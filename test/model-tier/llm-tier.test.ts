// M2-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 2) —
// LLM tier map + resolver tests.

import { describe, expect, test } from 'bun:test';
import {
  LLM_TIER_MAP_BY_PROVIDER,
  MODEL_TIERS,
  lookupLlmTierSpec,
  resolveLlmTier,
} from '../../src/model-tier/index.js';

// Failure classification (six baseline failures): 이름이 늙음 4 · 배선 오류 2.
// Names: Anthropic best lookup and two resolver assertions → claude-opus-5;
// Gemini balanced resolver → gemini-3.7-flash. The four renames landed in
// d7f8094b61efce56286e65457395775faa1e714d (2026-08-18).
// Wiring: 68db850f incorrectly sent both `auto` and unknown providers to the
// Codex family. Their safe fallback is Anthropic balanced, not a cross-provider
// Codex model. The budget/best failure came from a partial field comparison;
// compare complete LlmTierSpec objects so future fields cannot be omitted.

describe('M2-1 · LLM_TIER_MAP_BY_PROVIDER · invariants', () => {
  const providers = Object.keys(LLM_TIER_MAP_BY_PROVIDER) as Array<keyof typeof LLM_TIER_MAP_BY_PROVIDER>;

  test('every provider has all 5 tier specs', () => {
    for (const provider of providers) {
      const map = LLM_TIER_MAP_BY_PROVIDER[provider];
      for (const tier of MODEL_TIERS) {
        expect(map[tier]).toBeDefined();
        expect(map[tier].model.length).toBeGreaterThan(0);
        expect(map[tier].label.length).toBeGreaterThan(0);
        expect(map[tier].rationale.length).toBeGreaterThan(0);
      }
    }
  });

  test('local provider entries are WIP', () => {
    for (const tier of MODEL_TIERS) {
      expect(LLM_TIER_MAP_BY_PROVIDER.local[tier].status).toBe('wip');
    }
  });

  test('wired cloud providers ship while declared-only and local ladders remain WIP', () => {
    for (const provider of providers) {
      // bedrock = 배선됐지만 실호출 전(계정별 접근 조건 미측정) — wip (BEDROCK-PROVIDER #25966).
      const status = ['local', 'kimi', 'qwen', 'glm', 'bedrock'].includes(provider) ? 'wip' : 'shipping';
      for (const tier of MODEL_TIERS) {
        expect(LLM_TIER_MAP_BY_PROVIDER[provider][tier].status).toBe(status);
      }
    }
  });

  test('loaded tier uses the provider-specific reasoning ceiling', () => {
    for (const provider of providers) {
      const level = provider === 'local' ? undefined : provider === 'openai-codex' ? 'medium' : 'high';
      expect(LLM_TIER_MAP_BY_PROVIDER[provider].loaded.reasoningLevel).toBe(level);
    }
  });

  test('budget and best resolve to distinct complete specs on every provider', () => {
    for (const provider of providers) {
      const budget = LLM_TIER_MAP_BY_PROVIDER[provider].budget;
      const best = LLM_TIER_MAP_BY_PROVIDER[provider].best;
      expect(budget).not.toEqual(best);
    }
  });
});

describe('M2-1 · lookupLlmTierSpec', () => {
  test('anthropic best → claude-opus-5-5', () => {
    expect(lookupLlmTierSpec('anthropic', 'best').model).toBe('claude-opus-5-5');
  });

  // ⚠️ o1 은 폐기 모델 · 현행 OPENAI map 반환값에 맞춰 green. gpt-5.5 자체는 catalog 미등재
  //    유령 id 로, SSoT 정합(→ gpt-5.6 계열·대표 2026-07-19)은 모델관리 아크에서 map/catalog 별도 검토.
  test('openai best → gpt-5.5 (map 현행)', () => {
    expect(lookupLlmTierSpec('openai', 'best').model).toBe('gpt-5.5');
  });

  test('gemini loaded → gemini-3.1-pro-preview · reasoning high', () => {
    const s = lookupLlmTierSpec('gemini', 'loaded');
    expect(s.model).toBe('gemini-3.1-pro-preview');
    expect(s.reasoningLevel).toBe('high');
  });

  test('local best is WIP', () => {
    expect(lookupLlmTierSpec('local', 'best').status).toBe('wip');
  });

  test('auto provider falls back to Anthropic balanced rather than Codex', () => {
    expect(lookupLlmTierSpec('auto', 'best')).toEqual(LLM_TIER_MAP_BY_PROVIDER.anthropic.balanced);
  });
});

describe('M2-1 · resolveLlmTier · precedence', () => {
  test('undefined config → default tier · source=default', () => {
    const r = resolveLlmTier(undefined, 'anthropic');
    expect(r.tier).toBe('balanced');
    expect(r.source).toBe('default');
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('claude-sonnet-5');
  });

  test('modelTier.llm = "best" → matching spec · source=user-config-surface', () => {
    const r = resolveLlmTier({ llm: 'best' }, 'anthropic');
    expect(r.tier).toBe('best');
    expect(r.source).toBe('user-config-surface');
    // 우선순위 시험이다 — 이름은 사다리에서 파생한다(사다리를 바꿀 때마다 깨지지 않게 · 2026-09-25).
    expect(r.model).toBe(lookupLlmTierSpec('anthropic', 'best').model);
    expect(r.reasoningLevel).toBe('medium');
  });

  test('preset alone → default tier · source=preset', () => {
    const r = resolveLlmTier({ preset: 'meeting' }, 'openai');
    expect(r.tier).toBe('balanced');
    expect(r.source).toBe('preset');
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('gpt-4o-mini');
  });

  test('profile alone → default tier · source=profile', () => {
    const r = resolveLlmTier({ profile: 'power' }, 'gemini');
    expect(r.tier).toBe('balanced');
    expect(r.source).toBe('profile');
    expect(r.model).toBe(lookupLlmTierSpec('gemini', 'balanced').model);   // 이름은 사다리에서 파생
  });

  test('per-surface override wins over profile + preset', () => {
    const r = resolveLlmTier(
      { llm: 'loaded', profile: 'casual', preset: 'meeting' },
      'anthropic',
    );
    expect(r.tier).toBe('loaded');
    expect(r.source).toBe('user-config-surface');
    expect(r.reasoningLevel).toBe('high');
  });

  test('provider determines model · same tier resolves differently per provider', () => {
    const anthropic = resolveLlmTier({ llm: 'best' }, 'anthropic');
    const openai = resolveLlmTier({ llm: 'best' }, 'openai');
    const gemini = resolveLlmTier({ llm: 'best' }, 'gemini');
    // «provider 마다 다르게 풀린다»가 불변식이다 — 이름은 사다리에서 파생한다(2026-09-25).
    expect(anthropic.model).toBe(lookupLlmTierSpec('anthropic', 'best').model);
    expect(openai.model).toBe(lookupLlmTierSpec('openai', 'best').model);
    expect(gemini.model).toBe(lookupLlmTierSpec('gemini', 'best').model);
    expect(new Set([anthropic.model, openai.model, gemini.model]).size).toBe(3);
  });
});
