// SMART-ROUTER-PLUGIN-TIERS — 등급 게이트 시험.
// numeric 상한 출처: PRODUCT-SMART-ROUTER-TIERS-1117.md «등급» 표 «보여 주기» 행
// (무료 7일 기록 · 프로 30일 기록 · 어드밴스드 무제한) — consumer.ts ROUTER_SAVINGS_HISTORY_DAYS 와 동일 출처.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SMART_ROUTER_TABLE,
  ROUTER_SAVINGS_HISTORY_DAYS,
  authorizeRouterFeature,
  isSmartRouterTier,
  summarizeRouterTier,
  type MembershipResolver,
} from './consumer.js';

const member = (tier: string | null | undefined): MembershipResolver => ({ currentTier: () => tier });

describe('SMART-ROUTER-PLUGIN-TIERS — 등급별 기능 게이트 (표: plugins/smart-router/entitlements.json)', () => {
  test('free = 기본 강중약 자동·절감 영수·완료직전 1회 만 허용 (제품 정본 «무료» 열)', () => {
    for (const key of ['router.basic_auto_routing', 'router.savings_receipt', 'router.strong_final_check']) {
      expect(authorizeRouterFeature(key, member('free')).allowed).toBe(true);
    }
    for (const key of ['router.strong_three_moments', 'router.subscription_window_aware', 'router.policy_yaml_custom',
      'router.team_shared_pool', 'router.failure_oracle_gen', 'router.external_proxy_sdk']) {
      const grant = authorizeRouterFeature(key, member('free'));
      expect(grant.allowed).toBe(false);
      expect(grant.reason).toBe('denied');
    }
  });

  test('pro = 창 인식·정책 YAML·예산 경보·구독 조언자 월 보고 추가 (제품 정본 «프로» 열)', () => {
    for (const key of ['router.subscription_window_aware', 'router.policy_yaml_custom', 'router.budget_alerts',
      'router.subscription_advisor_monthly', 'router.strong_three_moments']) {
      expect(authorizeRouterFeature(key, member('pro')).allowed).toBe(true);
    }
    for (const key of ['router.team_shared_pool', 'router.per_project_budget', 'router.policy_inheritance',
      'router.failure_oracle_gen', 'router.neighbor_sweep', 'router.external_proxy_sdk',
      'router.unlimited_history', 'router.roi_audit_export']) {
      const grant = authorizeRouterFeature(key, member('pro'));
      expect(grant.allowed).toBe(false);
      expect(grant.reason).toBe('denied');
    }
  });

  test('advanced = 팀 공유 풀·판정기 자동 생성·외부 프록시/SDK 전부 (제품 정본 «어드밴스드» 열)', () => {
    const summary = summarizeRouterTier(member('advanced'));
    expect(summary).not.toBeNull();
    expect(summary!.deniedFeatures).toEqual([]);
    expect(summary!.grantedFeatures).toContain('router.team_shared_pool');
    expect(summary!.grantedFeatures).toContain('router.failure_oracle_gen');
    expect(summary!.grantedFeatures).toContain('router.external_proxy_sdk');
  });

  test('fail-closed — 비회원/모르는 등급/없는 기능/표 부재', () => {
    expect(authorizeRouterFeature('router.basic_auto_routing', member(null)).reason).toBe('missing-tier');
    expect(authorizeRouterFeature('router.basic_auto_routing', member('enterprise')).reason).toBe('unknown-tier');
    expect(authorizeRouterFeature('router.not_a_feature', member('free')).reason).toBe('unknown-feature');
    expect(authorizeRouterFeature('router.basic_auto_routing', member('free'), '/nonexistent/smart-router-table.json').reason).toBe('invalid-table');
    expect(summarizeRouterTier(member(null))).toBeNull();
  });

  test('기능은 단조 증가 — advanced ⊇ pro ⊇ free (등급 상승이 권한 박탈 아님 · 기대값 독립 리터럴)', () => {
    // 출처: plugins/smart-router/entitlements.json 표 원문 그대로 — 생산 summarizeRouterTier 출력이 아니라
    // 독립 리터럴 기대값(OP #130606 · REVIEW-2 T1 필수 1 · 규칙 11). free 3 · pro 8 · advanced 16.
    const FREE = [
      'router.basic_auto_routing',
      'router.savings_receipt',
      'router.strong_final_check',
    ];
    const PRO = [
      'router.basic_auto_routing',
      'router.savings_receipt',
      'router.strong_final_check',
      'router.strong_three_moments',
      'router.subscription_window_aware',
      'router.policy_yaml_custom',
      'router.budget_alerts',
      'router.subscription_advisor_monthly',
    ];
    const ADVANCED = [
      'router.basic_auto_routing',
      'router.savings_receipt',
      'router.strong_final_check',
      'router.strong_three_moments',
      'router.subscription_window_aware',
      'router.policy_yaml_custom',
      'router.budget_alerts',
      'router.subscription_advisor_monthly',
      'router.team_shared_pool',
      'router.per_project_budget',
      'router.policy_inheritance',
      'router.failure_oracle_gen',
      'router.neighbor_sweep',
      'router.external_proxy_sdk',
      'router.unlimited_history',
      'router.roi_audit_export',
    ];
    const granted = (tier: string) => summarizeRouterTier(member(tier))!.grantedFeatures;
    const sorted = (xs: readonly string[]) => [...xs].sort();
    expect(sorted(granted('free'))).toEqual(sorted(FREE));
    expect(sorted(granted('pro'))).toEqual(sorted(PRO));
    expect(sorted(granted('advanced'))).toEqual(sorted(ADVANCED));
    for (const key of FREE) expect(PRO).toContain(key);
    for (const key of PRO) expect(ADVANCED).toContain(key);
    expect(FREE.length).toBeLessThan(PRO.length);
    expect(PRO.length).toBeLessThan(ADVANCED.length);
  });

  test('절감 기록 상한 — 무료 7일 · 프로 30일 · 어드밴스드 무제한 (출처: 제품 정본 «보여 주기» 행)', () => {
    expect(ROUTER_SAVINGS_HISTORY_DAYS.free).toBe(7);      // 출처: PRODUCT-SMART-ROUTER-TIERS-1117.md «7일 기록»
    expect(ROUTER_SAVINGS_HISTORY_DAYS.pro).toBe(30);      // 출처: PRODUCT-SMART-ROUTER-TIERS-1117.md «30일 기록»
    expect(ROUTER_SAVINGS_HISTORY_DAYS.advanced).toBe(Number.POSITIVE_INFINITY); // 출처: «무제한 기록»
    expect(summarizeRouterTier(member('free'))!.savingsHistoryDays).toBe(7);
    expect(summarizeRouterTier(member('pro'))!.savingsHistoryDays).toBe(30);
  });

  test('가격 비공개 계약 — 표와 소비 코드에 단가·금액 문자열 없음 (제품 정본 «가격 공개 금지»)', () => {
    const tableText = readFileSync(DEFAULT_SMART_ROUTER_TABLE, 'utf8');
    expect(tableText).not.toMatch(/\$\s?\d/);
    expect(tableText).toContain('"pricingStatus": "undecided"');
    const consumerText = readFileSync(join(import.meta.dir, 'consumer.ts'), 'utf8');
    expect(consumerText).not.toMatch(/\$\s?\d/);
  });

  test('isSmartRouterTier — 세 등급만, 기타 값 거부', () => {
    for (const t of ['free', 'pro', 'advanced']) expect(isSmartRouterTier(t)).toBe(true);
    for (const t of [null, undefined, 'paid', 'enterprise', '']) expect(isSmartRouterTier(t as string | null | undefined)).toBe(false);
  });
});
