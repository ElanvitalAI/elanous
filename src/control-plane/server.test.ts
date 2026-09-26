import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedControlHostname, DEFAULT_CONTROL_PORT, ensureControlTokens, startControlServer } from './server.js';
import { issueMemberToken } from './member-tokens.js';
import { createHash } from 'node:crypto';
import { runNexus } from '../nexus/index.js';
import { setTestStateRoot } from '../nexus/paths.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const roots: string[] = [];
const servers: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'elanous-control-'));
  roots.push(root);
  const server = startControlServer({ root, port: 0 });
  servers.push(server);
  const tokens = ensureControlTokens(root);
  const call = (path: string, token?: string, method = 'GET', body?: unknown, leaseId?: string) => fetch(`${server.url}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(leaseId ? { 'x-port-lease-id': leaseId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { root, server, tokens, call };
}

const record = { id: 'i1', kind: 'instance', machine: 'local', name: 'nexus', owner: 'forged', endpoint: 'http://127.0.0.1:31415', attrs: { load: 1 }, observedAt: 0, ttlMs: 30_000 };

test('NEXUS boot starts the separate authenticated control listener and releases it on shutdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-control-nexus-'));
  roots.push(root);
  setTestStateRoot(root);
  setElanousConfigDir(root);
  const reserved = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const controlPort = reserved.port;
  reserved.stop(true);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const boot = runNexus({
    headless: true,
    headlessDoneForTesting: done,
    skipHeadlessSetupCheckForTesting: true,
    controlPort,
    skipHttpServer: true,
    skipRuntimeApi: true,
    skipSupervisor: true,
    skipEnvMigration: true,
    registerDaemonTab: false,
    registerSettingsTab: false,
    autoMountShare: false,
    mcpEnabled: false,
  });
  try {
    const path = join(root, 'control', 'tokens.json');
    const deadline = Date.now() + 3_000;
    while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const tokens = ensureControlTokens(root);
    // The HTTP/PWA listener is skipped: this port is owned by the separate control server.
    const liveUrl = `http://127.0.0.1:${controlPort}/v1/resources`;
    expect((await fetch(liveUrl)).status).toBe(401);
    const authorized = await fetch(liveUrl, { headers: { Authorization: `Bearer ${tokens.query}` } });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ resources: [] });
    finish();
    await boot;
    await expect(fetch(liveUrl)).rejects.toThrow();
  } finally {
    finish();
    await boot;
    setTestStateRoot(null);
    resetElanousConfigDir();
  }
});

// ⛔ 관제부는 운영 넥서스와 «별도 프로세스»(RFC A2) — 넥서스 부팅은 관제부를 기본으로 띄우지 않고,
//    명시로 띄우다 실패해도(포트 점유) 넥서스 부팅은 막지 않는다. 🩸 2026-09-27: 종전엔 늘 31413 을 잡고 실패면 throw →
//    운영이 31413 을 쥔 뒤 모든 격리 데몬이 부팅에서 죽을 수 있었다.
test('NEXUS boot does not start the control listener by default, and a busy control port never blocks boot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-control-prod-boot-'));
  roots.push(root);
  setTestStateRoot(root);
  setElanousConfigDir(root);
  const common = {
    headless: true,
    skipHeadlessSetupCheckForTesting: true,
    skipHttpServer: true,
    skipRuntimeApi: true,
    skipSupervisor: true,
    skipEnvMigration: true,
    registerDaemonTab: false,
    registerSettingsTab: false,
    autoMountShare: false,
    mcpEnabled: false,
  } as const;
  const busy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('busy') });
  try {
    // ① 기본: 관제부 토큰 파일이 생기지 않는다(= 관제부를 안 띄웠다).
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const boot = runNexus({ ...common, headlessDoneForTesting: done });
    await Bun.sleep(300);
    expect(existsSync(join(root, 'control', 'tokens.json'))).toBe(false);
    finish();
    await boot;
    // ② 대조: 명시한 관제 포트가 이미 점유돼도 넥서스 부팅은 끝까지 간다(예외 없음).
    let finish2!: () => void;
    const done2 = new Promise<void>(resolve => { finish2 = resolve; });
    const boot2 = runNexus({ ...common, headlessDoneForTesting: done2, controlPort: busy.port });
    await Bun.sleep(300);
    finish2();
    await expect(boot2).resolves.toBeDefined();
  } finally {
    busy.stop(true);
    setTestStateRoot(null);
    resetElanousConfigDir();
  }
});

