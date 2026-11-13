import type { MeasuredTurnUsage } from '../session/turn-usage.js';

/** The sticky stream must never reuse a turn ID within its process. */
export function createTurnIdClaim() {
  const seen = new Set<string>();
  return (id: string): boolean => {
    if (id.trim().length === 0 || seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

/** Build a completion only for the successful invocation that owns this ID. */
export function usageCompletionFrame(
  turnId: string,
  sessionId: string,
  usage: MeasuredTurnUsage | undefined,
  aborted: boolean,
) {
  if (aborted || !turnId || !usage) return undefined;
  return { event: 'usage-complete' as const, turnId, sessionId, usage };
}
