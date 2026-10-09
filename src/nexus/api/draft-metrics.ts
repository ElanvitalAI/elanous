import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import type { DraftMetrics, OverlapMetrics } from '../../self-dev/draft-sweep.js';

export type CeoDraftMetrics = DraftMetrics & { readonly overlap: OverlapMetrics | null };

/**
 * DRAFT-METRIC — CEO view source. Opening the page must never trigger a GitHub read:
 * `read()` answers from memory and at most one background collection runs at a time,
 * no more often than the TTL (or the failure back-off). The collection itself is
 * `elanous harness drafts metrics --json` in a child process, which reads PR evidence
 * through the batched GraphQL path (#24918) — one call per 40 drafts, no per-draft comments call.
 */
export type DraftMetricsState = 'measuring' | 'ready' | 'unavailable';

export interface DraftMetricsSnapshot {
  /** measuring = no value yet and a collection is running · unavailable = no value and the last collection failed. */
  readonly state: DraftMetricsState;
  readonly metrics: CeoDraftMetrics | null;
  /** When the served value was collected (ISO). null without a value. */
  readonly measuredAt: string | null;
  /** A background collection is in flight. */
  readonly refreshing: boolean;
  /** Last collection failure; with a value it means the value is older than intended. */
  readonly reason: string | null;
}

export interface DraftMetricsSourceOptions {
  readonly collect?: () => Promise<CeoDraftMetrics>;
  readonly ttlMs?: number;
  readonly failureRetryMs?: number;
  readonly now?: () => number;
}

export const DRAFT_METRICS_TTL_MS = 10 * 60_000;
export const DRAFT_METRICS_FAILURE_RETRY_MS = 2 * 60_000;
const COLLECT_TIMEOUT_MS = 5 * 60_000;

function isMetrics(value: unknown): value is DraftMetrics {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const count = (key: string) => Number.isInteger(row[key]) && (row[key] as number) >= 0;
  const nullableNumber = (key: string) => row[key] === null || (typeof row[key] === 'number' && Number.isFinite(row[key]));
  return count('inventory') && count('needsOwner') && count('converted48h') && count('cohort48h')
    && nullableNumber('oldestAgeHours') && nullableNumber('conversion48h');
}

function isOverlapMetrics(value: unknown): value is OverlapMetrics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const count = (key: string) => row[key] === null || (Number.isInteger(row[key]) && (row[key] as number) >= 0);
  const nullableNumber = (key: string) => row[key] === null || (typeof row[key] === 'number' && Number.isFinite(row[key]) && (row[key] as number) >= 0);
  return ['launches24h', 'launched', 'unmeasured', 'linked', 'autoLanded', 'salvaged', 'salvageUnmeasured'].every(count)
    && typeof row.sourceIncomplete === 'boolean' && nullableNumber('secondSiblingMedianHours')
    && (row.autoRate === null || (typeof row.autoRate === 'number' && Number.isFinite(row.autoRate) && row.autoRate >= 0 && row.autoRate <= 1));
}

/** Parses the CLI's single JSON line; malformed draft values fail, malformed overlap is unmeasured. */
export function parseDraftMetricsOutput(stdout: string): CeoDraftMetrics {
  const line = stdout.trim().split('\n').reverse().find((text) => text.trim().startsWith('{'));
  if (!line) throw new Error('draft metrics: no JSON output');
  const parsed: unknown = JSON.parse(line);
  if (!isMetrics(parsed)) throw new Error('draft metrics: malformed output');
  const { inventory, oldestAgeHours, needsOwner, converted48h, cohort48h, conversion48h } = parsed;
  const candidate = (parsed as DraftMetrics & { overlap?: unknown }).overlap;
  return { inventory, oldestAgeHours, needsOwner, converted48h, cohort48h, conversion48h,
    overlap: isOverlapMetrics(candidate) ? candidate : null };
}

async function collectViaCli(): Promise<CeoDraftMetrics> {
  const root = join(import.meta.dir, '../../..');
  const proc = Bun.spawn(['bun', join(root, 'bin/elanous.mjs'), 'harness', 'drafts', 'metrics', '--json'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), COLLECT_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(stderr.trim().split('\n').at(-1) || `draft metrics exited ${exitCode}`);
    return parseDraftMetricsOutput(stdout);
  } finally { clearTimeout(timer); }
}

export interface DraftMetricsSource {
  read(): DraftMetricsSnapshot;
}

export function createDraftMetricsSource(options: DraftMetricsSourceOptions = {}): DraftMetricsSource {
  const collect = options.collect ?? collectViaCli;
  const ttl = options.ttlMs ?? DRAFT_METRICS_TTL_MS;
  const retry = options.failureRetryMs ?? DRAFT_METRICS_FAILURE_RETRY_MS;
  const now = options.now ?? Date.now;
  let value: { metrics: CeoDraftMetrics; at: number } | null = null;
  let failure: { reason: string; at: number } | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): void => {
    if (inFlight) return;
    const started = now();
    inFlight = (async () => {
      try {
        const metrics = await collect();
        value = { metrics, at: now() };
        failure = null;
        try { debug.log('nexus.draft-metrics', 'collected', { ms: now() - started, inventory: metrics.inventory }); } catch { /* fail-soft */ }
      } catch (error) {
        failure = { reason: error instanceof Error ? error.message : String(error), at: now() };
        try { debug.log('nexus.draft-metrics', 'failed', { ms: now() - started, reason: failure.reason }); } catch { /* fail-soft */ }
      } finally { inFlight = null; }
    })();
  };

  return {
    read() {
      const clock = now();
      const due = failure && (!value || failure.at >= value.at)
        ? clock - failure.at >= retry
        : !value || clock - value.at >= ttl;
      if (due) refresh();
      return {
        state: value ? 'ready' : failure && !inFlight ? 'unavailable' : 'measuring',
        metrics: value?.metrics ?? null,
        measuredAt: value ? new Date(value.at).toISOString() : null,
        refreshing: inFlight !== null,
        reason: failure?.reason ?? null,
      };
    },
  };
}
