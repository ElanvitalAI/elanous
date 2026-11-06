import { NexusEventBus } from '../nexus/api/event-bus.js';
import type { NexusEvent } from '../nexus/state/state.js';

export type AppRowOperation = 'insert' | 'update' | 'delete';

export interface AppRowChange {
  appSlug: string;
  operation: AppRowOperation;
  rowId: string;
  row: Record<string, unknown>;
}

export interface AppRealtimeFrame {
  id: string;
  event: string;
  data: string;
  receivedAt: number;
}

export interface AppRealtimeScenarioInput {
  name: string;
  subscriberCount: number;
  maxLatencyMs: number;
  bufferLimit: number;
  now: () => number;
  advance: (ms: number) => void;
}

export interface AppRealtimeScenario {
  name: string;
  input: Omit<AppRealtimeScenarioInput, 'name' | 'now' | 'advance'>;
  expected: {
    operations: readonly AppRowOperation[];
    subscriberCount: number;
    maxLatencyMs: number;
    bufferLimit: number;
    replayOnlyAfterLastEventId: true;
    isolatedByAppSlug: true;
    overflowClosesSlowSubscriber: true;
  };
}

export interface AppRealtimeSubscription {
  unsubscribe(): void | Promise<void>;
  disconnect(): void | Promise<void>;
  readonly closed: boolean;
  readonly pending: number;
  drain(): void | Promise<void>;
}

