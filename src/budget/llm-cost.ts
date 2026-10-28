// Shared catalog-backed LLM cost ruler.
//
// Prices live in the four model catalogs. This file converts tokens to
// dollars, or says it cannot — it does not invent a number, and it does
// not treat "unknown" as 0.

import { findClaudeModel } from '../anthropic/models.js';
import { findCodexModel } from '../codex/models.js';
import { findGeminiModel } from '../gemini/models.js';
import { findGrokModel } from '../grok/models.js';
import { getUserConfig } from '../user-config.js';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import { getCatalog } from '../registry/loader.js';
import { byokCostFor, type ByokActualCost, type ByokPartialCost } from '../llm/openrouter-byok-cost.js';

export interface LlmPricingUsd {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
  /** 장문맥 단가 칸(BACKLOG C8 · 2026-09-25) — 한 요청의 프롬프트(새 입력 ⊕ 캐시 읽기 ⊕ 캐시 쓰기)가
   *  `thresholdTokens` 를 «넘으면» 그 요청 «전체»를 이 단가로 매긴다(Gemini Pro 의 200K 절벽 · 공식 문서: 초과분이 아니라 요청 전체).
   *  캐시 단가가 없으면 기본 캐시 단가를 입력 단가와 «같은 비율»로 올린다(추정 — 공식 표가 캐시 단가도 입력과 같은 배수로 올린다). */
  longContext?: { thresholdTokens: number; inputPerM: number; outputPerM: number; cacheReadPerM?: number; cacheWritePerM?: number };
}

/** AWS Bedrock Global Standard prices, USD per million tokens (AWS pricing API, ap-northeast-2).
 *  Anthropic(Claude) 축만 담는다 — 이 표는 `isBedrockPricingModel` 게이트(`claude-` 시작) 뒤에 있다.
 *  ⛔ BEDROCK-COST-LEDGER(0.2.38) — mantle-openai 비-Anthropic id 는 «다른 표»
 *  (`BEDROCK_NON_ANTHROPIC_PRICING_USD`)로 분리했다. 이 객체는 Claude 5.5 착지분 그대로다(보존 계약). */
export const BEDROCK_PRICING_USD: Readonly<Record<string, LlmPricingUsd>> = {
  'claude-haiku-5-5': { inputPerM: 0.1, outputPerM: 0.5, cacheWritePerM: 0.125, cacheReadPerM: 0.01 },
  'claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10, cacheWritePerM: 2.5, cacheReadPerM: 0.1 },
  'claude-opus-5-5': { inputPerM: 4, outputPerM: 20, cacheWritePerM: 5, cacheReadPerM: 0.2 },
};

/** Bedrock 비-Anthropic(mantle-openai) 단가의 근거 — AWS Price List API(`AmazonBedrock` offer,
 *  us-east-1 = mantle-openai 고정 리전) 조회 결과. 게시 시각 2026-10-16T21:08:06Z.
 *  재현: `awscurl`/SDK 로 `GetProducts`(serviceCode=AmazonBedrock, regionCode=USE1) 후
 *  `USE1-<id>-mantle-{input,output}-tokens-standard` 키의 `pricePerUnit.USD` 를 읽는다(1K 토큰 단가 ×1000 = per-M).
 *  ⛔ 근거 없는 id 는 표에 «넣지 않는다» — `kind:'unknown'` 에 머문다(0원으로 꾸미지 않는다). */
