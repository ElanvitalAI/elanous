import { AsyncLocalStorage } from 'node:async_hooks';

export interface GraphEventInput {
  /** Optional stable producer id; useful when a runner resumes from its durable sequence. */
  readonly eventId?: string;
  /** Preserved by the runner's durable event outbox when delivery is retried. */
  readonly sequence?: number;
  readonly emittedAt?: string;
  readonly graphId: string;
  readonly runId: string;
  readonly type: string;
  readonly source: { readonly kind: 'runner' | 'node'; readonly nodeId?: string };
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface GraphEvent extends GraphEventInput {
  readonly eventId: string;
  readonly sequence: number;
  readonly emittedAt: string;
}

export type GraphEventHandler = (event: GraphEvent) => void | Promise<void>;

export interface GraphEventScope {
  readonly graphId: string;
  readonly runId: string;
  /** Run-level opt-out for observer side effects, including custom node events. */
  readonly dryRun?: boolean;
}

export interface GraphEventBus {
  /** Extensible event vocabulary registry; domain owners add new event kinds explicitly. */
  registerType(type: string): void;
  hasType(type: string): boolean;
  /** Tries all handlers, rejects with AggregateError if any fail, and drains later queued events.
   * Reentrant publishes enqueue and are awaited by flush(). */
  publish(input: GraphEventInput): Promise<GraphEvent>;
  /** Completes queued reentrant publications and reports their delivery failures. */
  flush(scope?: GraphEventScope): Promise<void>;
  subscribe(handler: GraphEventHandler, filter?: { readonly type?: string }): () => void;
}

/** Run scope adds a durable event id while preserving the injected bus's subscribers and queue. */
export function createScopedGraphEventBus(
  bus: GraphEventBus,
  prepareEvent: (input: GraphEventInput) => GraphEvent,
  onQueued?: (event: GraphEvent) => void,
  onFlushed?: (scope: GraphEventScope | undefined, eventIds: readonly string[]) => void | Promise<void>,
): GraphEventBus & { prepare(input: GraphEventInput): GraphEvent } {
  const queuedByScope = new Map<string, Set<string>>();
  return {
    registerType: (type) => bus.registerType(type),
    hasType: (type) => bus.hasType(type),
    prepare: (input) => prepareEvent(input),
    async publish(input) {
      const event = input.eventId !== undefined && input.sequence !== undefined && input.emittedAt !== undefined
        ? input as GraphEvent : prepareEvent(input);
      onQueued?.(event);
      const key = `${event.graphId}\0${event.runId}`;
      const ids = queuedByScope.get(key) ?? new Set<string>();
      ids.add(event.eventId);
      queuedByScope.set(key, ids);
      try { return await bus.publish(event); }
      catch (error) {
        ids.delete(event.eventId);
        if (ids.size === 0) queuedByScope.delete(key);
        throw error;
      }
    },
    async flush(scope) {
      const keys = scope === undefined ? [...queuedByScope.keys()] : [`${scope.graphId}\0${scope.runId}`];
      try { await bus.flush(scope); }
      catch (error) {
        for (const key of keys) queuedByScope.delete(key);
        throw error;
      }
      const ids = keys.flatMap((key) => [...(queuedByScope.get(key) ?? [])]);
      for (const key of keys) queuedByScope.delete(key);
      const flushed = onFlushed?.(scope, ids);
      if (flushed) await flushed;
    },
    subscribe: (handler, filter) => bus.subscribe(handler, filter),
  };
}

/** Enforces a node's declared emits allowlist before handing the event to the shared bus. */
export function publishNodeGraphEvent(
  bus: GraphEventBus,
  input: GraphEventInput & { readonly source: { readonly kind: 'node'; readonly nodeId: string } },
  allowedEventTypes: readonly string[],
): Promise<GraphEvent> {
  if (!allowedEventTypes.includes(input.type))
    return Promise.reject(new Error(`node ${input.source.nodeId} emitted undeclared graph event: ${input.type}`));
  return bus.publish(input);
}

interface Delivery {
  readonly event: GraphEvent;
  readonly recipients: readonly { readonly handler: GraphEventHandler; readonly type?: string }[];
  readonly reentrant: boolean;
  readonly promise: Promise<GraphEvent>;
  readonly resolve: (event: GraphEvent) => void;
  readonly reject: (error: Error) => void;
}

/** Ordered in-process event sink. Reentrant emits queue behind the current event instead of deadlocking. */
export function createGraphEventBus(options: {
  readonly createEventId?: (sequence: number) => string;
  readonly now?: () => Date;
} = {}): GraphEventBus {
  let sequence = 0;
  let nextSubscriber = 0;
  let draining = false;
  let drainTask: Promise<void> | undefined;
  const token = Symbol('graph-event-bus');
  const deliveryContext = new AsyncLocalStorage<symbol>();
  const nestedFailures = new Map<string, Error[]>();
  const queue: Delivery[] = [];
  const vocabulary = new Set(['node-start', 'node-end']);
  const subscribers = new Map<number, { readonly handler: GraphEventHandler; readonly type?: string }>();

  const startDrain = (): void => {
    if (draining) return;
    draining = true;
    drainTask = (async () => {
      while (queue.length > 0) {
        const delivery = queue.shift()!;
        const failures: unknown[] = [];
        for (const subscriber of delivery.recipients) {
          if (subscriber.type !== undefined && subscriber.type !== delivery.event.type) continue;
          try {
            await deliveryContext.run(token, () => subscriber.handler(delivery.event));
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          const error = new AggregateError(failures, `graph event ${delivery.event.eventId} delivery failed`);
          if (delivery.reentrant) {
            const key = `${delivery.event.graphId}\0${delivery.event.runId}`;
            const runFailures = nestedFailures.get(key) ?? [];
            runFailures.push(error);
            nestedFailures.set(key, runFailures);
          }
          delivery.reject(error);
        } else {
          delivery.resolve(delivery.event);
        }
      }
    })().finally(() => {
      draining = false;
      if (queue.length > 0) startDrain();
    });
  };

  return {
    registerType(type) {
      if (!type.trim()) throw new Error('graph event type must be a non-empty string');
      vocabulary.add(type);
    },
    hasType(type) { return vocabulary.has(type); },
    publish(input) {
      if (!vocabulary.has(input.type)) return Promise.reject(new Error(`unregistered graph event type: ${input.type}`));
      const eventSequence = input.sequence ?? sequence + 1;
      sequence = Math.max(sequence, eventSequence);
      const event: GraphEvent = {
        ...input,
        eventId: input.eventId ?? options.createEventId?.(eventSequence) ?? `${input.runId}:${eventSequence}`,
        sequence: eventSequence,
        emittedAt: input.emittedAt ?? (options.now?.() ?? new Date()).toISOString(),
      };
      const reentrant = deliveryContext.getStore() === token;
      let resolve!: (value: GraphEvent) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<GraphEvent>((res, rej) => { resolve = res; reject = rej; });
      // Reentrant callers intentionally receive enqueue acknowledgement. flush() observes delivery failures.
      void promise.catch(() => undefined);
      queue.push({ event, recipients: [...subscribers.values()], reentrant, promise, resolve, reject });
      startDrain();
      return reentrant ? Promise.resolve(event) : promise;
    },
    async flush(scope) {
      while (draining || queue.length > 0) {
        if (!draining) startDrain();
        await drainTask;
      }
      const key = scope === undefined ? undefined : `${scope.graphId}\0${scope.runId}`;
      const failures = key === undefined
        ? [...nestedFailures.values()].flat()
        : nestedFailures.get(key) ?? [];
      if (key === undefined) nestedFailures.clear();
      else nestedFailures.delete(key);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'reentrant graph event delivery failed');
      }
    },
    subscribe(handler, filter) {
      const id = ++nextSubscriber;
      subscribers.set(id, { handler, ...(filter?.type === undefined ? {} : { type: filter.type }) });
      return () => { subscribers.delete(id); };
    },
  };
}

