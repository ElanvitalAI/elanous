// 모델 오케스트레이션 코어 — 구현(계약 = `orchestration-core.ts`).
//
// 한 번의 `decide` 가 하는 일(순서 고정):
//   ① 기준 등급 — 일감 신호 × 순간: L1~3 = 약 · L4+ = 설계·판정 강 / 구현 중.
//   ② 올림 — 모듈 규칙(ADVISOR: 상담 순간 → 강) 다음 내장 규칙(섞기 정책 v0: 같은 오류 2회 · 빨강 3라운드 · 위험 첫 설계 → 한 단계).
//      첫 제안 «하나»만 쓴다. 판단 하나 뒤 내림은 호출측이 다음 `decide` 를 계기 없이 부르는 것으로 일어난다(상태 없음).
//   ③ 칸 — 등급 → 사다리 칸(약 budget · 중 better · 강 best) → provider 사다리의 모델 id.
//   ④ 계정 — 계정 선택 모듈(내장 기본 = 활성 계정 유지 · 프로세스 기본 = 창 인지 선택기 · shadow 면 활성 유지).
// 결정은 순수하다(시계·I/O 없음). 원장 쓰기는 호출측(`self-implement/work-route.ts`)이 한다.

import type { ModelTier } from './types.js';
import { LLM_TIER_MAP_BY_PROVIDER, type LlmTierProvider } from './llm-tier-map.js';
import type {
  AccountSelector,
  CoreDecision,
  CoreDecisionInput,
  CoreDecisionLedgerRecord,
  CoreModules,
  EscalateRule,
  ModelOrchestrationCore,
  TierGateModule,
  WorkMoment,
  WorkTierClass,
} from './orchestration-core.js';
import { isRiskyLevel } from './work-risk-router.js';
import { ADVISOR_ESCALATE_RULE } from './advisor-checkpoints.js';
import { WINDOW_AWARE_ACCOUNT_SELECTOR, accountIdHash } from './window-account-selector.js';
import { ROUTER_MIX_ACCOUNT_SELECTOR } from './router-mix-selector.js';
import { createSmartRouterTierGate, authorizeRouterFeature, envMembershipResolver } from '../plugins/smart-router/consumer.js';
import {
  STRONG_OUTPUT_MAX_TOKENS,
  WORK_TIER_CLASSES,
  WORK_TIER_LADDER_CELL,
  escalationTrigger,
  workTierUsageFields,
} from './work-tier-policy.js';

/** ① 기준 등급표 — 위험 여부 × 순간. 대표 정정(20:1x): 약 = budget 칸 · 중 = better 칸 · 강 = best 칸. */
export const CORE_BASE_TIER: Readonly<Record<'plain' | 'risky', Readonly<Record<WorkMoment, WorkTierClass>>>> = {
  plain: { design: 'weak', judge: 'weak', implement: 'weak' },
  risky: { design: 'strong', judge: 'strong', implement: 'mid' },
};

/** ② 내장 올림 규칙 — 섞기 정책 v0 표(한 단계). */
export const MIX_POLICY_RULE: EscalateRule = {
  name: 'mix-policy-v0',
  propose: ({ input }) => {
    const trigger = escalationTrigger(input.failures ?? {});
    return trigger ? { trigger } : null;
  },
};

/** ④ 기본 계정 선택 — 활성 계정을 그대로 둔다(창 인지 없음). */
export const ACTIVE_ACCOUNT_SELECTOR: AccountSelector = {
  name: 'active-account',
  select: ({ input }) => {
    const active = input.accounts?.active;
    return active
      ? { provider: active.provider, account: active.account, reason: 'active-account' }
      : { provider: input.provider, account: null, reason: 'no-account-state' };
  },
};

function defaultLadder(provider: string): Readonly<Record<ModelTier, { readonly model: string }>> | undefined {
  const name = provider.replace(/^auto:/, '');
  return Object.prototype.hasOwnProperty.call(LLM_TIER_MAP_BY_PROVIDER, name)
    ? LLM_TIER_MAP_BY_PROVIDER[name as LlmTierProvider]
    : undefined;
}

