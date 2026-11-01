/** GRAPH-VIEW-WIRING-UX ⑥ — four header cells for one live-run graph.
 *  Counts and elapsed time come only from the graph and the traversal ledger.
 *  A missing source (no cost field on HarnessRunTraversal) stays «미계측», never a painted 0. */

import type { HarnessRunTraversal } from '@/nexus/client';
import { durationLabel } from '@/lib/live-run-scene';

export const UNMEASURED = '미계측';

export interface LiveRunMetricCells {
  nodeCount: number;
  edgeCount: number;
  elapsed: string;
  cost: string;
}

export interface LiveRunMetricGraph {
  nodes: readonly { node_id: string }[];
  edges: readonly unknown[];
}

/** Optional cost source. The production ledger type has no cost field; a future source may pass one. */
export type LiveRunCostSource = { cost?: number | null };

function finiteCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Wall span from the ledger. Prefer startedAt→endedAt; a running run uses the last observed step time;
 *  otherwise the sum of step durationMs. No usable source → null (caller shows «미계측»). */
export function elapsedMs(run: Pick<HarnessRunTraversal, 'startedAt' | 'endedAt' | 'steps' | 'status'>): number | null {
  const start = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const end = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  const lastAt = run.steps.map((step) => Date.parse(step.at)).filter((time) => Number.isFinite(time)).at(-1);
  if (Number.isFinite(start) && lastAt !== undefined && lastAt >= start) return lastAt - start;
  const durations = run.steps.map((step) => step.durationMs).filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0);
  if (durations.length > 0 && durations.length === run.steps.length) return durations.reduce((sum, ms) => sum + ms, 0);
  return null;
}

export function liveRunMetricCells(
  run: Pick<HarnessRunTraversal, 'startedAt' | 'endedAt' | 'steps' | 'status'> & LiveRunCostSource,
  graph: LiveRunMetricGraph | null,
): LiveRunMetricCells {
  const nodeCount = graph ? new Set(graph.nodes.map((node) => node.node_id)).size : new Set(run.steps.map((step) => step.node)).size;
  const edgeCount = graph ? graph.edges.length : Math.max(0, new Set(run.steps.map((step) => step.node)).size > 0 ? run.steps.length - 1 : 0);
  const elapsed = elapsedMs(run);
  const cost = finiteCost(run.cost);
  return {
    nodeCount,
    edgeCount,
    elapsed: elapsed === null ? UNMEASURED : durationLabel(elapsed),
    cost: cost === null ? UNMEASURED : String(cost),
  };
}
