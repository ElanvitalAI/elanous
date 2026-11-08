import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tools: BudgetStatus · BudgetHistory · BudgetForecast · BudgetSetLimit
//
// LLM-facing surface for the H6 P1 budget tracker. All four tools
// read from the same in-process `UsageStore` + `BudgetHistoryStore` +
// `LimitsStore` singletons that the dashboard bootstraps at startup.
// Each tool is cheap (no network on read · only `BudgetStatus` /
// `BudgetForecast` without `refresh=true` are strictly local).
//
// Output contract: `{ output: string; metadata: object; isError?: true }`
// · same as `skill-tool-market-quote.ts`. `output` is the human-
// readable summary the LLM embeds directly into its reply; `metadata`
// carries machine-readable fields for downstream dashboards /
// budget-aware policy routers.


import type {
  RateWindow,
  UsageProvider,
  UsageSnapshot,
  WindowKind,
} from '../../budget/types.js';
import { getLimitsStore } from '../../budget/limits.js';
import { getBudgetHistoryStore } from '../../budget/history-store.js';
import { getUsageStore } from '../../budget/usage-store.js';
import { forecastSnapshot } from '../../budget/forecaster.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeBrand(raw: unknown): UsageProvider | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  const valid: UsageProvider[] = ['codex', 'claude', 'gemini', 'local-llm'];
  return (valid as string[]).includes(normalized) ? (normalized as UsageProvider) : undefined;
}

function normalizeWindow(raw: unknown): WindowKind | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  const valid: WindowKind[] = ['session', 'weekly', 'monthly'];
  return (valid as string[]).includes(normalized) ? (normalized as WindowKind) : undefined;
}

function fmtPercent(p: number): string {
  return `${p.toFixed(1)}%`;
}

function fmtHoursFromNow(epochMs: number | null | undefined, now: number): string {
  if (!epochMs || epochMs <= 0) return '—';
  const deltaMs = epochMs - now;
  if (deltaMs <= 0) return 'now';
  const hours = deltaMs / (60 * 60 * 1000);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function pickWindows(
  snapshot: UsageSnapshot,
  window?: WindowKind,
): RateWindow[] {
  if (!window) return [...snapshot.windows];
  return snapshot.windows.filter((w) => w.kind === window);
}

// ─── BudgetStatus ────────────────────────────────────────────────────

export interface BudgetStatusArgs {
  brand?: UsageProvider;
  window?: WindowKind;
  refresh?: boolean;
}

export interface BudgetStatusRow {
  brand: UsageProvider;
  window: WindowKind;
  model?: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number;
  resetsInHours: number;
  source: UsageSnapshot['source'];
  fetchedAt: number;
}

export interface BudgetStatusResult {
  output: string;
  metadata: {
    snapshots: BudgetStatusRow[];
    errors?: Record<string, string>;
  };
  isError?: true;
}

export function buildBudgetStatusTool(): LLMToolSpec {
  return {
    name: 'BudgetStatus',
    description:
      'Return current per-brand/per-window usage for the local elanous budget tracker. Reads from in-process UsageStore; optional `refresh: true` runs every registered fetcher (~1-3s). For historical time-series use `BudgetHistory`; for pace-based prediction use `BudgetForecast`.',
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          enum: ['codex', 'claude', 'gemini', 'local-llm'],
          description: 'Filter to one brand. Omit for all.',
        },
        window: {
          type: 'string',
          enum: ['session', 'weekly', 'monthly'],
          description: 'Filter to one window kind.',
        },
        refresh: {
          type: 'boolean',
          description: 'When true, run registered fetchers before reading. Default false.',
        },
      },
      additionalProperties: false,
    },
  };
}

export async function dispatchBudgetStatus(
  rawArgs: Record<string, unknown>,
): Promise<BudgetStatusResult> {
  const args: BudgetStatusArgs = {
    ...(normalizeBrand(rawArgs.brand) ? { brand: normalizeBrand(rawArgs.brand)! } : {}),
    ...(normalizeWindow(rawArgs.window) ? { window: normalizeWindow(rawArgs.window)! } : {}),
    refresh: Boolean(rawArgs.refresh),
  };
  const store = getUsageStore();
  if (args.refresh) {
    await store.refresh(args.brand);
  }
  const now = Date.now();
  const brands: UsageProvider[] = args.brand ? [args.brand] : store.listProviders();
  const rows: BudgetStatusRow[] = [];
  const errors: Record<string, string> = {};
  for (const brand of brands) {
    const err = store.getError(brand);
    if (err) errors[brand] = err;
    const snapshot = store.getSnapshot(brand);
    if (!snapshot) continue;
    for (const win of pickWindows(snapshot, args.window)) {
      rows.push({
        brand: snapshot.provider,
        window: win.kind,
        ...(win.model ? { model: win.model } : {}),
        usedPercent: win.used,
        remainingPercent: win.remainingPercent,
        resetsAt: win.resetsAt,
        resetsInHours: win.resetsAt > 0 ? (win.resetsAt - now) / (60 * 60 * 1000) : 0,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt,
      });
    }
  }
  const output = formatStatusOutput(rows, errors, now);
  return {
    output,
    metadata: {
      snapshots: rows,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    },
  };
}

