import { expect, test } from 'bun:test';
import type { GraphGrowth } from '../graph-runner/graph-grow.js';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { renderGraphEngineSim, simGraphEngineSelection } from './graph-engine-sim.js';

const graph: GraphTemplateSpec = {
  graphId: 'self-implement', version: 1, entryNode: 'component', terminalNodes: ['done', 'needs-human', 'heal'],
  nodes: [
    { nodeId: 'component', kind: 'agent', recipe: 'none', maxVisits: 1 },
    { nodeId: 'done', kind: 'gate', recipe: 'none', maxVisits: 1 },
    { nodeId: 'needs-human', kind: 'gate', recipe: 'none', maxVisits: 1 },
  ],
  edges: [{ from: 'component', on: 'outcome', map: {
    success: 'done', failure: 'needs-human', missing: 'needs-human', stuck: 'needs-human', 'budget-exceeded': 'needs-human',
  } }],
};

test('real graph selector routes simulated component exits for success, failure, missing, stuck and budget exhaustion', () => {
  const expected = new Map([
    ['success', 'done'], ['failure', 'needs-human'], ['missing', 'needs-human'],
    ['stuck', 'needs-human'], ['budget-exceeded', 'needs-human'],
  ]);
  for (const [outcome, destination] of expected) {
    const observation = simGraphEngineSelection({ graph, exit: { nodeId: 'component', outcome } });
    expect(observation.to).toBe(destination);
    expect(observation.growthApplied).toBe(false);
    expect(observation.sourceGraphUnchanged).toBe(true);
  }
});

test('ARG healing growth changes the real selector route without mutating the source graph', () => {
  const growth: GraphGrowth = {
    node: { nodeId: 'heal', kind: 'agent', recipe: 'none', maxVisits: 1 },
    edges: [
      { from: 'component', on: 'outcome', map: { 'needs-heal': 'heal' } },
      { from: 'heal', to: 'component' },
    ],
    reason: 'ARG adds one healing route for a newly observed component outcome',
    undo: { removeNode: 'heal', removeOutcome: { from: 'component', outcome: 'needs-heal' }, removeEdge: { from: 'heal', to: 'component' } },
  };
  const observation = simGraphEngineSelection({ graph, exit: { nodeId: 'component', outcome: 'needs-heal' }, growth });
  expect(observation).toMatchObject({ from: 'component', outcome: 'needs-heal', to: 'heal', growthApplied: true, sourceGraphUnchanged: true });
  expect(graph.edges[0]?.map?.['needs-heal']).toBeUndefined();
  expect(renderGraphEngineSim(observation)).toContain('component --needs-heal--> heal');
});

test('unmapped simulated exit preserves production fallback behavior', () => {
  const fallbackGraph: GraphTemplateSpec = {
    ...graph,
    edges: [{ from: 'component', on: 'outcome', map: { failure: 'needs-human' }, fallback: [{ node: 'needs-human', requires: [] }] }],
  };
  const observation = simGraphEngineSelection({ graph: fallbackGraph, exit: { nodeId: 'component', outcome: 'unlisted-exit' } });
  expect(observation.to).toBe('needs-human');
});
