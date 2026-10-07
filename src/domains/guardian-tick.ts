import type { Database } from 'bun:sqlite';
import { fileURLToPath } from 'node:url';
import { debug } from '../debug/log.js';
import { calendarFields, resolveTimeZone } from '../time/format.js';
import { cronMatches } from './cron-match.js';
import { listScheduleRuns } from './schedule-runs.js';
import { listSchedules, openSchedulesDb, type ScheduleRow } from './schedule-registry.js';
import type { SpawnOutcome } from './schedule-runner.js';

export interface GuardianPlan {
  jobs: readonly (Pick<ScheduleRow, 'id' | 'cron' | 'enabled' | 'source' | 'run_via'> & Partial<Pick<ScheduleRow, 'command'>>)[];
  timeZone?: string;
}

export interface GuardianDeps {
  config?: { guardian?: { mode?: 'shadow' | 'live' } };
  /** Inject a cron-run-compatible executor in tests; shadow never calls it. */
  execute?: (command: string) => Promise<SpawnOutcome>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function matchedJobs(plan: GuardianPlan): GuardianPlan['jobs'] {
  return plan.jobs.filter(job => job.source === 'crontab' && job.run_via === 'crontab' && !!job.enabled && !!job.cron);
}

/** The wrapper prefix a live run may reuse as-is: `<bun> <…/>cron-run.ts --schedule-id <id> …` as the command's own
 * first program (cron-run honours --schedule-id only as argv[0]). Fail-closed: any other mention of cron-run.ts —
 * e.g. inside a `sh -c` body, behind `cd … &&`, or with shell control operators — is ambiguous and refused, so a run
 * can never be attributed to the wrong (or no) schedule id. Unwrapped commands are wrapped with this job's id. */
function liveCommand(jobId: string, raw: string): string {
  if (!/cron-run\.ts/.test(raw)) {
    return `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('../../scripts/cron-run.ts', import.meta.url)))} --schedule-id ${shellQuote(jobId)} --shell /bin/sh -c ${shellQuote(raw)}`;
  }
  // First program must be bun itself (bare `bun`, a path ending in /bun, or this process's executable).
  const prefix = /^\s*(?:'(?:[^']*\/)?bun'|(?:[^\s'"]*\/)?bun)\s+(?:'[^']*\/)?(?:[^\s'"]*\/)?cron-run\.ts'?\s+--schedule-id\s+(?:'([^']*)'|([^\s'"]+))(?:\s|$)/.exec(raw);
  const declaredId = prefix ? (prefix[1] ?? prefix[2]) : undefined;
  const controls = /[;&|`\n]|\$\(/.test(raw);
  if (declaredId !== jobId || controls || (raw.match(/cron-run\.ts/g) ?? []).length !== 1) {
    throw new Error(`guardian live job ${jobId}: cron-run --schedule-id is ${declaredId ?? 'missing'}${controls ? ' (shell control operators)' : ''} — refusing misattributed run`);
  }
  return raw;
}

/** One five-minute guardian observation. No schedule state or crontab is mutated in shadow mode. */
export async function guardianTick(now: Date, plan: GuardianPlan, deps: GuardianDeps = {}): Promise<{ mode: 'shadow' | 'live'; wouldRun: string[]; executed: number }> {
  if (!Number.isFinite(now.getTime())) throw new RangeError('invalid tick time');
  const mode = deps.config?.guardian?.mode === 'live' ? 'live' : 'shadow';
  const timeZone = plan.timeZone ?? resolveTimeZone().timeZone;
  const wouldRun: string[] = [];
  let executed = 0;
  for (const job of matchedJobs(plan)) {
    if (!cronMatches(job.cron!, now, { timeZone })) continue;
    wouldRun.push(job.id);
    debug.log('guardian.tick', 'would-run', { job: job.id, cron: job.cron });
    if (mode === 'live') {
      if (!job.command) throw new Error(`guardian live job has no command: ${job.id}`);
      const command = liveCommand(job.id, job.command);
      const execute = deps.execute ?? (await import('./schedule-runner.js')).defaultSpawnJob;
      const outcome = await execute(command);
      executed++;
      if (outcome.code !== 0) throw new Error(`guardian job ${job.id} exited ${outcome.code}`);
    }
  }
  return { mode, wouldRun, executed };
}

export interface GuardianDayDeps {
  db: Database;
  plan: GuardianPlan;
  /** Optional measured alert counts, keyed by stable schedule id. Absent means unmeasured, not zero. */
  alertsActual?: (jobId: string, day: string) => number | null;
}

export interface GuardianComparison {
  day: string;
  timeZone: string;
  jobs: Array<{ job: string; would: number; actual: number; alertsActual: number | null }>;
  diff: Array<{ job: string; would: number; actual: number; alertsActual: number | null }>;
  same: boolean;
  /** Jobs whose measured alert count differs from would. Empty when alerts are unmeasured. */
  alertDiff: Array<{ job: string; would: number; actual: number; alertsActual: number | null }>;
}

/** Count the 5-minute shadow ticks for a calendar day in the scheduler's time zone — using the CURRENT plan
 * (today's cron/enabled), so a past day is judged against the present schedule, not the one in force that day —
 * then compare actual fire history by stable id and instant (never by job name). */
export function guardianShadowDay(day: string, deps?: GuardianDayDeps): GuardianComparison {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))
    || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new RangeError('day must be a valid YYYY-MM-DD');
  }
  if (!deps) {
    const db = openSchedulesDb();
    try { return guardianShadowDay(day, { db, plan: { jobs: listSchedules(db) } }); }
    finally { db.close(); }
  }
  const timeZone = deps.plan.timeZone ?? resolveTimeZone().timeZone;
  const jobs = matchedJobs(deps.plan);
  const counts = new Map(jobs.map(job => [job.id, 0]));
  const date = Date.parse(`${day}T00:00:00Z`);
  // Bracket every possible IANA civil-day offset, including daylight-saving transitions.
  for (let ms = date - 14 * 3600_000; ms < date + 38 * 3600_000; ms += 5 * 60_000) {
    const at = new Date(ms);
    const fields = calendarFields(at, { timeZone });
    if (`${fields.year}-${String(fields.month).padStart(2, '0')}-${String(fields.day).padStart(2, '0')}` !== day) continue;
    for (const job of jobs) {
      if (cronMatches(job.cron!, at, { timeZone })) counts.set(job.id, counts.get(job.id)! + 1);
    }
  }
  const rows = jobs.map(job => {
    // schedule_runs retains only the latest 500 fires per id: older days can be incomplete.
    const runs = listScheduleRuns(deps.db, job.id, { limit: 500 });
    const actual = runs.filter(run => {
      const fields = calendarFields(new Date(run.fired_at), { timeZone });
      return `${fields.year}-${String(fields.month).padStart(2, '0')}-${String(fields.day).padStart(2, '0')}` === day;
    }).length;
    if (runs.length === 500 && runs.length > 0) {
      const oldest = calendarFields(new Date(runs[runs.length - 1]!.fired_at), { timeZone });
      const oldestDay = `${oldest.year}-${String(oldest.month).padStart(2, '0')}-${String(oldest.day).padStart(2, '0')}`;
      if (oldestDay >= day) throw new Error(`guardian comparison incomplete: schedule_runs history truncated for ${job.id} on ${day}`);
    }
    const alertsActual = deps.alertsActual?.(job.id, day) ?? null;
    if (alertsActual !== null && (!Number.isSafeInteger(alertsActual) || alertsActual < 0)) {
      throw new RangeError('alertsActual must be a non-negative integer or null');
    }
    return { job: job.id, would: counts.get(job.id)!, actual, alertsActual };
  });
  // `same` judges scheduled vs recorded fires only. Alert counts are a separate axis: unmeasured (null) by default,
  // and a measured mismatch is reported in alertDiff without changing the fire verdict.
  const diff = rows.filter(row => row.would !== row.actual);
  const same = diff.length === 0;
  const alertDiff = rows.filter(row => row.alertsActual !== null && row.would !== row.alertsActual);
  debug.log('guardian.compare', 'day', { same, diff, alertDiff });
  return { day, timeZone, jobs: rows, diff, same, alertDiff };
}
