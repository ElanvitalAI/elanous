// M3-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 3) —
// Budget-guarded auto-fallback evaluator (pillar 4 · §3.4).
//
// Pure function over `(BudgetUserConfig, monthSoFarUsd)` returning the
// three-state evaluation the PWA modal + daemon endpoint share:
//
//   ok          monthSoFar < cap × (notifyAtPct / 100)
//   warning     cap × (notifyAtPct / 100) ≤ monthSoFar < cap
//   cap-exceeded                            monthSoFar ≥ cap
//
// Decision M4 — undefined `monthlyUsdCap` means "passive · cost dashboard
// only · no fallback"; the evaluator returns `ok` regardless of spend.
// Decision M7 — default fallback tier is `budget` when the user accepts
// the modal recommendation but didn't pin a specific `fallbackTier`.
//
// Reference: PLAN §3.4 (Budget-guarded auto-fallback) + §4.4 (modal
// shape · 3-option radio).

import type { BudgetUserConfig, ModelTier } from '../model-tier/types.js';
// SMART-ROUTER-TIER-FULL-WIRE(칸 43) — 등급 게이트 원천(실제 원천 스토어 → env → free fail-closed).
import type { MembershipResolver } from '../plugins/smart-router/consumer.js';
import { authorizeRouterFeatureAtEntry } from '../plugins/smart-router/full-wire.js';
import { createMemberTierStore, memberTierResolver } from '../members/tier-store.js';

export type BudgetStatus = 'ok' | 'warning' | 'cap-exceeded';

export interface BudgetEvaluation {
  status: BudgetStatus;
  /** monthSoFarUsd ÷ cap × 100. `null` when no cap is set (no
   *  meaningful percentage exists). Capped at 999 to keep UI strings
   *  short on runaway months. */
  percent: number | null;
  /** Monthly USD cap echoed back so the PWA modal can render
   *  "$40/$50" without re-reading the same config. `undefined` when no
   *  cap is configured. */
  monthlyUsdCap?: number;
  /** Tier the modal should pre-select on the "Switch to fallback"
   *  radio. Always populated for `warning` / `cap-exceeded` so the
   *  modal has something to apply on a 1-click confirm. */
  recommendedFallback?: ModelTier;
  /** notifyAtPct echoed back for "(80%)" subtext in the modal header. */
  notifyAtPct: number;
  /** SMART-ROUTER-TIER-FULL-WIRE(칸 43) — router.budget_alerts 미달 등급이어서 경보 상태를 내지 않을 때의 표지.
   *  관측값(percent·monthlyUsdCap)은 그대로 실린다 — «기능 미달»을 숨기지 않는다. */
  readonly alertsDenied?: {
    readonly feature: 'router.budget_alerts';
    readonly reason: string;
    readonly entry: string;
    readonly tierSource: string;
  };
}

/** Default tier for `recommendedFallback` when the user hasn't pinned
 *  one — decision M7. */
export const DEFAULT_FALLBACK_TIER: ModelTier = 'budget';

/** Default notify threshold — 80% of cap. The modal fires once we cross
 *  this; before that the `getMonthSummary` pill in the status bar is
 *  the only signal. */
export const DEFAULT_NOTIFY_AT_PCT = 80;

export interface EvaluateBudgetOpts {
  budget: BudgetUserConfig | undefined;
  monthSoFarUsd: number;
  /** SMART-ROUTER-TIER-FULL-WIRE(칸 43) — 등급 원천 주입(시험). 없으면 실제 원천 스토어 → env 폴백 → free. */
  readonly membership?: MembershipResolver;
}

export function evaluateBudget(opts: EvaluateBudgetOpts): BudgetEvaluation {
  const budget = opts.budget ?? {};
  const cap = budget.monthlyUsdCap;
  const notifyAtPct = clampPct(budget.notifyAtPct ?? DEFAULT_NOTIFY_AT_PCT);
  const fallback = budget.fallbackTier ?? DEFAULT_FALLBACK_TIER;
  const monthSoFar = Math.max(0, opts.monthSoFarUsd);

  // No cap configured → passive mode (decision M4).
  if (cap === undefined || cap <= 0) {
    return {
      status: 'ok',
      percent: null,
      notifyAtPct,
    };
  }

  const rawPercent = (monthSoFar / cap) * 100;
  const percent = Math.min(999, Math.round(rawPercent * 10) / 10);
  // SMART-ROUTER-TIER-FULL-WIRE(칸 43) — budget_alerts 진입 게이트: 등급 원천(member-tier-store → env → free
  // fail-closed)이 router.budget_alerts 를 거부하면 경보·추천 강하를 내지 않는다(status ok — fail-closed).
  // 관측값(percent·monthlyUsdCap)은 그대로 실고 alertsDenied 표지로 기능 미달을 밝힌다(숫자를 지어내지 않는다).
  const grant = authorizeRouterFeatureAtEntry('router.budget_alerts', opts.membership ?? memberTierResolver(createMemberTierStore()));
  if (!grant.allowed) {
    return {
      status: 'ok',
      percent,
      monthlyUsdCap: cap,
      notifyAtPct,
      alertsDenied: { feature: 'router.budget_alerts', reason: grant.reason, entry: grant.entry, tierSource: grant.tierSource },
    };
  }
  const warnAt = cap * (notifyAtPct / 100);

  if (monthSoFar >= cap) {
    return {
      status: 'cap-exceeded',
      percent,
      monthlyUsdCap: cap,
      recommendedFallback: fallback,
      notifyAtPct,
    };
  }
  if (monthSoFar >= warnAt) {
    return {
      status: 'warning',
      percent,
      monthlyUsdCap: cap,
      recommendedFallback: fallback,
      notifyAtPct,
    };
  }
  return {
    status: 'ok',
    percent,
    monthlyUsdCap: cap,
    notifyAtPct,
  };
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_NOTIFY_AT_PCT;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}