export interface AppRealtimePort {
  subscribe(
    appSlug: string,
    listener: (frame: AppRealtimeFrame) => void,
    options?: { lastEventId?: string; slow?: boolean },
  ): AppRealtimeSubscription;
  publish(change: AppRowChange): void | Promise<void>;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  flush(): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

export type AppRealtimePortFactory = (input: AppRealtimeScenarioInput) => AppRealtimePort | Promise<AppRealtimePort>;

/**
 * Subscriber count, latency limit and buffer limit below are SIMULATION FIXTURES, not landed contract values —
 * the canonical numbers belong to NEXUS-APP-RT. Pass `AppRealtimeMatrixLimits` to `runFakeAppRealtimeMatrix`
 * to run the same matrix with an implementation's own limits.
 */
export interface AppRealtimeMatrixLimits { subscriberCount?: number; maxLatencyMs?: number; bufferLimit?: number }

export const FAKE_APP_REALTIME_SCENARIOS: readonly AppRealtimeScenario[] = [
  {
    name: 'app-scoped insert update delete and SSE frame fields',
    input: { subscriberCount: 2, maxLatencyMs: 25, bufferLimit: 2 },
    expected: {
      operations: ['insert', 'update', 'delete'], subscriberCount: 2, maxLatencyMs: 25, bufferLimit: 2,
      replayOnlyAfterLastEventId: true, isolatedByAppSlug: true, overflowClosesSlowSubscriber: true,
    },
  },
  {
    name: 'Last-Event-ID replays only missed app events',
    input: { subscriberCount: 1, maxLatencyMs: 25, bufferLimit: 2 },
    expected: {
      operations: ['insert'], subscriberCount: 1, maxLatencyMs: 25, bufferLimit: 2,
      replayOnlyAfterLastEventId: true, isolatedByAppSlug: true, overflowClosesSlowSubscriber: true,
    },
  },
  {
    name: 'slow subscriber overflow is isolated from healthy subscribers',
    input: { subscriberCount: 2, maxLatencyMs: 25, bufferLimit: 2 },
    expected: {
      operations: ['insert'], subscriberCount: 2, maxLatencyMs: 25, bufferLimit: 2,
      replayOnlyAfterLastEventId: true, isolatedByAppSlug: true, overflowClosesSlowSubscriber: true,
    },
  },
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function change(appSlug: string, operation: AppRowOperation, rowId: string): AppRowChange {
  return { appSlug, operation, rowId, row: { id: rowId, value: `${operation}-${rowId}` } };
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`runFakeAppRealtimeMatrix: ${name} must be a positive integer`);
}

export async function runFakeAppRealtimeMatrix(factory: AppRealtimePortFactory, limits: AppRealtimeMatrixLimits = {}): Promise<void> {
  if (limits.subscriberCount !== undefined) requirePositiveInteger(limits.subscriberCount, 'subscriberCount');
  if (limits.bufferLimit !== undefined) requirePositiveInteger(limits.bufferLimit, 'bufferLimit');
  if (limits.maxLatencyMs !== undefined && (!Number.isFinite(limits.maxLatencyMs) || limits.maxLatencyMs < 0)) {
    throw new Error('runFakeAppRealtimeMatrix: maxLatencyMs must be a nonnegative finite number');
  }
  const failures: Error[] = [];
  for (const scenario of FAKE_APP_REALTIME_SCENARIOS) {
    const cleanups: Array<() => void | Promise<void>> = [];
    let port: AppRealtimePort | undefined;
    let failure: unknown;
    let failed = false;
    try {
      let currentTime = 0;
      const input: AppRealtimeScenarioInput = {
        ...scenario.input,
        ...(limits.subscriberCount === undefined ? {} : { subscriberCount: limits.subscriberCount }),
        ...(limits.maxLatencyMs === undefined ? {} : { maxLatencyMs: limits.maxLatencyMs }),
        ...(limits.bufferLimit === undefined ? {} : { bufferLimit: limits.bufferLimit }),
        name: scenario.name,
        now: () => currentTime,
        advance: (ms) => { currentTime += ms; },
      };
      port = await factory(input);
      const subscribe = (slug: string, listener: (frame: AppRealtimeFrame) => void, options?: { lastEventId?: string; slow?: boolean }) => {
        const subscription = port!.subscribe(slug, listener, options);
        cleanups.push(() => subscription.unsubscribe());
        return subscription;
      };
      const observed: AppRealtimeFrame[][] = Array.from({ length: input.subscriberCount }, () => []);
      const sentAt = new Map<string, number>();
      const latencies: number[] = [];
      const healthy = observed.map((frames) => subscribe('app-a', (frame) => {
        frames.push(frame);
        const data = JSON.parse(frame.data) as AppRowChange;
        const publishedAt = sentAt.get(data.rowId);
        if (publishedAt !== undefined) latencies.push(input.now() - publishedAt);
      }));
      const otherApp: AppRealtimeFrame[] = [];
      subscribe('app-b', (frame) => otherApp.push(frame));
      for (const [index, operation] of scenario.expected.operations.entries()) {
        currentTime += 5;
        const rowId = `row-${index}`;
        sentAt.set(rowId, input.now());
        await port.publish(change('app-a', operation, rowId));
      }
      await port.flush();
      const expectedCount = scenario.expected.operations.length;
      for (const frames of observed) {
        assert(frames.length === expectedCount, `${scenario.name}: expected ${expectedCount} events, got ${frames.length}`);
        frames.forEach((frame, index) => {
          assert(frame.id.length > 0, `${scenario.name}: missing SSE id`);
          const expectedOperation = scenario.expected.operations[index]!;
          assert(frame.event === `app.row.${expectedOperation}`, `${scenario.name}: incorrect SSE event`);
          const data = JSON.parse(frame.data) as AppRowChange;
          assert(data.appSlug === 'app-a' && data.rowId === `row-${index}`, `${scenario.name}: incorrect SSE data`);
          assert(data.operation === expectedOperation && data.row.value === `${data.operation}-row-${index}`, `${scenario.name}: row payload did not match input`);
        });
      }
      assert(latencies.length === expectedCount * input.subscriberCount, `${scenario.name}: missing delivery latency observations`);
      assert(latencies.every((latency) => latency >= 0 && latency <= input.maxLatencyMs), `${scenario.name}: delivery exceeded maxLatencyMs=${input.maxLatencyMs}`);
      assert(otherApp.length === 0, `${scenario.name}: event leaked to another app`);

      if (scenario.name.startsWith('Last-Event-ID')) {
        const before = observed[0]![0]!.id;
        const beforeDisconnect = observed.map((frames) => frames.length);
        for (const subscription of healthy) {
          await subscription.disconnect();
          assert(subscription.closed, `${scenario.name}: disconnect left an existing subscription open`);
        }
        const referenceFrames: AppRealtimeFrame[] = [];
        const reference = subscribe('app-a', (frame) => referenceFrames.push(frame));
        await port.pause();
        await port.publish(change('app-a', 'insert', 'missed-1'));
        await port.publish(change('app-a', 'insert', 'missed-2'));
        await port.publish(change('app-b', 'insert', 'foreign'));
        await port.resume();
        await port.flush();
        assert(referenceFrames.length === 2, `${scenario.name}: expected two original missed frames`);
        await reference.unsubscribe();
        observed.forEach((frames, index) => {
          assert(frames.length === beforeDisconnect[index], `${scenario.name}: disconnected subscriber received another event`);
        });
        const replayed: AppRealtimeFrame[] = [];
        subscribe('app-a', (frame) => replayed.push(frame), { lastEventId: before });
        await port.flush();
        assert(replayed.length === referenceFrames.length, `${scenario.name}: expected exactly the missed events to replay`);
        replayed.forEach((frame, index) => {
          const original = referenceFrames[index]!;
          assert(frame.id === original.id, `${scenario.name}: replayed frame id differs from original event`);
          assert(frame.event === original.event, `${scenario.name}: replayed frame event differs from original event`);
          assert(frame.data === original.data, `${scenario.name}: replayed frame payload differs from original event`);
        });
      }

      if (scenario.name.startsWith('slow subscriber')) {
        const slow = subscribe('app-a', () => {}, { slow: true });
        const otherAppCountBeforeOverflow = otherApp.length;
        for (let index = 0; index <= input.bufferLimit; index++) {
          await port.publish(change('app-a', 'insert', `overflow-${index}`));
          await port.flush();
          assert(otherApp.length === otherAppCountBeforeOverflow, `${scenario.name}: overflow event leaked to another app`);
          const overflowCount = index + 1;
          if (overflowCount <= input.bufferLimit) {
            assert(!slow.closed, `${scenario.name}: slow subscriber closed before bufferLimit=${input.bufferLimit}`);
            assert(slow.pending === overflowCount, `${scenario.name}: expected pending=${overflowCount}, got ${slow.pending}`);
            assert(slow.pending <= input.bufferLimit, `${scenario.name}: pending exceeded bufferLimit=${input.bufferLimit}`);
          } else {
            assert(slow.closed, `${scenario.name}: slow subscriber remained connected beyond bufferLimit=${input.bufferLimit}`);
            assert(slow.pending <= input.bufferLimit, `${scenario.name}: pending exceeded bufferLimit=${input.bufferLimit}`);
          }
          for (const subscription of healthy) {
            assert(!subscription.closed, `${scenario.name}: healthy subscriber was closed by slow subscriber overflow`);
          }
          const expectedOverflowCount = Math.min(overflowCount, input.bufferLimit + 1);
          for (let subscriberIndex = 0; subscriberIndex < observed.length; subscriberIndex++) {
            const frames = observed[subscriberIndex]!;
            assert(frames.length === expectedCount + overflowCount, `${scenario.name}: healthy subscriber stopped receiving after flush`);
            for (let eventIndex = 0; eventIndex < expectedOverflowCount; eventIndex++) {
              const rowId = `overflow-${eventIndex}`;
              const frame = frames[expectedCount + eventIndex]!;
              assert(frame.id.length > 0, `${scenario.name}: overflow frame missing SSE id`);
              assert(frame.event === 'app.row.insert', `${scenario.name}: healthy subscriber received incorrect overflow event`);
              // Compare the contract fields of the parsed payload: key order and whitespace are not part of the SSE contract.
              const expectedChange = change('app-a', 'insert', rowId);
              const actualChange = JSON.parse(frame.data) as AppRowChange;
              assert(actualChange.appSlug === expectedChange.appSlug && actualChange.operation === expectedChange.operation
                && actualChange.rowId === expectedChange.rowId && actualChange.row?.id === expectedChange.row.id
                && actualChange.row?.value === expectedChange.row.value,
              `${scenario.name}: healthy subscriber received incorrect or out-of-order overflow data`);
              if (subscriberIndex > 0) {
                assert(frame.id === observed[0]![expectedCount + eventIndex]!.id, `${scenario.name}: healthy subscribers received different overflow frame ids`);
              }
            }
          }
        }
      }
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup(); } catch (error) {
          if (!failed) failure = error;
          else failure = new AggregateError([failure, error], scenario.name);
          failed = true;
        }
      }
      if (port) {
        try { await port.cleanup(); } catch (error) {
          if (!failed) failure = error;
          else failure = new AggregateError([failure, error], scenario.name);
          failed = true;
        }
      }
    }
    if (failed) failures.push(new Error(`Realtime scenario failed: ${scenario.name}`, { cause: failure }));
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Realtime contract matrix failed');
}

