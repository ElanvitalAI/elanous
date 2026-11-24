// TUI-STATUS-3ROW row 3 (대표 11-24 22:4x «LLM 현황은 왜 표시 안하나요? codex 계정들 현황과 openrouter 크레딧 잔액») —
// the LLM account snapshot the status rows draw.
//
// The TUI never asks a provider while it draws (els-always-lightweight · ~/.claude/statusline.sh model):
//   • `elanous usage status-cache` (a child process) runs the same collector as `elanous usage` and writes a compact
//     snapshot atomically to <state>/status/llm-usage.json;
//   • the TUI reads that file off the render path (a timer, never a paint) and keeps it in memory;
//   • when the file is older than LLM_USAGE_REFRESH_MS the TUI starts at most one refresh child — single flight in
//     this process, and a mkdir lock across processes (every seat runs a TUI). A lock older than 300 s is cleared.
//   • a refresh that fails only touches the file, so the next try waits out the same TTL (no retry storm), and the
//     snapshot keeps its own `ts`, so the row says «(stale)» once the numbers are older than 10 minutes.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import type { AccountUsageRow, UnifiedUsageReport } from '../../budget/types.js';

export interface LlmUsageAccount {
  readonly provider: AccountUsageRow['provider'];
  readonly account: string;
  /** Used share of the account's window (0–100); null = the provider did not say. */
  readonly usedPercent: number | null;
  /** Prepaid balance as shown (`$977.5`); only for balance accounts. */
  readonly left?: string;
  readonly leftUsd?: number;
  /** Time until the window refills (`3d 8h`); absent for prepaid balances or when unknown. */
  readonly resetsIn?: string;
  readonly status: 'ok' | 'error' | 'unknown';
}

export interface LlmUsageSnapshot {
  /** When the collector answered (epoch ms) — staleness is measured from here, not from the file time. */
  readonly ts: number;
  readonly accounts: readonly LlmUsageAccount[];
  /** The collector itself failed before any row (the file then has no accounts). */
  readonly error?: string;
}

// 출처: Claude's OAuth usage endpoint answers 429 at 5–10 minute intervals (src/budget/unified-usage.ts); 대표 statusline.sh
// keeps codex 1800 s and OpenRouter 600 s. 300 s keeps the row fresh without hammering any of them from every seat.
export const LLM_USAGE_REFRESH_MS = 300_000;
// 출처: 대표 11-24 row 3 spec — numbers older than 10 minutes are drawn with «(stale)».
export const LLM_USAGE_STALE_MS = 600_000;
// 출처: 대표 statusline.sh bg_refresh — a lock older than 300 s belongs to a dead refresher.
export const LLM_USAGE_LOCK_STALE_MS = 300_000;
// A refresh child that has not answered in this long is stopped (its lock is released with it).
const REFRESH_CHILD_TIMEOUT_MS = 90_000;
// How often the TUI looks at the file (a stat; the read happens only when the file changed).
const CHECK_INTERVAL_MS = 30_000;

/** <state>/status/llm-usage.json — ~/.elanous/status/llm-usage.json for the installed universe, the isolated root in tests. */
export function llmUsageCachePath(stateRoot: string = elanousStateRoot()): string {
  return join(stateRoot, 'status', 'llm-usage.json');
}

