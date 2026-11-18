// GRAPH-VIEW-TRIGGER: the graph runner's progress observations (GraphProgressObservation — node started, completed,
// failed, retrying) projected into graph-view events, so the Next TUI can draw the inline block (개정 4) from the
// same contract the footer line already uses. Stages are the nodes seen so far; a per-graph adapter (app_build,
// release, harness children) that knows the whole stage list replaces this projection when it lands.
import type { GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import type { GraphViewEvent, GraphViewStageStatus } from './model.js';

export interface RunnerProgressProjector {
  /** Accept one runner observation; returns the graph-view events it produced (empty when ignored). */
  observe(event: GraphProgressObservation): GraphViewEvent[];
  /** End every loop still open: done when every seen node completed, failed when a node failed last, else cancelled. */
  settle(atMs: number): GraphViewEvent[];
  readonly events: readonly GraphViewEvent[];
}

const STATUS: Record<GraphProgressObservation['kind'], GraphViewStageStatus> = {
  started: 'running', retrying: 'running', completed: 'done', failed: 'failed',
};

export function createRunnerProgressProjector(): RunnerProgressProjector {
  const events: GraphViewEvent[] = [];
  const loops = new Map<string, { ended: boolean; nodes: Map<string, GraphViewStageStatus> }>();
  const push = (next: GraphViewEvent[]) => { events.push(...next); return next; };
  return {
    events,
    observe(event) {
      const at = Date.parse(event.at);
      const loopId = `${event.graphId}:${event.runId}`;
      let loop = loops.get(loopId);
      const out: GraphViewEvent[] = [];
      if (!loop) {
        loop = { ended: false, nodes: new Map() };
        loops.set(loopId, loop);
        out.push({ type: 'loop.started', loopId, at, kind: event.graphId, lead: 'graph-runner',
          title: event.dryRun ? `${event.runId.slice(0, 8)} · dry run` : event.runId.slice(0, 8) });
      }
      if (loop.ended) return push(out);
      const status = STATUS[event.kind];
      loop.nodes.set(event.nodeId, status);
      out.push({ type: 'stage.changed', loopId, at, stage: event.nodeId, status });
      // A retried node reads as a retried lane: the same worker going failed → running counts one retry.
      if (event.kind === 'retrying' || event.kind === 'failed' || event.attempt > 1)
        out.push({ type: 'worker.changed', loopId, at, worker: event.nodeId, stage: event.nodeId, status });
      return push(out);
    },
    settle(atMs) {
      const out: GraphViewEvent[] = [];
      for (const [loopId, loop] of loops) {
        if (loop.ended) continue;
        loop.ended = true;
        const states = [...loop.nodes.values()];
        const status = states.includes('failed') ? 'failed' : states.every((state) => state === 'done') ? 'done' : 'cancelled';
        out.push({ type: 'loop.ended', loopId, at: atMs, status });
      }
      return push(out);
    },
  };
}
