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
  onFlushed?: (scope: GraphEventScope | undefined, eventIds: readonly string[]) => void,
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
      onFlushed?.(scope, ids);
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
