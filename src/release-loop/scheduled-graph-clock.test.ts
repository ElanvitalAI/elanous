import { expect, test } from 'bun:test';
import { scheduledGraphClock } from './scheduled-graph-clock.js';

const clock = { rehearsalAt: '2026-11-27T08:00+09:00', cutAt: '2026-11-27T09:00+09:00', publishAt: '2026-11-27T10:00+09:00' };

test('requires each explicit valid offset clock independently', () => {
  expect(scheduledGraphClock(clock)).toEqual({ ok: true, clock: {
    rehearsalAt: '2026-11-26T23:00:00.000Z', cutAt: '2026-11-27T00:00:00.000Z', publishAt: '2026-11-27T01:00:00.000Z',
  } });
  for (const field of ['rehearsalAt', 'cutAt', 'publishAt'] as const) {
    for (const value of [undefined, '', '2026-02-30T08:00+09:00', '2026-11-27T08:00']) {
      expect(scheduledGraphClock({ ...clock, [field]: value })).toEqual({ ok: false, reason: `${field} is missing or invalid` });
    }
  }
});

test('orders instants rather than local wall times across offsets', () => {
  expect(scheduledGraphClock({
    rehearsalAt: '2026-11-27T09:00+09:00',
    cutAt: '2026-11-27T02:00+01:00',
    publishAt: '2026-11-26T19:00-07:00',
  })).toEqual({ ok: true, clock: {
    rehearsalAt: '2026-11-27T00:00:00.000Z',
    cutAt: '2026-11-27T01:00:00.000Z',
    publishAt: '2026-11-27T02:00:00.000Z',
  } });
});

test('rejects equal or reversed schedule instants across offsets', () => {
  for (const bad of [
    { ...clock, rehearsalAt: '2026-11-27T00:00Z' },
    { ...clock, rehearsalAt: '2026-11-27T00:01Z' },
    { ...clock, publishAt: '2026-11-27T00:00Z' },
    { ...clock, publishAt: '2026-11-26T23:59Z' },
  ]) {
    expect(scheduledGraphClock(bad)).toEqual({ ok: false, reason: 'expected rehearsalAt < cutAt < publishAt' });
  }
});
