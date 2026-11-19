import { describe, expect, test } from 'bun:test';
import type { TurnEvent } from '../../turn-capsule/contract.js';
import { createTurnEventBus } from './bus.js';
import { createWakeupBusConsumer, openLateWakeupTurn, parseWakeupKey, type LateWakeupTurnDeps, type WakeupView } from './wakeup-consumer.js';

/** The events schedule-wakeup.ts publishes (:470 base · :545 late), as literals. */
const base = (id: string, n: number, at: number): TurnEvent => ({
  id: `wakeup-${id}-${n}`, source: 'wakeup', dedupeKey: `wakeup:${id}:${n}`, arrivedAt: at, text: `⏰ ${id}`,
});
const late = (id: string, n: number, at: number): TurnEvent => ({
  id: `wakeup-${id}-${n}-late`, source: 'wakeup', dedupeKey: `wakeup:${id}:${n}:late`, arrivedAt: at, text: `⏰ ${id} (late)`,
});

function rig(views: WakeupView[]) {
  let clock = 1_000;
  const bus = createTurnEventBus({ now: () => clock, log: () => {}, backoffMs: () => 5_000 });
  const consumer = createWakeupBusConsumer({ bus, wakeups: () => views });
  return { bus, consumer, views, tick: (ms: number) => { clock += ms; } };
}

describe('parseWakeupKey', () => {
  test('base and late keys; anything else is null', () => {
    expect(parseWakeupKey('wakeup:w-7:0')).toEqual({ id: 'w-7', fireCount: 0, late: false });
    expect(parseWakeupKey('wakeup:w-7:3:late')).toEqual({ id: 'w-7', fireCount: 3, late: true });
    expect(parseWakeupKey('msg:42')).toBeNull();
  });
});

describe('O2 bus consumer — late one-shots are delivered, never doubled', () => {
  test('a one-shot that exhausted its retries (late, still held at the same fire count) is delivered once', () => {
    const r = rig([{ id: 'w-1', fireCount: 0 }]);
    r.bus.publish(base('w-1', 0, 1));
    r.bus.publish(late('w-1', 0, 2));
    const event = r.consumer.next();
    expect(event?.id).toBe('wakeup-w-1-0-late');
    // in flight: no second delivery while its turn runs
    expect(r.consumer.next()).toBeNull();
    r.consumer.settle('wakeup-w-1-0-late', 'responded');
    // the caller cancels the scheduler's one-shot after the turn opened → the entry is gone → the base copy resolves
    r.views.length = 0;
    expect(r.consumer.next()).toBeNull();
    expect(r.bus.pending()).toEqual([]);
  });

  test('#38794 must — the scheduler already fired it directly (fireCount moved on): base and late resolve, no turn', () => {
    const r = rig([{ id: 'w-2', fireCount: 1 }]);
    r.bus.publish(base('w-2', 0, 1));
    r.bus.publish(late('w-2', 0, 2));
    expect(r.consumer.next()).toBeNull();
    expect(r.bus.pending()).toEqual([]);
  });

  test('a cancelled or fired one-shot (entry gone) never opens a turn from the bus', () => {
    const r = rig([]);
    r.bus.publish(late('w-3', 0, 1));
    expect(r.consumer.next()).toBeNull();
    expect(r.bus.pending()).toEqual([]);
  });

  test('a base item the scheduler still retries goes back to waiting (its retries belong to the scheduler)', () => {
    const r = rig([{ id: 'w-4', fireCount: 0 }]);
    r.bus.publish(base('w-4', 0, 1));
    expect(r.consumer.next()).toBeNull();
    expect(r.bus.pending().map((event) => event.id)).toEqual(['wakeup-w-4-0']);
  });

  test('one delivery at a time; the next late item waits for the first to settle', () => {
    const r = rig([{ id: 'a', fireCount: 0 }, { id: 'b', fireCount: 0 }]);
    r.bus.publish(late('a', 0, 1));
    r.bus.publish(late('b', 0, 2));
    expect(r.consumer.next()?.id).toBe('wakeup-a-0-late');
    expect(r.consumer.next()).toBeNull();
    r.consumer.settle('wakeup-a-0-late', 'responded');
    expect(r.consumer.next()?.id).toBe('wakeup-b-0-late');
  });

  test('a person cancels the turn (Esc) → the late wakeup is offered again at once; a failure waits out its backoff', () => {
    const r = rig([{ id: 'w-5', fireCount: 0 }]);
    r.bus.publish(late('w-5', 0, 1));
    r.consumer.settle(r.consumer.next()!.id, 'cancelled');
    expect(r.consumer.next()?.id).toBe('wakeup-w-5-0-late');
    r.consumer.settle('wakeup-w-5-0-late', 'failed');
    expect(r.consumer.next()).toBeNull();
    r.tick(5_000); // 출처: #38875 bus backoff option — this rig uses a 5 s backoff
    expect(r.consumer.next()?.id).toBe('wakeup-w-5-0-late');
  });

  test('a settle for an event not in flight changes nothing', () => {
    const r = rig([{ id: 'w-6', fireCount: 0 }]);
    r.bus.publish(late('w-6', 0, 1));
    r.consumer.settle('wakeup-w-6-0-late', 'responded');
    expect(r.consumer.next()?.id).toBe('wakeup-w-6-0-late');
  });

  test('other sources on the shared bus (mail) are handed back untouched, never left in flight', () => {
    const r = rig([{ id: 'w-7', fireCount: 0 }]);
    r.bus.publish({ id: 'mail-42', source: 'mail', dedupeKey: 'mail:42', arrivedAt: 1, text: 'mail 42' });
    r.bus.publish(late('w-7', 0, 2));
    expect(r.consumer.next()?.id).toBe('wakeup-w-7-0-late');
    expect(r.bus.pending().map((event) => event.id)).toEqual(['mail-42']);
  });

  test('higher sources (urgent-mail · capsule-done) ahead of it never push the wakeup out, and stay waiting', () => {
    const r = rig([{ id: 'w-8', fireCount: 0 }]);
    for (let i = 0; i < 20; i++) r.bus.publish({ id: `u-${i}`, source: 'urgent-mail', dedupeKey: `mail:u${i}`, arrivedAt: 1, text: 'urgent' });
    r.bus.publish({ id: 'cap-1', source: 'capsule-done', dedupeKey: 'capsule:1', arrivedAt: 1, text: 'done' });
    r.bus.publish(late('w-8', 0, 2));
    expect(r.consumer.next()?.id).toBe('wakeup-w-8-0-late');
    expect(r.bus.pending().length).toBe(21);
    expect(r.bus.pending().every((event) => event.source !== 'wakeup')).toBe(true);
  });
});

