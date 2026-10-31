import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphTemplateSpec } from './graph-yaml.js';
import { appendRunLedgerEntries, appendRunLedgerEntry, loadRunLedger } from './run-ledger.js';
import { projectRunLedgerSteps } from './run-step-projection.js';
import { runtimeOverlayRunSteps } from './runtime-overlay-run-steps.js';

const runId = 'run-03096144-0000-4000-8000-000000000001';
const timestamp = '2026-10-29T06:20:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const node = (nodeId: string, kind = 'agent') => ({ nodeId, kind, recipe: `cmd:${nodeId}`, maxVisits: 1 });
const before: GraphTemplateSpec = {
  graphId: 'research-runtime', version: 1, entryNode: 'question', terminalNodes: ['terminal'],
  nodes: ['question', 'search', 'read', 'synthesise', 'review', 'terminal'].map((nodeId) => node(nodeId)),
  edges: [
    { from: 'question', to: 'search' }, { from: 'search', to: 'read' }, { from: 'read', to: 'synthesise' },
    { from: 'synthesise', to: 'review' }, { from: 'review', on: 'outcome', map: { pass: 'terminal', fail: 'terminal' } },
  ],
};
const after: GraphTemplateSpec = {
  ...before,
  nodes: [...before.nodes, node('source-audit', 'judge')],
  edges: [
    ...before.edges.slice(0, -1),
    { from: 'review', on: 'outcome', map: { pass: 'terminal', fail: 'source-audit' } },
    { from: 'source-audit', to: 'terminal' },
  ],
};

describe('runtimeOverlayRunSteps', () => {
  test('E4 fixed ledger replay records an atomic runtime-overlay structural batch in the lifecycle seq domain', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-overlay-run-steps-'));
    roots.push(root);
    const steps = runtimeOverlayRunSteps({
      runId, timestamp, before, after, overlayIds: ['research-runtime-empty-terminal'], round: 1,
    });
    expect(steps).toEqual([
      expect.objectContaining({ event: 'node-added', data: expect.objectContaining({ node: 'source-audit', kind: 'judge', decider: 'runtime-overlay' }) }),
      expect.objectContaining({ event: 'edge-rerouted', data: expect.objectContaining({ from: 'review', outcome: 'fail', was: 'terminal', to: 'source-audit' }) }),
      expect.objectContaining({ event: 'edge-rerouted', data: expect.objectContaining({ from: 'source-audit', outcome: '$default', was: '$absent', to: 'terminal' }) }),
    ]);

    appendRunLedgerEntry({ timestamp, runId, event: 'pipeline-node-entry', data: { node: 'question', visit: 1 } }, root);
    const unserializable = { ...steps[1]!, data: { ...steps[1]!.data, invalid: 1n } };
    expect(() => appendRunLedgerEntries([steps[0]!, unserializable], root)).toThrow();
    expect(loadRunLedger(runId, root)).toHaveLength(1);
    appendRunLedgerEntries(steps, root);
    const projection = projectRunLedgerSteps(runId, loadRunLedger(runId, root)!);

    expect(projection.complete).toBe(true);
    expect(projection.steps.map((step) => [step.seq, step.type])).toEqual([
      [1, 'node-enter'], [2, 'node-added'], [3, 'edge-rerouted'], [4, 'edge-rerouted'],
    ]);
    expect(projection.steps.filter((step) => step.type === 'node-added')).toHaveLength(1);
    expect(projection.steps.filter((step) => step.type === 'edge-rerouted')).toHaveLength(2);
  });

  test('does not create structural records when a selected runtime overlay leaves graph structure unchanged', () => {
    expect(runtimeOverlayRunSteps({ runId, timestamp, before, after: before, overlayIds: ['budget-only'], round: 2 })).toEqual([]);
  });
});