/** External event envelope is separate from run-scoped GraphEvent: it has no graph/run owner yet. */
export interface GraphExternalTriggerEvent {
  readonly eventId: string;
  readonly type: string;
  readonly dedupeKey: string;
  readonly at: string;
  readonly sequence?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type GraphExternalTriggerDispatchResult =
  | { readonly disposition: 'ignored'; readonly reason: 'event-not-declared'; readonly graphId: string; readonly eventId: string }
  | { readonly disposition: 'started' | 'resumed' | 'duplicate' | 'busy'; readonly graphId: string; readonly eventId: string;
      readonly runId: string; readonly state?: import('./runner.js').GraphRunState };

/** Starts a graph only when its YAML declares this external event; the dispatch registry owns idempotency.
 *  Internal GraphEventBus subscribers remain scoped to an existing graph/run and never call this ingress. */
export async function dispatchDeclaredGraphExternalEvent(graphPath: string, event: unknown, options: {
  registryRoot?: string;
  stateRoot?: string;
  runRoot?: string;
  now?: () => number;
  leaseMs?: number;
  createRunId?: () => string;
  eventNow?: () => Date;
  graphRunOptions?: Pick<import('./runner.js').GraphRunOptions, 'eventBus' | 'quiet' | 'deps' | 'routeGraphEvents'>;
} = {}): Promise<GraphExternalTriggerDispatchResult> {
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error('external graph event requires an object envelope');
  const envelope = event as Record<string, unknown>;
  for (const field of ['eventId', 'type', 'dedupeKey']) {
    if (typeof envelope[field] !== 'string' || !envelope[field].trim())
      throw new Error(`external graph event requires ${field}`);
  }
  if (typeof envelope.at !== 'string' || !Number.isFinite(Date.parse(envelope.at)))
    throw new Error('external graph event requires a valid at timestamp');
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload))
    throw new Error('external graph event requires an object payload');
  if (envelope.sequence !== undefined && (!Number.isSafeInteger(envelope.sequence) || (envelope.sequence as number) < 0))
    throw new Error('external graph event requires a non-negative safe integer sequence');
  const delivery = envelope as unknown as GraphExternalTriggerEvent;

  const { readFileSync } = await import('node:fs');
  const { parse: parseYaml } = await import('yaml');
  const document: unknown = parseYaml(readFileSync(graphPath, 'utf8'));
  const root = document && typeof document === 'object' && !Array.isArray(document)
    ? document as Record<string, unknown> : {};
  const graphId = typeof root.graph_id === 'string' ? root.graph_id : '';
  if (!graphId) throw new Error('external graph event target requires graph_id');
  if (root.loop !== undefined && (!root.loop || typeof root.loop !== 'object' || Array.isArray(root.loop)))
    throw new Error('external graph event target requires an object loop declaration');
  const loop = root.loop && typeof root.loop === 'object' && !Array.isArray(root.loop)
    ? root.loop as Record<string, unknown> : {};
  if (loop.trigger !== undefined && (!loop.trigger || typeof loop.trigger !== 'object' || Array.isArray(loop.trigger)))
    throw new Error('external graph event target requires an object trigger declaration');
  const trigger = loop.trigger && typeof loop.trigger === 'object' && !Array.isArray(loop.trigger)
    ? loop.trigger as Record<string, unknown> : {};
  if (trigger.events !== undefined && (!Array.isArray(trigger.events)
    || trigger.events.some(type => typeof type !== 'string' || !type.trim())))
    throw new Error('external graph event target requires an array of non-empty event types');
  const declarations = Array.isArray(trigger.events) ? trigger.events : [];
  if (!declarations.includes(delivery.type))
    return { disposition: 'ignored', reason: 'event-not-declared', graphId, eventId: delivery.eventId };

  const { dispatchGraphTriggerRun } = await import('../loops/graph-trigger-dispatch.js');
  const result = await dispatchGraphTriggerRun({
    graphId,
    graphPath,
    triggerId: `event:${graphId}:${delivery.type}`,
    dedupeKey: delivery.dedupeKey,
    payload: { ...delivery.payload, graphEvent: { eventId: delivery.eventId, type: delivery.type, dedupeKey: delivery.dedupeKey,
      at: delivery.at, ...(delivery.sequence === undefined ? {} : { sequence: delivery.sequence }) } },
  }, options);
  const disposition = !result.claimed ? 'busy'
    : result.mode === 'start' ? 'started'
      : result.mode === 'resume' ? 'resumed' : 'duplicate';
  return { disposition, graphId, eventId: delivery.eventId, runId: result.registration.runId,
    ...(result.state ? { state: result.state } : {}) };
}

