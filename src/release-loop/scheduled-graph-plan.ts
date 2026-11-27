import { scheduledGraphClock } from './scheduled-graph-clock.js';
import type { ReleaseClock } from './release-graph-exec.js';

/** Pure decision only: callers must claim durably before creating or executing anything. */
export function planScheduledGraph(input: {
  mode: 'live' | 'shadow'; version?: string; now: Date;
  schedule?: { version: string; rehearsalAt?: unknown; cutAt?: unknown; publishAt?: unknown } | null;
  hasRun: boolean;
}): { kind: 'none' } | { kind: 'red'; version: string; reason: string } | { kind: 'due'; version: string; clock: ReleaseClock } {
  if (input.mode !== 'live' || !input.version || input.hasRun) return { kind: 'none' };
  const version = input.version;
  if (!input.schedule || input.schedule.version !== version) return { kind: 'red', version, reason: 'live version has no run or matching schedule' };
  const checked = scheduledGraphClock(input.schedule);
  if (!checked.ok) return { kind: 'red', version, reason: `live version has no run: ${checked.reason}` };
  if (!Number.isFinite(input.now.getTime())) return { kind: 'red', version, reason: 'invalid tick time' };
  if (input.now.getTime() < Date.parse(checked.clock.cutAt)) return { kind: 'red', version, reason: 'live version has no run; cut time not yet reached' };
  return { kind: 'due', version, clock: checked.clock };
}
