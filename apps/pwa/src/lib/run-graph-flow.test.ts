import { expect, test } from 'bun:test';
import { runGraphToFlow } from './run-graph-flow';
import type { RunGraphDetail } from '../nexus/client';

const graph: RunGraphDetail = {
  id: 'research-loop', source: 'core', editable: false,
  entry_node: 'investigate', terminal_nodes: ['merge'],
  nodes: [
    { node_id: 'investigate', kind: 'agent', recipe: 'headless-goal-loop', max_visits: 7 },
    { node_id: 'gate', kind: 'gate', recipe: 'gate-baseline', max_visits: 6 },
    { node_id: 'judge', kind: 'judge', recipe: 'pr-reviewer', max_visits: 4 },
    { node_id: 'merge', kind: 'git', recipe: 'seams-gh-merge-squash', max_visits: 2 },
  ],
  edges: [
    { from: 'investigate', on: 'changed-files', map: { 'code-changed': 'gate', 'documents-only': 'judge', unknown: 'gate' } },
    { from: 'judge', to: 'merge' },
  ],
};

test('splits each research outcome into a labelled edge and marks entry and terminal nodes', () => {
  const flow = runGraphToFlow(graph);
  expect(flow.edges.filter((edge) => edge.source === 'investigate')).toHaveLength(3);
  expect(flow.edges).toContainEqual(expect.objectContaining({ source: 'investigate', target: 'judge', label: 'documents-only' }));
  const parallel = flow.edges.filter((edge) => edge.source === 'investigate' && edge.target === 'gate');
  expect(parallel.map((edge) => edge.label)).toEqual(['code-changed', 'unknown']);
  expect(parallel.map((edge) => edge.sourceHandle)).toEqual(['out-0', 'out-2']);
  expect(parallel.map((edge) => edge.targetHandle)).toEqual(['in-0', 'in-1']);
  const source = flow.nodes.find((node) => node.id === 'investigate')!;
  const target = flow.nodes.find((node) => node.id === 'gate')!;
  for (const edge of parallel) {
    expect(source.data.outputHandles).toContain(edge.sourceHandle!);
    expect(target.data.inputHandles).toContain(edge.targetHandle!);
  }
  expect(flow.edges.find((edge) => edge.source === 'judge')).toMatchObject({ target: 'merge' });
  expect(flow.nodes.find((node) => node.id === 'investigate')?.data).toMatchObject({ entry: true, terminal: false, kind: 'agent', outcomes: ['code-changed', 'documents-only', 'unknown'] });
  expect(flow.nodes.find((node) => node.id === 'merge')?.data).toMatchObject({ entry: false, terminal: true });
  expect(flow.nodes.every((node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true);
});
