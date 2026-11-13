import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { GraphEdgeSpec, GraphTemplateSpec } from '../self-implement/graph-yaml.js';

export type PlannedStep = { outcome?: string; to: string };

const LOOP_TERMINAL_STATUS: Readonly<Record<string, Readonly<Record<string, 'done' | 'failed'>>>> = {
  'ta-journey': { done: 'done', failed: 'failed', 'needs-human': 'failed', rework: 'failed' },
  'default-loop': { landed: 'done', stopped: 'failed' },
  'document-loop': { landed: 'done', 'document-blocked': 'failed', 'needs-human': 'failed' },
  'operate-loop': { landed: 'done', 'operate-blocked': 'failed', 'needs-human': 'failed' },
  'research-loop': { landed: 'done', 'needs-human': 'failed' },
};

export function topLevelTerminalStatus(graphId: string, terminal: string): 'done' | 'failed' | undefined {
  const aliases = Object.hasOwn(LOOP_TERMINAL_STATUS, graphId) ? LOOP_TERMINAL_STATUS[graphId] : undefined;
  if (aliases) return Object.hasOwn(aliases, terminal) ? aliases[terminal] : undefined;
  if (terminal === 'needs-human' || terminal === 'rework') return 'failed';
  return terminal === 'done' || terminal === 'failed' ? terminal : undefined;
}

/** Shortest declared route (map/to edges only — fallbacks are not a success branch) to a terminal that maps to `done`.
 * Ties keep the first declared outcome, so the plan follows the YAML's own order. A unit call only takes its first
 * declared exit (the same stand-in a plain dry run uses) — its `rework` exit is a shortcut, not the success path. */
export function planHarnessLoopRoute(graph: GraphTemplateSpec, unitSuccessExit: (nodeId: string) => string | undefined): Map<string, PlannedStep> {
  const candidates = new Map<string, PlannedStep[]>();
  for (const node of graph.nodes) {
    const edge = graph.edges.find((item) => item.from === node.nodeId);
    if (!edge) continue;
    const exit = unitSuccessExit(node.nodeId);
    candidates.set(node.nodeId, edge.to !== undefined ? [{ to: edge.to }]
      : Object.entries(edge.map ?? {}).filter(([outcome]) => exit === undefined || outcome === exit).map(([outcome, to]) => ({ outcome, to })));
  }
  const distance = new Map<string, number>();
  for (const terminal of graph.terminalNodes) if (topLevelTerminalStatus(graph.graphId, terminal) === 'done') distance.set(terminal, 0);
  const route = new Map<string, PlannedStep>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [nodeId, steps] of candidates) {
      if (graph.terminalNodes.includes(nodeId)) continue;
      let best: { step: PlannedStep; d: number } | undefined;
      for (const step of steps) {
        const d = distance.get(step.to);
        if (d !== undefined && (!best || d + 1 < best.d)) best = { step, d: d + 1 };
      }
      if (best && (distance.get(nodeId) ?? Infinity) > best.d) {
        distance.set(nodeId, best.d);
        route.set(nodeId, best.step);
        changed = true;
      }
    }
  }
  return route;
}

/** Production edge selection shared by runGraph and the graph simulator device. */
export function nextNode(edges: readonly GraphEdgeSpec[], nodeId: string, exitOutcome: 'ok' | 'fail', namedOutcome?: string): string | undefined {
  const edge = edges.find((item) => item.from === nodeId);
  if (!edge) return undefined;
  // A static edge is the success continuation. A failed node must not run
  // downstream side effects and later turn the whole graph into a false done.
  if (edge.to !== undefined) return exitOutcome === 'ok' ? edge.to : undefined;
  if (edge.on !== 'outcome') throw new Error(`unsupported edge condition: ${edge.on}`);
  if (namedOutcome !== undefined && edge.map && Object.hasOwn(edge.map, namedOutcome)) return edge.map[namedOutcome];
  return edge.map?.[exitOutcome] ?? edge.fallback?.[0]?.node;
}

