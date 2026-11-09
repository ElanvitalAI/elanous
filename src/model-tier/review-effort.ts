import type { RoleLlmResolution } from '../user-config/types.js';
import { lookupLlmTierSpec, type LlmTierProvider } from './llm-tier-map.js';

/**
 * 리뷰 호출의 추론 강도 — ***모델을 고른 «같은» 역할 해석에서*** 가져온다.
 *
 * 🩸 왜 — 2026-09-23 실측: 리뷰 티어를 `loaded`→`best`(gpt-6-sol·**high**)로 올렸는데, 리뷰 호출부에
 *   `reasoningEffort: 'medium'` 이 박혀 있어 ***wire 에는 계속 `medium` 이 나갔다***(per-call 값이 티어를 이긴다).
 *   `llm/model-defaults.ts` 의 `tierCall` 주석이 바로 이것을 경고한다 — *"지점이 reasoningEffort 를 따로
 *   하드코딩하면 provider 를 바꿀 때 또 어긋난다."* 대표 결정(같은 날): ***리뷰는 high.***
 *
 * - 티어로 풀렸으면 그 티어의 `reasoningLevel` 을 쓴다(codex·grok 모두 best = high).
 * - 티어가 `off` 면 «안 보낸다»(추론 안 하는 칸에 억지로 싣지 않는다).
 * - ⛔ 티어 없이 «모델이 핀»된 경우(env/config 로 모델명만 준 경우)는 대표 결정대로 `high`.
 *
 * ⭐ 공용 모듈인 이유 — 리뷰 LLM 을 짓는 자리가 «둘»이다(`dev-pipeline` 의 무인 리뷰 · `elanous self review`).
 *   둘 다 `'medium'` 을 박고 있었다. 한쪽만 고치면 다른 쪽이 조용히 남는다.
 */
export function reviewReasoningEffort(
  role: Pick<RoleLlmResolution, 'provider' | 'tier'>,
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (!role.tier) return 'high';
  let level: string | undefined;
  try { level = lookupLlmTierSpec(role.provider as LlmTierProvider, role.tier).reasoningLevel; } catch { level = undefined; }
  if (!level) return 'high';
  if (level === 'off') return undefined;
  return level as 'low' | 'medium' | 'high' | 'xhigh';
}
