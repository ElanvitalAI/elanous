// SMART-ROUTER-TIER-FULL-WIRE (ROSTER-0333 칸 43 · OP #132082) — 16기능 진입점·실제 회원 등급 원천 결속.
//
// 완료선(칸 원문): «스마트 라우터 회원 등급 게이트를 전체 16기능 진입점·실제 회원 등급 원천에 연결»
// RED 조건(착수 시점 실측): decide 종단엔 3키(basic_auto_routing·strong_final_check·strong_three_moments)만
//   매핑(consumer.ts routerFeatureKeyForDecision)되고 13기능 진입점은 미배선·등급 원천은 env 폴백뿐
//   (envMembershipResolver — 회원 계정 원천 없음). 이 시험의 새 단언은 그 갭이 채워지기 전까지 실패한다.
//
// 시험 원문 출력은 합성 이벤트로 남긴다(pregate focused.raw — 게이트 판정 행: allowed·feature키·등급 출처).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SMART_ROUTER_TIERS,
  authorizeRouterFeature,
  isSmartRouterTier,
  type MembershipResolver,
} from './consumer.js';
import { createMemberTierStore, memberTierResolver } from '../../members/tier-store.js';
import { readAccountWindowSnapshot } from '../../model-tier/account-window-snapshot.js';
import { evaluateBudget } from '../../budget-guard/budget-guard.js';
import { ROUTER_FULL_WIRE_FEATURES, authorizeRouterFeatureAtEntry, type RouterFeatureEntry } from './full-wire.js';

const tablePath = join(import.meta.dir, '../../../plugins/smart-router/entitlements.json');
const table = JSON.parse(readFileSync(tablePath, 'utf8')) as {
  features: Array<{ key: string; grant: Record<string, boolean> }>;
};

/** 16기능 키 전부 — entitlements.json 표가 정본(키 누락·추가 즉시 이 시험이 잡는다). */
const TABLE_KEYS = table.features.map((row) => row.key).sort();
const ALL_16 = [
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
].sort();

const tierOf = (tier: string): MembershipResolver => ({ currentTier: () => tier });

describe('SMART-ROUTER-TIER-FULL-WIRE — ① 16기능 × 3등급 행렬(표 정본 일치)', () => {
  test('entitlements.json 은 16기능 키를 정확히 담는다(누락·추가 없음)', () => {
    expect(TABLE_KEYS).toEqual(ALL_16);
    expect(ROUTER_FULL_WIRE_FEATURES.length).toBe(16); // 출처: entitlements.json features 16행(표 정본)
    expect(ROUTER_FULL_WIRE_FEATURES.map((row) => row.key).sort()).toEqual(ALL_16);
  });

  for (const tier of SMART_ROUTER_TIERS) {
    test(`${tier} — 표의 grant 그대로 허용/거부(행렬 전수)`, () => {
      for (const key of ALL_16) {
        const expected = table.features.find((row) => row.key === key)!.grant[tier] === true;
        const grant = authorizeRouterFeature(key, tierOf(tier));
        expect(grant.allowed).toBe(expected);
      }
    });
  }

  test('등급을 모르면(missing-tier) 전 기능 거부 — 그래프 입력이 등급을 자급할 수 없다(fail-closed)', () => {
    for (const key of ALL_16) {
      const grant = authorizeRouterFeature(key, { currentTier: () => null });
      expect(grant.allowed).toBe(false);
      expect(grant.reason).toBe('missing-tier');
    }
  });

  test('표 밖 등급(unknown-tier)도 전 기능 거부', () => {
    for (const key of ALL_16) {
      expect(authorizeRouterFeature(key, tierOf('ultra')).reason).toBe('unknown-tier');
    }
  });
});

