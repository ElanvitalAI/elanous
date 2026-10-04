#!/usr/bin/env bun
/** Seven-day read-only measurement of self-implement Pod memory by goal kind. */
import { existsSync } from 'node:fs';
import { LogStore, logsDbPath, type LogStoreRow } from '../src/mss/logging/log-store.js';

export const GOAL_TYPES = ['test', 'code', 'pwa-build', 'docs'] as const;
export type GoalType = typeof GOAL_TYPES[number];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

type Observation = Pick<LogStoreRow, 'ts_ms' | 'event' | 'data' | 'category'>;
type Run = { type: GoalType | null; limit: string | null; peakMiB: number | null; samples: number; terminated: boolean; oomKilled: boolean };
type MemorySample = { cgroupBytes?: unknown };
export type MemoryMeasurement = {
  window: { since: string; until: string };
  sources: { logs: string; observations: number; samples: number; unclassifiedRuns: number; classification: 'goal-fields-or-space-id'; peakCoverage: 'recorded-samples-only' };
  byGoalType: Array<{ goalType: GoalType; runs: number; measured: number; missingPeak: number; samples: number; memoryLimits: Record<string, number>; terminations: number; oomKilled: number; peakMiB: { p50: number | null; p95: number | null; max: number | null } }>;
};

function payload(raw: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Infer only unambiguous kinds from free text; never turn an unknown title into code. */
export function goalTypeOf(description: string): GoalType | null {
  const kinds: GoalType[] = [];
  if (/\b(?:pwa|next\.js|frontend|front-end|web app)[-\s]+(?:build|compile|typecheck|bundle)\b/i.test(description)) kinds.push('pwa-build');
  if (/\b(?:test|tests|testing|spec|coverage|gate)\b/i.test(description) || /시험|테스트|검증/.test(description)) kinds.push('test');
  if (/\b(?:docs?|documentation|readme|manual|report)\b/i.test(description) || /문서|보고서/.test(description)) kinds.push('docs');
  if (/\b(?:implement|implementation|coding|code|cli)\b/i.test(description) || /구현|코드/.test(description)) kinds.push('code');
  return kinds.length === 1 ? kinds[0]! : null;
}

function recordedGoalType(data: Record<string, unknown>, spaceId: string): GoalType | null {
  if ('goalType' in data) return GOAL_TYPES.find((type) => type === data.goalType) ?? null;
  if ('goalKind' in data) return GOAL_TYPES.find((type) => type === data.goalKind) ?? null;
  const descriptions = [data.goalTitle, data.goalDescription, data.feature].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return descriptions.length ? goalTypeOf(descriptions.join(' ')) : goalTypeOf(spaceId);
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  return Math.round((sorted[low]! + (sorted[Math.ceil(index)]! - sorted[low]!) * (index - low)) * 100) / 100;
}

/** All rows are read before aggregation: log query's default 100-row limit is not a seven-day census. */
export function measurePodMemoryByGoal(rows: readonly Observation[], nowMs: number = Date.now(), logs = logsDbPath()): MemoryMeasurement {
  const sinceMs = nowMs - WEEK_MS;
  const windowRows = rows.filter((row) => row.ts_ms >= sinceMs && row.ts_ms <= nowMs && row.category === 'self-implement.pod');
  const runs = new Map<string, Run>();
  const jobToSpace = new Map<string, string>();
  let samples = 0;
  const ordered = [...windowRows].sort((a, b) => a.ts_ms - b.ts_ms);
  for (const row of ordered) {
    if (row.event !== 'memory-limit') continue;
    const data = payload(row.data);
    const id = typeof data.spaceId === 'string' ? data.spaceId : '';
    if (!id) continue;
    runs.set(id, { type: recordedGoalType(data, id), limit: typeof data.memoryLimit === 'string' ? data.memoryLimit : null,
      peakMiB: null, samples: 0, terminated: false, oomKilled: false });
  }
  for (const row of ordered) {
    const data = payload(row.data);
    const job = typeof data.job === 'string' ? data.job : '';
    const directId = typeof data.spaceId === 'string' ? data.spaceId : '';
    if (row.event === 'job-applied' && job && runs.has(directId)) jobToSpace.set(job, directId);
    const run = runs.get(directId || jobToSpace.get(job) || '');
    if (!run) continue;
    if (row.event === 'job-finished') {
      run.terminated = true;
      run.oomKilled ||= data.containerReason === 'OOMKilled';
    }
    if (row.event === 'oom-evidence') { run.terminated = true; run.oomKilled = true; }
    if (data.reason === 'OOMKilled') { run.terminated = true; run.oomKilled = true; }
    if (row.event !== 'oom-evidence' && row.event !== 'memory-last') continue;
    const rawSamples: unknown[] = row.event === 'oom-evidence' && Array.isArray(data.samples) ? data.samples : [data.sample];
    for (const raw of rawSamples) {
      const record = raw && typeof raw === 'object' ? raw as MemorySample : {};
      const bytes = record.cgroupBytes;
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) continue;
      const reading = bytes / MIB;
      run.peakMiB = Math.max(run.peakMiB ?? 0, reading);
      run.samples++;
      samples++;
    }
  }
  return {
    window: { since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString() },
    sources: { logs, observations: windowRows.length, samples, unclassifiedRuns: [...runs.values()].filter((run) => run.type === null).length,
      classification: 'goal-fields-or-space-id', peakCoverage: 'recorded-samples-only' },
    byGoalType: GOAL_TYPES.map((goalType) => {
      const group = [...runs.values()].filter((run) => run.type === goalType);
      const peaks = group.flatMap((run) => run.peakMiB === null ? [] : [run.peakMiB]).sort((a, b) => a - b);
      const memoryLimits: Record<string, number> = {};
      for (const run of group) if (run.limit) memoryLimits[run.limit] = (memoryLimits[run.limit] ?? 0) + 1;
      return { goalType, runs: group.length, measured: peaks.length, missingPeak: group.length - peaks.length,
        samples: group.reduce((count, run) => count + run.samples, 0), memoryLimits,
        terminations: group.filter((run) => run.terminated).length, oomKilled: group.filter((run) => run.oomKilled).length,
        peakMiB: { p50: percentile(peaks, 0.5), p95: percentile(peaks, 0.95), max: peaks.at(-1) ?? null } };
    }),
  };
}

