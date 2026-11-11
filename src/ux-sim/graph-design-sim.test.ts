import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, type GraphRunState } from '../graph-runner/runner.js';
import {
  type AdaptiveGraphDiff,
  applyAdaptiveGraphDiff,
  buildGraphDesignPlaybackEnvelope,
  createAdaptiveGraphDesignState,
  getAdaptiveGraphPublishedYaml,
  previewAdaptiveGraphRoute,
  recordAdaptiveGraphRun,
} from './graph-design-sim.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// 출처: .rules/30-harness/testing-gates.md R-TST36; src/self-implement/graph-yaml.ts:217-219 requires max_visits >= 1.
const GRAPH_FIXTURE_MAX_VISITS = 1;
// 출처: .rules/30-harness/testing-gates.md R-TST36; src/ux-sim/graph-design-sim.ts supersedes current outputs in invalidated nodes.
const SUPERSEDED_OUTPUT_LOWER_BOUND = 0;

// Keep scenario-specific flow in declared graph YAML rather than encoding it in the simulator.
const GRAPH_V1_YAML = readFileSync(new URL('../../catalog/ux-sim/fixtures/adaptive-graph-v1.yaml', import.meta.url), 'utf8');
const GRAPH_WITH_FALLBACK_YAML = GRAPH_V1_YAML.replace(
  'map: { ok: rate-scan, fail: done } }',
  'map: { ok: rate-scan, fail: done }, fallback: [{ node: audit, requires: [local-extractor] }] }',
);

function graphSnapshotSha(state: ReturnType<typeof createAdaptiveGraphDesignState>, revision: number): string {
  return createHash('sha256').update(getAdaptiveGraphPublishedYaml(state, revision)).digest('hex');
}

