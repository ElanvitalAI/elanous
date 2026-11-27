// `eln llm savings` — SMART-ROUTER-DEMO-SAVINGS(OP #116366 · 11-23 타임리 시연) 영수 CLI.
//
// 실측 원장(logs.db 의 llm.usage / llm-usage 이벤트) 창을 읽어 router-savings 순수요약으로
// 데모 영수(md 또는 json)를 낸다. ① 호출별 모델·길목(role/phase)·등급 표 ② 고급 호출 수/전체
// ③ «강 단독» 대비 절감 비율.
// ⛔ 가격 비공개 — 단가·금액은 주입(기본 estimateLlmCost)로 «내부» 계산하고 영수에는 비율만 남는다.
// ⛔ 실측 원장만 — estimated(글자수 어림) 행은 버리고, 매긴 호출이 0이면 savingsPct=null.
// ⛔ 다른 category/event 행은 읽지 않는다(원장 계약).

import { existsSync } from 'node:fs';
import { estimateLlmCost } from '../budget/llm-cost.js';
import {
  renderSavingsReceiptMd,
  summarizeRouterSavings,
  type SavingsCallRow,
  type SavingsDayRow,
  type SavingsPriceOf,
  type SavingsReceipt,
} from '../model-tier/router-savings.js';
import { LogStore, logsDbPath, type LogQuery, type LogStoreRow } from '../mss/logging/log-store.js';
import { decideGuardedRoute, type GuardedRouteDecision } from '../llm/route-quality-guard.js';
import { ROUTER_SAVINGS_HISTORY_DAYS, isSmartRouterTier, type MembershipResolver } from '../plugins/smart-router/consumer.js';
import { authorizeRouterFeatureAtEntry } from '../plugins/smart-router/full-wire.js';
import { createMemberTierStore, memberTierResolver } from '../members/tier-store.js';

/** 원장 행 최소 형태(LogStoreRow 와 구조 호환 — 시험 주입용). `ts` 는 ISO 문자열(원장 실측 계약). */
export interface SavingsLedgerRow {
  readonly id: number;
  readonly ts: string;
  readonly category: string;
  readonly event: string;
  readonly data: string | null;
}

export interface LedgerWindowOpts {
  /** 창 기준 시각(epoch ms). */
  readonly now: number;
  /** 창 길이(ms). undefined 면 창 필터 없음. */
  readonly sinceMs?: number;
  /** 특정 런만. */
  readonly runId?: string;
}

type LedgerData = Record<string, unknown>;

/** 원장 행 → 요약 호출 행. 실측 계약: llm-usage 만, estimated 제외, 창·runId 필터. */
export function savingsCallsFromLedger(rows: readonly SavingsLedgerRow[], opts: LedgerWindowOpts): SavingsCallRow[] {
  const out: SavingsCallRow[] = [];
  for (const row of rows) {
    if (row.category !== 'llm.usage' || row.event !== 'llm-usage') continue;
    if (typeof row.data !== 'string' || row.data.length === 0) continue;
    // 원장 시각 계약: LogStoreRow.ts = ISO 문자열 → epoch ms 로 해석. 해석 불가 행은 창 배치가
    // 불가능하므로 제외(실측 원장만 — 합성 추측 금지).
    const atMs = Date.parse(row.ts);
    if (!Number.isFinite(atMs)) continue;
    let data: LedgerData;
    try {
      data = JSON.parse(row.data) as LedgerData;
    } catch {
      continue;
    }
    if (opts.sinceMs !== undefined && atMs < opts.now - opts.sinceMs) continue;
    if (opts.runId !== undefined && data.runId !== opts.runId) continue;
    if (data.estimated === true) continue;
    const cost = (data.cost ?? null) as { usd?: unknown; apiEquivalentUsd?: unknown } | null;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    // 실측값 계약(router-savings.ts): 구독 호출의 실측값은 apiEquivalentUsd(API 환산)다.
    // 구독 행의 cost.usd(부과분 0)를 costUsd 로 내보내면 요약이 0을 집어 절감이 100%로 과장된다
    // (judb-39664-84d0ecbb51c6 수리 중 발견 — 18707420 실측: usd=0 · apiEquivalentUsd=0.0033936).
    const costUsd = cost !== null && str(data.billing) !== 'subscription' ? (num(cost.usd) ?? null) : null;
    out.push({
      at: atMs,
      role: str(data.role),
      phase: str(data.phase),
      model: str(data.model) ?? '(모델 미기록)',
      provider: str(data.billingProvider),
      billing: str(data.billing),
      runKey: str(data.runId),
      tier: str(data.workTier),
      inputTokens: num(data.inputTokens),
      outputTokens: num(data.outputTokens),
      costUsd,
      apiEquivalentUsd: cost !== null ? (num(cost.apiEquivalentUsd) ?? null) : null,
    });
  }
  return out;
}

