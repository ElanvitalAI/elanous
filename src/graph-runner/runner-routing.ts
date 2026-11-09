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
  if (edge.to !== undefined) return edge.to;
  if (edge.on !== 'outcome') throw new Error(`unsupported edge condition: ${edge.on}`);
  if (namedOutcome !== undefined && edge.map && Object.hasOwn(edge.map, namedOutcome)) return edge.map[namedOutcome];
  return edge.map?.[exitOutcome] ?? edge.fallback?.[0]?.node;
}

export function releaseRouteReachesKnownIssues(edges: readonly GraphEdgeSpec[], startAt: string): boolean {
  const forbidden = new Set(['publish', 'approve-publish']);
  const seen = new Set<string>();
  let cursor: string | undefined = startAt;
  while (cursor && cursor !== 'known-issues' && !seen.has(cursor)) {
    if (forbidden.has(cursor)) return false;
    seen.add(cursor);
    const edge = edges.find((candidate) => candidate.from === cursor);
    if (!edge) return false;
    if (edge.branches) {
      if (Object.values(edge.branches).flat().some((nodeId) => forbidden.has(nodeId))) return false;
      cursor = edge.join;
    } else {
      cursor = nextNode(edges, cursor, 'ok', 'ok');
    }
  }
  return cursor === 'known-issues' && ![...seen].some((nodeId) => forbidden.has(nodeId));
}

export function fanOutGraphSource(source: string, graph: GraphTemplateSpec, branchNode: string): string {
  const document = parseYaml(source) as Record<string, unknown>;
  const terminals = graph.terminalNodes;
  const done = graph.unit ? terminals.find((terminal) => terminal === 'done')
    : terminals.find((terminal) => topLevelTerminalStatus(graph.graphId, terminal) === 'done');
  const failed = graph.unit ? terminals.find((terminal) => terminal === 'failed')
    : terminals.find((terminal) => topLevelTerminalStatus(graph.graphId, terminal) === 'failed');
  if (!done || !failed) throw new Error(`fan-out requires declared success and failure terminals: ${graph.graphId}`);
  document.entry_node = branchNode;
  if (Array.isArray(document.nodes)) {
    document.nodes = document.nodes.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const { needs: _needs, ...node } = entry as Record<string, unknown>;
      return node;
    });
  }
  document.edges = [{ from: branchNode, on: 'outcome', map: { ok: done, fail: failed, error: failed } }];
  return stringifyYaml(document);
}
