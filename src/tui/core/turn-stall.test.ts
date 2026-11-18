import { expect, test } from 'bun:test';
import { createTurnStallWatch, stallMinutes, TURN_STALL_LIMIT_MS } from './turn-stall.js';

const clock = (start = 0) => { let at = start; return { now: () => at, advance: (ms: number) => { at += ms; } }; };

test('silence beyond the limit with nothing running is a stall; any touch resets it', () => {
  const time = clock();
  const watch = createTurnStallWatch({ now: time.now });
  time.advance(TURN_STALL_LIMIT_MS - 1);
  expect(watch.check({ running: 0 })).toEqual({ stalled: false });
  watch.touch();
  time.advance(TURN_STALL_LIMIT_MS - 1);
  expect(watch.check({ running: 0 }).stalled).toBe(false);
  time.advance(1);
  expect(watch.check({ running: 0 })).toEqual({ stalled: true, idleMs: TURN_STALL_LIMIT_MS });
});

test('running tools, shells and agents are expected to be quiet and never count as a stall', () => {
  const time = clock();
  const shortLimit = TURN_STALL_LIMIT_MS / TURN_STALL_LIMIT_MS;
  const watch = createTurnStallWatch({ now: time.now, limitMs: shortLimit });
  time.advance(shortLimit * 10);
  expect(watch.check({ running: 1 })).toEqual({ stalled: false });
  // Once the work is done the silence is measured from the last touch, which has not moved.
  expect(watch.check({ running: 0 }).stalled).toBe(true);
});

test('a custom limit is honoured and minutes are reported as whole numbers, at least one', () => {
  const time = clock();
  const customLimit = TURN_STALL_LIMIT_MS / 10;
  const watch = createTurnStallWatch({ now: time.now, limitMs: customLimit });
  time.advance(customLimit);
  const verdict = watch.check({ running: 0 });
  expect(verdict.stalled).toBe(true);
  expect(stallMinutes(verdict.stalled ? verdict.idleMs : 0)).toBe(Math.floor(customLimit / (TURN_STALL_LIMIT_MS / 15)));
  const sub = TURN_STALL_LIMIT_MS / 100;
  expect(stallMinutes(sub)).toBe(Math.max(1, Math.floor(sub / (TURN_STALL_LIMIT_MS / 15))));
});
