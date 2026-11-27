/** A draft may yield to an automatic turn only after a known period without a human key.
 * Unknown or future key timestamps are conservative: they never permit a yield.
 */
export const DRAFT_IDLE_MS = 120_000;

/** Start a conservative observation window for a restored draft with no key timestamp. */
export function createDraftKeyClock(): (draft: string, lastKey: number, now: number) => number {
  let observed = '';
  let since = 0;
  return (draft, lastKey, now) => {
    if (!draft || lastKey !== 0 || !Number.isFinite(now) || now <= 0) {
      observed = '';
      since = 0;
      return lastKey;
    }
    if (draft !== observed || since === 0 || now < since) {
      observed = draft;
      since = now;
    }
    return since;
  };
}

export function isIdleDraft(text: string, lastHumanKeyAt: number, now: number, idleMs = DRAFT_IDLE_MS): boolean {
  return text.length > 0 && Number.isFinite(lastHumanKeyAt) && lastHumanKeyAt > 0
    && Number.isFinite(now) && Number.isFinite(idleMs) && idleMs >= 0
    && now >= lastHumanKeyAt && now - lastHumanKeyAt >= idleMs;
}