function writeGraph(root: string, revision: number, yaml: string): string {
  const path = join(root, `graph-r${revision}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

async function executeDeclaredGraph(root: string, state: ReturnType<typeof createAdaptiveGraphDesignState>, revision: number,
  runId: string, views: readonly string[]): Promise<GraphRunState> {
  const graph = state.graph;
  const path = writeGraph(root, revision, getAdaptiveGraphPublishedYaml(state, revision));
  const commands: string[] = [];
  return runGraph(path, { runId, input: { expertViews: views }, deps: { root,
    runBash: async (command) => {
      commands.push(command);
      return { stdout: JSON.stringify({ outcome: 'ok', command }), stderr: '', exitCode: 0 };
    },
  } }).then((run) => {
    expect(commands.sort()).toEqual(run.path.flatMap((nodeId) => graph.nodes.filter((node) => node.nodeId === nodeId && node.kind !== 'gate'))
      .map((node) => `simulate ${node.recipe.replace(/^cmd:/, '')}`).sort());
    return run;
  });
}

test('adaptive graph design applies one atomic revision, runs both declared graphs, and supersedes affected evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-design-sim-'));
  roots.push(root);
  writeFileSync(join(root, 'recipes.yaml'), [
    'diagnose:', '  command: "simulate diagnose"',
    'rate-scan:', '  command: "simulate rate-scan"',
    'counter-evidence:', '  command: "simulate counter-evidence"',
    'forecast:', '  command: "simulate forecast"',
    'forecast-with-counter-evidence:', '  command: "simulate forecast-with-counter-evidence"',
    'recommendation:', '  command: "simulate recommendation"',
    'audit:', '  command: "simulate audit"',
  ].join('\n') + '\n');

  const initialViews = [
    'Expert A: rate cuts support growth assets next year.',
    'Expert B: persistent inflation may delay rate cuts.',
  ];
  let state = createAdaptiveGraphDesignState(GRAPH_V1_YAML, 'expert-view-series-1');
  const firstRun = await executeDeclaredGraph(root, state, 1, 'expert-view-series-1-r1', initialViews);
  expect(firstRun.status).toBe('done');
  expect(firstRun.path).toEqual(['diagnose', 'rate-scan', 'forecast', 'recommendation', 'done']);
  state = recordAdaptiveGraphRun(state, firstRun);

  const diff = {
    revision: 2,
    eventId: 'expert-view-b-received',
    reason: 'The second expert supplied counter-evidence that changes the rate-cut premise.',
    operations: [
      { op: 'remove' as const, nodeId: 'rate-scan' },
      { op: 'add' as const,
        node: { nodeId: 'counter-evidence', kind: 'agent', recipe: 'cmd:counter-evidence', maxVisits: GRAPH_FIXTURE_MAX_VISITS },
        edges: [
          { from: 'counter-evidence', on: 'outcome', map: { ok: 'forecast', fail: 'done' } },
        ],
      },
      { op: 'replace' as const,
        node: { ...state.graph.nodes.find((node) => node.nodeId === 'diagnose')! },
        edges: [{ from: 'diagnose', on: 'outcome', map: { ok: 'counter-evidence', fail: 'done' } }],
      },
      { op: 'replace' as const,
        node: { nodeId: 'forecast', kind: 'agent', recipe: 'cmd:forecast-with-counter-evidence', maxVisits: GRAPH_FIXTURE_MAX_VISITS },
      },
    ],
  };
  const applied = applyAdaptiveGraphDiff(state, diff);
  expect(applied.replayed).toBe(false);
  expect(applied.state.revision).toBe(2);
  expect(applied.publishedYaml).toContain('version: 2');
  expect(getAdaptiveGraphPublishedYaml(state, 1)).toContain('version: 1');
  expect(getAdaptiveGraphPublishedYaml(applied.state, 2)).toBe(applied.publishedYaml);
  expect(applied.state.graph.nodes.map((node) => node.nodeId)).toContain('counter-evidence');
  expect(applied.state.graph.nodes.map((node) => node.nodeId)).not.toContain('rate-scan');
  expect(applied.invalidatedNodeIds).toEqual(['counter-evidence', 'diagnose', 'done', 'forecast', 'rate-scan', 'recommendation']);
  expect(applied.supersededOutputCount).toBeGreaterThan(SUPERSEDED_OUTPUT_LOWER_BOUND);
  expect(previewAdaptiveGraphRoute(applied.state, 'counter-evidence', 'success')).toBe('forecast');

  const duplicate = applyAdaptiveGraphDiff(applied.state, diff);
  expect(duplicate.replayed).toBe(true);
  expect(duplicate.state).toBe(applied.state);
  expect(duplicate.state.revision).toBe(2);

  const updatedViews = [...initialViews, 'Expert C: credit stress weakens the growth outlook despite a delayed cut.'];
  const secondRun = await executeDeclaredGraph(root, applied.state, 2, 'expert-view-series-1-r2', updatedViews);
  expect(secondRun.status).toBe('done');
  expect(secondRun.path).toEqual(['diagnose', 'counter-evidence', 'forecast', 'recommendation', 'done']);
  const finalState = recordAdaptiveGraphRun(applied.state, secondRun);
  expect(finalState.outputs.filter((output) => output.status === 'superseded').map((output) => output.nodeId).sort())
    .toEqual(['diagnose', 'forecast', 'rate-scan', 'recommendation']);
  expect(finalState.outputs.filter((output) => output.status === 'current' && output.revision === 2).map((output) => output.nodeId).sort())
    .toEqual(['counter-evidence', 'diagnose', 'forecast', 'recommendation']);

  const playback = buildGraphDesignPlaybackEnvelope(finalState, {
    conclusions: { 1: 'Rate cuts support a growth tilt, subject to inflation risk.', 2: 'Credit stress weakens the growth outlook despite delayed cuts.' },
    bloomQuestions: { 1: ['What evidence could falsify the rate-cut premise?'], 2: ['Which indicator would distinguish credit stress from delayed easing?'] },
  });
  expect(playback.runId).toBe('expert-view-series-1');
  expect(playback.frames).toHaveLength(2);
  expect(playback.frames[0]).toMatchObject({ revision: 1, diff: [], conclusion: expect.any(String), bloomQuestions: [expect.any(String)] });
  expect(playback.frames[0]!.nodes.find((node) => node.nodeId === 'rate-scan')?.status).toBe('superseded');
  expect(playback.frames[1]).toMatchObject({
    revision: 2,
    conclusion: expect.any(String),
    bloomQuestions: [expect.any(String)],
    diff: [
      { op: 'remove', nodeId: 'rate-scan', from: 'diagnose', to: 'forecast', why: diff.reason },
      { op: 'add', nodeId: 'counter-evidence', to: 'forecast', why: diff.reason },
      { op: 'replace', nodeId: 'diagnose', to: 'counter-evidence', why: diff.reason },
      { op: 'replace', nodeId: 'forecast', from: 'counter-evidence', to: 'recommendation', why: diff.reason },
    ],
  });
  expect(playback.frames[1]!.nodes.find((node) => node.nodeId === 'counter-evidence')?.status).toBe('current');
});

test('adaptive graph diff rejects gaps and dangling references without mutating the source graph', () => {
  const state = createAdaptiveGraphDesignState(GRAPH_V1_YAML, 'invalid-diff-series');
  const bad = { revision: 3, eventId: 'skip-revision', reason: 'revision gap', operations: [{ op: 'remove' as const, nodeId: 'rate-scan' }] };
  expect(() => applyAdaptiveGraphDiff(state, bad)).toThrow('adaptive graph revision must be 2');
  expect(state.revision).toBe(1);
  expect(state.graph.nodes.map((node) => node.nodeId)).toContain('rate-scan');

  const dangling = { ...bad, revision: 2, eventId: 'dangling-target', operations: [{
    op: 'add' as const,
    node: { nodeId: 'counter-evidence', kind: 'agent', recipe: 'cmd:counter-evidence', maxVisits: GRAPH_FIXTURE_MAX_VISITS },
    edges: [{ from: 'counter-evidence', to: 'missing-node' }],
  }] };
  expect(() => applyAdaptiveGraphDiff(state, dangling)).toThrow('adaptive graph edge target missing: missing-node');
  expect(state.revision).toBe(1);
  expect(state.graph.nodes.map((node) => node.nodeId)).not.toContain('counter-evidence');
});

test('new edges invalidate existing downstream outputs in the before and after graph closures', () => {
  const state = createAdaptiveGraphDesignState(GRAPH_V1_YAML, 'edge-invalidation-series');
  const auditRun: GraphRunState = { graphId: state.graphId, runId: 'audit-prior-run', status: 'done', path: ['audit'],
    graphSnapshot: { graphSha: graphSnapshotSha(state, 1), recipesSha: 'fixture-recipes' },
    nodes: [{ nodeId: 'audit', ok: true, exit: 0, executed: true, output: { reviewed: true } }],
    executed: 1, dryRun: false, statePath: 'memory://audit-prior-run' };
  const withPriorAudit = recordAdaptiveGraphRun(state, auditRun);
  const updated = applyAdaptiveGraphDiff(withPriorAudit, {
    revision: 2, eventId: 'diagnosis-adds-audit', reason: 'Diagnosis now requires the existing audit result.',
    operations: [{ op: 'replace', node: { ...state.graph.nodes.find((node) => node.nodeId === 'diagnose')! }, edges: [
      { from: 'diagnose', on: 'outcome', map: { ok: 'rate-scan', fail: 'done', audit: 'audit' } },
    ] }],
  });
  expect(updated.invalidatedNodeIds).toContain('audit');
  expect(updated.state.outputs.find((output) => output.nodeId === 'audit')).toMatchObject({ status: 'superseded', supersededBy: 2 });
});

test('removing a node preserves unrelated outcomes in a multi-outcome edge', () => {
  const state = createAdaptiveGraphDesignState(GRAPH_V1_YAML, 'branch-preservation-series');
  const updated = applyAdaptiveGraphDiff(state, {
    revision: 2, eventId: 'remove-rate-scan', reason: 'Remove the obsolete scan branch.',
    operations: [{ op: 'remove', nodeId: 'rate-scan' }],
  });
  expect(updated.state.graph.edges.find((edge) => edge.from === 'diagnose')?.map).toEqual({ fail: 'done' });
  expect(updated.state.graph.nodes.map((node) => node.nodeId)).not.toContain('rate-scan');
});

test('fallback links participate in invalidation and are removed without stale upstream evidence', () => {
  const makeFallbackRun = (graphId: string, graphSha: string): GraphRunState => ({
    graphId, runId: 'fallback-prior-run', status: 'done', path: ['diagnose', 'audit'],
    graphSnapshot: { graphSha, recipesSha: 'fixture-recipes' },
    nodes: [
      { nodeId: 'diagnose', ok: true, exit: 0, executed: true, output: { outcome: 'fallback' } },
      { nodeId: 'audit', ok: true, exit: 0, executed: true, output: { reviewed: true } },
    ],
    executed: 2, dryRun: false, statePath: 'memory://fallback-prior-run',
  });
  const state = createAdaptiveGraphDesignState(GRAPH_WITH_FALLBACK_YAML, 'fallback-invalidation-series');
  const withOutputs = recordAdaptiveGraphRun(state, makeFallbackRun(state.graphId, graphSnapshotSha(state, 1)));
  const changed = applyAdaptiveGraphDiff(withOutputs, {
    revision: 2, eventId: 'change-fallback-source', reason: 'The fallback source behavior changed.',
    operations: [{ op: 'replace', node: { ...state.graph.nodes.find((node) => node.nodeId === 'diagnose')!, recipe: 'cmd:diagnose-v2' } }],
  });
  expect(changed.invalidatedNodeIds).toContain('audit');
  expect(changed.state.outputs.find((output) => output.nodeId === 'audit')).toMatchObject({ status: 'superseded', supersededBy: 2 });

  const removalState = createAdaptiveGraphDesignState(GRAPH_WITH_FALLBACK_YAML, 'fallback-removal-series');
  const removalOutputs = recordAdaptiveGraphRun(removalState, makeFallbackRun(removalState.graphId, graphSnapshotSha(removalState, 1)));
  const removed = applyAdaptiveGraphDiff(removalOutputs, {
    revision: 2, eventId: 'remove-fallback-target', reason: 'Retire the fallback target.',
    operations: [{ op: 'remove', nodeId: 'audit' }],
  });
  expect(removed.invalidatedNodeIds).toContain('diagnose');
  expect(removed.state.graph.edges.find((edge) => edge.from === 'diagnose')?.fallback).toBeUndefined();
  expect(removed.state.outputs.find((output) => output.nodeId === 'diagnose')).toMatchObject({ status: 'superseded', supersededBy: 2 });
});

test('removing the last primary route fails closed when a fallback would be left alone', () => {
  const source = GRAPH_WITH_FALLBACK_YAML.replace('map: { ok: rate-scan, fail: done }', 'map: { ok: rate-scan }');
  const state = createAdaptiveGraphDesignState(source, 'fallback-only-route-series');
  expect(() => applyAdaptiveGraphDiff(state, {
    revision: 2, eventId: 'remove-primary-route', reason: 'The only primary target is retired.',
    operations: [{ op: 'remove', nodeId: 'rate-scan' }],
  })).toThrow('adaptive graph YAML validation failed');
  expect(state.revision).toBe(1);
  expect(state.graph.nodes.map((node) => node.nodeId)).toContain('rate-scan');
});

test('an atomic diff can replace a route after temporarily leaving only its fallback', () => {
  const source = GRAPH_WITH_FALLBACK_YAML.replace('map: { ok: rate-scan, fail: done }', 'map: { ok: rate-scan }');
  const state = createAdaptiveGraphDesignState(source, 'atomic-fallback-route-series');
  const updated = applyAdaptiveGraphDiff(state, {
    revision: 2, eventId: 'replace-primary-after-remove', reason: 'Replace the primary route while retaining the fallback.',
    operations: [
      { op: 'remove', nodeId: 'rate-scan' },
      { op: 'replace', node: { ...state.graph.nodes.find((node) => node.nodeId === 'diagnose')! },
        edges: [{ from: 'diagnose', on: 'outcome', map: { ok: 'recommendation' },
          fallback: [{ node: 'audit', requires: ['local-extractor'] }] }] },
    ],
  });
  expect(updated.state.revision).toBe(2);
  expect(updated.state.graph.edges.find((edge) => edge.from === 'diagnose')).toMatchObject({
    map: { ok: 'recommendation' }, fallback: [{ node: 'audit', requires: ['local-extractor'] }],
  });
});

test('an atomic diff can replace a direct edge to a removed node while preserving fallback', () => {
  const source = GRAPH_V1_YAML.replace(
    'from: recommendation, on: outcome, map: { ok: done, fail: done }',
    'from: recommendation, to: rate-scan, fallback: [{ node: audit, requires: [local-extractor] }]',
  );
  const state = createAdaptiveGraphDesignState(source, 'direct-edge-replacement-series');
  const updated = applyAdaptiveGraphDiff(state, {
    revision: 2, eventId: 'replace-direct-edge', reason: 'Replace the direct edge to the retired node.',
    operations: [
      { op: 'remove', nodeId: 'rate-scan' },
      { op: 'replace', node: { ...state.graph.nodes.find((node) => node.nodeId === 'recommendation')! },
        edges: [{ from: 'recommendation', to: 'done', fallback: [{ node: 'audit', requires: ['local-extractor'] }] }] },
    ],
  });
  expect(updated.state.graph.edges.find((edge) => edge.from === 'recommendation')).toMatchObject({
    to: 'done', fallback: [{ node: 'audit', requires: ['local-extractor'] }],
  });
  expect(updated.state.graph.nodes.map((node) => node.nodeId)).not.toContain('rate-scan');
});

test('late receipts from an invalidated revision remain superseded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-design-late-receipt-'));
  roots.push(root);
  writeFileSync(join(root, 'recipes.yaml'), [
    'diagnose:', '  command: "simulate diagnose"', 'rate-scan:', '  command: "simulate rate-scan"',
    'forecast:', '  command: "simulate forecast"', 'recommendation:', '  command: "simulate recommendation"',
    'audit:', '  command: "simulate audit"',
  ].join('\n') + '\n');
  const state = createAdaptiveGraphDesignState(GRAPH_V1_YAML, 'late-receipt-series');
  const run = await executeDeclaredGraph(root, state, 1, 'late-receipt-r1', ['Synthetic view one.']);
  const revised = applyAdaptiveGraphDiff(recordAdaptiveGraphRun(state, run), {
    revision: 2, eventId: 'replace-forecast', reason: 'New evidence changes the forecast recipe.',
    operations: [{ op: 'replace', node: { ...state.graph.nodes.find((node) => node.nodeId === 'forecast')!, recipe: 'cmd:forecast-with-counter-evidence' } }],
  });
  const withLateReceipt = recordAdaptiveGraphRun(revised.state, run);
  expect(withLateReceipt.outputs.filter((output) => output.runId === run.runId && output.revision === 1
    && ['forecast', 'recommendation'].includes(output.nodeId))
    .every((output) => output.status === 'superseded' && output.supersededBy === 2)).toBe(true);
});

test('recording a run requires an exact published graph snapshot', () => {
  const state = createAdaptiveGraphDesignState(GRAPH_V1_YAML, 'snapshot-binding-series');
  const run: GraphRunState = { graphId: state.graphId, runId: 'unbound-run', status: 'done', path: ['diagnose'],
    graphSnapshot: { graphSha: '0'.repeat(64), recipesSha: 'fixture-recipes' },
    nodes: [{ nodeId: 'diagnose', ok: true, exit: 0, executed: true, output: 'stale' }],
    executed: 1, dryRun: false, statePath: 'memory://unbound-run' };

  expect(() => recordAdaptiveGraphRun(state, run)).toThrow('run graph snapshot does not match a published revision');
  const missingSnapshot = { ...run, graphSnapshot: undefined };
  expect(() => recordAdaptiveGraphRun(state, missingSnapshot)).toThrow('cannot record run without a graph snapshot');
});

test('replaying an older event returns its own published YAML after later revisions', () => {
  const state = createAdaptiveGraphDesignState(GRAPH_V1_YAML, 'old-event-replay-series');
  const revisionTwoDiff: AdaptiveGraphDiff = {
    revision: 2, eventId: 'add-counter-evidence', reason: 'Add the counter-evidence check.',
    operations: [{ op: 'add' as const, node: { nodeId: 'counter-evidence', kind: 'agent', recipe: 'cmd:counter-evidence', maxVisits: GRAPH_FIXTURE_MAX_VISITS },
      edges: [{ from: 'diagnose', on: 'outcome', map: { evidence: 'counter-evidence' } },
        { from: 'counter-evidence', on: 'outcome', map: { ok: 'forecast', fail: 'done' } }] }],
  };
  const revisionTwo = applyAdaptiveGraphDiff(state, revisionTwoDiff);
  const revisionThree = applyAdaptiveGraphDiff(revisionTwo.state, {
    revision: 3, eventId: 'replace-forecast', reason: 'Update the forecast recipe.',
    operations: [{ op: 'replace', node: { ...revisionTwo.state.graph.nodes.find((node) => node.nodeId === 'forecast')!, recipe: 'cmd:forecast-v3' } }],
  });
  const replayed = applyAdaptiveGraphDiff(revisionThree.state, revisionTwoDiff);
  expect(replayed.replayed).toBe(true);
  expect(replayed.publishedYaml).toContain('version: 2');
  expect(replayed.publishedYaml).not.toContain('forecast-v3');
});