function oneStepUp(tier: WorkTierClass): WorkTierClass {
  return WORK_TIER_CLASSES[Math.min(WORK_TIER_CLASSES.indexOf(tier) + 1, WORK_TIER_CLASSES.length - 1)]!;
}

export function createModelOrchestrationCore(modules: CoreModules = {}): ModelOrchestrationCore {
  // 모듈 규칙(ADVISOR — checkpoint 가 있을 때만 제안) 먼저, 내장 섞기 정책 표가 마지막.
  const rules: readonly EscalateRule[] = [...(modules.escalate ?? []), MIX_POLICY_RULE];
  const selector = modules.accounts ?? ACTIVE_ACCOUNT_SELECTOR;
  const ladderOf = modules.ladder ?? defaultLadder;
  return {
    decide(input: CoreDecisionInput): CoreDecision {
      const base = CORE_BASE_TIER[isRiskyLevel(input.work.level) ? 'risky' : 'plain'][input.moment];
      const reason: string[] = [`level:${input.work.level}`, `moment:${input.moment}`, `base:${base}`];
      let tier = base;
      let trigger: CoreDecision['trigger'] = 'base';
      for (const rule of rules) {
        let proposal: ReturnType<EscalateRule['propose']> = null;
        try { proposal = rule.propose({ input, base }); } catch { reason.push(`rule-failed:${rule.name}`); }
        if (!proposal) continue;
        const target = proposal.target === 'strong' ? 'strong' : oneStepUp(base);
        trigger = proposal.trigger;
        if (target !== base) tier = target;
        reason.push(`escalate:${rule.name}:${proposal.trigger}:${base}->${tier}`);
        break; // 첫 제안 하나만 — 여러 계기가 겹쳐도 한 번
      }
      // SMART-ROUTER-PLUGIN-TIERS 등급 게이트 — 올림 결과가 회원 등급 표를 통과 못 하면 «올림만» 되돌린다(호출 차단 아님).
      // jud-39528 mustFix ①: base 가 이미 strong(risky design/judge)이어도 ADVISOR 유료 상담 «계기»는 심사 대상 —
      // 게이트는 trigger 를 본다(올림이 없는 계기도 심사). 거부 시 계기만 되돌린다(일반 strong 라우팅은 유지).
      if (modules.gate && (trigger !== 'base' || tier !== base)) {
        let verdict: ReturnType<TierGateModule['review']> | null = null;
        try { verdict = modules.gate.review({ trigger, checkpoint: input.checkpoint, tier }); } catch { reason.push(`gate-failed:${modules.gate.name}`); }
        if (verdict && !verdict.allowed) {
          reason.push(`gate-blocked:${modules.gate.name}:${verdict.reason ?? 'denied'}:${base}`);
          if (tier !== base) tier = base;
          trigger = 'base';
        }
      }
      const cell = WORK_TIER_LADDER_CELL[tier];
      // jud-39528 mustFix ②(r13 — JUD-2 HOLD 8929e2809624 · OP #132044): 구독 창 인식 계정 전환은 router.subscription_window_aware(프로+).
      // 거부 시 창 인식 선택기 «자체»를 건너뛴다 — ROUTER_MIX 만 막으면 기본 WINDOW_AWARE_ACCOUNT_SELECTOR 가
      // selection=on 에서 계정을 전환한다. 거부 = 창 인식 없는 선택기(활성 계정 고정 · 전환 0).
      const windowAware = selector === WINDOW_AWARE_ACCOUNT_SELECTOR;
      let accountSelector: AccountSelector = selector;
      if (windowAware) {
        // MembershipReader(함수)·MembershipResolver(객체) 양쪽 정규화(r12d — TS2322 수리)
        const windowGrant = authorizeRouterFeature('router.subscription_window_aware', { currentTier: typeof modules.membership === 'function' ? modules.membership : envMembershipResolver().currentTier });
        if (!windowGrant.allowed) {
          reason.push(`${input.accounts?.routerMix ? 'router-mix' : 'window-aware'}:denied:router.subscription_window_aware:${windowGrant.reason}`);
          accountSelector = ACTIVE_ACCOUNT_SELECTOR;
        } else if (input.accounts?.routerMix) {
          accountSelector = ROUTER_MIX_ACCOUNT_SELECTOR;
        }
      }
      let picked: ReturnType<AccountSelector['select']>;
      try { picked = accountSelector.select({ input, tier, cell }); } catch {
        picked = ACTIVE_ACCOUNT_SELECTOR.select({ input, tier, cell });
        reason.push(`account-selector-failed:${accountSelector.name}`);
      }
      reason.push(`account:${accountSelector.name}:${picked.reason}`);
      // OP #38337 ②: 측정 원천이 없어 «모름 = 뒤»로 정렬된 신호 칸 — 이유 줄과 구조 칸 둘 다에 남긴다.
      if (picked.unmeasured?.length) reason.push(`unmeasured:${picked.unmeasured.join('+')}`);
      const ladder = ladderOf(picked.provider);
      if (!ladder) reason.push('no-tier-ladder');
      return {
        tier, cell, provider: picked.provider, model: ladder ? ladder[cell].model : null, account: picked.account,
        trigger, reason, ...(tier === 'strong' ? { maxOutputTokens: STRONG_OUTPUT_MAX_TOKENS } : {}),
        ...(picked.unmeasured?.length ? { unmeasured: [...picked.unmeasured] } : {}),
      };
    },
    callFields: ({ provider, model }) => workTierUsageFields(provider, model),
    decisionRecord(decision, input, applied): CoreDecisionLedgerRecord {
      // 허용 칸만 — 호출측이 문면을 넘겨도 들어가지 않는다.
      return {
        kind: 'decision', runId: input.runId, moment: input.moment,
        level: input.work.level, bloom: input.work.bloom, riskCategories: [...input.work.riskCategories],
        tier: decision.tier, cell: decision.cell, provider: decision.provider, model: decision.model,
        // COST-OPTIMIZER-WINDOW-AWARE: 원장에는 원 계정 이름 대신 해시만.
        account: decision.account === null ? null : accountIdHash(decision.provider, decision.account), trigger: decision.trigger, reason: [...decision.reason],
        mode: applied.mode, applied: applied.applied, skip: applied.skip,
        launched: { provider: applied.launched.provider, model: applied.launched.model },
        accountApplied: Boolean(applied.appliedAccount),
        appliedAccount: applied.appliedAccount
          ? { kind: applied.appliedAccount.kind, account: accountIdHash(decision.provider, applied.appliedAccount.account) } : null,
        unmeasured: [...(decision.unmeasured ?? [])],
      };
    },
  };
}

