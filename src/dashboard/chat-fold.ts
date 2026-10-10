import { format, getMessages } from '../expression/i18n/index.js';

type Locale = NonNullable<Parameters<typeof getMessages>[0]>;

export function splitNoSynthesisTail(text: string): { head: string; tail: string } | null {
  const index = text.indexOf('[NO FINAL SYNTHESIS]');
  if (index === -1) return null;
  return {
    head: text.slice(0, index).trimEnd(),
    tail: text.slice(index),
  };
}

/** English fallback for locale bundles that do not carry the optional key. */
const FOLDED_TAIL_FALLBACK = '● Internal notes folded · {n} lines · press f to expand';

export function buildFoldedTailLine(lineCount: number, locale?: Locale): string {
  const template = getMessages(locale).chatFoldedInternalTail ?? FOLDED_TAIL_FALLBACK;
  return format(template, { n: lineCount });
}