test('NEXUS refuses a coordinator lease without its per-run identity before HTTP startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-control-lease-boot-'));
  roots.push(root);
  setTestStateRoot(root);
  setElanousConfigDir(root);
  process.env.ELANOUS_TEST_COORDINATOR_LEASE_PORT = '31450';
  delete process.env.ELANOUS_TEST_COORDINATOR_LEASE_ID;
  try {
    await expect(runNexus({ detachForTesting: true, httpStartPort: 31450, skipHttpServer: true, skipSupervisor: true })).rejects.toThrow('missing coordinator lease id');
    expect(existsSync(join(root, 'nexus', '.lock'))).toBe(false);
  } finally {
    delete process.env.ELANOUS_TEST_COORDINATOR_LEASE_PORT;
    setTestStateRoot(null);
    resetElanousConfigDir();
  }
});

test('first startup creates independent 0600 tokens, preserves them across restart, and binds loopback', () => {
  const { root, server, tokens } = setup();
  const path = join(root, 'control', 'tokens.json');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(new Set(Object.values(tokens)).size).toBe(3);
  expect(Object.values(tokens).every(v => /^[0-9a-f]{64}$/.test(v))).toBe(true);
  expect(server.hostname).toBe('127.0.0.1');
  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const again = startControlServer({ root, port: 0 });
  servers.push(again);
  expect(again.hostname).toBe('127.0.0.1');
  expect(ensureControlTokens(root)).toEqual(tokens);
  expect(readFileSync(path, 'utf8')).toContain(tokens.member);
});

test('register and query enforce scope, filters, age, ownership, heartbeat and deletion without leaking tokens', async () => {
  const { root, tokens, call } = setup();
  expect((await call('/v1/resources')).status).toBe(401);
  expect((await call('/v1/resources', 'wrong')).status).toBe(401);
  expect((await call('/v1/resources/register', undefined, 'POST', record)).status).toBe(401);
  expect((await call('/v1/resources/register', tokens.query, 'POST', record)).status).toBe(403);
  expect((await call('/v1/resources/i1/heartbeat', undefined, 'POST', {})).status).toBe(401);
  expect((await call('/v1/resources/i1', undefined, 'DELETE')).status).toBe(401);
  expect((await call('/v1/resources/i1/heartbeat', tokens.query, 'POST', {})).status).toBe(403);
  expect((await call('/v1/resources/i1', tokens.query, 'DELETE')).status).toBe(403);
  const registered = await call('/v1/resources/register', tokens.member, 'POST', record);
  expect(registered.status).toBe(200);
  const responseText = await registered.text();
  for (const token of Object.values(tokens)) expect(responseText).not.toContain(token);
  expect(JSON.parse(responseText).owner).not.toBe('forged');
  const list = await call('/v1/resources?kind=instance&machine=local&name=nexus', tokens.query);
  expect(list.status).toBe(200);
  const body = await list.json() as { resources: Array<{ id: string; ageMs: number; expired: boolean }> };
  expect(body.resources).toHaveLength(1);
  expect(body.resources[0]!.id).toBe('i1');
  expect(body.resources[0]!.ageMs).toBeGreaterThanOrEqual(0);
  expect(body.resources[0]!.expired).toBe(false);
  expect((await (await call('/v1/resources?name=other', tokens.query)).json()).resources).toEqual([]);
  const updated = await call('/v1/resources/register', tokens.member, 'POST', { ...record, name: 'renamed' });
  expect(updated.status).toBe(200);
  expect((await call('/v1/resources', tokens.member)).status).toBe(200);
  expect((await call('/v1/resources/register', tokens.admin, 'POST', { ...record, id: 'admin-owned' })).status).toBe(200);
  expect((await call('/v1/resources/admin-owned', tokens.admin, 'DELETE')).status).toBe(204);
  expect((await call('/v1/resources/register', tokens.admin, 'POST', record)).status).toBe(403);
  expect((await call('/v1/resources/i1/heartbeat', tokens.admin, 'POST', {})).status).toBe(403);
  expect((await call('/v1/resources/i1', tokens.admin, 'DELETE')).status).toBe(403);
  expect((await call('/v1/resources/i1/heartbeat', tokens.member, 'POST', { attrs: { load: 2 } })).status).toBe(200);
  const rows = (await (await call('/v1/resources', tokens.query)).json()).resources;
  expect(rows).toHaveLength(1);
  expect(rows[0].attrs).toEqual({ load: 2 });
  expect(statSync(join(root, 'control', 'ledger.json')).mode & 0o777).toBe(0o600);
  expect((await call('/v1/resources/i1', tokens.member, 'DELETE')).status).toBe(204);
  expect((await (await call('/v1/resources', tokens.query)).json()).resources).toEqual([]);
});

