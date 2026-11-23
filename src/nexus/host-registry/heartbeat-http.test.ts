import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainHostHeartbeatQueue, enqueueHostHeartbeat, HeartbeatSendError, heartbeatQueuePath,
  postHostHeartbeat, readHostHeartbeatQueue, sendHostHeartbeatCentral, type HostHeartbeatEntry,
} from './heartbeat-http.js';
import { issueMemberToken, machineForExpiringToken } from '../../control-plane/member-tokens.js';
import { handleHostsHeartbeatPost } from '../api/hosts-heartbeat.js';
import { readHostLedgerStrict } from './store.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const OLD_ISO = '2026-11-23T07:00:00.000Z';
const NEW_ISO = '2026-11-23T08:00:00.000Z';

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'hb-http-')); }

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (e) { return (e as HeartbeatSendError).reason; }
  return '(no-throw)';
}

/** The synthetic central nexus: the /v1/hosts/heartbeat route block as http-server wires it. */
function centralServer(root: string, ledgerPath: string, desired: () => string | undefined,
  seen: Array<{ heartbeat: { host: string; installedSha: string; at: string } }>) {
  return Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: async (req: Request) => {
      if (new URL(req.url).pathname !== '/v1/hosts/heartbeat') return new Response('not-found', { status: 404 });
      const offered = req.headers.get('authorization');
      const presented = offered?.startsWith('Bearer ') ? offered.slice(7).trim() : '';
      const machine = presented ? machineForExpiringToken(presented, root) : undefined;
      if (!machine) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
      const body = await req.clone().json() as { heartbeat?: { host: string; installedSha: string; at: string } };
      const response = await handleHostsHeartbeatPost(req, machine, { ledgerPath, desiredSha: desired });
      if (response.status === 201 && body?.heartbeat) seen.push({ heartbeat: body.heartbeat });
      return response;
    },
  });
}

test('합성 종단(실HTTP · 기계 토큰): 원격 송신 → 중앙 hosts list 원장에 원격 행 · 성공 시 큐 미생성', async () => {
  const root = tempDir(); const remote = tempDir();
  const ledgerPath = join(root, 'central-host-registry.json');
  const queuePath = join(remote, 'host-heartbeat-queue.jsonl');
  const token = issueMemberToken('node-b', root);
  const seen: Array<{ heartbeat: { host: string; installedSha: string; at: string } }> = [];
  const server = centralServer(root, ledgerPath, () => SHA_B, seen);
  try {
    const result = await sendHostHeartbeatCentral(
      { host: 'node-b', installedSha: SHA_A, seat: 'TC-H-CC-1', channel: 'dev', at: NEW_ISO },
      { baseUrl: `http://127.0.0.1:${server.port}`, bearerToken: token, queuePath });
    expect(result).toMatchObject({ outcome: 'sent', host: 'node-b', state: 'behind', drained: { sent: 0, kept: 0 } });
    const central = readHostLedgerStrict(ledgerPath);
    expect(central?.hosts['node-b']).toMatchObject({
      host: 'node-b', installedSha: SHA_A, seat: 'TC-H-CC-1', channel: 'dev', lastHeartbeatMs: Date.parse(NEW_ISO),
    });
    expect(existsSync(queuePath)).toBe(false);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
});

test('오프라인 재전송: 중앙 장애 → 로컬 큐 적체 → 회복 후 드레인이 원본 at 그대로 재전송 · 큐 소진 · 중앙 원장은 최신', async () => {
  const root = tempDir(); const remote = tempDir();
  const ledgerPath = join(root, 'central-host-registry.json');
  const queuePath = join(remote, 'host-heartbeat-queue.jsonl');
  const token = issueMemberToken('node-c', root);
  const seen: Array<{ heartbeat: { host: string; installedSha: string; at: string } }> = [];

  const down = await sendHostHeartbeatCentral(
    { host: 'node-c', installedSha: SHA_A, channel: 'release', at: OLD_ISO },
    { baseUrl: 'http://127.0.0.1:1', bearerToken: token, queuePath });
  expect(down).toMatchObject({ outcome: 'queued', reason: 'endpoint-unavailable', queued: 1 });
  expect(readHostHeartbeatQueue(queuePath)).toEqual([{ host: 'node-c', installedSha: SHA_A, channel: 'release', at: OLD_ISO }]);

  const server = centralServer(root, ledgerPath, () => SHA_A, seen);
  try {
    const recovered = await sendHostHeartbeatCentral(
      { host: 'node-c', installedSha: SHA_B, channel: 'release', at: NEW_ISO },
      { baseUrl: `http://127.0.0.1:${server.port}`, bearerToken: token, queuePath });
    expect(recovered).toMatchObject({ outcome: 'sent', drained: { sent: 1, kept: 0 } });
    expect(readHostHeartbeatQueue(queuePath)).toEqual([]);
    expect(seen.map((s) => [s.heartbeat.at, s.heartbeat.installedSha])).toEqual([[OLD_ISO, SHA_A], [NEW_ISO, SHA_B]]);
    const central = readHostLedgerStrict(ledgerPath);
    expect(central?.hosts['node-c']).toMatchObject({ installedSha: SHA_B, channel: 'release', lastHeartbeatMs: Date.parse(NEW_ISO) });
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
});

test('postHostHeartbeat: base URL 검증 · 오류 사상 · 성공 파싱', async () => {
  const entry: HostHeartbeatEntry = { host: 'node-c', installedSha: SHA_A, at: OLD_ISO };
  const seam = (status: number, body: unknown) => ((async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch);
  expect(await reasonOf(postHostHeartbeat('ftp://nexus.test', entry, { bearerToken: 'tok', fetch: seam(201, {}) }))).toBe('invalid-nexus-url');
  expect(await reasonOf(postHostHeartbeat('http://user:pass@nexus.test', entry, { bearerToken: 'tok', fetch: seam(201, {}) }))).toBe('invalid-nexus-url');
  expect(await reasonOf(postHostHeartbeat('http://127.0.0.1:1', entry, { bearerToken: '', fetch: seam(201, {}) }))).toBe('machine-token-missing');
  expect(await reasonOf(postHostHeartbeat('http://127.0.0.1:1', entry, { bearerToken: 'tok', fetch: seam(401, { error: 'unauthorized' }) }))).toBe('unauthorized');
  expect(await reasonOf(postHostHeartbeat('http://127.0.0.1:1', entry, { bearerToken: 'tok', fetch: seam(403, { error: 'host-token-mismatch' }) }))).toBe('host-token-mismatch');
  expect(await reasonOf(postHostHeartbeat('http://127.0.0.1:1', entry, { bearerToken: 'tok', fetch: seam(500, { error: 'boom' }) }))).toBe('http-500');
  expect(await reasonOf(postHostHeartbeat('http://127.0.0.1:1', entry, { bearerToken: 'tok', fetch: seam(201, { ok: false }) }))).toBe('invalid-response-body');

  let captured: { url?: string; method?: string; headers?: Record<string, string>; body?: string } = {};
  const ok = await postHostHeartbeat('http://nexus.test', entry, {
    bearerToken: 'tok',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input), method: init?.method, headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      };
      return (seam(201, { ok: true, host: 'node-c', state: 'behind' }) as unknown as () => Promise<Response>)();
    }) as typeof fetch,
  });
  expect(ok).toEqual({ ok: true, host: 'node-c', state: 'behind' });
  expect(captured.url).toBe('http://nexus.test/v1/hosts/heartbeat');
  expect(captured.method).toBe('POST');
  expect(captured.headers?.authorization).toBe('Bearer tok');
  expect(JSON.parse(captured.body ?? '{}')).toEqual({ heartbeat: { host: 'node-c', installedSha: SHA_A, at: OLD_ISO } });
});

