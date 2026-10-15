// Log-pane in-pane search — scan chatLines for a query, return matches
// with short previews, and provide a highlight helper the renderer
// wraps around visible lines while a query is active.
//
// Case-insensitive substring match (not regex) for MVP. Future
// extensions: regex mode, case-sensitive toggle, field filters.

import { stripAnsi } from '../tui.js';

export interface LogSearchResult {
  /** Absolute chatLines index where the match was found. */
  readonly lineIdx: number;
  /** Physical row inside that entry where its first match begins. */
  readonly physicalRowInEntry?: number;
  /** Stripped-ANSI context window around the match (~80 cols). Leading
   *  `…` when we trimmed the start; trailing `…` when we trimmed the
   *  end, so users see exactly what section of the line matched. */
  readonly preview: string;
  /** Character offsets into `preview` where the match begins/ends.
   *  Useful for renderers that want to paint the match span in
   *  contrast colour. */
  readonly matchStart: number;
  readonly matchEnd: number;
}

/** Scan every line for `query` (case-insensitive substring). Returns
 *  one LogSearchResult per matching line — additional matches on the
 *  same line are folded into the first occurrence (power users can
 *  refine the query if they need multi-per-line hits). */
export function findLogMatches(lines: readonly string[], query: string): LogSearchResult[] {
  return scanLogMatches(lines, query, '');
}

export function findVisibleLogMatches(lines: readonly string[], query: string, filterQuery: string): LogSearchResult[] {
  return scanLogMatches(lines, query, filterQuery);
}

function scanLogMatches(lines: readonly string[], query: string, filterQuery: string): LogSearchResult[] {
  const q = query.trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const filter = filterQuery.trim().toLowerCase();
  const results: LogSearchResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripAnsi(lines[i] ?? '');
    let source = '';
    let idx = -1;
    let physicalRowInEntry = 0;
    const rows = stripped.split(/\r\n|\r|\n/);
    for (let row = 0; row < rows.length; row++) {
      const candidate = rows[row]!;
      if (filter && !candidate.toLowerCase().includes(filter)) continue;
      const match = candidate.toLowerCase().indexOf(qLower);
      if (match < 0) continue;
      source = candidate;
      idx = match;
      physicalRowInEntry = row;
      break;
    }
    if (idx < 0) continue;
    const ctxLead = 20;  // chars before the match in the preview
    const ctxTail = 60;  // chars after the match end in the preview
    const srcStart = Math.max(0, idx - ctxLead);
    const srcEnd = Math.min(source.length, idx + q.length + ctxTail);
    const trimmedLeft = srcStart > 0;
    const trimmedRight = srcEnd < source.length;
    const slice = source.slice(srcStart, srcEnd);
    const preview = (trimmedLeft ? '…' : '') + slice + (trimmedRight ? '…' : '');
    const offsetInPreview = (trimmedLeft ? 1 : 0) + (idx - srcStart);
    results.push({
      lineIdx: i,
      physicalRowInEntry,
      preview,
      matchStart: offsetInPreview,
      matchEnd: offsetInPreview + q.length,
    });
  }
  return results;
}

/** Split a line at the query match boundaries so renderers can paint
 *  the match in a contrast colour while leaving the rest of the line
 *  intact. Returns `null` when the query isn't in the line (caller
 *  renders the line as-is).
 *
 *  We strip ANSI for matching but return the *original* line segments
 *  keyed to the stripped offsets — preserving colours outside the
 *  match span. This is lossy when the match straddles an ANSI escape
 *  boundary (we fall back to stripped rendering in that case); most
 *  real log lines either land entirely inside a single coloured span
 *  or entirely outside, so the lossy case is rare enough to accept. */
export function highlightLineSegments(
  line: string,
  query: string,
): { prefix: string; match: string; suffix: string } | null {
  const q = query.trim();
  if (!q) return null;
  const stripped = stripAnsi(line);
  const idx = stripped.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return null;
  // Map stripped offset back into the original indexed by skipping
  // over ANSI escape sequences.
  const mapStrippedToOriginal = (target: number): number => {
    let stripPos = 0;
    let orig = 0;
    while (orig < line.length && stripPos < target) {
      if (line[orig] === '\x1b') {
        // walk to end of escape
        while (orig < line.length && line[orig] !== 'm') orig++;
        orig++;
        continue;
      }
      orig++;
      stripPos++;
    }
    return orig;
  };
  const origStart = mapStrippedToOriginal(idx);
  const origEnd = mapStrippedToOriginal(idx + q.length);
  return {
    prefix: line.slice(0, origStart),
    match: line.slice(origStart, origEnd),
    suffix: line.slice(origEnd),
  };
}