test('member port leases require authentication and can only be released by their owner', async () => {
  const { tokens, call } = setup();
  const request = { machine: 'local', purpose: 'test-nexus', ttlMs: 30_000 };
  expect((await call('/v1/leases/port', undefined, 'POST', request)).status).toBe(401);
  expect((await call('/v1/leases/port', tokens.query, 'POST', request)).status).toBe(403);
  expect((await call('/v1/leases/port', tokens.admin, 'POST', request)).status).toBe(403);
  expect((await call('/v1/leases/port', tokens.member, 'POST', { ...request, ttlMs: 0 })).status).toBe(400);
  expect((await call('/v1/leases/port', tokens.member, 'POST', { ...request, machine: ' ' })).status).toBe(400);
  const first = await call('/v1/leases/port', tokens.member, 'POST', request);
  expect(first.status).toBe(200);
  const lease = await first.json() as { port: number; lease: { kind: string; owner: string; attrs: { leaseId: string } } };
  const leaseId = lease.lease.attrs.leaseId;
  expect(leaseId).toMatch(/^[0-9a-f-]{36}$/);
  expect(lease.port).toBe(31450);
  expect(lease.lease.kind).toBe('port-lease');
  expect(JSON.stringify(lease)).not.toContain(tokens.member);
  const visible = await (await call('/v1/resources?kind=port-lease', tokens.query)).json() as { resources: Array<{ attrs: Record<string, unknown> }> };
  expect(visible.resources[0]?.attrs.leaseId).toBeUndefined();
  expect(visible.resources[0]?.attrs.port).toBe(31450);
  expect((await (await call('/v1/leases/port', tokens.member, 'POST', request)).json()).port).toBe(31451);
  expect((await call('/v1/leases/port/31450/heartbeat', undefined, 'POST')).status).toBe(401);
  expect((await call('/v1/leases/port/31450/heartbeat', tokens.query, 'POST')).status).toBe(403);
  expect((await call('/v1/leases/port/31450/heartbeat', tokens.admin, 'POST')).status).toBe(403);
  expect((await call('/v1/leases/port/31450/heartbeat', tokens.member, 'POST')).status).toBe(400);
  expect((await call('/v1/leases/port/31450/heartbeat', tokens.member, 'POST', undefined, 'wrong')).status).toBe(403);
  const renewed = await call('/v1/leases/port/31450/heartbeat', tokens.member, 'POST', undefined, leaseId);
  expect(renewed.status).toBe(200);
  expect((await renewed.json()).attrs.port).toBe(31450);
  expect((await call('/v1/leases/port/31415/heartbeat', tokens.member, 'POST')).status).toBe(400);
  expect((await call('/v1/leases/port/31450', undefined, 'DELETE')).status).toBe(401);
  expect((await call('/v1/leases/port/31450', tokens.member, 'DELETE')).status).toBe(400);
  expect((await call('/v1/leases/port/31450', tokens.member, 'DELETE', undefined, 'wrong')).status).toBe(403);
  expect((await call('/v1/leases/port/31450', tokens.member, 'DELETE', undefined, leaseId)).status).toBe(204);
  expect((await call('/v1/leases/port/31450/heartbeat', tokens.member, 'POST', undefined, leaseId)).status).toBe(404);
  const reclaimed = await (await call('/v1/leases/port', tokens.member, 'POST', request)).json() as { port: number; lease: { attrs: { leaseId: string } } };
  expect(reclaimed.port).toBe(31450);
  expect((await call('/v1/leases/port/31450', tokens.query, 'DELETE')).status).toBe(403);
  expect((await call('/v1/leases/port/31450', tokens.admin, 'DELETE')).status).toBe(403);
  expect((await call('/v1/leases/port/31415', tokens.member, 'DELETE')).status).toBe(400);
  expect(reclaimed.lease.attrs.leaseId).not.toBe(leaseId);
  expect((await call('/v1/leases/port/31450/heartbeat', tokens.member, 'POST', undefined, leaseId)).status).toBe(403);
  expect((await call('/v1/leases/port/31450', tokens.member, 'DELETE', undefined, leaseId)).status).toBe(403);
  expect((await call('/v1/leases/port/31450', tokens.member, 'DELETE', undefined, reclaimed.lease.attrs.leaseId)).status).toBe(204);
  expect((await (await call('/v1/leases/port', tokens.member, 'POST', request)).json()).port).toBe(31450);
  expect((await call('/v1/resources/register', tokens.member, 'POST', { ...record, id: 'port-lease:31450', kind: 'port-lease' })).status).toBe(403);
  expect((await call('/v1/resources/port-lease%3A31450/heartbeat', tokens.member, 'POST', {})).status).toBe(403);
  expect((await call('/v1/resources/port-lease%3A31450', tokens.member, 'DELETE')).status).toBe(403);
  expect((await call('/v1/leases/port', tokens.member, 'POST', { ...request, excluded: [31415] })).status).toBe(400);
  expect((await (await call('/v1/leases/port', tokens.member, 'POST', { ...request, excluded: [31450] })).json()).port).toBe(31452);
});

