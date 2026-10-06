// `elanous usage outcomes` — 런 원장의 childProvider × 결과.
// provider 가 기록되지 않은 런은 «불명». 이름을 지어 세지 않는다.

import { readdirSync } from 'node:fs';
import {
  loadRunLedger,
  runLedgerDir,
  type RunLedgerEntry,
  type RunLedgerReader,
} from '../self-implement/run-ledger.js';

export const UNKNOWN_PROVIDER_LABEL = '불명';

export type OutcomeKind = 'landed' | 'draft' | 'failed' | 'open';

export interface ProviderOutcomeRow {
  readonly provider: string;
  readonly runs: number;
  readonly landed: number;
  readonly draft: number;
  readonly failed: number;
  readonly open: number;
  /** landed / runs. 런이 0이면 0. */
  readonly unattendedLandRate: number;
  readonly rounds: number;
  readonly blockReasons: Readonly<Record<string, number>>;
}

export interface UsageOutcomesReport {
  readonly sinceDays: number;
  readonly sinceMs: number;
  readonly rows: readonly ProviderOutcomeRow[];
  readonly unreadableLedgers: number;
}

export interface UsageOutcomesDeps {
  readonly dir?: string;
  readonly nowMs?: number;
  readonly list?: (path: string) => string[];
  readonly read?: RunLedgerReader;
  readonly load?: (runId: string, dir: string, read?: RunLedgerReader) => RunLedgerEntry[] | null;
}

