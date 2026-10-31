import { expect, test } from 'bun:test';
import { applyRunGraphEvents, runGraphAdaptiveEvidence, runGraphToFlow } from './run-graph-flow';
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

test('merges outcomes that share a target into one labelled edge and marks entry and terminal nodes', () => {
  const flow = runGraphToFlow(graph);
  expect(flow.edges.filter((edge) => edge.source === 'investigate')).toHaveLength(2);
  expect(flow.edges).toContainEqual(expect.objectContaining({ source: 'investigate', target: 'judge', label: 'documents-only', type: 'tidy' }));
  const parallel = flow.edges.filter((edge) => edge.source === 'investigate' && edge.target === 'gate');
  expect(parallel.map((edge) => edge.label)).toEqual(['code-changed · unknown']);
  expect(flow.edges.find((edge) => edge.source === 'judge')).toMatchObject({ target: 'merge' });
  expect(flow.nodes.find((node) => node.id === 'investigate')?.data).toMatchObject({ entry: true, terminal: false, kind: 'agent', outcomes: ['code-changed', 'documents-only', 'unknown'] });
  expect(flow.nodes.find((node) => node.id === 'merge')?.data).toMatchObject({ entry: false, terminal: true });
  expect(flow.nodes.every((node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true);
});

test('replays traversal graphEvents by adding a runtime node and replacing its adaptive route', () => {
  const replayed = applyRunGraphEvents(graph, [
    { seq: 3, ts: '2026-10-29T00:00:00.000Z', type: 'node-added', node: 'source-audit', kind: 'judge', decider: 'runtime-overlay', reason: 'source evidence missing' },
    { seq: 4, ts: '2026-10-29T00:00:01.000Z', type: 'edge-rerouted', from: 'judge', outcome: '$default', was: 'merge', to: 'source-audit', decider: 'runtime-overlay', reason: 'source evidence missing' },
    { seq: 5, ts: '2026-10-29T00:00:02.000Z', type: 'edge-rerouted', from: 'source-audit', outcome: '$default', was: '$absent', to: 'merge', decider: 'runtime-overlay', reason: 'source evidence missing' },
  ]);
  const flow = runGraphToFlow(replayed);
  expect(flow.nodes.find((node) => node.id === 'source-audit')?.data).toMatchObject({ kind: 'judge', recipe: 'runtime:runtime-overlay' });
  expect(flow.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'judge', target: 'source-audit' }),
    expect.objectContaining({ source: 'source-audit', target: 'merge' }),
  ]));
});

test('DEMO1104-ARG-ADAPTIVE-VIEW: three scene evidence stays ordered and records add, depth, repair, and hand work', () => {
  const evidence = runGraphAdaptiveEvidence([
    { seq: 6, ts: '2026-10-29T00:00:05.000Z', type: 'edge-rerouted', from: 'failed-search', outcome: '$default', was: 'failed', to: 'fallback-search', decider: 'runtime-overlay', reason: 'search failed; use alternate route' },
    { seq: 2, ts: '2026-10-29T00:00:01.000Z', type: 'node-added', node: 'search-1', kind: 'search', decider: 'runtime-overlay', reason: 'source gap' },
    { seq: 4, ts: '2026-10-29T00:00:03.000Z', type: 'unit-expanded', node: 'research', unit: 'source-check', childRunId: 'child-1', resolution: 3, decider: 'runtime-overlay', reason: 'deepen evidence' },
    { seq: 1, ts: '2026-10-29T00:00:00.000Z', type: 'node-added', node: 'failed-search', kind: 'search', decider: 'runtime-overlay', reason: 'find sources' },
    { seq: 3, ts: '2026-10-29T00:00:02.000Z', type: 'node-added', node: 'search-2', kind: 'search', decider: 'runtime-overlay', reason: 'expand sources' },
    { seq: 5, ts: '2026-10-29T00:00:04.000Z', type: 'node-added', node: 'codex-hand', kind: 'hand', decider: 'runtime-overlay', reason: 'agent mission hand', who: 'codex', what: 'compare evidence', missionId: 'mission-1' },
    { seq: 7, ts: '2026-10-29T00:00:06.000Z', type: 'node-added', node: 'fallback-search', kind: 'search', decider: 'runtime-overlay', reason: 'alternate source path' },
    { seq: 8, ts: '2026-10-29T00:00:07.000Z', type: 'unit-collapsed', node: 'research', resolution: 2, decider: 'runtime-overlay', reason: 'return to summary' },
  ]);
  expect(evidence.orderedEvents.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(evidence.addedNodes.filter((event) => event.kind === 'search')).toHaveLength(4);
  expect(evidence.depthChanges.filter((event) => event.type === 'unit-expanded')).toHaveLength(1);
  expect(evidence.orderedEvents.find((event) => event.type === 'unit-collapsed')).toMatchObject({ node: 'research', resolution: 2 });
  expect(evidence.repairs).toMatchObject([{ from: 'failed-search', was: 'failed', to: 'fallback-search' }]);
  expect(evidence.handNodes).toMatchObject([{ who: 'codex', what: 'compare evidence', missionId: 'mission-1' }]);
});

test('ARG evidence counts only recorded node, resolution, repair, and hand events in sequence order', () => {
  const evidence = runGraphAdaptiveEvidence([
    { seq: 4, ts: '2026-10-29T00:00:03.000Z', type: 'edge-rerouted', from: 'lookup', outcome: '$default', was: 'done', to: 'fallback', decider: 'runtime-overlay', reason: 'source unavailable' },
    { seq: 2, ts: '2026-10-29T00:00:01.000Z', type: 'unit-expanded', node: 'research', unit: 'source-check', childRunId: 'child-1', resolution: 3, decider: 'runtime-overlay', reason: 'evidence gap' },
    { seq: 1, ts: '2026-10-29T00:00:00.000Z', type: 'node-added', node: 'lookup', kind: 'search', decider: 'runtime-overlay', reason: 'missing source' },
    { seq: 3, ts: '2026-10-29T00:00:02.000Z', type: 'node-added', node: 'codex-hand', kind: 'hand', decider: 'runtime-overlay', reason: 'agent mission hand', who: 'codex', what: 'compare research angle', missionId: 'mission-research' },
  ]);
  expect(evidence.addedNodes.map((event) => event.seq)).toEqual([1, 3]);
  expect(evidence.depthChanges.map((event) => [event.type, event.resolution])).toEqual([['unit-expanded', 3]]);
  expect(evidence.repairs.map((event) => [event.from, event.to])).toEqual([['lookup', 'fallback']]);
  expect(evidence.handNodes.map((event) => [event.who, event.what, event.missionId])).toEqual([['codex', 'compare research angle', 'mission-research']]);
  expect(runGraphAdaptiveEvidence()).toEqual({ orderedEvents: [], addedNodes: [], depthChanges: [], repairs: [], handNodes: [] });
});
