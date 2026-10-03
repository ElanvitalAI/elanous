import { describe, expect, test } from 'bun:test';
import type { DaemonClient } from './daemon-client';
import { getOpsChecklist, getReleaseNodeLog, getReleaseRuns, getSeats, type OpsSeats } from './ops-api';

const RUN = { runId: 'run-1', status: 'running', startedAt: '2026-10-02T00:00:00Z', version: '0.2.9', path: ['gate'], nodes: [{ nodeId: 'gate', ok: null, summary: '진행' }] };
const CHECKLIST = { version: '0.2.9', items: [{ id: 'K1', title: '판정', status: 'yellow', owner: 'OP', updatedAt: 'now', evidence: '근거' }], history: [], byOwner: { OP: 1 } };

function client(reply: () => Promise<Response>, calls: Array<{ path: string; method: string }>): DaemonClient {
  return { fetchResponse: async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    return reply();
  } } as DaemonClient;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('OPS seats read-only API', () => {
  const row = { seat: 'OP', role: 'COO', now: null, landed: null, blocked: [], pendingDecisions: null, checklist: null };
  const payload: OpsSeats = { date: '2026-10-02', seats: [{ ...row, seat: 'OP' }] };
  test('GET preserves unreadable null fields and encodes date', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    expect(await getSeats(client(async () => json(payload), calls), '2026-10-02 &')).toEqual({ kind: 'ready', data: payload });
    expect(calls).toEqual([{ path: '/v1/ops/seats?date=2026-10-02%20%26', method: 'GET' }]);
    calls.length = 0;
    await getSeats(client(async () => json(payload), calls));
    expect(calls[0]?.path).toBe('/v1/ops/seats');
  });
  test('403, HTTP, network and malformed nested fields fail closed', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    expect(await getSeats(client(async () => json({}, 403), calls))).toEqual({ kind: 'forbidden' });
    expect(await getSeats(client(async () => json({}, 500), calls))).toEqual({ kind: 'error', status: 500 });
    expect(await getSeats(client(async () => { throw Error('offline'); }, calls))).toEqual({ kind: 'error', status: 0 });
    for (const bad of [
      { ...payload, seats: [{ ...row, landed: [{ pr: '1', title: 'x', at: 'now', checklistId: null }] }] },
      { ...payload, seats: [{ ...row, blocked: [{ id: 'x', title: 'x', status: 'green' }] }] },
      { ...payload, seats: [{ ...row, pendingDecisions: -1 }] },
      { ...payload, seats: [{ ...row, checklist: { green: 0, yellow: 0, red: '0', done: 0 } }] },
      { ...payload, seats: [{ seat: 'OTHER', now: null, landed: [], blocked: [], pendingDecisions: 0, checklist: null }] },
      { date: '2026-10-02', seats: 'not an array' },
    ]) expect(await getSeats(client(async () => json(bad), calls))).toEqual({ kind: 'error', status: 200 });
    expect(calls.every((entry) => entry.method === 'GET')).toBe(true);
  });
});

