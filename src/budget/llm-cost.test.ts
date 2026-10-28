import { describe, expect, it, spyOn } from 'bun:test';
import { findClaudeModel } from '../anthropic/models.js';
import * as codexModels from '../codex/models.js';
import { findCodexModel } from '../codex/models.js';
import { findGeminiModel } from '../gemini/models.js';
import { findGrokModel } from '../grok/models.js';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import { debug } from '../debug/log.js';
import { logAgentTurnUsage } from '../llm.js';
import * as userConfig from '../user-config.js';
import { bedrockPricingModelId, creditRouteFromQuotaSignal, estimateLlmCost, llmUsageCostFields, readLlmConfigPricing, longContextPricing } from './llm-cost.js';

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
  it('normalizes Bedrock model ids and version suffixes to bare Claude pricing ids', () => {
    expect(bedrockPricingModelId('bedrock/claude-haiku-5-5-v1:0')).toBe('claude-haiku-5-5');
    expect(bedrockPricingModelId('ap-northeast-2.anthropic.claude-sonnet-5-5-v1:0')).toBe('claude-sonnet-5-5');
    expect(bedrockPricingModelId('anthropic.claude-opus-5-5-v1:0')).toBe('claude-opus-5-5');
  });
  it('Bedrock wire ids (us./global. regions) take the Bedrock table, never the 1st-party cache rate', () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: MILLION, cacheCreationInputTokens: 0 };
    // 캐시 읽기만 1M — Bedrock sonnet 0.1 · 1st-party 는 다르다. 1st-party 카탈로그가 Bedrock id 를 가로채면 이 값이 바뀐다.
    expect(llmUsageCostFields('us.anthropic.claude-sonnet-5-5', usage, noOverlay, 'api').cost).toMatchObject({ kind: 'known', usd: 0.1, source: 'bedrock-catalog' });
    expect(llmUsageCostFields('global.anthropic.claude-sonnet-5-5', usage, noOverlay, 'api').cost).toMatchObject({ kind: 'known', usd: 0.1, source: 'bedrock-catalog' });
    const firstParty = llmUsageCostFields('claude-sonnet-5-5', usage, noOverlay, 'api').cost;
    expect(firstParty).toMatchObject({ kind: 'known', source: 'catalog' });
    expect((firstParty as { usd: number }).usd).toBe(0.2);   // 1st-party 읽기 = 입력(2)×0.1 — Bedrock 0.1 과 «다른 값»으로 고정(음성 대조)
    // 표에 없는 Bedrock 모델은 지어내지 않고 unknown.
    expect(llmUsageCostFields('bedrock/zai.glm-5', usage, noOverlay, 'api').cost).toMatchObject({ kind: 'unknown' });
  });

  it('prices Bedrock usage with Bedrock cache rates through llmUsageCostFields', () => {
    const sonnet = llmUsageCostFields('global.anthropic.claude-sonnet-5-5', {
      inputTokens: MILLION,
      outputTokens: MILLION,
      cacheReadInputTokens: MILLION,
      cacheCreationInputTokens: MILLION,
    }, noOverlay, 'api');
    expect(sonnet.cost).toMatchObject({ kind: 'known', usd: 14.6, source: 'bedrock-catalog' });

    const haiku = llmUsageCostFields('bedrock/claude-haiku-5-5', {
      inputTokens: MILLION,
      outputTokens: MILLION,
      cacheReadInputTokens: MILLION,
      cacheCreationInputTokens: MILLION,
    }, noOverlay, 'api');
    expect(haiku.cost).toMatchObject({ kind: 'known', usd: 0.735, source: 'bedrock-catalog' });

    const opus = llmUsageCostFields('anthropic.claude-opus-5-5', {
      inputTokens: MILLION,
      outputTokens: MILLION,
      cacheReadInputTokens: MILLION,
      cacheCreationInputTokens: MILLION,
    }, noOverlay, 'api');
    expect(opus.cost).toMatchObject({ kind: 'known', usd: 29.2, source: 'bedrock-catalog' });
  });
  it('keeps first-party claude-sonnet-5-5 pricing and catalog source unchanged', () => {
    const firstParty = estimateLlmCost({
      model: 'claude-sonnet-5-5',
      inputTokens: MILLION,
      outputTokens: MILLION,
      cacheReadInputTokens: MILLION,
      cacheCreationInputTokens: MILLION,
    }, noOverlay);
    expect(firstParty).toMatchObject({ kind: 'known', usd: 14.7, source: 'catalog' });
    expect(firstParty).not.toMatchObject({ source: 'bedrock-catalog' });
  });
  it('wires Bedrock pricing into the existing llm.usage observation caller', () => {
    const spy = spyOn(debug, 'log');
    const model = 'global.anthropic.claude-sonnet-5-5';
    try {
      logAgentTurnUsage(model, {
        provider: 'anthropic',
        inputTokens: MILLION,
        outputTokens: MILLION,
        cacheReadInputTokens: MILLION,
        cacheCreationInputTokens: MILLION,
      }, { providerName: 'bedrock', site: 'bedrock-cost-test' });
      const row = spy.mock.calls.find((call) =>
        call[0] === 'llm.usage'
        && call[1] === 'llm-usage'
        && (call[2] as { site?: string })?.site === 'bedrock-cost-test');
      expect(row).toBeDefined();
      expect(row![2]).toMatchObject({
        model,
        billingProvider: 'bedrock',
        inputTokens: MILLION,
        outputTokens: MILLION,
        cacheReadInputTokens: MILLION,
        cacheCreationInputTokens: MILLION,
      });
      expect((row![2] as { cost: unknown }).cost).toMatchObject({ kind: 'known', usd: 14.6, source: 'bedrock-catalog' });
    } finally {
      spy.mockRestore();
    }
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

// BEDROCK-COST-LEDGER(0.2.38) — mantle-openai 비-Anthropic Bedrock id 분류.
// 근거 = AWS Bedrock price list(us-east-1 — mantle-openai 고정 리전)의 `USE1-<id>-mantle-{input,output}-tokens-standard`
// (게시 2026-10-16T21:08:06Z). 근거 있는 행만 known·source:'bedrock-catalog', 근거 없는 id 는 unknown(0원으로 꾸미지 않는다).
import { BEDROCK_MODELS } from '../llm/bedrock.js';
import { BEDROCK_PRICING_USD, type LlmPricingUsd } from './llm-cost.js';
// ⛔ `BEDROCK_NON_ANTHROPIC_PRICING_USD` 는 정적 import 금지 — 착지 전 base 에 «없는» export 다.
// 정적으로 당기면 base 실행이 판정 실패가 아니라 module-load-error 로 죽어 RED 증인이 «구분된 실패»로
// 잡히지 않는다(0.2.38 게이트 회고). 지연 import 면 base 에서는 `undefined` → 아래 단언이 판정 실패로 떨어진다.
async function bedrockNonAnthropicPricingTable(): Promise<Readonly<Record<string, LlmPricingUsd>> | undefined> {
  const mod = await import('./llm-cost.js') as { BEDROCK_NON_ANTHROPIC_PRICING_USD?: Readonly<Record<string, LlmPricingUsd>> };
  return mod.BEDROCK_NON_ANTHROPIC_PRICING_USD;
}
describe('Bedrock non-Anthropic classification (BEDROCK-COST-LEDGER 0.2.38)', () => {
  it('lets the built-in catalog win when an id collides with a Bedrock price row', async () => {
    const table = await bedrockNonAnthropicPricingTable();
    const ids = Object.keys(table ?? {});
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(BUILTIN_CATALOG.models.some((entry) => entry.id === id)).toBe(false);
      const synthetic = {
        id,
        provider: 'openai',
        family: 'test',
        contextWindow: 1_000,
        inputPerMtok: 9,
        outputPerMtok: 17,
        local: false,
        tags: [],
        bestFor: [],
      } as (typeof BUILTIN_CATALOG.models)[number];
      BUILTIN_CATALOG.models.push(synthetic);
      try {
        expect(estimateLlmCost({ model: id, inputTokens: MILLION, outputTokens: 0 }, noOverlay))
          .toMatchObject({ kind: 'known', usd: 9, source: 'catalog' });
      } finally {
        BUILTIN_CATALOG.models.pop();
      }
    }
  });

  it('keeps every AWS Bedrock price row free of a built-in catalog id collision', async () => {
    const table = await bedrockNonAnthropicPricingTable();
    for (const id of Object.keys(table ?? {})) {
      expect(BUILTIN_CATALOG.models.some((entry) => entry.id === id)).toBe(false);
    }
  });

  it('evidence-backed mantle-openai ids price as bedrock-catalog/known (1M in + 1M out)', async () => {
    // base 에는 이 표가 «없다» — 이 단언이 base 에서 판정 실패로 떨어지는 RED 증인의 하나다.
    const table = await bedrockNonAnthropicPricingTable();
    expect(table).toBeDefined();
    const evidenced: Array<[id: string, inputPerM: number, outputPerM: number]> = [
      ['zai.glm-4.7-flash', 0.07, 0.4],
      ['deepseek.v3.2', 0.62, 1.85],
      ['moonshotai.kimi-k2.5', 0.6, 3],
      ['qwen.qwen3-coder-next', 0.5, 1.2],
      ['minimax.minimax-m2.5', 0.3, 1.2],
      ['mistral.devstral-2-123b', 0.4, 2],
    ];
    const selectable = new Set(BEDROCK_MODELS.filter((m) => m.route === 'mantle-openai').map((m) => m.id));
    for (const [id, inputPerM, outputPerM] of evidenced) {
      // 표에 있는 id 는 «지금 mantle-openai 로 선택 가능한» 정본 목록(src/llm/bedrock.ts)의 원소여야 한다.
      expect(selectable.has(id)).toBe(true);
      // 표 행이 AWS price list 근거의 수치 그대로다 — 추정치가 아니다.
      expect(table?.[id]).toEqual({ inputPerM, outputPerM });
      expect(estimateLlmCost({ model: id, inputTokens: MILLION, outputTokens: MILLION }, noOverlay)).toEqual({
        kind: 'known',
        model: id,
        usd: inputPerM + outputPerM,
        source: 'bedrock-catalog',
        cacheReadPricedAt: 'input-rate',
        cacheWritePricedAt: 'input-rate',
      });
      // 실제 invoke id 모양(`bedrock/<id>-v1:0`)도 같은 칸으로 온다.
      expect(estimateLlmCost({ model: `bedrock/${id}-v1:0`, inputTokens: MILLION, outputTokens: 0 }, noOverlay))
        .toMatchObject({ kind: 'known', source: 'bedrock-catalog', usd: inputPerM });
    }
  });

  it('ids with no price row in the AWS price list stay unknown — never a zero-dressed known', async () => {
    const table = await bedrockNonAnthropicPricingTable();
    for (const id of ['openai.gpt-6-sol', 'openai.gpt-6-luna', 'zai.glm-5']) {
      expect(table?.[id]).toBeUndefined();
      const got = estimateLlmCost({ model: id, inputTokens: MILLION, outputTokens: MILLION }, noOverlay);
      expect(got).toEqual({ kind: 'unknown', model: id });
      expect('usd' in got).toBe(false);
    }
  });

  it('bedrock/ aliases without a price row and ids outside the catalog fall to the unknown safety branch', () => {
    for (const model of ['bedrock/zai.glm-5', 'bedrock/openai.gpt-6-sol', 'bedrock/acme.mystery-1']) {
      expect(estimateLlmCost({ model, inputTokens: MILLION, outputTokens: MILLION }, noOverlay)).toEqual({ kind: 'unknown', model });
    }
  });

  it('every selectable mantle-openai id has exactly one decided outcome — known iff a price row exists', async () => {
    const table = (await bedrockNonAnthropicPricingTable()) ?? {};
    const nonAnthropic = BEDROCK_MODELS.filter((m) => m.route === 'mantle-openai');
    expect(nonAnthropic.length).toBeGreaterThan(0);
    for (const entry of nonAnthropic) {
      const got = estimateLlmCost({ model: entry.id, inputTokens: MILLION, outputTokens: MILLION }, noOverlay);
      const row = table[entry.id];
      if (row) {
        expect(got).toEqual({
          kind: 'known',
          model: entry.id,
          usd: row.inputPerM + row.outputPerM,
          source: 'bedrock-catalog',
          cacheReadPricedAt: 'input-rate',
          cacheWritePricedAt: 'input-rate',
        });
      } else {
        expect(got).toEqual({ kind: 'unknown', model: entry.id });
      }
    }
  });

  it('the landed Claude 5.5 Bedrock table is byte-identical (preservation contract)', () => {
    expect(JSON.stringify(BEDROCK_PRICING_USD)).toBe(
      '{"claude-haiku-5-5":{"inputPerM":0.1,"outputPerM":0.5,"cacheWritePerM":0.125,"cacheReadPerM":0.01},'
      + '"claude-sonnet-5-5":{"inputPerM":2,"outputPerM":10,"cacheWritePerM":2.5,"cacheReadPerM":0.1},'
      + '"claude-opus-5-5":{"inputPerM":4,"outputPerM":20,"cacheWritePerM":5,"cacheReadPerM":0.2}}',
    );
  });

  it('date suffixes and us./global. prefixes do not open the Claude-only Bedrock gate', () => {
    expect(bedrockPricingModelId('openai.gpt-6-sol')).toBe('openai.gpt-6-sol');
    // 양성 대조 — 같은 정규화 안에서 Claude id 의 게이트는 그대로 열려 Bedrock 표로 known.
    expect(estimateLlmCost({ model: 'global.anthropic.claude-sonnet-5-5', inputTokens: MILLION, outputTokens: 0 }, noOverlay))
      .toMatchObject({ kind: 'known', source: 'bedrock-catalog' });
    // 비-Anthropic id 는 접두·날짜 꼬리를 붙여도 게이트가 열리지 않는다.
    for (const model of ['openai.gpt-6-sol-20251001', 'bedrock/zai.glm-5-20251001', 'global.zai.glm-5']) {
      expect(estimateLlmCost({ model, inputTokens: MILLION, outputTokens: MILLION }, noOverlay)).toEqual({ kind: 'unknown', model });
    }
  });

  it('logAgentTurnUsage keeps an honest unknown — never a zero-dressed known — for a mantle-openai id on the bedrock route', () => {
    const spy = spyOn(debug, 'log');
    try {
      logAgentTurnUsage('zai.glm-5', {
        provider: 'openai',
        inputTokens: MILLION,
        outputTokens: MILLION,
      }, { providerName: 'bedrock', site: 'bedrock-cost-test' });
      const row = spy.mock.calls.find((call) =>
        call[0] === 'llm.usage' && call[1] === 'llm-usage' && (call[2] as { site?: string })?.site === 'bedrock-cost-test');
      expect(row).toBeDefined();
      expect(row![2]).toMatchObject({ model: 'zai.glm-5', billingProvider: 'bedrock' });
      expect((row![2] as { cost: unknown }).cost).toEqual({ kind: 'unknown', model: 'zai.glm-5' });

      // 근거 있는 id 는 같은 생산 원장 경로에서 bedrock-catalog/known 으로 찍힌다.
      logAgentTurnUsage('deepseek.v3.2', {
        provider: 'openai',
        inputTokens: MILLION,
        outputTokens: MILLION,
      }, { providerName: 'bedrock', site: 'bedrock-cost-known-test' });
      const knownRow = spy.mock.calls.find((call) =>
        call[0] === 'llm.usage' && call[1] === 'llm-usage' && (call[2] as { site?: string })?.site === 'bedrock-cost-known-test');
      expect(knownRow).toBeDefined();
      expect(knownRow![2]).toMatchObject({ model: 'deepseek.v3.2', billingProvider: 'bedrock' });
      expect((knownRow![2] as { cost: unknown }).cost).toEqual({
        kind: 'known',
        model: 'deepseek.v3.2',
        usd: 0.62 + 1.85,
        source: 'bedrock-catalog',
        cacheReadPricedAt: 'input-rate',
        cacheWritePricedAt: 'input-rate',
      });
    } finally {
      spy.mockRestore();
    }
  });
});

// BACKLOG C7 — provider 보고 청구액이 있으면 그것이 비용(추정은 곁에).
import { llmUsageCostFields as fieldsC7 } from './llm-cost.js';
import { _resetCodexBillingDecisionForTesting } from '../oauth/codex-billing-route.js';
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

describe('Codex credit billing (METER-CODEX-CREDIT-ACTUAL)', () => {
  it('selects credit only for an exhausted window with available credits', () => {
    expect(creditRouteFromQuotaSignal({ usedPercent: 100, hasCredits: true })).toBe('credit');
    expect(creditRouteFromQuotaSignal({ usedPercent: 99.9, rateLimitReached: true, hasCredits: true })).toBe('credit');
    expect(creditRouteFromQuotaSignal({ usedPercent: 99.9, hasCredits: true })).toBeNull();
    expect(creditRouteFromQuotaSignal({ usedPercent: 100, hasCredits: false })).toBeNull();
  });

  it('does not infer credit from absent or incomplete quota data', () => {
    expect(creditRouteFromQuotaSignal(null)).toBeNull();
    expect(creditRouteFromQuotaSignal({ hasCredits: true })).toBeNull();
    expect(creditRouteFromQuotaSignal({ usedPercent: 100 })).toBeNull();
    expect(creditRouteFromQuotaSignal({ usedPercent: Number.NaN, hasCredits: true })).toBeNull();
  });

  it('records credit separately from dollars while retaining a known API equivalent', () => {
    const equivalent = findCodexModel('gpt-5.6-terra')!.pricingUsd!.inputPerM;
    expect(llmUsageCostFields('gpt-5.6-terra', { inputTokens: MILLION, outputTokens: 0 }, noOverlay, 'credit'))
      .toEqual({ cost: { kind: 'credit', model: 'gpt-5.6-terra', usd: null, apiEquivalentUsd: equivalent } });
    expect(llmUsageCostFields('absent-model-for-test', { inputTokens: 3 }, noOverlay, 'credit'))
      .toEqual({ cost: { kind: 'credit', model: 'absent-model-for-test', usd: null } });
  });

  it('keeps an explicit credit route when conflicting provider or BYOK amounts are present', () => {
    const base = { inputTokens: MILLION, outputTokens: 0 };
    const equivalent = findCodexModel('gpt-5.6-terra')!.pricingUsd!.inputPerM;
    expect(llmUsageCostFields('gpt-5.6-terra', { ...base, reportedCostUsd: 1.23 } as never, noOverlay, 'credit'))
      .toEqual({ cost: { kind: 'credit', model: 'gpt-5.6-terra', usd: null, apiEquivalentUsd: equivalent } });
    expect(llmUsageCostFields('gpt-5.6-terra', { ...base, byok: true, reportedCostUsd: 1.23, upstreamCostUsd: 2.34 } as never, noOverlay, 'credit'))
      .toEqual({ cost: { kind: 'credit', model: 'gpt-5.6-terra', usd: null, apiEquivalentUsd: equivalent } });
  });

  it('does not label a production usage row as credit without a verified payment route', () => {
    // CREDIT-BILLING-LABEL — 회전 판정이 남긴 크레딧 경로(다른 시험 파일의 잔여)가 없을 때의 기본값을 잰다.
    _resetCodexBillingDecisionForTesting();
    const spy = spyOn(debug, 'log');
    try {
      logAgentTurnUsage('gpt-5.6-terra', {
        provider: 'openai', inputTokens: MILLION, outputTokens: 0,
      }, { providerName: 'openai-codex', site: 'codex-billing-test' });
      const row = spy.mock.calls.find((call) =>
        call[0] === 'llm.usage' && (call[2] as { site?: string })?.site === 'codex-billing-test');
      expect(row).toBeDefined();
      expect(row![2]).toMatchObject({ billingProvider: 'openai-codex', inputTokens: MILLION, outputTokens: 0 });
      const recorded = row![2] as { billing: string; cost: unknown };
      const equivalent = findCodexModel('gpt-5.6-terra')!.pricingUsd!.inputPerM;
      expect(['subscription', 'unknown']).toContain(recorded.billing);
      if (recorded.billing === 'subscription') {
        expect(recorded.cost).toEqual({ kind: 'included', model: 'gpt-5.6-terra', usd: 0, billing: 'subscription', apiEquivalentUsd: equivalent });
      } else {
        expect(recorded.cost).toEqual({ kind: 'known', model: 'gpt-5.6-terra', usd: equivalent, source: 'catalog', cacheReadPricedAt: 'input-rate', cacheWritePricedAt: 'input-rate' });
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves the existing subscription estimate as an API equivalent', () => {
    const estimate = findCodexModel('gpt-5.6-terra')!.pricingUsd!.inputPerM;
    expect(llmUsageCostFields('gpt-5.6-terra', { inputTokens: MILLION, outputTokens: 0 }, noOverlay, 'subscription'))
      .toEqual({ cost: { kind: 'included', model: 'gpt-5.6-terra', usd: 0, billing: 'subscription', apiEquivalentUsd: estimate } });
  });
});
