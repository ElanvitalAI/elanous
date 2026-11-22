// HARNESS-DIFFICULTY-ROUTER — 하니스 발사 결정점 배선(골 문서 → 일감 신호 → 코어 → 원장).
//
// 판정은 `src/model-tier/work-risk-router.ts`(순수), 등급·모델·계정은 코어(`model-orchestration.ts`) 하나가 정한다.
// 여기서는 ⑴ 골 문서의 «구조 칸»만 읽어 일감 신호를 만들고 ⑵ user-config `harness.difficultyRouter` 를 읽고
// ⑶ 코어 결정 한 줄(`harness.route-decision`)을 런 원장·logs.db 에 남긴다.
// ⛔ 골 산문·프롬프트 문면은 읽지도 싣지도 않는다 — 경로 · `위험 범주:` · `위험 등급:` 줄만.

import { goalTargetPaths } from '../llm/difficulty.js';
import { verbatimOriginalAsk } from './goal-author.js';
import { classifyWorkRisk, workRiskInputFromFields, type WorkRiskClassification, type WorkRiskInput } from '../model-tier/work-risk-router.js';
import { modelOrchestrationCore } from '../model-tier/model-orchestration.js';
import type { AccountCandidate, AccountState, CoreDecision, CoreDecisionInput, CoreMode, ModelOrchestrationCore } from '../model-tier/orchestration-core.js';
import { WINDOW_ACCOUNT_EVENT } from '../model-tier/window-account-selector.js';
import { debug } from '../debug/log.js';
import { recordWorkRouteDecision, type WorkRouteLedgerDeps } from './work-route-ledger.js';

export { WORK_ROUTE_LEDGER_EVENT, recordWorkRouteDecision, resolveWorkRouteMode, type WorkRouteLedgerDeps } from './work-route-ledger.js';

/** 골 문서의 구조 칸 → 판정 입력. 경로는 골 저작기의 «대상 경로»(없으면 추적 경로) · 범주·등급은 `위험 범주:`·`위험 등급:` 줄. */
export function workRiskInputFromGoal(document: string): WorkRiskInput {
  return workRiskInputFromFields(verbatimOriginalAsk(document) ?? document, goalTargetPaths(document));
}

export interface WorkRoutePlan {
  readonly classification: WorkRiskClassification;
  readonly input: CoreDecisionInput;
  readonly decision: CoreDecision;
}

/** 발사(구현 순간) 결정 — 코어를 한 번 부른다. runId 는 원장에 쓸 때 채운다.
 *  계정·창 스냅숏(COST-OPTIMIZER-WINDOW-AWARE)은 호출측이 «반드시» 넘긴다 — 기본 인자를 두지 않는다:
 *  JS 기본 인자는 명시 `undefined`(읽기 실패)에도 다시 돌아 디스크를 한 번 더 읽는다(OP 리뷰 #38337 mf1).
 *  `undefined` = 스냅숏 없음 → 선택기가 `refused:no-snapshot` 으로 활성 계정을 지킨다. */
export function planWorkRoute(document: string, provider: string, accounts: AccountState | undefined,
  core: ModelOrchestrationCore = modelOrchestrationCore()): WorkRoutePlan {
  const classification = classifyWorkRisk(workRiskInputFromGoal(document));
  const input: CoreDecisionInput = { runId: '', moment: 'implement', provider, work: classification, ...(accounts ? { accounts } : {}) };
  return { classification, input, decision: core.decide(input) };
}

/** COST-OPTIMIZER-WINDOW-AWARE — `on` 에서 창 선택기가 활성과 다른 계정을 골랐을 때만 자식 계정 env 를 낸다.
 *  같은 provider(openai-codex)만 · 명시 계정이면 선택기가 이미 거절했다 · 그 밖은 빈 객체(발사 불변). */
export interface WindowAccountLaunch {
  /** 자식에 넘길 env — 비어 있으면 계정 불변. */
  readonly env: Record<string, string>;
  /** env 를 넘겼을 때만 — 원장 `accountApplied`·`appliedAccount` 의 근원(같은 객체에서 나온다). */
  readonly applied: { readonly kind: AccountCandidate['billing']; readonly account: string } | null;
}

const NO_SWITCH: WindowAccountLaunch = { env: {}, applied: null };

/** 발사 한 번의 계정 적용 판단 — env 와 원장 칸을 «한 판단»에서 낸다(둘이 어긋나지 않게 · 리뷰 #38337 sf1). */
export function windowAccountLaunch(plan: WorkRoutePlan, launchedProvider: string | null | undefined,
  emit: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d)): WindowAccountLaunch {
  const accounts = plan.input.accounts;
  const { decision } = plan;
  // 선택기가 이미 이벤트를 낸 갈래(shadow · 거절 · 같은 계정)는 여기서 다시 내지 않는다.
  if (accounts?.selection !== 'on' || !accounts.active || accounts.explicit === true) return NO_SWITCH;
  const codex = accounts.routerMix?.codex;
  const actualActive = decision.provider === 'openai-codex' && codex ? codex.active?.account : accounts.active.account;
  if (decision.account === null || decision.account === actualActive) return NO_SWITCH;
  const skip = (reason: string): WindowAccountLaunch => {
    try { emit(WINDOW_ACCOUNT_EVENT, 'apply-skip', { reason, provider: decision.provider, launchedProvider: launchedProvider ?? null }); } catch { /* fail-soft */ }
    return NO_SWITCH;
  };
  if (launchedProvider !== decision.provider ||
      (decision.provider !== accounts.active.provider && !(accounts.routerMix && decision.provider === 'openai-codex')))
    return skip('provider-mismatch');
  if (decision.provider !== 'openai-codex' && decision.provider !== 'codex') return skip('provider-not-switchable');
  const kind = (codex?.candidates ?? accounts.candidates).find((c) => c.provider === decision.provider && c.account === decision.account)?.billing ?? 'unknown';
  return { env: { ELANOUS_CODEX_ACCOUNT: decision.account }, applied: { kind, account: decision.account } };
}

/** `windowAccountLaunch` 의 env 만. */
export function windowAccountChildEnv(plan: WorkRoutePlan, launchedProvider: string | null | undefined,
  emit?: (category: string, event: string, data: Record<string, unknown>) => void): Record<string, string> {
  return windowAccountLaunch(plan, launchedProvider, emit).env;
}

/** 발사 결정을 runId 와 함께 원장에 남긴다(PTY·폴백 두 갈래 공용). */
export function recordLaunchRoute(route: { plan: WorkRoutePlan; mode: CoreMode; applied: boolean; skip: string | null },
  runId: string, launched: { provider: string | null; model: string | null }, deps: WorkRouteLedgerDeps = {}, core: ModelOrchestrationCore = modelOrchestrationCore(),
  appliedAccount: WindowAccountLaunch['applied'] = null): void {
  void recordWorkRouteDecision(core.decisionRecord(route.plan.decision, { ...route.plan.input, runId },
    { mode: route.mode, applied: route.applied, skip: route.skip, launched, appliedAccount }), deps);
}
