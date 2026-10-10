import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCanvasRunSteps, autoLayout, autoLayoutToFit, CANVAS_NODE_SIZE, canvasOutcomeLabel, fromYaml, type CanvasGraph } from '../components/editor/graph-canvas-model';
import { dfsBackEdges, edgeFamily, hoverFocus, labelCollisions, mergeParallelEdges, routeEdges, WIRING_STYLE, wiringEdgeStyle, type RouteNode } from './graph-edge-route';
import type { RunStep } from '../../../../src/self-implement/run-step-projection';

const repoGraph = (name: string) => readFileSync(join(import.meta.dir, '../../../../graphs', name), 'utf8');

function route(graph: CanvasGraph, flow: 'horizontal' | 'vertical' = 'horizontal') {
  const nodes: RouteNode[] = graph.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, ...CANVAS_NODE_SIZE }));
  return { nodes, routed: routeEdges(nodes, mergeParallelEdges(graph.edges), { flow, rename: canvasOutcomeLabel }) };
}

function hitsBody(points: Array<{ x: number; y: number }>, box: RouteNode): boolean {
  // Sample every segment; a point strictly inside the card (2px inset) = the line crosses the body.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    for (let k = 0; k <= 20; k++) {
      const x = a.x + ((b.x - a.x) * k) / 20, y = a.y + ((b.y - a.y) * k) / 20;
      if (x > box.x + 2 && x < box.x + box.width - 2 && y > box.y + 2 && y < box.y + box.height - 2) return true;
    }
  }
  return false;
}

describe('graph editor hover focus', () => {
  const edges = [
    { id: 'ab', from: 'a', to: 'b' },
    { id: 'bc', from: 'b', to: 'c' },
    { id: 'de', from: 'd', to: 'e' },
  ] as const;

  test('focuses only the hovered node and its directly connected nodes and edges', () => {
    const focus = hoverFocus('b', edges);
    expect(focus?.nodes).toEqual(new Set(['a', 'b', 'c']));
    expect(focus?.edges).toEqual(new Set(['ab', 'bc']));
    expect(focus?.nodes.has('d')).toBe(false);
    expect(focus?.nodes.has('e')).toBe(false);
    expect(focus?.edges.has('de')).toBe(false);
  });

  test('returns null without hover and keeps an isolated node with no edges', () => {
    expect(hoverFocus(null, edges)).toBeNull();
    expect(hoverFocus('isolated', edges)).toEqual({ nodes: new Set(['isolated']), edges: new Set() });
    expect(hoverFocus('isolated', [])).toEqual({ nodes: new Set(['isolated']), edges: new Set() });
  });
});

describe('wiring edge focus', () => {
  test('highlights the direct edge and dims an unrelated edge', () => {
    const focus = hoverFocus('a', [{ id: 'ab', from: 'a', to: 'b' }, { id: 'cd', from: 'c', to: 'd' }]);
    expect(WIRING_STYLE).toEqual({ gold: '#D4AF37', flowDash: '3 14', dimNode: 0.22, dimEdge: 0.15, width: 3 });
    expect(wiringEdgeStyle(focus, 'ab')).toEqual({
      style: { stroke: '#D4AF37', strokeWidth: 3, strokeDasharray: '3 14' }, animated: true,
    });
    expect(wiringEdgeStyle(focus, 'cd')).toEqual({ style: { opacity: 0.15 } });
  });

  test('leaves edge style and animation unset when no node is hovered', () => {
    expect(wiringEdgeStyle(null, 'ab')).toEqual({});
  });
});