test('drain: 실패 항목은 순서 보존 재적체 · 깨진 줄은 버림 · 빈 큐 드레인은 파일을 만들지 않는다', async () => {
  const dir = tempDir();
  const queuePath = join(dir, 'queue.jsonl');
  try {
    enqueueHostHeartbeat({ host: 'h1', installedSha: SHA_A, at: OLD_ISO }, queuePath);
    enqueueHostHeartbeat({ host: 'h2', installedSha: SHA_B, at: OLD_ISO }, queuePath);
    appendFileSync(queuePath, '{broken json\n');
    const fail = async () => { throw new HeartbeatSendError('endpoint-unavailable'); };
    expect(await drainHostHeartbeatQueue(fail, queuePath)).toEqual({ sent: 0, kept: 2 });
    expect(readHostHeartbeatQueue(queuePath)).toEqual([
      { host: 'h1', installedSha: SHA_A, at: OLD_ISO },
      { host: 'h2', installedSha: SHA_B, at: OLD_ISO },
    ]);
    let calls = 0;
    const succeed = async () => { calls += 1; };
    expect(await drainHostHeartbeatQueue(succeed, queuePath)).toEqual({ sent: 2, kept: 0 });
    expect(calls).toBe(2);
    expect(readHostHeartbeatQueue(queuePath)).toEqual([]);
    rmSync(queuePath, { force: true });
    expect(await drainHostHeartbeatQueue(succeed, queuePath)).toEqual({ sent: 0, kept: 0 });
    expect(existsSync(queuePath)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('heartbeatQueuePath: 원장 옆 표준 이름 · 미구성(토큰/URL 부재)은 무전송', async () => {
  expect(heartbeatQueuePath('/x/y/host-registry.json')).toBe('/x/y/host-heartbeat-queue.jsonl');
  const dir = tempDir();
  try {
    const queuePath = join(dir, 'queue.jsonl');
    const entry: HostHeartbeatEntry = { host: 'h1', installedSha: SHA_A, at: OLD_ISO };
    expect(await sendHostHeartbeatCentral(entry, { baseUrl: 'http://127.0.0.1:1', bearerToken: '', queuePath })).toEqual({ outcome: 'unconfigured' });
    expect(await sendHostHeartbeatCentral(entry, { baseUrl: '', bearerToken: 'tok', queuePath })).toEqual({ outcome: 'unconfigured' });
    expect(existsSync(queuePath)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