export function readPodMemoryMeasurement(path: string = logsDbPath(), nowMs: number = Date.now()): MemoryMeasurement {
  if (!existsSync(path)) throw new Error(`log store not found: ${path}`);
  const store = LogStore.openReadOnly(path);
  try {
    return measurePodMemoryByGoal(store.queryAll({ exactCategories: ['self-implement.pod'], sinceMs: nowMs - WEEK_MS, untilMs: nowMs }), nowMs, path);
  } finally { store.close(); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = 'Usage: bun scripts/measure-pod-memory-by-goal.ts [--json] [--logs-db <existing-logs.db>] [--help]';
  const dbArg = args.indexOf('--logs-db');
  const db = dbArg === -1 ? logsDbPath() : args[dbArg + 1];
  if (!db || (dbArg !== -1 && (db.startsWith('--') || args.lastIndexOf('--logs-db') !== dbArg))
    || args.some((arg, index) => !['--json', '--help', '--logs-db'].includes(arg) && index !== dbArg + 1)) throw new Error(usage);
  if (args.includes('--help')) console.log(usage);
  else {
    const result = readPodMemoryMeasurement(db);
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else for (const group of result.byGoalType) console.log(`${group.goalType}: runs=${group.runs} measured=${group.measured} peak p50=${group.peakMiB.p50 ?? 'n/a'} MiB p95=${group.peakMiB.p95 ?? 'n/a'} MiB OOMKilled=${group.oomKilled}`);
  }
}
