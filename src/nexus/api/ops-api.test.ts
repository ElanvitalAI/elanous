import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { resetUserConfig } from '../../user-config.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { readReleaseRuns } from './ops-api.js';
import { gateShardsPath, writeGateShards } from '../../release-loop/gate-shards.js';

const SECRET = 'op-proxy-secret-0123456789abcdef';
const API_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
const OWNER = 'owner-token';
const dirs: string[] = [];

afterEach(() => {
  resetUserConfig();
  resetElanousConfigDir();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(enabled: boolean | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-api-'));
  dirs.push(dir);
  setElanousConfigDir(dir);
  resetUserConfig();
  if (enabled !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify({ operator: { enabled, proxySecretFile: join(dir, 'secret') } }));
  writeFileSync(join(dir, 'secret'), SECRET, { mode: 0o600 });
  chmodSync(join(dir, 'secret'), 0o600);
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const opts = { state, registry: new TabRegistry(state), eventBus: new NexusEventBus(), metaApi: { bearerToken: OWNER, noAuth: false } };
  const send = (path: string, headers: Record<string, string> = {}, method = 'GET') => {
    const request = new Request(`http://ops.test${path}`, { method, headers: { 'sec-fetch-site': 'cross-site', ...headers } });
    return routeRequest(request, opts, {} as never, null, createDevProxyRuntimeRef());
  };
  const run = (id: string, startedAt: string, version = '0.2.9', output: unknown = JSON.stringify({ summary: 'ok' })) => {
    const folder = join(dir, 'graph-runs', 'release-loop');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.json`), JSON.stringify({
      graphId: 'release-loop', runId: id, status: 'running', path: ['version-release'], startedAt,
      input: { version }, nodes: [{ nodeId: 'version-release', ok: true, exit: 0, output }],
    }));
  };
  return { dir, send, run };
}

test('default install with owner bearer refuses all ops data', async () => {
  const { send, run } = fixture(undefined);
  run('run-1', '2026-10-02T00:00:00Z');
  for (const path of ['/v1/ops/release/runs', '/v1/ops/release/runs/run-1/nodes/version-release/log', '/v1/ops/checklist?version=0.2.9']) {
    const response = await send(path, { authorization: `Bearer ${OWNER}` });
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: 'forbidden' });
  }
});

test('enabled but forged proxy header without owner token is refused', async () => {
  const { send } = fixture(true);
  expect((await send('/v1/ops/release/runs', { 'x-elanous-operator': 'forged-forged-forged-forged' }))?.status).toBe(403);
});

test('enabled and correct proxy header serves redacted run summaries and node logs, without bearer', async () => {
  const { send, run } = fixture(true);
  const summary = `${API_KEY} ${'a'.repeat(310)}`;
  const log = `begin ${'z'.repeat(4100)} ${API_KEY} end`;
  run('run-1', '2026-10-02T00:00:00Z', '0.2.9', JSON.stringify({ summary, log }));
  const headers = { 'x-elanous-operator': SECRET };
  const response = await send('/v1/ops/release/runs?version=0.2.9', headers);
  expect(response?.status).toBe(200);
  expect(response?.headers.get('cache-control')).toBe('no-store');
  const runs = await response?.json() as Array<{ runId: string; status: string; startedAt: string; version: string; path: string[]; nodes: Array<{ nodeId: string; ok: boolean; summary: string }> }>;
  expect(runs).toEqual([{
    runId: 'run-1', status: 'running', startedAt: '2026-10-02T00:00:00Z', version: '0.2.9', path: ['version-release'],
    nodes: [{ nodeId: 'version-release', ok: true, summary: `sk-*** ${'a'.repeat(293)}` }],
  }]);
  expect(JSON.stringify(runs)).not.toContain(API_KEY);
  const logResponse = await send('/v1/ops/release/runs/run-1/nodes/version-release/log', headers);
  expect(logResponse?.status).toBe(200);
  const body = await logResponse?.json() as { log: string };
  expect(body.log.length).toBe(4000);
  expect(JSON.stringify(body)).not.toContain(API_KEY);
  expect((await send('/v1/ops/release/runs/run-1/nodes/missing/log', headers))?.status).toBe(404);
});

test('run list redacts secrets in stored metadata without a version filter', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'graph-runs', 'release-loop');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'run-1.json'), JSON.stringify({
    status: `running ${API_KEY}`, path: [`version-release ${API_KEY}`],
    startedAt: `2026-10-02T00:00:00Z ${API_KEY}`,
    input: { version: API_KEY },
    nodes: [{ nodeId: `version-release ${API_KEY}`, ok: true, output: { summary: 'ok' } }],
  }));
  const response = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  expect(response?.status).toBe(200);
  const body = await response?.text() ?? '';
  expect(body).not.toContain(API_KEY);
  expect(JSON.parse(body)).toEqual([{
    runId: 'run-1', status: 'running sk-***', startedAt: '2026-10-02T00:00:00Z sk-***',
    version: null, path: ['version-release sk-***'],
    nodes: [{ nodeId: 'version-release sk-***', ok: true, summary: 'ok' }],
  }]);
  writeFileSync(join(folder, `${API_KEY}.json`), JSON.stringify({
    status: 'running', path: [], startedAt: '2026-10-01T00:00:00Z',
    input: { version: '0.2.9' }, nodes: [],
  }));
  const withSecretId = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  const withSecretIdBody = await withSecretId?.text() ?? '';
  expect(withSecretIdBody).not.toContain(API_KEY);
  expect(JSON.parse(withSecretIdBody)[1]?.runId).toBe('sk-***');
});

test('run list never returns a malformed node ok containing a secret', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'graph-runs', 'release-loop');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'run-1.json'), JSON.stringify({
    status: 'running', path: [], startedAt: '2026-10-02T00:00:00Z',
    input: { version: '0.2.9' },
    nodes: [{ nodeId: 'version-release', ok: { key: API_KEY }, output: { summary: 'ok' } }],
  }));
  const response = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  expect(response?.status).toBe(200);
  const body = await response?.text() ?? '';
  expect(body).not.toContain(API_KEY);
  expect(JSON.parse(body)[0]?.nodes).toEqual([{ nodeId: 'version-release', ok: null, summary: 'ok' }]);
});

test('run summary reads the last JSON object from multi-line node output', async () => {
  const { send, run } = fixture(true);
  run('run-1', '2026-10-02T00:00:00Z', '0.2.9', `first line\n${JSON.stringify({ summary: `completed ${API_KEY}` })}\n`);
  const response = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  const runs = await response?.json() as Array<{ nodes: Array<{ summary: string }> }>;
  expect(runs[0]?.nodes[0]?.summary).toBe('completed sk-***');
});

test('enabled owner bearer serves the listChecklist data plus the version schedule (null when unset)', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'release', '0.2.9');
  mkdirSync(folder, { recursive: true });
  const item = { id: 'OPS1', title: 'release', status: 'green', updatedAt: '2026-10-02', updatedBy: 'test' };
  writeFileSync(join(folder, 'checklist.json'), JSON.stringify({ version: '0.2.9', released: '', dev: '', items: [item], history: [] }));
  const { listChecklist } = await import('../../release-loop/checklist.js');
  const expected = listChecklist('0.2.9');
  const response = await send('/v1/ops/checklist?version=0.2.9', { authorization: `Bearer ${OWNER}` });
  expect(response?.status).toBe(200);
  const body = await response?.json() as { items: Array<{ id: string }> };
  expect(body.items).toContainEqual(item);
  expect(body as unknown).toEqual({ ...expected, schedule: null });
  expect((await send('/v1/ops/checklist?version=../../secrets', { authorization: `Bearer ${OWNER}` }))?.status).toBe(400);
});

test('rejects traversal and invalid ids before touching the filesystem', async () => {
  const { send } = fixture(true);
  const headers = { 'x-elanous-operator': SECRET };
  expect((await send('/v1/ops/release/runs/../nodes/one/log', headers))?.status).toBe(400);
  for (const id of ['..%2Fsecret', '%2E%2E%5Csecret', 'bad_id']) {
    expect((await send(`/v1/ops/release/runs/${id}/nodes/one/log`, headers))?.status).toBe(400);
  }
  expect((await send('/v1/ops/release/runs/run-1/nodes/bad_id/log', headers))?.status).toBe(400);
  expect((await send('/v1/ops/release/runs?version=../', headers))?.status).toBe(400);
  expect((await send('/v1/ops/release/runs', headers, 'POST'))?.status).toBe(405);
});

test('run list filters by version, orders newest first and caps at 20', async () => {
  const { send, run } = fixture(true);
  for (let i = 0; i < 22; i++) run(`run-${i}`, `2026-10-02T00:00:${String(i).padStart(2, '0')}Z`);
  run('other-version', '2026-10-02T01:00:00Z', '0.2.8');
  const response = await send('/v1/ops/release/runs?version=0.2.9', { authorization: `Bearer ${OWNER}` });
  const runs = await response?.json() as Array<{ runId: string }>;
  expect(runs).toHaveLength(20);
  expect(runs[0]?.runId).toBe('run-21');
  expect(runs.at(-1)?.runId).toBe('run-2');
});

test('ops observability records path and source, never credentials', async () => {
  const { send } = fixture(true);
  const records: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'ops.api' && (event === 'served' || event === 'refused')) records.push({ event, data });
  });
  try {
    await send('/v1/ops/release/runs', { 'x-elanous-operator': 'forged-forged-forged-forged' });
    await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
    expect(records).toEqual([
      { event: 'refused', data: { path: '/v1/ops/release/runs', source: null } },
      { event: 'served', data: { path: '/v1/ops/release/runs', source: 'op-proxy' } },
    ]);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(records)).not.toContain(OWNER);
  } finally { spy.mockRestore(); }
});

test('seats: refused without the operator signal, 400 on a bad date, and served from the (injected) board', async () => {
  const { setSeatsCacheForTest } = await import('./ops-api.js');
  const { createSeatsCache } = await import('./ops-seats.js');
  const { send } = fixture(true);
  setSeatsCacheForTest(createSeatsCache({ channel: async () => null, merged: async () => null, checklist: () => null, openDecisionRaisers: () => [] }));
  try {
    expect((await send('/v1/ops/seats'))?.status).toBe(403);
    expect((await send('/v1/ops/seats', { 'x-elanous-operator': 'forged-forged-forged-forged' }))?.status).toBe(403);
    const headers = { 'x-elanous-operator': SECRET };
    expect((await send('/v1/ops/seats?date=2026-13-45', headers))?.status).toBe(400);
    expect((await send('/v1/ops/seats?date=yesterday', headers))?.status).toBe(400);
    const response = await send('/v1/ops/seats?date=2026-10-02', headers);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const board = await response?.json() as { date: string; seats: Array<{ seat: string; now: unknown; pendingDecisions: unknown }> };
    expect(board.date).toBe('2026-10-02');
    expect(board.seats.map((row) => [row.seat, row.now, row.pendingDecisions])).toEqual([['OP', null, 0], ['TC', null, 0], ['MK', null, 0], ['UX', null, 0]]);
  } finally { setSeatsCacheForTest(null); }
});

test('checklist carries the version schedule (cut · land-by) or null when none is set', async () => {
  const { setSchedule } = await import('../../release-loop/release-schedule.js');
  const { send } = fixture(true);
  const headers = { 'x-elanous-operator': SECRET };
  const before = await (await send('/v1/ops/checklist?version=0.2.10', headers))!.json() as { schedule: unknown };
  expect(before.schedule).toBeNull();
  setSchedule('0.2.10', { cutAt: '2026-10-03T08:00+09:00', landBy: '2026-10-03T06:30+09:00' }, 'test');
  const after = await (await send('/v1/ops/checklist?version=0.2.10', headers))!.json() as { schedule: { cutAt: string; landBy: string | null } };
  expect(after.schedule).toEqual({ cutAt: '2026-10-02T23:00:00.000Z', landBy: '2026-10-02T21:30:00.000Z' });
});

test('GRAPH-NODE-TIMES: run list carries ledger node times and the running node start; old ledgers carry none', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'graph-runs', 'release-loop');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'timed.json'), JSON.stringify({
    status: 'running', path: ['version-release', 'gate'], startedAt: '2026-10-07T00:00:00.000Z', input: { version: '0.2.19' },
    nodes: [{ nodeId: 'version-release', ok: true, output: '', startedAt: '2026-10-07T00:00:01.000Z', endedAt: '2026-10-07T00:02:00.000Z', seconds: 119 }],
    currentNode: { nodeId: 'gate', startedAt: '2026-10-07T00:02:01.000Z' },
  }));
  writeFileSync(join(folder, 'legacy.json'), JSON.stringify({
    status: 'failed', path: ['version-release'], startedAt: '2026-10-06T00:00:00.000Z', input: { version: '0.2.18' },
    nodes: [{ nodeId: 'version-release', ok: false, output: '', startedAt: 'not a time', endedAt: 'October 7, 2026' }],
    currentNode: { nodeId: 'version-release', startedAt: '2026-10-06T00:00:01.000Z' },
  }));
  const response = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  const runs = await response?.json() as Array<{ runId: string; nodes: unknown[] }>;
  expect(runs.find((run) => run.runId === 'timed')?.nodes).toEqual([
    { nodeId: 'version-release', ok: true, summary: '', startedAt: '2026-10-07T00:00:01.000Z', endedAt: '2026-10-07T00:02:00.000Z' },
    { nodeId: 'gate', ok: null, summary: '', startedAt: '2026-10-07T00:02:01.000Z' },
  ]);
  expect(runs.find((run) => run.runId === 'legacy')?.nodes).toEqual([{ nodeId: 'version-release', ok: false, summary: '' }]);
});

test('GATE-LIVE-OBS: a run sitting on gate carries the shard table of its own version; other runs and other versions do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-gate-shards-'));
  try {
    const folder = join(root, 'runs');
    mkdirSync(folder, { recursive: true });
    const gate = (version: string) => JSON.stringify({ status: 'running', path: ['version-release', 'gate'], startedAt: '2026-10-07T00:00:00.000Z',
      input: { version }, nodes: [{ nodeId: 'version-release', ok: true, output: '' }], currentNode: { nodeId: 'gate', startedAt: '2026-10-07T00:02:00.000Z' } });
    writeFileSync(join(folder, 'on-gate.json'), gate('0.2.20'));
    writeFileSync(join(folder, 'no-file.json'), gate('0.2.21'));
    writeFileSync(join(folder, 'publishing.json'), JSON.stringify({ status: 'running', path: ['gate', 'publish'], startedAt: '2026-10-06T00:00:00.000Z',
      input: { version: '0.2.20' }, nodes: [{ nodeId: 'gate', ok: true, output: '' }], currentNode: { nodeId: 'publish', startedAt: '2026-10-06T01:00:00.000Z' } }));
    writeGateShards(gateShardsPath('0.2.20', root), { v: 1, version: '0.2.20', updatedAt: '2026-10-07T00:30:00.000Z', shards: [
      { id: 'pod-0', state: 'running', startedAt: '2026-10-07T00:20:00.000Z', plannedMin: 20 },
      { id: 'pod-1', state: 'pending', waitReason: 'CPU 부족 31.2/32', plannedMin: 10 },
    ] });
    const runs = readReleaseRuns(null, folder, { ledgerRoot: root, now: Date.parse('2026-10-07T00:30:00.000Z') });
    if (runs === 'unavailable') throw new Error('unavailable');
    const onGate = runs.find((run) => run.runId === 'on-gate');
    expect(onGate?.gateShards?.shards.map((shard) => shard.state)).toEqual(['running', 'pending']);
    expect(onGate?.gateShards?.summary).toMatchObject({ total: 2, etaMin: 20, waitReasons: [{ reason: 'CPU 부족 31.2/32', count: 1 }] });
    expect(runs.find((run) => run.runId === 'no-file')?.gateShards).toBeUndefined();
    expect(runs.find((run) => run.runId === 'publishing')?.gateShards).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
