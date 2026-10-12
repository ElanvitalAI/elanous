// RELEASE-WAIVE-UNMEASURED (0.2.25 · OP policy 10-12): only an UNMEASURED gate may be waived — a measured failure or an
// already-waived gate is refused (fail-closed) · --reason is required · the waiver (with why the gate was unmeasured) is
// recorded on the run ledger. A gate cut before any verdict (SIGTERM mid-sweep, containerd kill) was blocked both by
// `resume --waive` (failed node only) and by `--partial` (needs a measured prior gate).
import { describe, expect, test } from 'bun:test';
import type { GraphRunState } from '../../src/graph-runner/runner.js';
import { STOPPED_NODE_ERROR } from '../../src/graph-runner/runner.js';
import { gateUnmeasuredDetail, releaseResumeWaiver } from './resume.js';
import { graphGateResult, type GateResult } from './gate-node.js';

type NodeRecord = GraphRunState['nodes'][number];
type SavedNode = Partial<NodeRecord> & { nodeId: string };

// publicWaiverReason copies the reason verbatim into public release notes, so it must stay printable ASCII
// (no Korean, no brackets) — the alternative-gate evidence is written as an English justification line.
const REASON = 'alternative gate evidence: host gate ran the same commit with zero failures; the pod gate was cut by SIGTERM before any verdict';

const run = (path: string[], nodes: SavedNode[]): GraphRunState =>
  ({ path, nodes: nodes as GraphRunState['nodes'], input: { version: '0.2.25' } }) as unknown as GraphRunState;

// The shapes the runner and gate-node actually write (runner.ts manageGraphRun · gate-node.ts graphGateResult).
const head: SavedNode[] = [
  { nodeId: 'start', ok: true, executed: true, exit: 0 },
  { nodeId: 'prepare', ok: true, executed: true, exit: 0 },
];
const stoppedGate = (): GraphRunState => run(['start', 'prepare', 'gate'], [...head,
  { nodeId: 'gate', ok: false, executed: false, exit: null, error: STOPPED_NODE_ERROR, endedAt: '2026-10-12T00:10:00.000Z', startedAt: '2026-10-12T00:00:00.000Z', seconds: 600 }]);
const gateThenFailed = (gate: Omit<SavedNode, 'nodeId'>): GraphRunState => run(['start', 'prepare', 'gate', 'failed'], [...head,
  { nodeId: 'gate', ok: false, executed: true, ...gate }, { nodeId: 'failed', ok: true, executed: false, exit: null }]);
const gateOutput = (result: Record<string, unknown>) => `[gate] sweeping\n${JSON.stringify({ commit: 'a'.repeat(40), introduced: [], preexisting: 0, ...result })}\n`;
const sweepIncomplete = () => gateThenFailed({ exit: 2, output: gateOutput({ outcome: 'error', verdict: 'fail',
  error: 'pod sweep incomplete: stalled shards 3, 7 (unmeasured: no test output within 600s of checkout — shards 3, 7)',
  stalledShards: [{ shard: 3, files: ['a.test.ts'], reason: 'no-output' }, { shard: 7, files: ['b.test.ts'], reason: 'exit-code' }],
  partialSummary: { pass: 900, fail: 4, errors: 0, ran: 904, files: 120 } }) });

