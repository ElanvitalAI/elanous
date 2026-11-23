// SUBSCRIPTION-ADVISOR-PROACTIVE r6(JUD-B #126283 / OP #126295) — 조언자를 실제 원장에 연결하는 어댑터.
//
// 원천(이미 구조화돼 «디스크에» 있는 것만 · 네트워크 0):
//   · llm-usage 원장 행(LogStore query 심) — billingProvider × billing=subscription 호출 수를
//     주간(7일)·월간(30일) 창으로 센다. 계정 칸이 없는 행은 account=null(지어 넣지 않는다).
//   · harness.window-account refused(reason=all-exhausted) 이벤트 — 관측된 «풀 전체 선택 거절» 순간(provider 구분).
//     ⛔ 이것은 계정 창 소진 수가 아니다 — pickWindowAccount 는 eligible 창 부재때도 같은 reason 을 내고
//     거절마다 로그가 쌓인다(JUD-B #126547). 관측한 의미 그대로 «선택 거절 수»로만 세고 계정 usage 에 붙이지 않는다.
//   · readAccountWindowSnapshot(forceShadow) — 창 remaining 스냅숏(core-advisor-wiring 과 같은 제공자).
//
// ⛔ 가격 미관측 — monthlyPriceUsd 는 null(등급간 가격표 비공개 · JUD-B #125712 estRatio=null 과 같은 계약).

import { readAccountWindowSnapshot } from './account-window-snapshot.js';
import type { LogQuery, LogStoreRow } from '../mss/logging/log-store.js';
import type { SubscriptionUsage, SubscriptionWindow } from './subscription-advisor.js';

export interface SubscriptionAdvisorLedgerDeps {
  /** llm-usage 원장 읽기 심(usage-cli 의 readRunLogs 와 같은 형태). */
  readonly readRunLogs: (query: LogQuery) => LogStoreRow[];
  /** 창 스냅숏 심(제품 제공자 그대로 · 시험은 스텁). */
  readonly readSnapshot?: typeof readAccountWindowSnapshot;
  readonly now?: () => number;
  /** 집계 대상 provider(기본 openai-codex — 현재 창 데이터가 있는 유일한 provider). */
  readonly provider?: string;
}

export interface SubscriptionAdvisorLedgerInput {
  readonly windows: readonly SubscriptionWindow[];
  readonly usage: readonly SubscriptionUsage[];
  /** 집계에 쓴 원장 관측치(영수용 — «얼마나 읽었나»의 정직한 수). */
  readonly observed: {
    readonly weeklyCalls: number;
    readonly monthlyCalls: number;
    /** 관측된 «provider 전체 선택 거절(all-exhausted)» 수 — 계정 창 소진 수가 아님(JUD-B #126547 mustFix2). */
    readonly weeklyAllExhaustedRefusals: number;
    readonly monthlyAllExhaustedRefusals: number;
  };
}

export const WEEK_WINDOW_MS = 7 * 86_400_000;
export const MONTH_WINDOW_MS = 30 * 86_400_000;

interface UsageRowShape {
  readonly billingProvider?: unknown;
  readonly billing?: unknown;
}

function isSubscriptionCall(row: LogStoreRow, provider: string): boolean {
  if (row.event !== 'llm-usage') return false;
  try {
    const parsed = row.data ? JSON.parse(row.data) as UsageRowShape : null;
    return parsed?.billingProvider === provider && parsed?.billing === 'subscription';
  } catch { return false; }
}

function isWindowExhaustion(row: LogStoreRow, provider: string): boolean {
  if (row.category !== 'harness.window-account' || row.event !== 'refused') return false;
  try {
    const parsed = row.data ? (JSON.parse(row.data) as { reason?: unknown; provider?: unknown }) : null;
    // 관측 의미 보존: provider 구분 + reason=all-exhausted 거절만. 계정 usage 부착은 하지 않는다(JUD-B #126547).
    return parsed?.reason === 'all-exhausted' && parsed?.provider === provider;
  } catch { return false; }
}

