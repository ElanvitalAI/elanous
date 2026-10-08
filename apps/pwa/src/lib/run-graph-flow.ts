import { layeredPositions, mergeParallelEdges, routeEdges, type GraphFlowDirection } from './graph-edge-route';
import type { Edge, Node } from '@xyflow/react';
import type { RunGraphDetail } from '../nexus/client';

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
