// ── Log pane — chat/output history below the 3-pane grid ──
// Phase 0 extraction: pure render function over explicit state. The
// dashboard still owns chatLines and chatScrollOffset; this module just
// renders them. Scroll handling / mutations stay in dashboard.ts until
// Phase 2 plugin-host lands.

import { C, stripAnsi, truncate, visibleWidth } from '../tui.js';
import type { FoldMode } from '../log-entry.js';
import { paneTitle } from './pane-title.js';
import { highlightLineSegments, type LogSearchResult } from '../log-pane/search.js';
import type { PaneSpec, RenderCtx } from '../plugins/core/types.js';

export interface LogPaneState {
  lines: string[];
  /** -1 = follow tail; otherwise 0-based top index. */
  scrollOffset: number;
  /** ⭐ `B1`(2026-08-19 · 대표 지시) — 스트리밍 중 «대기 큐» 한 줄. 스트리밍 표시줄 «바로 위»에
   *  그려진다. `null`/`''` 이면 행을 차지하지 않는다.
   *  ⛔ 큐의 자리는 컴포저가 «아니다» — 대표: *"입력기에 그리는게 아니라 스트리밍 프롬프트에"*.
   *  ⚠️ footer 가 없으면(=스트리밍이 아니면) 그리지 않는다 — 그때는 「대기」 개념이 없다. */
  queueRow?: string | null;
  /** Optional pinned footer row — rendered as the LAST body row, with
   *  the rest of the log body scrolling above it. Used for the chat
   *  thinking/streaming indicator so it stays at the bottom of the log
   *  while streamed content fills the rows above. null / undefined =
   *  no footer (body uses full height). */
  footerLine?: string | null;
  /** Scroll-freeze — when the user scrolls up, the dashboard snapshots
   *  `lines.length` into this field. The renderer then clips the
   *  visible slice to `lines.slice(0, frozenTailIndex)` so new output
   *  stops visually piling up under the user, and surfaces a badge
   *  (`⏸ N new`) in the title row so the hidden count is transparent.
   *  `null` / undefined = no freeze (tail follows). Clear it on
   *  explicit return-to-tail (`G` key / scroll to bottom). */
  frozenTailIndex?: number | null;
  /** Optional substring filter applied before viewporting. Unlike
   *  searchQuery this narrows the visible dataset itself. */
  filterQuery?: string | null;
  foldMode?: FoldMode;
  /** Optional discoverability hint shown while focused and no active
   *  filter is applied. The dashboard chooses the command surface
   *  (`/log filter` vs `/debug filter`) so the renderer stays generic. */
  filterHint?: string | null;
  /** Active in-pane search query — when set, the renderer wraps the
   *  matching substring of each visible line in a warning-coloured
   *  span so hits are visible at a glance. Combines with the search
   *  modal's initial options getter: user types query → modal filters
   *  → Enter picks one → dashboard sets scroll + leaves `searchQuery`
   *  here so subsequent n/N navigation has the same highlight. Empty
   *  / null = no highlighting (legacy). */
  searchQuery?: string | null;
  /** Current match cursor (1-based for display), when a search is
   *  active. `null` suppresses the title-row badge. */
  searchCursor?: { current: number; total: number } | null;
}

export interface LogPaneViewport {
  title: string;
  bodyLines: string[];
  visibleLineIndices: number[];
}

/** Dashboard scroll offsets count painted rows, while freeze/copy indices
 *  still address original entries. Match the pane's filter before scrolling.
 *  The common no-filter path counts delimiters without allocating rows. */
export function physicalLogRowCount(
  lines: readonly string[],
  beforeIndex = lines.length,
  filterQuery = '',
): number {
  let count = 0;
  const query = filterQuery.trim().toLowerCase();
  for (let i = 0; i < Math.min(beforeIndex, lines.length); i++) {
    const entry = lines[i] ?? '';
    if (query) {
      count += entry.split(/\r\n|\r|\n/).filter(line => stripAnsi(line).toLowerCase().includes(query)).length;
      continue;
    }
    count++;
    for (let j = 0; j < entry.length; j++) {
      if (entry[j] === '\n') count++;
      else if (entry[j] === '\r') {
        count++;
        if (entry[j + 1] === '\n') j++;
      }
    }
  }
  return count;
}

export function visibleSearchRowOffset(
  lines: readonly string[],
  result: LogSearchResult,
  filterQuery = '',
): number {
  const precedingRows = physicalLogRowCount(lines, result.lineIdx, filterQuery);
  const entryRowsBeforeMatch = (lines[result.lineIdx] ?? '')
    .split(/\r\n|\r|\n/)
    .slice(0, result.physicalRowInEntry ?? 0);
  const filter = filterQuery.trim().toLowerCase();
  const withinEntry = filter
    ? entryRowsBeforeMatch.filter(line => stripAnsi(line).toLowerCase().includes(filter)).length
    : entryRowsBeforeMatch.length;
  return precedingRows + withinEntry;
}

export function logPaneContentHeight(height: number, hasFooter: boolean, hasQueueRow: boolean): number {
  return Math.max(0, height - 1 - (hasFooter ? (hasQueueRow ? 3 : 2) : 0));
}

