// SUBSCRIPTION-ADVISOR-PROACTIVE (0.3.33 · OP ROSTER-0333-60 행 13 P0) — 구독 조언자.
//
// 완료선(로스터 원문): 1주·1달 사용량·구독 창 소진 패턴으로 «어떤 구독을 추가·상향·하향·해지하면
// 월 얼마 절감» 제안 · 주 1회 요약 + 창 소진 패턴.
//
// 설계(제품 정본 PRODUCT-SMART-ROUTER-TIERS-1117.md «프로» 열 «구독 창 인식»과 같은 데이터 계열):
//   입력은 이미 구조화된 순수 데이터 — 창 스냅숏(account-window-snapshot AccountCandidate 계열:
//   remaining 0~1 · resetsAtMs)과 사용량 행(주간·월간). 네트워크 0 · 키 0 · 실측 데이터만.
//   ⛔ 합성 금지 — 스냅숏이 «모름»이면 제안에서 빼고 unknownWindowSubscriptions 으로만 센다
//   (router-savings.ts «실측 원장만» 계약과 같은 맥락).
//   ⛔ 가격 비공개 — 제안 금액은 월 구독가·절감액 «비율» 로만 표현한다(단가·금액 문자열 금지).
//
// 순수모듈(시험 주입 가능) — cadence(주 1회)는 그래프/스케줄 몫, 이 파일은 판정만.

/** 구독(공급자 계정) 하나의 창 스냅숏 — AccountCandidate 와 같은 형. */
export interface SubscriptionWindow {
  readonly provider: string;
  readonly account: string | null;
  /** 창 남은 비율 0~1. undefined = 모름(합성 금지 → 제안 제외). */
  readonly remaining?: number;
  readonly resetsAtMs?: number;
}

/** 사용량 — 주간(7일)·월간(30일) 창 소진 패턴. 시간은 epoch ms. */
export interface SubscriptionUsage {
  readonly provider: string;
  readonly account: string | null;  /** 최근 7일 창 소진(마찰 지점 수 — 창 리밋 도달 횟수). */
  /** 최근 7일 창 소진 — null = 미귀속(계정 미구분 관측)이라 미측정(terra r1 mustFix ② · PR 39662 r2). */
  readonly weeklyWindowExhaustions: number | null;
  /** 최근 30일 창 소진 횟수 — null = 미귀속(계정 미구분 관측)이라 미측정. */
  readonly monthlyWindowExhaustions: number | null;
  /** 월 구독가 — 미관측(null). 등급간 가격표는 비공개(JUD-B #125712 estRatio=null 과 같은 계약 · 제안 금액은 비율만). */
  readonly monthlyPriceUsd: number | null;
  /** 이 구독 경유 호출 수(최근 30일). */
  readonly monthlyCalls: number;
}

export type SubscriptionAction = 'add' | 'upgrade' | 'downgrade' | 'cancel' | 'keep';

export interface SubscriptionRecommendation {
  readonly provider: string;
  readonly account: string | null;
  readonly action: SubscriptionAction;
  /** 근거 — 창 소진 패턴 원문(관측된 것만 · null = 계정 미구분 관측이라 미측정). */
  readonly evidence: {
    readonly weeklyWindowExhaustions: number | null;
    readonly monthlyWindowExhaustions: number | null;
    readonly remaining: number | null;
  };
  /** 예상 월 절감 비율(0~1 · add/upgrade 는 추가 구독 대비). 실측 데이터 없으면 null. */
  readonly estMonthlySavingsRatio: number | null;
  readonly reason: string;
}

export interface SubscriptionAdvisorInput {
  readonly windows: readonly SubscriptionWindow[];
  readonly usage: readonly SubscriptionUsage[];
  /** 순수 시험 주입용 기준 시각. */
  readonly now?: () => number;
}

export interface SubscriptionAdvisorReport {
  readonly recommendations: readonly SubscriptionRecommendation[];
  /** 창 데이터가 «모름»이라 제안에서 뺀 구독 수(합성 금지 계약). */
  readonly unknownWindowSubscriptions: number;
  /** 사용량 행이 없어 제안에서 뺀 구독 수 — 0으로 합성하지 않는다(JUD-B #125712). */
  readonly missingUsageSubscriptions: number;
  /** 주 1회 요약 마크다운(창 소진 패턴 표 + 제안). */
  readonly weeklySummaryMd: string;
}

