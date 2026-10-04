export type LoopCronVerdict = 'alive' | 'late' | 'failed' | 'off';

/** Shared display inputs for a graph loop or cron job. Fixed intervals use
 * milliseconds; calendar cron schedules supply the second actual due instant. */
export interface LoopCronVerdictInput {
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  intervalMs: number | null;
  /** Second scheduled execution after the last run, for calendar-based cron schedules. */
  secondDueAt?: string | null;
  /** Cron-aware daemon state (src/domains/schedule-state.ts). Callers pass it for cron schedules only —
   *  a fixed interval keeps its own «2× interval» rule (review must-fix: stale must not override an interval). */
  scheduleState?: 'live' | 'firing' | 'stale' | 'off';
}

/** Pure health classification; a failed last execution takes precedence over age.
 * Without a valid last run and a cadence/due instant, lateness needs the daemon stale signal. */
export function loopCronVerdict(entry: LoopCronVerdictInput, nowMs: number): LoopCronVerdict {
  if (!entry.enabled || entry.scheduleState === 'off') return 'off';
  if (entry.lastStatus === 'failed' || entry.lastStatus === 'error' || entry.lastStatus === 'failure' ||
      entry.lastStatus === 'abandoned' || entry.lastStatus === 'expired') return 'failed';
  if (entry.scheduleState === 'stale') return 'late';
  const lastRunMs = entry.lastRunAt === null ? NaN : Date.parse(entry.lastRunAt);
  if (entry.secondDueAt !== undefined) {
    const secondDueMs = entry.secondDueAt === null ? NaN : Date.parse(entry.secondDueAt);
    return Number.isFinite(lastRunMs) && Number.isFinite(nowMs) &&
      Number.isFinite(secondDueMs) && secondDueMs > lastRunMs && nowMs > secondDueMs ? 'late' : 'alive';
  }
  if (Number.isFinite(nowMs) && Number.isFinite(lastRunMs) &&
      entry.intervalMs !== null && Number.isFinite(entry.intervalMs) && entry.intervalMs > 0 &&
      nowMs - lastRunMs > 2 * entry.intervalMs) return 'late';
  return 'alive';
}
