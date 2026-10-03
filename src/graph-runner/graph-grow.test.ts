import { expect, test } from 'bun:test';
import { proposeGrowth } from './graph-grow.js';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';

const graph: GraphTemplateSpec = {
  graphId: 'grow-test', version: 1, entryNode: 'judge', terminalNodes: ['done'],
  nodes: [
    { nodeId: 'judge', kind: 'judge', recipe: 'cmd:judge', maxVisits: 2 },
    { nodeId: 'done', kind: 'gate', recipe: 'none', maxVisits: 1 },
  ],
  edges: [{ from: 'judge', on: 'outcome', map: { ok: 'done' } }],
};
const node = { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 1, contract: { inputs: [], tools: 'read-only', outputs: [] } };
const input = { graph, nodeId: 'judge', outcome: 'needs-research', runId: 'run-1' };

test('growth validates an invented outcome, new node and return edge without mutating the source', async () => {
  const result = await proposeGrowth(input, () => ({ node, returnTo: 'judge', reason: 'review requested research' }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.graph.nodes.at(-1)).toEqual(node);
  expect(result.graph.edges[0]?.map?.['needs-research']).toBe('research');
  expect(result.graph.edges.at(-1)).toEqual({ from: 'research', to: 'judge' });
  expect(result.growth.reason).toBe('review requested research');
  expect(result.growth.undo).toEqual({ removeNode: 'research', removeOutcome: { from: 'judge', outcome: 'needs-research' }, removeEdge: { from: 'research', to: 'judge' } });
  expect(graph.edges[0]?.map?.['needs-research']).toBeUndefined();
});

test('invalid proposals fall back with a reason, while external effects require a human', async () => {
  const duplicate = await proposeGrowth(input, () => ({ node: { ...node, nodeId: 'done' }, returnTo: 'judge', reason: 'duplicate' }));
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.reason).toContain('invalid-growth');
  const unknownReturn = await proposeGrowth(input, () => ({ node, returnTo: 'missing', reason: 'unknown' }));
  expect(unknownReturn.ok).toBe(false);
  const missingReturn = await proposeGrowth(input, () => ({ node, reason: 'no onward route' }));
  expect(missingReturn).toMatchObject({ ok: false, reason: expect.stringContaining('invalid-growth') });
  const effect = await proposeGrowth(input, () => ({ node: { ...node, recipe: 'cmd:git push' }, returnTo: 'done', reason: 'publish' }));
  expect(effect).toMatchObject({ ok: false, park: true, reason: expect.stringContaining('사람 확인 필요') });
  const upload = await proposeGrowth(input, () => ({ node: { ...node, recipe: 'cmd:upload', contract: { ...node.contract, tools: 'read-only' } }, returnTo: 'done', reason: 'upload' }));
  expect(upload).toMatchObject({ ok: false, park: true, reason: expect.stringContaining('사람 확인 필요') });
});
