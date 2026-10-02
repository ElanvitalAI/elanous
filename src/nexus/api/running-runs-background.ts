// The terminals list must answer at once and must never share the event loop with a ledger scan: the running-runs query
// reads every run ledger synchronously (~5k files · 0.9–1.8 s on 10-02), which froze typing in the web terminal while the
// PWA polled the list. This keeps the last result as a snapshot and refreshes it in a separate bun process, on demand.
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import type { RunningRunsResult } from '../../self-implement/running-runs.js';

export const RUNNING_RUNS_REFRESH_MS = 15_000;
/** A refresh that has not answered by then is abandoned; the next request starts another. */
export const RUNNING_RUNS_REFRESH_TIMEOUT_MS = 60_000;

export interface RunningRunsSnapshot {
  /** Last result, or null before the first refresh finished (subjects then keep unknown assessments). */
  readonly result: RunningRunsResult | null;
  /** Milliseconds since `result` was computed; null when there is none. */
  readonly ageMs: number | null;
}

/** Runs the query somewhere other than this event loop and resolves with its JSON output. */
export type RunningRunsRunner = (includeTest: boolean) => Promise<RunningRunsResult>;

export const RUNNING_RUNS_CHILD_SCRIPT = join(import.meta.dir, 'running-runs-child.ts');

/** Default runner: `bun running-runs-child.ts [--include-test]` — the child does the ledger I/O, we only parse its stdout. */
export const childProcessRunner: RunningRunsRunner = async (includeTest) => {
  const proc = Bun.spawn([process.execPath, RUNNING_RUNS_CHILD_SCRIPT, ...(includeTest ? ['--include-test'] : [])], {
    stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: process.env,
  });
  const timer = setTimeout(() => proc.kill(), RUNNING_RUNS_REFRESH_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`running-runs child exit ${code}`);
    return JSON.parse(out) as RunningRunsResult;
  } finally { clearTimeout(timer); }
};

export interface RunningRunsBackground {
  /** Never blocks: returns the last snapshot and starts a refresh when it is stale and none is in flight. */
  snapshot(options: { includeTest?: boolean }): RunningRunsSnapshot;
}

export function createRunningRunsBackground(runner: RunningRunsRunner = childProcessRunner, now: () => number = Date.now, refreshMs = RUNNING_RUNS_REFRESH_MS): RunningRunsBackground {
  const slots = new Map<boolean, { at: number; result: RunningRunsResult }>();
  const flights = new Set<boolean>();
  const refresh = (includeTest: boolean): void => {
    if (flights.has(includeTest)) return;
    flights.add(includeTest);
    const started = now();
    void runner(includeTest)
      .then((result) => {
        slots.set(includeTest, { at: now(), result });
        debug.log('nexus.terminals', 'running-runs-refreshed', { includeTest, ms: now() - started });
      })
      .catch((error: unknown) => {
        debug.log('nexus.terminals', 'running-runs-refresh-failed', { includeTest, reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' });
      })
      .finally(() => { flights.delete(includeTest); });
  };
  return {
    snapshot(options) {
      const includeTest = options.includeTest === true;
      const slot = slots.get(includeTest);
      const t = now();
      if (!slot || t - slot.at >= refreshMs) refresh(includeTest);
      return slot ? { result: slot.result, ageMs: t - slot.at } : { result: null, ageMs: null };
    },
  };
}
