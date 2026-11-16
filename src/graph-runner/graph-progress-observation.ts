import type { GraphNodeLifecycleEvent } from './runner-types.js';

/** The runner is the only producer. Both the supervisor and display consume this projection. */
export interface GraphProgressObservation {
  readonly version: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly at: string;
  readonly dryRun: boolean;
  readonly kind: 'started' | 'completed' | 'failed' | 'retrying';
}

export interface GraphSupervisorObservationInput {
  readonly graphId: string;
  readonly runId: string;
  readonly lastSequence: number;
  readonly events: readonly GraphProgressObservation[];
  readonly truncated: boolean;
  /** A lifecycle sequence skipped a number; other declared graph events may occupy it. */
  readonly sequenceGapObserved: boolean;
  readonly outOfOrderIgnored: boolean;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const UTC_MILLISECOND = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const safeId = (value: unknown, max: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value) <= max && ID.test(value);
const canonicalAt = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length !== 24 || !UTC_MILLISECOND.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

function validRunnerLifecycle(event: GraphNodeLifecycleEvent): boolean {
  return event?.kind === 'node.lifecycle' && event.source === 'graph-runner'
    && (event.phase === 'arrival' || event.phase === 'start' || event.phase === 'end' || event.phase === 'leave')
    && (event.phase !== 'end' || event.outcome === 'ok' || event.outcome === 'fail')
    && safeId(event.eventId, 256) && safeId(event.graphId, 120)
    && safeId(event.runId, 120) && safeId(event.nodeId, 160)
    && Number.isSafeInteger(event.seq) && event.seq > 0
    && event.eventId === `${event.graphId}:${event.runId}:${event.seq}`
    && Number.isSafeInteger(event.attempt) && event.attempt > 0
    && canonicalAt(event.at) && typeof event.dryRun === 'boolean';
}

/** Raw reason, node output, credentials and model text never enter this contract. */
export function graphProgressObservation(event: GraphNodeLifecycleEvent): GraphProgressObservation | null {
  if (!validRunnerLifecycle(event)) return null;
  const kind = event.phase === 'start' ? 'started'
    : event.phase === 'end' ? event.outcome === 'ok' ? 'completed'
      : event.outcome === 'fail' ? 'failed' : null : null;
  if (!kind) return null;
  return { version: 1, eventId: event.eventId, sequence: event.seq,
    graphId: event.graphId, runId: event.runId, nodeId: event.nodeId,
    attempt: event.attempt, at: event.at, dryRun: event.dryRun, kind };
}

export function isGraphProgressObservation(value: unknown): value is GraphProgressObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!Object.keys(row).every(key => ['version', 'eventId', 'sequence', 'graphId', 'runId',
    'nodeId', 'attempt', 'at', 'dryRun', 'kind'].includes(key))) return false;
  return row.version === 1 && safeId(row.eventId, 256) && safeId(row.graphId, 120)
    && safeId(row.runId, 120) && safeId(row.nodeId, 160)
    && Number.isSafeInteger(row.sequence) && Number(row.sequence) > 0
    && row.eventId === `${row.graphId}:${row.runId}:${row.sequence}`
    && Number.isSafeInteger(row.attempt) && Number(row.attempt) > 0
    && canonicalAt(row.at)
    && typeof row.dryRun === 'boolean'
    && (row.kind === 'started' || row.kind === 'completed' || row.kind === 'failed' || row.kind === 'retrying');
}

/** Expected identity comes from the verified runGraph caller, never from an event or model. */
export function createGraphProgressCollector(expected: { readonly graphId: string; readonly runId: string },
  onProgress?: (event: GraphProgressObservation) => void, maxEvents = 64) {
  if (!safeId(expected.graphId, 120) || !safeId(expected.runId, 120))
    throw new Error('graph progress requires trusted graph/run identity');
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 128)
    throw new Error('graph progress maxEvents must be within 1..128');
  let lastSequence = 0;
  let lastRawSequence = 0;
  let truncated = false;
  let sequenceGapObserved = false;
  let outOfOrderIgnored = false;
  const events: GraphProgressObservation[] = [];
  const failedNodes = new Set<string>();
  return {
    observe(raw: GraphNodeLifecycleEvent): GraphProgressObservation | null {
      if (!validRunnerLifecycle(raw) || raw.graphId !== expected.graphId || raw.runId !== expected.runId) return null;
      if (raw.seq <= lastRawSequence) { outOfOrderIgnored = true; return null; }
      if (raw.seq > lastRawSequence + 1) sequenceGapObserved = true;
      lastRawSequence = raw.seq;
      const projected = graphProgressObservation(raw);
      if (!projected) return null;
      // A failed node resumed with fromNodeId can carry runner visit=1 again.
      // A successful loop revisit is a start, even when its visit number grows.
      const event: GraphProgressObservation = projected.kind === 'started' && failedNodes.has(projected.nodeId)
        ? { ...projected, kind: 'retrying' } : projected;
      if (projected.kind === 'failed') {
        failedNodes.delete(projected.nodeId);
        failedNodes.add(projected.nodeId);
        if (failedNodes.size > 128) failedNodes.delete(failedNodes.values().next().value!);
      } else if (projected.kind === 'started' || projected.kind === 'completed') {
        failedNodes.delete(projected.nodeId);
      }
      lastSequence = event.sequence;
      events.push(event);
      if (events.length > maxEvents) { events.shift(); truncated = true; }
      try { onProgress?.(event); } catch { /* display cannot change runner outcome */ }
      return event;
    },
    snapshot(): GraphSupervisorObservationInput {
      return { graphId: expected.graphId, runId: expected.runId, lastSequence,
        events: [...events], truncated, sequenceGapObserved, outOfOrderIgnored };
    },
  };
}

export function graphProgressStatus(event: GraphProgressObservation): string {
  const verb = event.kind === 'started' ? '시작' : event.kind === 'completed' ? '완료'
    : event.kind === 'failed' ? '실패' : '재시도';
  const attempt = event.kind === 'retrying' ? '' : ` (${event.attempt}회)`;
  return `그래프 ${event.graphId}/${event.runId.slice(0, 8)} · ${event.nodeId} ${verb}${attempt}${event.dryRun ? ' · 시험' : ''}`;
}