describe('OPS read-only daemon API', () => {
  test('normalizes optional, absent and malformed schedule without rejecting checklist rows', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const read = (schedule: unknown, absent = false) => getOpsChecklist(client(async () => json(absent ? CHECKLIST : { ...CHECKLIST, schedule }), calls), '0.2.10');
    const valid = { cutAt: '2026-10-02T23:00:00.000Z', landBy: '2026-10-02T21:30:00Z' };
    expect(await read(valid)).toMatchObject({ kind: 'ready', data: { schedule: valid, items: CHECKLIST.items } });
    expect(await read({ cutAt: valid.cutAt, landBy: null })).toMatchObject({ kind: 'ready', data: { schedule: { cutAt: valid.cutAt, landBy: null } } });
    expect(await read(null)).toMatchObject({ kind: 'ready', data: { schedule: null } });
    expect(await read(undefined, true)).toMatchObject({ kind: 'ready', data: { schedule: null } });
    for (const schedule of [{ cutAt: 'tomorrow', landBy: null }, { cutAt: valid.cutAt, landBy: 12 },
      { cutAt: '2026-02-30T08:00:00Z', landBy: null }, { cutAt: valid.cutAt }, 'bad']) {
      expect(await read(schedule)).toMatchObject({ kind: 'ready', data: { schedule: null, items: CHECKLIST.items } });
    }
    expect(calls.every((call) => call.path === '/v1/ops/checklist?version=0.2.10' && call.method === 'GET')).toBe(true);
  });
  test('three authenticated-client GETs decode shapes, encoded identifiers and checklist counts', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const c = client(async () => json(calls.length === 1 ? [RUN] : calls.length === 2 ? { log: 'last 4000 chars' } : CHECKLIST), calls);
    expect(await getReleaseRuns(c, '0.2.9')).toEqual({ kind: 'ready', data: [RUN] });
    expect(await getReleaseNodeLog(c, 'run-1', 'gate')).toEqual({ kind: 'ready', data: { log: 'last 4000 chars' } });
    expect(await getOpsChecklist(c, '0.2.9')).toMatchObject({ kind: 'ready', data: { green: 0, yellow: 1, red: 0, done: 0, items: CHECKLIST.items } });
    expect(calls).toEqual([
      { path: '/v1/ops/release/runs?version=0.2.9', method: 'GET' },
      { path: '/v1/ops/release/runs/run-1/nodes/gate/log', method: 'GET' },
      { path: '/v1/ops/checklist?version=0.2.9', method: 'GET' },
    ]);
    calls.length = 0;
    await getReleaseNodeLog(c, 'run/1', 'node?x');
    expect(calls[0]?.path).toBe('/v1/ops/release/runs/run%2F1/nodes/node%3Fx/log');
  });

  test('403 is forbidden and other HTTP, invalid body and network failures are nonthrowing errors on all calls', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    for (const call of [(c: DaemonClient) => getReleaseRuns(c), (c: DaemonClient) => getReleaseNodeLog(c, 'run-1', 'gate'), (c: DaemonClient) => getOpsChecklist(c, '0.2.9')]) {
      expect(await call(client(async () => json({ error: 'forbidden' }, 403), calls))).toEqual({ kind: 'forbidden' });
      expect(await call(client(async () => json({ error: 'oops' }, 502), calls))).toEqual({ kind: 'error', status: 502 });
      expect(await call(client(async () => json({ bad: 'shape' }), calls))).toEqual({ kind: 'error', status: 200 });
      expect(await call(client(async () => { throw new Error('offline'); }, calls))).toEqual({ kind: 'error', status: 0 });
    }
    expect(calls.every((entry) => entry.method === 'GET')).toBe(true);
  });

  test('rejects malformed nested run and checklist rows instead of treating them as trusted objects', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    expect(await getReleaseRuns(client(async () => json([{ ...RUN, nodes: [{ nodeId: 'gate', ok: 'true', summary: 'x' }] }]), calls)))
      .toEqual({ kind: 'error', status: 200 });
    expect(await getOpsChecklist(client(async () => json({ ...CHECKLIST, items: [{ ...CHECKLIST.items[0], status: 7 }] }), calls), '0.2.9'))
      .toEqual({ kind: 'error', status: 200 });
    // 모르는 상태 «문자열»은 버리지 않는다 — 칸 하나 때문에 화면 전체가 오류가 되지 않게(수에는 안 든다).
    const unknown = await getOpsChecklist(client(async () => json({ items: [{ ...CHECKLIST.items[0], status: 'blocked' }], version: '0.2.9' }), calls), '0.2.9');
    expect(unknown.kind).toBe('ready');
    if (unknown.kind === 'ready') { expect(unknown.data.items[0]!.status).toBe('blocked'); expect(unknown.data.green + unknown.data.yellow + unknown.data.red + unknown.data.done).toBe(0); }
    expect(await getOpsChecklist(client(async () => json({ ...CHECKLIST, byOwner: { OP: 'one' } }), calls), '0.2.9'))
      .toEqual({ kind: 'error', status: 200 });
    expect(await getReleaseNodeLog(client(async () => json({ log: 12 }), calls), 'run', 'node'))
      .toEqual({ kind: 'error', status: 200 });
  });
});