// ─── ④ webhook trigger (GRAPH-SCHEDULER §1-1 ④, §1-3, §6-1 SCHEDULE-TRIGGER-HOOK-IN) ───

/** §1-1 ④: the event type a graph declares in loop.trigger.events to receive els HOOK-IN firings. */
export const HOOK_IN_EVENT_TYPE = 'hook.in';

/** §1-3: risk class of a hook's graph target — the els door holds the first firing of write/external-send for a person. */
export type HookInGraphTriggerDanger = 'read' | 'write' | 'external-send';

/** A HOOK-IN envelope that already passed the els door's signature, nonce and window proof (#39168). */
export interface HookInGraphTriggerEnvelope {
  readonly hookName: string;
  readonly nonce: string;
  /** ISO time of the verified webhook request. */
  readonly at: string;
  /** Parsed JSON object body of the verified webhook. */
  readonly body: Readonly<Record<string, unknown>>;
  /** Graph yaml the hook fires; its loop.trigger.events must declare hook.in. */
  readonly graphPath: string;
  /** §1-3 risk class; it travels with the envelope so the door and the dispatch registry share one contract. */
  readonly danger: HookInGraphTriggerDanger;
}

/** §1-1 ④: dedupeKey = `hook:<hookName>:<nonce>` — the door's nonce ledger and the dispatch registry share the key. */
export function hookInGraphEventEnvelope(envelope: HookInGraphTriggerEnvelope): GraphExternalTriggerEvent {
  const eventId = `hook:${envelope.hookName}:${envelope.nonce}`;
  return { eventId, type: HOOK_IN_EVENT_TYPE, dedupeKey: eventId, at: envelope.at, payload: { ...envelope.body } };
}