export function maxLogPaneScroll(
  lines: readonly string[],
  height: number,
  opts: { filterQuery?: string; frozenTailIndex?: number | null; hasFooter?: boolean; hasQueueRow?: boolean } = {},
): number {
  const sourceCount = opts.frozenTailIndex ?? lines.length;
  const visibleRows = physicalLogRowCount(lines, sourceCount, opts.filterQuery);
  return Math.max(0, visibleRows - logPaneContentHeight(height, !!opts.hasFooter, !!opts.hasQueueRow));
}

function buildScrollStatusLine(opts: {
  start: number;
  visibleCount: number;
  total: number;
}): string | null {
  if (opts.total <= opts.visibleCount) return null;
  const maxScroll = Math.max(0, opts.total - opts.visibleCount);
  if (opts.start >= maxScroll) return null;
  const from = Math.min(opts.total, opts.start + 1);
  const to = Math.min(opts.total, opts.start + opts.visibleCount);
  const percent = Math.max(0, Math.min(100, Math.round((opts.start / Math.max(1, maxScroll)) * 100)));
  return C.dim(`  scrolled ${from}-${to}/${opts.total} · ${percent}% · G tail`);
}

/** Pure render: returns the title line plus `height - 1` content lines.
 *  When `state.footerLine` is set, the last body row is that line and
 *  the tail-follow window for `state.lines` shrinks by 1 so the
 *  streamed text scrolls up past it, not over it.
 *
 *  Scroll-freeze: when `state.frozenTailIndex` is a finite number,
 *  only lines up to that index are considered visible. A `⏸ N new`
 *  badge lands in the title row so the user sees how much output is
 *  queued behind the freeze. `scrollOffset < 0` (tail-follow) is
 *  re-interpreted under freeze as "stick to the frozen tail index",
 *  not the real tail. */
export function buildLogPaneViewport(state: LogPaneState, ctx: RenderCtx): LogPaneViewport {
  const copyHint = C.dim(' (Shift+drag to copy)');

  // Clip the visible window under scroll-freeze so new lines don't
  // slip in under the user while they read.
  const frozen = typeof state.frozenTailIndex === 'number'
    ? Math.max(0, Math.min(state.frozenTailIndex, state.lines.length))
    : null;
  const frozenLines = frozen != null ? state.lines.slice(0, frozen) : state.lines;
  const hiddenBehindFreeze = frozen != null ? Math.max(0, state.lines.length - frozen) : 0;
  const filterQuery = state.filterQuery?.trim() ?? '';
  // Each source entry can contain embedded newlines. Expand it before
  // viewport math so one array item never paints over the footer/input rows.
  const physicalLines = frozenLines.flatMap((entry, index) =>
    entry.split(/\r\n|\r|\n/).map(line => ({ line, index })));
  const filtered = physicalLines.filter(({ line }) => {
    if (!filterQuery) return true;
    return stripAnsi(line).toLowerCase().includes(filterQuery.toLowerCase());
  });
  const visibleLines = filtered.map(item => item.line);
  const visibleLineIndices = filtered.map(item => item.index);

  // Title row — append freeze + search badges when applicable.
  let title = paneTitle('ChatLog', ctx.focused, ctx.width - (ctx.focused ? 20 : 0));
  if (hiddenBehindFreeze > 0) {
    // Badge is rendered in-line after the title so terminals with no
    // HUD segments still surface the state. `G` to resume uses the
    // dashboard's existing "return to tail" handler.
    title += ' ' + C.warning(`⏸ ${hiddenBehindFreeze} new — press G`);
  }
  if (state.searchQuery && state.searchCursor && state.searchCursor.total > 0) {
    title += ' ' + C.accent(
      `🔍 "${state.searchQuery}" ${state.searchCursor.current}/${state.searchCursor.total} — n/N · Esc clear`,
    );
  }
  if (filterQuery) {
    title += ' ' + C.info(`⌕ ${filterQuery} · ${visibleLines.length}`);
  } else if (ctx.focused && state.filterHint) {
    title += ' ' + C.dim(`⌕ ${state.filterHint}`);
  }
  if (ctx.focused) title += copyHint;
  const bodyH = Math.max(0, ctx.height - 1);
  const hasFooter = state.footerLine != null && state.footerLine !== '';
  // When the pinned footer is active, reserve 2 rows for it (1-row
  // breathing gap above + 1-row footer) so the streamed text doesn't
  // feel crammed against the indicator.
  const hasQueueRow = hasFooter && state.queueRow != null && state.queueRow !== '';
  const contentH = logPaneContentHeight(ctx.height, hasFooter, hasQueueRow);
  const maxScroll = Math.max(0, visibleLines.length - contentH);
  const start = state.scrollOffset < 0
    ? maxScroll
    : Math.min(state.scrollOffset, maxScroll);
  const scrollStatusLine = buildScrollStatusLine({
    start,
    visibleCount: contentH,
    total: visibleLines.length,
  });
  const bodyWidth = Math.max(0, ctx.width);
  const bodyLines: string[] = [];
  const viewportIndices: number[] = [];

  for (let i = 0; i < contentH; i++) {
    let ln = visibleLines[start + i];
    viewportIndices.push(visibleLineIndices[start + i] ?? -1);
    // Search highlight pass — wrap the matched substring in a
    // contrast colour. Applied before truncation so the truncate()
    // call is still ANSI-aware; the extra SGR pair may cost a few
    // chars but doesn't affect visibleWidth.
    if (ln && state.searchQuery) {
      const seg = highlightLineSegments(ln, state.searchQuery);
      if (seg) ln = seg.prefix + C.accent(seg.match) + seg.suffix;
    }
    const row = ln ? `  ${renderBodyLine(ln, Math.max(0, bodyWidth - 2))}` : '';
    bodyLines.push(row);
  }
  if (hasFooter) {
    bodyLines.push('');  // breathing gap
    viewportIndices.push(-1);
    if (hasQueueRow) {
      bodyLines.push(`  ${truncate(state.queueRow!, Math.max(0, bodyWidth - 2))}`);
      viewportIndices.push(-1);
    }
    const footerBase = `  ${truncate(state.footerLine!, Math.max(0, bodyWidth - 2))}`;
    const footerWithStatus = scrollStatusLine
      ? truncate(`${footerBase}  ${stripAnsi(scrollStatusLine).trimStart()}`, Math.max(0, bodyWidth))
      : footerBase;
    bodyLines.push(
      footerWithStatus,
    );
    viewportIndices.push(-1);
  } else if (scrollStatusLine) {
    bodyLines.push(truncate(scrollStatusLine, Math.max(0, bodyWidth)));
    viewportIndices.push(-1);
  }
  while (bodyLines.length < bodyH) {
    bodyLines.push('');
    viewportIndices.push(-1);
  }
  return {
    title,
    bodyLines,
    visibleLineIndices: viewportIndices,
  };
}