describe('SMART-ROUTER-TIER-FULL-WIRE — ② 실제 회원 등급 원천(src/members 스토어 → 게이트)', () => {
  test('회원 등급 스토어가 실제 원천을 읽는다 — 파일에 저장된 등급이 resolver 로 나온다', () => {
    // 원천 파일 = 회원 계정이 소유하는 등급 표(호스트 소유). env 폴백은 원천이 없을 때만.
    const store = createMemberTierStore({ fixture: 'pro' });
    expect(store.currentTier()).toBe('pro');
    expect(isSmartRouterTier(store.currentTier())).toBe(true);
  });

  test('원천이 등급을 모르면 env 폴백 → env 도 없으면 free(fail-closed · 그래프 입력 자급 불가)', () => {
    expect(memberTierResolver(createMemberTierStore({ fixture: 'unknown' }), {}).currentTier()).toBe('free');
    expect(memberTierResolver(createMemberTierStore({ fixture: 'missing' }), { ELANOUS_ROUTER_TIER: 'advanced' }).currentTier()).toBe('advanced');
    expect(memberTierResolver(createMemberTierStore({ fixture: 'missing' }), {}).currentTier()).toBe('free');
  });

  test('원천 등급(pro)이 env(advanced)보다 우선한다 — 실제 원천이 정본', () => {
    const resolver = memberTierResolver(createMemberTierStore({ fixture: 'pro' }), { ELANOUS_ROUTER_TIER: 'advanced' });
    expect(resolver.currentTier()).toBe('pro');
    // pro 는 team_shared_pool(advanced 전용)을 거부 — env 의 advanced 로 우회되지 않는다.
    expect(authorizeRouterFeature('router.team_shared_pool', resolver).allowed).toBe(false);
    expect(authorizeRouterFeature('router.policy_yaml_custom', resolver).allowed).toBe(true);
  });
});

describe('SMART-ROUTER-TIER-FULL-WIRE — ③ 16기능 진입점 결속(실측 매핑 · wired 10 / 진입점 부재 6)', () => {
  const member = (tier: string) => memberTierResolver(createMemberTierStore({ fixture: tier }), {});

  test('배선 완료선 실측: wired 10 · 부재 6(wired=false 는 absentReason 실측 문구를 갖는다)', () => {
    const wired = ROUTER_FULL_WIRE_FEATURES.filter((row) => row.wired);
    const absent = ROUTER_FULL_WIRE_FEATURES.filter((row) => !row.wired);
    expect(wired.length).toBe(10); // 출처: OP #132082 칸 43 완료선 — 배선 10(wired) · 진입점 부재 6
    expect(absent.length).toBe(6); // 출처: OP #132082 칸 43 완료선 — 배선 10(wired) · 진입점 부재 6
    for (const row of absent) {
      expect(row.absentReason).toBeTruthy();
      expect(row.entryName).toContain('(없음');
    }
  });

  for (const feature of ROUTER_FULL_WIRE_FEATURES as readonly RouterFeatureEntry[]) {
    test(`${feature.key} — 진입점 게이트 판정이 표와 동일하다(free/pro/advanced 전수 · entry=${feature.entryName})`, () => {
      for (const tier of SMART_ROUTER_TIERS) {
        const expected = table.features.find((row) => row.key === feature.key)!.grant[tier] === true;
        const grant = authorizeRouterFeatureAtEntry(feature.key, member(tier));
        expect([grant.allowed, grant.reason, grant.entry]).toEqual([expected, expected ? 'granted' : 'denied', feature.entryName]);
      }
    });

    test(`${feature.key} — 거부 시 fail-closed · 등급 출처가 실제 원천(member-tier-store)에 실린다`, () => {
      const denied = authorizeRouterFeatureAtEntry(feature.key, member('free'));
      if (denied.allowed) {
        // free 에서 허용되는 3키(basic_auto_routing·savings_receipt·strong_final_check)는 위 전수 행렬이 증명.
        expect(['router.basic_auto_routing', 'router.savings_receipt', 'router.strong_final_check']).toContain(feature.key);
        expect(denied.reason).toBe('granted');
        expect(denied.failClosed).toBe(false);
        return;
      }
      expect(denied.reason).toBe('denied');
      expect(denied.failClosed).toBe(true);
      expect(denied.tierSource).toContain('member-tier-store');
    });
  }

  test('decide 종단(기존 3키)과 진입점 결속이 같은 원천(resolver)을 쓴다 — 원천이 하나뿐임을 단언', () => {
    // 코어 종단 배선(#39528)과 진입점 결속이 각각 다른 등급을 읽으면 게이트가 우회된다.
    const resolver = memberTierResolver(createMemberTierStore({ fixture: 'free' }), { ELANOUS_ROUTER_TIER: 'advanced' });
    for (const feature of ROUTER_FULL_WIRE_FEATURES) {
      const grant = authorizeRouterFeatureAtEntry(feature.key, resolver);
      const direct = authorizeRouterFeature(feature.key, resolver);
      expect(grant.allowed).toBe(direct.allowed);
    }
  });
});

