#!/usr/bin/env bun
import { asRecord } from '../src/primitives/guards.js';
// Read-only llm.usage ledger: measurable USD + unknown-pricing remainder.
//
// Invokes the existing logs command. Does not write logs, mutate config,
// touch runRecorder, or use the network.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  estimateLlmCost,
  readLlmConfigPricing,
  type LlmCostUsage,
  type LlmPricingUsd,
} from '../src/budget/llm-cost.js';

const PAGE_LIMIT = '100000';
const MAX_PAGES = 10_000;

const LOGS_ARGS = [
  'bin/elanous.mjs',
  'logs',
  '--category', 'llm.usage',
  '--all',
  '--include-test',
  '--json',
  '--json-data',
  '--limit', PAGE_LIMIT,
] as const;

export interface LlmCostLedgerSummary {
  rows: number;
  /** Priced dollars from complete rows plus the priced portion of partial rows. */
  measurableUsd: number;
  knownUsd: number;
  partialUsd: number;
  unknownRows: number;
  unknownModels: string[];
  partialRows: number;
  partialModels: string[];
  incomplete: boolean;
  failure?: string;
  /** 공급자 잔액 관측이 주어졌을 때만 — 없으면 원장 출력은 종전과 바이트 동일. */
  reconcile?: LlmCostReconcile;
  /** TOKEN-BURN-BY-SEAT — 기본 출력에 포함되는 자리×모델×30분 축(카드 표 줄). 빈 원장이면 빈 배열. */
  seatAxis?: string[];
  /** JUD-3(OP #132677) — 같은 자리 10분 100콜 초과 경보 줄(카드). 없으면 undefined(출력 변화 없음). */
  seatRateAlerts?: string[];
}

// ── TOKEN-BURN-BY-SEAT JUD-3(OP #132677 · 0.3.33) — 같은 자리 10분 100콜↑ 경보 ──────────
export const SEAT_RATE_WINDOW_MS = 10 * 60 * 1_000;
export const SEAT_RATE_ALERT_THRESHOLD = 100;

export interface SeatRateAlert {
  seat: string;
  windowStartIso: string;
  windowEndIso: string;
  calls: number;
  threshold: number;
  windowMs: number;
}

/**
 * 원장 행을 자리별 시각 배열로 모은 뒤, 슬라이딩 10분 창에서 «정확히 임계를 초과한» 순간마다 경보 1건.
 * 창은 각 행을 창 끝으로 삼는 투포인터 — 버킷 경계가 아니라 실제 연소 구간을 잡는다(OP #132677).
 * ts 파싱 불능 행은 창에 넣지 않는다(#39502 원장 ts 신뢰 관례). 출처: #132677/#39654.
 */
export function detectSeatRateAlerts(lines: readonly string[]): SeatRateAlert[] {
  const bySeat = new Map<string, number[]>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const rec = asRecord(parsed);
    if (!rec) continue;
    const data = asRecord(rec.data);
    if (!data || typeof data.model !== 'string') continue; // llm.usage 행만 센다
    const time = typeof rec.ts === 'string' ? Date.parse(rec.ts) : Number.NaN;
    if (!Number.isFinite(time)) continue;
    const seatRaw = typeof data.seat === 'string' && data.seat ? data.seat : undefined;
    const seat = seatRaw ?? '(no-seat)';
    const stamps = bySeat.get(seat);
    if (stamps) stamps.push(time);
    else bySeat.set(seat, [time]);
  }
  const alerts: SeatRateAlert[] = [];
  for (const [seat, stamps] of bySeat) {
    stamps.sort((a, b) => a - b);
    let start = 0;
    let lastAlertEndMs: number | null = null;
    for (let end = 0; end < stamps.length; end++) {
      while (stamps[end]! - stamps[start]! >= SEAT_RATE_WINDOW_MS) start += 1;
      if (end - start + 1 > SEAT_RATE_ALERT_THRESHOLD) {
        // 같은 연소 에피소드(앞 경보 창과 행을 공유)면 1건으로 묶는다 — 첫 임계 도달 시점 1건(OP #132677: 101콜→경보 1).
        if (lastAlertEndMs !== null && stamps[start]! < lastAlertEndMs) continue;
        lastAlertEndMs = stamps[end]!;
        alerts.push({
          seat,
          windowStartIso: new Date(stamps[start]!).toISOString(),
          windowEndIso: new Date(stamps[end]!).toISOString(),
          calls: end - start + 1,
          threshold: SEAT_RATE_ALERT_THRESHOLD,
          windowMs: SEAT_RATE_WINDOW_MS,
        });
      }
    }
  }
  alerts.sort((a, b) => a.windowStartIso.localeCompare(b.windowStartIso) || a.seat.localeCompare(b.seat));
  return alerts;
}

