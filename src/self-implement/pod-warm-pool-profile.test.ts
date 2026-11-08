import { describe, expect, test } from 'bun:test';
import { withSimClock } from '../ux-sim/fake-clock.js';
import {
  deriveWarmPoolPhaseRatios,
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

  test('applies measured phase shares within host caps and keeps unmeasured phases closed', () => {
    expect(resolveWarmPoolQuota('fixed', 'node-b', 'standard')).toBe(16);
    expect(resolveWarmPoolQuota('gate', 'node-c', 'standard')).toBe(4);
    expect(resolveWarmPoolQuota('landing', 'host-e-wsl', 'standard')).toBe(0);
    for (const host of ['gcp1', 'aws1', 'aws2']) {
      expect(resolveWarmPoolQuota('fixed', host, 'standard')).toBe(2);
      expect(resolveWarmPoolQuota('gate', host, 'standard')).toBe(2);
      expect(resolveWarmPoolQuota('landing', host, 'standard')).toBe(0);
      expect(resolveWarmPoolQuota('feature', host, 'lite')).toBe(0);
    }
    expect(resolveWarmPoolQuota('fixed', 'mbp', 'lite')).toBe(7);
    expect(resolveWarmPoolQuota('fixed', 'mbp', 'standard')).toBe(0);
    expect(resolveWarmPoolQuota('fixed', 'node-c', 'lite')).toBe(0);
    expect(resolveWarmPoolQuota('fixed', 'unknown-host', 'standard')).toBe(0);
  });

  test('simulates the 0.3.6 cut-ledger phase share before applying it to quotas', async () => {
    // Actual 2026-11-07 cut 3cb140ec: latest rows for 82 shard IDs include 70
    // executed attempts (16,673.530 shard-seconds) and 12 reused receipts excluded.
    // The ledger has cut only; this is an execution-time proxy, not Pod occupancy.
    const ratios = deriveWarmPoolPhaseRatios([{ phase: 'cut', shardSeconds: 16_673.53 }]);
    expect(ratios).toEqual({ gate: 1, landing: 0, feature: 0 });
    expect(resolveWarmPoolQuota('gate', 'aws1', 'standard')).toBe(2);
    expect(resolveWarmPoolQuota('landing', 'aws1', 'standard')).toBe(0);
    expect(resolveWarmPoolQuota('feature', 'aws1', 'standard')).toBe(0);
    expect(deriveWarmPoolPhaseRatios([
      { phase: 'cut', shardSeconds: 10 },
      { phase: 'landing', shardSeconds: 30 },
      { phase: 'feature', shardSeconds: 60 },
    ])).toEqual({ gate: 0.1, landing: 0.3, feature: 0.6 });
    expect(deriveWarmPoolPhaseRatios([{ phase: 'cut', shardSeconds: Number.NaN }]))
      .toEqual({ gate: 0, landing: 0, feature: 0 });

    await withSimClock(Date.parse('2026-11-04T15:00:00.000Z'), clock => {
      const simulatedShards = [
        { phase: 'cut' as const, durationMs: 10_000 },
        { phase: 'landing' as const, durationMs: 30_000 },
        { phase: 'feature' as const, durationMs: 60_000 },
      ];
      const samples = simulatedShards.map(({ phase, durationMs }) => {
        const startedAt = clock.now();
        clock.setTime(startedAt + durationMs);
        return { phase, shardSeconds: (clock.now() - startedAt) / 1_000 };
      });
      const simulatedRatios = deriveWarmPoolPhaseRatios(samples);
      expect(samples.map(sample => sample.shardSeconds)).toEqual([10, 30, 60]);
      expect(simulatedRatios).toEqual({ gate: 0.1, landing: 0.3, feature: 0.6 });
      expect(resolveWarmPoolQuota('gate', 'node-b', 'standard', simulatedRatios)).toBe(1);
      expect(resolveWarmPoolQuota('landing', 'node-b', 'standard', simulatedRatios)).toBe(4);
      expect(resolveWarmPoolQuota('feature', 'node-b', 'standard', simulatedRatios)).toBe(9);
      expect(clock.now() - Date.parse('2026-11-04T15:00:00.000Z')).toBe(100_000);
    });
  });

});
