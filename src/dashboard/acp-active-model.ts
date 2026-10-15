// ── TUI 턴의 실행 모델 결정 (TUI-MODEL-SESSION-SCOPE · 10-14) ──
//
// ACP 브리지 `getActiveModel`(dashboard/index.ts) 의 본체. 인라인 클로저였을 때는 시험이 «같은 모양을
// 재현»할 수밖에 없어, 실제 경로가 깨져도 시험이 초록이었다(1R 리뷰 GOODHART 지적). 함수로 빼서
// 실물 `/model` 핸들러 → 이 함수 → route-decision 을 그대로 잇는다.

import { debug } from '../debug/log.js';
import { effectiveReasoningLevel } from '../llm.js';
import { recordCurrentRouteDecision, resolveRouteDecision, sessionModelPin } from '../llm/route-decision.js';
import { inspectActiveProvider } from '../provider-summary.js';
import { getUserConfig } from '../user-config.js';

/** The model the next dashboard turn runs, recorded as the surface's current route decision.
 *  A `/model` session pin goes in as `explicitModel`, so it beats the Codex tier policy. */
export function resolveDashboardActiveModel(userText: string): string | null {
  const cfg = getUserConfig();
  const pin = sessionModelPin('dashboard', cfg.llm.provider);
  const decision = resolveRouteDecision({
    provider: cfg.llm.provider,
    configuredModel: inspectActiveProvider().model,
    text: userText,
    routePolicy: cfg.llm.routePolicy,
    ...(pin ? { explicitModel: pin.model } : {}),
  });
  // Badge truthfulness(2026-07-19 goal-exec) — resolveRouteDecision 의 codex
  // tier-policy 브랜치는 curated effort(예: balanced=low)를 찍지만, codex provider 는
  // 그 값을 wire 로 보내지 않는다: 실제 effort 는 effectiveReasoningLevel(cfg)(config
  // 주도, reasoningLevel 미설정 시 model-default high). 그대로 두면 완료 뱃지가
  // "terra(low)" 로 떠 사용자가 모델이 약하게 돈다고 오해한다(실제 high). 실제 wire
  // effort 로 덮어써 뱃지를 진실하게. decision.effort 는 표시 전용이라 라우팅 무영향.
  const trueEffort = effectiveReasoningLevel(cfg.llm, decision.provider, decision.model);
  const badgedDecision = trueEffort && trueEffort !== 'off'
    ? { ...decision, effort: trueEffort }
    : decision;
  recordCurrentRouteDecision('dashboard', badgedDecision);
  if (debug.enabled) debug.log('llm.route-decision', 'dashboard-acp', {
    provider: decision.provider, model: decision.model, mission: decision.mission, source: decision.source,
  });
  return decision.model || null;
}
