// ── 공용 tier 모델 선택 ────────────────────────────────────────────────────
//
// ⛔⭐ 호출 지점은 «모델 이름»이 아니라 «필요 성능(tier)»만 선언한다 (대표 2026-08-18).
//    이전에는 지점마다 `process.env.X || 'gpt-5.6-sol'` 로 모델을 «문자열»로 박아
//    두었고, 그래서 llm.provider 를 바꿔도 그 지점들이 따라오지 않았다(실측 28곳).
//    티어로 선언하면 활성 provider 의 사다리(LLM_TIER_MAP_BY_PROVIDER)가 실제 모델을
//    채우므로 provider 전환이 «자동»으로 전 구간에 전파된다.
//
// 경량 분류·판정 호출은 모델 family를 직접 고정하지 않는다. 활성 provider의 budget
// tier를 해석해 cross-family 라우팅/인증 실패를 막고, site 별 환경변수 override는 호출부에 둔다.

import { lookupLlmTierSpec } from '../model-tier/index.js';
import type { ModelTier } from '../model-tier/types.js';
import { getUserConfig, type LLMProviderName, type ReasoningLevel } from '../user-config.js';

/** Provider used for tier defaults. Model-env mismatches are named in
 *  user-config at selection time; this layer stays on the provider ladder
 *  so a foreign `ELANOUS_LLM_MODEL` cannot retarget active-provider defaults.
 *  ⛔ `openai` 와 `openai-codex` 는 사다리가 다르다 — gpt-5.6-sol 은
 *     openai-codex 눈금이고 openai 기본값을 덮어쓰지 않는다.
 *  ⛔ Do not import this file from user-config — that is the cycle. */
function activeProviderForDefaults(provider?: LLMProviderName): LLMProviderName {
  if (provider) return provider;
  const configured = getUserConfig().llm.provider;
  return configured === 'auto' ? decidedAutoProvider() : configured;
}

/** `auto` has no ladder of its own — the tier map answers it with Anthropic's model, so a grok-only
 *  (or codex-only) user asked for a Claude model at every tier call site and hit «set ANTHROPIC_API_KEY».
 *  Resolve `auto` the way the router does (decideProviderForConfig) and use that provider's ladder.
 *  Late require: llm.ts imports this module. */
let decideAuto: () => LLMProviderName | undefined = () => {
  const { decideProviderForConfig } = require('../llm.js') as typeof import('../llm.js');
  const decided = String(decideProviderForConfig(getUserConfig()).provider).replace(/^auto:/, '');
  return decided && decided !== 'auto' ? decided as LLMProviderName : undefined;
};
function decidedAutoProvider(): LLMProviderName {
  try { return decideAuto() ?? 'auto'; } catch { return 'auto'; }
}
/** Test seam — swap the auto decision. */
export function setAutoProviderDecisionForTest(fn: (() => LLMProviderName | undefined) | undefined): void {
  decideAuto = fn ?? (() => {
    const { decideProviderForConfig } = require('../llm.js') as typeof import('../llm.js');
    const decided = String(decideProviderForConfig(getUserConfig()).provider).replace(/^auto:/, '');
    return decided && decided !== 'auto' ? decided as LLMProviderName : undefined;
  });
}

/** config/tier 해석이 «실패»했을 때만 타는 최후 폴백. 티어 사다리가 안 읽히는
 *  상황(부팅 초기·손상된 config)에서도 지점이 «성능 등급에 맞는» 모델을 얻게 한다. */
const LEGACY_TIER_FALLBACK: Readonly<Record<ModelTier, string>> = {
  // 🩸 2026-09-23 — 이 폴백이 GPT-6 이관 뒤에도 gpt-5.6-* 였다(결정 지적 · GPT-6 에는 terra 가 없다).
  //   사다리가 안 읽힐 때만 쓰이므로 codex 사다리의 «현재 값»과 같게 둔다(시험이 사다리와 대조한다).
  budget: 'gpt-6-luna',
  balanced: 'gpt-6-sol',
  better: 'gpt-6-sol',
  best: 'gpt-6-sol',
  loaded: 'gpt-6-astra',
};

/** 활성(또는 명시) provider 에서 그 tier 에 해당하는 모델 id.
 *  ⭐ 호출부는 이것만 쓰고 모델 이름을 박지 않는다. */
export function tierModel(tier: ModelTier, provider?: LLMProviderName): string {
  try {
    return lookupLlmTierSpec(activeProviderForDefaults(provider), tier).model;
  } catch {
    return LEGACY_TIER_FALLBACK[tier];
  }
}

/** 모델 ⊕ 그 tier 가 «선호하는» 추론 강도를 함께 돌려준다.
 *  ⛔ 지점이 reasoningEffort 를 따로 하드코딩하면 provider 를 바꿀 때 또 어긋난다. */
export function tierCall(
  tier: ModelTier,
  provider?: LLMProviderName,
): { model: string; reasoningEffort?: ReasoningLevel } {
  try {
    const spec = lookupLlmTierSpec(activeProviderForDefaults(provider), tier);
    return spec.reasoningLevel
      ? { model: spec.model, reasoningEffort: spec.reasoningLevel }
      : { model: spec.model };
  } catch {
    return { model: LEGACY_TIER_FALLBACK[tier] };
  }
}

/** 활성(또는 명시) provider의 경량 budget-tier 모델. config/tier 해석 실패 시에만 legacy 최후 폴백. */
export function budgetModel(provider?: LLMProviderName): string {
  return tierModel('budget', provider);
}