function formatStatusOutput(
  rows: BudgetStatusRow[],
  errors: Record<string, string>,
  now: number,
): string {
  if (rows.length === 0 && Object.keys(errors).length === 0) {
    return 'BudgetStatus: no snapshots available · register fetchers and call with refresh=true';
  }
  const lines: string[] = [];
  for (const row of rows) {
    const label = row.model ? `${row.brand}/${row.model}` : row.brand;
    lines.push(
      `${label} [${row.window}] used=${fmtPercent(row.usedPercent)} resets_in=${fmtHoursFromNow(row.resetsAt, now)} src=${row.source}`,
    );
  }
  for (const [brand, msg] of Object.entries(errors)) {
    lines.push(`${brand}: ERROR · ${msg}`);
  }
  return lines.join('\n');
}

// ─── BudgetHistory ───────────────────────────────────────────────────

export interface BudgetHistoryArgs {
  brand: UsageProvider;
  window?: WindowKind;
  days?: number;
  model?: string;
}

export interface BudgetHistoryPoint {
  at: number;
  tokens: number;
  costUsd: number;
}

export interface BudgetHistoryResult {
  output: string;
  metadata: {
    brand: UsageProvider;
    days: number;
    points: BudgetHistoryPoint[];
    aggregate: {
      turns: number;
      inputTokens: number;
      outputTokens: number;
      avgDailyTokens: number;
      peakDayTokens: number;
      costUsd: number;
    };
  };
  isError?: true;
}

export function buildBudgetHistoryTool(): LLMToolSpec {
  return {
    name: 'BudgetHistory',
    description:
      'Daily-rolled-up token history for one brand over the last `days` days (default 7). Reads from BudgetHistoryStore (SQLite local cache populated by the log-scan recorder).',
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          enum: ['codex', 'claude', 'gemini', 'local-llm'],
          description: 'Brand to roll up.',
        },
        window: {
          type: 'string',
          enum: ['session', 'weekly', 'monthly'],
          description: 'Present for future parity · Bundle 2 ignores (rolls up per day).',
        },
        days: {
          type: 'number',
          description: 'Lookback window in days. Default 7, max 56.',
        },
        model: {
          type: 'string',
          description: 'Optional filter by model (e.g. "opus" / "sonnet" / "gpt-5-codex").',
        },
      },
      required: ['brand'],
      additionalProperties: false,
    },
  };
}

export async function dispatchBudgetHistory(
  rawArgs: Record<string, unknown>,
): Promise<BudgetHistoryResult> {
  const brand = normalizeBrand(rawArgs.brand);
  if (!brand) {
    return errorResult(
      'BudgetHistory: `brand` required (codex/claude/gemini/local-llm)',
      {
        brand: 'codex',
        days: 0,
        points: [],
        aggregate: { turns: 0, inputTokens: 0, outputTokens: 0, avgDailyTokens: 0, peakDayTokens: 0, costUsd: 0 },
      },
    ) as BudgetHistoryResult;
  }
  const daysRaw = typeof rawArgs.days === 'number' ? rawArgs.days : 7;
  const days = Math.max(1, Math.min(56, Math.floor(daysRaw)));
  const model = typeof rawArgs.model === 'string' ? rawArgs.model : undefined;
  const now = Date.now();
  const fromMs = now - days * DAY_MS;
  const history = getBudgetHistoryStore();
  const turns = history.queryTurns({
    fromMs,
    toMs: now,
    provider: brand,
    ...(model ? { model } : {}),
  });
  const points = rollupPerDay(turns, fromMs, now);
  const agg = history.aggregate({
    fromMs,
    toMs: now,
    provider: brand,
    ...(model ? { model } : {}),
  });
  const totalTokens = agg.inputTokens + agg.outputTokens;
  const avgDailyTokens = days > 0 ? totalTokens / days : 0;
  const peakDayTokens = points.reduce((m, p) => Math.max(m, p.tokens), 0);
  const output = formatHistoryOutput(brand, days, points, {
    turns: agg.turns,
    totalTokens,
    avgDailyTokens,
    peakDayTokens,
  });
  return {
    output,
    metadata: {
      brand,
      days,
      points,
      aggregate: {
        turns: agg.turns,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        avgDailyTokens,
        peakDayTokens,
        costUsd: agg.costUsd,
      },
    },
  };
}

