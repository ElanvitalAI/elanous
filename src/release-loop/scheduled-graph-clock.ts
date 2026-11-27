import type { ReleaseClock } from './release-graph-exec.js';
import { utcIso } from './release-schedule.js';

/** Fail closed: no clock may be inferred from another schedule field. */
export function scheduledGraphClock(input: {
  rehearsalAt?: unknown; cutAt?: unknown; publishAt?: unknown;
}): { ok: true; clock: ReleaseClock } | { ok: false; reason: string } {
  const clock: Partial<ReleaseClock> = {};
  for (const field of ['rehearsalAt', 'cutAt', 'publishAt'] as const) {
    const value = input[field];
    if (typeof value !== 'string') return { ok: false, reason: `${field} is missing or invalid` };
    try { clock[field] = utcIso(value); }
    catch { return { ok: false, reason: `${field} is missing or invalid` }; }
  }
  if (Date.parse(clock.rehearsalAt!) >= Date.parse(clock.cutAt!) || Date.parse(clock.cutAt!) >= Date.parse(clock.publishAt!)) {
    return { ok: false, reason: 'expected rehearsalAt < cutAt < publishAt' };
  }
  return { ok: true, clock: clock as ReleaseClock };
}