/** 30분 카드 경보 줄 — `alert seat <자리> <시작>..~<끝> calls N > 100 (10m window)`. */
export function formatSeatRateAlert(alert: SeatRateAlert): string {
  return `alert seat ${alert.seat} ${alert.windowStartIso}..~${alert.windowEndIso} calls ${alert.calls} > ${alert.threshold} (${Math.round(alert.windowMs / 60_000)}m window)`;
}

/** 우편 1통(OP) — gate-bisect-owner-mail 관례 재사용. 발송 실패는 경보 출력에 실패 문구로만 남긴다(원장 출력 중단 없음). */
function postSeatRateAlertMail(alertLines: readonly string[], repoRoot: string): string | undefined {
  const body = [
    '[TOKEN-BURN-BY-SEAT JUD-3 경보] 같은 자리 10분 100콜 초과',
    ...alertLines,
    `source: llm-cost-ledger · 출처: OP #132677`,
  ].join('\n');
  const result = spawnSync('eln', ['msg', 'post', '--from', 'OP', '--to', 'OP', '--kind', 'alert', '--body', body], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
  });
  if (result.error || result.status !== 0) {
    return `alert-mail-failed: ${((result.stderr || result.stdout || result.error?.message || `eln msg post exited ${result.status}`).trim())}`;
  }
  return /#(\d+)/.exec(result.stdout)?.[0];
}

export interface UsageLogFetchResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
}

/** 경보 임계 — 측정액과 공급자 잔액 변화의 차이가 이 비율을 «초과» 하면 경보(10%). */
export const RECONCILE_THRESHOLD_RATIO = 0.1;

/** 대조에 필요한 잔액 관측 — 전일 잔액과 금일 잔액(공급자 보고 USD). */
export interface LlmCostLedgerBalance {
  beforeUsd: number;
  afterUsd: number;
  provider?: string;
}

export type LlmCostReconcileStatus = 'ok' | 'alert' | 'unmeasured';

export type LlmCostReconcileReason = 'balance-increased' | 'no-balance-change';

/** 일별 토큰×단가 합계와 공급자 잔액 변화의 대조 결과. */
export interface LlmCostReconcile {
  /** 호출자가 실제로 관측해 넘긴 공급자 이름만 — 모르면 필드 자체가 없다(합성 기본값 없음). */
  provider?: string;
  /** 대조에 넣은 달러 = known + partial (측정 가능분). */
  measuredUsd: number;
  knownUsd: number;
  partialUsd: number;
  /** 단가를 몰라 대조에서 빠진 잔여 — 0 USD 로 꾸미지 않고 칸으로 남긴다. */
  unmeasuredRows: number;
  unmeasuredModels: string[];
  unmeasuredUsd: null;
  balanceBeforeUsd: number;
  balanceAfterUsd: number;
  /** 전일 잔액 − 금일 잔액. */
  balanceDeltaUsd: number;
  /** 잔액이 줄지 않았으면(충전) 대조 불가 — null. */
  diffUsd: number | null;
  diffRatio: number | null;
  thresholdRatio: number;
  status: LlmCostReconcileStatus;
  reason?: LlmCostReconcileReason;
}

export interface ReconcileLlmCostInput {
  measuredUsd: number;
  knownUsd?: number;
  partialUsd?: number;
  unmeasuredRows?: number;
  unmeasuredModels?: readonly string[];
  balanceBeforeUsd: number;
  balanceAfterUsd: number;
  provider?: string;
  thresholdRatio?: number;
}

function reconcileNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 일별 토큰×단가 합계(measuredUsd)를 공급자 잔액 변화(before − after)와 대조한다.
 *  ⛔ 새 비용 축을 만들지 않는다 — 단가 축은 `estimateLlmCost` 합계, 공급자 축은 잔액 관측 그대로다. */