/** 창이 «거의 소진» 임계 — remaining 이 이 값 이하(출처: codex-rotation 선례 usedPercent>=95 계열). */
export const WINDOW_LOW_REMAINING = 0.05;

/** 주간 소진 2회 이상 = 추가·상향 후보(출처: 교훈 원장 «같은 오류 2회» 계열 임계와 같은 2회 계약). */
export const WEEKLY_EXHAUSTION_ADD_THRESHOLD = 2;

/** 월 0회 소진·호출 미미 = 하향·해지 후보. */
export const MONTHLY_CALLS_IDLE_THRESHOLD = 10;

export function adviseSubscriptions(input: SubscriptionAdvisorInput): SubscriptionAdvisorReport {
  const nowMs = (input.now ?? Date.now)();
  const recommendations: SubscriptionRecommendation[] = [];
  let unknown = 0;
  let missingUsage = 0;
  const usageBy = new Map<string, SubscriptionUsage>();
  for (const row of input.usage) {
    usageBy.set(`${row.provider}|${row.account ?? ''}`, row);
  }

  for (const w of input.windows) {
    // 매칭 규칙(OP #127200 · JUD-B #127194/#127195): 정확 일치(provider|account) 우선.
    // provider 계정 창이 «1개»일 때만 provider급 미귀속 총량(account=null) 폴백 — 그 총량은 그 계정 몫뿐이다.
    // 다중 계정에서는 총량을 각 창에 부착하면 이중계상·잘못된 귀속이라 폴백하지 않는다(JUD-B #126547 mustFix2 계약 유지).
    // llm-usage 원장에 계정 칸이 없어(llm.ts:8566) 실계정 창은 정확 일치로는 영영 missingUsage — 폴백 사용은 표지로 구분.
    const providerWindowCount = input.windows.filter((x) => x.provider === w.provider).length;
    const exact = usageBy.get(`${w.provider}|${w.account ?? ''}`) ?? null;
    const unattributedFallback = exact === null && w.account !== null && providerWindowCount === 1
      ? usageBy.get(`${w.provider}|`) ?? null
      : null;
    const usage = exact ?? unattributedFallback;
    const unattributed = usage !== null && usage.account === null; // provider급 총량(계정 미구분 관측) — 모든 제안에 표지
    const remaining = w.remaining !== undefined && Number.isFinite(w.remaining) ? w.remaining : null;
    if (remaining === null) {
      unknown += 1;
      continue; // ⛔ 모름 → 합성 금지
    }
    if (!usage) {
      missingUsage += 1;
      continue; // ⛔ 사용량 미관측 → 0으로 합성 금지(JUD-B #125712 — `?? 0` 오답 교정)
    }
    // 가짜 0 수리(OP #127200): 미귀속 폴백 행의 소진 수는 계정 창 소진 관측이 아니다(0이 «0회 소진»이 아니라
    // «계정별 미측정»). 정확 일치 행만 소진 수를 근거로 쓰고, 폴백 행은 null(미측정)로 정직화한다.
    const exactMatch = exact !== null;
    const weekly = exactMatch ? usage.weeklyWindowExhaustions : null;
    const monthly = exactMatch ? usage.monthlyWindowExhaustions : null;
    const calls = usage.monthlyCalls;
    const evidence = { weeklyWindowExhaustions: weekly, monthlyWindowExhaustions: monthly, remaining };
    // 월 절감 비율은 근거 있는 경우만: add/upgrade/downgrade = null(등급간 가격표 비공개 · 근거 없는 가격 비교 제거 JUD-B #125712).
    const estRatio: number | null = null;

    if (weekly !== null && weekly >= WEEKLY_EXHAUSTION_ADD_THRESHOLD && remaining <= WINDOW_LOW_REMAINING) {
      recommendations.push({
        provider: w.provider, account: w.account, action: 'add', evidence,
        estMonthlySavingsRatio: estRatio,
        reason: `주 ${weekly}회 창 소진 + 남은 창 ${(remaining * 100).toFixed(0)}% — 같은 등급 구독 추가로 창 병렬화하면 상향보다 저렴${unattributedSuffix(unattributed)}`,
      });
    } else if (monthly !== null && monthly >= WEEKLY_EXHAUSTION_ADD_THRESHOLD * 2) {
      recommendations.push({
        provider: w.provider, account: w.account, action: 'upgrade', evidence,
        estMonthlySavingsRatio: estRatio,
        reason: `월 ${monthly}회 창 소진 — 상위 등급(더 큰 창)이 추가 구독보다 저렴한 구간${unattributedSuffix(unattributed)}`,
      });
    } else if (calls <= MONTHLY_CALLS_IDLE_THRESHOLD && (monthly === 0 || monthly === null)) {
      // monthly === null = 미귀속 폴백 행 — 소진은 미측정이지만 호출 수는 실측이므로 하향 제안 가능(미측정 표지 필수).
      recommendations.push({
        provider: w.provider, account: w.account, action: 'downgrade', evidence,
        estMonthlySavingsRatio: estRatio,
        reason: monthly === null
          ? `월 ${calls}호출·창 소진 미측정(계정 미구분 관측) — 하위 등급 후보, 소진 수는 계정 귀속 후 재판정(«해지»는 30일 호출 0일 때만)${unattributedSuffix(unattributed)}`
          : `월 ${calls}호출·창 소진 0 — 하위 등급으로 월 구독가 비율 절감(«해지»는 30일 호출 0일 때만)${unattributedSuffix(unattributed)}`,
      });
    }
  }
  // 해지 후보: 사용량 목록에 있으나 창 스냅숏에 없는(비활성) 구독 중 월 호출 0.
  for (const u of input.usage) {
    const hasWindow = input.windows.some(w => w.provider === u.provider && w.account === u.account);
    if (!hasWindow && u.monthlyCalls === 0) {
      recommendations.push({
        provider: u.provider, account: u.account, action: 'cancel', evidence: {
          weeklyWindowExhaustions: u.weeklyWindowExhaustions, monthlyWindowExhaustions: u.monthlyWindowExhaustions, remaining: null,
        },
        estMonthlySavingsRatio: 1,
        reason: '30일 호출 0 + 창 스냅숏 부재 — 구독 해지가 월 구독가 전액 절감',
      });
    }
  }

  const lines: string[] = [
    '# 구독 조언자 — 주간 요약 (SUBSCRIPTION-ADVISOR-PROACTIVE)',
    '',
    `- 기준 시각: ${new Date(nowMs).toISOString()}`,
    `- 창 소진 패턴 대상 구독: ${input.windows.length} · 제안 ${recommendations.length}건 · 창 미측정(제안 제외) ${unknown}건 · 사용량 미관측(제안 제외) ${missingUsage}건`,
    '',
    '| 구독 | 제안 | 주 소진 | 월 소진 | 남은 창 | 근거 |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of recommendations) {
    lines.push(`| ${r.provider}${r.account ? `:${r.account}` : ''} | ${actionLabel(r.action)} | ${r.evidence.weeklyWindowExhaustions ?? '—'} | ${r.evidence.monthlyWindowExhaustions ?? '—'} | ${r.evidence.remaining === null ? '—' : `${(r.evidence.remaining * 100).toFixed(0)}%`} | ${r.reason} |`);
  }
  if (recommendations.length === 0) lines.push('| — | 유지 | — | — | — | 제안 없음(모든 구독이 패턴 임계 미충족) |');
  lines.push('', '⛔ 금액·단가 비공개 — 절감은 비율로만 표기 · 창 미측정 구독은 합성 없이 제외.');
  return { recommendations, unknownWindowSubscriptions: unknown, missingUsageSubscriptions: missingUsage, weeklySummaryMd: lines.join('\n') + '\n' };
}

function actionLabel(action: SubscriptionAction): string {
  switch (action) {
    case 'add': return '추가';
    case 'upgrade': return '상향';
    case 'downgrade': return '하향';
    case 'cancel': return '해지';
    default: return '유지';
  }
}

/** 계정 미구분 관측(provider급 총량)에 근거한 제안임을 모든 action 에 표지(JUD-B #126547 — downgrade 도 예외 없음). */
function unattributedSuffix(unattributed: boolean): string {
  return unattributed ? ' · 사용량은 계정 미구분 관측(llm-usage 원장에 계정 칸 없음)' : '';
}