/** 일일 재계산 — 호출을 UTC 일(YYYY-MM-DD) 버킷으로 나눠 각 일을 summarizeRouterSavings 로 다시 요약한다(jud-39614 필수 3).
 *  ⛔ 가격 비공개 — savingsPct 는 주입 단가로 «내부» 계산한 비율뿐. 시각을 못 매긴 행은 '시각 미측정' 버킷(렌더 방어 관습). */
export function summarizeDailySavings(
  calls: readonly SavingsCallRow[],
  opts: { readonly premiumModel: string; readonly premiumModels?: readonly string[]; readonly priceOf: SavingsPriceOf },
): readonly SavingsDayRow[] {
  const buckets = new Map<string, SavingsCallRow[]>();
  for (const call of calls) {
    const day = Number.isFinite(call.at) ? new Date(call.at).toISOString().slice(0, 10) : '시각 미측정';
    const list = buckets.get(day);
    if (list) list.push(call);
    else buckets.set(day, [call]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, dayCalls]) => {
      const receipt = summarizeRouterSavings({ calls: dayCalls, premiumModel: opts.premiumModel, premiumModels: opts.premiumModels, priceOf: opts.priceOf });
      return {
        day,
        totalCalls: receipt.totalCalls,
        premiumCalls: receipt.premiumCalls,
        premiumShare: receipt.totalCalls === 0 ? 0 : receipt.premiumCalls / receipt.totalCalls,
        savingsPct: receipt.savingsPct,
        unpricedCalls: receipt.unpricedCalls,
      } satisfies SavingsDayRow;
    });
}

// ── 과제/런 키 대차 증거(judb-39664-84d0ecbb51c6 mustFix) ─────────────────────
// 같은 묶음을 ① 고정 티어 실행(전 과제 강 모델)과 ② 라우터 실행(가벼운 선출→임계 게이트→상향)으로
// 모두 돌려 비용·품질을 한 세트로 대차한다. 키 = 과제 id(묶음)·원장 runId(실측 행).
// ⛔ 가격 비공개 — 증거에는 주입 단가로 계산한 비율·횟수만 남는다.

/** 런 키 대차 한 행 — 같은 runId 에 묶인 실측 호출의 짝 대차(강 단독 단가 기준). */
export interface PairedRunKeyRow {
  /** 원장 data.runId — 그룹 키. */
  readonly key: string;
  readonly calls: number;
  readonly pricedCalls: number;
  readonly unpricedCalls: number;
  /** 1 − 실측합/강단가합(매긴 호출 0이거나 강단가합 ≤0 이면 null). */
  readonly savingsPct: number | null;
}

/**
 * 실측 원장 행을 런 키(data.runId)로 묶어 짝 대차한다 — 키 순서는 원장 첫 등장 순.
 * 각 키 안에서 실측값(구독=apiEquivalentUsd · credit/api=costUsd — 실측 계약) 합을
 * 같은 토큰의 강 단독 단가 합으로 다시 계산한 값에 대비한다. ⛔ 합성 0 — 매긴 호출이 없으면 null.
 */
