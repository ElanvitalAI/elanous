import { describe, expect, it, spyOn } from 'bun:test';
import { findClaudeModel } from '../anthropic/models.js';
import * as codexModels from '../codex/models.js';
import { findCodexModel } from '../codex/models.js';
import { findGeminiModel } from '../gemini/models.js';
import { findGrokModel } from '../grok/models.js';
import * as userConfig from '../user-config.js';
import { estimateLlmCost, llmUsageCostFields, readLlmConfigPricing, longContextPricing } from './llm-cost.js';

const MILLION = 1_000_000;
const noOverlay = { configPricing: {} };

function cacheReadPerMOf(pricing: { inputPerM: number; outputPerM: number }): number | undefined {
  return 'cacheReadPerM' in pricing && typeof (pricing as { cacheReadPerM?: unknown }).cacheReadPerM === 'number'
    ? (pricing as { cacheReadPerM: number }).cacheReadPerM
    : undefined;
}

function cacheWritePerMOf(pricing: { inputPerM: number; outputPerM: number }): number | undefined {
  return 'cacheWritePerM' in pricing && typeof (pricing as { cacheWritePerM?: unknown }).cacheWritePerM === 'number'
    ? (pricing as { cacheWritePerM: number }).cacheWritePerM
    : undefined;
}

describe('estimateLlmCost — catalog reuse', () => {
  it('converts tokens to dollars from all four catalogs', () => {
    const cases = [
      findCodexModel('gpt-5.6-terra'),
      findGrokModel('grok-4.6'),
      findGeminiModel('gemini-3.7-flash'),
      findClaudeModel('claude-sonnet-4-6'),
    ];
    for (const entry of cases) {
      expect(entry).toBeDefined();
      expect(entry!.pricingUsd).toBeTruthy();
      const pricing = entry!.pricingUsd!;
      const got = estimateLlmCost({
        model: entry!.id,
        inputTokens: MILLION,
        outputTokens: MILLION,
      });
      expect(got).toEqual({
        kind: 'known',
        model: entry!.id,
        usd: pricing.inputPerM + pricing.outputPerM,
        source: 'catalog',
        cacheReadPricedAt: cacheReadPerMOf(pricing) === undefined ? 'input-rate' : 'cache-read',
        cacheWritePricedAt: cacheWritePerMOf(pricing) === undefined ? 'input-rate' : 'cache-write',
      });
    }
  });
});

describe('estimateLlmCost — unknown is not zero', () => {
  it('returns an explicit unknown result with the model name, not 0', () => {
    for (const model of ['absent-model-for-test', 'another-absent-model']) {   // ⛔ claude-sonnet-5 는 BACKLOG C2 로 «알게» 됐다(저장소 정본 폴백)
      const got = estimateLlmCost({
        model,
        inputTokens: MILLION,
        outputTokens: MILLION,
      });
      expect(got).toEqual({ kind: 'unknown', model });
      expect(got.kind).not.toBe('known');
      expect('usd' in got).toBe(false);
    }
  });

  it('separates catalog absence, catalog presence without price, and usable catalog price', () => {
    const absent = estimateLlmCost({
      model: 'absent-model-for-test',
      inputTokens: MILLION,
      outputTokens: 0,
    });
    expect(absent).toEqual({ kind: 'unknown', model: 'absent-model-for-test' });

    const priced = findCodexModel('gpt-5.6-terra')!;
    expect(priced.pricingUsd).toBeTruthy();
    expect(estimateLlmCost({
      model: 'gpt-5.6-terra',
      inputTokens: MILLION,
      outputTokens: 0,
    })).toMatchObject({ kind: 'known', source: 'catalog', usd: priced.pricingUsd!.inputPerM });

    const originalFind = findCodexModel;
    const find = spyOn(codexModels, 'findCodexModel').mockImplementation((id: string) => {
      if (id !== 'ghost-priced') return originalFind(id);
      return {
        id: 'ghost-priced',
        label: 'ghost',
        tier: 'legacy',
        description: 'listed without a price',
        contextWindow: null,
        pricingUsd: null,
      };
    });
    try {
      const usage = { model: 'ghost-priced', inputTokens: MILLION, outputTokens: 0 };
      expect(estimateLlmCost(usage)).toEqual({ kind: 'unknown', model: 'ghost-priced' });
      expect(estimateLlmCost(usage, {
        configPricing: { 'ghost-priced': { inputPerM: 9, outputPerM: 1 } },
      })).toEqual({ kind: 'unknown', model: 'ghost-priced' });
    } finally {
      find.mockRestore();
    }
  });
});

