import { layeredPositions, mergeParallelEdges, routeEdges, type GraphFlowDirection } from './graph-edge-route';
import type { Edge, Node } from '@xyflow/react';
import type { HarnessGraphEventWire, RunGraphDetail } from '../nexus/client';

export interface RunGraphNodeData extends Record<string, unknown> {
  label: string;
  kind: string;
  recipe: string;
  maxVisits: number;
  entry: boolean;
  terminal: boolean;
  outcomes: string[];
  inputHandles: string[];
  outputHandles: string[];
  height: number;
}

export const RUN_NODE_WIDTH = 190;
const flow: GraphFlowDirection = 'horizontal';
type RunGraphAdaptiveEvent = Extract<HarnessGraphEventWire, { type: 'node-added' | 'edge-rerouted' | 'unit-expanded' | 'unit-collapsed' }>;

export interface RunGraphAdaptiveEvidence {
  orderedEvents: RunGraphAdaptiveEvent[];
  addedNodes: Extract<HarnessGraphEventWire, { type: 'node-added' }>[];
  depthChanges: Extract<HarnessGraphEventWire, { type: 'unit-expanded' | 'unit-collapsed' }>[];
  repairs: Extract<HarnessGraphEventWire, { type: 'edge-rerouted' }>[];
  handNodes: Extract<HarnessGraphEventWire, { type: 'node-added' }>[];
}

/** Summarize only recorded structural events; no synthetic scene counts are inferred from traversal steps. */
export function runGraphAdaptiveEvidence(events: readonly HarnessGraphEventWire[] = []): RunGraphAdaptiveEvidence {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const addedNodes = ordered.filter((event): event is Extract<HarnessGraphEventWire, { type: 'node-added' }> => event.type === 'node-added');
  return {
    orderedEvents: ordered.filter((event): event is RunGraphAdaptiveEvent => event.type === 'node-added' || event.type === 'unit-expanded' || event.type === 'unit-collapsed' || event.type === 'edge-rerouted'),
    addedNodes,
    depthChanges: ordered.filter((event): event is Extract<HarnessGraphEventWire, { type: 'unit-expanded' | 'unit-collapsed' }> => event.type === 'unit-expanded' || event.type === 'unit-collapsed'),
    repairs: ordered.filter((event): event is Extract<HarnessGraphEventWire, { type: 'edge-rerouted' }> => event.type === 'edge-rerouted'),
    handNodes: addedNodes.filter((event) => event.kind === 'hand'),
  };
}

/** Replay the traversal route's existing structural events without mutating the loaded YAML graph. */
export function applyRunGraphEvents(graph: RunGraphDetail, events: readonly HarnessGraphEventWire[]): RunGraphDetail {
  return [...events].sort((left, right) => left.seq - right.seq).reduce((current, event) => {
    if (event.type === 'node-added') {
      if (current.nodes.some((node) => node.node_id === event.node)) return current;
      return { ...current, nodes: [...current.nodes, {
        node_id: event.node, kind: event.kind, recipe: `runtime:${event.decider}`, max_visits: 1,
      }] };
    }
    if (event.type !== 'edge-rerouted') return current;
    let changed = false;
    const edges = current.edges.map((edge) => {
      if (edge.from !== event.from) return edge;
      if (edge.map && event.outcome !== '$default' && Object.hasOwn(edge.map, event.outcome)) {
        changed = true;
        return { ...edge, map: { ...edge.map, [event.outcome]: event.to } };
      }
      if (edge.map && event.was !== '$absent') {
        const previousOutcome = Object.entries(edge.map).find(([, target]) => target === event.was)?.[0];
        if (previousOutcome) {
          changed = true;
          return { ...edge, map: { ...edge.map, [previousOutcome]: event.to } };
        }
      }
      if (edge.to === event.was && event.outcome === '$default') {
        changed = true;
        return { ...edge, to: event.to };
      }
      return edge;
    });
    if (changed) return { ...current, edges };
    if (event.was !== '$absent') return current;
    const mapped = event.outcome !== '$default'
      ? edges.map((edge) => edge.from === event.from && edge.map
        ? { ...edge, map: { ...edge.map, [event.outcome]: event.to } }
        : edge)
      : edges;
    if (event.outcome !== '$default' && mapped.some((edge, index) => edge !== edges[index])) return { ...current, edges: mapped };
    return { ...current, edges: [...edges, { from: event.from, to: event.to }] };
  }, graph);
}

/** GRAPH-EDGE-TIDY — outcomes that share a target merge into one edge labelled «a · b»; ranks follow forward edges
 *  only; every edge is pre-routed (graph-edge-route.ts) and drawn by the `tidy` edge type. */
export function runGraphToFlow(graph: RunGraphDetail): { nodes: Node<RunGraphNodeData>[]; edges: Edge[] } {
  const raw = graph.edges.flatMap((edge) => edge.map
    ? Object.entries(edge.map).map(([outcome, to]) => ({ from: edge.from, to, outcome }))
    : edge.to ? [{ from: edge.from, to: edge.to, outcome: '' }] : []);
  const outcomesOf = (id: string) => raw.filter((edge) => edge.from === id && edge.outcome).map((edge) => edge.outcome);
  const sized = graph.nodes.map((node) => ({ id: node.node_id, width: RUN_NODE_WIDTH, height: outcomesOf(node.node_id).length ? 86 : 70 }));
  const positions = layeredPositions(sized, raw, { entry: graph.entry_node, flow, margin: 25 });
  const placed = sized.map((node) => ({ ...node, ...(positions.get(node.id) ?? { x: 0, y: 0 }) }));
  const routed = routeEdges(placed, mergeParallelEdges(raw), { flow });
  const edges: Edge[] = routed.map((route) => ({
    id: route.id, source: route.from, target: route.to, sourceHandle: 'out', targetHandle: 'in',
    type: 'tidy', ...(route.label ? { label: route.label.text } : {}), data: { route },
  }));
  const terminals = new Set(graph.terminal_nodes);
  return {
    nodes: graph.nodes.map((node, index) => ({
      id: node.node_id,
      position: { x: placed[index]!.x, y: placed[index]!.y },
      data: {
        label: node.node_id,
        kind: node.kind,
        recipe: node.recipe,
        maxVisits: node.max_visits,
        entry: graph.entry_node === node.node_id,
        terminal: terminals.has(node.node_id),
        outcomes: outcomesOf(node.node_id),
        inputHandles: ['in'],
        outputHandles: ['out'],
        height: placed[index]!.height,
      },
    })),
    edges,
  };
}
