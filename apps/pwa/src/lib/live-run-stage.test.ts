import { expect, test } from 'bun:test';
import type { HarnessRunTraversal, RunGraphDetail } from '@/nexus/client';
import { failureRepairEvidence, liveRunStageMetrics, mcpEdgeDirection, nodeBirthsBetweenSteps, stageNodeResourceBadges, unorderableGraphEventCount, visibleRunAtCursor } from './live-run-stage';

const run = {
  steps: [
    { node: 'research', round: 1, outcome: 'fail', at: '2026-11-03T00:00:00Z', durationMs: 10, visit: 1, maxVisits: 2, detail: null, sourceSeq: 1 },
    { node: 'research', round: 1, outcome: 'pass', at: '2026-11-03T00:00:01Z', durationMs: 20, visit: 2, maxVisits: 2, detail: null, sourceSeq: 5, resources: { host: 'gcp2', models: ['gpt-6-sol'] } },
    { node: 'aside_exec', round: 1, outcome: 'pass', at: '2026-11-03T00:00:02Z', durationMs: 30, visit: 1, maxVisits: 1, detail: null, sourceSeq: 6, resources: { pod: 'research-1', plugins: ['browser'] } },
  ],
  graphEvents: [
    { seq: 1, ts: '2026-11-03T00:00:00Z', type: 'node-added', node: 'repair', kind: 'agent', decider: 'runtime', reason: 'recovery' },
    { seq: 3, ts: '2026-11-03T00:00:01Z', type: 'edge-rerouted', from: 'research', outcome: 'fail', to: 'repair', was: 'finish', decider: 'runtime', reason: 'recover' },
    { seq: 7, ts: '2026-11-03T00:00:03Z', type: 'edge-rerouted', from: 'aside_exec', outcome: 'pass', to: 'end', was: 'finish', decider: 'runtime', reason: 'other' },
  ],
} as unknown as Pick<HarnessRunTraversal, 'steps' | 'graphEvents'>;

const graph = {
  nodes: [{ node_id: 'research' }, { node_id: 'aside_exec' }, { node_id: 'repair' }],
  edges: [{ from: 'research', to: 'repair' }, { from: 'aside', to: 'elanous_task_submit' }, { from: 'elanous', to: 'aside_exec' }],
} as unknown as Pick<RunGraphDetail, 'nodes' | 'edges'>;

test('stage counts are sourced from traversal and structural graph events', () => {
  expect(liveRunStageMetrics(run, graph)).toEqual({ nodes: 3, edges: 3, visits: 3, failures: 1, repairs: 2, mcpEdges: 2, births: 1 });
  expect(failureRepairEvidence(run)).toMatchObject({ failure: { node: 'research', outcome: 'fail' }, repair: { from: 'research', to: 'repair', outcome: 'fail' } });
  expect(failureRepairEvidence({ steps: [run.steps[0]!], graphEvents: [run.graphEvents![2]!] } as unknown as Pick<HarnessRunTraversal, 'steps' | 'graphEvents'>)).toBeNull();
});

test('aside and Elanous MCP tools receive directional accent; unrelated edges do not', () => {
  expect(mcpEdgeDirection('aside', 'elanous_task_submit')).toBe('to-elanous');
  expect(mcpEdgeDirection('research', 'skill_exec')).toBeNull();
  expect(mcpEdgeDirection('elanous', 'aside_exec')).toBe('to-aside');
  expect(mcpEdgeDirection('aside_exec', 'elanous')).toBe('to-elanous');
  expect(mcpEdgeDirection('elanous_task_submit', 'aside')).toBe('to-aside');
  expect(mcpEdgeDirection('research', 'review')).toBeNull();
});

test('stage replay only exposes records at or before its cursor', () => {
  const first = visibleRunAtCursor(run, 0, false);
  expect(first.steps).toHaveLength(1);
  expect(first.graphEvents.map((event) => event.seq)).toEqual([1]);
  const second = visibleRunAtCursor(run, 1, false);
  expect(second.steps).toHaveLength(2);
  expect(second.graphEvents.map((event) => event.seq)).toEqual([1, 3]);
  expect(visibleRunAtCursor(run, -1, false)).toEqual({ steps: [], graphEvents: [] });
  expect(visibleRunAtCursor(run, 0, true).graphEvents).toHaveLength(3);
});

