import { createHash } from 'node:crypto';

/** Hash the exact typed mapping in the current title; ambiguity never inherits an old receipt. */
export function boundaryMappingHash(title: string): string | null {
  const matches = [...title.matchAll(/^\s*-?\s*완료 경계 실물 검증:\s*(.+)$/gm)];
  if (matches.length !== 1) return null;
  try {
    const mapping: unknown = JSON.parse(matches[0]![1]!);
    if (!Array.isArray(mapping) || mapping.length < 1 || mapping.length > 8) return null;
    return createHash('sha256').update(JSON.stringify(mapping)).digest('hex');
  } catch { return null; }
}
