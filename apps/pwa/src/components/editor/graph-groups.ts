// GRAPH-GROUPS (0.2.21) — reusable «묶음» (subgraph unit) model for run graphs, shared by the graph editor
// and the /live-run scene.
//
// Two views of the same graph:
//   · 접기(collapsed): every member of a unit becomes ONE node `group:<name>` (kind `subgraph`); edges into/out of the
//     unit are rewired to it, edges inside the unit disappear. The collapsed graph is laid out fresh by the same
//     `runGraphToFlow`, so the tidy edge routing still applies.
//   · 펼치기(통합 보기): nodes stay where the layout put them and each unit gets a labelled box around its members.
//
// Until real `kind: subgraph` exists, units come from the node `group:` tag (HARNESS-FULL-GRAPH). No tag ⇒ no units.

import type { RunGraphDetail } from '@/nexus/client';

export type GroupedRunGraph = Omit<RunGraphDetail, 'nodes'> & {
  nodes: Array<RunGraphDetail['nodes'][number] & { group?: string }>;
};

export const GROUP_NODE_PREFIX = 'group:';
export const groupNodeId = (group: string) => `${GROUP_NODE_PREFIX}${group}`;
export const isGroupNodeId = (id: string) => id.startsWith(GROUP_NODE_PREFIX);

/** node id → unit name, only for nodes that carry a non-empty `group` tag. */
export function groupOf(graph: GroupedRunGraph): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of graph.nodes) {
    const group = typeof node.group === 'string' ? node.group.trim() : '';
    if (group) out.set(node.node_id, group);
  }
  return out;
}

/** Unit names in first-declared order. */
export function groupNames(graph: GroupedRunGraph): string[] {
  return [...new Set(groupOf(graph).values())];
}

/** The graph with every unit in `collapsed` folded into one node. `resolve(id)` maps an original node id to the id
 *  drawn in the collapsed graph (itself, or its unit node). */
export function collapseGroups(graph: GroupedRunGraph, collapsed: ReadonlySet<string>): { graph: GroupedRunGraph; resolve: (id: string) => string } {
  const groups = groupOf(graph);
  const resolve = (id: string) => {
    const group = groups.get(id);
    return group && collapsed.has(group) ? groupNodeId(group) : id;
  };
  if (![...groups.values()].some((group) => collapsed.has(group))) return { graph, resolve };

  const nodes: GroupedRunGraph['nodes'] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    const id = resolve(node.node_id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === node.node_id) { nodes.push(node); continue; }
    const group = groups.get(node.node_id)!;
    const members = graph.nodes.filter((candidate) => groups.get(candidate.node_id) === group);
    nodes.push({ node_id: id, kind: 'subgraph', recipe: `묶음 · 노드 ${members.length}개`, max_visits: Math.max(...members.map((member) => member.max_visits)), group });
  }

  const edges: GroupedRunGraph['edges'] = [];
  for (const edge of graph.edges) {
    const from = resolve(edge.from);
    if (edge.map) {
      const map: Record<string, string> = {};
      for (const [outcome, to] of Object.entries(edge.map)) {
        const target = resolve(to);
        if (target !== from) map[outcome] = target;
      }
      if (Object.keys(map).length) edges.push({ from, ...(edge.on ? { on: edge.on } : {}), map });
    } else if (edge.to) {
      const target = resolve(edge.to);
      if (target !== from) edges.push({ from, to: target });
    }
  }
  // A collapsed unit may now carry the same outcome out of two members — merge them into one map edge.
  const merged: GroupedRunGraph['edges'] = [];
  for (const edge of edges) {
    const twin = merged.find((candidate) => candidate.from === edge.from && Boolean(candidate.map) === Boolean(edge.map) && (edge.map || candidate.to === edge.to));
    if (!twin) { merged.push(edge.map ? { ...edge, map: { ...edge.map } } : edge); continue; }
    // Same outcome to a DIFFERENT target keeps both routes — the second gets a qualified key so the walked edge
    // still exists (the scene matches edges by from→to first).
    if (edge.map && twin.map) {
      for (const [outcome, to] of Object.entries(edge.map)) {
        if (!(outcome in twin.map)) twin.map[outcome] = to;
        else if (twin.map[outcome] !== to && !Object.values(twin.map).includes(to)) twin.map[`${outcome}·${to.replace(GROUP_NODE_PREFIX, '')}`] = to;
      }
    }
  }

  const entry = resolve(graph.entry_node);
  const terminals = [...new Set(graph.terminal_nodes.map(resolve))];
  return { graph: { ...graph, entry_node: entry, terminal_nodes: terminals, nodes, edges: merged }, resolve };
}

export interface GroupBox {
  id: string;
  group: string;
  x: number;
  y: number;
  width: number;
  height: number;
  members: string[];
}

export const GROUP_BOX_PAD = 18;
export const GROUP_BOX_HEADER = 26;

/** One box per expanded unit, around its members' laid-out rectangles. */
export function groupBoxes(
  nodes: ReadonlyArray<{ id: string; position: { x: number; y: number }; width: number; height: number }>,
  groups: ReadonlyMap<string, string>,
): GroupBox[] {
  const byGroup = new Map<string, typeof nodes[number][]>();
  for (const node of nodes) {
    const group = groups.get(node.id);
    if (!group || isGroupNodeId(node.id)) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), node]);
  }
  return [...byGroup.entries()].map(([group, members]) => {
    const x0 = Math.min(...members.map((node) => node.position.x));
    const y0 = Math.min(...members.map((node) => node.position.y));
    const x1 = Math.max(...members.map((node) => node.position.x + node.width));
    const y1 = Math.max(...members.map((node) => node.position.y + node.height));
    return {
      id: `box:${group}`, group, members: members.map((node) => node.id),
      x: x0 - GROUP_BOX_PAD, y: y0 - GROUP_BOX_PAD - GROUP_BOX_HEADER,
      width: x1 - x0 + GROUP_BOX_PAD * 2, height: y1 - y0 + GROUP_BOX_PAD * 2 + GROUP_BOX_HEADER,
    };
  });
}

export type GroupState = 'pending' | 'running' | 'passed' | 'failed';

/** A unit's state from its members': running wins, then failed, then passed; all pending ⇒ pending. */
export function aggregateGroupState(states: readonly GroupState[]): GroupState {
  if (states.includes('running')) return 'running';
  if (states.includes('failed')) return 'failed';
  if (states.includes('passed')) return 'passed';
  return 'pending';
}
