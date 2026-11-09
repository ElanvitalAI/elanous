import type { DaemonClient } from './daemon-client';
import { parseSseBlock } from './daemon-client';
import { subscribeSharedEventSource } from './shared-event-source';
import { parseDecision, type PtyDecision } from '../components/inside/pty-decisions';

export function subscribePtyDecisions(client: Pick<DaemonClient, 'logsStreamUrl'>, onEvent: (event: PtyDecision) => void): () => void {
  const url = client.logsStreamUrl({ exactCategory: 'pty.decision' });
  if (!url) return () => {};
  return subscribeSharedEventSource(url, { events: { log: message => {
    let frame: unknown;
    try { frame = JSON.parse(message.data); } catch { return; }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    const record = frame as Record<string, unknown>;
    if (record.category !== 'pty.decision') return;
    const event = parseDecision(record.data);
    if (event && record.event === event.step) onEvent(event);
  } } });
}

export interface WizardStepEvent {
  ts: string;
  wizardId: string;
  step: 'request' | 'research' | 'draft' | 'validate' | 'install' | 'done';
  text: string;
  detail?: unknown;
}

export function fromWizardLogFrame(json: unknown): WizardStepEvent | null {
  let frame: unknown = json;
  if (typeof frame === 'string') {
    try { frame = JSON.parse(frame); } catch { return null; }
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const record = frame as Record<string, unknown>;
  if (record.category !== 'wizard.step' || record.event !== 'wizard.step' || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return null;
  const data = record.data as Record<string, unknown>;
  if (typeof data.ts !== 'string' || !Number.isFinite(Date.parse(data.ts)) || typeof data.wizardId !== 'string' || !data.wizardId ||
    !['request', 'research', 'draft', 'validate', 'install', 'done'].includes(data.step as string) || typeof data.text !== 'string') return null;
  return { ts: data.ts, wizardId: data.wizardId, step: data.step as WizardStepEvent['step'], text: data.text, ...(data.detail === undefined ? {} : { detail: data.detail }) };
}

export function subscribeWizardSteps(client: Pick<DaemonClient, 'logsStreamUrl'>, onEvent: (event: WizardStepEvent) => void): () => void {
  const url = client.logsStreamUrl({ exactCategory: 'wizard.step' });
  if (!url) return () => {};
  return subscribeSharedEventSource(url, { events: { log: message => {
    const event = fromWizardLogFrame(message.data);
    if (event) onEvent(event);
  } } });
}

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

export interface ReleaseGateProgressEvent {
  graphId: 'release-loop'; runId: string; at?: string; eventId?: string;
  phase: string; shard?: string; state?: string; decision?: 'reuse' | 'rerun'; reason?: string;
  shardIndex?: number; shardTotal?: number; reuseCount?: number; rerunCount?: number;
  radiusInvalidatedCount?: number; failureCount?: number;
  rerunReasons?: Record<string, number>;
}

export function fromReleaseGateProgress(value: unknown): ReleaseGateProgressEvent | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const data = frame.data && typeof frame.data === 'object' && !Array.isArray(frame.data)
    ? frame.data as Record<string, unknown> : frame;
  if (frame.kind !== 'release.gate.progress' || frame.graphId !== 'release-loop' || typeof frame.runId !== 'string' || !frame.runId
    || typeof data.phase !== 'string' || !data.phase) return null;
  const numericKeys = ['shardIndex', 'shardTotal', 'reuseCount', 'rerunCount', 'radiusInvalidatedCount', 'failureCount'] as const;
  const numbers = Object.fromEntries(numericKeys.flatMap((key) => typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0
    ? [[key, data[key]]] : []));
  const rerunReasons = data.rerunReasons && typeof data.rerunReasons === 'object' && !Array.isArray(data.rerunReasons)
    ? Object.fromEntries(Object.entries(data.rerunReasons as Record<string, unknown>)
      .filter(([reason, count]) => reason.length <= 160 && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) as Record<string, number> : undefined;
  return {
    graphId: 'release-loop', runId: frame.runId,
    ...(typeof data.at === 'string' ? { at: data.at } : typeof frame.at === 'string' ? { at: frame.at } : {}), phase: data.phase,
    ...(typeof data.eventId === 'string' ? { eventId: data.eventId } : typeof frame.eventId === 'string' ? { eventId: frame.eventId } : {}),
    ...(typeof data.shard === 'string' ? { shard: data.shard } : {}),
    ...(typeof data.state === 'string' ? { state: data.state } : {}),
    ...(data.decision === 'reuse' || data.decision === 'rerun' ? { decision: data.decision } : {}),
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}), ...numbers,
    ...(rerunReasons && Object.keys(rerunReasons).length ? { rerunReasons } : {}),
  };
}

/** Authenticated, run-scoped stream. Operator events use fetch because EventSource cannot send the daemon bearer. */
export function subscribeReleaseGateProgress(
  client: Pick<DaemonClient, 'fetchResponse'>, runId: string,
  onEvent: (event: ReleaseGateProgressEvent) => void, onForbidden?: () => void,
): () => void {
  const controller = new AbortController();
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const connect = async (): Promise<void> => {
    try {
      const response = await client.fetchResponse(`/v1/ops/release/runs/${encodeURIComponent(runId)}/events`, {
        method: 'GET', headers: { accept: 'text/event-stream' }, signal: controller.signal,
      });
      if (response.status === 403) { onForbidden?.(); return; }
      if (!response.ok || !response.body) throw new Error(`release progress stream ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = parseSseBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (frame?.event === 'release.gate.progress') {
            const event = fromReleaseGateProgress(frame.data);
            if (event?.runId === runId) onEvent(event);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      if (disposed || controller.signal.aborted) return;
    }
    if (!disposed && !controller.signal.aborted) retryTimer = setTimeout(() => { void connect(); }, 1_500);
  };
  void connect();
  return () => {
    disposed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    controller.abort();
  };
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