export function reconcileLlmCostVsBalance(input: ReconcileLlmCostInput): LlmCostReconcile {
  const measuredUsd = reconcileNumber(input.measuredUsd, 0);
  const knownUsd = reconcileNumber(input.knownUsd, 0);
  const partialUsd = reconcileNumber(input.partialUsd, 0);
  const unmeasuredRows = reconcileNumber(input.unmeasuredRows, 0);
  const thresholdRatio = reconcileNumber(input.thresholdRatio, RECONCILE_THRESHOLD_RATIO);
  const balanceBeforeUsd = reconcileNumber(input.balanceBeforeUsd, 0);
  const balanceAfterUsd = reconcileNumber(input.balanceAfterUsd, 0);
  const balanceDeltaUsd = balanceBeforeUsd - balanceAfterUsd;

  let diffUsd: number | null = null;
  let diffRatio: number | null = null;
  let status: LlmCostReconcileStatus = 'ok';
  let reason: LlmCostReconcileReason | undefined;
  if (balanceDeltaUsd < 0) {
    status = 'unmeasured';
    reason = 'balance-increased';
  } else if (balanceDeltaUsd === 0) {
    diffUsd = measuredUsd;
    if (measuredUsd > 0) {
      status = 'alert';
      reason = 'no-balance-change';
    }
  } else {
    diffUsd = Math.abs(measuredUsd - balanceDeltaUsd);
    diffRatio = diffUsd / balanceDeltaUsd;
    if (diffRatio > thresholdRatio) status = 'alert';
  }

  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  return {
    ...(provider ? { provider } : {}),
    measuredUsd,
    knownUsd,
    partialUsd,
    unmeasuredRows,
    unmeasuredModels: [...(input.unmeasuredModels ?? [])].sort(),
    unmeasuredUsd: null,
    balanceBeforeUsd,
    balanceAfterUsd,
    balanceDeltaUsd,
    diffUsd,
    diffRatio,
    thresholdRatio,
    status,
    ...(reason ? { reason } : {}),
  };
}

function ratioText(value: number | null): string {
  return value === null ? 'unmeasured' : String(Math.round(value * 1e6) / 1e6);
}

function formatReconcileLines(reconcile: LlmCostReconcile): string[] {
  return [
    `reconcileProvider ${reconcile.provider ?? '(unknown)'}`,
    `reconcileMeasuredUsd ${reconcile.measuredUsd}`,
    `reconcileKnownUsd ${reconcile.knownUsd}`,
    `reconcilePartialUsd ${reconcile.partialUsd}`,
    `reconcileUnmeasuredRows ${reconcile.unmeasuredRows}`,
    `reconcileUnmeasuredModels ${reconcile.unmeasuredModels.join(',') || '(none)'}`,
    `reconcileBalanceDeltaUsd ${reconcile.balanceDeltaUsd}`,
    `reconcileDiffUsd ${reconcile.diffUsd === null ? 'unmeasured' : reconcile.diffUsd}`,
    `reconcileDiffRatio ${ratioText(reconcile.diffRatio)}`,
    `reconcileThreshold ${reconcile.thresholdRatio}`,
    `reconcileStatus ${reconcile.status}${reconcile.reason ? ` ${reconcile.reason}` : ''}`,
    ...(reconcile.status === 'alert'
      ? [`alert reconcile-diff measuredUsd ${reconcile.measuredUsd} balanceDeltaUsd ${reconcile.balanceDeltaUsd} diffUsd ${reconcile.diffUsd} diffRatio ${ratioText(reconcile.diffRatio)} threshold ${reconcile.thresholdRatio}`]
      : []),
  ];
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value, { fallback: 'undefined' });
}

