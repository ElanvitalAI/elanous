/**
 * SEAT-STEER-PREEMPT JUD security HOLD (b5c5c3b3): `msg post --from` is not bound to an authenticated seat, so a sender
 * name (OP · 대표) and the ledger origin derived from it grant NO priority and NO preemption. A decision is recognised by
 * its structured intent alone (`--intent decision`, or legacy `--kind decision`, normalised by the ledger read), and that
 * only guarantees delivery — it is never folded into the cap summary. Order stays FIFO by msgId.
 */
export function isDecisionMail(message: { intent?: string | null }): boolean {
  return message.intent === 'decision';
}

/** An urgent mail is marked at the start of its kind or body, after whitespace. */
export function isUrgentSeatMail(message: { kind?: string | null; body: string }): boolean {
  return [message.kind, message.body].some(value => typeof value === 'string' && /^[🔴⚡]/u.test(value.trimStart()));
}

/** Urgent mail keeps arrival order, as does every other item. No queued work is discarded. */
export function prioritizeSeatMail<T>(items: readonly T[], isUrgent: (item: T) => boolean): T[] {
  const urgent: T[] = [];
  const ordinary: T[] = [];
  for (const item of items) (isUrgent(item) ? urgent : ordinary).push(item);
  return [...urgent, ...ordinary];
}
