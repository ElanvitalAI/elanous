/**
 * HARNESS-RUN-LIVE-GRAPH — pure scene model for one harness run's execution graph.
 *
 * Input: the run's graph (same `RunGraphDetail` the editor draws) ⊕ the ordered traversal steps the run took.
 * Output, for a playback cursor: per-node state (pending / running / passed / failed), visit counts, which
 * edges were taken, and the edge the run is moving along right now (the token animates on it).
 *
 * Kept free of React so the replay rules are testable without a canvas.
 */

export type LiveNodeState = 'pending' | 'running' | 'passed' | 'failed';

export interface TraversalStep {
  /** Graph node id. */
  node: string;
  /** Outcome the node produced (`pass`, `fail`, `rework`, …) — null while the node is still running. */
  outcome: string | null;
  /** ISO time the node was entered. */
  at: string;
  /** Wall time the node took — null while running or when unknown. */
  durationMs: number | null;
  /** 1-based visit count of this node at this step (2 = first revisit). */
  visit: number;
  /** One short line (no secrets, no goal body). */
  detail?: string | null;
}

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  outcomes: string[];
}

export interface SceneFrame {
  nodeState: Record<string, LiveNodeState>;
  visits: Record<string, number>;
  /** Edge ids traversed at least once up to the cursor. */
  takenEdges: Set<string>;
  /** Edge the run moved along to reach the cursor step (null at the first step). */
  activeEdge: string | null;
  /** Index of the step under the cursor (−1 = nothing played yet). */
  cursor: number;
}

const FAIL_OUTCOMES = new Set(['fail', 'failed', 'error', 'blocked', 'rejected', 'aborted', 'unconvergeable', 'timeout']);

export function outcomeState(outcome: string | null): LiveNodeState {
  if (outcome === null) return 'running';
  return FAIL_OUTCOMES.has(outcome.toLowerCase()) ? 'failed' : 'passed';
}

/** The edge that carried the run from `prev` (with its outcome) to `next`. Prefers an edge whose outcome list
 *  holds the outcome, then any edge between the two nodes. */
export function edgeBetween(edges: readonly SceneEdge[], from: string, outcome: string | null, to: string): SceneEdge | null {
  const between = edges.filter((edge) => edge.from === from && edge.to === to);
  if (between.length === 0) return null;
  return between.find((edge) => outcome !== null && edge.outcomes.includes(outcome)) ?? between[0]!;
}

/** Scene after playing steps[0..cursor]. `entering` = the cursor step is shown as just entered (running, pulsing)
 *  even when its outcome is known — replay uses it so each node first glows, then settles green/red. A step whose
 *  outcome is null (live: still running) always shows running. */
export function sceneAt(
  nodeIds: readonly string[],
  edges: readonly SceneEdge[],
  steps: readonly TraversalStep[],
  cursor: number,
  entering = false,
): SceneFrame {
  const nodeState: Record<string, LiveNodeState> = Object.fromEntries(nodeIds.map((id) => [id, 'pending' as LiveNodeState]));
  const visits: Record<string, number> = {};
  const takenEdges = new Set<string>();
  let activeEdge: string | null = null;
  const last = Math.min(cursor, steps.length - 1);
  for (let index = 0; index <= last; index += 1) {
    const step = steps[index]!;
    visits[step.node] = (visits[step.node] ?? 0) + 1;
    nodeState[step.node] = index === last && entering ? 'running' : outcomeState(step.outcome);
    if (index > 0) {
      const prev = steps[index - 1]!;
      const edge = edgeBetween(edges, prev.node, prev.outcome, step.node);
      if (edge) {
        takenEdges.add(edge.id);
        if (index === last) activeEdge = edge.id;
      }
    }
  }
  return { nodeState, visits, takenEdges, activeEdge, cursor: last };
}

/** Replay pacing: real gaps are squeezed into [minMs, maxMs] at 1× so a 40-minute run plays in about a minute,
 *  then divided by speed. */
export function replayDelayMs(steps: readonly TraversalStep[], index: number, speed: number, minMs = 900, maxMs = 4000): number {
  const step = steps[index];
  const next = steps[index + 1];
  if (!step || !next) return minMs / speed;
  const gap = Date.parse(next.at) - Date.parse(step.at);
  const scaled = Number.isFinite(gap) ? Math.min(maxMs, Math.max(minMs, gap / 60)) : minMs;
  return scaled / Math.max(1, speed);
}

/** KST clock (HH:MM:SS) for the timeline. */
export function kstClock(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  return new Date(time + 9 * 3600_000).toISOString().slice(11, 19);
}

export function durationLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}
