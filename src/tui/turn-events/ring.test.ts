import { describe, expect, test } from 'bun:test';
import { createTurnEventRing } from './ring.js';

describe('completed turn-event history', () => {
  test('keeps the newest 200 in insertion order and reports evictions', () => {
    const logs: Array<{ name: string; data: Record<string, unknown> }> = [];
    const ring = createTurnEventRing({ log: (name, data) => logs.push({ name, data }) });
    for (let n = 0; n < 203; n++) ring.record({ id: `event-${n}`, outcome: 'responded' });
    const history = ring.snapshot();
    expect(history.rows.length).toBe(200);
    expect(history.rows[0]).toEqual({ id: 'event-3', outcome: 'responded' });
    expect(history.rows[199]).toEqual({ id: 'event-202', outcome: 'responded' });
    expect(history.evicted).toBe(3);
    expect(logs.map(log => [log.name, log.data.eventId])).toEqual([
      ['event-history-evicted', 'event-0'], ['event-history-evicted', 'event-1'], ['event-history-evicted', 'event-2'],
    ]);
  });

  test('only responded entries enter history; callers cannot mutate stored entries', () => {
    const ring = createTurnEventRing();
    expect(ring.record({ id: 'a', outcome: 'failed' })).toBe(false);
    expect(ring.record({ id: 'b', outcome: 'cancelled' })).toBe(false);
    expect(ring.record({ id: 'c', outcome: 'stopped' })).toBe(false);
    expect(ring.record({ id: 'd', outcome: 'responded' })).toBe(true);
    const result = ring.snapshot();
    expect(result).toEqual({ rows: [{ id: 'd', outcome: 'responded' }], evicted: 0 });
    result.rows[0]!.id = 'changed';
    expect(ring.snapshot().rows).toEqual([{ id: 'd', outcome: 'responded' }]);
  });
});