export function pairLedgerRowsByRunKey(
  rows: readonly SavingsLedgerRow[],
  opts: { readonly now: number; readonly sinceMs?: number; readonly premiumModel: string; readonly priceOf: SavingsPriceOf },
): readonly PairedRunKeyRow[] {
  const calls = savingsCallsFromLedger(rows, { now: opts.now, sinceMs: opts.sinceMs });
  const buckets = new Map<string, SavingsCallRow[]>();
  for (const call of calls) {
    const key = call.runKey ?? '(런 미기록)';
    const list = buckets.get(key);
    if (list) list.push(call);
    else buckets.set(key, [call]);
  }
  return [...buckets.entries()].map(([key, keyCalls]) => {
    let actual = 0;
    let fixed = 0;
    let priced = 0;
    let unpriced = 0;
    for (const call of keyCalls) {
      const actualUsd = call.costUsd ?? call.apiEquivalentUsd ?? null;
      const tokens = call.inputTokens !== undefined && call.outputTokens !== undefined
        ? { inputTokens: call.inputTokens, outputTokens: call.outputTokens }
        : null;
      const fixedUsd = tokens !== null ? opts.priceOf(opts.premiumModel, tokens) : null;
      if (actualUsd === null || fixedUsd === null || !Number.isFinite(actualUsd) || !Number.isFinite(fixedUsd)) {
        unpriced += 1;
        continue;
      }
      actual += actualUsd;
      fixed += fixedUsd;
      priced += 1;
    }
    const savingsPct = priced === 0 || fixed <= 0 ? null : 1 - actual / fixed;
    return { key, calls: keyCalls.length, pricedCalls: priced, unpricedCalls: unpriced, savingsPct } satisfies PairedRunKeyRow;
  });
}

/** 대차 과제 한 건 — 같은 토큰 묶음을 두 실행(고정 티어 vs 라우터)으로 돌린다. */
export interface PairedBundleTask {
  /** 과제 키 — 세트 내 유일(원장 runId 와 같은 축의 증거 키). */
  readonly key: string;
  readonly taskType: string;
  readonly tokens: { readonly inputTokens: number; readonly outputTokens: number };
}

/** 과제 한 행의 대차 — 고정 티어 실행과 라우터 실행의 모델·품질·절감 비율. ⛔ 가격 비공개 — 비율만. */
export interface PairedBundleRow {
  readonly key: string;
  readonly taskType: string;
  readonly fixedTierModel: string;
  /** 고정 티어 품질 — 라우터의 shadow 강 평가 점수를 그대로 재사용(평가 이중화 0). */
  readonly fixedTierQuality: number;
  readonly routedModel: string;
  readonly escalated: boolean;
  readonly routedQuality: number;
  readonly appliedFloor: number;
  /** 인도 품질 − 적용 임계(품질 하한 보존 근거). */
  readonly qualityVsFloor: number;
  /** 1 − 인도 단가/강 단독 단가(같은 과제 토큰 · 주입 단가 — 비공개). */
  readonly costSavingsPct: number | null;
}

/** 과제/런 키 대차 증거 한 세트 — 같은 묶음의 비용·품질 대차를 한 표에 남긴다. */
export interface PairedBundleEvidence {
  readonly rows: readonly PairedBundleRow[];
  readonly escalated: number;
  readonly kept: number;
  /** shadow 강 평가 횟수(과제당 정확히 1회). */
  readonly premiumEvaluations: number;
  /** 묶음 최저 (인도 품질 − 적용 임계) — 전 과제 ≥0 이면 품질 하한 보존. */
  readonly minQualityVsFloor: number | null;
  /** 묶음 절감 비율 — 1 − 인도 단가 합/강 단독 단가 합. */
  readonly costSavingsPct: number | null;
}

export interface BuildPairedBundleInput {
  readonly tasks: readonly PairedBundleTask[];
  readonly lightweight: string;
  readonly premium: string;
  /** (모델, 과제 키) → 품질 점수(0~1). shadow 강 평가가 곧 고정 티어 품질이다(과제당 강 평가 정확히 1회). */
  readonly evaluate: (model: string, key: string) => number | Promise<number>;
  /** 유형→인도 임계(전유형 바닥 ≥0.95 — route-quality-guard 계약). */
  readonly floors?: Readonly<Record<string, number>>;
  readonly priceOf: SavingsPriceOf;
}