const LEDGER_FILE = /\.jsonl$/;

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function entryMs(entry: RunLedgerEntry): number | undefined {
  if (!entry.timestamp) return undefined;
  const ms = Date.parse(entry.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 기록된 childProvider 만. 없거나 공백이면 «불명». */
export function providerLabel(entries: readonly RunLedgerEntry[]): string {
  const origin = entries.find((entry) => entry.event === 'run-origin');
  const recorded = origin ? stringField(origin.data, 'childProvider') : undefined;
  return recorded ?? UNKNOWN_PROVIDER_LABEL;
}

function blockReason(entry: RunLedgerEntry): string | undefined {
  return stringField(entry.data, 'stopReason')
    ?? stringField(entry.data, 'reason')
    ?? stringField(entry.data, 'verdict')
    ?? stringField(entry.data, 'error');
}

interface ClassifiedRun {
  readonly provider: string;
  readonly outcome: OutcomeKind;
  readonly rounds: number;
  readonly blockReason?: string;
  readonly atMs: number;
}

export function classifyLedgerRun(entries: readonly RunLedgerEntry[], nowMs: number): ClassifiedRun | null {
  if (entries.length === 0) return null;
  const times = entries.map(entryMs).filter((ms): ms is number => ms !== undefined);
  const atMs = times.length > 0 ? Math.max(...times) : nowMs;
  const rounds = new Set(
    entries
      .map((entry) => entry.data.round)
      .filter((round): round is number => typeof round === 'number' && Number.isFinite(round)),
  ).size;
  const merged = [...entries].reverse().find((entry) => entry.event === 'merged' && entry.data.merged === true);
  const drafted = [...entries].reverse().find((entry) => entry.event === 'pr-opened' && entry.data.draft !== false);
  const failed = [...entries].reverse().find((entry) => entry.event === 'failed' || entry.event === 'run-status' && (entry.data.runStatus === 'failed' || entry.data.runStatus === 'stopped'));
  const outcome: OutcomeKind = merged ? 'landed' : drafted ? 'draft' : failed ? 'failed' : 'open';
  const reason = outcome === 'failed' || outcome === 'open'
    ? (failed ? blockReason(failed) : undefined)
      ?? entries.map(blockReason).reverse().find((value) => value !== undefined)
    : undefined;
  return {
    provider: providerLabel(entries),
    outcome,
    rounds,
    ...(reason ? { blockReason: reason } : {}),
    atMs,
  };
}

export function aggregateUsageOutcomes(
  runs: readonly ClassifiedRun[],
  sinceDays: number,
  sinceMs: number,
  unreadableLedgers = 0,
): UsageOutcomesReport {
  const byProvider = new Map<string, {
    runs: number;
    landed: number;
    draft: number;
    failed: number;
    open: number;
    rounds: number;
    blockReasons: Record<string, number>;
  }>();
  for (const run of runs) {
    const row = byProvider.get(run.provider) ?? {
      runs: 0, landed: 0, draft: 0, failed: 0, open: 0, rounds: 0, blockReasons: {},
    };
    row.runs += 1;
    row[run.outcome] += 1;
    row.rounds += run.rounds;
    if (run.blockReason && run.outcome !== 'landed' && run.outcome !== 'draft') {
      row.blockReasons[run.blockReason] = (row.blockReasons[run.blockReason] ?? 0) + 1;
    }
    byProvider.set(run.provider, row);
  }
  const rows = [...byProvider.entries()]
    .map(([provider, row]): ProviderOutcomeRow => ({
      provider,
      ...row,
      unattendedLandRate: row.runs === 0 ? 0 : row.landed / row.runs,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider, 'en'));
  return { sinceDays, sinceMs, rows, unreadableLedgers };
}

export function queryUsageOutcomes(sinceDays: number, deps: UsageOutcomesDeps = {}): UsageOutcomesReport {
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : 2;
  const nowMs = deps.nowMs ?? Date.now();
  const sinceMs = nowMs - days * 24 * 60 * 60 * 1000;
  const dir = deps.dir ?? runLedgerDir();
  const list = deps.list ?? readdirSync;
  const load = deps.load ?? loadRunLedger;
  let names: string[];
  try {
    names = list(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return aggregateUsageOutcomes([], days, sinceMs, 0);
    }
    throw error;
  }
  const runs: ClassifiedRun[] = [];
  let unreadableLedgers = 0;
  for (const name of names) {
    if (!LEDGER_FILE.test(name)) continue;
    const runId = name.slice(0, -'.jsonl'.length);
    let ledger: RunLedgerEntry[] | null;
    try {
      ledger = load(runId, dir, deps.read);
    } catch {
      unreadableLedgers += 1;
      continue;
    }
    if (!ledger) {
      unreadableLedgers += 1;
      continue;
    }
    const classified = classifyLedgerRun(ledger, nowMs);
    if (!classified || classified.atMs < sinceMs) continue;
    runs.push(classified);
  }
  return aggregateUsageOutcomes(runs, days, sinceMs, unreadableLedgers);
}

export function formatUsageOutcomes(report: UsageOutcomesReport): string {
  const header = `최근 ${report.sinceDays}일 · 런 원장 childProvider × 결과`;
  const verdict = outcomeTableHasCodexGrokUnknown(report)
    ? '판정: codex·grok·불명'
    : '판정: codex·grok·불명 아님';
  if (report.rows.length === 0) return `${header}\n${verdict}\n(해당 런 없음)`;
  const lines = [header, verdict, 'provider  runs  landed  draft  failed  open  landRate  rounds  blockReasons'];
  for (const row of report.rows) {
    const reasons = Object.entries(row.blockReasons)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(',');
    const rate = `${Math.round(row.unattendedLandRate * 1000) / 10}%`;
    lines.push(`${row.provider}  ${row.runs}  ${row.landed}  ${row.draft}  ${row.failed}  ${row.open}  ${rate}  ${row.rounds}  ${reasons || '-'}`);
  }
  if (report.unreadableLedgers > 0) lines.push(`unreadable ledgers: ${report.unreadableLedgers}`);
  return lines.join('\n');
}

/** 판정이 요구하는 최근 이틀 표에 codex·grok·불명 세 줄이 있는지. */
export function outcomeTableHasCodexGrokUnknown(report: UsageOutcomesReport): boolean {
  const names = new Set(report.rows.map((row) => row.provider));
  return names.has('codex') && names.has('grok') && names.has(UNKNOWN_PROVIDER_LABEL) && report.rows.length >= 3;
}
