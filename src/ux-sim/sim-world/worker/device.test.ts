import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';
import { parseEventFrame } from '../../../agent-events/protocol.js';
import { createWorkerSim } from './device.js';
import { simWorldScenarios } from './scenarios.js';

test('worker device emits existing wire frames and deterministic injected anomalies', () => {
  const worker = createWorkerSim('pane-A', () => 1234);
  const first = worker.emit({ kind: 'state', state: 'working' });
  const second = worker.approval();
  expect(first).toEqual({ op: 'event', v: 1, ws: 'SIM-WORKER', pane: 'pane-A', sid: 'sim-pane-A', seq: 1, at: 1234, event: { kind: 'state', state: 'working' } });
  expect(second).toMatchObject({ seq: 2, event: { kind: 'state', state: 'blocked', message: 'approval required' } });
  expect(parseEventFrame(second).ok).toBe(true);
  expect(worker.duplicateAndLate(first, second).map(frame => frame.seq)).toEqual([2, 2, 1]);
  expect(worker.stall()).toEqual([]);
  expect(worker.die()).toMatchObject({ seq: 3, event: { kind: 'state', state: 'exited' } });
  expect(worker.flood(3).map(frame => frame.event)).toEqual([
    { kind: 'notice', level: 'info', text: 'output-1' },
    { kind: 'notice', level: 'info', text: 'output-2' },
    { kind: 'notice', level: 'info', text: 'output-3' },
  ]);
  expect(simWorldScenarios.map(item => item.id)).toEqual(['WORKER-STALL', 'WORKER-DEATH', 'WORKER-APPROVAL', 'WORKER-REORDER', 'WORKER-FLOOD', 'WORKER-MIXED', 'WORKER-BINDINGS', 'WORKER-WIRE-ACCEPT', 'WORKER-WIRE-REJECT']);
});


test('four kinds forward their frames to the supplied nexus port without replacing it', async () => {
  const calls: Array<{ kind: string; pane: string | undefined; seq: number }> = [];
  const port = { async publish(kind: string, frame: { pane?: string; seq: number }) { calls.push({ kind, pane: frame.pane, seq: frame.seq }); } };
  for (const kind of ['shell', 'inline-agent', 'pane-agent', 'cli'] as const) {
    const worker = createWorkerSim(`pane-${kind}`, () => 42, kind);
    await worker.publish(port, { kind: 'state', state: 'working' });
  }
  expect(calls).toEqual([
    { kind: 'shell', pane: 'pane-shell', seq: 1 },
    { kind: 'inline-agent', pane: 'pane-inline-agent', seq: 1 },
    { kind: 'pane-agent', pane: 'pane-pane-agent', seq: 1 },
    { kind: 'cli', pane: 'pane-cli', seq: 1 },
  ]);
});

test('worker world through the kernel: wire accept/reject are measured green, the seven injections stay red with the stated reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-world-'));
  try {
    const summary = await runSimWorlds({ worldId: 'worker', seed: 1, engine: 'legacy', only: null, expectBaseFile: null, stateRoot: root, runId: 'w', isolate: 'inline' });
    expect(summary.scenarios.map(row => `${row.scenario}:${row.verdict}`)).toEqual([
      'WORKER-STALL:xfail', 'WORKER-DEATH:xfail', 'WORKER-APPROVAL:xfail', 'WORKER-REORDER:xfail', 'WORKER-FLOOD:xfail', 'WORKER-MIXED:xfail', 'WORKER-BINDINGS:xfail',
      'WORKER-WIRE-ACCEPT:pass', 'WORKER-WIRE-REJECT:pass',
    ]);
    expect(summary.ok).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000); // 출처: kernel.test.ts inline runs — allowance for a loaded gate host.

test('a restarted sender in the same pane is a new sid whose seq starts again at 1 (WORKER-CONTRACT §1: restart = new sid, same chain)', () => {
  const worker = createWorkerSim('pane-R', () => 7);
  worker.emit({ kind: 'state', state: 'working' });
  const second = worker.emit({ kind: 'state', state: 'idle' });
  const again = worker.restart().emit({ kind: 'state', state: 'working' });
  expect([second.sid, second.seq]).toEqual(['sim-pane-R', 2]);
  expect([again.sid, again.seq, again.pane]).toEqual(['sim-pane-R-r2', 1, 'pane-R']);
  expect(parseEventFrame(JSON.parse(JSON.stringify(again))).ok).toBe(true);
});