/**
 * 묶음 대차 증거를 만든다(judb-39664 mustFix): 과제마다 라우터를 돌려(shadow 기본 on —
 * 프리미엄 평가 과제당 정확히 1회) 그 shadow 점수를 고정 티어(강) 품질로 그대로 재사용하고,
 * 같은 과제 토큰으로 인도 모델 단가 vs 강 단독 단가를 짝 대차한다.
 */
export async function buildPairedBundleEvidence(input: BuildPairedBundleInput): Promise<PairedBundleEvidence> {
  const rows: PairedBundleRow[] = [];
  let premiumEvaluations = 0;
  let actualTotal = 0;
  let fixedTotal = 0;
  let priced = 0;
  for (const task of input.tasks) {
    const decision: GuardedRouteDecision = await decideGuardedRoute({
      lightweight: input.lightweight,
      premium: input.premium,
      evaluate: model => input.evaluate(model, task.key),
      taskType: task.taskType,
      floors: input.floors,
    });
    if (decision.shadowScore !== null) premiumEvaluations += 1;
    const fixedTierQuality = decision.shadowScore ?? decision.qualityScore;
    const routedPrice = input.priceOf(decision.model, task.tokens);
    const fixedPrice = input.priceOf(input.premium, task.tokens);
    let costSavingsPct: number | null = null;
    if (routedPrice !== null && fixedPrice !== null && Number.isFinite(routedPrice) && Number.isFinite(fixedPrice) && fixedPrice > 0) {
      costSavingsPct = 1 - routedPrice / fixedPrice;
      actualTotal += routedPrice;
      fixedTotal += fixedPrice;
      priced += 1;
    }
    rows.push({
      key: task.key,
      taskType: decision.taskType,
      fixedTierModel: input.premium,
      fixedTierQuality,
      routedModel: decision.model,
      escalated: decision.escalated,
      routedQuality: decision.qualityScore,
      appliedFloor: decision.appliedFloor,
      qualityVsFloor: decision.qualityScore - decision.appliedFloor,
      costSavingsPct,
    });
  }
  const escalated = rows.filter(r => r.escalated).length;
  return {
    rows,
    escalated,
    kept: rows.length - escalated,
    premiumEvaluations,
    minQualityVsFloor: rows.length === 0 ? null : Math.min(...rows.map(r => r.qualityVsFloor)),
    costSavingsPct: priced === 0 || fixedTotal <= 0 ? null : 1 - actualTotal / fixedTotal,
  };
}

export interface LlmSavingsOpts {
  /** «강 단독» 기준 모델 id — 필수. */
  readonly premiumModel?: string;
  readonly premiumModels?: readonly string[];
  /** 측정 창(분). 기본 60. */
  readonly minutes?: number;
  /** 특정 런만. */
  readonly runId?: string;
  /** JSON 영수 출력. */
  readonly json?: boolean;
  /** 일일 재계산 표도 영수에 실린다(UTC 일 버킷별 — jud-39614 필수 3). */
  readonly daily?: boolean;
}

export interface LlmSavingsDeps {
  /** 시험 주입 — 원장 행 대신 직접 호출 행. */
  readonly rows?: readonly SavingsCallRow[];
  readonly priceOf?: SavingsPriceOf;
  readonly out?: (line: string) => void;
  readonly now?: () => number;
  /** SMART-ROUTER-TIER-FULL-WIRE(칸 43) — 등급 원천 주입(시험). 없으면 실제 원천 스토어 → env 폴백 → free. */
  readonly membership?: MembershipResolver;
}

export interface LlmSavingsResult {
  readonly error?: string;
  readonly json?: SavingsReceipt;
}

const DEFAULT_WINDOW_MINUTES = 60;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 50;