/** §5 one entrance: the verified HOOK-IN envelope becomes a graph event envelope and goes through
 *  dispatchDeclaredGraphExternalEvent — the graph's own loop.trigger.events declaration decides, and the
 *  shared dispatch registry owns idempotency. Direct HTTP→runGraph paths stay forbidden. */
export async function dispatchHookInGraphTrigger(
  envelope: HookInGraphTriggerEnvelope,
  options: Parameters<typeof dispatchDeclaredGraphExternalEvent>[2] = {},
): Promise<GraphExternalTriggerDispatchResult> {
  if (typeof envelope.hookName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(envelope.hookName))
    throw new Error('hook.in trigger requires a hook name');
  if (typeof envelope.nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(envelope.nonce))
    throw new Error('hook.in trigger requires a nonce');
  if (typeof envelope.at !== 'string' || !Number.isFinite(Date.parse(envelope.at)))
    throw new Error('hook.in trigger requires a valid at timestamp');
  if (!envelope.body || typeof envelope.body !== 'object' || Array.isArray(envelope.body))
    throw new Error('hook.in trigger requires an object body');
  if (envelope.danger !== 'read' && envelope.danger !== 'write' && envelope.danger !== 'external-send')
    throw new Error('hook.in trigger requires a danger class');
  if (typeof envelope.graphPath !== 'string' || !envelope.graphPath.trim())
    throw new Error('hook.in trigger requires a graph path');
  return dispatchDeclaredGraphExternalEvent(envelope.graphPath, hookInGraphEventEnvelope(envelope), options);
}
