// LOOPCHECK-FENCE (0.2.20): an hq-fence cron execution is one process, not a loop.
// Each wrapped run leaves its rc in a per-role streak file; the wrapper's owner alert
// raises a seat request only when the same role failed in consecutive runs, keyed per
// role so the seat request journal holds at most one `loopcheck:hq-fence:<role>` per day.
// No loops/ import here: hq.ts records through this module and loops/registry imports hq.ts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';

/** The role is the file name; `lastAt` is shown in the owner alert so TC sees when the streak last grew. */
export interface FenceOutcome { consecutiveFailures: number; lastRc: number; lastAt: string }

/** Two failures in a row: one rc=1 from a job that recovers on the next fire is not a fence fault. */
export const FENCE_FAILURE_STREAK = 2;

const safeRole = (role: string): string => role.replace(/[^\w.-]/g, '_') || 'unknown';

export function fenceOutcomePath(dir: string, role: string): string {
  return join(dir, `${safeRole(role)}.json`);
}

/** Default directory next to the host-local lease view (`<config>/hq/fence-outcomes`). */
export function fenceOutcomeDir(localPath: string): string {
  return join(dirname(localPath), 'fence-outcomes');
}

export function readFenceOutcome(dir: string, role: string): FenceOutcome | null {
  try {
    const parsed = JSON.parse(readFileSync(fenceOutcomePath(dir, role), 'utf8')) as Partial<FenceOutcome>;
    return typeof parsed.consecutiveFailures === 'number' ? parsed as FenceOutcome : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    debug.log('hq.fence-outcome', 'read-failed', { role, error: String(error) });
    return null;
  }
}

/** rc 0 resets the streak; any other rc extends it. A skipped (not-holder) run is not recorded.
 * Overlapping runs of one role serialize the read-modify-write on an SQLite lock (released even on SIGKILL). */
export function recordFenceOutcome(dir: string, role: string, rc: number, now: Date = new Date()): FenceOutcome {
  const path = fenceOutcomePath(dir, role);
  mkdirSync(dirname(path), { recursive: true });
  const lock = new Database(`${path}.lock.sqlite`);
  try {
    lock.exec('PRAGMA busy_timeout = 10000');
    lock.exec('BEGIN EXCLUSIVE');
    try {
      const previous = readFenceOutcome(dir, role);
      const outcome: FenceOutcome = { consecutiveFailures: rc === 0 ? 0 : (previous?.consecutiveFailures ?? 0) + 1, lastRc: rc, lastAt: now.toISOString() };
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(outcome));
      renameSync(tmp, path);
      lock.exec('COMMIT');
      return outcome;
    } catch (error) { lock.exec('ROLLBACK'); throw error; }
  } finally { lock.close(); }
}

/** `hq-fence: fence failed (rc=1, role=seat-loop)` → `seat-loop`; other wrapper reasons have no role. */
export function fenceAlertRole(reason: string): string | null {
  return /\brole=([\w.-]+)/.exec(reason)?.[1] ?? null;
}
