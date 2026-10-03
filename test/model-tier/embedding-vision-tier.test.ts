// M3-2 (Phase 3) — Embedding + Vision tier map / resolver tests.

import { describe, expect, test } from 'bun:test';
import {
  EMBEDDING_TIER_MAP_BY_PROVIDER,
  MODEL_TIERS,
  VISION_TIER_MAP_BY_PROVIDER,
  lookupEmbeddingTierSpec,
  lookupVisionTierSpec,
  resolveEmbeddingTier,
  resolveVisionTier,
} from '../../src/model-tier/index.js';

describe('M3-2 · EMBEDDING_TIER_MAP_BY_PROVIDER · shape invariants', () => {
  test('every provider has all 5 ticks · monotone usdPer1MTokens (non-decreasing within provider)', () => {
    const providers = Object.keys(EMBEDDING_TIER_MAP_BY_PROVIDER) as Array<
      keyof typeof EMBEDDING_TIER_MAP_BY_PROVIDER
    >;
    for (const p of providers) {
      const map = EMBEDDING_TIER_MAP_BY_PROVIDER[p];
      for (const tier of MODEL_TIERS) {
        expect(map[tier]).toBeDefined();
        expect(map[tier]!.model).not.toBe('');
        expect(map[tier]!.dim).toBeGreaterThan(0);
      }
      let prev = -1;
      for (const tier of MODEL_TIERS) {
        const cost = map[tier]!.usdPer1MTokens;
        // local always 0; others monotone non-decreasing.
        expect(cost).toBeGreaterThanOrEqual(prev === -1 ? 0 : prev);
        prev = cost;
      }
    }
  });

  test('loaded tier sets extraReranker on every provider', () => {
    for (const p of Object.values(EMBEDDING_TIER_MAP_BY_PROVIDER)) {
      expect(p.loaded.extraReranker).toBe(true);
    }
  });

  test('local provider is $0 across all ticks', () => {
    for (const tier of MODEL_TIERS) {
      expect(EMBEDDING_TIER_MAP_BY_PROVIDER.local[tier].usdPer1MTokens).toBe(0);
    }
  });
});

describe('M3-2 · VISION_TIER_MAP_BY_PROVIDER · shape invariants', () => {
  test('every provider has all 5 ticks · loaded extraReasoning=true', () => {
    for (const p of Object.values(VISION_TIER_MAP_BY_PROVIDER)) {
      for (const tier of MODEL_TIERS) {
        expect(p[tier]).toBeDefined();
        expect(p[tier]!.model).not.toBe('');
      }
      expect(p.loaded.extraReasoning).toBe(true);
    }
  });

  test('anthropic price ladder is monotone', () => {
    const a = VISION_TIER_MAP_BY_PROVIDER.anthropic;
    expect(a.budget.usdPer1MTokens).toBeLessThanOrEqual(a.better.usdPer1MTokens);
    expect(a.better.usdPer1MTokens).toBeLessThanOrEqual(a.best.usdPer1MTokens);
  });
});

describe('M3-2 · resolveEmbeddingTier', () => {
  test('default config → balanced · source=default', () => {
    const r = resolveEmbeddingTier(undefined, 'openai');
    expect(r.tier).toBe('balanced');
    expect(r.source).toBe('default');
    expect(r.model).toBe('text-embedding-3-small');
    expect(r.provider).toBe('openai');
  });

  test('user-config surface override wins', () => {
    const r = resolveEmbeddingTier({ embedding: 'best' }, 'voyage');
    expect(r.tier).toBe('best');
    expect(r.source).toBe('user-config-surface');
    expect(r.model).toBe('voyage-3-large');
  });

  test('preset (no surface override) → default tier · source=preset', () => {
    const r = resolveEmbeddingTier({ preset: 'meeting' }, 'cohere');
    expect(r.tier).toBe('balanced');
    expect(r.source).toBe('preset');
  });

  test('profile-only → default tier · source=profile', () => {
    const r = resolveEmbeddingTier({ profile: 'power' }, 'local');
    expect(r.tier).toBe('balanced');
    expect(r.source).toBe('profile');
  });

  test('cohere loaded → reranker pass', () => {
    const r = resolveEmbeddingTier({ embedding: 'loaded' }, 'cohere');
    expect(r.extraReranker).toBe(true);
    expect(r.status).toBe('wip');
  });
});

describe('M3-2 · resolveVisionTier', () => {
  test('default config → balanced · provider preserved', () => {
    const r = resolveVisionTier(undefined, 'anthropic');
    expect(r.tier).toBe('balanced');
    expect(r.model).toBe('claude-haiku-4-5');
    expect(r.source).toBe('default');
  });

  test('surface override → loaded tier extraReasoning=true', () => {
    const r = resolveVisionTier({ vision: 'loaded' }, 'gemini');
    expect(r.tier).toBe('loaded');
    expect(r.extraReasoning).toBe(true);
    expect(r.source).toBe('user-config-surface');
  });

  test('local provider always $0', () => {
    for (const tier of MODEL_TIERS) {
      expect(lookupVisionTierSpec('local', tier).usdPer1MTokens).toBe(0);
    }
  });

  test('preset present (no surface) → default tier · source=preset', () => {
    const r = resolveVisionTier({ preset: 'medical_dictation' }, 'openai');
    expect(r.tier).toBe('balanced');
    expect(r.source).toBe('preset');
  });
});

describe('M3-2 · lookup helpers', () => {
  test('lookupEmbeddingTierSpec returns the expected ladder entry', () => {
    const spec = lookupEmbeddingTierSpec('openai', 'best');
    expect(spec.model).toBe('text-embedding-3-large');
    expect(spec.dim).toBe(3072);
  });

  test('lookupVisionTierSpec returns the expected ladder entry', () => {
    const spec = lookupVisionTierSpec('openai', 'better');
    expect(spec.model).toBe('gpt-4o');
  });
});
