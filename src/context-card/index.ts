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

/** RFC context-diet §3a — exact fallback wording for a PR body that states no conclusion / could not be read. */
export const PR_CONCLUSION_NONE = '없음(원문에 결론 없음)';
export const PR_CONCLUSION_UNREADABLE = '확인 불가';

export interface PrConclusionCardInput {
  readonly id: string;
  /** First paragraph of the original body; empty or omitted means the original states no conclusion. */
  readonly firstParagraph?: string;
  /** Set when the original body could not be read at all. */
  readonly unreadable?: boolean;
  readonly pointers: readonly string[];
  readonly source: string;
  readonly updatedAt: string;
  readonly supersedes?: string;
}

/** First blank-line-delimited paragraph of the original body, or '' when the body is blank. */
export function firstParagraphOf(body: string): string {
  const trimmed = body.trim();
  return trimmed ? (trimmed.split(/\n\s*\n/)[0] ?? '') : '';
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** kind-'pr' conclusion card on the existing ContextCard schema; why/verdict/remaining stay empty unless grounded. */
export function buildPrConclusionCard(input: PrConclusionCardInput): ContextCard {
  const conclusion = input.unreadable
    ? PR_CONCLUSION_UNREADABLE
    : oneLine(input.firstParagraph ?? '') || PR_CONCLUSION_NONE;
  return {
    id: input.id,
    kind: 'pr',
    conclusion,
    why: '',
    verdict: '',
    remaining: [],
    pointers: [...input.pointers],
    source: input.source,
    updatedAt: input.updatedAt,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  };
}

/** §3a display header; fallback conclusions keep the prescribed wording verbatim with no pointer suffix. */
export function prConclusionCardHeader(card: ContextCard): string {
  const fallback = card.conclusion === PR_CONCLUSION_NONE || card.conclusion === PR_CONCLUSION_UNREADABLE;
  const pointers = card.pointers.join(' · ');
  return `결론: ${card.conclusion}${fallback || !pointers ? '' : ` · 포인터: ${pointers}`}`;
}