test('expired port reallocation with the same member token rejects the previous run identity', async () => {
  const { tokens, call } = setup();
  const request = { machine: 'local', purpose: 'test-nexus', ttlMs: 1 };
  const first = await (await call('/v1/leases/port', tokens.member, 'POST', request)).json() as { port: number; lease: { attrs: { leaseId: string } } };
  await Bun.sleep(5);
  const second = await (await call('/v1/leases/port', tokens.member, 'POST', { ...request, ttlMs: 30_000 })).json() as typeof first;
  expect(second.port).toBe(first.port);
  expect(second.lease.attrs.leaseId).not.toBe(first.lease.attrs.leaseId);
  const path = `/v1/leases/port/${first.port}`;
  expect((await call(`${path}/heartbeat`, tokens.member, 'POST', undefined, first.lease.attrs.leaseId)).status).toBe(403);
  expect((await call(path, tokens.member, 'DELETE', undefined, first.lease.attrs.leaseId)).status).toBe(403);
  const renewed = await call(`${path}/heartbeat`, tokens.member, 'POST', undefined, second.lease.attrs.leaseId);
  expect(renewed.status).toBe(200);
  expect((await renewed.json() as { attrs: { leaseId?: string } }).attrs.leaseId).toBeUndefined();
  expect((await call(path, tokens.member, 'DELETE', undefined, second.lease.attrs.leaseId)).status).toBe(204);
});

test('untrusted owner, malformed registration and unknown route cannot change the ledger', async () => {
  const { tokens, call } = setup();
  expect((await call('/v1/resources/register', tokens.member, 'POST', { ...record, ttlMs: -1 })).status).toBe(400);
  expect((await call('/v1/resources/i1/heartbeat', tokens.member, 'POST', {})).status).toBe(404);
  expect((await call('/v1/resources/i1', tokens.member, 'DELETE')).status).toBe(404);
  expect((await call('/v1/tokens', tokens.admin)).status).toBe(404);
});

test('binding rejects public and wildcard hosts before startup and accepts only loopback or tailnet', () => {
  for (const host of ['0.0.0.0', '8.8.8.8', 'localhost', '127.0.0.2', '100.63.255.255', '100.128.0.1', '100.83.1.069']) {
    expect(allowedControlHostname(host)).toBe(false);
    expect(() => startControlServer({ hostname: host, root: join(tmpdir(), 'not-created') })).toThrow('invalid control hostname');
  }
  for (const host of ['127.0.0.1', '::1', '100.64.0.0', '100.83.1.69', '100.127.255.255']) expect(allowedControlHostname(host)).toBe(true);
  const { root } = setup();
  const ipv6 = startControlServer({ root, port: 0, hostname: '::1' });
  servers.push(ipv6);
  expect(ipv6.hostname).toBe('::1');
  expect(new URL(ipv6.url).hostname).toBe('[::1]');
});

