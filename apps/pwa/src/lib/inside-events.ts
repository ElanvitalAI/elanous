import type { DaemonClient } from './daemon-client';
import { subscribeSharedEventSource } from './shared-event-source';

export interface InsideEvent {
  kind: 'node';
  graphId: string;
  runId: string;
  nodeId: string;
  phase: 'start' | 'ok' | 'fail';
  ts: string;
  seconds?: number;
}

export interface InsideNode {
  nodeId: string;
  phase: InsideEvent['phase'];
  retries: number;
}

export interface InsideRun {
  graphId: string;
  runId: string;
  startedAt: string;
  order: string[];
  nodes: Record<string, InsideNode>;
}

export interface RunsState {
  currentRunId: string | null;
  runs: Record<string, InsideRun>;
}

export const EMPTY_RUNS: RunsState = { currentRunId: null, runs: {} };

export function fromLogFrame(json: unknown): InsideEvent | null {
  let frame: unknown = json;
  if (typeof frame === 'string') {
    try { frame = JSON.parse(frame); } catch { return null; }
  }
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return null;
  const record = frame as Record<string, unknown>;
  if (record.category !== 'graph.run' || record.event !== 'node') return null;
  const data = record.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const node = data as Record<string, unknown>;
  if (!['graphId', 'runId', 'nodeId'].every((key) => typeof node[key] === 'string' && (node[key] as string).trim().length > 0)
    || (node.phase !== 'start' && node.phase !== 'ok' && node.phase !== 'fail')
    || typeof record.ts !== 'string' || !Number.isFinite(Date.parse(record.ts))
    || (node.seconds !== undefined && (typeof node.seconds !== 'number' || !Number.isFinite(node.seconds) || node.seconds < 0))) return null;
  return {
    kind: 'node', graphId: node.graphId as string, runId: node.runId as string,
    nodeId: node.nodeId as string, phase: node.phase, ts: record.ts,
    ...(node.seconds === undefined ? {} : { seconds: node.seconds as number }),
  };
}

export function reduceRuns(state: RunsState, ev: InsideEvent): RunsState {
  const previous = Object.hasOwn(state.runs, ev.runId) ? state.runs[ev.runId] : undefined;
  const oldNode = previous && Object.hasOwn(previous.nodes, ev.nodeId) ? previous.nodes[ev.nodeId] : undefined;
  const node: InsideNode = {
    nodeId: ev.nodeId,
    phase: ev.phase,
    retries: (oldNode?.retries ?? 0) + (ev.phase === 'start' && oldNode ? 1 : 0),
  };
  const run: InsideRun = {
    graphId: ev.graphId, runId: ev.runId,
    startedAt: previous?.startedAt ?? ev.ts,
    order: oldNode ? previous!.order : [...(previous?.order ?? []), ev.nodeId],
    nodes: { ...previous?.nodes, [ev.nodeId]: node },
  };
  // Only a run we have not seen becomes «now»; late events of an older run update it in place.
  const currentRunId = previous ? (state.currentRunId ?? ev.runId) : ev.runId;
  return { currentRunId, runs: { ...state.runs, [ev.runId]: run } };
}

/** The only boundary between log-fabric frames and the inside scene.
 *  Goes through the shared SSE module (one connection per URL · native reconnect),
 *  as the PWA's connection budget requires. */
export function subscribeInsideEvents(client: Pick<DaemonClient, 'logsStreamUrl'>, onEvent: (ev: InsideEvent) => void): () => void {
  const url = client.logsStreamUrl({ category: 'graph.run' });
  if (!url) return () => {};
  return subscribeSharedEventSource(url, {
    events: {
      log: (message) => {
        const event = fromLogFrame(message.data);
        if (event) onEvent(event);
      },
    },
  });
}
