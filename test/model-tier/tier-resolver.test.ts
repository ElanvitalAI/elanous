// M1-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// Resolver precedence tests. Verifies surface-override > preset >
// profile > default.

import { describe, expect, test } from 'bun:test';
import { resolveSttTier, DEFAULT_MODEL_TIER } from '../../src/model-tier/index.js';

describe('M1-1 · resolveSttTier', () => {
  test('undefined config → default tier · source = "default"', () => {
    const r = resolveSttTier(undefined);
    expect(r.tier).toBe(DEFAULT_MODEL_TIER);
    expect(r.source).toBe('default');
    expect(r.provider).toBe('openai-realtime-stt');
    expect(r.model).toBe('gpt-4o-mini-transcribe');
  });

  test('empty modelTier → default tier · source = "default"', () => {
    const r = resolveSttTier({});
    expect(r.tier).toBe(DEFAULT_MODEL_TIER);
    expect(r.source).toBe('default');
  });

  test('profile alone → balanced default · source = "profile"', () => {
    const r = resolveSttTier({ profile: 'casual' });
    expect(r.tier).toBe(DEFAULT_MODEL_TIER);
    expect(r.source).toBe('profile');
  });

  test('preset alone → default tier · source = "preset" (Phase 2 catalog stub)', () => {
    const r = resolveSttTier({ preset: 'medical_dictation' });
    expect(r.tier).toBe(DEFAULT_MODEL_TIER);
    expect(r.source).toBe('preset');
  });

  test('surface override wins over preset + profile', () => {
    const r = resolveSttTier({
      profile: 'power',
      preset: 'casual_chat',
      voice: { stt: 'best' },
    });
    expect(r.tier).toBe('best');
    expect(r.source).toBe('user-config-surface');
    expect(r.model).toBe('gpt-realtime-whisper');
  });

  test('loaded surface override resolves to gpt-realtime-whisper + surcharge', () => {
    const r = resolveSttTier({ voice: { stt: 'loaded' } });
    expect(r.tier).toBe('loaded');
    expect(r.model).toBe('gpt-realtime-whisper');
    expect(r.loadedExtraUsdPerMin).toBeGreaterThan(0);
  });

  test('budget surface override surfaces wip status', () => {
    const r = resolveSttTier({ voice: { stt: 'budget' } });
    expect(r.tier).toBe('budget');
    expect(r.status).toBe('wip');
    expect(r.provider).toBe('whisper-cpp-local');
  });
});