let defaultCore: ModelOrchestrationCore | null = null;

/** 기본 모듈 — ADVISOR 올림 규칙(세 순간 → 강) · 계정 = 창 인지 선택기(COST-OPTIMIZER-WINDOW-AWARE · 스냅숏의
 *  `selection` 이 `on` 일 때만 계정을 바꾼다 · 그 밖은 활성 계정 그대로 + 고를 계정은 이유 칸에 해시로). */
export const DEFAULT_CORE_MODULES: CoreModules = {
  escalate: [ADVISOR_ESCALATE_RULE], accounts: WINDOW_AWARE_ACCOUNT_SELECTOR,
  // SMART-ROUTER-PLUGIN-TIERS — 등급은 신뢰 호스트 seam(env ELANOUS_ROUTER_TIER · 없으면 free, fail-closed).
  gate: createSmartRouterTierGate(envMembershipResolver()),
};

let installedModules: CoreModules = DEFAULT_CORE_MODULES;

/** ADVISOR·창 칸이 «호출부를 건드리지 않고» 끼우는 자리 — 다음 `modelOrchestrationCore()` 부터 적용. */
export function installCoreModules(modules: CoreModules): void {
  installedModules = modules;
  defaultCore = null;
}

/** 프로세스 기본 코어(내장 규칙 · ADVISOR 규칙 · 활성 계정). 모듈 칸 교체는 `installCoreModules`. */
export function modelOrchestrationCore(): ModelOrchestrationCore {
  return (defaultCore ??= createModelOrchestrationCore(installedModules));
}