function usageFromRow(row: Record<string, unknown>): LlmCostUsage | undefined {
  if (row._meta) return undefined;
  const nested = recordOrUndefined(row.data);
  const data = nested
    ?? (typeof row.model === 'string' ? row : undefined)
    ?? (row.category === 'llm.usage' ? row : undefined);
  if (!data) return undefined;
  const model = typeof data.model === 'string' ? data.model : '';
  const num = (key: keyof LlmCostUsage): number | undefined => {
    const v = data[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  return {
    model,
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    cacheReadInputTokens: num('cacheReadInputTokens'),
    cacheCreationInputTokens: num('cacheCreationInputTokens'),
  };
}

export function limitMetaFromRow(row: Record<string, unknown>): {
  limitReached: boolean;
  nextCursor: number | null;
  nextCursors?: Record<string, number>;
} | undefined {
  const meta = recordOrUndefined(row._meta) ?? (row.type === 'log-query-limit' ? row : undefined);
  if (!meta || meta.type !== 'log-query-limit') return undefined;
  const nextCursors = recordOrUndefined(meta.nextCursors) as Record<string, number> | undefined;
  return {
    limitReached: meta.limitReached === true,
    nextCursor: typeof meta.nextCursor === 'number' ? meta.nextCursor : null,
    ...(nextCursors ? { nextCursors } : {}),
  };
}

export function spawnPageFailure(
  status: number | null,
  spawn?: { error?: Error | null; signal?: NodeJS.Signals | null },
): string | undefined {
  const error = spawn?.error;
  if (error) {
    const code = 'code' in error && error.code != null ? String(error.code) : undefined;
    return code ? `spawn error: ${code}` : `spawn error: ${error.message}`;
  }
  if (spawn?.signal) return `killed by ${spawn.signal}`;
  if (status !== 0) return status == null ? 'spawn status null' : `exit ${status}`;
  return undefined;
}

export function pageIsIncomplete(
  stdout: string,
  stderr: string,
  status: number | null,
  spawn?: { error?: Error | null; signal?: NodeJS.Signals | null },
): {
  usageLines: string[];
  limitReached: boolean;
  nextBefore?: string;
  incomplete: boolean;
  failure?: string;
} {
  const usageLines: string[] = [];
  let limitReached = false;
  let nextBefore: string | undefined;
  let unreadable = false;
  let invalidOutput = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      invalidOutput = true;
      continue;
    }
    const rec = recordOrUndefined(parsed);
    if (!rec) {
      invalidOutput = true;
      continue;
    }
    const metaType = recordOrUndefined(rec._meta)?.type ?? rec.type;
    if (metaType === 'log-query-unreadable-instances') {
      unreadable = true;
      continue;
    }
    const limit = limitMetaFromRow(rec);
    if (limit) {
      limitReached = limit.limitReached;
      if (limit.nextCursors && Object.keys(limit.nextCursors).length > 0) {
        nextBefore = JSON.stringify(limit.nextCursors);
      } else if (limit.nextCursor != null) {
        nextBefore = String(limit.nextCursor);
      }
      continue;
    }
    usageLines.push(trimmed);
  }
  const stderrTruncated = stderr.includes('limitReached=true');
  if (stderrTruncated) limitReached = true;
  const spawnFailure = spawnPageFailure(status, spawn);
  const failure = spawnFailure
    ?? (invalidOutput ? 'invalid-json' : undefined)
    ?? (unreadable ? 'unreadable-instances' : undefined)
    ?? (limitReached && !nextBefore ? 'truncated-without-cursor' : undefined);
  const incomplete = !!spawnFailure || unreadable || invalidOutput || (limitReached && !nextBefore);
  return {
    usageLines,
    limitReached,
    nextBefore,
    incomplete,
    ...(failure ? { failure } : {}),
  };
}

export function collectUsageLogPages(
  fetchPage: (before?: string) => UsageLogFetchResult,
): { lines: string[]; incomplete: boolean; failure?: string } {
  const lines: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { stdout, stderr, status, error, signal } = fetchPage(before);
    const parsed = pageIsIncomplete(stdout, stderr, status, { error, signal });
    lines.push(...parsed.usageLines);
    if (parsed.incomplete) {
      return { lines, incomplete: true, ...(parsed.failure ? { failure: parsed.failure } : {}) };
    }
    if (!parsed.limitReached) return { lines, incomplete: false };
    if (!parsed.nextBefore) return { lines, incomplete: true, failure: 'truncated-without-cursor' };
    before = parsed.nextBefore;
  }
  return { lines, incomplete: true, failure: 'page-limit' };
}

// ── TOKEN-BURN-BY-SEAT(0.3.33 P0 · OP #132084) — 자리·모델·30분 버킷 집계 ──────────
/** 30분 버킷의 시작 ISO — ts 가 버킷 경계에 떨어지면 그 시각, 아니면 버려진다(원장 ts 신뢰). */
export const USAGE_BUCKET_MS = 30 * 60 * 1_000;

export interface UsageBySeatRow {
  seat: string;
  model: string;
  bucketStartIso: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 측정 가능한 USD(known+partial) — 미측정 행이 섞이면 unknownRows 로 별도 표시(0 꾸미기 금지). */
  usd?: number;
  unknownRows: number;
}

export interface UsageBySeatTable {
  rows: UsageBySeatRow[];
  /** seat 필드 없는 원장 행 수(스탬프 착지 이전 구행) — (no-seat) 행과 함께 표시. */
  unstampedRows: number;
}

