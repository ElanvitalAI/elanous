import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimIncident, type IncidentClaim, type IncidentClaimStore } from '../../supervision/incident-claim.js';
import { canonicalJson, createSimWorldRecorder } from './recorder.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tempRoot = () => { const root = mkdtempSync(join(tmpdir(), 'sim-world-recorder-')); roots.push(root); return root; };

function memoryClaimStore(): IncidentClaimStore {
  const rows = new Map<string, IncidentClaim | null>();
  return {
    async transact(incidentId, update) {
      const { next, result } = update(rows.get(incidentId) ?? null);
      rows.set(incidentId, next);
      return result;
    },
    async withCurrent(input, action) {
      const row = rows.get(input.incidentId);
      if (!row || row.claimToken !== input.claimToken || row.expiresAtMs <= input.now()) return { current: false };
      return { current: true, value: await action() };
    },
  };
}

/** A scripted scenario touching every recorder entry point; the clock is a literal counter. */
async function recordOnce(dir: string) {
  const recorder = createSimWorldRecorder({ dir, world: 'ta', scenario: 'A02', engine: 'legacy', seed: 1 });
  let now = 1_000;
  const seams = recorder.wrapSeams({
    gate: async (input: { round: number }) => ({ ok: input.round > 1 }),
    openPr: (title: string) => { if (!title) throw new Error('empty title'); return { number: 7 }; },
  });
  for (const [node, round] of [['implement', 1], ['gate', 1], ['rework', 1], ['implement', 2], ['gate', 2]] as const) recorder.onNodeEntry(node, round);
  recorder.onProgress({ stage: 'gate', message: 'shard 1 failed' });
  await seams.gate({ round: 1 });
  await seams.gate({ round: 2 });
  expect(() => seams.openPr('')).toThrow('empty title');
  seams.openPr('feat: x');
  recorder.nodeLifecycle({ phase: 'arrival', nodeId: 'merge', attempt: 1, visit: 1 });
  recorder.nodeLifecycle({ phase: 'end', nodeId: 'merge', attempt: 1, visit: 1, outcome: 'ok', nextNodeId: 'done' });
  const store = recorder.wrapClaimStore(memoryClaimStore());
  const claimed = await claimIncident(store, { incidentId: 'run-stall-1', ownerLoopRef: 'loop:run-doctor@1',
    ownerOrder: ['loop:run-doctor@1', 'loop:guardian@1'], now: () => now, leaseMs: 900_000 });
  expect(claimed.disposition).toBe('claimed');
  await store.withCurrent({ incidentId: 'run-stall-1', claimToken: claimed.claim!.claimToken, now: () => now }, () => 'healed');
  now += 1_000_000;
  await claimIncident(store, { incidentId: 'run-stall-1', ownerLoopRef: 'loop:guardian@1',
    ownerOrder: ['loop:run-doctor@1', 'loop:guardian@1'], now: () => now, leaseMs: 900_000 });
  recorder.event('scenario.note', { z: 1, a: [undefined, () => 1], when: new Date(0) });
  return recorder.finalize({ world: 'ta', scenario: 'A02', engine: 'legacy', seed: 1, expected: 'green', actual: 'pass', verdict: 'pass', diffFirstLine: null, observedReason: null });
}

const FILES = ['events.jsonl', 'walk.json', 'seam-calls.jsonl', 'claims.jsonl', 'verdict.json'];

