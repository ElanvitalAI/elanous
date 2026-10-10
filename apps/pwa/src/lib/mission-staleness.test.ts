import { describe, expect, it } from 'bun:test';
import { missionStaleness } from './mission-staleness';

const now = Date.parse('2026-10-09T03:00:00Z');
const options = { timeZone: 'Asia/Seoul', status: 'running' };

describe('missionStaleness', () => {
  it('marks a running mission last updated 89 days ago as stale in Seoul time', () => {
    expect(missionStaleness(Date.parse('2026-07-12T03:00:00Z'), now, options)).toEqual({
      stale: true, days: 89, lastUpdated: '2026-07-12',
    });
  });

  it('keeps a mission updated 13 days ago fresh', () => {
    expect(missionStaleness(now - 13 * 86_400_000, now, options)).toEqual({
      stale: false, days: 13, lastUpdated: '2026-09-26',
    });
  });

  it('does not call a closed mission stale', () => {
    for (const status of ['done', 'failed', 'disarmed', 'rejected', 'completed', 'cancelled']) {
      expect(missionStaleness(Date.parse('2026-07-12T03:00:00Z'), now, { ...options, status })?.stale).toBe(false);
    }
  });

  it('returns null for missing or non-finite updates', () => {
    expect(missionStaleness(undefined, now, options)).toBeNull();
    expect(missionStaleness(Number.NaN, now, options)).toBeNull();
    expect(missionStaleness(Infinity, now, options)).toBeNull();
    expect(missionStaleness(Number.MAX_VALUE, now, options)).toBeNull();
  });

  it('uses a 14-day default threshold and accepts an override', () => {
    const updatedAt = now - 14 * 86_400_000;
    expect(missionStaleness(updatedAt, now, options)?.stale).toBe(true);
    expect(missionStaleness(updatedAt, now, { ...options, thresholdDays: 15 })?.stale).toBe(false);
  });
});