/** NexusEvent kind prefix the reference port publishes app row changes under. */
export const APP_ROW_EVENT_PREFIX = 'app.row.';

export interface NexusEventBusRealtimeObserver {
  /** Every event the real NexusEventBus carried (recorded by a plain bus subscriber). */
  readonly busEvents: NexusEvent[];
  /** Slow subscribers the port closed because their buffer overflowed. */
  overflowClosed: number;
  /** Frames replayed on Last-Event-ID resubscription, each taken from an event the bus actually delivered. */
  readonly replayed: AppRealtimeFrame[];
  /** Bus listener count after each scenario cleanup (0 = nothing leaked). */
  readonly busSizeAfterCleanup: number[];
}

export function createNexusEventBusRealtimeObserver(): NexusEventBusRealtimeObserver {
  return { busEvents: [], overflowClosed: 0, replayed: [], busSizeAfterCleanup: [] };
}

/**
 * Reference SIM-APPRT port on the real in-process bus (`src/nexus/api/event-bus.ts` NexusEventBus): row changes are
 * published as `app.row.<operation>` NexusEvents and every subscriber — including Last-Event-ID replay and the slow
 * subscriber buffer — is fed from `bus.subscribe`. Only the SSE wire framing is simulated.
 */
export function createNexusEventBusAppRealtimePortFactory(
  options: { observer?: NexusEventBusRealtimeObserver } = {},
): AppRealtimePortFactory {
  return (input) => {
    const bus = new NexusEventBus();
    const observer = options.observer;
    const stopObserving = observer ? bus.subscribe((event) => observer.busEvents.push(event), [APP_ROW_EVENT_PREFIX]) : () => {};
    const frameOf = (event: NexusEvent): AppRealtimeFrame => ({
      id: String(event.detail?.id), event: event.kind, data: String(event.detail?.data), receivedAt: input.now(),
    });
    // Replay history is fed by a bus subscriber: only events the real bus delivered can be replayed.
    const history = new Map<string, AppRealtimeFrame[]>();
    const stopHistory = bus.subscribe((event) => {
      const appSlug = String(event.detail?.appSlug);
      const frames = history.get(appSlug) ?? [];
      frames.push(frameOf(event));
      history.set(appSlug, frames);
    }, [APP_ROW_EVENT_PREFIX]);
    const unsubscribers = new Set<() => void>();
    const held: NexusEvent[] = [];
    let paused = false;
    let nextId = 0;
    return {
      subscribe(appSlug, listener, subscribeOptions = {}) {
        let closed = false;
        const queue: AppRealtimeFrame[] = [];
        if (subscribeOptions.lastEventId !== undefined) {
          const after = Number(subscribeOptions.lastEventId);
          for (const frame of history.get(appSlug) ?? []) {
            if (Number(frame.id) <= after) continue;
            const replay = { ...frame, receivedAt: input.now() };
            observer?.replayed.push(replay);
            listener(replay);
          }
        }
        let stop = () => {};
        const close = () => { if (!closed) { closed = true; stop(); unsubscribers.delete(close); } };
        stop = bus.subscribe((event) => {
          if (closed || event.detail?.appSlug !== appSlug) return;
          const frame = frameOf(event);
          if (!subscribeOptions.slow) { listener(frame); return; }
          if (queue.length >= input.bufferLimit) {
            close();
            if (observer) observer.overflowClosed += 1;
            return;
          }
          queue.push(frame);
        }, [APP_ROW_EVENT_PREFIX]);
        unsubscribers.add(close);
        return {
          unsubscribe: close,
          disconnect: close,
          get closed() { return closed; },
          get pending() { return queue.length; },
          drain() { while (queue.length) listener(queue.shift()!); },
        };
      },
      publish(rowChange) {
        input.advance(1);
        const id = String(++nextId);
        const kind = `${APP_ROW_EVENT_PREFIX}${rowChange.operation}` as unknown as NexusEvent['kind'];
        const event: NexusEvent = { ts: input.now(), kind, detail: { appSlug: rowChange.appSlug, id, data: JSON.stringify(rowChange) } };
        if (paused) held.push(event);
        else bus.publish(event);
      },
      pause() { paused = true; },
      resume() { paused = false; while (held.length) bus.publish(held.shift()!); },
      flush() {},
      cleanup() {
        for (const close of [...unsubscribers]) close();
        stopHistory();
        stopObserving();
        observer?.busSizeAfterCleanup.push(bus.size());
      },
    };
  };
}
