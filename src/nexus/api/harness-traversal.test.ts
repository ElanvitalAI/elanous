import { describe, expect, test } from 'bun:test';
import { buildRunTraversal, handleHarnessRunTraversalGet } from './harness-traversal.js';
import type { RunLedgerEntry } from '../../self-implement/run-ledger.js';
import type { HarnessGraphEventWire } from '../../../apps/pwa/src/nexus/client.js';

const runId = 'run-demo-replay';
const at = '2026-10-29T00:00:00.000Z';
const row = (event: string, seq: number, data: Record<string, unknown>): RunLedgerEntry => ({
  timestamp: at, runId, event, seq, data,
});

describe('buildRunTraversal graph replay sequence', () => {
  test('exposes source sequence and structural graph events from the same fixed ledger', () => {
    const traversal = buildRunTraversal(runId, [
      row('start', 0, { feature: 'Research demo' }),
      row('pipeline-node-entry', 1, { node: 'investigate', round: 0, graphId: 'research-loop' }),
      row('node-added', 2, { node: 'source-check', kind: 'agent', decider: 'supervisor', reason: 'verify citation' }),
      row('pipeline-node-entry', 3, { node: 'source-check', round: 0, graphId: 'research-loop' }),
      row('edge-rerouted', 4, { from: 'source-check', outcome: 'pass', to: 'summarize', was: 'gate', decider: 'orchestrator', reason: 'evidence found' }),
    ]);

    expect(traversal.steps.map(({ node, sourceSeq }) => [node, sourceSeq])).toEqual([
      ['investigate', 1], ['source-check', 3],
    ]);
    expect(traversal.graphEvents?.map(({ seq, type }) => [seq, type])).toEqual([
      [2, 'node-added'], [4, 'edge-rerouted'],
    ]);
    const pwaContract: HarnessGraphEventWire[] = traversal.graphEvents ?? [];
    expect(pwaContract).toHaveLength(2);
  });

  test('preserves graph events and traversal sequence through the HTTP handler', async () => {
    const response = handleHarnessRunTraversalGet(new Request(`http://localhost/v1/harness/run-traversal?runId=${runId}`), {
      loadLedger: () => [
        row('pipeline-node-entry', 1, { node: 'investigate', round: 0, graphId: 'research-loop' }),
        row('node-added', 2, { node: 'source-check', kind: 'agent', decider: 'supervisor', reason: 'verify citation' }),
      ],
    });
    const wire = await response.json();
    expect(response.status).toBe(200);
    expect(wire.steps[0].sourceSeq).toBe(1);
    expect(wire.graphEvents).toEqual([expect.objectContaining({ seq: 2, type: 'node-added', node: 'source-check' })]);
  });
});
