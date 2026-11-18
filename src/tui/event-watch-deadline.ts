/**
 * ELANOUS_EVENT_WATCH_DEADLINE_MS is a duration in milliseconds, not an absolute epoch.
 * A value such as 600000 means "ten minutes from now". Comparing that raw number to
 * Date.now() expires the watch on the first tick and kills the process group.
 * Missing, empty, zero, negative, and non-numeric values mean "no deadline".
 */

export function eventWatchDeadlineMs(raw: string | undefined, nowMs: number): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const durationMs = Number(trimmed);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return nowMs + durationMs;
}
