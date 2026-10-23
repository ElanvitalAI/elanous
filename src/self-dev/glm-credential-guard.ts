/**
 * GLM-NO-CREDENTIAL-FALLBACK (OP #28375 · 10-22) — 하니스 자식 공급자가 `glm`(Z.ai GLM Coding Plan 직결)인데
 * 이 프로세스에 Z.ai 자격이 없으면, 구현 라운드를 «열기 전»에 정한다:
 *   · OpenRouter 키가 있으면 → `openrouter` / `openrouter/z-ai/glm-5.3` 로 바꿔 발사한다(같은 GLM 계열 · 관측 한 줄).
 *   · 둘 다 없으면 → 이유 한 줄로 발사 전에 거부한다(조용한 no-progress 라운드를 만들지 않는다).
 *
 * ⭐ 자격 판정은 생산 해석기 그대로다 — `zaiCodingPlanAvailable()`(키 캐시 `~/.cache/zai_api_key` → env `ZAI_API_KEY`)이
 *   `getProviderForConfig` 가 glm 직결을 세우는 조건과 «같은» 함수이고, OpenRouter 는 `getOpenRouterApiKey()` 다.
 * ⛔ Pod 경로는 이 판정 «전»에 이미 fail-closed 다(`pod-zai-child.ts` · 클러스터 Secret 판정). Pod 안에선 Secret 이
 *   `ZAI_API_KEY` 를 env 로 주므로 여기는 그대로 통과한다(keep). 이 모듈은 호스트 로컬 자식·Secret 밖 경로의 받침이다.
 * ⛔ 이 모듈은 가볍게 둔다(무거운 import 0) — dev-pipeline 이 발사 직전에 부른다.
 */

import type { ChildLlmSelection } from '../agent/run-context.js';
import { getOpenRouterApiKey } from '../config.js';
import { debug } from '../debug/log.js';
import { ZAI_OPENROUTER_FALLBACK_MODEL, zaiCodingPlanAvailable } from '../llm/zai-coding-plan.js';

export interface GlmCredentialProbe {
  /** Z.ai 직결이 서나 — 기본 = 생산 `zaiCodingPlanAvailable()`. */
  readonly zai: () => boolean;
  /** OpenRouter 키가 있나 — 기본 = 생산 `getOpenRouterApiKey()`. */
  readonly openrouter: () => boolean;
}

export const defaultGlmCredentialProbe: GlmCredentialProbe = {
  zai: () => zaiCodingPlanAvailable(),
  openrouter: () => Boolean(getOpenRouterApiKey()?.trim()),
};

export type GlmCredentialDecision =
  | { kind: 'keep' }
  | { kind: 'fallback'; from: string; to: string; reason: string }
  | { kind: 'refuse'; reason: string };

/** 발사 전 거부 — 호출부가 자기 오류 종류로 감싼다(dev-pipeline 은 DevPipelineError). */
export class GlmChildCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlmChildCredentialError';
  }
}

const ZAI_MISSING = 'Z.ai 자격 없음(~/.cache/zai_api_key · env ZAI_API_KEY)';

/** 순수 판정 — glm 이 아니면 언제나 keep. */
export function decideGlmChildCredential(
  selection: Pick<ChildLlmSelection, 'provider' | 'model'> | undefined,
  probe: GlmCredentialProbe = defaultGlmCredentialProbe,
): GlmCredentialDecision {
  if (!selection || selection.provider.trim().toLowerCase() !== 'glm') return { kind: 'keep' };
  if (probe.zai()) return { kind: 'keep' };
  const from = `glm/${selection.model}`;
  if (probe.openrouter()) {
    return { kind: 'fallback', from, to: `openrouter/${ZAI_OPENROUTER_FALLBACK_MODEL}`, reason: `${ZAI_MISSING} · OpenRouter 키 있음 → OpenRouter GLM 으로 발사` };
  }
  return {
    kind: 'refuse',
    reason: `child provider glm(${selection.model}) 발사 전 거부 — ${ZAI_MISSING} ⊕ OpenRouter 키 없음(~/.cache/openrouter_api_key · env OPENROUTER_API_KEY) · 자격 하나를 세우거나 --child-llm-provider 를 바꿔라`,
  };
}

/** 발사 직전 적용 — keep 이면 같은 객체, fallback 이면 바꾼 선택, refuse 면 던진다. 결정마다 관측 한 줄. */
export function applyGlmCredentialFallback(
  selection: ChildLlmSelection | undefined,
  probe: GlmCredentialProbe = defaultGlmCredentialProbe,
): ChildLlmSelection | undefined {
  const decision = decideGlmChildCredential(selection, probe);
  if (decision.kind === 'keep') return selection;
  if (decision.kind === 'fallback') {
    debug.log('self-dev.child-llm', 'glm-no-credential-fallback', { from: decision.from, to: decision.to, reason: decision.reason }, { level: 'warn' });
    // effort·source·codexQuotaPolicy 는 그대로 — 바뀌는 것은 «길»(provider·model)뿐이다.
    return { ...selection!, provider: 'openrouter', model: ZAI_OPENROUTER_FALLBACK_MODEL };
  }
  debug.log('self-dev.child-llm', 'glm-no-credential-refused', { from: `glm/${selection!.model}`, reason: decision.reason }, { level: 'warn' });
  throw new GlmChildCredentialError(decision.reason);
}
