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
  type SavingsPriceOf,
  type SavingsReceipt,
} from '../model-tier/router-savings.js';
import { LogStore, logsDbPath, type LogQuery, type LogStoreRow } from '../mss/logging/log-store.js';

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
    out.push({
      at: atMs,
      role: str(data.role),
      phase: str(data.phase),
      model: str(data.model) ?? '(모델 미기록)',
      provider: str(data.billingProvider),
      billing: str(data.billing),
      tier: str(data.workTier),
      inputTokens: num(data.inputTokens),
      outputTokens: num(data.outputTokens),
      costUsd: cost !== null ? (num(cost.usd) ?? null) : null,
      apiEquivalentUsd: cost !== null ? (num(cost.apiEquivalentUsd) ?? null) : null,
    });
  }
  return out;
}

export interface LlmSavingsOpts {
  /** «강 단독» 기준 모델 id — 필수. */
  readonly premiumModel?: string;
  /** 측정 창(분). 기본 60. */
  readonly minutes?: number;
  /** 특정 런만. */
  readonly runId?: string;
  /** JSON 영수 출력. */
  readonly json?: boolean;
}

export interface LlmSavingsDeps {
  /** 시험 주입 — 원장 행 대신 직접 호출 행. */
  readonly rows?: readonly SavingsCallRow[];
  readonly priceOf?: SavingsPriceOf;
  readonly out?: (line: string) => void;
  readonly now?: () => number;
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
  const minutes = opts.minutes ?? DEFAULT_WINDOW_MINUTES;
  const calls = deps.rows !== undefined
    ? deps.rows
    : savingsCallsFromLedger(readLedgerWindow(), { now, sinceMs: minutes * 60_000, runId: opts.runId });
  const priceOf = deps.priceOf ?? defaultPriceOf;
  const receipt = summarizeRouterSavings({ calls, premiumModel: opts.premiumModel, priceOf });
  const out = deps.out ?? ((line: string) => console.log(line));
  if (opts.json) {
    // 데모 계약(--json): 한 줄 JSON 영수도 이 모듈이 낸다 — 액션이 반환값을 버려도 영수가 찍힌다.
    out(JSON.stringify(receipt));
    return { json: receipt };
  }
  out(renderSavingsReceiptMd(receipt, { title: 'SMART-ROUTER-DEMO-SAVINGS', at: new Date(now).toISOString(), premiumModel: opts.premiumModel }));
  return {};
}
