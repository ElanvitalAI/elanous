// TUI-KEEP-TRANSCRIPT-ON-COMPACT (대표 11-24 «대화가 너무 빨리 사라진다»): compaction shrinks the MODEL context only,
// never the transcript the person is reading. A compaction rewrites the stored history into a summary; reloading that
// store into the chat used to replace every displayed row with the summary. After a same-session compaction the
// display keeps the rows it already showed and only appends rows that are new in the store. A session switch still
// replaces the display (the caller simply does not merge then).
import type { SerializedMessage } from '../../session/index.js';
import { transcriptRowId } from './transcript-vanish.js';

export interface CompactDisplayMerge {
  /** The rows to display: every previously displayed row (in place) then the rows new in the store. */
  readonly rows: SerializedMessage[];
  /** How many previously displayed rows the store no longer has (kept on screen only). */
  readonly keptMissing: number;
  /** Index of the last previously displayed row — the compaction point a marker anchors after. */
  readonly compactionPoint: number;
}

/** The stored summary row a compaction writes (model context only — not a chat row to show). */
export function isContextSummaryRow(row: SerializedMessage): boolean {
  return row.role === 'system' && row.content.startsWith('<context_summary>');
}

/** The store's version is a compaction rewrite of what was shown: a seat-mail stub (compact-session stubMailRow) or a
 *  shortened text. A row that only grew (a streamed answer completing) is not. */
function isCompactionRewrite(shown: SerializedMessage, stored: SerializedMessage): boolean {
  if (stored.content === shown.content) return false;
  if (stored.content.startsWith('[seat-mail ') && !shown.content.startsWith('[seat-mail ')) return true;
  return stored.content.length < shown.content.length;
}

/** Merge a reloaded (possibly compacted) store into the rows already on screen.
 *  - A displayed row still in the store takes the store's version, unless the store shortened its text
 *    (a compaction stub) — then the text the person read stays.
 *  - A displayed row the store dropped stays where it was.
 *  - A store row not yet displayed is appended (summary rows excluded). */
export function mergeDisplayAfterCompact(
  displayed: readonly SerializedMessage[],
  reloaded: readonly SerializedMessage[],
): CompactDisplayMerge {
  const stored = new Map<string, SerializedMessage>();
  for (const row of reloaded) stored.set(transcriptRowId(row), row);
  const shownIds = new Set<string>();
  let keptMissing = 0;
  const rows: SerializedMessage[] = displayed.map((row) => {
    const rowId = transcriptRowId(row);
    shownIds.add(rowId);
    const next = stored.get(rowId);
    if (!next) { keptMissing += 1; return row; }
    return isCompactionRewrite(row, next) ? row : next;
  });
  const compactionPoint = rows.length - 1;
  for (const row of reloaded) {
    if (shownIds.has(transcriptRowId(row)) || isContextSummaryRow(row)) continue;
    rows.push(row);
  }
  return { rows, keptMissing, compactionPoint };
}

/** The rows to show after a store reload. Only a reload of the session on screen that was compacted while shown keeps
 *  the displayed rows; a session switch (or a never-compacted session) shows the store as it is. */
export function displayRowsAfterReload(input: {
  readonly sameSession: boolean;
  readonly compacted: boolean;
  readonly displayed: readonly SerializedMessage[];
  readonly reloaded: readonly SerializedMessage[];
}): CompactDisplayMerge {
  if (!input.sameSession || !input.compacted)
    return { rows: [...input.reloaded], keptMissing: 0, compactionPoint: input.reloaded.length - 1 };
  return mergeDisplayAfterCompact(input.displayed, input.reloaded);
}

/** «Compacted 120→30 messages» → «── context compacted 120→30 ──» (any other status: no counts). */
export function compactMarkerText(status: string): string {
  const counts = /(\d+)\s*→\s*(\d+)/.exec(status);
  return counts ? `── context compacted ${counts[1]}→${counts[2]} ──` : '── context compacted ──';
}

const ATTEMPT_HEAD_CHARS = 80;

/** A replaced streaming preview, folded to one line (the full text unfolds as detail). Null when nothing was shown
 *  or the new preview simply continues the old one. */
export function previousAttemptMarker(previousText: string | undefined, nextText: string):
  { text: string; detail: string[] } | null {
  const shown = (previousText ?? '').trim();
  if (!shown) return null;
  if (nextText.trim().startsWith(shown)) return null;
  const oneLine = shown.replace(/\s+/g, ' ');
  const head = oneLine.length > ATTEMPT_HEAD_CHARS ? `${oneLine.slice(0, ATTEMPT_HEAD_CHARS - 1)}…` : oneLine;
  return { text: `↺ previous attempt · ${head}`, detail: shown.split('\n') };
}