describe('estimateLlmCost — config overlay', () => {
  const usage = { model: 'absent-model-for-test', inputTokens: MILLION, outputTokens: 0 };
  const overlay = { 'absent-model-for-test': { inputPerM: 4, outputPerM: 8 } };

  it('the same absent model diverges with vs without config pricing', () => {
    const bare = estimateLlmCost(usage);
    const overlaid = estimateLlmCost(usage, { configPricing: overlay });
    expect(bare).toEqual({ kind: 'unknown', model: 'absent-model-for-test' });
    expect(overlaid).toEqual({
      kind: 'known',
      model: 'absent-model-for-test',
      usd: 4,
      source: 'config',
      cacheReadPricedAt: 'input-rate',
      cacheWritePricedAt: 'input-rate',
    });
    expect(bare).not.toEqual(overlaid);
  });

  it('does not let config overlay a catalog price', () => {
    const terra = findCodexModel('gpt-5.6-terra')!.pricingUsd!;
    const got = estimateLlmCost(
      { model: 'gpt-5.6-terra', inputTokens: MILLION, outputTokens: 0 },
      { configPricing: { 'gpt-5.6-terra': { inputPerM: terra.inputPerM + 99, outputPerM: 1 } } },
    );
    expect(got).toEqual({
      kind: 'known',
      model: 'gpt-5.6-terra',
      usd: terra.inputPerM,
      source: 'catalog',
      cacheReadPricedAt: 'input-rate',
      cacheWritePricedAt: 'input-rate',
    });
  });
});

describe('readLlmConfigPricing — operational config overlay', () => {
  it('reads budget.llmPricing from user-config raw and ignores catalog models', () => {
    const overlay = readLlmConfigPricing({
      budget: {
        llmPricing: {
          'gpt-5.6-luna': { inputPerM: 4, outputPerM: 8 },
          'gpt-5.6-terra': { inputPerM: 99, outputPerM: 1 },
        },
      },
    });
    expect(overlay).toEqual({
      'gpt-5.6-luna': { inputPerM: 4, outputPerM: 8 },
      'gpt-5.6-terra': { inputPerM: 99, outputPerM: 1 },
    });
    expect(estimateLlmCost(
      { model: 'gpt-5.6-luna', inputTokens: MILLION, outputTokens: 0 },
      { configPricing: overlay },
    ).kind).toBe('known');
    expect(estimateLlmCost(
      { model: 'gpt-5.6-terra', inputTokens: MILLION, outputTokens: 0 },
      { configPricing: overlay },
    )).toMatchObject({ kind: 'known', source: 'catalog', usd: findCodexModel('gpt-5.6-terra')!.pricingUsd!.inputPerM });   // 카탈로그가 이긴다 · 값은 카탈로그에서 파생(09-23 단가 정정 2.5→2.0 을 박힌 값이 못 따라갔다)
  });

  it('loads live getUserConfig().raw when no raw is passed', () => {
    const get = spyOn(userConfig, 'getUserConfig').mockReturnValue({
      raw: { budget: { llmPricing: { 'gpt-5.6-luna': { inputPerM: 4, outputPerM: 8 } } } },
    } as unknown as ReturnType<typeof userConfig.getUserConfig>);
    try {
      expect(readLlmConfigPricing()).toEqual({ 'gpt-5.6-luna': { inputPerM: 4, outputPerM: 8 } });
    } finally {
      get.mockRestore();
    }
  });
});

describe('estimateLlmCost — cache read rate', () => {
  it('uses cacheReadPerM when the catalog reports it', () => {
    const claude = findClaudeModel('claude-sonnet-4-6')!;
    const rate = cacheReadPerMOf(claude.pricingUsd!);
    expect(rate).toBeDefined();
    const got = estimateLlmCost({
      model: 'claude-sonnet-4-6',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: MILLION,
    });
    expect(got).toEqual({
      kind: 'known',
      model: 'claude-sonnet-4-6',
      usd: rate!,
      source: 'catalog',
      cacheReadPricedAt: 'cache-read',
      cacheWritePricedAt: 'cache-write',
    });
  });

  it('falls back to the input rate and marks that fallback when cacheReadPerM is absent', () => {
    const terra = findCodexModel('gpt-5.6-terra')!.pricingUsd!;
    expect(terra).not.toHaveProperty('cacheReadPerM');
    const got = estimateLlmCost({
      model: 'gpt-5.6-terra',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: MILLION,
    });
    expect(got).toEqual({
      kind: 'known',
      model: 'gpt-5.6-terra',
      usd: terra.inputPerM,
      source: 'catalog',
      cacheReadPricedAt: 'input-rate',
      cacheWritePricedAt: 'input-rate',
    });
  });
});

