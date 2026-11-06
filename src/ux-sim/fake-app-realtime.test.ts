import { describe, expect, test } from 'bun:test';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import type { NexusEvent } from '../nexus/state/state.js';
import {
  createNexusEventBusAppRealtimePortFactory,
  createNexusEventBusRealtimeObserver,
  runFakeAppRealtimeMatrix,
  type AppRealtimeFrame,
  type AppRealtimePort,
  type AppRealtimePortFactory,
} from './fake-app-realtime.js';

function createPortFactory(options: { defect?: 'publish' | 'drop' | 'duplicate' | 'slow-early-close' | 'slow-unbounded' | 'disconnect-noop' | 'overflow-replace' | 'replay-empty-id' | 'replay-event' | 'replay-payload' | 'overflow-leak' | 'reordered-keys'; asyncDelivery?: boolean; failureValue?: unknown; failWithFalsy?: boolean; active?: Set<string>; attempted?: Set<string> } = {}): AppRealtimePortFactory {
  const active = options.active ?? new Set<string>();
  return (input) => {
    options.attempted?.add(input.name);
    const listeners = new Map<string, Map<number, { callback: (frame: AppRealtimeFrame) => void; queue: AppRealtimeFrame[] }>>();
    const history = new Map<string, AppRealtimeFrame[]>();
    let id = 0;
    let disposed = false;
    const deliveries: Array<() => void> = [];
    const port: AppRealtimePort = {
      subscribe(appSlug, callback, subscribeOptions = {}) {
        const subscribers = listeners.get(appSlug) ?? new Map();
        listeners.set(appSlug, subscribers);
        const key = ++id;
        let closed = false;
        const queue: AppRealtimeFrame[] = [];
        const deliver = (frame: AppRealtimeFrame) => {
          if (subscribeOptions.slow) {
            if (options.defect === 'slow-early-close') { closed = true; subscribers.delete(key); }
            else if (options.defect !== 'slow-unbounded' && queue.length >= input.bufferLimit) { closed = true; subscribers.delete(key); }
            else queue.push(frame);
          } else if (options.asyncDelivery) deliveries.push(() => callback(frame));
          else callback(frame);
        };
        const entry = { callback: deliver, queue };
        if (subscribeOptions.lastEventId !== undefined) {
          for (const frame of history.get(appSlug) ?? []) {
            if (Number(frame.id) > Number(subscribeOptions.lastEventId)) {
              const replay = options.defect === 'replay-empty-id' ? { ...frame, id: '' }
                : options.defect === 'replay-event' ? { ...frame, event: 'app.row.corrupt' }
                  : options.defect === 'replay-payload' ? { ...frame, data: JSON.stringify({ ...JSON.parse(frame.data), row: { damaged: true } }) }
                    : frame;
              callback(replay);
            }
          }
        }
        subscribers.set(key, entry);
        return {
          unsubscribe() { subscribers.delete(key); closed = true; },
          disconnect() {
            if (options.defect !== 'disconnect-noop') { subscribers.delete(key); closed = true; }
          },
          get closed() { return closed; },
          get pending() { return queue.length; },
          drain() { while (queue.length) callback(queue.shift()!); },
        };
      },
      publish(change) {
        if (disposed) throw new Error('port disposed');
        if (options.defect === 'publish') {
          if (options.failWithFalsy) throw options.failureValue;
          throw new Error('injected publish failure');
        }
        input.advance(1);
        const data = options.defect === 'reordered-keys'
          ? JSON.stringify({ row: { value: change.row.value, id: change.row.id }, rowId: change.rowId, operation: change.operation, appSlug: change.appSlug }, null, 1)
          : JSON.stringify(change);
        const frame: AppRealtimeFrame = {
          id: String(++id), event: `app.row.${change.operation}`, data, receivedAt: input.now(),
        };
        const events = history.get(change.appSlug) ?? [];
        events.push(frame);
        history.set(change.appSlug, events);
          for (const subscriber of listeners.get(change.appSlug)?.values() ?? []) {
            if (options.defect === 'drop' && change.operation === 'insert') continue;
            const delivered = options.defect === 'overflow-replace' && change.rowId.startsWith('overflow-')
              ? { ...frame, data: JSON.stringify({ ...change, rowId: 'substituted' }) }
              : frame;
            subscriber.callback(delivered);
            if (options.defect === 'duplicate') subscriber.callback(frame);
          }
          if (options.defect === 'overflow-leak' && change.rowId.startsWith('overflow-')) {
            for (const subscriber of listeners.get('app-b')?.values() ?? []) subscriber.callback(frame);
          }
      },
      pause() {},
      resume() {},
      async flush() { while (deliveries.length) deliveries.shift()!(); },
      cleanup() { disposed = true; listeners.clear(); active.delete(input.name); },
    };
    active.add(input.name);
    return port;
  };
}