export function renderLogPane(state: LogPaneState, ctx: RenderCtx): string[] {
  const viewport = buildLogPaneViewport(state, ctx);
  return [viewport.title, ...viewport.bodyLines];
}

/** Render one body line — truncate to `maxW` visible columns. When
 *  the source is wider than maxW, the tail gets a `…+N` marker where
 *  N is the number of hidden characters (ANSI stripped) so the user
 *  knows content was dropped. Line is otherwise returned unchanged
 *  (no trailing reset marker when it fits natively — matches the
 *  old behaviour where truncate() was a no-op).
 *
 *  The marker cost is 4-6 visible cols (" …+N" through " …+99999");
 *  we pre-reserve enough room so appending the marker never causes
 *  a second wrap. Very narrow panes (maxW < 10) skip the marker and
 *  fall back to plain truncate so we don't paint just "…+N" with no
 *  content.
 *
 *  Exported for the unit test so future regressions around marker
 *  width / UTF-8 widths / nested ANSI are pinned. */
export function renderBodyLine(line: string, maxW: number): string {
  const vw = visibleWidth(line);
  if (vw <= maxW) return line + '\x1b[0m';
  if (maxW < 10) return truncate(line, maxW);
  const hiddenCount = vw - maxW;
  const marker = `…+${hiddenCount}`;
  const markerW = marker.length;  // ASCII — visibleWidth equals length
  // Truncate aggressively enough to leave room for the marker *plus*
  // a space for breathing. truncate() itself will append '…' which
  // we overwrite by stripping its trailing char before appending the
  // richer marker.
  const truncated = truncate(line, Math.max(1, maxW - markerW));
  // truncate() appends '…\x1b[0m' — strip both so our richer marker
  // lands cleanly at the end.
  const stripped = truncated.endsWith('…\x1b[0m')
    ? truncated.slice(0, -('…\x1b[0m'.length))
    : truncated;
  return stripped + C.dim(marker) + '\x1b[0m';
}

/** PaneSpec adapter for future plugin-host wiring. */
export const logPane: PaneSpec<LogPaneState> = {
  title: 'Log',
  render: renderLogPane,
};

/**
 * Find the block of non-empty lines that contains (or precedes) the given
 * cursor index. Blocks are delimited by empty strings ('' in chatLines).
 *
 * If the cursor lands on an empty line, we walk backward to the nearest
 * non-empty line and use that as the anchor. If no non-empty line exists,
 * returns null. Useful for "copy the output chunk I'm looking at" UX.
 *
 * Bounds are [start, end) — `end` is exclusive.
 */
export function findBlock(lines: string[], cursorIdx: number): { start: number; end: number } | null {
  if (lines.length === 0) return null;

  // Clamp + walk back to a non-empty anchor.
  let anchor = Math.min(Math.max(0, cursorIdx), lines.length - 1);
  while (anchor >= 0 && lines[anchor] === '') anchor--;
  if (anchor < 0) return null;

  // Walk outward to the empty-line boundaries.
  let start = anchor;
  while (start > 0 && lines[start - 1] !== '') start--;
  let end = anchor + 1;
  while (end < lines.length && lines[end] !== '') end++;

  return { start, end };
}
