import { describe, expect, test } from 'bun:test';
import { loadRunLedgerWithMetadata, type RunLedgerEntry } from './run-ledger.js';
import { projectRunLedgerSteps } from './run-step-projection.js';

const runId = 'run-00000000-0000-0000-0000-000000000001';
const timestamp = '2026-10-09T00:00:00.000Z';
const entry = (seq: number, event: string, data: Record<string, unknown>): RunLedgerEntry => ({
  timestamp, runId, event, data: { seq, ...data },
});

function fromJsonl(entries: readonly RunLedgerEntry[]) {
  const source = entries.map((item) => JSON.stringify(item)).join('\n') + '\n';
  return loadRunLedgerWithMetadata(runId, '/unused', () => source)!.entries;
}

describe('projectRunLedgerSteps', () => {
  test('projects every step kind from JSONL, sorted by seq rather than timestamp or input order', () => {
    const records = [
      entry(11, 'unit-collapsed', { node: 'implement', resolution: 0, decider: 'supervisor', reason: 'done' }),
      entry(2, 'node-exit', { node: 'author', outcome: 'ok' }),
      entry(3, 'edge-taken', { from: 'author', to: 'plan', via: 'outcome' }),
      entry(4, 'node-skipped', { node: 'pool-admit', reason: 'condition', condition: 'substrate == pod' }),
      entry(9, 'node-added', { node: 'investigate', kind: 'agent', decider: 'supervisor', reason: 'failed gate', trigger: { failure_kind: 'gate' }, undo: { op: 'remove-node' } }),
      entry(10, 'edge-rerouted', { from: 'gate', outcome: 'fail', to: 'investigate', was: 'rework', decider: 'orchestrator', reason: 'new diagnosis' }),
      entry(1, 'node-enter', { node: 'author', visit: 1, graphId: 'implement-loop', graphVersion: '3', variantHash: 'variant-1' }),
      entry(12, 'unit-expanded', { node: 'implement', unit: 'unit-heal@2', childRunId: `${runId}/implement#2`, resolution: 1, decider: 'supervisor', reason: 'zoom in' }),
      entry(13, 'run-status', { runStatus: 'completed' }),
    ];
    const result = projectRunLedgerSteps(runId, fromJsonl(records));
    expect(result).toEqual({
      runId, graph: { graphId: 'implement-loop', version: '3', variantHash: 'variant-1' },
      steps: [
        { seq: 1, ts: timestamp, type: 'node-enter', node: 'author', visit: 1 },
        { seq: 2, ts: timestamp, type: 'node-exit', node: 'author', outcome: 'ok' },
        { seq: 3, ts: timestamp, type: 'edge-taken', from: 'author', to: 'plan', via: 'outcome' },
        { seq: 4, ts: timestamp, type: 'node-skipped', node: 'pool-admit', reason: 'condition', condition: 'substrate == pod' },
        { seq: 9, ts: timestamp, type: 'node-added', node: 'investigate', kind: 'agent', decider: 'supervisor', reason: 'failed gate', trigger: { failure_kind: 'gate' }, undo: { op: 'remove-node' } },
        { seq: 10, ts: timestamp, type: 'edge-rerouted', from: 'gate', outcome: 'fail', to: 'investigate', was: 'rework', decider: 'orchestrator', reason: 'new diagnosis' },
        { seq: 11, ts: timestamp, type: 'unit-collapsed', node: 'implement', resolution: 0, decider: 'supervisor', reason: 'done' },
        { seq: 12, ts: timestamp, type: 'unit-expanded', node: 'implement', unit: 'unit-heal@2', childRunId: `${runId}/implement#2`, resolution: 1, decider: 'supervisor', reason: 'zoom in' },
      ], complete: true, unreadable: 0, violations: [],
    });
  });

  test('requires both decider and reason for each structural change without dropping valid siblings', () => {
    for (const event of ['node-added', 'edge-rerouted', 'unit-expanded', 'unit-collapsed']) {
      const fields: Record<string, unknown> = event === 'node-added' ? { node: 'n', kind: 'agent' }
        : event === 'edge-rerouted' ? { from: 'a', outcome: 'fail', to: 'b', was: 'c' }
          : event === 'unit-expanded' ? { node: 'n', unit: 'u@1', childRunId: 'child', resolution: 1 }
            : { node: 'n', resolution: 0 };
      for (const missing of ['decider', 'reason']) {
        const data: Record<string, unknown> = { ...fields, decider: 'supervisor', reason: 'because' };
        delete data[missing];
        const result = projectRunLedgerSteps(runId, fromJsonl([
          entry(2, event, data), entry(1, 'node-enter', { node: 'a', visit: 1 }),
        ]));
        expect(result.steps).toEqual([{ seq: 1, ts: timestamp, type: 'node-enter', node: 'a', visit: 1 }]);
        expect(result.complete).toBe(false);
        expect(result.unreadable).toBe(1);
        expect(result.violations).toEqual([{ seq: 2, reason: 'structural change requires decider and reason' }]);
      }
    }
  });

  test('does not synthesize sequence numbers, silently overwrite duplicates, or count unrelated events', () => {
    const result = projectRunLedgerSteps(runId, fromJsonl([
      { timestamp, runId, event: 'node-enter', data: { node: 'unsequenced', visit: 1 } },
      entry(2, 'node-enter', { node: 'a', visit: 1 }),
      entry(2, 'node-exit', { node: 'a', outcome: 'ok' }),
      entry(3, 'node-skipped', { node: 'b', reason: 'profile' }),
      entry(4, 'run-status', { runStatus: 'completed' }),
    ]));
    expect(result.steps.map(({ seq, type }) => [seq, type])).toEqual([[2, 'node-enter'], [3, 'node-skipped']]);
    expect(result.violations).toEqual([
      { seq: null, reason: 'step requires positive safe-integer seq' },
      { seq: 2, reason: 'duplicate step seq' },
    ]);
    expect(result.complete).toBe(false);
    expect(result.unreadable).toBe(2);
  });

  test('accepts top-level JSONL seq but rejects disagreement with a data seq', () => {
    const result = projectRunLedgerSteps(runId, fromJsonl([
      { timestamp, runId, event: 'node-enter', seq: 3, data: { node: 'author', visit: 1 } } as RunLedgerEntry,
      { timestamp, runId, event: 'node-exit', seq: 4, data: { seq: 5, node: 'author', outcome: 'ok' } } as RunLedgerEntry,
    ]));
    expect(result.steps).toEqual([{ seq: 3, ts: timestamp, type: 'node-enter', node: 'author', visit: 1 }]);
    expect(result.violations).toEqual([{ seq: 4, reason: 'conflicting step seq' }]);
    expect(result.complete).toBe(false);
  });

  test('recognizes existing pipeline and graph journey ledger vocabulary only when the producer records seq', () => {
    const result = projectRunLedgerSteps(runId, fromJsonl([
      entry(1, 'pipeline-node-entry', { node: 'author', visit: 2 }),
      entry(2, 'graph-edge-taken', { from: 'author', taken: 'plan', to: 'other', source: 'code-default' }),
      entry(3, 'applied', { op: 'collapse', node: 'implement', resolution: 0, decider: 'supervisor', reason: 'budget' }),
    ]));
    expect(result.steps).toEqual([
      { seq: 1, ts: timestamp, type: 'node-enter', node: 'author', visit: 2 },
      { seq: 2, ts: timestamp, type: 'edge-taken', from: 'author', to: 'plan', via: 'fallback' },
      { seq: 3, ts: timestamp, type: 'unit-collapsed', node: 'implement', resolution: 0, decider: 'supervisor', reason: 'budget' },
    ]);
    expect(result.complete).toBe(true);
  });
});
