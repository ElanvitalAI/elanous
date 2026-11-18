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
export function noticeOneDispatch(input: {
  readonly injected: boolean;
  readonly remaining: number;
}): { readonly startTurn: boolean; readonly wakeQueue: boolean } {
  if (input.injected) return { startTurn: true, wakeQueue: false };
  return { startTurn: false, wakeQueue: input.remaining > 0 };
}