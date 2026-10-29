#!/usr/bin/env bun
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function usageFromRow(row: Record<string, unknown>): LlmCostUsage | undefined {
  if (row._meta) return undefined;
  const nested = asRecord(row.data);
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
  const meta = asRecord(row._meta) ?? (row.type === 'log-query-limit' ? row : undefined);
  if (!meta || meta.type !== 'log-query-limit') return undefined;
  const nextCursors = asRecord(meta.nextCursors) as Record<string, number> | undefined;
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
    const rec = asRecord(parsed);
    if (!rec) {
      invalidOutput = true;
      continue;
    }
    const metaType = asRecord(rec._meta)?.type ?? rec.type;
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
    const rec = asRecord(parsed);
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
  (deps.out ?? console.log)(formatLlmCostLedger(summary));
  return summary;
}

if (import.meta.main) {
  const balance = cliBalance(process.argv.slice(2));
  const summary = main(join(import.meta.dir, '..'), { ...(balance ? { balance } : {}) });
  if (summary.incomplete) process.exit(1);
}
