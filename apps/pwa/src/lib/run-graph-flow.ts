import dagre from '@dagrejs/dagre';
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

/** Preserve each outcome as its own labelled edge, even when two outcomes share a target. */
export function runGraphToFlow(graph: RunGraphDetail): { nodes: Node<RunGraphNodeData>[]; edges: Edge[] } {
  const edges: Edge[] = graph.edges.flatMap((edge, index) => edge.map
    ? Object.entries(edge.map).map(([outcome, target]) => ({
        id: `${index}:${edge.from}:${outcome}`, source: edge.from, target, label: outcome,
        data: { on: edge.on }, type: 'straight',
      }))
    : edge.to ? [{ id: `${index}:${edge.from}:${edge.to}`, source: edge.from, target: edge.to, type: 'smoothstep' }] : []);

  // One handle per result makes parallel outcomes visibly separate at both ends.
  for (const node of graph.nodes) {
    const outgoing = edges.filter((edge) => edge.source === node.node_id);
    const incoming = edges.filter((edge) => edge.target === node.node_id);
    outgoing.forEach((edge, index) => { edge.sourceHandle = `out-${index}`; });
    incoming.forEach((edge, index) => { edge.targetHandle = `in-${index}`; });
  }

  const layout = new dagre.graphlib.Graph();
  layout.setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 55, marginx: 25, marginy: 25 });
  for (const node of graph.nodes) {
    const handleCount = Math.max(1, edges.filter((edge) => edge.source === node.node_id).length,
      edges.filter((edge) => edge.target === node.node_id).length);
    layout.setNode(node.node_id, { width: 190, height: Math.max(90, (handleCount + 1) * 26) });
  }
  for (const edge of edges) layout.setEdge(edge.source, edge.target);
  dagre.layout(layout);

  const terminals = new Set(graph.terminal_nodes);
  return {
    nodes: graph.nodes.map((node) => {
      const position = layout.node(node.node_id) as { x: number; y: number; height: number };
      const outgoing = edges.filter((edge) => edge.source === node.node_id);
      const incoming = edges.filter((edge) => edge.target === node.node_id);
      return {
        id: node.node_id,
        position: { x: position.x - 95, y: position.y - position.height / 2 },
        data: {
          label: node.node_id,
          kind: node.kind,
          recipe: node.recipe,
          maxVisits: node.max_visits,
          entry: graph.entry_node === node.node_id,
          terminal: terminals.has(node.node_id),
          outcomes: outgoing.filter((edge) => typeof edge.label === 'string').map((edge) => edge.label as string),
          inputHandles: incoming.map((edge) => edge.targetHandle!),
          outputHandles: outgoing.map((edge) => edge.sourceHandle!),
          height: position.height,
        },
      };
    }),
    edges,
  };
}
