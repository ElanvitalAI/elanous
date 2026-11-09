import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseGraphTemplateYaml, type GraphNodeSpec } from '../self-implement/graph-yaml.js';
import { createGraphEventBus, type GraphEvent, type GraphEventBus, type GraphEventInput } from '../graph-runner/graph-events.js';
import { registerGraphSubscriptions, type GraphSubscriptionDispatch } from '../graph-runner/graph-subscriptions.js';
import { debug } from '../debug/log.js';
import { openMsgStore } from '../msg/msg-store.js';
import { runMacrophageHeal, type MacrophageEvidence, type MacrophageScrap } from './macrophage-heal.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

const SUBSCRIBER_GRAPH = join(import.meta.dir, '../../graphs/release/macrophage-subscriber.yaml');
const SUBSCRIBER_NODE_ID = 'macrophage-heal';
const DECISION_EVENT = 'release.macrophage.decision';
const TRAIN_EVENTS = new Set(['merge-train.batch', 'merge-train.verdict', 'merge-train.incident']);
const PHASE_WAKE_NODES = new Set(['pre-gate-join', 'pre-prepare-join', 'release-post-publish-join', 'traffic-failed-restore']);
const FAILURE_WAKE_NODES = new Set(['export-check', 'gate', 'residual-run', 'gate-triage', 'pwa', 'notes-recheck', 'verify']);

export interface MacrophageRuntimeOptions {
  readonly runId: string;
  readonly root?: string;
  readonly graphId?: string;
  readonly eventBus?: GraphEventBus;
  readonly mode?: 'live' | 'simulation';
  readonly inventory?: (event: GraphEvent) => readonly MacrophageScrap[];
  readonly reportUnknownFailure?: (notice: { runId: string; nodeId: string; detail: string }) => void | Promise<void>;
  readonly writeReceipt?: (root: string, event: GraphEvent) => void;
  /** Applies only the two explicitly safe live cleanup kinds, after the adapter revalidates ownership. */
  readonly liveCleanup?: (scrap: MacrophageScrap) => Promise<string | undefined> | string | undefined;
  readonly now?: () => Date;
  readonly consecutiveFailureLimit?: number;
}

export interface MacrophageRuntime {
  readonly eventBus: GraphEventBus;
  readonly decisions: readonly GraphEvent[];
  dispose(): void;
}