function bucketStartIsoFromTs(ts: unknown): string | undefined {
  const date = typeof ts === 'string' ? new Date(ts) : undefined;
  const time = date?.getTime();
  if (time === undefined || !Number.isFinite(time)) return undefined;
  const bucketMs = Math.floor(time / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;
  return new Date(bucketMs).toISOString();
}

/** #39502 llm.usage 원장 행을 자리×모델×30분 버킷으로 모은다 — 30분 카드(PLAN-TPS20-CADENCE-1111)용. */
export function summarizeUsageBySeat(
  lines: readonly string[],
  opts: { configPricing?: Record<string, LlmPricingUsd> } = {},
): UsageBySeatTable {
  const configPricing = opts.configPricing ?? readLlmConfigPricing();
  const buckets = new Map<string, UsageBySeatRow>();
  let unstampedRows = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const rec = recordOrUndefined(parsed);
    if (!rec) continue;
    const usage = usageFromRow(rec);
    if (!usage) continue;
    const data = recordOrUndefined(rec.data);
    const seatRaw = typeof data?.seat === 'string' && data.seat ? data.seat : undefined;
    const seat = seatRaw ?? '(no-seat)';
    if (!seatRaw) unstampedRows += 1;
    const bucketStartIso = bucketStartIsoFromTs(rec.ts);
    if (!bucketStartIso) continue; // ts 없는 행은 버킷 불능 — 표에서 제외(총계는 summarizeLlmUsageRows 담당)
    const key = `${bucketStartIso}|${seat}|${usage.model}`;
    let row = buckets.get(key);
    if (!row) {
      row = { seat, model: usage.model, bucketStartIso, calls: 0, inputTokens: 0, outputTokens: 0, unknownRows: 0 };
      buckets.set(key, row);
    }
    row.calls += 1;
    row.inputTokens += usage.inputTokens ?? 0;
    row.outputTokens += usage.outputTokens ?? 0;
    const estimate = estimateLlmCost(usage, { configPricing });
    if (estimate.kind === 'known' || estimate.kind === 'partial') row.usd = (row.usd ?? 0) + estimate.usd;
    else row.unknownRows += 1;
  }
  const rows = [...buckets.values()].sort((a, b) =>
    a.bucketStartIso.localeCompare(b.bucketStartIso) || a.seat.localeCompare(b.seat) || a.model.localeCompare(b.model));
  return { rows, unstampedRows };
}

/** 30분 카드에 붙여넣는 한 줄 표 — `seat <자리> bucket <ISO> model <모델> calls N inTok N outTok N usd N [unknown N]`. */
export function formatUsageBySeatTable(table: UsageBySeatTable): string {
  const lines = table.rows.map((r) =>
    `seat ${r.seat} bucket ${r.bucketStartIso} model ${r.model} calls ${r.calls}`
    + ` inTok ${r.inputTokens} outTok ${r.outputTokens}`
    + (r.usd !== undefined ? ` usd ${r.usd}` : ' usd unmeasured')
    + (r.unknownRows > 0 ? ` unknown ${r.unknownRows}` : ''));
  if (table.unstampedRows > 0) lines.push(`unstamped ${table.unstampedRows}`);
  return lines.join('\n');
}

export function summarizeLlmUsageRows(
  lines: readonly string[],
  configPricing = readLlmConfigPricing(),
): Omit<LlmCostLedgerSummary, 'incomplete'> {
  let rows = 0;
  let knownUsd = 0;
  let partialUsd = 0;
  let unknownRows = 0;
  let partialRows = 0;
  const unknownModels = new Set<string>();
  const partialModels = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const rec = recordOrUndefined(parsed);
    if (!rec) continue;
    const usage = usageFromRow(rec);
    if (!usage) continue;
    rows += 1;
    const estimate = estimateLlmCost(usage, { configPricing });
    if (estimate.kind === 'known') {
      knownUsd += estimate.usd;
    } else if (estimate.kind === 'partial') {
      partialUsd += estimate.usd;
      partialRows += 1;
      partialModels.add(estimate.model);
    } else {
      unknownRows += 1;
      unknownModels.add(estimate.model);
    }
  }
  return {
    rows,
    measurableUsd: knownUsd + partialUsd,
    knownUsd,
    partialUsd,
    unknownRows,
    unknownModels: [...unknownModels].sort(),
    partialRows,
    partialModels: [...partialModels].sort(),
  };
}

