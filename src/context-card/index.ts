/** A rebuildable view of the ledger and code, never an authoritative record. */
export interface ContextCard {
  readonly id: string;
  readonly kind: 'task' | 'goal' | 'run' | 'pr' | 'cell' | 'doc';
  readonly conclusion: string;
  readonly why: string;
  readonly verdict: string;
  readonly remaining: readonly string[];
  readonly pointers: readonly string[];
  readonly source: string;
  readonly updatedAt: string;
  readonly supersedes?: string;
}

/** Serialized code points, including JSON escaping; callers may supply a smaller screen budget. */
export const CONTEXT_CARD_SCREEN_CHARS = 1_600;
const length = (text: string): number => [...text].length;

/** Preserve the decision and provenance; fold only the two expandable lists. Never mutate the card. */
export function serializeContextCard(card: ContextCard, maxChars = CONTEXT_CARD_SCREEN_CHARS): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new RangeError('maxChars must be a positive safe integer');
  if (/[\r\n\u2028\u2029]/u.test(card.conclusion)) throw new Error('conclusion must be one line');
  const remaining = [...card.remaining];
  const pointers = [...card.pointers];
  const render = () => JSON.stringify({
    id: card.id, kind: card.kind, conclusion: card.conclusion, why: card.why,
    verdict: card.verdict, remaining: remaining.length < card.remaining.length
      ? [...remaining, `외 ${card.remaining.length - remaining.length}개`] : remaining,
    pointers: pointers.length < card.pointers.length
      ? [...pointers, `외 ${card.pointers.length - pointers.length}개`] : pointers,
    source: card.source, updatedAt: card.updatedAt,
    ...(card.supersedes === undefined ? {} : { supersedes: card.supersedes }),
  });
  let text = render();
  while (length(text) > maxChars && (remaining.length || pointers.length)) {
    // Remove the larger last entry first, then break ties by preferring remaining.
    const remainingCost = remaining.length ? length(JSON.stringify(remaining.at(-1))) : -1;
    const pointerCost = pointers.length ? length(JSON.stringify(pointers.at(-1))) : -1;
    if (remainingCost >= pointerCost) remaining.pop();
    else pointers.pop();
    text = render();
  }
  if (length(text) > maxChars) throw new RangeError('card core and omission counts exceed maxChars');
  return text;
}