test('machine tokens only write their machine and keep ownership after reissue', async () => {
  const { root, tokens, call } = setup();
  const node-b = issueMemberToken('node-b', root);
  const mbp = issueMemberToken('mbp', root);
  const own = { ...record, machine: 'node-b' };
  expect((await call('/v1/resources/register', node-b, 'POST', own)).status).toBe(200);
  const owner = createHash('sha256').update('machine:node-b').digest('hex');
  const listed = await call('/v1/resources', node-b);
  expect(listed.status).toBe(200);
  expect((await listed.json() as { resources: Array<{ owner: string }> }).resources[0]?.owner).toBe(owner);
  const other = { ...record, id: 'mbp1', machine: 'mbp' };
  expect((await call('/v1/resources/register', tokens.member, 'POST', other)).status).toBe(200);
  for (const [path, method, body] of [
    ['/v1/resources/register', 'POST', { ...own, machine: 'mbp', id: 'new' }],
    ['/v1/resources/register', 'POST', { ...own, machine: 'node-b', id: 'mbp1' }],
    ['/v1/resources/mbp1/heartbeat', 'POST', {}],
    ['/v1/resources/mbp1', 'DELETE', undefined],
    ['/v1/resources/i1/heartbeat', 'POST', { machine: 'mbp' }],
  ] as const) {
    const response = await call(path, node-b, method, body);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'machine-scope' });
  }
  expect((await call('/v1/resources/i1/heartbeat', node-b, 'POST', {})).status).toBe(200);
  const next = issueMemberToken('node-b', root);
  expect((await call('/v1/resources', node-b)).status).toBe(401);
  const updated = await call('/v1/resources/register', next, 'POST', { ...own, name: 'new-name' });
  expect(updated.status).toBe(200);
  expect((await updated.json() as { owner: string }).owner).toBe(owner);
  expect((await call('/v1/resources/i1', next, 'DELETE')).status).toBe(204);
  expect((await call('/v1/resources/mbp1', mbp, 'DELETE')).status).toBe(403);
});

test('machine-scoped port leases reject other machines on allocation and target operations', async () => {
  const { root, call } = setup();
  const node-b = issueMemberToken('node-b', root);
  const mbp = issueMemberToken('mbp', root);
  const request = { machine: 'node-b', purpose: 'test', ttlMs: 30_000 };
  const rejected = await call('/v1/leases/port', node-b, 'POST', { ...request, machine: 'mbp' });
  expect(rejected.status).toBe(403);
  expect(await rejected.json()).toEqual({ error: 'machine-scope' });
  const allocated = await call('/v1/leases/port', node-b, 'POST', request);
  expect(allocated.status).toBe(200);
  const { port, lease } = await allocated.json() as { port: number; lease: { owner: string; attrs: { leaseId: string } } };
  expect(lease.owner).toBe(createHash('sha256').update('machine:node-b').digest('hex'));
  const url = `/v1/leases/port/${port}`;
  for (const path of [url, `${url}/heartbeat`]) {
    const response = await call(path, mbp, path === url ? 'DELETE' : 'POST', undefined, lease.attrs.leaseId);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'machine-scope' });
  }
  const next = issueMemberToken('node-b', root);
  expect((await call(`${url}/heartbeat`, next, 'POST', undefined, lease.attrs.leaseId)).status).toBe(200);
  expect((await call(url, next, 'DELETE', undefined, lease.attrs.leaseId)).status).toBe(204);
});

test('the server clips an oversized port-lease ttl to the 24-hour cap', async () => {
  const { tokens, call } = setup();
  const res = await call('/v1/leases/port', tokens.member, 'POST', { machine: 'local', purpose: 'test-nexus', ttlMs: 10 * 365 * 24 * 60 * 60 * 1000 });
  expect(res.status).toBe(200);
  const body = await res.json() as { lease: { ttlMs: number } };
  expect(body.lease.ttlMs).toBe(24 * 60 * 60 * 1000);
});
