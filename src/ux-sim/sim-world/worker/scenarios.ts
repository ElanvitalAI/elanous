import { parseEventFrame } from '../../../agent-events/protocol.js';
import { createWorkerSim, type SimWorkerKind } from './device.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

type WorkerSim = ReturnType<typeof createWorkerSim>;
export const simWorldDevices: readonly SimWorldDeviceDef<WorkerSim>[] = [{
  id: 'WORKER-SIM', title: 'deterministic worker event source',
  create: () => createWorkerSim('sim-pane', () => 1000),
}];

const scenario = (id: string, title: string, inject: (worker: WorkerSim) => readonly unknown[]): SimWorldScenario => ({
  id, title, devices: ['WORKER-SIM'],
  async run(ctx) {
    const events = inject(ctx.device<WorkerSim>('WORKER-SIM'));
    for (const event of events) ctx.recorder.event('worker-sim:injected', { event });
    // RED means missing observation, not a claim that the future consumer is defective.
    return { ok: false, reason: 'worker consumer not connected', diff: `${id}: ${events.length} injected frames; worker consumer has not been wired or observed` };
  },
});

/** Wire consumer boundary (WORKER-UNIFY §6-2 S1): what the production v1 frame reader accepts, and what it refuses with a reason. */
const wire = (id: string, title: string, check: (worker: WorkerSim) => string | null): SimWorldScenario => ({
  id, title, devices: ['WORKER-SIM'],
  async run(ctx) {
    const diff = check(ctx.device<WorkerSim>('WORKER-SIM'));
    ctx.recorder.event('worker-sim:wire', { id, diff });
    return diff === null ? { ok: true } : { ok: false, reason: 'wire boundary mismatch', diff };
  },
});
const over = (value: unknown): unknown => JSON.parse(JSON.stringify(value)); // one frame = one JSON line on the socket

export const wireScenarios: readonly SimWorldScenario[] = [
  wire('WORKER-WIRE-ACCEPT', 'a worker frame survives the wire and the v1 reader accepts it', worker => {
    const sent = [worker.emit({ kind: 'state', state: 'working' }), worker.emit({ kind: 'notice', level: 'warn', text: 'disk low' }), worker.emit({ kind: 'state', state: 'done' })];
    const got = sent.map(frame => parseEventFrame(over(frame)));
    const seen = got.map(row => row.ok ? `${row.frame.seq}:${row.frame.event.kind}` : `refused:${row.reason}`).join(',');
    return seen === '1:state,2:notice,3:state' ? null : `expected 1:state,2:notice,3:state got ${seen}`;
  }),
  wire('WORKER-WIRE-REJECT', 'frames the v1 reader cannot represent are refused with a stated reason', worker => {
    const good = worker.emit({ kind: 'state', state: 'working' });
    const refused = [
      { ...good, v: 2 },
      { ...good, event: { kind: 'result', ok: true } }, // contract §3 own event — not in wire v1
      { ...good, event: { kind: 'state', state: 'needs-approval' } }, // contract §2 state — wire v1 says `blocked`
      { ...good, seq: 0 },
    ].map(frame => { const row = parseEventFrame(over(frame)); return row.ok ? 'accepted' : `${row.ignore ? 'ignore' : 'reject'}:${row.reason}`; });
    const want = ['ignore:unknown protocol version 2', 'ignore:unknown event kind result', 'reject:state: unknown state', 'reject:frame needs ws, sid, seq and at'];
    return refused.join('|') === want.join('|') ? null : `expected ${want.join('|')} got ${refused.join('|')}`;
  }),
];

export const simWorldScenarios: readonly SimWorldScenario[] = [
  scenario('WORKER-STALL', 'silent worker becomes stalled', worker => [worker.emit({ kind: 'state', state: 'working' }), ...worker.stall()]),
  scenario('WORKER-DEATH', 'dead worker becomes terminal', worker => [worker.emit({ kind: 'state', state: 'working' }), worker.die()]),
  scenario('WORKER-APPROVAL', 'approval wait is visible', worker => [worker.emit({ kind: 'state', state: 'working' }), worker.approval()]),
  scenario('WORKER-REORDER', 'duplicate and late frames do not rewind state', worker => {
    const first = worker.emit({ kind: 'state', state: 'working' });
    const newer = worker.emit({ kind: 'state', state: 'idle' });
    return [first, ...worker.duplicateAndLate(first, newer)];
  }),
  scenario('WORKER-FLOOD', 'output burst remains observable', worker => worker.flood(25)), // 출처: #95169 burst injection scenario, not a production bound.
  scenario('WORKER-MIXED', 'mixed-kind fanout reports through one nexus watch', () => {
    const kinds: readonly SimWorkerKind[] = ['shell', 'inline-agent', 'pane-agent', 'cli'];
    return kinds.map(kind => ({ kind, frame: createWorkerSim(`pane-${kind}`, () => 1000, kind).emit({ kind: 'state', state: 'working' }) }));
  }),
  scenario('WORKER-BINDINGS', 'one envelope has equal semantics across bindings', () => []),
  ...wireScenarios,
];