describe('resume --waive gate: only an unmeasured gate', () => {
  test('① a gate cut by `graph runs stop` is waived and says why it was unmeasured', () => {
    const waived = releaseResumeWaiver(stoppedGate(), { from: 'gate', waive: 'gate', reason: REASON });
    expect(waived).toEqual({ nodeId: 'gate', reason: REASON, unmeasured: `stopped: ${STOPPED_NODE_ERROR} after 600s`,
      acceptedRegressions: [{ id: 'waive:gate', note: REASON }] });
  });

  test('② a gate process that ended with exit null before printing any verdict is waived', () => {
    const waived = releaseResumeWaiver(gateThenFailed({ exit: null, output: '[gate] sweeping shard 4/12\n', error: 'SIGTERM' }), { from: 'gate', waive: 'gate', reason: REASON });
    expect(waived?.unmeasured).toBe('no-verdict: gate process ended with exit null and no result line — SIGTERM');
    // A verdict printed before the kill is a measurement, even with log lines after it.
    const printed = gateThenFailed({ exit: null, output: gateOutput({ outcome: 'fail', verdict: 'fail', introduced: ['src/a.test.ts > breaks'] }) + '[gate] cleanup\n' });
    expect(() => releaseResumeWaiver(printed, { from: 'gate', waive: 'gate', reason: REASON })).toThrow('cannot waive a safety');
  });

  test('③ an incomplete sweep (outcome error · introduced 0) is waived with the stalled-shard detail', () => {
    const waived = releaseResumeWaiver(sweepIncomplete(), { from: 'gate', waive: 'gate', reason: REASON });
    expect(waived?.unmeasured).toStartWith('sweep incomplete: pod sweep incomplete: stalled shards 3, 7');
    // What was measured stays on the ledger: each stalled shard's reason and the finished shards' counts.
    expect(waived?.unmeasured).toEndWith('· stalled shards 2 (no-output×1, exit-code×1) · finished shards measured pass 900 fail 4 errors 0 ran 904');
    expect(releaseResumeWaiver(gateThenFailed({ exit: 2, output: gateOutput({ outcome: 'error', error: 'sweep incomplete: no tests ran' }) }),
      { from: 'gate', waive: 'gate', reason: REASON })?.unmeasured).toBe('sweep incomplete: sweep incomplete: no tests ran');
  });

  test('a measured gate failure (outcome fail · introduced > 0) is refused', () => {
    const measured = gateThenFailed({ exit: 1, output: gateOutput({ outcome: 'fail', verdict: 'fail', introduced: ['src/a.test.ts > breaks'] }) });
    expect(() => releaseResumeWaiver(measured, { from: 'gate', waive: 'gate', reason: REASON }))
      .toThrow('only an unmeasured gate — stopped, killed or sweep incomplete — may be waived');
    // A bare exit-1 failure with no result line is a measured failure too (only a signal death is «killed»).
    expect(() => releaseResumeWaiver(gateThenFailed({ exit: 1 }), { from: 'gate', waive: 'gate', reason: REASON }))
      .toThrow('cannot waive a safety, side-effect or approval node');
  });

  test('an error outcome that may follow a verdict, or names introduced failures, is refused', () => {
    for (const result of [
      { outcome: 'error', error: 'baseline persistence: EACCES' },
      { outcome: 'error', error: 'cleanup: rm failed' },
      { outcome: 'error', error: 'pod sweep incomplete: stalled shards 1', introduced: ['src/a.test.ts > breaks'] },
      { outcome: 'error', error: 'pod sweep incomplete: stalled shards 1', introduced: 'none' },
    ]) {
      expect(() => releaseResumeWaiver(gateThenFailed({ exit: 2, output: gateOutput(result) }), { from: 'gate', waive: 'gate', reason: REASON }))
        .toThrow('cannot waive a safety');
    }
  });

  test('an already-waived gate is refused (no double waiver)', () => {
    const already = run(['start', 'prepare', 'gate'], [...head,
      { nodeId: 'gate', ok: true, executed: false, exit: 0, waiver: { reason: 'earlier', at: '2026-10-10T00:00:00.000Z', original: { exit: null, error: STOPPED_NODE_ERROR } } }]);
    expect(() => releaseResumeWaiver(already, { from: 'gate', waive: 'gate', reason: REASON }))
      .toThrow('--waive gate requires the failed executable node on the saved path');
    // Even a stopped-shaped record that somehow still carries a waiver is not unmeasured.
    const marked = stoppedGate();
    marked.nodes.at(-1)!.waiver = { reason: 'earlier', at: '2026-10-10T00:00:00.000Z', original: { exit: null } };
    expect(() => releaseResumeWaiver(marked, { from: 'gate', waive: 'gate', reason: REASON })).toThrow('requires the failed executable node');
  });

  test('--reason is required for a gate waiver, and must be a public sentence', () => {
    expect(() => releaseResumeWaiver(stoppedGate(), { from: 'gate', waive: 'gate' })).toThrow('--waive <node> and --reason <text> must be supplied together');
    expect(() => releaseResumeWaiver(stoppedGate(), { from: 'gate', waive: 'gate', reason: '   ' })).toThrow('--reason must not be empty');
    expect(() => releaseResumeWaiver(stoppedGate(), { from: 'gate', waive: 'gate', reason: 'see /Users/me/gate.log [TC]' })).toThrow('unsafe public waiver reason');
  });

  test('a stopped gate that is not the last record, or a ledger without the gate record, is refused', () => {
    const later = stoppedGate();
    later.path.push('mac-smoke');
    later.nodes.push({ nodeId: 'mac-smoke', ok: false, executed: false, exit: null } as NodeRecord);
    expect(() => releaseResumeWaiver(later, { from: 'gate', waive: 'gate', reason: REASON })).toThrow('requires the failed executable node');
    // A run whose runner died without `graph runs stop` has no gate record — stop it first (the runner refuses the mismatch too).
    const noRecord = run(['start', 'prepare', 'gate'], head);
    expect(() => releaseResumeWaiver(noRecord, { from: 'gate', waive: 'gate', reason: REASON })).toThrow('requires the failed executable node');
  });

  test('other nodes keep their rules: mac-smoke measured failure still waivable, --from alone still not a waiver', () => {
    const mac = run(['mac-smoke', 'failed'], [{ nodeId: 'mac-smoke', ok: false, executed: true, exit: 1 }, { nodeId: 'failed' }]);
    const waived = releaseResumeWaiver(mac, { from: 'mac-smoke', waive: 'mac-smoke', reason: REASON });
    expect(waived).toEqual({ nodeId: 'mac-smoke', reason: REASON, acceptedRegressions: [{ id: 'waive:mac-smoke', note: REASON }] });
    expect(() => releaseResumeWaiver(stoppedGate(), { from: 'gate', waive: 'prepare', reason: REASON })).toThrow('--from must name the waived node');
  });
});

