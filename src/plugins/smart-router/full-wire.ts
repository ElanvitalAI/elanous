// SMART-ROUTER-TIER-FULL-WIRE (ROSTER-0333 칸 43 · OP #132082) — 16기능 진입점 매핑·게이트 배선 API.
//
// 완료선: «스마트 라우터 회원 등급 게이트를 전체 16기능 진입점·실제 회원 등급 원천에 연결».
// 이 모듈의 역할(세 가지):
//   ① 16기능 각각의 **실제 진입점 실측 명부**(ROUTER_FULL_WIRE_FEATURES — 2026-11-23 06:48~06:50 전역 스캔).
//   ② 진입점 게이트 판정 API(authorizeRouterFeatureAtEntry) — 진입 모듈이 호출해 실제 결정을 바꾼다.
//      «정의만 있고 결정을 못 바꾼다» HOLD(jud-39528 8929e280 계열) 재현 방지: wired=true 인 진입점은
//      소비 코드가 이 API 를 호출하고 거부 시 fail-closed 로 동작을 차단한다.
//   ③ 진입점 부재 기능(absentReason)의 정직한 명세 — 기능 구현 칸에서 이 명부의 게이트를 결속할 때까지
//      entitlements.json 표(deny-unlisted-and-unresolved)가 기본 거부를 유지한다.
//
// 등급 원천: src/members/tier-store.ts(실제 회원 등급 원천 스토어 — 원본 우선·env 폴백·free fail-closed).

import { authorizeRouterFeature, type MembershipResolver } from './consumer.js';

/** 16기능 진입점 실측 행. entryName 은 스캔 실측(추측 금지 · 원본은 칸 PR 본문 «약속 체크리스트»). */
export interface RouterFeatureEntry {
  readonly key: string;
  /** 실제 진입점(모듈·함수). 부재 기능은 부재 위치의 실측 설명. */
  readonly entryName: string;
  /** 진입점에 게이트가 실제 결속돼 있는가. false = 기능 실체 없음(구현 칸에서 결속). */
  readonly wired: boolean;
  /** wired=false 사유 — 실측 근거. */
  readonly absentReason?: string;
}

/** 16기능 진입점 매핑 — entitlements.json 16키와 1:1. */
export const ROUTER_FULL_WIRE_FEATURES: readonly RouterFeatureEntry[] = [
  { key: 'router.basic_auto_routing', entryName: 'model-orchestration.decide(base)', wired: true },
  { key: 'router.savings_receipt', entryName: 'cli.llm-savings.runLlmSavings', wired: true },
  { key: 'router.strong_final_check', entryName: 'model-orchestration.decide(advisor:pre-complete)', wired: true },
  { key: 'router.strong_three_moments', entryName: 'model-orchestration.decide(advisor:plan)', wired: true },
  { key: 'router.subscription_window_aware', entryName: 'model-tier.account-window-snapshot.readAccountWindowSnapshot', wired: true },
  {
    key: 'router.policy_yaml_custom', entryName: '(없음 — 라우터 정책 YAML 로더 부재)', wired: false,
    absentReason: 'policy[-_]?yaml/policyYaml/loadPolicyYaml 전역 탐색 → entitlements 키 문자열만 · src/plugins/core/plugin-yaml.ts는 플러그인 매니페스트로 별개',
  },
  { key: 'router.budget_alerts', entryName: 'budget-guard.evaluateBudget', wired: true },
  { key: 'router.subscription_advisor_monthly', entryName: 'cli.usage.advisor(usage-cli.ts:689)', wired: true },
  {
    key: 'router.team_shared_pool', entryName: '(없음 — 다�호스트 합산 풀 부재)', wired: false,
    absentReason: 'team_shared_pool|team-shared|sharedPool 전역 탐색 → 키 문자열만 · budget/history-store.ts는 사용자 전역 예산 이력(«Deliberately global»)',
  },
  {
    key: 'router.per_project_budget', entryName: '(없음 — 프로젝트별 예산 축 부재)', wired: false,
    absentReason: 'per-project 일치는 전부 문서/포트 오버라이드 · 예산 축은 사용자 전역 하나뿐',
  },
  {
    key: 'router.policy_inheritance', entryName: '(없음 — 상속 대상 정책 구조 자체 부재)', wired: false,
    absentReason: '상속받을 라우터 정책 구조(policy_yaml_custom 부재)가 없음',
  },
  { key: 'router.failure_oracle_gen', entryName: 'harness.failure-oracle → self-implement.seams', wired: true },
  { key: 'router.neighbor_sweep', entryName: 'harness.neighbor-sweep → harness-seams', wired: true },
  {
    key: 'router.external_proxy_sdk', entryName: '(없음 — 외부 에이전트를 라우터로 통과시키는 프록시/SDK 부재)', wired: false,
    absentReason: 'acp/aside 접면은 있으나 «라우터 프록시» 명명 실체 없음 · ACP 턴의 코어 경유 여부 미실측',
  },
  { key: 'router.unlimited_history', entryName: 'cli.llm-savings.ledger-window(ROUTER_SAVINGS_HISTORY_DAYS 집행)', wired: true },
  {
    key: 'router.roi_audit_export', entryName: '(없음 — 전용 ROI 감사 내보내기 부재)', wired: false,
    absentReason: 'ROI 계산(savingsPct)은 model-tier/router-savings.ts 안에 있으나 전용 감사 보고·내보내기 기능은 없음',
  },
];

/** 진입점 게이트 판정 — 진입 모듈이 호출한다. */
export interface RouterFeatureEntryGrant {
  readonly allowed: boolean;
  readonly reason: 'granted' | 'missing-tier' | 'unknown-tier' | 'unknown-feature' | 'invalid-table' | 'denied';
  /** 판정이 일어난(일어났어야 할) 진입점 이름. */
  readonly entry: string;
  /** 거부 시 진입점 fail-closed(기능 동작 차단). 허용 시 무의미(false). */
  readonly failClosed: boolean;
  /** 등급 출처 — 실제 원천 스토어(member-tier-store) 기반 resolver 여부 표기. */
  readonly tierSource: string;
}

/**
 * 진입점 게이트 — 소비 모듈의 실제 결정 흐름 안에서 호출된다(wired 진입점 전부).
 * 등급 원천은 memberTierResolver(src/members/tier-store)로 정규화한 resolver 를 전달한다.
 * tierSource 는 그 resolver 의 원천을 표기한다(시험 ③ 단언 — 원천이 하나뿐임).
 */
export function authorizeRouterFeatureAtEntry(
  feature: string,
  member: MembershipResolver & { tierSource?: string },
  tablePath?: string,
): RouterFeatureEntryGrant {
  const grant = tablePath
    ? authorizeRouterFeature(feature, member, tablePath)
    : authorizeRouterFeature(feature, member);
  return {
    allowed: grant.allowed,
    reason: grant.reason,
    entry: ROUTER_FULL_WIRE_FEATURES.find((row) => row.key === feature)?.entryName ?? '(unmapped-feature)',
    failClosed: !grant.allowed,
    tierSource: member.tierSource ?? 'member-tier-store',
  };
}

/** 진입점이 실제로 결속돼 있는(wired) 기능 키 — 이 칸의 배선 완료선 실측. */
export const WIRED_FEATURE_KEYS: readonly string[] = ROUTER_FULL_WIRE_FEATURES.filter((row) => row.wired).map((row) => row.key);
