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

/** TUI-LONG-PASTE-SPIN (OP froze again 11-25 12:12 · `compact-display-kept {at:"message-block"}` every ~170 ms): every
 *  store reload returns fresh row objects, so a merge handed the renderer a brand-new transcript each time and every
 *  frame re-wrapped all 4.6k rows. A reloaded row that is the same as the row on screen keeps the on-screen object:
 *  a reload of an unchanged store changes nothing, and only changed or new rows are drawn again. */
function sameRow(shown: SerializedMessage, stored: SerializedMessage): boolean {
  if (shown === stored) return true;
  const a = shown as unknown as Record<string, unknown>;
  const b = stored as unknown as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (left === right) continue;
    // Small structured fields (from · usage · attachments) compare by value; the big strings above compare by ===.
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  return true;
}

/** `reloaded` with every row that equals a displayed row (same id · same fields) replaced by the displayed object. */
export function reuseDisplayedRows(displayed: readonly SerializedMessage[], reloaded: readonly SerializedMessage[]): SerializedMessage[] {
  if (displayed.length === 0) return [...reloaded];
  const shown = new Map<string, SerializedMessage>();
  for (const row of displayed) shown.set(transcriptRowId(row), row);
  return reloaded.map((row) => {
    const prior = shown.get(transcriptRowId(row));
    return prior && sameRow(prior, row) ? prior : row;
  });
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
    return isCompactionRewrite(row, next) || sameRow(row, next) ? row : next;
  });
  const compactionPoint = rows.length - 1;
  for (const row of reloaded) {
    if (shownIds.has(transcriptRowId(row)) || isContextSummaryRow(row)) continue;
    rows.push(row);
  }
  return { rows, keptMissing, compactionPoint };
}

/** TUI-KEEP-TRANSCRIPT-ON-TURN-START-COMPACT — the turn-start compaction runs inside the turn child (session/chat.ts)
 *  and rewrites the store without telling the TUI (no onCompact). The rewrite is still visible in the store itself: a
 *  context summary row the screen has not seen. Returns that row's id, or null when the store holds no new summary.
 *  `known` is the summary id this display already handled (a merged display never contains the summary row). */
export function newStoreSummaryId(
  displayed: readonly SerializedMessage[],
  reloaded: readonly SerializedMessage[],
  known?: string,
): string | null {
  let latest: SerializedMessage | undefined;
  for (let index = reloaded.length - 1; index >= 0 && !latest; index -= 1)
    if (isContextSummaryRow(reloaded[index]!)) latest = reloaded[index];
  if (!latest) return null;
  const latestId = transcriptRowId(latest);
  if (latestId === known) return null;
  return displayed.some((row) => isContextSummaryRow(row) && transcriptRowId(row) === latestId) ? null : latestId;
}

/** The rows to show after a store reload. Only a reload of the session on screen that was compacted while shown keeps
 *  the displayed rows; a session switch (or a never-compacted session) shows the store as it is. A same-session store
 *  that carries a summary the screen has not seen was compacted while shown (by the turn child) — it merges too and
 *  reports the summary id in `compactedBy`. Display only: the store and the reloaded rows are never written. */
export function displayRowsAfterReload(input: {
  readonly sameSession: boolean;
  readonly compacted: boolean;
  readonly displayed: readonly SerializedMessage[];
  readonly reloaded: readonly SerializedMessage[];
  readonly knownSummaryId?: string;
}): CompactDisplayMerge & { readonly compactedBy?: string } {
  const compactedBy = input.sameSession && input.displayed.length > 0
    ? newStoreSummaryId(input.displayed, input.reloaded, input.knownSummaryId) : null;
  if (!input.sameSession || (!input.compacted && !compactedBy))
    return { rows: input.sameSession ? reuseDisplayedRows(input.displayed, input.reloaded) : [...input.reloaded], keptMissing: 0, compactionPoint: input.reloaded.length - 1 };
  const merged = mergeDisplayAfterCompact(input.displayed, input.reloaded);
  return compactedBy ? { ...merged, compactedBy } : merged;
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
