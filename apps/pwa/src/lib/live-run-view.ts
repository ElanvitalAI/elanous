// HARNESS-RUN-LIVE-GRAPH — small view helpers for the /live-run page (kept pure for tests).
import type { HarnessFinishedRunWire, HarnessRunEntry, RunGraphDetail } from '../nexus/client';
import type { TraversalStep } from './live-run-scene';

/** When the graph definition is unavailable, draw the path the run actually walked (nodes it visited, edges it took)
 *  rather than inventing a graph. */
export function graphFromSteps(id: string, steps: readonly Pick<TraversalStep, 'node' | 'outcome'>[]): RunGraphDetail {
  const nodeIds = [...new Set(steps.map((step) => step.node))];
  const maps = new Map<string, Record<string, string>>();
  for (let index = 1; index < steps.length; index += 1) {
    const prev = steps[index - 1]!;
    const map = maps.get(prev.node) ?? {};
    const outcome = prev.outcome ?? 'pass';
    if (!Object.values(map).includes(steps[index]!.node)) map[map[outcome] ? `${outcome}·${steps[index]!.node}` : outcome] = steps[index]!.node;
    maps.set(prev.node, map);
  }
  return {
    id, source: 'core', editable: false,
    entry_node: nodeIds[0] ?? '',
    terminal_nodes: steps.length ? [steps.at(-1)!.node] : [],
    nodes: nodeIds.map((node) => ({ node_id: node, kind: 'agent', recipe: '원장에서 본 노드', max_visits: steps.filter((step) => step.node === node).length })),
    edges: [...maps.entries()].map(([from, map]) => ({ from, on: 'outcome', map })),
  };
}

/** The declared graph ⊕ any node/edge the run walked that the declaration lacks (never drops declared nodes, so
 *  unvisited ones still show as «기록 없음»). */
export function mergeWalked(graph: RunGraphDetail, steps: readonly Pick<TraversalStep, 'node' | 'outcome'>[]): RunGraphDetail {
  const known = new Set(graph.nodes.map((node) => node.node_id));
  const extraNodes = [...new Set(steps.map((step) => step.node))].filter((node) => !known.has(node));
  const targets = (from: string) => graph.edges.filter((edge) => edge.from === from)
    .flatMap((edge) => edge.map ? Object.values(edge.map) : edge.to ? [edge.to] : []);
  const extraEdges: RunGraphDetail['edges'] = [];
  for (let index = 1; index < steps.length; index += 1) {
    const from = steps[index - 1]!.node; const to = steps[index]!.node;
    if (targets(from).includes(to) || extraEdges.some((edge) => edge.from === from && edge.to === to)) continue;
    extraEdges.push({ from, to });
  }
  if (extraNodes.length === 0 && extraEdges.length === 0) return graph;
  return {
    ...graph,
    nodes: [...graph.nodes, ...extraNodes.map((node) => ({ node_id: node, kind: 'agent', recipe: '원장에서 본 노드(선언 밖)', max_visits: steps.filter((step) => step.node === node).length }))],
    edges: [...graph.edges, ...extraEdges],
  };
}

/** Same rule as the daemon's `displayTitle`: first line, path-like tokens shrunk to their basename, ≤ max chars. */
export function displayTitle(text: string | undefined, max = 60): string {
  const line = text?.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  const shrunk = line.replace(/\s*\[truncated[^\]]*\]\s*$/, '').replace(/(?:~|\.{0,2})?\/?(?:[\w.@-]+\/)+([\w.@-]+)/g, '$1');
  return shrunk.length > max ? `${shrunk.slice(0, max - 1)}…` : shrunk;
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case 'running': return '● 도는 중';
    case 'completed': return '완료';
    case 'failed': return '실패';
    case 'abandoned': return '버려짐';
    case 'cancelled': return '취소됨';
    default: return status;
  }
}

export interface LiveRunPick {
  runId: string;
  label: string;
  live: boolean;
  at: string | null;
}

/** Picker rows: running runs first (newest activity first), then finished runs (newest end first). Titles are the
 *  first goal line only, cut to 60 chars. */
export function liveRunPicks(entries: ReadonlyArray<HarnessRunEntry & { objective?: string }>, finished: readonly HarnessFinishedRunWire[]): LiveRunPick[] {
  const line = (text: string | undefined) => displayTitle(text);
  const running = [...entries]
    .sort((a, b) => Date.parse(b.lastActivityTimestamp ?? '') - Date.parse(a.lastActivityTimestamp ?? '') || 0)
    .map((entry) => ({ runId: entry.runId, label: line(entry.objective) || entry.runId, live: true, at: entry.lastActivityTimestamp ?? null }));
  const seen = new Set(running.map((pick) => pick.runId));
  const done = finished.filter((run) => !seen.has(run.runId))
    .map((run) => ({ runId: run.runId, label: line(run.objective) || run.runId, live: false, at: run.endedAt }));
  return [...running, ...done];
}