function parseInventory(value: unknown): MacrophageScrap[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`macrophage inventory[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.kind !== 'string' || !item.evidence || typeof item.evidence !== 'object' || Array.isArray(item.evidence))
      throw new Error(`macrophage inventory[${index}] is missing id, kind, or evidence`);
    if (item.owner !== undefined && typeof item.owner !== 'string') throw new Error(`macrophage inventory[${index}].owner must be text`);
    return { id: item.id, kind: item.kind as MacrophageScrap['kind'], evidence: item.evidence as MacrophageScrap['evidence'],
      ...(typeof item.owner === 'string' ? { owner: item.owner } : {}) };
  });
}

function subscriberNodes(): readonly GraphNodeSpec[] {
  const parsed = parseGraphTemplateYaml(readFileSync(SUBSCRIBER_GRAPH, 'utf8'), 'graphs/release/macrophage-subscriber.yaml');
  if (parsed.errors.length || !parsed.template) throw new Error(`invalid macrophage subscriber graph: ${parsed.errors.map((error) => error.message).join('; ')}`);
  return parsed.template.nodes;
}

function releaseNodeFailure(event: GraphEvent): MacrophageScrap | undefined {
  const nodeId = event.source.nodeId;
  if (event.data?.ok !== false || !nodeId || (!FAILURE_WAKE_NODES.has(nodeId) && !/^gate-repair-[a-f0-9]{12}$/.test(nodeId))) return undefined;
  const failure = event.data.failure;
  const detail = typeof event.data.reason === 'string' ? event.data.reason
    : failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string' ? failure.message
      : typeof event.data.outcome === 'string' ? event.data.outcome : 'failure diagnostic unavailable';
  const search = `${detail} ${JSON.stringify(failure ?? {})}`.toLowerCase();
  const failureSignature: NonNullable<MacrophageEvidence['failureSignature']> = /ledger.{0,40}(?:not configured|missing|unset)|(?:not configured|missing|unset).{0,40}ledger/.test(search)
    ? 'ledger-unconfigured'
    : /\bts\d{3,5}\b|typescript|type(?:check| checking| error)/.test(search) ? 'type-error'
      : /config(?:uration)?\b.{0,40}(?:missing|unset|not configured|required)|(?:missing|unset|not configured|required).{0,40}config(?:uration)?\b/.test(search)
        ? 'configuration-missing' : 'unknown';
  return { id: `release-failure:${nodeId}:${failureSignature}`, kind: 'release-node-failure', owner: 'OP',
    evidence: { nodeId, failureSignature, failureDetail: detail.slice(0, 400) } };
}

function reportUnknownFailureToOp(notice: { runId: string; nodeId: string; detail: string }): void {
  const store = openMsgStore();
  try {
    store.post({ from: 'RELEASE', to: 'OP', kind: 'report',
      body: `release-loop macrophage: unknown failure signature · run=${notice.runId} · node=${notice.nodeId} · detail=${notice.detail}` });
  } finally { store.close(); }
}

function appendMacrophageReceipt(root: string, event: GraphEvent): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(event.runId) || event.runId === '.' || event.runId === '..') {
    throw new Error(`invalid macrophage receipt run id: ${event.runId}`);
  }
  const contexts = join(root, 'graph-runs', 'release-loop', `${event.runId}.json.contexts`);
  mkdirSync(contexts, { recursive: true, mode: 0o700 });
  appendDurableJsonLine(join(contexts, 'macrophage.jsonl'), {
    schema: 'elanous.release.macrophage-receipt.v1',
    eventId: event.eventId,
    sequence: event.sequence,
    emittedAt: event.emittedAt,
    graphId: event.graphId,
    runId: event.runId,
    source: event.source,
    data: event.data ?? {},
  });
}

function appendDurableJsonLine(path: string, value: Record<string, unknown>): void {
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function macrophagePaths(root: string, runId: string): { readonly contexts: string; readonly receipt: string; readonly state: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..')
    throw new Error(`invalid macrophage receipt run id: ${runId}`);
  const contexts = join(root, 'graph-runs', 'release-loop', `${runId}.json.contexts`);
  return { contexts, receipt: join(contexts, 'macrophage.jsonl'), state: join(contexts, 'macrophage-state.jsonl') };
}

function readJsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
      return value as Record<string, unknown>;
    } catch (error) {
      throw new Error(`invalid macrophage journal ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function appendMacrophageState(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendDurableJsonLine(path, value);
}

function decisionKey(sourceEventId: string, id: string): string {
  return createHash('sha256').update(`${sourceEventId}\0${id}`).digest('hex');
}

function decisionEventId(runId: string, key: string): string {
  return `${runId}:macrophage:${key}`;
}

/** Attach the declarative macrophage subscriber to an active release graph's real event bus. */
export function createMacrophageRuntime(options: MacrophageRuntimeOptions): MacrophageRuntime {
  const root = options.root ?? effectiveInstanceRoot();
  const bus = options.eventBus ?? createGraphEventBus({ now: options.now });
  bus.registerType(DECISION_EVENT);
  for (const type of TRAIN_EVENTS) bus.registerType(type);
  const decisions: GraphEvent[] = [];
  const paths = macrophagePaths(root, options.runId);
  const receipts = readJsonLines(paths.receipt);
  const stateRecords = readJsonLines(paths.state);
  const receiptedDecisionKeys = new Set<string>();
  const seenFailureSignatures = new Set<string>();
  const seenPhaseEventIds = new Set<string>();
  const reportedUnknownFailureSignatures = new Set<string>();
  for (const receipt of receipts) {
    const data = receipt.data && typeof receipt.data === 'object' ? receipt.data as Record<string, unknown> : {};
    if (typeof data.sourceEventId === 'string' && typeof data.id === 'string')
      receiptedDecisionKeys.add(decisionKey(data.sourceEventId, data.id));
    if (typeof data.failureSignature === 'string') {
      const evidence = data.evidence && typeof data.evidence === 'object' ? data.evidence as Record<string, unknown> : {};
      const nodeId = evidence.nodeId ?? data.phaseNodeId;
      if (typeof nodeId === 'string') seenFailureSignatures.add(`release-failure:${nodeId}:${data.failureSignature}`);
    }
  }
  const preparedDecisions = new Map<string, GraphEventInput>();
  for (const record of stateRecords) {
    if (record.kind === 'decision-prepared' && typeof record.key === 'string'
      && record.event && typeof record.event === 'object' && !Array.isArray(record.event))
      preparedDecisions.set(record.key, record.event as GraphEventInput);
    if (record.kind === 'decision-receipted' && typeof record.key === 'string') receiptedDecisionKeys.add(record.key);
    if (record.kind === 'failure-completed' && typeof record.signature === 'string') seenFailureSignatures.add(record.signature);
    if (record.kind === 'phase-completed' && typeof record.eventId === 'string') seenPhaseEventIds.add(record.eventId);
    if (record.kind === 'unknown-notified' && typeof record.signature === 'string') reportedUnknownFailureSignatures.add(record.signature);
  }
  const inFlightByEvent = new Map<string, Promise<void>>();
  const completedEventIds = new Set<string>();
  const publishedInRuntime = new Map<string, GraphEvent>();
  bus.subscribe((event) => { if (event.type === DECISION_EVENT) decisions.push(event); }, { type: DECISION_EVENT });
  const processDispatchCore = async (dispatch: GraphSubscriptionDispatch): Promise<void> => {
    if (dispatch.nodeId !== SUBSCRIBER_NODE_ID || dispatch.action !== 'wake') return;
    const failure = releaseNodeFailure(dispatch.event);
    const isTrainEvent = TRAIN_EVENTS.has(dispatch.event.type);
    const isPhaseWake = PHASE_WAKE_NODES.has(dispatch.event.source.nodeId ?? '');
    const duplicateFailure = failure !== undefined && seenFailureSignatures.has(failure.id);
    if (duplicateFailure) return;
    if (failure?.evidence.failureSignature === 'unknown' && !reportedUnknownFailureSignatures.has(failure.id)) {
      const notice = { runId: dispatch.event.runId, nodeId: failure.evidence.nodeId ?? 'unknown-node',
        detail: failure.evidence.failureDetail ?? 'failure diagnostic unavailable' };
      try {
        if (options.reportUnknownFailure) await options.reportUnknownFailure(notice);
        else if ((options.mode ?? 'live') === 'live') reportUnknownFailureToOp(notice);
        reportedUnknownFailureSignatures.add(failure.id);
        appendMacrophageState(paths.state, { schema: 'elanous.release.macrophage-state.v1', kind: 'unknown-notified', signature: failure.id });
      } catch (error) {
        debug.log('release-loop.macrophage', 'unknown-failure-report-failed', {
          graphId: dispatch.event.graphId, runId: dispatch.event.runId, nodeId: notice.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Let the graph event delivery fail. The runner's persisted pendingGraphEvents
        // outbox will replay this exact node-end envelope when the run resumes.
        throw error;
      }
    }
    if (!failure && !isPhaseWake && !isTrainEvent) return;
    const inventory = [
      ...(isPhaseWake ? options.inventory?.(dispatch.event) ?? parseInventory(dispatch.event.data?.macrophageScraps) : []),
      ...(failure ? [failure] : []),
      ...(isTrainEvent ? [{ id: `merge-train:${dispatch.event.eventId}`, kind: 'merge-train-observation' as const,
        evidence: { trainEventType: dispatch.event.type as 'merge-train.batch' | 'merge-train.verdict' | 'merge-train.incident',
          detail: JSON.stringify(dispatch.event.data ?? {}) } }] : []),
    ];
    const result = runMacrophageHeal({ phase: 'idle', mode: options.mode ?? 'live', now: (options.now ?? (() => new Date()))(),
      promotionMode: options.mode, consecutiveFailureLimit: options.consecutiveFailureLimit ?? 3, inventory });
    const rows = result.events.length ? result.events : [{ id: 'inventory', kind: 'parked-pr' as const,
      evidence: 'no scrap inventory evidence was attached to the phase event', action: 'retain' as const,
      result: 'unmeasured no cleanup applied', applied: false }];
    for (const row of rows) {
      const key = decisionKey(dispatch.event.eventId, row.id);
      if (receiptedDecisionKeys.has(key)) continue;
      let emitted = row;
      let eventInput = preparedDecisions.get(key);
      const published = publishedInRuntime.get(key);
      if (!eventInput) {
        const scrap = inventory.find((candidate) => candidate.id === row.id);
        if ((options.mode ?? 'live') === 'live' && options.liveCleanup && scrap
          && ((scrap.kind === 'merged-land-queue-row' && row.action === 'remove-queue-row')
            || (scrap.kind === 'orphan-worktree' && row.action === 'remove-resource' && scrap.evidence.mergedMainline === true))) {
          try {
            const appliedResult = await options.liveCleanup(scrap);
            if (appliedResult) emitted = { ...row, applied: true, result: appliedResult };
          } catch (error) {
            emitted = { ...row, result: `cleanup failed; retained (${error instanceof Error ? error.message : String(error)})` };
          }
        }
        const data = { sourceEventId: dispatch.event.eventId,
          ...(isTrainEvent ? { sourceEventType: dispatch.event.type } : {}),
          phaseNodeId: dispatch.event.source.nodeId,
          sourceNodeId: emitted.sourceNodeId, failureSignature: emitted.failureSignature,
          status: result.status, ...emitted };
        const eventId = decisionEventId(dispatch.event.runId, key);
        eventInput = { eventId, graphId: dispatch.event.graphId, runId: dispatch.event.runId,
          type: DECISION_EVENT, source: { kind: 'runner' }, data };
        preparedDecisions.set(key, eventInput);
        appendMacrophageState(paths.state, { schema: 'elanous.release.macrophage-state.v1', kind: 'decision-prepared', key, event: eventInput });
      }
      if (published) {
        (options.writeReceipt ?? appendMacrophageReceipt)(root, published);
        receiptedDecisionKeys.add(key);
        appendMacrophageState(paths.state, { schema: 'elanous.release.macrophage-state.v1', kind: 'decision-receipted', key });
        continue;
      }
      const data = eventInput.data ?? {};
      debug.log('release-loop.macrophage', 'decision', { graphId: dispatch.event.graphId, runId: dispatch.event.runId, ...data });
      const decisionEvent = await bus.publish(eventInput);
      publishedInRuntime.set(key, decisionEvent);
      (options.writeReceipt ?? appendMacrophageReceipt)(root, decisionEvent);
      receiptedDecisionKeys.add(key);
      appendMacrophageState(paths.state, { schema: 'elanous.release.macrophage-state.v1', kind: 'decision-receipted', key });
    }
    if (failure) {
      seenFailureSignatures.add(failure.id);
      appendMacrophageState(paths.state, { schema: 'elanous.release.macrophage-state.v1', kind: 'failure-completed', signature: failure.id });
    }
    if (isPhaseWake) {
      seenPhaseEventIds.add(dispatch.event.eventId);
      appendMacrophageState(paths.state, { schema: 'elanous.release.macrophage-state.v1', kind: 'phase-completed', eventId: dispatch.event.eventId });
    }
  };
  const unsubscribe = registerGraphSubscriptions(bus, subscriberNodes(), async (dispatch) => {
    if (dispatch.nodeId !== SUBSCRIBER_NODE_ID || dispatch.action !== 'wake') return;
    const eventId = dispatch.event.eventId;
    if (completedEventIds.has(eventId) || seenPhaseEventIds.has(eventId)) return;
    const pending = inFlightByEvent.get(eventId);
    if (pending) return pending;
    const task = processDispatchCore(dispatch).then(() => { completedEventIds.add(eventId); });
    inFlightByEvent.set(eventId, task);
    try { await task; } finally { inFlightByEvent.delete(eventId); }
  }, { scope: { graphId: options.graphId ?? 'release-loop', runId: options.runId } });
  return { eventBus: bus, decisions, dispose: unsubscribe };
}
