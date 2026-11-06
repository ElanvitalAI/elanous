import { describe, expect, test } from 'bun:test';
import { withSimClock } from '../ux-sim/fake-clock.js';
import {
  isWarmPoolProfile,
  resolveWarmPoolProfile,
  resolveWarmPoolQuota,
} from './pod-warm-pool-profile.js';

describe('warm-pool profile', () => {
  test('accepts only the declared profile vocabulary', () => {
    expect(['fixed', 'gate', 'landing', 'feature'].every(isWarmPoolProfile)).toBe(true);
    expect(isWarmPoolProfile('unknown')).toBe(false);
    expect(isWarmPoolProfile(null)).toBe(false);
  });

  test('resolves pod.warmPoolProfile and defaults invalid or missing values to fixed', () => {
    expect(resolveWarmPoolProfile({ pod: { warmPoolProfile: 'gate' } })).toBe('gate');
    expect(resolveWarmPoolProfile({ pod: { warmPoolProfile: 'invalid' } })).toBe('fixed');
    expect(resolveWarmPoolProfile({})).toBe('fixed');
    expect(resolveWarmPoolProfile({ pod: null })).toBe('fixed');
    expect(resolveWarmPoolProfile({ pod: {}, raw: { pod: { warmPoolProfile: 'feature' } } })).toBe('feature');
  });

  test('applies standard host caps across profiles and keeps other tiers closed', () => {
    expect(resolveWarmPoolQuota('fixed', 'node-b', 'standard')).toBe(16);
    expect(resolveWarmPoolQuota('gate', 'node-c', 'standard')).toBe(4);
    expect(resolveWarmPoolQuota('landing', 'host-e-wsl', 'standard')).toBe(5);
    for (const host of ['gcp1', 'aws1', 'aws2']) {
      for (const profile of ['fixed', 'gate', 'landing', 'feature'] as const) {
        expect(resolveWarmPoolQuota(profile, host, 'standard')).toBe(2);
      }
      expect(resolveWarmPoolQuota('feature', host, 'lite')).toBe(0);
    }
    expect(resolveWarmPoolQuota('fixed', 'mbp', 'lite')).toBe(7);
    expect(resolveWarmPoolQuota('fixed', 'mbp', 'standard')).toBe(0);
    expect(resolveWarmPoolQuota('fixed', 'node-c', 'lite')).toBe(0);
    expect(resolveWarmPoolQuota('fixed', 'unknown-host', 'standard')).toBe(0);
  });

  test('replays observed phase signals on a fake clock without inventing a quota ratio', async () => {
    // Snapshot from prod pod.warm evidence-supplied events: 25 requests per
    // consumer (ta, land, gate-recheck), all marked measured:false. These are
    // event counts, not concurrent ready/leased worker demand.
    const observedSignals = [
      { phase: 'feature' as const, profile: 'feature' as const, requests: 25, atMs: 0 },
      { phase: 'landing' as const, profile: 'landing' as const, requests: 25, atMs: 3.5 * 60 * 60_000 },
      { phase: 'gate-window' as const, profile: 'gate' as const, requests: 25, atMs: 4.5 * 60 * 60_000 },
    ];
    await withSimClock(Date.parse('2026-11-04T15:00:00.000Z'), clock => {
      const replayed: Array<{ phase: string; requests: number; quota: number; time: number }> = [];
      for (const signal of observedSignals) {
        clock.setTime(Date.parse('2026-11-04T15:00:00.000Z') + signal.atMs);
        replayed.push({ phase: signal.phase, requests: signal.requests,
          quota: resolveWarmPoolQuota(signal.profile, 'node-b', 'standard'), time: clock.now() });
      }
      expect(replayed.map(({ phase, requests }) => [phase, requests])).toEqual([
        ['feature', 25], ['landing', 25], ['gate-window', 25],
      ]);
      expect(replayed.map(({ quota }) => quota)).toEqual([16, 16, 16]);
      expect(replayed[2]!.time - replayed[0]!.time).toBe(4.5 * 60 * 60_000);
    });
  });

});