export function formatLlmCostLedger(summary: LlmCostLedgerSummary): string {
  return [
    `measurableUsd ${summary.measurableUsd}`,
    `knownUsd ${summary.knownUsd}`,
    `partialUsd ${summary.partialUsd}`,
    `unknownRows ${summary.unknownRows}`,
    `unknownModels ${summary.unknownModels.join(',') || '(none)'}`,
    `partialRows ${summary.partialRows}`,
    `partialModels ${summary.partialModels.join(',') || '(none)'}`,
    `rows ${summary.rows}`,
    `incomplete ${summary.incomplete ? 'true' : 'false'}`,
    ...(summary.failure ? [`failure ${summary.failure}`] : []),
    ...(summary.seatAxis ? summary.seatAxis : []),
    ...(summary.seatRateAlerts ? summary.seatRateAlerts : []),
    ...(summary.reconcile ? formatReconcileLines(summary.reconcile) : []),
  ].join('\n');
}

function spawnUsageLogPage(repoRoot: string): (before?: string) => UsageLogFetchResult {
  return (before) => {
    const args = before ? [...LOGS_ARGS, '--before', before] : [...LOGS_ARGS];
    const result = spawnSync('bun', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
      error: result.error ?? null,
      signal: result.signal ?? null,
    };
  };
}

/** 생산 진입점 테스트 시젠 — 로그 페이지 공급자·잔액 관측·출력 싱크를 주입한다. */
export interface LlmCostLedgerDeps {
  fetchPage?: (before?: string) => UsageLogFetchResult;
  balance?: LlmCostLedgerBalance;
  configPricing?: Readonly<Record<string, LlmPricingUsd>>;
  out?: (line: string) => void;
}

/** `--balance-before <usd> --balance-after <usd> [--balance-provider <name>]` — 공급자 잔액 관측. */
function cliBalance(argv: readonly string[]): LlmCostLedgerBalance | undefined {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const before = Number(flag('--balance-before'));
  const after = Number(flag('--balance-after'));
  if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0) return undefined;
  const provider = flag('--balance-provider');
  return { beforeUsd: before, afterUsd: after, ...(provider ? { provider } : {}) };
}

export function main(
  repoRoot: string = join(import.meta.dir, '..'),
  deps: LlmCostLedgerDeps = {},
): LlmCostLedgerSummary {
  const { lines, incomplete, failure } = collectUsageLogPages(deps.fetchPage ?? spawnUsageLogPage(repoRoot));
  const totals = summarizeLlmUsageRows(lines, deps.configPricing ?? readLlmConfigPricing());
  const reconcile = deps.balance
    ? reconcileLlmCostVsBalance({
        measuredUsd: totals.measurableUsd,
        knownUsd: totals.knownUsd,
        partialUsd: totals.partialUsd,
        unmeasuredRows: totals.unknownRows,
        unmeasuredModels: totals.unknownModels,
        balanceBeforeUsd: deps.balance.beforeUsd,
        balanceAfterUsd: deps.balance.afterUsd,
        ...(deps.balance.provider ? { provider: deps.balance.provider } : {}),
      })
    : undefined;
  const summary: LlmCostLedgerSummary = {
    ...totals,
    incomplete,
    ...(failure ? { failure } : {}),
    ...(reconcile ? { reconcile } : {}),
  };
  // TOKEN-BURN-BY-SEAT(OP #132232 수정1): 새 깃발 없이 기본 출력에 자리 축을 포함한다.
  // 30분 카드에 그대로 붙여넣는 표 — summarizeUsageBySeat 와 formatUsageBySeatTable 재사용.
  const seatAxisText = formatUsageBySeatTable(summarizeUsageBySeat(lines, { configPricing: deps.configPricing ?? readLlmConfigPricing() }));
  summary.seatAxis = seatAxisText ? seatAxisText.split('\n') : [];
  // TOKEN-BURN-BY-SEAT JUD-3(OP #132677): 같은 자리 10분 100콜↑ — 카드 경보 줄 + 우편 1통(OP).
  const alerts = detectSeatRateAlerts(lines);
  if (alerts.length > 0) {
    summary.seatRateAlerts = alerts.map(formatSeatRateAlert);
    const mailId = postSeatRateAlertMail(summary.seatRateAlerts, repoRoot);
    if (mailId) summary.seatRateAlerts.push(mailId.startsWith('alert-mail-failed') ? mailId : `alert-mail ${mailId}`);
  }
  (deps.out ?? console.log)(formatLlmCostLedger(summary));
  return summary;
}

if (import.meta.main) {
  const balance = cliBalance(process.argv.slice(2));
  const summary = main(join(import.meta.dir, '..'), { ...(balance ? { balance } : {}) });
  if (summary.incomplete) process.exit(1);
}
