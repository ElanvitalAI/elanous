// Node-catalog v2 (2026-05-11) — schedule entry tick.
//
// Given a registry of schedule entries + a `runWorkflow` callback,
// `startScheduler` registers a timer per entry:
//   - `interval` entries → `setInterval` (test-injectable).
//   - `cron` entries     → `node-cron` (scheduler-retirement R2).
// Invalid entries fall into `skipped` with a human-readable reason.

import cron from 'node-cron';
import type { ScheduleEntry } from './registry.js';
import { resolveTimeZone } from '../../time/format.js';
import '../../user-config.js'; // Standalone cron entry registers the config timezone source.

export interface CronTaskLike {
  stop: () => void;
}

export interface SchedulerHandle {
  /** Cancel every active timer. Idempotent. */
  stop: () => void;
  /** Count of active interval timers + cron tasks. */
  active: number;
  /** Count of active interval timers (cron entries excluded). */
  activeIntervals: number;
  /** Count of active cron tasks. */
  activeCrons: number;
  /** Entries that could not be scheduled (invalid pattern, sub-min
   *  interval, unknown type). Surfaced so callers can warn the user. */
  skipped: Array<{ entry: ScheduleEntry; reason: string }>;
  /** V2.2-7 (2026-05-11) — register a new entry after `startScheduler`
   *  returns. The TOX→workflow-runtime bridge (`task-to-workflow.ts`)
   *  calls this so newly-created tasks with a `scheduleText` start
   *  firing immediately without restarting the daemon. The same
   *  rejection rules apply as boot-time entries (sub-min interval ·
   *  empty/invalid cron · unknown type fall into `skipped`). */
  add: (entry: ScheduleEntry) => void;
}

export type IntervalHandle = ReturnType<typeof globalThis.setInterval>;
export interface SchedulerOpts {
  registry: ScheduleEntry[];
  /** Invoked when a tick fires. Caller owns the workflow run
   *  (e.g. via `runWorkflow` with the workflow definition + a fresh
   *  runId). */
  runWorkflow: (entry: ScheduleEntry) => void | Promise<void>;
  /** Inject for tests so we can use a fake timer. Defaults to globalThis.setInterval. */
  setInterval?: (cb: () => void, ms: number) => IntervalHandle;
  /** Inject for tests. Defaults to globalThis.clearInterval. */
  clearInterval?: (handle: IntervalHandle) => void;
  /** Inject for tests so we can avoid real cron wall-clock waits.
   *  Defaults to `node-cron`. Must return an object with `stop()`. */
  cronSchedule?: (expr: string, cb: () => void) => CronTaskLike;
}

const MIN_INTERVAL_MS = 1_000;

/** Start every schedule entry. Returns a handle so the caller can stop
 *  all timers + cron tasks (e.g. on daemon shutdown). */
export function startScheduler(opts: SchedulerOpts): SchedulerHandle {
  const setIntervalFn: (cb: () => void, ms: number) => IntervalHandle =
    opts.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as IntervalHandle);
  const clearIntervalFn: (handle: IntervalHandle) => void =
    opts.clearInterval ?? ((h) => globalThis.clearInterval(h));
  // 2026-07-24 — 발화 시간대 명시(domains/schedule-runner.ts 와 동일 계약).
  // 옵션을 안 넘기면 node-cron 이 프로세스 주변 TZ 를 쓰는데, launchd 데몬은 `TZ` 를
  // 물려받지 못해 환경에 따라 조용히 밀린다. 계약: src/time/format.ts
  const timeZone = resolveTimeZone().timeZone;
  const cronScheduleFn: (expr: string, cb: () => void) => CronTaskLike =
    opts.cronSchedule
    ?? ((expr, cb) => cron.schedule(expr, cb, { timezone: timeZone }) as unknown as CronTaskLike);

  const handles: IntervalHandle[] = [];
  const cronTasks: CronTaskLike[] = [];
  const skipped: Array<{ entry: ScheduleEntry; reason: string }> = [];

  /** Internal: register a single entry. Used by the boot loop below
   *  and by the dynamic `handle.add()` path. Mutates `handles` /
   *  `cronTasks` / `skipped`. */
  function registerEntry(entry: ScheduleEntry): void {
    if (entry.trigger.type === 'interval') {
      const ms = entry.trigger.interval ?? 0;
      if (ms < MIN_INTERVAL_MS) {
        skipped.push({
          entry,
          reason: `interval ${ms}ms below minimum ${MIN_INTERVAL_MS}ms`,
        });
        return;
      }
      const h = setIntervalFn(() => {
        void opts.runWorkflow(entry);
      }, ms);
      handles.push(h);
    } else if (entry.trigger.type === 'cron') {
      const expr = entry.trigger.cron;
      if (typeof expr !== 'string' || expr.trim() === '') {
        skipped.push({ entry, reason: 'cron expression is empty' });
        return;
      }
      if (!cron.validate(expr)) {
        skipped.push({ entry, reason: `invalid cron expression '${expr}'` });
        return;
      }
      const task = cronScheduleFn(expr, () => {
        void opts.runWorkflow(entry);
      });
      cronTasks.push(task);
    } else {
      skipped.push({
        entry,
        reason: `unknown schedule type '${(entry.trigger as { type?: string }).type ?? '(missing)'}'`,
      });
    }
  }

  for (const entry of opts.registry) registerEntry(entry);

  const handle: SchedulerHandle = {
    get active() {
      return handles.length + cronTasks.length;
    },
    get activeIntervals() {
      return handles.length;
    },
    get activeCrons() {
      return cronTasks.length;
    },
    skipped,
    add: registerEntry,
    stop: () => {
      while (handles.length > 0) {
        const h = handles.pop();
        if (h) clearIntervalFn(h);
      }
      while (cronTasks.length > 0) {
        const t = cronTasks.pop();
        if (t) t.stop();
      }
    },
  };
  return handle;
}
