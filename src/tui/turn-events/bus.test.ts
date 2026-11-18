import { describe, expect, test } from 'bun:test';
import { createTurnEventBus } from './bus.js';
import { debug } from '../../debug/log.js';
import type { LogRecord } from '../../mss/logging/record.js';
import type { TurnEvent } from '../../turn-capsule/contract.js';

const event = (id: string, source: TurnEvent['source'], arrivedAt = 1, dedupeKey = id): TurnEvent =>
  ({ id, source, dedupeKey, arrivedAt, text: id });

describe('turn event bus', () => {
  test('orders by priority, arrival and id and does not drop late events', () => {
    const bus = createTurnEventBus();
    for (const e of [event('w', 'watch'), event('m', 'mail'), event('c', 'capsule-done'),
      event('z', 'human', 2), event('a', 'human', 2), event('h', 'human', 1),
      { ...event('u', 'wakeup'), deliverBy: 0 }, event('urgent', 'urgent-mail')]) bus.publish(e);
    expect(bus.pending().map(e => e.id)).toEqual(['h', 'a', 'z', 'urgent', 'c', 'u', 'm', 'w']);
    expect(bus.take(2).map(e => e.id)).toEqual(['h', 'a']);
    expect(bus.pending().map(e => e.id)).toEqual(['z', 'urgent', 'c', 'u', 'm', 'w']);
  });
  test('deduplicates across waiting, in-flight and responded', () => {
    const bus = createTurnEventBus();
    expect(bus.publish(event('one', 'mail', 1, 'mail:1'))).toEqual({ duplicate: false });
    expect(bus.publish(event('two', 'mail', 2, 'mail:1'))).toEqual({ duplicate: true });
    bus.take(1);
    expect(bus.publish(event('three', 'mail', 3, 'mail:1'))).toEqual({ duplicate: true });
    bus.ack(['one'], 'responded');
    expect(bus.publish(event('four', 'mail', 4, 'mail:1'))).toEqual({ duplicate: true });
    expect(bus.pending()).toEqual([]);
  });
  test('cancelled and stopped are immediately retried; failed backs off', () => {
    let clock = 1000;
    const bus = createTurnEventBus({ now: () => clock, backoffMs: () => 500 });
    bus.publish(event('a', 'mail')); bus.publish(event('b', 'watch')); bus.publish(event('c', 'wakeup'));
    bus.take(3); bus.ack(['a'], 'cancelled'); bus.ack(['b'], 'stopped'); bus.ack(['c'], 'failed');
    expect(bus.pending().map(e => e.id)).toEqual(['a', 'b']);
    expect(bus.take(3).map(e => e.id)).toEqual(['a', 'b']);
    clock = 1499; expect(bus.pending()).toEqual([]);
    clock = 1500; expect(bus.pending().map(e => e.id)).toEqual(['c']);
  });
  test('turn-life observation has correlation ids and cannot disrupt delivery', () => {
    const seen: Array<{ name: string; data: Record<string, unknown> }> = [];
    const bus = createTurnEventBus({ log: (name, data) => { seen.push({ name, data }); throw new Error('sink'); } });
    bus.publish(event('mail-7', 'mail')); bus.take(1); bus.ack(['mail-7'], 'responded');
    expect(seen).toEqual([
      { name: 'turn-life:event-queued', data: { eventId: 'mail-7', source: 'mail' } },
      { name: 'turn-life:event-dequeued', data: { eventId: 'mail-7', source: 'mail' } },
      { name: 'turn-life:event-acked', data: { eventId: 'mail-7', source: 'mail', outcome: 'responded' } },
    ]);
    expect(bus.pending()).toEqual([]);
  });
  test('default sink emits the canonical names and correlation ID', () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({ name: 'bus-lifecycle-test', emit: (record) => records.push(record) });
    debug.enable();
    try {
      const bus = createTurnEventBus();
      bus.publish(event('event-42', 'mail')); bus.take(1); bus.ack(['event-42'], 'responded');
      expect(records.filter(r => r.category === 'turn-life').map(r => [r.event, (r.data as { eventId?: unknown } | undefined)?.eventId])).toEqual([
        ['turn-life:event-queued', 'event-42'], ['turn-life:event-dequeued', 'event-42'], ['turn-life:event-acked', 'event-42'],
      ]);
    } finally { off(); debug.disable(); }
  });
  test('unknown acknowledgements do nothing and invalid take never removes events', () => {
    const bus = createTurnEventBus(); bus.publish(event('a', 'human'));
    bus.ack(['a', 'missing'], 'responded');
    expect(bus.take(0)).toEqual([]); expect(bus.take(-1)).toEqual([]); expect(bus.take(NaN)).toEqual([]);
    expect(bus.pending().map(e => e.id)).toEqual(['a']);
    expect(bus.take(1).map(e => e.id)).toEqual(['a']);
    bus.ack(['a'], 'responded'); expect(bus.pending()).toEqual([]);
  });
});