function rollupPerDay(
  turns: readonly { inputTokens: number; outputTokens: number; costUsd?: number; completedAt: number }[],
  fromMs: number,
  toMs: number,
): BudgetHistoryPoint[] {
  const fromDay = Math.floor(fromMs / DAY_MS);
  const toDay = Math.ceil(toMs / DAY_MS);
  const buckets = new Map<number, BudgetHistoryPoint>();
  for (let d = fromDay; d < toDay; d++) {
    buckets.set(d, { at: d * DAY_MS, tokens: 0, costUsd: 0 });
  }
  for (const t of turns) {
    const d = Math.floor(t.completedAt / DAY_MS);
    const bucket = buckets.get(d);
    if (!bucket) continue;
    const tokens = (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
    const replaced: BudgetHistoryPoint = {
      at: bucket.at,
      tokens: bucket.tokens + tokens,
      costUsd: bucket.costUsd + (t.costUsd ?? 0),
    };
    buckets.set(d, replaced);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

function formatHistoryOutput(
  brand: UsageProvider,
  days: number,
  points: readonly BudgetHistoryPoint[],
  agg: { turns: number; totalTokens: number; avgDailyTokens: number; peakDayTokens: number },
): string {
  const head = `BudgetHistory[${brand}] last=${days}d turns=${agg.turns} total_tokens=${agg.totalTokens} avg/day=${Math.round(agg.avgDailyTokens)} peak/day=${agg.peakDayTokens}`;
  if (points.length === 0) return head;
  const recent = points.slice(-7);
  const lines = recent.map((p) => {
    const day = new Date(p.at).toISOString().slice(0, 10);
    return `  ${day} tokens=${p.tokens}${p.costUsd > 0 ? ` cost=$${p.costUsd.toFixed(4)}` : ''}`;
  });
  return [head, ...lines].join('\n');
}

// ─── BudgetForecast ──────────────────────────────────────────────────

export interface BudgetForecastArgs {
  brand?: UsageProvider;
  window?: WindowKind;
}

export interface BudgetForecastRow {
  brand: UsageProvider;
  window: WindowKind;
  model?: string;
  currentUsedPercent: number;
  expectedUsedPercent: number;
  atCurrentPaceReachesLimitAt: number | null;
  recommendation: 'safe' | 'warn' | 'throttle';
}

export interface BudgetForecastResult {
  output: string;
  metadata: { forecasts: BudgetForecastRow[] };
  isError?: true;
}

export function buildBudgetForecastTool(): LLMToolSpec {
  return {
    name: 'BudgetForecast',
    description:
      'Project when each window would hit 100% at the current pace. Recommendation buckets: safe < 80% · warn 80-95% · throttle ≥ 95%. Pure read — does not refresh fetchers.',
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          enum: ['codex', 'claude', 'gemini', 'local-llm'],
          description: 'Filter to one brand. Omit for all.',
        },
        window: {
          type: 'string',
          enum: ['session', 'weekly', 'monthly'],
          description: 'Filter to one window kind.',
        },
      },
      additionalProperties: false,
    },
  };
}

export async function dispatchBudgetForecast(
  rawArgs: Record<string, unknown>,
): Promise<BudgetForecastResult> {
  const brand = normalizeBrand(rawArgs.brand);
  const window = normalizeWindow(rawArgs.window);
  const store = getUsageStore();
  const brands: UsageProvider[] = brand ? [brand] : store.listProviders();
  const rows: BudgetForecastRow[] = [];
  const now = Date.now();
  for (const b of brands) {
    const snap = store.getSnapshot(b);
    if (!snap) continue;
    for (const f of forecastSnapshot(snap)) {
      if (window && f.windowKind !== window) continue;
      rows.push({
        brand: b,
        window: f.windowKind,
        ...(f.model ? { model: f.model } : {}),
        currentUsedPercent: f.usedPercent,
        expectedUsedPercent: f.expectedUsedPercent,
        atCurrentPaceReachesLimitAt: f.atCurrentPaceReachesLimitAt,
        recommendation: f.recommendation,
      });
    }
  }
  const output = formatForecastOutput(rows, now);
  return {
    output,
    metadata: { forecasts: rows },
  };
}

