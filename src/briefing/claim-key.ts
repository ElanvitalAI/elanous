/** Collapse whitespace so the same claim, however spaced, counts once. */
export function normalizeClaim(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
