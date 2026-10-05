import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_REQUEST_AGE_HOURS, seatRequestEligibility } from './seat-request-eligibility.js';

const now = new Date('2026-10-05T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60_000).toISOString();
const request = (text: string, hours = 1) => ({ text, queuedAt: hoursAgo(hours) });

describe('seat request eligibility', () => {
  test('rejects an empty or whitespace-only body', () => {
    for (const body of ['', ' \n\t ']) {
      expect(seatRequestEligibility(request(body), { now })).toEqual({ eligible: false, reason: 'empty-body' });
    }
  });

  test('defaults to a 48-hour age limit, inclusive at its boundary', () => {
    expect(DEFAULT_MAX_REQUEST_AGE_HOURS).toBe(48);
    expect(seatRequestEligibility(request('do it', 48), { now })).toEqual({ eligible: true });
    expect(seatRequestEligibility(request('do it', 48 + 1 / 3_600_000), { now })).toEqual({ eligible: false, reason: 'too-old' });
    expect(seatRequestEligibility({ text: 'do it', queuedAt: 'invalid' }, { now })).toEqual({ eligible: false, reason: 'too-old' });
  });

  test('uses a configured age limit instead of the default', () => {
    expect(seatRequestEligibility(request('do it', 3), { now, maxRequestAgeHours: 2 })).toEqual({ eligible: false, reason: 'too-old' });
    expect(seatRequestEligibility(request('do it', 3), { now, maxRequestAgeHours: 4 })).toEqual({ eligible: true });
    expect(() => seatRequestEligibility(request('do it'), { now, maxRequestAgeHours: -1 })).toThrow('invalid seat request max age hours');
  });

  test('rejects a request targeting a green or done slot', () => {
    for (const slotStatus of ['green', 'done']) {
      expect(seatRequestEligibility(request('do it'), { now, slotStatus })).toEqual({ eligible: false, reason: 'slot-closed' });
    }
  });

  test('unreadable or missing slot status does not falsely assert a closed slot', () => {
    for (const slotStatus of [undefined, null, 'unreadable', 'yellow', 'red']) {
      expect(seatRequestEligibility(request('do it'), { now, slotStatus })).toEqual({ eligible: true });
    }
  });
});