function formatForecastOutput(rows: readonly BudgetForecastRow[], now: number): string {
  if (rows.length === 0) return 'BudgetForecast: no windows to forecast';
  return rows
    .map((r) => {
      const label = r.model ? `${r.brand}/${r.model}` : r.brand;
      return `${label} [${r.window}] used=${fmtPercent(r.currentUsedPercent)} expected=${fmtPercent(r.expectedUsedPercent)} eta=${fmtHoursFromNow(r.atCurrentPaceReachesLimitAt, now)} → ${r.recommendation}`;
    })
    .join('\n');
}

// ─── BudgetSetLimit ──────────────────────────────────────────────────

export interface BudgetSetLimitArgs {
  brand: UsageProvider;
  window: WindowKind;
  quota: number;
  model?: string;
}

export interface BudgetSetLimitResult {
  output: string;
  metadata: {
    saved: boolean;
    previousLimit?: number;
    limit?: {
      brand: UsageProvider;
      window: WindowKind;
      model?: string;
      quota: number;
      source: string;
    };
  };
  isError?: true;
}

export function buildBudgetSetLimitTool(): LLMToolSpec {
  return {
    name: 'BudgetSetLimit',
    description:
      'Write a user-config limit for (brand, window, model?). Pass quota in percent units (0-100) for parity with current RateWindow semantics. Persists to ~/.config/elanous/budget/limits.json.',
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          enum: ['codex', 'claude', 'gemini', 'local-llm'],
        },
        window: {
          type: 'string',
          enum: ['session', 'weekly', 'monthly'],
        },
        quota: {
          type: 'number',
          description: 'Percent-unit cap (0-100). Use Infinity for unlimited.',
        },
        model: {
          type: 'string',
          description: 'Optional model scope (e.g. "opus" / "sonnet" / "gpt-5-codex").',
        },
      },
      required: ['brand', 'window', 'quota'],
      additionalProperties: false,
    },
  };
}

export async function dispatchBudgetSetLimit(
  rawArgs: Record<string, unknown>,
): Promise<BudgetSetLimitResult> {
  const brand = normalizeBrand(rawArgs.brand);
  const window = normalizeWindow(rawArgs.window);
  const quotaRaw = typeof rawArgs.quota === 'number' ? rawArgs.quota : Number(rawArgs.quota);
  const model = typeof rawArgs.model === 'string' && rawArgs.model.trim().length > 0
    ? rawArgs.model.trim()
    : undefined;

  if (!brand) {
    return {
      output: 'BudgetSetLimit: `brand` required (codex/claude/gemini/local-llm)',
      metadata: { saved: false },
      isError: true,
    };
  }
  if (!window) {
    return {
      output: 'BudgetSetLimit: `window` required (session/weekly/monthly)',
      metadata: { saved: false },
      isError: true,
    };
  }
  if (!Number.isFinite(quotaRaw) && quotaRaw !== Number.POSITIVE_INFINITY) {
    return {
      output: 'BudgetSetLimit: `quota` must be a finite number (or Infinity)',
      metadata: { saved: false },
      isError: true,
    };
  }
  const limits = getLimitsStore();
  const prior = limits.getEffective(brand, window, model);
  try {
    const saved = limits.setUserLimit({
      brand,
      window,
      quota: quotaRaw,
      ...(model ? { model } : {}),
    });
    const label = model ? `${brand}/${model}` : brand;
    return {
      output: `BudgetSetLimit: saved ${label} [${window}] quota=${saved.quota} (prior=${prior?.quota ?? '—'})`,
      metadata: {
        saved: true,
        ...(prior ? { previousLimit: prior.quota } : {}),
        limit: {
          brand: saved.brand,
          window: saved.window,
          ...(saved.model ? { model: saved.model } : {}),
          quota: saved.quota,
          source: saved.source,
        },
      },
    };
  } catch (err) {
    return {
      output: `BudgetSetLimit: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { saved: false },
      isError: true,
    };
  }
}

// ─── Shared error shaping ────────────────────────────────────────────

function errorResult<M>(msg: string, metadata: M): { output: string; metadata: M; isError: true } {
  return { output: msg, metadata, isError: true };
}
