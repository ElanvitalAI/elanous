import { cronMatches } from '../domains/cron-match.js';
import { resolveTimeZone } from '../time/time-zone.js';

/** Latest cron fire at or before `at` (minute resolution, scans back up to one year). */
export function previousLoopFire(cron: string, at: Date, timeZone: string = resolveTimeZone().timeZone): string | null {
  if (cron.trim().split(/\s+/).length !== 5) return null;
  let minute = Math.floor(at.getTime() / 60000) * 60000;
  for (let i = 0; i < 527040; i++, minute -= 60000) {
    if (cronMatches(cron, new Date(minute), { timeZone })) return new Date(minute).toISOString();
  }
  return null;
}

/** The fire before the latest scheduled fire — a run older than this has missed two scheduled fires. */
export function dueBefore(cron: string, now: Date, timeZone?: string): string | null {
  const latest = previousLoopFire(cron, now, timeZone);
  return latest ? previousLoopFire(cron, new Date(Date.parse(latest) - 60000), timeZone) : null;
}
