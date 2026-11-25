/**
 * ELN-EXTERNAL-EVENTS-NOTICE-ONE — the common dispatch verdict, kept in a
 * leaf of its own so the import-failure branch of the entry chain can use
 * the same predicate even when the wire leaf did not load.
 */

/**
 * What entry does after the leaf answers. A new row starts the notice turn.
 * A duplicate or a refusal is not a turn. The item is already off the queue,
 * so a later item must still be woken. The leaf import failing is the same
 * as a refusal: no turn, and the rest of the queue still wakes.
 */
/** Consecutive not-injected notices after which one turn is forced (no silent stall · 11-25 OP deaf). */
export const NOT_INJECTED_FORCE_AFTER = 3;

export function noticeOneDispatch(input: {
  readonly injected: boolean;
  readonly remaining: number;
  /** Why the ledger refused: `full` is bookkeeping, not a reason to lose the turn — it starts anyway. */
  readonly refusal?: 'duplicate' | 'full';
  /** Not-injected results in a row, this one included. */
  readonly streak?: number;
}): { readonly startTurn: boolean; readonly wakeQueue: boolean; readonly forced?: 'ledger-full' | 'not-injected-streak' } {
  if (input.injected) return { startTurn: true, wakeQueue: false };
  if (input.refusal === 'full') return { startTurn: true, wakeQueue: false, forced: 'ledger-full' };
  if ((input.streak ?? 0) >= NOT_INJECTED_FORCE_AFTER) return { startTurn: true, wakeQueue: false, forced: 'not-injected-streak' };
  return { startTurn: false, wakeQueue: input.remaining > 0 };
}