describe('D10 sim-recorder', () => {
  test('the same scripted run twice writes byte-identical files', async () => {
    const root = tempRoot();
    expect(await recordOnce(join(root, 'first'))).toEqual({ ok: true, dir: join(root, 'first') });
    expect(await recordOnce(join(root, 'second'))).toEqual({ ok: true, dir: join(root, 'second') });
    for (const name of FILES) expect(readFileSync(join(root, 'second', name), 'utf8')).toBe(readFileSync(join(root, 'first', name), 'utf8'));
  });

  test('walk.json has the fixed H5 shape: entry order, per-node visit, source, terminal', async () => {
    const root = tempRoot();
    await recordOnce(root);
    expect(JSON.parse(readFileSync(join(root, 'walk.json'), 'utf8'))).toEqual({
      engine: 'legacy', scenario: 'A02', schema: 'sim-world.walk/1', seed: 1, terminal: 'merge', world: 'ta',
      steps: [
        { i: 0, node: 'implement', round: 1, source: 'onNodeEntry', visit: 1 },
        { i: 1, node: 'gate', round: 1, source: 'onNodeEntry', visit: 1 },
        { i: 2, node: 'rework', round: 1, source: 'onNodeEntry', visit: 1 },
        { i: 3, node: 'implement', round: 2, source: 'onNodeEntry', visit: 2 },
        { i: 4, node: 'gate', round: 2, source: 'onNodeEntry', visit: 2 },
        { i: 5, node: 'merge', round: 1, source: 'nodeLifecycle', visit: 1 },
      ],
    });
    expect(readFileSync(join(root, 'walk.json'), 'utf8').startsWith('{\n  "engine": "legacy",\n')).toBe(true);
  });

  test('seam calls, throws and claim ops are recorded in call order with UUIDs normalised', async () => {
    const root = tempRoot();
    await recordOnce(root);
    expect(readFileSync(join(root, 'seam-calls.jsonl'), 'utf8')).toBe([
      '{"input":{"round":1},"output":{"ok":false},"seam":"gate","seq":0}',
      '{"input":{"round":2},"output":{"ok":true},"seam":"gate","seq":1}',
      '{"error":"empty title","input":"","seam":"openPr","seq":2}',
      '{"input":"feat: x","output":{"number":7},"seam":"openPr","seq":3}',
      '',
    ].join('\n'));
    const claims = readFileSync(join(root, 'claims.jsonl'), 'utf8').trim().split('\n').map((row) => JSON.parse(row));
    expect(claims.map((row) => [row.op, row.seq, row.result?.disposition ?? row.current])).toEqual([
      ['transact', 0, 'claimed'], ['withCurrent', 1, true], ['transact', 2, 'escalated'],
    ]);
    expect(claims[0].after.claimToken).toBe('uuid-1');
    expect(claims[1].claimToken).toBe('uuid-1');
    expect(claims[2].after.claimToken).toBe('uuid-2');
    expect(claims[2].after.ownerLoopRef).toBe('loop:guardian@1');
    const events = readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(events[0]).toBe('{"data":{"message":"shard 1 failed","stage":"gate"},"kind":"si.progress","seq":0}');
    expect(events.at(-1)).toBe('{"data":{"a":[null,"[function]"],"when":"1970-01-01T00:00:00.000Z","z":1},"kind":"scenario.note","seq":3}');
  });

  test('a failed disk write is returned, not thrown and not reported as ok', async () => {
    const recorder = createSimWorldRecorder({ dir: '/sim/disk-full', world: 'memory', scenario: 'M07', engine: 'legacy', seed: 1,
      fs: { mkdir: () => {}, write: (path) => { if (path.endsWith('walk.json')) throw new Error('ENOSPC: no space left on device'); } } });
    recorder.step('write');
    expect(recorder.finalize({ world: 'memory', scenario: 'M07', engine: 'legacy', seed: 1, expected: 'red', actual: 'fail', verdict: 'xfail', diffFirstLine: 'x', observedReason: null }))
      .toEqual({ ok: false, dir: '/sim/disk-full', error: 'ENOSPC: no space left on device' });
  });

  test('a claim store failure is recorded and rethrown', async () => {
    const root = tempRoot();
    const recorder = createSimWorldRecorder({ dir: root, world: 'supervisors', scenario: 'C09', engine: 'graph', seed: 3 });
    const store = recorder.wrapClaimStore({
      transact: async () => { throw new Error('lock holder died'); },
      withCurrent: async () => ({ current: false }),
    });
    await expect(store.transact('inc-1', () => ({ next: null, result: 1 }))).rejects.toThrow('lock holder died');
    recorder.finalize({ world: 'supervisors', scenario: 'C09', engine: 'graph', seed: 3, expected: 'red', actual: 'fail', verdict: 'xfail', diffFirstLine: 'x', observedReason: null });
    expect(readFileSync(join(root, 'claims.jsonl'), 'utf8')).toBe('{"error":"lock holder died","incidentId":"inc-1","op":"transact","seq":0}\n');
  });

  test('MF2: an async seam keeps its START-order seq; results and rejections land in their own slots', async () => {
    const root = tempRoot();
    const recorder = createSimWorldRecorder({ dir: root, world: 'ta', scenario: 'A07', engine: 'graph', seed: 2 });
    const gates: Record<string, () => void> = {};
    const seams = recorder.wrapSeams({
      call: (name: string) => new Promise<string>((resolve) => { gates[name] = () => resolve(`${name}-done`); }),
      fail: (name: string) => new Promise<string>((_, reject) => { gates[name] = () => reject(new Error(`${name} refused`)); }),
    });
    const a = seams.call('A');
    const b = seams.call('B');
    const c = seams.fail('C');
    const d = seams.call('D');
    gates.B!();
    await b;
    gates.C!();
    await expect(c).rejects.toThrow('C refused');
    gates.A!();
    await a;
    recorder.finalize({ world: 'ta', scenario: 'A07', engine: 'graph', seed: 2, expected: 'red', actual: 'fail', verdict: 'xfail', diffFirstLine: 'x', observedReason: 'x' });
    expect(readFileSync(join(root, 'seam-calls.jsonl'), 'utf8')).toBe([
      '{"input":"A","output":"A-done","seam":"call","seq":0}',
      '{"input":"B","output":"B-done","seam":"call","seq":1}',
      '{"error":"C refused","input":"C","seam":"fail","seq":2}',
      '{"input":"D","pending":true,"seam":"call","seq":3}',
      '',
    ].join('\n'));
    void d;
  });

  test('MF3: a getter that throws during serialization is { ok:false }, never a throw', () => {
    const recorder = createSimWorldRecorder({ dir: tempRoot(), world: 'memory', scenario: 'M01', engine: 'legacy', seed: 1 });
    recorder.event('hostile', { value: { get boom() { throw new Error('getter exploded'); } } });
    const verdict = { world: 'memory', scenario: 'M01', engine: 'legacy', seed: 1, expected: 'red', actual: 'fail', verdict: 'xfail', diffFirstLine: 'x', observedReason: 'x' } as const;
    expect(recorder.finalize(verdict)).toMatchObject({ ok: false, error: 'record serialization failed: events seq 0: getter exploded' });
    const clean = createSimWorldRecorder({ dir: tempRoot(), world: 'memory', scenario: 'M01', engine: 'legacy', seed: 1 });
    const hostileVerdict = new Proxy({ ...verdict }, { ownKeys: () => { throw new Error('proxy exploded'); } });
    expect(clean.finalize(hostileVerdict)).toMatchObject({ ok: false, error: 'proxy exploded' });
  });

  test('MF4: canonical JSON emits keys in code-point order, integer-like keys included (byte-exact)', () => {
    expect(canonicalJson({ a: 3, 2: 2, 10: 1 })).toBe('{"10":1,"2":2,"a":3}');
    expect(canonicalJson({ z: { 10: [1, { 2: true, 1: null }] }, '': 0 })).toBe('{"":0,"z":{"10":[1,{"1":null,"2":true}]}}');
    expect(canonicalJson({ b: [], a: {} }, 2)).toBe('{\n  "a": {},\n  "b": []\n}');
    expect(canonicalJson({ list: [1, undefined], drop: undefined, when: new Date(0) }, 2))
      .toBe('{\n  "list": [\n    1,\n    null\n  ],\n  "when": "1970-01-01T00:00:00.000Z"\n}');
  });
});