describe('JUD-B must 2 — only the exact slot is deliverable', () => {
  test('a fire count ahead of the scheduler (key 1, scheduler 0) is not opened — it waits', () => {
    const r = rig([{ id: 'w-1', fireCount: 0 }]);
    r.bus.publish(late('w-1', 1, 1));
    expect(r.consumer.next()).toBeNull();
    expect(r.bus.pending().map((event) => event.id)).toEqual(['wakeup-w-1-1-late']);
  });

  test('an older slot of a repeat (same count, deliverBy of an earlier dueAt) is resolved, never opened', () => {
    const r = rig([{ id: 'w-2', fireCount: 0, deliverBy: 9_000 }]);
    r.bus.publish({ ...late('w-2', 0, 1), deliverBy: 5_000 });
    expect(r.consumer.next()).toBeNull();
    expect(r.bus.pending()).toEqual([]);
  });

  test('the same slot (deliverBy matches) is delivered', () => {
    const r = rig([{ id: 'w-3', fireCount: 0, deliverBy: 9_000 }]);
    r.bus.publish({ ...late('w-3', 0, 1), deliverBy: 9_000 });
    expect(r.consumer.next()?.id).toBe('wakeup-w-3-0-late');
  });
});

describe('JUD-B must 1 — openLateWakeupTurn: start first, cancel the scheduler copy only once the turn runs', () => {
  function turnRig(opts: { throws?: boolean; runs?: boolean; cancelOk?: boolean }) {
    const r = rig([{ id: 'w-9', fireCount: 0 }]);
    r.bus.publish(late('w-9', 0, 1));
    const calls: string[] = [];
    let tracked: string | null = 'unset';
    const deps: LateWakeupTurnDeps = {
      consumer: r.consumer,
      start: (event) => { calls.push(`start:${event.id}`); if (opts.throws) throw new Error('boom'); },
      running: () => opts.runs ?? true,
      cancel: (id) => { calls.push(`cancel:${id}`); return opts.cancelOk ?? true; },
      abort: () => { calls.push('abort'); },
      track: (id) => { tracked = id; },
    };
    return { r, calls, deps, tracked: () => tracked };
  }

  test('opened: start, then cancel the scheduler copy; the turn end settles it', () => {
    const t = turnRig({});
    expect(openLateWakeupTurn(t.deps)).toBe('opened');
    expect(t.calls).toEqual(['start:wakeup-w-9-0-late', 'cancel:w-9']);
    expect(t.tracked()).toBe('wakeup-w-9-0-late');
  });

  test('start throws before the turn runs: the scheduler entry is kept (no cancel) and the item can be retried', () => {
    const t = turnRig({ throws: true });
    expect(openLateWakeupTurn(t.deps)).toBe('start-failed');
    expect(t.calls).toEqual(['start:wakeup-w-9-0-late']);
    expect(t.tracked()).toBeNull();
    expect(t.r.consumer.next()?.id).toBe('wakeup-w-9-0-late');
  });

  test('the door did not open the turn: no cancel, the item goes back', () => {
    const t = turnRig({ runs: false });
    expect(openLateWakeupTurn(t.deps)).toBe('not-started');
    expect(t.calls).toEqual(['start:wakeup-w-9-0-late']);
    expect(t.r.consumer.next()?.id).toBe('wakeup-w-9-0-late');
  });

  test('the scheduler refuses the cancel: this delivery is given up (turn stopped, bus item done) — the scheduler fires it', () => {
    const t = turnRig({ cancelOk: false });
    expect(openLateWakeupTurn(t.deps)).toBe('cancel-refused');
    expect(t.calls).toEqual(['start:wakeup-w-9-0-late', 'cancel:w-9', 'abort']);
    expect(t.tracked()).toBeNull();
    expect(t.r.consumer.next()).toBeNull();
    expect(t.r.bus.pending()).toEqual([]);
  });
});
