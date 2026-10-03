import { describe, expect, test } from 'bun:test';
import { GRAPH_SPECS } from './graph-templates.js';
import { createGraphVariant, type GraphVariantPlan } from './graph-variant.js';
import { edgeMapOf, type GraphTemplateSpec } from './graph-yaml.js';
import { selectOverlays } from './graph-overlay-yaml.js';

const template = GRAPH_SPECS['self-implement'] as GraphTemplateSpec;
const plan: GraphVariantPlan = { maxVisits: { rework: 5 }, routes: [{ from: 'review', outcome: 'pass', to: 'open-pr' }] };

function generate(changes: GraphVariantPlan, source = template) {
  return createGraphVariant({ template: source, goal: 'g_abc123', plan: changes });
}

describe('harness graph variant', () => {
  test('injected plan changes only allowed visits and conditional route; is reproducible and goal-scoped', () => {
    const result = generate(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const again = generate(plan);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(result.overlay).toEqual(again.overlay);
    expect(result.template).toEqual(again.template);
    expect(result.patches).toEqual([
      { op: 'replace', path: `/nodes/${template.nodes.findIndex((node) => node.nodeId === 'rework')}/maxVisits`, value: 5 },
      { op: 'replace', path: `/edges/${template.edges.findIndex((edge) => edge.from === 'review' && edge.map?.pass)}/map/pass`, value: 'open-pr' },
    ]);
    expect(result.template.nodes.find((node) => node.nodeId === 'rework')?.maxVisits).toBe(5);
    expect(edgeMapOf(result.template).review).toContain('open-pr');
    expect(template.nodes.find((node) => node.nodeId === 'rework')?.maxVisits).not.toBe(5);
    expect(template.edges.find((edge) => edge.from === 'review' && edge.map)?.map?.pass).toBe('main-sync');
    expect(result.template.nodes.map((node) => node.nodeId)).toEqual(template.nodes.map((node) => node.nodeId));
    expect(selectOverlays([result.overlay], { graphId: template.graphId, stage: 'launch', state: { goal_key: 'g_abc123' } }).applied).toHaveLength(1);
    expect(selectOverlays([result.overlay], { graphId: template.graphId, stage: 'launch', state: { goal_key: 'g_other' } }).applied).toHaveLength(0);
  });

  test('sorting visit and route proposals yields the same variant', () => {
    const a = generate({ maxVisits: { review: 6, rework: 5 }, routes: [{ from: 'review', outcome: 'pass', to: 'open-pr' }, { from: 'gate', outcome: 'pass', to: 'open-pr' }] });
    const b = generate({ routes: [{ from: 'gate', outcome: 'pass', to: 'open-pr' }, { from: 'review', outcome: 'pass', to: 'open-pr' }], maxVisits: { rework: 5, review: 6 } });
    expect(a).toEqual(b);
  });

  test('unknown source, destination and visit nodes reject the whole proposal', () => {
    const result = generate({ maxVisits: { missing: 2, rework: 5 }, routes: [{ from: 'review', outcome: 'pass', to: 'missing' }, { from: 'missing', outcome: 'pass', to: 'merge' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections).toEqual([
      { kind: 'unknown-node', node: 'missing' },
      { kind: 'unknown-node', node: 'missing' },
      { kind: 'unknown-node', node: 'missing' },
    ]);
    expect('template' in result).toBe(false);
  });

  test('protects unconditional and fallback edges and rejects invented outcomes', () => {
    for (const proposal of [
      { from: 'open-pr', outcome: 'pass', to: 'review' },
      { from: 'review', outcome: 'fallback', to: 'merge' },
      { from: 'gate', outcome: 'invented', to: 'review' },
    ]) {
      const result = generate({ routes: [proposal] });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.rejections[0]?.kind).toBe('protected-edge');
    }
  });

  test('unknown outcome on a conditional-only edge is distinct from a protected edge', () => {
    const compact: GraphTemplateSpec = {
      graphId: 'compact', version: 1, entryNode: 'start', terminalNodes: ['end'],
      nodes: ['start', 'end'].map((nodeId) => ({ nodeId, kind: 'agent', recipe: 'unit', maxVisits: 1, contract: { inputs: [], tools: 'read-only', outputs: [] } })),
      edges: [{ from: 'start', on: 'outcome', map: { pass: 'end' } }],
    };
    const result = generate({ routes: [{ from: 'start', outcome: 'invented', to: 'end' }] }, compact);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections).toEqual([{ kind: 'unknown-outcome', from: 'start', outcome: 'invented' }]);
  });

  test('invalid budgets fail closed including zero, fractional and non-finite values', () => {
    for (const value of [0, -1, 1.25, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const result = generate({ maxVisits: { rework: value } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejections[0]).toEqual({ kind: 'invalid-budget', node: 'rework', value });
    }
  });

  test('a route that cuts off the declared terminal cannot be accepted', () => {
    const compact: GraphTemplateSpec = {
      graphId: 'compact', version: 1, entryNode: 'start', terminalNodes: ['end'],
      nodes: ['start', 'end'].map((nodeId) => ({ nodeId, kind: 'agent', recipe: 'unit', maxVisits: 1, contract: { inputs: [], tools: 'read-only', outputs: [] } })),
      edges: [{ from: 'start', on: 'outcome', map: { pass: 'end' } }],
    };
    const result = generate({ routes: [{ from: 'start', outcome: 'pass', to: 'start' }] }, compact);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections.some((rejection) => rejection.kind === 'unreachable-terminal' && rejection.node === 'end')).toBe(true);
  });

  test('duplicate routes and invalid goal identity reject rather than silently winning', () => {
    const duplicated = generate({ routes: [{ from: 'review', outcome: 'pass', to: 'open-pr' }, { from: 'review', outcome: 'pass', to: 'merge' }] });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.rejections[0]?.kind).toBe('duplicate-route');
    const invalid = createGraphVariant({ template, goal: 'a b', plan: {} });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.rejections[0]?.kind).toBe('invalid-goal');
  });

  test('an outcome declared on two conditional edges of one node is rejected, not half-patched', () => {
    const reviewEdge = template.edges.find((edge) => edge.from === 'review' && edge.map?.pass);
    expect(reviewEdge).toBeDefined();
    const doubled: GraphTemplateSpec = { ...template, edges: [...template.edges, { ...reviewEdge!, map: { pass: reviewEdge!.map!.pass! } }] };
    const result = generate({ routes: [{ from: 'review', outcome: 'pass', to: 'open-pr' }] }, doubled);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections).toEqual([{ kind: 'ambiguous-outcome', from: 'review', outcome: 'pass' }]);
  });
});
