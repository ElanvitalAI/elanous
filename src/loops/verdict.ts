export type LoopCronVerdict = 'alive' | 'late' | 'failed' | 'off';

/** Shared display inputs for a graph loop or a cron job. The caller supplies
 * the cadence in milliseconds (or null when it is not known). */
export interface LoopCronVerdictInput {
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  intervalMs: number | null;
}

/** Pure health classification; a failed last execution takes precedence over age.
 * With no valid timestamp or positive cadence, lateness cannot be established. */
export function loopCronVerdict(entry: LoopCronVerdictInput, nowMs: number): LoopCronVerdict {
  if (!entry.enabled) return 'off';
  if (entry.lastStatus === 'failed' || entry.lastStatus === 'error' || entry.lastStatus === 'failure') return 'failed';
  const lastRunMs = entry.lastRunAt === null ? NaN : Date.parse(entry.lastRunAt);
  if (Number.isFinite(nowMs) && Number.isFinite(lastRunMs) &&
      entry.intervalMs !== null && Number.isFinite(entry.intervalMs) && entry.intervalMs > 0 &&
      nowMs - lastRunMs > 2 * entry.intervalMs) return 'late';
  return 'alive';
}