function windowResetsIn(endMs: number, nowMs: number): string | undefined {
  if (!Number.isFinite(endMs)) return undefined;
  const remain = endMs - nowMs;
  if (remain <= 0) return undefined;
  const hours = Math.floor(remain / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${Math.floor((remain % 3_600_000) / 60_000)}m`;
  return `${Math.max(1, Math.floor(remain / 60_000))}m`;
}

/** Fold the collector's report into the compact snapshot (no credentials, no notes — numbers and states only). */
export function llmUsageSnapshotFromReport(report: UnifiedUsageReport, nowMs: number): LlmUsageSnapshot {
  const accounts = report.rows.map((row): LlmUsageAccount => {
    const base = { provider: row.provider, account: row.accountName.replace(/[\x00-\x1f\x7f]/g, ' ') };
    const credits = row.credits;
    if (credits.status === 'error' || credits.status === 'unauthorized') return { ...base, usedPercent: null, status: 'error' };
    if (credits.status !== 'ok') return { ...base, usedPercent: null, status: 'unknown' };
    const used = credits.usedPercent !== null && Number.isFinite(credits.usedPercent) ? credits.usedPercent : null;
    if (credits.periodType === 'prepaid-usd') {
      const balance = credits.balance !== null && Number.isFinite(credits.balance) ? credits.balance : null;
      return balance === null
        ? { ...base, usedPercent: used, status: used === null ? 'unknown' : 'ok' }
        : { ...base, usedPercent: used, left: `$${balance}`, leftUsd: balance, status: 'ok' };
    }
    const subscriptionEnd = row.subscription.status === 'available' ? row.subscription.resetsAt : Number.NaN;
    const end = Number.isFinite(subscriptionEnd) ? subscriptionEnd : credits.periodEnd ? Date.parse(credits.periodEnd) : Number.NaN;
    const resetsIn = windowResetsIn(end, nowMs);
    return { ...base, usedPercent: used, ...(resetsIn ? { resetsIn } : {}), status: used === null ? 'unknown' : 'ok' };
  });
  return { ts: nowMs, accounts };
}

/** Write the snapshot so a reader never sees half a file: a sibling temp file, then a rename. */
export function writeLlmUsageSnapshot(path: string, snapshot: LlmUsageSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, 'utf8');
  renameSync(temp, path);
}

/** A failed refresh: keep the old numbers (their `ts` makes them stale in time) and only move the file time. */
export function markLlmUsageRefreshFailed(path: string, error: string, nowMs: number): void {
  if (existsSync(path)) {
    const at = new Date(nowMs);
    utimesSync(path, at, at);
    return;
  }
  writeLlmUsageSnapshot(path, { ts: nowMs, accounts: [], error });
}

const PROVIDERS = new Set(['codex', 'claude', 'grok', 'openrouter', 'zai']);

/** Parse the file; anything that is not a snapshot is null (the row is then not drawn). */
export function parseLlmUsageSnapshot(text: string): LlmUsageSnapshot | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const { ts, accounts, error } = value as Record<string, unknown>;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || !Array.isArray(accounts)) return null;
  const rows = accounts.filter((row): row is LlmUsageAccount => !!row && typeof row === 'object'
    && PROVIDERS.has((row as LlmUsageAccount).provider) && typeof (row as LlmUsageAccount).account === 'string'
    && ['ok', 'error', 'unknown'].includes((row as LlmUsageAccount).status));
  return { ts, accounts: rows, ...(typeof error === 'string' ? { error } : {}) };
}

export interface LlmUsageSourceDeps {
  readonly path?: string;
  readonly now?: () => number;
  /** Start the refresh child; resolve when it ends. Default: `elanous usage status-cache` of this install. */
  readonly runRefresh?: () => Promise<void>;
  readonly checkIntervalMs?: number;
}

export interface LlmUsageSource {
  /** The last snapshot read from the file (null = no file yet or unreadable). Never touches the disk. */
  current(): LlmUsageSnapshot | null;
  /** Start looking (after the first paint). */
  start(): void;
  stop(): void;
  /** One check now (tests; the timer calls the same). */
  check(): Promise<void>;
}

function mtimeOf(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/** Take the cross-process lock; clear a lock left by a dead refresher. */
export function acquireLlmUsageLock(lock: string, nowMs: number): boolean {
  try { mkdirSync(dirname(lock), { recursive: true }); mkdirSync(lock); return true; } catch { /* held */ }
  const at = mtimeOf(lock);
  if (at !== null && nowMs - at > LLM_USAGE_LOCK_STALE_MS) {
    try { rmdirSync(lock); } catch { /* another reader cleared it */ }
  }
  return false; // As in statusline.sh: a cleared stale lock is retaken on the next check, not now.
}

function defaultRunRefresh(): Promise<void> {
  return import('../../els/supervisor.js').then(({ elanousCommandFor }) => new Promise<void>((resolve) => {
    // The same build that draws the row writes its cache: this process's own entry first, the install's wrapper otherwise.
    const entry = process.argv[1];
    const command = [...(entry && existsSync(entry) ? [process.execPath, entry]
      : elanousCommandFor({ prefixEnv: process.env.ELANOUS_INSTALL_PREFIX, home: homedir(), exists: existsSync, execPath: process.execPath, entry })),
    'usage', 'status-cache'];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command[0]!, command.slice(1), { stdio: 'ignore', env: process.env });
    } catch { resolve(); return; }
    child.unref();
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, REFRESH_CHILD_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('exit', done);
    child.once('error', done);
  }));
}

export function createLlmUsageSource(options: { readonly onChange: () => void } & LlmUsageSourceDeps): LlmUsageSource {
  const path = options.path ?? llmUsageCachePath();
  const lock = `${path}.lock`;
  const now = options.now ?? Date.now;
  // A fake-LLM run (PTY tests, sims) never asks the real providers: it only reads whatever cache its state root has.
  const runRefresh = options.runRefresh ?? (process.env.ELANOUS_TEST_FAKE_LLM ? async () => {} : defaultRunRefresh);
  let snapshot: LlmUsageSnapshot | null = null;
  let readMtime: number | null = null;
  let refreshing = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const load = (): void => {
    const at = mtimeOf(path);
    if (at === null || at === readMtime) return;
    readMtime = at;
    let next: LlmUsageSnapshot | null;
    try { next = parseLlmUsageSnapshot(readFileSync(path, 'utf8')); } catch { next = null; }
    if (next === null) return;
    const changed = JSON.stringify(next) !== JSON.stringify(snapshot);
    snapshot = next;
    if (changed && !stopped) options.onChange();
  };

  const check = async (): Promise<void> => {
    if (stopped) return;
    load();
    const at = mtimeOf(path);
    if (refreshing || (at !== null && now() - at < LLM_USAGE_REFRESH_MS)) return;
    if (!acquireLlmUsageLock(lock, now())) return;
    refreshing = true;
    try {
      await runRefresh();
    } catch { /* judged below by the file time */ } finally {
      // A child that died, timed out or does not know the command wrote nothing: mark the try so the next one waits the
      // same TTL (no spawn every check), and the old numbers age into «(stale)».
      if (mtimeOf(path) === at) {
        try { markLlmUsageRefreshFailed(path, 'refresh wrote nothing', now()); } catch { /* read-only state root */ }
      }
      try { rmdirSync(lock); } catch { /* cleared as stale */ }
      refreshing = false;
    }
    if (!stopped) load();
  };

  return {
    current: () => snapshot,
    start: () => {
      if (timer || stopped) return;
      void check();
      timer = setInterval(() => { void check(); }, options.checkIntervalMs ?? CHECK_INTERVAL_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    stop: () => { stopped = true; if (timer) clearInterval(timer); },
    check,
  };
}