/** llm-usage 원장 행 → 구독(provider) 축 사용량(호출 수만 실측 · 가격은 미관측 null). */
export function subscriptionUsageFromLedgerRows(
  rows: readonly LogStoreRow[],
  nowMs: number,
  provider = 'openai-codex',
): SubscriptionUsage[] {
  let weekly = 0;
  let monthly = 0;
  for (const row of rows) {
    if (!isSubscriptionCall(row, provider)) continue;
    const age = nowMs - row.ts_ms;
    if (age <= MONTH_WINDOW_MS) monthly += 1;
    if (age >= 0 && age <= WEEK_WINDOW_MS) weekly += 1;
  }
  if (monthly === 0) return []; // 30일 관측 0 = 사용량 행 없음(0으로 합성하지 않는다)
  // terra r1 mustFix ②(PR 39662 r2) — 이 행은 provider급 총량(계정 미구분 관측)이다: 계정 창 소진을
  // 관측한 적이 없으므로 소진 수에 0을 심지 않고 null(미측정)로 낸다. 0을 심으면 조언자가 «창 소진 0»
  // 실측으로 하향을 권고한다(0 오판 — subscription-advisor-ledger.test.ts 종단 단언).
  return [{ provider, account: null, weeklyWindowExhaustions: null, monthlyWindowExhaustions: null, monthlyPriceUsd: null, monthlyCalls: monthly }];
}

/** harness.window-account refused(all-exhausted) 공급자별 선택 거절 수 — 관측된 거절마다 1(전환이 아님 · 계정 소진 수 아님). */
export function countAllExhaustedSelectionRefusals(rows: readonly LogStoreRow[], nowMs: number, provider: string): { weekly: number; monthly: number } {
  let weekly = 0;
  let monthly = 0;
  for (const row of rows) {
    if (!isWindowExhaustion(row, provider)) continue;
    const age = nowMs - row.ts_ms;
    if (age <= MONTH_WINDOW_MS) monthly += 1;
    if (age >= 0 && age <= WEEK_WINDOW_MS) weekly += 1;
  }
  return { weekly, monthly };
}

/** 제품 경로 어댑터 — 사용자가 치는 `elanous usage advisor` 가 이 함수로 조언자를 부른다. */
export function subscriptionAdvisorLedgerInput(deps: SubscriptionAdvisorLedgerDeps): SubscriptionAdvisorLedgerInput {
  const nowMs = (deps.now ?? Date.now)();
  const provider = deps.provider ?? 'openai-codex';
  const usageRows = deps.readRunLogs({ exactCategories: ['llm.usage'], events: ['llm-usage'], sinceMs: nowMs - MONTH_WINDOW_MS, limit: 10_000 });
  const exhaustionRows = deps.readRunLogs({ exactCategories: ['harness.window-account'], events: ['refused'], sinceMs: nowMs - MONTH_WINDOW_MS, limit: 10_000 });
  const refusals = countAllExhaustedSelectionRefusals(exhaustionRows, nowMs, provider);
  const snapshot = (deps.readSnapshot ?? readAccountWindowSnapshot)(provider, { forceShadow: true, now: () => nowMs });
  // 창 없는 후보도 통과(remaining=undefined «모름») — 조언자가 unknownWindowSubscriptions 로 세고 제안에서 뺀다(JUD-B #126547 mustFix1).
  const windows: SubscriptionWindow[] = (snapshot?.candidates ?? []).map((c) => ({
    provider: c.provider,
    account: c.account,
    ...(c.window !== undefined ? { remaining: c.window.remaining } : {}),
    ...(c.window !== undefined && c.window.resetsAtMs !== undefined ? { resetsAtMs: c.window.resetsAtMs } : {}),
  }));
  const base = subscriptionUsageFromLedgerRows(usageRows, nowMs, provider);
  let weeklyCalls = 0;
  for (const row of usageRows) {
    if (!isSubscriptionCall(row, provider)) continue;
    const age = nowMs - row.ts_ms;
    if (age >= 0 && age <= WEEK_WINDOW_MS) weeklyCalls += 1;
  }
  // ⛔ 거절 수를 계정 usage 에 부착하지 않는다(JUD-B #126547) — observed 에만 관측치로 낸다.
  return {
    windows,
    usage: base,
    observed: {
      weeklyCalls,
      monthlyCalls: base[0]?.monthlyCalls ?? 0,
      weeklyAllExhaustedRefusals: refusals.weekly,
      monthlyAllExhaustedRefusals: refusals.monthly,
    },
  };
}