export function releaseRouteReachesKnownIssues(edges: readonly GraphEdgeSpec[], startAt: string): boolean {
  const forbidden = new Set(['publish', 'approve-publish']);
  const reaches = (cursor: string | undefined, seen: ReadonlySet<string>): boolean => {
    if (!cursor || forbidden.has(cursor) || seen.has(cursor)) return false;
    if (cursor === 'known-issues') return true;
    const edge = edges.find((candidate) => candidate.from === cursor);
    if (!edge) return false;
    const visited = new Set(seen).add(cursor);
    if (edge.branches) {
      if (Object.values(edge.branches).flat().some((nodeId) => forbidden.has(nodeId))) return false;
      return reaches(edge.join, visited);
    }
    // This release switch has two valid success exits, neither named "ok".
    // An owner waiver may continue only if both exits reach known-issues before publication.
    if (cursor === 'gate-cutover-switch') {
      return !!edge.map?.legacy && !!edge.map?.audit
        && reaches(edge.map.legacy, visited) && reaches(edge.map.audit, visited);
    }
    return reaches(nextNode(edges, cursor, 'ok', 'ok'), visited);
  };
  return reaches(startAt, new Set());
}

export function fanOutGraphSource(source: string, graph: GraphTemplateSpec, branchNode: string): string {
  const document = parseYaml(source) as Record<string, unknown>;
  const terminals = graph.terminalNodes;
  const done = graph.unit ? terminals.find((terminal) => terminal === 'done')
    : terminals.find((terminal) => topLevelTerminalStatus(graph.graphId, terminal) === 'done');
  const failed = graph.unit ? terminals.find((terminal) => terminal === 'failed')
    : terminals.find((terminal) => topLevelTerminalStatus(graph.graphId, terminal) === 'failed');
  if (!done || !failed) throw new Error(`fan-out requires declared success and failure terminals: ${graph.graphId}`);
  if (document.apiVersion === 'elanous.dev/graph/v2') {
    const idMatch = /^(.*)__map_(\d+)$/.exec(branchNode);
    const originalId = idMatch?.[1];
    const sourceNodes = Array.isArray(document.nodes) ? document.nodes.filter((entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object' && !Array.isArray(entry)) : [];
    const sourceMapNode = originalId ? sourceNodes.find((entry) => entry.id === originalId && entry.map && typeof entry.map === 'object') : undefined;
    const loweredBranch = graph.nodes.find((node) => node.nodeId === branchNode);
    const loweredInput = loweredBranch?.input && typeof loweredBranch.input === 'object' && !Array.isArray(loweredBranch.input)
      ? loweredBranch.input as Record<string, unknown> : undefined;
    const mapItem = loweredInput?.__graphV2MapItem;
    if (!sourceMapNode || !mapItem) throw new Error(`cannot reconstruct lowered static map branch: ${branchNode}`);
    const { map: _map, ...branchSource } = sourceMapNode;
    const priorWith = branchSource.with && typeof branchSource.with === 'object' && !Array.isArray(branchSource.with)
      ? branchSource.with as Record<string, unknown> : {};
    // The selected branch binds its item from branchParentOutputs; unrelated parent nodes would be
    // revalidated without their edges in this child graph (and unit exit maps would falsely fail).
    document.nodes = [{ ...branchSource, id: branchNode, with: { ...priorWith, __graphV2MapItem: mapItem } }];
    document.entry = branchNode;
  } else {
    document.entry_node = branchNode;
    if (Array.isArray(document.nodes)) {
      document.nodes = document.nodes.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const { needs: _needs, ...node } = entry as Record<string, unknown>;
        return node;
      });
    }
  }
  const childNodeIds = new Set((Array.isArray(document.nodes) ? document.nodes : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const node = entry as Record<string, unknown>;
    const id = typeof node.id === 'string' ? node.id : node.node_id;
    return typeof id === 'string' ? [id] : [];
  }));
  const unitNodeIds = new Set(graph.nodes.filter((node) => node.kind === 'subgraph' && childNodeIds.has(node.nodeId))
    .map((node) => node.nodeId));
  const unitEdges = Array.isArray(document.edges) ? document.edges.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const from = (entry as Record<string, unknown>).from;
    return typeof from === 'string' && unitNodeIds.has(from);
  }) : [];
  // Keep unrelated unit exit contracts intact while the fan-out child executes just its selected branch.
  document.edges = [...unitEdges, { from: branchNode, on: 'outcome', map: { ok: done, fail: failed, error: failed } }];
  return stringifyYaml(document);
}