describe('fake app realtime contract matrix', () => {
  test('SIM-APPRT: NexusEventBus public subscribe/publish path delivers and unsubscribes', () => {
    const bus = new NexusEventBus();
    const received: NexusEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event), ['nexus.']);
    const event: NexusEvent = { ts: 1, kind: 'nexus.boot', detail: { phase: 'test' } };
    bus.publish(event);
    unsubscribe();
    bus.publish({ ts: 2, kind: 'nexus.shutdown' });
    expect(received).toEqual([event]);
    expect(bus.size()).toBe(0);
  });

  test('SIM-APPRT: the matrix runs on the real NexusEventBus reference port and observes its frames and overflow', async () => {
    const observer = createNexusEventBusRealtimeObserver();
    await runFakeAppRealtimeMatrix(createNexusEventBusAppRealtimePortFactory({ observer }));
    expect(observer.busEvents.length).toBeGreaterThan(0);
    expect(observer.busEvents.every((event) => event.kind.startsWith('app.row.'))).toBe(true);
    expect(observer.busEvents.map((event) => event.kind)).toEqual(expect.arrayContaining(['app.row.insert', 'app.row.update', 'app.row.delete']));
    expect(observer.busEvents.some((event) => event.detail?.appSlug === 'app-b')).toBe(true);
    expect(observer.overflowClosed).toBe(1);
    expect(observer.replayed).toHaveLength(2);
    for (const frame of observer.replayed) {
      // Frame ids restart per scenario port, so match the carried event by id, kind and payload together.
      const carried = observer.busEvents.find((event) => String(event.detail?.id) === frame.id
        && event.kind === frame.event && event.detail?.data === frame.data);
      expect(carried).toBeDefined();
    }
    expect(observer.busSizeAfterCleanup).toEqual([0, 0, 0]);
  });

  test('SIM-APPRT: limits are explicit inputs, so the same matrix runs with another implementation\'s values', async () => {
    const observer = createNexusEventBusRealtimeObserver();
    await runFakeAppRealtimeMatrix(createNexusEventBusAppRealtimePortFactory({ observer }), { subscriberCount: 3, bufferLimit: 4, maxLatencyMs: 10 });
    expect(observer.overflowClosed).toBe(1);
    await expect(runFakeAppRealtimeMatrix(createNexusEventBusAppRealtimePortFactory(), { bufferLimit: 0 })).rejects.toThrow('bufferLimit must be a positive integer');
  });

  test('SIM-APPRT: matrix accepts a valid payload whose JSON key order and whitespace differ', async () => {
    await runFakeAppRealtimeMatrix(createPortFactory({ defect: 'reordered-keys' }));
  });

  test('SIM-APPRT: injected independent port runs exported cases and cleans up after failure', async () => {
    const active = new Set<string>();
    await runFakeAppRealtimeMatrix(createPortFactory({ active }));
    expect(active.size).toBe(0);
  });

  test('SIM-APPRT: matrix rejects a port that drops inserted events and still cleans it', async () => {
    const active = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect: 'drop', active }))).rejects.toThrow();
    expect(active.size).toBe(0);
  });

  test('SIM-APPRT: matrix rejects duplicate delivery and cleans every scenario', async () => {
    const active = new Set<string>();
    const attempted = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect: 'duplicate', active, attempted }))).rejects.toThrow();
    expect(active.size).toBe(0);
    expect(attempted.size).toBe(3);
  });

  test('SIM-APPRT: matrix accepts asynchronous delivery after flush', async () => {
    await runFakeAppRealtimeMatrix(createPortFactory({ asyncDelivery: true }));
  });

  test('SIM-APPRT: matrix rejects a no-op disconnect and cleans every scenario', async () => {
    const active = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect: 'disconnect-noop', active }))).rejects.toThrow();
    expect(active.size).toBe(0);
  });

  test.each(['replay-empty-id', 'replay-event', 'replay-payload'] as const)('SIM-APPRT: matrix rejects corrupted replay frame %s', async (defect) => {
    const active = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect, active }))).rejects.toThrow();
    expect(active.size).toBe(0);
  });

  test('SIM-APPRT: matrix rejects app-b leakage during each overflow stage', async () => {
    const active = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect: 'overflow-leak', active }))).rejects.toThrow();
    expect(active.size).toBe(0);
  });

  test('SIM-APPRT: matrix rejects substituted healthy overflow events and cleans every scenario', async () => {
    const active = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect: 'overflow-replace', active }))).rejects.toThrow();
    expect(active.size).toBe(0);
  });

  test.each(['slow-early-close', 'slow-unbounded'] as const)('SIM-APPRT: matrix rejects %s and cleans up', async (defect) => {
    const active = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect, active }))).rejects.toThrow();
    expect(active.size).toBe(0);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
  ] as const)('SIM-APPRT: %s thrown value is a failure and still cleans every scenario', async (_label, failureValue) => {
    const active = new Set<string>();
    const attempted = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect: 'publish', failWithFalsy: true, failureValue, active, attempted }))).rejects.toThrow();
    expect(active.size).toBe(0);
    expect(attempted.size).toBe(3);
  });

  test('SIM-APPRT: matrix attempts cleanup after port factory succeeds then publish fails', async () => {
    const active = new Set<string>();
    const attempted = new Set<string>();
    await expect(runFakeAppRealtimeMatrix(createPortFactory({ defect: 'publish', active, attempted }))).rejects.toThrow();
    expect(active.size).toBe(0);
    expect(attempted.size).toBe(3);
  });
});