export const BEDROCK_NON_ANTHROPIC_PRICING_USD: Readonly<Record<string, LlmPricingUsd>> = {
  // AWS price list key: USE1-deepseek.v3.2-mantle-{input,output}-tokens-standard
  'deepseek.v3.2': { inputPerM: 0.62, outputPerM: 1.85 },
  // AWS price list key: USE1-zai.glm-4.7-flash-mantle-{input,output}-tokens-standard
  'zai.glm-4.7-flash': { inputPerM: 0.07, outputPerM: 0.4 },
  // AWS price list key: USE1-moonshotai.kimi-k2.5-mantle-{input,output}-tokens-standard
  'moonshotai.kimi-k2.5': { inputPerM: 0.6, outputPerM: 3 },
  // AWS price list key: USE1-qwen.qwen3-coder-next-mantle-{input,output}-tokens-standard
  'qwen.qwen3-coder-next': { inputPerM: 0.5, outputPerM: 1.2 },
  // AWS price list key: USE1-minimax.minimax-m2.5-mantle-{input,output}-tokens-standard
  'minimax.minimax-m2.5': { inputPerM: 0.3, outputPerM: 1.2 },
  // AWS price list key: USE1-mistral.devstral-2-123b-mantle-{input,output}-tokens-standard
  'mistral.devstral-2-123b': { inputPerM: 0.4, outputPerM: 2 },
  // ⛔ 근거 없음(AWS price list 조회 0행 → 표에 없음): openai.gpt-6-sol · openai.gpt-6-luna · zai.glm-5.
  //    이 셋은 지금 mantle-openai 로 선택 가능하지만 단가 근거가 없으므로 `kind:'unknown'` 이 정직한 답이다.
};

/** Bedrock 비-Anthropic(mantle-openai) 단가 조회용 id 정규화 — invoke id 모양을 표의 키로 되돌린다.
 *  - `bedrock/` 접두(레지스트리 별칭) · `us.`/`global.` 같은 리전 스코프 접두
 *  - `-v1:0` 버전 꼬리 · `-20251001` 날짜 꼬리
 *  Anthropic id(`anthropic.claude-…`)는 이 축이 아니다 — `bedrockPricingModelId` 가 맡는다. */
export function bedrockNonAnthropicPricingModelId(model: string): string {
  return model.trim()
    .replace(/^bedrock\//, '')
    .replace(/^(?:us|eu|apac|global)\./, '')
    .replace(/-v1:\d+$/, '')
    .replace(/-\d{8}$/, '');
}

export interface LlmCostUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** 추론(생각) 토큰 — ⛔ `outputTokens` 의 «부분집합»이다(OpenAI·Gemini 어댑터가 그렇게 싣는다).
   *  여기서 따로 매기지 않는다(이중 과금 방지) — 출력 단가 안에 이미 있다. 칸은 «얼마가 생각이었나»를 가르는 데만 쓴다. */
  reasoningOutputTokens?: number;
}

export interface EstimateLlmCostOptions {
  /** Overlay for models absent from catalogs. Catalog presence always wins. */
  configPricing?: Readonly<Record<string, LlmPricingUsd>>;
}

export type LlmCostOmittedField = 'inputTokens' | 'outputTokens';

export type LlmCostEstimate =
  | {
      kind: 'known';
      model: string;
      usd: number;
      source: 'catalog' | 'bedrock-catalog' | 'config' | 'registry';
      cacheReadPricedAt: 'cache-read' | 'input-rate';
      cacheWritePricedAt: 'cache-write' | 'input-rate';
      /** 장문맥 단가로 매겼으면 `'long-context'` — 없으면 기본 단가. */
      pricedTier?: 'long-context';
    }
  | {
      kind: 'partial';
      model: string;
      usd: number;
      source: 'catalog' | 'bedrock-catalog' | 'config' | 'registry';
      cacheReadPricedAt: 'cache-read' | 'input-rate';
      cacheWritePricedAt: 'cache-write' | 'input-rate';
      pricedTier?: 'long-context';
      omitted: LlmCostOmittedField[];
    }
  | {
      kind: 'unknown';
      model: string;
    };

/** `undefined` = absent from catalogs; `null` = present but no usable price. */
function catalogPricing(model: string): LlmPricingUsd | null | undefined {
  const entry =
    findCodexModel(model) ??
    findGrokModel(model) ??
    findGeminiModel(model) ??
    findClaudeModel(model);
  if (!entry) return undefined;
  return entry.pricingUsd;
}

function finiteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function tokenField(n: unknown): number | undefined {
  return finiteNonNegative(n) ? n : undefined;
}

function validPricing(value: LlmPricingUsd | null | undefined): value is LlmPricingUsd {
  return !!value
    && finiteNonNegative(value.inputPerM)
    && finiteNonNegative(value.outputPerM)
    && (value.cacheReadPerM === undefined || finiteNonNegative(value.cacheReadPerM))
    && (value.cacheWritePerM === undefined || finiteNonNegative(value.cacheWritePerM));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsePricingMap(value: unknown): Record<string, LlmPricingUsd> | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, LlmPricingUsd> = {};
  for (const [model, raw] of Object.entries(rec)) {
    const pricing = asRecord(raw);
    if (!pricing) continue;
    const candidate: LlmPricingUsd = {
      inputPerM: pricing.inputPerM as number,
      outputPerM: pricing.outputPerM as number,
      ...(finiteNonNegative(pricing.cacheReadPerM) ? { cacheReadPerM: pricing.cacheReadPerM } : {}),
      ...(finiteNonNegative(pricing.cacheWritePerM) ? { cacheWritePerM: pricing.cacheWritePerM } : {}),
    };
    if (!validPricing(candidate)) continue;
    out[model] = candidate;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read catalog-absent overlay prices from user config. Catalog still wins. */
export function readLlmConfigPricing(
  raw?: Record<string, unknown>,
): Readonly<Record<string, LlmPricingUsd>> | undefined {
  try {
    const source = raw ?? (getUserConfig() as { raw?: Record<string, unknown> }).raw;
    if (!source) return undefined;
    const budget = asRecord(source.budget);
    return parsePricingMap(budget?.llmPricing)
      ?? parsePricingMap(asRecord(source.llm)?.pricingUsd)
      ?? parsePricingMap(source.llmPricing);
  } catch {
    return undefined;
  }
}

/** 단가 조회용 id 정규화(BACKLOG C2 · hermes `usage_pricing` 의 이름 정규화와 같은 뜻).
 *  - 날짜 꼬리(`claude-haiku-4-5-20251001` → `claude-haiku-4-5`)
 *  - 게이트웨이·벤더 접두(`anthropic/claude-…` · `openrouter/anthropic/claude-…`)
 *  ⛔ `openrouter/<vendor>/<model>` 의 «비-Anthropic» 모델은 벗기지 않는다 — 그 단가는 OpenRouter 의 것이다(레지스트리가 안다). */
export function normalizePricingModelId(model: string): string {
  let m = model.trim();
  m = m.replace(/^openrouter\/(?=anthropic\/)/, '');
  m = m.replace(/^anthropic\//, '');
  m = m.replace(/-\d{8}$/, '');
  return m;
}

/** Normalize a Bedrock Anthropic model id to its bare Claude pricing id. */
export function bedrockPricingModelId(model: string): string {
  return model.trim()
    .replace(/^bedrock\//, '')
    .replace(/^[a-z0-9-]+\.anthropic\./i, '')
    .replace(/^anthropic\./, '')
    .replace(/-v1:0$/, '');
}

function isBedrockPricingModel(model: string): boolean {
  const trimmed = model.trim();
  return /^(?:bedrock\/|[a-z0-9-]+\.anthropic\.|anthropic\.)/i.test(trimmed)
    && bedrockPricingModelId(trimmed).startsWith('claude-');
}

/** 저장소의 모델 정본(intelligence-map BUILTIN_CATALOG) — 손 카탈로그 넷에 없는 모델(Claude 5 계열 등)의 입력·출력 단가.
 *  캐시 단가는 거기 없다 → Anthropic 모델은 공식 규칙(읽기 0.1× · 쓰기 5분 1.25×)으로 파생한다. 다른 벤더는 입력 단가로 매기고
 *  `cacheReadPricedAt: 'input-rate'` 로 그 사실을 드러낸다(추측하지 않는다). */
function builtinCatalogPricing(model: string): LlmPricingUsd | undefined {
  const e = BUILTIN_CATALOG.models.find((x) => x.id === model);
  if (!e || !finiteNonNegative(e.inputPerMtok) || !finiteNonNegative(e.outputPerMtok) || e.local) return undefined;
  return {
    inputPerM: e.inputPerMtok,
    outputPerM: e.outputPerMtok,
    ...(e.provider === 'anthropic' ? { cacheReadPerM: e.inputPerMtok * 0.1, cacheWritePerM: e.inputPerMtok * 1.25 } : {}),
  };
}

/** 레지스트리 카탈로그(발견 스냅숏 접힘 · OpenRouter `/models` 단가) — BACKLOG C1 · hermes `get_pricing_entry` 의 OpenRouter 경로. */
function registryPricing(model: string): LlmPricingUsd | undefined {
  try {
    const p = getCatalog().models.get(model)?.pricing;
    if (!p || !finiteNonNegative(p.inputPerMTok) || !finiteNonNegative(p.outputPerMTok)) return undefined;
    return { inputPerM: p.inputPerMTok, outputPerM: p.outputPerMTok, ...(finiteNonNegative(p.cachedInputPerMTok) ? { cacheReadPerM: p.cachedInputPerMTok } : {}) };
  } catch {
    return undefined;   // 카탈로그를 못 읽으면 «모른다» — 0 이 아니다
  }
}

function resolvePricing(
  model: string,
  opts?: EstimateLlmCostOptions,
): { pricing: LlmPricingUsd; source: 'catalog' | 'bedrock-catalog' | 'config' | 'registry' } | undefined {
  // ⭐ 순서: 손 카탈로그(정확) → 정규화 id → config 오버레이 → Claude Bedrock 표 → 저장소 정본 → mantle Bedrock 표 → 레지스트리. 앞이 이긴다.
  const normalized = normalizePricingModelId(model);
  for (const id of normalized === model ? [model] : [model, normalized]) {
    const catalog = catalogPricing(id);
    if (catalog !== undefined) return validPricing(catalog) ? { pricing: catalog, source: 'catalog' } : undefined;
  }
  for (const id of normalized === model ? [model] : [model, normalized]) {
    const overlay = opts?.configPricing?.[id];
    if (validPricing(overlay)) return { pricing: overlay, source: 'config' };
  }
  if (isBedrockPricingModel(model)) {
    const bedrock = BEDROCK_PRICING_USD[bedrockPricingModelId(model)];
    if (validPricing(bedrock)) return { pricing: bedrock, source: 'bedrock-catalog' };
  }
  // 저장소 정본이 mantle 표보다 우선한다. 같은 id 가 생기면 직접 모델 가격을 Bedrock 가격으로 덮지 않는다.
  const builtin = builtinCatalogPricing(normalized);
  if (validPricing(builtin)) return { pricing: builtin, source: 'catalog' };
  // BEDROCK-COST-LEDGER(0.2.38) — mantle-openai 비-Anthropic 축: 근거 있는 행만 bedrock-catalog 로 값을 낸다.
  // 표에 없는 id(openai.gpt-6-sol·zai.glm-5 등)는 여기서 결정되지 않아 아래 정본·레지스트리로 내려가고,
  // 그것도 없으면 `unknownCost()` — 0원으로 꾸미지 않는다.
  const mantle = BEDROCK_NON_ANTHROPIC_PRICING_USD[bedrockNonAnthropicPricingModelId(model)];
  if (validPricing(mantle)) return { pricing: mantle, source: 'bedrock-catalog' };
  const registry = registryPricing(model);
  if (validPricing(registry)) return { pricing: registry, source: 'registry' };
  return undefined;
}

/** 프롬프트가 장문맥 문턱을 «넘으면» 그 칸의 단가 — 아니면 기본 단가 그대로(같은 객체). */
export function longContextPricing(pricing: LlmPricingUsd, promptTokens: number): LlmPricingUsd {
  const tier = pricing.longContext;
  if (!tier || !finiteNonNegative(tier.thresholdTokens) || !finiteNonNegative(tier.inputPerM) || !finiteNonNegative(tier.outputPerM)) return pricing;
  if (!(promptTokens > tier.thresholdTokens)) return pricing;
  const ratio = pricing.inputPerM > 0 ? tier.inputPerM / pricing.inputPerM : 1;
  return {
    inputPerM: tier.inputPerM,
    outputPerM: tier.outputPerM,
    ...(finiteNonNegative(tier.cacheReadPerM) ? { cacheReadPerM: tier.cacheReadPerM }
      : pricing.cacheReadPerM !== undefined ? { cacheReadPerM: pricing.cacheReadPerM * ratio } : {}),
    ...(finiteNonNegative(tier.cacheWritePerM) ? { cacheWritePerM: tier.cacheWritePerM }
      : pricing.cacheWritePerM !== undefined ? { cacheWritePerM: pricing.cacheWritePerM * ratio } : {}),
  };
}

function unknownCost(model: string): LlmCostEstimate {
  return { kind: 'unknown', model };
}

export function estimateLlmCost(
  usage: LlmCostUsage,
  opts?: EstimateLlmCostOptions,
): LlmCostEstimate {
  const model = typeof usage.model === 'string' ? usage.model : '';
  const resolved = resolvePricing(model, opts);
  if (!resolved) return unknownCost(model);

  const { pricing: basePricing, source } = resolved;
  const promptTokens = (tokenField(usage.inputTokens) ?? 0)
    + (tokenField(usage.cacheReadInputTokens) ?? 0)
    + (tokenField(usage.cacheCreationInputTokens) ?? 0);
  const pricing = longContextPricing(basePricing, promptTokens);
  const pricedTier = pricing === basePricing ? undefined : 'long-context' as const;
  const cacheReadPricedAt: 'cache-read' | 'input-rate' =
    pricing.cacheReadPerM === undefined ? 'input-rate' : 'cache-read';
  const cacheWritePricedAt: 'cache-write' | 'input-rate' =
    pricing.cacheWritePerM === undefined ? 'input-rate' : 'cache-write';
  const cacheReadPerM = pricing.cacheReadPerM ?? pricing.inputPerM;
  const cacheWritePerM = pricing.cacheWritePerM ?? pricing.inputPerM;

  const inputTokens = tokenField(usage.inputTokens);
  const outputTokens = tokenField(usage.outputTokens);
  const omitted: LlmCostOmittedField[] = [
    ...(inputTokens === undefined ? ['inputTokens' as const] : []),
    ...(outputTokens === undefined ? ['outputTokens' as const] : []),
  ];

  const usd =
    ((inputTokens ?? 0) / 1_000_000) * pricing.inputPerM
    + ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerM
    + ((tokenField(usage.cacheReadInputTokens) ?? 0) / 1_000_000) * cacheReadPerM
    + ((tokenField(usage.cacheCreationInputTokens) ?? 0) / 1_000_000) * cacheWritePerM;

  if (omitted.length > 0) {
    return {
      kind: 'partial',
      model,
      usd,
      source,
      cacheReadPricedAt,
      cacheWritePricedAt,
      ...(pricedTier ? { pricedTier } : {}),
      omitted,
    };
  }

  return {
    kind: 'known',
    model,
    usd,
    source,
    cacheReadPricedAt,
    cacheWritePricedAt,
    ...(pricedTier ? { pricedTier } : {}),
  };
}

/** Discriminated cost fields to spread onto an `llm.usage` observation. */
/** 과금 경로(BACKLOG C6 · hermes `resolve_billing_route`). 구독(OAuth)·local 은 «토큰당 청구가 없다». */
export type BillingRoute = 'subscription' | 'local' | 'credit' | 'api' | 'unknown';

/** Credit is known only when the quota window is exhausted and credits are present. */
export function creditRouteFromQuotaSignal(signal: {
  usedPercent?: number | null;
  rateLimitReached?: boolean | null;
  hasCredits?: boolean | null;
} | null): 'credit' | null {
  if (!signal || signal.hasCredits !== true) return null;
  const exhausted = signal.rateLimitReached === true
    || (typeof signal.usedPercent === 'number' && Number.isFinite(signal.usedPercent) && signal.usedPercent >= 100);
  return exhausted ? 'credit' : null;
}

/** 구독·local 호출의 비용 — 청구 0 이지만 «API 로 샀다면」 값은 따로 남긴다(환산가 · 모르면 칸이 없다). */
/** provider 가 보고한 실제 청구액(OpenRouter `usage.cost`) — 카탈로그 추정과 다르면 이것이 맞다. */
export interface ActualLlmCost {
  kind: 'actual';
  model: string;
  usd: number;
  source: 'provider-reported';
  estimateUsd?: number;
}

export interface IncludedLlmCost {
  kind: 'included';
  model: string;
  usd: 0;
  billing: 'subscription' | 'local';
  apiEquivalentUsd?: number;
}

export interface CreditLlmCost {
  kind: 'credit';
  model: string;
  usd: null;
  apiEquivalentUsd?: number;
}

export function llmUsageCostFields(
  model: string,
  usage: Omit<LlmCostUsage, 'model'>,
  opts?: EstimateLlmCostOptions,
  billing?: BillingRoute,
): { cost: LlmCostEstimate | IncludedLlmCost | CreditLlmCost | ActualLlmCost | ByokActualCost | ByokPartialCost } {
  const resolved = opts ?? { configPricing: readLlmConfigPricing() };
  const estimate = estimateLlmCost({ model, ...usage }, resolved);
  // An explicit credit route owns this cost row; API/BYOK amounts belong to other routes.
  if (billing === 'credit') {
    return { cost: { kind: 'credit', model, usd: null, ...(estimate.kind === 'known' || estimate.kind === 'partial' ? { apiEquivalentUsd: estimate.usd } : {}) } };
  }
  // ⛔⭐ 구독을 API 단가로 «known» 이라 적지 않는다 — 09-25 벤치에서 codex 구독 팔이 `$7.81 known` 으로 보였다.
  // ⭐ BACKLOG C7 — provider 가 실어 보낸 «실제 청구액»이 있으면 그것이 비용이다(추정은 곁에 남긴다).
  // OR-BYOK-COST — BYOK 면 «OR 청구 + 상류 청구»가 비용이다(상류를 모르면 partial · 0 으로 가정하지 않는다).
  if (billing !== 'subscription' && billing !== 'local') {
    const byok = byokCostFor(model, usage as Parameters<typeof byokCostFor>[1], estimate.kind === 'known' || estimate.kind === 'partial' ? estimate.usd : undefined);
    if (byok) return { cost: byok };
  }
  const reported = (usage as { reportedCostUsd?: unknown }).reportedCostUsd;
  if (typeof reported === 'number' && Number.isFinite(reported) && billing !== 'subscription' && billing !== 'local') {
    return { cost: { kind: 'actual', model, usd: reported, source: 'provider-reported', ...(estimate.kind === 'known' || estimate.kind === 'partial' ? { estimateUsd: estimate.usd } : {}) } };
  }
  if (billing === 'subscription' || billing === 'local') {
    return { cost: { kind: 'included', model, usd: 0, billing, ...(estimate.kind === 'known' || estimate.kind === 'partial' ? { apiEquivalentUsd: estimate.usd } : {}) } };
  }
  return { cost: estimate };
}