/** 운영 리더 — usage-cli readRunLogs 패턴(읽기 전용·페이지 순회). */
function readLedgerWindow(): LogStoreRow[] {
  const path = logsDbPath();
  if (!existsSync(path)) return [];
  const store = LogStore.openReadOnly(path);
  try {
    const rows: LogStoreRow[] = [];
    let beforeId: number | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: LogQuery = { exactCategories: ['llm.usage'], events: ['llm-usage'], beforeId, limit: PAGE_LIMIT };
      const batch = store.query(query);
      rows.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
      beforeId = batch[batch.length - 1].id;
    }
    return rows;
  } finally {
    store.close();
  }
}

/** 기본 단가 주입 — 내부 계산용(영수에는 금액이 실리지 않는다). */
const defaultPriceOf: SavingsPriceOf = (model, tokens) => {
  const est = estimateLlmCost({ model, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens });
  return est.kind === 'known' ? est.usd : null;
};

export async function runLlmSavings(opts: LlmSavingsOpts, deps: LlmSavingsDeps = {}): Promise<LlmSavingsResult> {
  if (!opts.premiumModel) {
    return { error: '--premium-model <모델 id> 필요 — «강 단독» 기준 모델을 지정해야 절감 비율을 계산한다.' };
  }
  const now = deps.now ? deps.now() : Date.now();
  // SMART-ROUTER-TIER-FULL-WIRE(칸 43) — savings_receipt 진입 게이트: 등급 원천(member-tier-store → env → free
  // fail-closed)이 표 판정을 내리고, 거부(missing-tier·unknown-tier·denied)면 영수 대신 거부 안내(fail-closed).
  const membership = deps.membership ?? memberTierResolver(createMemberTierStore());
  const savingsGrant = authorizeRouterFeatureAtEntry('router.savings_receipt', membership);
  if (!savingsGrant.allowed) {
    return { error: `⛔ 절감 영수를 내지 못했다 — router.savings_receipt:${savingsGrant.reason} (${savingsGrant.entry} · ${savingsGrant.tierSource})` };
  }
  const minutes = opts.minutes ?? DEFAULT_WINDOW_MINUTES;
  // SMART-ROUTER-TIER-FULL-WIRE — unlimited_history 집행: 등급별 기록 보존 상한(ROUTER_SAVINGS_HISTORY_DAYS ·
  // 출처: consumer.ts PRODUCT-SMART-ROUTER-TIERS-1117 «등급» 표 — free 7일 · pro 30일 · advanced 무제한).
  // 요청 창(minutes)이 등급 상한보다 크면 상한으로 잘라 읽는다(등급 상향 우회 금지 · fail-closed).
  const tierNow = membership.currentTier();
  const daysCap = isSmartRouterTier(tierNow) ? ROUTER_SAVINGS_HISTORY_DAYS[tierNow] : ROUTER_SAVINGS_HISTORY_DAYS.free;
  const minutesCap = daysCap === Number.POSITIVE_INFINITY ? minutes : Math.min(minutes, daysCap * 24 * 60);
  const calls = deps.rows !== undefined
    ? deps.rows
    : savingsCallsFromLedger(readLedgerWindow(), { now, sinceMs: minutesCap * 60_000, runId: opts.runId });
  const priceOf = deps.priceOf ?? defaultPriceOf;
  const receipt = summarizeRouterSavings({ calls, premiumModel: opts.premiumModel, premiumModels: opts.premiumModels, priceOf });
  // 일일 재계산(--daily): UTC 일 버킷 표를 영수에 함께 실는다 — 가격은 비공개(비율만).
  const json = opts.daily
    ? { ...receipt, daily: summarizeDailySavings(calls, { premiumModel: opts.premiumModel, premiumModels: opts.premiumModels, priceOf }) }
    : receipt;
  const out = deps.out ?? ((line: string) => console.log(line));
  if (opts.json) {
    // 데모 계약(--json): 한 줄 JSON 영수도 이 모듈이 낸다 — 액션이 반환값을 버려도 영수가 찍힌다.
    out(JSON.stringify(json));
    return { json };
  }
  out(renderSavingsReceiptMd(json, { title: 'SMART-ROUTER-DEMO-SAVINGS', at: new Date(now).toISOString(), premiumModel: opts.premiumModel }));
  return {};
}
