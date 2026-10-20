import { describe, expect, test } from 'bun:test';
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

  test('uses only measured physical host and tier caps', () => {
    expect(resolveWarmPoolQuota('fixed', 'node-b', 'standard')).toBe(16);
    expect(resolveWarmPoolQuota('gate', 'node-c', 'standard')).toBe(4);
    expect(resolveWarmPoolQuota('landing', 'host-e-wsl', 'standard')).toBe(5);
    expect(resolveWarmPoolQuota('fixed', 'mbp', 'lite')).toBe(7);
    expect(resolveWarmPoolQuota('fixed', 'mbp', 'standard')).toBe(0);
    expect(resolveWarmPoolQuota('fixed', 'node-c', 'lite')).toBe(0);
    expect(resolveWarmPoolQuota('fixed', 'unknown-host', 'standard')).toBe(0);
  });

});
