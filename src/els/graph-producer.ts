// ELS-GRAPH-LIVE-VIEW — the graph runner's node lifecycle and node-progress become els child requests: one graph run is
// one `graph` child, each node visit is a `graph-node` line inside it (the chain, in start order), node-progress is
// that line's note, and the run's end closes it. The els child tree then shows the chain with ● ◐ ✕ from the last
// event (child-tabs.ts owns the liveness marks; this module never computes them).
// Only structured fields are read (phase, outcome, visit, round, result counts, target). Fail-soft: no els server,
// a refused request or a throw never reaches the run. Requests go out in event order, one after another.
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';
import type { GraphNodeLifecycleEvent } from '../graph-runner/runner-types.js';
import type { GraphNodeProgressNotice, GraphRunIdleWake } from '../graph-runner/runner.js';
import type { GraphNodeProgressData } from '../graph-runner/node-progress.js';

export interface ElsGraphProducerSources {
  readonly onLifecycle: (listener: (event: GraphNodeLifecycleEvent) => void) => () => void;
  readonly onProgress: (listener: (notice: GraphNodeProgressNotice) => void) => () => void;
  readonly onRunEnd: (listener: (wake: GraphRunIdleWake) => void) => () => void;
}

export interface ElsGraphProducerOpts {
  readonly ws: string;
  readonly socketPath: string;
  readonly cwd?: string;
  readonly sources: ElsGraphProducerSources;
  readonly request: (socketPath: string, request: ElsRequest) => Promise<ElsResult>;
}

/** The note a node line carries, from node-progress fields only: «r6 · repair · fail 1 · pass 3 · <target>». */
export function graphProgressLine(progress: GraphNodeProgressData): string {
  return [
    progress.round === undefined ? '' : `r${progress.round}`,
    progress.phase,
    progress.result ? `fail ${progress.result.fail} · pass ${progress.result.pass}` : '',
    progress.target ?? '',
    progress.note ?? '',
  ].filter(Boolean).join(' · ');
}

const runChild = (runId: string): string => `graph:${runId}`;
const nodeChild = (runId: string, nodeId: string, visit: number): string => `graph:${runId}:${nodeId}#${visit}`;

export function wireElsGraphProducer(opts: ElsGraphProducerOpts): { dispose(): void; idle(): Promise<void> } {
  let chain: Promise<unknown> = Promise.resolve();
  const post = (request: ElsRequest): void => {
    chain = chain.then(() => opts.request(opts.socketPath, request)).catch(() => { /* no els server: nothing to show */ });
  };
  const runs = new Set<string>(); // runs this process opened a child for
  const blocked = new Set<string>(); // runs parked for approval (a node start in this process wakes them)
  const openNode = new Map<string, string>(); // `${runId}\0${nodeId}` -> child id of the visit now running

  const ensureRun = (graphId: string, runId: string): void => {
    if (runs.has(runId)) return;
    runs.add(runId);
    post({ op: 'child', action: 'start', id: runChild(runId), ws: opts.ws, source: 'graph', label: `${graphId} · ${runId.slice(0, 8)}`,
      ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  };

  const offLifecycle = opts.sources.onLifecycle((event) => {
    if (event.dryRun) return;
    const key = `${event.runId}\0${event.nodeId}`;
    if (event.phase === 'start') {
      ensureRun(event.graphId, event.runId);
      if (blocked.delete(event.runId)) post({ op: 'child', action: 'status', id: runChild(event.runId), state: 'working' });
      const id = nodeChild(event.runId, event.nodeId, event.visit);
      openNode.set(key, id);
      post({ op: 'child', action: 'start', id, ws: opts.ws, source: 'graph-node', parent: runChild(event.runId), label: event.nodeId });
      return;
    }
    if (event.phase === 'end') {
      const id = openNode.get(key);
      if (!id) return;
      openNode.delete(key);
      const ok = event.outcome !== 'fail';
      post({ op: 'child', action: 'end', id, ok, summary: event.outcome ?? (ok ? 'ok' : 'fail') });
    }
  });

  const offProgress = opts.sources.onProgress((notice) => {
    if (notice.dryRun) return;
    const id = openNode.get(`${notice.runId}\0${notice.nodeId}`);
    if (!id) return;
    post({ op: 'child', action: 'progress', id, line: graphProgressLine(notice.progress) });
  });

  const offRunEnd = opts.sources.onRunEnd((wake) => {
    if (wake.dryRun || !runs.has(wake.runId)) return;
    if (wake.status === 'awaiting-approval') {
      blocked.add(wake.runId);
      post({ op: 'child', action: 'status', id: runChild(wake.runId), state: 'blocked', line: wake.nodeId ? `승인 대기 · ${wake.nodeId}` : '승인 대기' });
      return;
    }
    runs.delete(wake.runId);
    blocked.delete(wake.runId);
    for (const key of [...openNode.keys()]) if (key.startsWith(`${wake.runId}\0`)) openNode.delete(key);
    post({ op: 'child', action: 'end', id: runChild(wake.runId), ok: wake.status === 'done', summary: wake.status });
  });

  return {
    dispose: () => { offLifecycle(); offProgress(); offRunEnd(); },
    idle: async () => { let seen: Promise<unknown> | undefined; while (seen !== chain) { seen = chain; await chain; } },
  };
}
