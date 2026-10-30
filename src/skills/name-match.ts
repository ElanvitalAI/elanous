/** Canonicalize a spoken/typed skill slug while retaining letters and digits. */
export function normalizeSkillName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

/** Return a canonical catalog entry only when the normalized name is unique. */
export function resolveSkillName<T extends { name: string }>(
  requested: string,
  entries: readonly T[],
): { entry?: T; ambiguous: T[] } {
  // Keep accidental surrounding whitespace out of execution; only the
  // slug's internal separators are fuzzy.
  if (requested !== requested.trim()) return { ambiguous: [] };
  const normalized = normalizeSkillName(requested);
  if (!normalized) return { ambiguous: [] };
  const matches = entries.filter((entry) => normalizeSkillName(entry.name) === normalized);
  return matches.length === 1
    ? { entry: matches[0], ambiguous: [] }
    : { ambiguous: matches.length > 1 ? matches : [] };
}
