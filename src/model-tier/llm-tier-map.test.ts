import { describe, it, expect } from 'bun:test';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import {
  lookupLlmTierSpec, parseTierArg, TIER_PROVIDERS, LLM_TIER_MAP_BY_PROVIDER, lookupOpenRouterModelSpec,
} from './llm-tier-map.js';
import { MODEL_TIERS } from './types.js';

describe('parseTierArg — 별칭 → canonical (헷갈림 흡수)', () => {
  it('low = budget', () => expect(parseTierArg('low')).toBe('budget'));
  it('mid/medium = better', () => { expect(parseTierArg('mid')).toBe('better'); expect(parseTierArg('medium')).toBe('better'); });
  it('high = best', () => expect(parseTierArg('high')).toBe('best'));
  it('max = loaded', () => expect(parseTierArg('max')).toBe('loaded'));
  it('canonical 이름은 그대로', () => { for (const t of MODEL_TIERS) expect(parseTierArg(t)).toBe(t); });
  it('대소문자·공백 무관', () => expect(parseTierArg('  LOW ')).toBe('budget'));
  it('알 수 없는 값 → undefined', () => expect(parseTierArg('turbo-max-ultra')).toBeUndefined());
});

describe('lookupLlmTierSpec — SSOT 회귀 (대표 지적)', () => {
  it('grok low(budget) = grok-4.20-non-reasoning', () => {
    expect(lookupLlmTierSpec('grok', parseTierArg('low')!).model).toBe('grok-4.20-non-reasoning');
  });
  // ⛔ 2026-09-23 — 종전엔 `'gpt-5.6-luna'` 를 «박았다». 사다리가 GPT-6 으로 옮기자 깨졌고,
  //   깨진 것이 결함이 아니라 «의도된 이동»이었다. ⇒ 이름 대신 ***불변식***을 판정한다:
  //   budget 은 그 provider 사다리에서 «가장 싼 칸»이어야 하고, best 보다 비싸면 안 된다.
  it('codex budget 은 사다리의 «최저 비용» 칸이다 (이름을 박지 않는다)', () => {
    const budget = lookupLlmTierSpec('openai-codex', 'budget');
    const best = lookupLlmTierSpec('openai-codex', 'best');
    expect(budget.model.length).toBeGreaterThan(0);
    const cost = (id: string) => {
      const e = BUILTIN_CATALOG.models.find(m => m.id === id);
      expect(e).toBeDefined();
      return (e!.inputPerMtok ?? 0) + (e!.outputPerMtok ?? 0);
    };
    expect(cost(budget.model)).toBeLessThan(cost(best.model));
    // budget 은 사다리 다섯 칸 중 최솟값이어야 한다 — 「가장 싼 칸」의 정의.
    const all = MODEL_TIERS.map(t => cost(lookupLlmTierSpec('openai-codex', t).model));
    expect(cost(budget.model)).toBe(Math.min(...all));
  });
  it('anthropic best = opus 5.5 (09-25 최신)', () => {
    expect(lookupLlmTierSpec('anthropic', 'best').model).toBe('claude-opus-5-5');
  });
  it('명시 provider 다섯 칸은 사다리 표와 같다', () => {
    for (const p of TIER_PROVIDERS) {
      const map = LLM_TIER_MAP_BY_PROVIDER[p];
      for (const t of MODEL_TIERS) {
        expect(lookupLlmTierSpec(p, t)).toEqual(map[t]);
      }
    }
  });
  it('OpenRouter GLM-5.3 측정 가격·창과 flash 의 미측정 가격을 구별한다', () => {
    const balanced = lookupLlmTierSpec('openrouter', 'balanced');
    expect(balanced.model).toBe('openrouter/z-ai/glm-5.3');
    expect(balanced.rationale).toContain('$0.039/$4.8');
    expect(balanced.rationale).toContain('1.05M ctx');
    const flash = lookupOpenRouterModelSpec('openrouter/z-ai/glm-5.3-flash')!;
    expect(lookupOpenRouterModelSpec('z-ai/glm-5.3-flash')).toEqual(flash);
    expect(lookupOpenRouterModelSpec('openrouter/z-ai/glm-5.3')).toEqual(balanced);
    expect(lookupOpenRouterModelSpec('openrouter/unknown/model')).toBeUndefined();
    expect(flash.model).toBe('openrouter/z-ai/glm-5.3-flash');
    expect(lookupLlmTierSpec('openrouter', 'budget').model).toBe('openrouter/qwen/qwen3.8-flash');
    expect(flash.status).toBe('shipping');
    expect(flash.rationale).toContain('미측정');
    expect(flash.rationale).not.toContain('$0');
    expect(lookupLlmTierSpec('openrouter', 'better').model).toBe('openrouter/qwen/qwen3.8-max-0902');
    expect(lookupLlmTierSpec('openrouter', 'best').model).toBe('openrouter/moonshotai/kimi-k3');
  });
  it('auto provider uses the Anthropic balanced safe fallback', () => {
    expect(lookupLlmTierSpec('auto', 'budget')).toEqual(LLM_TIER_MAP_BY_PROVIDER.anthropic.balanced);
    expect(lookupLlmTierSpec('auto', 'loaded')).toEqual(LLM_TIER_MAP_BY_PROVIDER.anthropic.balanced);
  });
  it('unknown provider uses the Anthropic balanced safe fallback', () => {
    expect(lookupLlmTierSpec('nope' as any, 'budget')).toEqual(LLM_TIER_MAP_BY_PROVIDER.anthropic.balanced);
    expect(lookupLlmTierSpec('nope' as any, 'loaded')).toEqual(LLM_TIER_MAP_BY_PROVIDER.anthropic.balanced);
  });
});

describe('SSOT 완전성 — 모든 provider 가 5단 전부 정의', () => {
  it('TIER_PROVIDERS 각각 5 tier · 모델 비어있지 않음', () => {
    for (const p of TIER_PROVIDERS) {
      const map = LLM_TIER_MAP_BY_PROVIDER[p];
      expect(map).toBeDefined();
      for (const t of MODEL_TIERS) {
        expect(map[t]).toBeDefined();
        expect(map[t].model.length).toBeGreaterThan(0);
      }
    }
  });
});
