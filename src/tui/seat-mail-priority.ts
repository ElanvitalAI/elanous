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
