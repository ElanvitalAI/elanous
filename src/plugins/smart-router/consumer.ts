// SMART-ROUTER-PLUGIN-TIERS (0.3.33 · OP ROSTER-0333-60 행 12 P0) — 스마트 라우터 플러그인 등급 게이트.
//
// 제품 정본: seat-state/OP/PRODUCT-SMART-ROUTER-TIERS-1117.md (대표 11-17 «스마트 라우터는 플러그인으로
// 제품으로 판다 · 무료/프로/어드밴스드»). 이 모듈의 경계(그 문서 «제품 칸» 절):
//   플러그인 꾸러미 + 등급 권한(무료/프로/어드밴스드) 게이트 · 회원 계정의 등급 읽기 · 기능 플래그.
// 실제 데이터(어느 등급이 무엇을 쓰는가)는 plugins/smart-router/entitlements.json — 코드가 아닌 데이터가
// 정본이고, 여기는 그 표를 읽어 판정만 내린다(gcp-architect-expand consumer 선례와 같은 구조).
//
// ⛔ 가격 비공개(제품 정본 머리 «가격 공개 금지») — 표·코드 어디에도 단가·금액이 실리지 않는다.
//    pricingStatus:'undecided' 표시 외 가격 문자열 금지(시험 consumer.test.ts «가격 비공개 계약» 단언).
// ⛔ 멤버십 신원은 신뢰 호스트 seam(MembershipResolver)으로만 공급 — 그래프 입력이 스스로 등급을
//    만들 수 없다(checkPluginFeature 계약, feature-entitlements.ts 머리 주석).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPluginFeature, type FeatureGrant } from '../core/feature-entitlements.js';

/** Host-owned membership resolver. Graph input cannot grant itself a tier. */
export interface MembershipResolver { currentTier(): string | null | undefined }

export const SMART_ROUTER_TIERS = ['free', 'pro', 'advanced'] as const;
export type SmartRouterTier = (typeof SMART_ROUTER_TIERS)[number];

export function isSmartRouterTier(value: string | null | undefined): value is SmartRouterTier {
  return value === 'free' || value === 'pro' || value === 'advanced';
}

/**
 * 절감 기록 보존 상한(일).
 * 출처: PRODUCT-SMART-ROUTER-TIERS-1117.md «등급» 표 «보여 주기» 행 —
 * 무료 «7일 기록» · 프로 «30일 기록» · 어드밴스드 «무제한 기록».
 */
export const ROUTER_SAVINGS_HISTORY_DAYS: Readonly<Record<SmartRouterTier, number>> = {
  free: 7,
  pro: 30,
  advanced: Number.POSITIVE_INFINITY,
};

export const DEFAULT_SMART_ROUTER_TABLE = join(import.meta.dir, '../../../plugins/smart-router/entitlements.json');

/** 단일 기능 판정 — 표를 못 읽으면 invalid-table 로 거부(fail-closed). */
export function authorizeRouterFeature(feature: string, member: MembershipResolver, tablePath = DEFAULT_SMART_ROUTER_TABLE): FeatureGrant {
  try {
    return checkPluginFeature(JSON.parse(readFileSync(tablePath, 'utf8')), feature, member.currentTier());
  } catch {
    return { allowed: false, reason: 'invalid-table' };
  }
}

export interface RouterTierSummary {
  readonly tier: SmartRouterTier;
  /** 허용된 기능 키(정렬) — 기능 플래그 목록. */
  readonly grantedFeatures: readonly string[];
  readonly deniedFeatures: readonly string[];
  /** 등급별 상한(일). ROUTER_SAVINGS_HISTORY_DAYS 값. */
  readonly savingsHistoryDays: number;
}

/** 등급 한 줄 요약 — 기능 플래그 세트 + 기록 상한. 등급을 못 읽으면 null(비회원 = 가입 동선). */
export function summarizeRouterTier(member: MembershipResolver, tablePath = DEFAULT_SMART_ROUTER_TABLE): RouterTierSummary | null {
  const tier = member.currentTier();
  if (!isSmartRouterTier(tier)) return null;
  let table: unknown;
  try {
    table = JSON.parse(readFileSync(tablePath, 'utf8'));
  } catch {
    return null;
  }
  const features = (table as { features?: Array<{ key: string; grant: Record<string, boolean> }> }).features ?? [];
  const grantedFeatures: string[] = [];
  const deniedFeatures: string[] = [];
  for (const row of features) {
    if (row.grant[tier] === true) grantedFeatures.push(row.key);
    else deniedFeatures.push(row.key);
  }
  grantedFeatures.sort();
  deniedFeatures.sort();
  return { tier, grantedFeatures, deniedFeatures, savingsHistoryDays: ROUTER_SAVINGS_HISTORY_DAYS[tier] };
}

// ── 코어 칸 배선(한 몸 원칙 — orchestration-core CoreModules.gate · JUD-B #125712) ────────
// authorizeRouterFeature 가 «정의만 있고 실제 라우팅 결정을 못 바꾼다» 는 HOLD — 이 게이트를
// ModelOrchestrationCore.decide 의 올림 뒤에 끼워 회원 등급 허용/거부가 실제 tier 에 반영된다.

/** 회원 등급의 호스트 공급원 — env ELANOUS_ROUTER_TIER, 없으면 free(fail-closed · 그래프 입력이 등급을 만들 수 없다). */
export function envMembershipResolver(env: NodeJS.ProcessEnv = process.env): MembershipResolver {
  return { currentTier: () => env.ELANOUS_ROUTER_TIER ?? 'free' };
}

/** 결정 → 기능 키: base/섞기정책 올림 = 기본 자동 라우팅(무료 허용) · ADVISOR 완료직전 = 1회 판정(무료 허용) · 그 외 ADVISOR = 세 순간(프로+). 출처: entitlements.json 각 행 grant. */
export function routerFeatureKeyForDecision(trigger: string, checkpoint?: string): string {
  if (trigger.startsWith('advisor:')) {
    return checkpoint === 'pre-complete' ? 'router.strong_final_check' : 'router.strong_three_moments';
  }
  return 'router.basic_auto_routing';
}

/** 등급 게이트 칸(orchestration-core TierGateModule 에 구조로 맞는다) — deny 면 «올림»을 되돌린다(호출 차단 아님 · 기본 라우팅은 무료에도 허용). */
export function createSmartRouterTierGate(member: MembershipResolver, tablePath = DEFAULT_SMART_ROUTER_TABLE) {
  return {
    name: 'smart-router-tiers',
    review(context: { readonly trigger: string; readonly checkpoint?: string; readonly tier: string }): { readonly allowed: boolean; readonly reason: string | null } {
      const key = routerFeatureKeyForDecision(context.trigger, context.checkpoint);
      const grant = authorizeRouterFeature(key, member, tablePath);
      if (grant.allowed || context.tier !== 'strong') return { allowed: true, reason: null };
      return { allowed: false, reason: `${key}:${grant.reason}` };
    },
  };
}