test('legacy timestamp-only traversal associates failures and node births in the same time order', () => {
  const steps = [
    { node: 'research', outcome: 'pass', at: '2026-11-03T00:00:01Z' },
    { node: 'research', outcome: 'fail', at: '2026-11-03T00:00:05Z' },
    { node: 'repair', outcome: 'pass', at: '2026-11-03T00:00:09Z' },
  ];
  const events = [
    { seq: 2, ts: '2026-11-03T00:00:07Z', type: 'node-added' as const, node: 'repair', kind: 'agent', decider: 'runtime', reason: 'repair' },
    { seq: 4, ts: '2026-11-03T00:00:06Z', type: 'edge-rerouted' as const, from: 'research', outcome: 'fail', to: 'repair', was: 'finish', decider: 'runtime', reason: 'repair' },
  ];
  const first = visibleRunAtCursor({ steps, graphEvents: events }, 0, false);
  expect(first.graphEvents).toEqual([]);
  const complete = visibleRunAtCursor({ steps, graphEvents: events }, 2, false);
  expect(nodeBirthsBetweenSteps(complete.graphEvents, steps[1], steps[2], true)).toEqual(['repair']);
  expect(failureRepairEvidence(complete as unknown as Pick<HarnessRunTraversal, 'steps' | 'graphEvents'>)).toMatchObject({ failure: { node: 'research', at: steps[1]!.at }, repair: { to: 'repair' } });
  expect(unorderableGraphEventCount(complete as unknown as Pick<HarnessRunTraversal, 'steps' | 'graphEvents'>, 2, false)).toBe(0);
  const tied = { steps: [steps[0]], graphEvents: [{ ...events[0]!, ts: steps[0]!.at }] } as unknown as Pick<HarnessRunTraversal, 'steps' | 'graphEvents'>;
  expect(unorderableGraphEventCount(tied, 0, false)).toBe(1);
  expect(unorderableGraphEventCount({ ...tied, graphEvents: [{ ...events[0]!, ts: 'invalid-date' }] }, 0, false)).toBe(1);
  expect(nodeBirthsBetweenSteps(tied.graphEvents ?? [], undefined, tied.steps[0], false)).toEqual([]);
});

test('edge counter matches rendered outcome and fallback paths', () => {
  const multiPath = { nodes: [{ node_id: 'aside' }, { node_id: 'elanous' }, { node_id: 'other' }], edges: [
    { from: 'aside', to: 'not-rendered', map: { pass: 'elanous', fail: 'other' }, fallback: [{ node: 'other' }] },
  ] } as unknown as Pick<RunGraphDetail, 'nodes' | 'edges'>;
  expect(liveRunStageMetrics({ steps: [], graphEvents: [] }, multiPath)).toMatchObject({ nodes: 3, edges: 2, mcpEdges: 1 });
});

test('resource badges retain explicit observations and mark absent host/model as unmeasured', () => {
  const badges = stageNodeResourceBadges(run.steps, (node) => node, 'pod');
  expect(badges.get('research')).toEqual(['호스트 gcp2', '모델 gpt-6-sol', '실행 pod']);
  expect(badges.get('aside_exec')).toEqual(['호스트 미계측', 'Pod research-1', '모델 미계측', '플러그인 browser']);
});

test('resource badges do not carry values from an earlier visit of the same node', () => {
  const visits = [
    { node: 'research', resources: { host: 'gcp2', models: ['gpt-6-sol'], plugins: ['browser'] } },
    { node: 'research', resources: { pod: 'worker-9' } },
  ];
  const badges = stageNodeResourceBadges(visits, (node) => node);
  expect(badges.get('research')).toEqual(['호스트 미계측', 'Pod worker-9', '모델 미계측']);
});