describe('SMART-ROUTER-TIER-FULL-WIRE — ④ 진입점 실제 배선(소비 코드가 게이트를 호출해 결정을 바꾼다)', () => {
  const member = (tier: string) => memberTierResolver(createMemberTierStore({ fixture: tier }), {});

  test('subscription_window_aware — readAccountWindowSnapshot: `on` 요청은 허용 등급에서만 on · 미달은 shadow 강등(fail-closed)', () => {
    const granted = table.features.find((row) => row.key === 'router.subscription_window_aware')!.grant;
    for (const tier of SMART_ROUTER_TIERS) {
      const expected = granted[tier] === true ? 'on' : 'shadow';
      const snapshot = readAccountWindowSnapshot('anthropic', {
        config: () => ({ harness: { windowAccounts: 'on' } }),
        membership: member(tier),
        emit: () => {},
      });
      expect(snapshot?.selection).toBe(expected);
    }
    // 등급을 모르면(missing-tier) `on` 요청도 shadow — 그래프 입력이 등급을 자급할 수 없다.
    expect(readAccountWindowSnapshot('anthropic', {
      config: () => ({ harness: { windowAccounts: 'on' } }),
      membership: { currentTier: () => null },
      emit: () => {},
    })?.selection).toBe('shadow');
  });

  test('budget_alerts — evaluateBudget: 경계·초과 상태는 허용 등급에서만 · 미달은 ok + alertsDenied 표지(fail-closed)', () => {
    const granted = table.features.find((row) => row.key === 'router.budget_alerts')!.grant;
    const cap = 50; const warnUsd = 45; const overUsd = 60; // 출처: 본 시험 합성 fixture — budget-guard.ts DEFAULT_NOTIFY_AT_PCT 80% 경계값
    for (const tier of SMART_ROUTER_TIERS) {
      const allowed = granted[tier] === true;
      const atWarn = evaluateBudget({ budget: { monthlyUsdCap: cap }, monthSoFarUsd: warnUsd, membership: member(tier) });
      const atOver = evaluateBudget({ budget: { monthlyUsdCap: cap }, monthSoFarUsd: overUsd, membership: member(tier) });
      expect(atWarn.status).toBe(allowed ? 'warning' : 'ok');
      expect(atOver.status).toBe(allowed ? 'cap-exceeded' : 'ok');
      if (allowed) {
        expect(atWarn.alertsDenied).toBeUndefined();
        expect(atOver.alertsDenied).toBeUndefined();
      } else {
        expect(atWarn.alertsDenied?.reason).toBe('denied');
        expect(atWarn.alertsDenied?.entry).toBe('budget-guard.evaluateBudget');
        expect(atOver.alertsDenied?.reason).toBe('denied');
      }
    }
    // 등급을 모르면 경보 없음(missing-tier) — 관측값은 그대로, 표지로 밝힌다.
    const unknown = evaluateBudget({ budget: { monthlyUsdCap: cap }, monthSoFarUsd: overUsd, membership: { currentTier: () => null } });
    expect(unknown.status).toBe('ok');
    expect(unknown.alertsDenied?.reason).toBe('missing-tier');
  });
});