describe('estimateLlmCost — cache creation tokens', () => {
  it('uses cacheWritePerM when the catalog reports it', () => {
    const claude = findClaudeModel('claude-sonnet-4-6')!;
    const rate = cacheWritePerMOf(claude.pricingUsd!);
    expect(rate).toBeDefined();
    const got = estimateLlmCost({
      model: 'claude-sonnet-4-6',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: MILLION,
    });
    expect(got).toEqual({
      kind: 'known',
      model: 'claude-sonnet-4-6',
      usd: rate!,
      source: 'catalog',
      cacheReadPricedAt: 'cache-read',
      cacheWritePricedAt: 'cache-write',
    });
  });

  it('falls back to the input rate and marks that fallback when cacheWritePerM is absent', () => {
    const terra = findCodexModel('gpt-5.6-terra')!.pricingUsd!;
    expect(terra).not.toHaveProperty('cacheWritePerM');
    const got = estimateLlmCost({
      model: 'gpt-5.6-terra',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: MILLION,
    });
    expect(got.kind).toBe('known');
    expect(got).toEqual({
      kind: 'known',
      model: 'gpt-5.6-terra',
      usd: terra.inputPerM,
      source: 'catalog',
      cacheReadPricedAt: 'input-rate',
      cacheWritePricedAt: 'input-rate',
    });
    expect(got.kind === 'known' && got.usd === 0).toBe(false);
  });
});

describe('estimateLlmCost — omitted tokens are not known zeros', () => {
  it('returns partial, not known, when a catalog model omits input or output', () => {
    const terra = findCodexModel('gpt-5.6-terra')!.pricingUsd!;
    const omittedInput = estimateLlmCost({ model: 'gpt-5.6-terra', outputTokens: MILLION });
    expect(omittedInput).toEqual({
      kind: 'partial',
      model: 'gpt-5.6-terra',
      usd: terra.outputPerM,
      source: 'catalog',
      cacheReadPricedAt: 'input-rate',
      cacheWritePricedAt: 'input-rate',
      omitted: ['inputTokens'],
    });
    expect(omittedInput.kind).not.toBe('known');
    const omittedBoth = estimateLlmCost({ model: 'gpt-5.6-terra' });
    expect(omittedBoth.kind).toBe('partial');
    if (omittedBoth.kind === 'partial') {
      expect(omittedBoth.omitted).toEqual(['inputTokens', 'outputTokens']);
      expect(omittedBoth.usd).toBe(0);
    }
  });

  it('treats an explicit 0 as a real 0, distinct from omission', () => {
    const terra = findCodexModel('gpt-5.6-terra')!.pricingUsd!;
    expect(estimateLlmCost({
      model: 'gpt-5.6-terra',
      inputTokens: 0,
      outputTokens: MILLION,
    })).toEqual({
      kind: 'known',
      model: 'gpt-5.6-terra',
      usd: terra.outputPerM,
      source: 'catalog',
      cacheReadPricedAt: 'input-rate',
      cacheWritePricedAt: 'input-rate',
    });
  });
});

describe('llmUsageCostFields', () => {
  it('spreads the same discriminated cost the estimator returns', () => {
    expect(llmUsageCostFields('absent-model-for-test', { inputTokens: 3 }, noOverlay)).toEqual({
      cost: { kind: 'unknown', model: 'absent-model-for-test' },
    });
    const terra = findCodexModel('gpt-5.6-terra')!.pricingUsd!;
    expect(llmUsageCostFields('gpt-5.6-terra', { inputTokens: MILLION, outputTokens: 0 }, noOverlay)).toEqual({
      cost: {
        kind: 'known',
        model: 'gpt-5.6-terra',
        usd: terra.inputPerM,
        source: 'catalog',
        cacheReadPricedAt: 'input-rate',
        cacheWritePricedAt: 'input-rate',
      },
    });
  });
});