describe('GRAPH-EDGE-TIDY · merge', () => {
  test('same (from,to) outcomes become one edge with a combined label', () => {
    const merged = mergeParallelEdges([
      { from: 'investigate', to: 'gate', outcome: 'code-changed' },
      { from: 'investigate', to: 'judge', outcome: 'documents-only' },
      { from: 'investigate', to: 'gate', outcome: 'unknown' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 'e0', from: 'investigate', to: 'gate', outcomes: ['code-changed', 'unknown'], indexes: [0, 2] });
    const { routed } = route(fromYaml(repoGraph('research-loop.yaml')));
    expect(routed.find((edge) => edge.from === 'investigate' && edge.to === 'gate')?.label?.text).toBe('code-changed · unknown');
  });

  test('outcome families colour pass / fail / other', () => {
    expect(edgeFamily(['pass'])).toBe('pass');
    expect(edgeFamily(['fail'])).toBe('fail');
    expect(edgeFamily(['code-changed', 'unknown'])).toBe('neutral');
    expect(edgeFamily(['pass', 'fail'])).toBe('neutral');
  });
});

describe('GRAPH-EDGE-TIDY · layout and routing on the shipped graphs', () => {
  for (const name of ['research-loop.yaml', 'implement-loop.yaml']) {
    for (const [flow, lineLength] of [['horizontal', undefined], ['vertical', undefined], ['horizontal', 1100], ['horizontal', 1600]] as const) {
      test(`${name} (${flow}${lineLength ? ` · wrapped at ${lineLength}` : ''}): back edges below in distinct lanes, no edge through a card, labels never collide`, () => {
        const graph = autoLayoutToFit(fromYaml(repoGraph(name)), flow, lineLength);
        const { nodes, routed } = route(graph, flow);
        const back = routed.filter((edge) => edge.kind === 'back');
        expect(back.length).toBeGreaterThan(0);
        // Back edges loop below (horizontal) / right of (vertical) every card they span, each lane on its own line.
        const cross = (p: { x: number; y: number }) => (flow === 'horizontal' ? p.y : p.x);
        const lanes = back.map((edge) => cross(edge.points[2]!));
        expect(new Set(lanes).size).toBe(lanes.length);
        for (const edge of back) {
          const ends = nodes.filter((node) => node.id === edge.from || node.id === edge.to);
          const source = ends.find((node) => node.id === edge.from)!;
          expect(cross(edge.points[2]!)).toBeGreaterThan(cross({ x: source.x + source.width, y: source.y + source.height }));
        }
        // No edge crosses a card it does not connect.
        for (const edge of routed) {
          for (const node of nodes) if (node.id !== edge.from && node.id !== edge.to) expect({ edge: edge.id, node: node.id, hit: hitsBody(edge.points, node) }).toEqual({ edge: edge.id, node: node.id, hit: false });
        }
        // Several outcomes leaving one card leave from distinct ports.
        const starts = new Map<string, Set<string>>();
        for (const edge of routed) starts.set(edge.from, (starts.get(edge.from) ?? new Set()).add(`${edge.points[0]!.x},${edge.points[0]!.y}`));
        for (const [from, set] of starts) expect({ from, ports: set.size }).toEqual({ from, ports: routed.filter((edge) => edge.from === from).length });
        // Labels: no overlap with each other or with any card.
        expect(labelCollisions(nodes, routed)).toEqual({ labelLabel: 0, labelNode: 0 });
      });
    }
  }

  test('research-loop: the documents-only skip branch gets its own lane instead of overlapping gate', () => {
    const graph = fromYaml(repoGraph('research-loop.yaml'));
    const at = (id: string) => graph.nodes.find((node) => node.id === id)!;
    expect(at('gate').x).toBeGreaterThan(at('investigate').x);
    expect(at('judge').x).toBeGreaterThan(at('gate').x);
    const { routed } = route(graph);
    const skip = routed.find((edge) => edge.from === 'investigate' && edge.to === 'judge')!;
    const gate = route(graph).nodes.find((node) => node.id === 'gate')!;
    expect(hitsBody(skip.points, gate)).toBe(false);
  });

  test('DFS back-edge detection ranks by forward edges only', () => {
    const back = dfsBackEdges(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'b', to: 'a' }], 'a');
    expect([...back].sort()).toEqual(['b\u0000a', 'c\u0000a']);
  });

  test('a user-moved card keeps its position (routing follows the card, layout does not move it)', () => {
    const graph = fromYaml(repoGraph('research-loop.yaml'));
    const moved = { ...graph, nodes: graph.nodes.map((node) => node.id === 'merge' ? { ...node, x: -500, y: 900 } : node) };
    const { routed } = route(moved);
    const into = routed.find((edge) => edge.to === 'merge')!;
    expect(into.points.at(-1)!.x).toBe(-500);
  });

  test('a forward curve that would pass through a third card detours even when the chord between the ends clears it', () => {
    const nodes: RouteNode[] = [
      { id: 's', x: 0, y: 0, width: 180, height: 72 },
      { id: 't', x: 500, y: 400, width: 180, height: 72 },
      { id: 'mid', x: 280, y: 70, width: 180, height: 72 },
    ];
    const routed = routeEdges(nodes, mergeParallelEdges([{ from: 's', to: 't', outcome: 'pass' }]));
    expect(hitsBody(routed[0]!.points, nodes[2]!)).toBe(false);
  });

  test('labels still clear every card when a drag leaves less room between cards than the pill is wide', () => {
    const nodes: RouteNode[] = [
      { id: 'a', x: 0, y: 0, width: 180, height: 72 },
      { id: 'b', x: 200, y: 0, width: 180, height: 72 },
    ];
    const routed = routeEdges(nodes, mergeParallelEdges([
      { from: 'a', to: 'b', outcome: 'code-changed' },
      { from: 'a', to: 'b', outcome: 'documents-only' },
      { from: 'b', to: 'a', outcome: 'fail' },
    ]));
    expect(labelCollisions(nodes, routed)).toEqual({ labelLabel: 0, labelNode: 0 });
  });

  test('a long chain wraps onto lines that fit the given length (no shrinking)', () => {
    for (const name of ['research-loop.yaml', 'implement-loop.yaml']) {
      const graph = autoLayoutToFit(fromYaml(repoGraph(name)), 'horizontal', 1100);
      const xs = graph.nodes.map((node) => node.x);
      expect(Math.max(...xs) + CANVAS_NODE_SIZE.width - Math.min(...xs)).toBeLessThanOrEqual(1100);
      expect(new Set(graph.nodes.map((node) => Math.round(node.y / 100))).size).toBeGreaterThan(1);
      const single = autoLayout(fromYaml(repoGraph(name)), 'horizontal');
      const singleXs = single.nodes.map((node) => node.x);
      expect(Math.max(...singleXs) - Math.min(...singleXs)).toBeGreaterThan(1100);
    }
  });

  test('re-entering a laid-out node clears its prior exit without moving the static layout', () => {
    const graph = autoLayout(fromYaml(repoGraph('research-loop.yaml')), 'horizontal');
    const positions = graph.nodes.map(({ id, x, y }) => ({ id, x, y }));
    const steps: RunStep[] = [
      { seq: 1, ts: '2026-10-09T00:01:00.000Z', type: 'node-enter', node: 'investigate', visit: 1 },
      { seq: 2, ts: '2026-10-09T00:02:00.000Z', type: 'node-exit', node: 'investigate', outcome: 'code-changed' },
      { seq: 3, ts: '2026-10-09T00:03:00.000Z', type: 'node-enter', node: 'investigate', visit: 2 },
    ];
    const result = applyCanvasRunSteps(graph, steps);
    expect(result.nodes.investigate).toEqual({
      visit: 2, enteredAt: '2026-10-09T00:03:00.000Z', outcome: undefined,
      exitedAt: undefined, skipped: undefined,
    });
    expect(result.graph.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(positions);
  });
});
