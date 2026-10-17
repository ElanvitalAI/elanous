// ── TUI 턴의 실행 모델 결정 (TUI-MODEL-SESSION-SCOPE · 10-14) ──
//
// ACP 브리지 `getActiveModel`(dashboard/index.ts) 의 본체. 인라인 클로저였을 때는 시험이 «같은 모양을
// 재현»할 수밖에 없어, 실제 경로가 깨져도 시험이 초록이었다(1R 리뷰 GOODHART 지적). 함수로 빼서
// 실물 `/model` 핸들러 → 이 함수 → route-decision 을 그대로 잇는다.

import { debug } from '../debug/log.js';
import { effectiveReasoningLevel } from '../llm.js';
import { clearSurfaceRouteDecision, currentRouteDecision, recordCurrentRouteDecision, recordRouteExecution, resolveRouteDecision, sessionModelPin } from '../llm/route-decision.js';
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

/** 턴 사용량(ACP `elanous/ui/usage`)이 실어 온 «실제» 공급자·모델을 이 표면의 실행으로 적는다
 *  (TUI-MODEL-BADGE-ACTUAL · 10-16). 완료 배지가 결정과 다르면 «A → B» 로 보인다.
 *  폴백(결정과 다른 모델)이면 관측 이벤트 `llm.route-decision` / `dashboard-executed-fallback` 를 «항상» 남긴다. */
export function recordDashboardTurnExecution(
  usage: { model?: string; routeProvider?: string } | null | undefined,
  /** 필수 — 세션 위치를 모르면(null) 적지 않는다(원격 사용량을 로컬 실행으로 꾸미지 않게). */
  session: { remote: boolean } | null,
): void {
  // ⛔ 순서: 원격·세션 미상 판정(⊕ 비우기)을 model 검사보다 «먼저» 한다 — 사용량 봉투의 model 은 선택 칸이라,
  //   모델 없는 원격 사용량이 먼저 반환하면 지난 로컬 턴의 «A → B» 가 남는다(r6 리뷰).
  const model = usage?.model?.trim() || null;
  if (session === null) {
    // 짝을 모르는 턴 — 지난 턴의 결정·실행이 이 턴의 배지로 «다시» 보이지 않게 비운다.
    clearSurfaceRouteDecision('dashboard');
    debug.log('llm.route-decision', 'dashboard-executed-session-unknown', { model }, { level: 'warn' });
    return;
  }
  // ⛔ 원격 데몬 세션은 적지 않는다 — 결정은 데몬 쪽에서 서므로 이 프로세스의 결정과 짝이 안 맞는다.
  //   후속 칸 TUI-MODEL-BADGE-REMOTE.
  if (session.remote) {
    // 원격 턴은 로컬 결정과 짝이 없다 — 지난 로컬 턴의 «A → B» 가 이 턴의 배지로 다시 나오지 않게 비운다(r5 리뷰).
    clearSurfaceRouteDecision('dashboard');
    if (debug.enabled) debug.log('llm.route-decision', 'dashboard-executed-remote-skipped', { model });
    return;
  }
  if (!model) return;
  const provider = usage?.routeProvider?.trim() || undefined;
  const decision = currentRouteDecision('dashboard');
  // 결정이 없는 실행은 짝이 없다 — 적지 않는다.
  if (!decision) return;
  recordRouteExecution('dashboard', { model, ...(provider ? { provider } : {}) });
  if (decision.model !== '' && decision.model !== model) {
    debug.log('llm.route-decision', 'dashboard-executed-fallback', {
      planned: { provider: decision.provider, model: decision.model },
      actual: { provider: provider ?? null, model },
    }, { level: 'warn' });
  } else if (debug.enabled) {
    debug.log('llm.route-decision', 'dashboard-executed', { provider: provider ?? null, model });
  }
}