// BACKLOG C1·C2 — 단가 조회 사슬(09-25 벤치: kimi·claude 5 계열이 전부 unknown 이었다).
import { normalizePricingModelId } from './llm-cost.js';
describe('pricing lookup chain (BACKLOG C1·C2)', () => {
  it('normalizes date suffixes and anthropic/openrouter-anthropic prefixes, not other gateway models', () => {
    expect(normalizePricingModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizePricingModelId('openrouter/anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(normalizePricingModelId('openrouter/moonshotai/kimi-k3')).toBe('openrouter/moonshotai/kimi-k3');
  });
  it('a date-suffixed claude id is priced (was unknown)', () => {
    const r = estimateLlmCost({ model: 'claude-haiku-4-5-20251001', inputTokens: MILLION, outputTokens: 0 });
    expect(r).toMatchObject({ kind: 'known', source: 'catalog' });
  });
  it('claude 5 family is priced from the in-repo model catalog with the anthropic cache rule', () => {
    const r = estimateLlmCost({ model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, cacheReadInputTokens: MILLION });
    expect(r).toMatchObject({ kind: 'known', cacheReadPricedAt: 'cache-read', usd: 0.5 });
  });
  it('a truly absent model stays unknown, never zero', () => {
    expect(estimateLlmCost({ model: 'absent-model-for-test', inputTokens: 1, outputTokens: 1 })).toEqual({ kind: 'unknown', model: 'absent-model-for-test' });
  });
});

// BACKLOG C7 — provider 보고 청구액이 있으면 그것이 비용(추정은 곁에).
import { llmUsageCostFields as fieldsC7 } from './llm-cost.js';
describe('actual cost (BACKLOG C7)', () => {
  it('reported cost wins over the catalog estimate for api billing; subscription stays included', () => {
    const api = fieldsC7('gpt-6-sol', { inputTokens: 1_000_000, outputTokens: 0, reportedCostUsd: 1.23 } as never, { configPricing: {} }, 'api');
    expect(api.cost).toMatchObject({ kind: 'actual', usd: 1.23, source: 'provider-reported', estimateUsd: 2 });
    const sub = fieldsC7('gpt-6-sol', { inputTokens: 1_000_000, outputTokens: 0, reportedCostUsd: 1.23 } as never, { configPricing: {} }, 'subscription');
    expect(sub.cost).toMatchObject({ kind: 'included' });
  });
});

describe('C8 장문맥 단가 · 추론 토큰 (2026-09-25)', () => {
  it('Gemini 3.1 Pro 는 프롬프트가 200K 를 «넘으면» 요청 전체를 $4/$18 로 매긴다 — 경계(=200K)는 기본 단가', () => {
    const at = estimateLlmCost({ model: 'gemini-3.1-pro-preview', inputTokens: 200_000, outputTokens: 1_000_000 });
    expect(at).toMatchObject({ kind: 'known', usd: 0.4 + 12 });
    expect((at as { pricedTier?: string }).pricedTier).toBeUndefined();
    const over = estimateLlmCost({ model: 'gemini-3.1-pro-preview', inputTokens: 200_001, outputTokens: 1_000_000 });
    expect(over).toMatchObject({ kind: 'known', pricedTier: 'long-context' });
    expect((over as { usd: number }).usd).toBeCloseTo(200_001 / 1e6 * 4 + 18, 9);
  });

  it('문턱은 캐시 읽기까지 합친 프롬프트로 잰다 · 캐시 단가는 입력과 같은 배수로 오른다', () => {
    const r = estimateLlmCost({ model: 'gemini-3.1-pro-preview', inputTokens: 50_000, outputTokens: 0, cacheReadInputTokens: 160_000 });
    expect(r).toMatchObject({ kind: 'known', pricedTier: 'long-context' });
    expect((r as { usd: number }).usd).toBeCloseTo(50_000 / 1e6 * 4 + 160_000 / 1e6 * 0.4, 9);
  });

  it('장문맥 칸이 없는 모델은 아무리 커도 기본 단가 그대로다(양성 대조)', () => {
    const r = estimateLlmCost({ model: 'gemini-3.1-pro-preview-nope', inputTokens: 1 }, { configPricing: { 'gemini-3.1-pro-preview-nope': { inputPerM: 1, outputPerM: 1 } } });
    expect((r as { pricedTier?: string }).pricedTier).toBeUndefined();
    expect(longContextPricing({ inputPerM: 1, outputPerM: 2 }, 10_000_000)).toEqual({ inputPerM: 1, outputPerM: 2 });
  });

  it('추론 토큰은 출력의 부분집합이라 따로 더 매기지 않는다(이중 과금 없음)', () => {
    const a = estimateLlmCost({ model: 'gemini-3.1-pro-preview', inputTokens: 1000, outputTokens: 5000 });
    const b = estimateLlmCost({ model: 'gemini-3.1-pro-preview', inputTokens: 1000, outputTokens: 5000, reasoningOutputTokens: 4000 });
    expect((b as { usd: number }).usd).toBe((a as { usd: number }).usd);
  });
});

describe('geminiUsageFromMetadata — Gemini 사용량 규약 (C8)', () => {
  it('생각 토큰을 출력에 더하고 reasoningOutputTokens 로 남긴다 · 프롬프트에서 캐시분을 뺀다', async () => {
    const { geminiUsageFromMetadata } = await import('../llm.js');
    expect(geminiUsageFromMetadata({ promptTokens: 10_000, outputTokens: 300, cachedTokens: 8_000, thoughtTokens: 1_200 })).toEqual({
      provider: 'openai', inputTokens: 2_000, outputTokens: 1_500, cacheReadInputTokens: 8_000, reasoningOutputTokens: 1_200,
    });
  });
  it('내장 도구 프롬프트 토큰(toolUsePromptTokenCount)은 프롬프트 밖이라 입력에 더한다', async () => {
    const { geminiUsageFromMetadata } = await import('../llm.js');
    expect(geminiUsageFromMetadata({ promptTokens: 1_000, outputTokens: 10, cachedTokens: 400, thoughtTokens: 0, toolUsePromptTokens: 250 }))
      .toEqual({ provider: 'openai', inputTokens: 850, outputTokens: 10, cacheReadInputTokens: 400 });
  });
  it('생각·캐시가 없으면 종전과 같은 모양이다 · 전부 0 이면 사용량을 안 낸다', async () => {
    const { geminiUsageFromMetadata } = await import('../llm.js');
    expect(geminiUsageFromMetadata({ promptTokens: 100, outputTokens: 20, cachedTokens: 0, thoughtTokens: 0 })).toEqual({ provider: 'openai', inputTokens: 100, outputTokens: 20 });
    expect(geminiUsageFromMetadata({ promptTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtTokens: 0 })).toBeUndefined();
  });
});

// OPENROUTER-OPTIMIZE G9 — the `stream-llm` usage site carries the provider-reported bill, not a catalog guess.
describe('stream-llm site — reportedCostUsd (G9)', () => {
  it('streamLLM keeps usage.cost through accumulation, so the llm-usage row is cost.kind=actual', async () => {
    const { streamLLM } = await import('../llm.js');
    const { debug } = await import('../debug/log.js');
    const provider = {
      name: 'g9-fake-router',
      defaultModel: 'absent-model-for-test',
      available: () => true,
      async *chat() { yield 'ok'; },
      async *streamChat() {
        yield { type: 'text' as const, delta: 'ok' };
        // OpenRouter shape: one final usage chunk with tokens and `usage.cost` together (parseOpenAIUsage output).
        yield { type: 'usage' as const, usage: { provider: 'openai' as const, inputTokens: 10, outputTokens: 2, reportedCostUsd: 0.0042 } };
      },
    };
    const spy = spyOn(debug, 'log');
    try {
      expect(await streamLLM([{ role: 'user', content: 'hi' }], () => {}, { provider })).toBe('ok');
      const row = spy.mock.calls.find((c) => c[0] === 'llm.usage' && c[1] === 'llm-usage' && (c[2] as { site?: string })?.site === 'stream-llm');
      expect(row).toBeDefined();
      expect((row![2] as { cost: unknown }).cost).toMatchObject({ kind: 'actual', usd: 0.0042, source: 'provider-reported' });
      expect(row![2]).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    } finally {
      spy.mockRestore();
    }
  });

  it('without a reported bill the same site stays on the estimate (negative control)', async () => {
    const { streamLLM } = await import('../llm.js');
    const { debug } = await import('../debug/log.js');
    const provider = {
      name: 'g9-fake-router',
      defaultModel: 'absent-model-for-test',
      available: () => true,
      async *chat() { yield 'ok'; },
      async *streamChat() {
        yield { type: 'text' as const, delta: 'ok' };
        yield { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 2 } };
      },
    };
    const spy = spyOn(debug, 'log');
    try {
      await streamLLM([{ role: 'user', content: 'hi' }], () => {}, { provider });
      const row = spy.mock.calls.find((c) => c[0] === 'llm.usage' && (c[2] as { site?: string })?.site === 'stream-llm');
      expect((row![2] as { cost: { kind: string } }).cost.kind).toBe('unknown');
    } finally {
      spy.mockRestore();
    }
  });
});