describe('gateUnmeasuredDetail reads only the gate record', () => {
  test('a non-gate node is never unmeasured', () => {
    const tui = run(['tui'], [{ nodeId: 'tui', ok: false, executed: false, exit: null, error: STOPPED_NODE_ERROR }]);
    expect(gateUnmeasuredDetail(tui, 0)).toBeUndefined();
  });
});

describe('the rule reads the line gate-node really prints (graphGateResult)', () => {
  const base: GateResult = { outcome: 'error', commit: 'a'.repeat(40), introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [],
    stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
  const printed = (result: GateResult, exit: number) => gateThenFailed({ exit, output: `${JSON.stringify(graphGateResult(result, true))}\n` });

  test('an incomplete pod sweep (StalledPodShards message) is unmeasured', () => {
    const state = printed({ ...base, error: 'pod sweep incomplete: stalled shards 3 (unmeasured: no test output within 600s of checkout — shards 3)',
      stalledShards: [{ shard: 3, files: ['a.test.ts'], reason: 'no-output', stall: { seconds: 600, sinceCheckoutMs: 600_000 } }],
      partialSummary: { pass: 10, fail: 0, errors: 0, ran: 10, files: 2 } }, 2);
    expect(gateUnmeasuredDetail(state, 2)).toStartWith('sweep incomplete: pod sweep incomplete: stalled shards 3');
  });

  test('a host shard without a summary (`<group> shard incomplete`) is unmeasured', () => {
    expect(gateUnmeasuredDetail(printed({ ...base, error: 'gate-3 shard incomplete (rc=137; pass summary missing)\n…' }, 2), 2))
      .toBe('sweep incomplete: gate-3 shard incomplete (rc=137; pass summary missing)');
  });

  test('a regression verdict (outcome fail) is measured', () => {
    expect(gateUnmeasuredDetail(printed({ ...base, outcome: 'regression', introduced: ['src/a.test.ts > breaks'] }, 1), 2)).toBeUndefined();
  });
});
