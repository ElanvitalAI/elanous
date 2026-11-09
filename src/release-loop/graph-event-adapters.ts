import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import type { GraphEvent, GraphEventBus, GraphEventScope } from '../graph-runner/graph-events.js';
import { debug } from '../debug/log.js';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { openMsgStore, type MsgStore } from '../msg/msg-store.js';
import { listCoordEvents } from '../context-bus/coord-events.js';
import { releaseRunContextSummary } from '../context-bus/context-now.js';
import { recordExternalEvent, type ExternalEventInput } from '../context-bus/external-events.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { appendReleaseStageMail, emitReleaseStageTransition, type ReleaseStageMailInput, type ReleaseStageState } from './stage-mail.js';

// OP RELEASE-RUN-STATUS-ONE-LINE: send the live run summary once per five-minute interval (minutes × ms/minute).
export const RELEASE_RUN_OP_SUMMARY_INTERVAL_MS = 5 * 60_000;

export interface ReleaseGraphEventAdapterDeps {
  readonly root: string;
  readonly openStore?: () => MsgStore;
  readonly contextEvent?: (input: ExternalEventInput) => string;
  readonly stageMail?: (input: ReleaseStageMailInput) => unknown;
  readonly ledgerRoot?: string;
  readonly releaseSummary?: () => string | undefined;
  readonly summaryIntervalMs?: number;
  readonly startSummaryTimer?: (tick: () => void, intervalMs: number) => () => void;
  readonly now?: () => number;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

const STAGE_STATES = new Set<ReleaseStageState>(['start', 'ok', 'fail', 'skip', 'wait', 'stall']);

function isScoped(event: GraphEvent, scope: GraphEventScope): boolean {
  return event.graphId === scope.graphId && event.runId === scope.runId &&
    scope.dryRun !== true && event.data?.dryRun !== true;
}

function eventSummary(event: GraphEvent): string {
  return `release graph ${event.type} · run=${event.runId} · node=${event.source.nodeId ?? '-'}${
    typeof event.data?.state === 'string' ? ` · state=${event.data.state}` : ''}`;
}

function oneLine(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function opInboxBody(event: GraphEvent): string | undefined {
  const nodeId = event.source.nodeId ?? '-';
  const repair = nodeId.startsWith('gate-repair-');
  if (event.type === 'node-start')
    return `✅ RLA ${repair ? 'repair ' : ''}started · run=${event.runId} · node=${nodeId} · event=${event.eventId}`;
  if (event.type === 'node-end') {
    const failed = event.data?.outcome === 'fail' || event.data?.ok === false;
    const outcome = failed ? 'failed' : 'completed';
    const marker = failed ? '🚨' : '✅';
    const reason = typeof event.data?.reason === 'string' ? ` · reason=${oneLine(event.data.reason)}` : '';
    return `${marker} RLA ${repair ? 'repair ' : ''}${outcome} · run=${event.runId} · node=${nodeId}${reason} · event=${event.eventId}`;
  }
  if (event.type === 'release.gate.failed') {
    const gate = event.data?.gate;
    const failures = gate && typeof gate === 'object' && 'introduced' in gate && Array.isArray(gate.introduced)
      ? gate.introduced.length : undefined;
    return `🚨 RLA gate failure attributed · run=${event.runId} · node=${nodeId}${failures === undefined ? '' : ` · failures=${failures}`} · event=${event.eventId}`;
  }
  return undefined;
}

function deliveryEventId(event: GraphEvent): string {
  return `${event.graphId}:${event.eventId}`;
}

/** Connects the graph bus to OP's durable inbox, context-bus journal, and TC's stage mail. */
export function registerReleaseGraphEventAdapters(
  bus: GraphEventBus,
  scope: GraphEventScope,
  deps: ReleaseGraphEventAdapterDeps,
): () => void {
  const log = deps.log ?? ((event: string, data: Record<string, unknown>) =>
    debug.log('release-loop.event-adapter', event, data, { level: 'warn' }));
  const openStore = deps.openStore ?? (() => openMsgStore(join(deps.root, 'msg', 'messages.db')));
  let store: MsgStore | undefined;
  const getStore = () => store ??= openStore();
  let contextDb: ReturnType<typeof openSurfaceEventsDb> | undefined;
  const contextEvent = deps.contextEvent ?? ((input: ExternalEventInput) => {
    const stateScoped = !!process.env.ELANOUS_STATE_DIR?.trim();
    const dbPath = join(deps.root, ...(stateScoped ? [] : ['memory']), 'surface_events.db');
    contextDb ??= openSurfaceEventsDb(dbPath);
    return recordExternalEvent(input, { db: contextDb });
  });
  const stageMail = deps.stageMail ?? ((input: ReleaseStageMailInput) => appendReleaseStageMail(getStore(), input, {
    configPath: join(deps.root, 'config.json'),
  }));
  const summaryIntervalMs = Number.isSafeInteger(deps.summaryIntervalMs) && (deps.summaryIntervalMs ?? 0) > 0
    ? deps.summaryIntervalMs! : RELEASE_RUN_OP_SUMMARY_INTERVAL_MS;
  let lastSummarySlot: number | undefined;
  const releaseSummary = deps.releaseSummary ?? (() => releaseRunContextSummary(scope.runId, {
    stateRoot: deps.root,
    ledgerRoot: deps.ledgerRoot ?? releaseLedgerRoot(),
    events: contextDb ? listCoordEvents({ since: '2000-01-01T00:00:00.000Z', seat: 'release-graph' }, { db: contextDb }) : [],
  }));
  const publishReleaseSummary = () => {
    const slot = Math.floor((deps.now?.() ?? Date.now()) / summaryIntervalMs);
    if (slot === lastSummarySlot) return;
    try {
      const observedSummary = releaseSummary();
      const summary = observedSummary ?? `run=${scope.runId} · 발행 상태 관측 불가`;
      getStore().appendWithProvenance({ from: 'RLA', to: 'OP', kind: 'progress',
        body: `RLA 5-minute release summary · run=${scope.runId} · ${summary}` },
      `release-event:${scope.runId}_${slot}:OP`);
      lastSummarySlot = slot;
      try { log('summary-delivered', { runId: scope.runId, intervalMs: summaryIntervalMs, slot, measured: observedSummary !== undefined }); }
      catch { /* diagnostics must not change durable mailbox delivery */ }
    } catch (error) {
      try { log('summary-delivery-failed', { runId: scope.runId, intervalMs: summaryIntervalMs,
        reason: error instanceof Error ? error.message : String(error) }); } catch { /* status delivery must not change graph execution */ }
    }
  };
  const stopSummaryTimer = scope.graphId === 'release-loop' && scope.dryRun !== true
    ? (deps.startSummaryTimer ?? ((tick, intervalMs) => {
        const timer = setInterval(tick, intervalMs);
        timer.unref?.();
        return () => clearInterval(timer);
      }))(publishReleaseSummary, summaryIntervalMs)
    : () => undefined;
  const deliveryErrors = (subscriberId: string, event: GraphEvent, error: unknown) => {
    try { log('delivery-failed', { subscriberId, eventId: event.eventId, type: event.type,
      reason: error instanceof Error ? error.message : String(error) }); } catch { /* subscriber errors are fail-open */ }
  };
  const disposers = [
    bus.subscribe((event) => {
      if (!isScoped(event, scope)) return;
      const body = opInboxBody(event);
      if (!body) return;
      const subscriberId = 'op-inbox';
      const provenance = `coord:${Buffer.from(deliveryEventId(event)).toString('base64url')}:OP`;
      try {
        getStore().appendWithProvenance({ from: 'RLA', to: 'OP', kind: 'progress', body }, provenance);
      } catch (error) { deliveryErrors(subscriberId, event, error); throw error; }
    }),
    bus.subscribe((event) => {
      if (!isScoped(event, scope)) return;
      const subscriberId = 'context-bus';
      const eventId = deliveryEventId(event);
      const source = `elanous://graph-event/${encodeURIComponent(eventId)}/${subscriberId}`;
      const kind: ExternalEventInput['kind'] = event.type === 'node-start' ? 'started'
        : event.type === 'node-end' ? 'finished' : 'exit';
      try { contextEvent({ origin: 'release-graph', kind, summary: eventSummary(event), source,
        delivery: { eventId, subscriberId }, at: event.emittedAt }); }
      catch (error) { deliveryErrors(subscriberId, event, error); throw error; }
    }),
    bus.subscribe((event) => {
      if (!isScoped(event, scope) || event.type !== 'release-stage') return;
      const nodeId = event.source.nodeId;
      const state = event.data?.state;
      if (!nodeId || typeof state !== 'string' || !STAGE_STATES.has(state as ReleaseStageState)) {
        deliveryErrors('tc-stage-mail', event, new Error('release-stage event is missing a valid nodeId/state'));
        return;
      }
      if (!emitReleaseStageTransition(scope.graphId, false, { runId: scope.runId, nodeId,
        state: state as ReleaseStageState }, stageMail, deliveryEventId(event))) {
        const error = new Error('stage mail delivery was refused');
        deliveryErrors('tc-stage-mail', event, error);
        throw error;
      }
    }),
  ];
  return () => {
    try { stopSummaryTimer(); } catch { /* timer cleanup cannot change graph execution */ }
    for (const dispose of disposers) dispose();
    try { store?.close(); } catch { /* close failure cannot change graph execution */ }
    try { contextDb?.close(); } catch { /* close failure cannot change graph execution */ }
  };
}
