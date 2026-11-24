/**
 * TUI-STICKY-SCROLLBACK (대표 11-24): a person who scrolled up keeps reading the same rows.
 *
 * `scroll` is the distance from the bottom of the transcript. When rows are appended (a notice turn,
 * a streamed answer, a turn-end marker) the same `scroll` would show different rows, and the old
 * turn-end `scroll = 0` snapped the view back to the bottom every 30–60 s on the OP seat.
 *
 * Rule: while scrolled up (scroll > 0) the top row stays where it was — scroll grows by the rows
 * appended below (and shrinks when rows below go away, e.g. the activity rows clearing at turn end).
 * Only the person's own action (submit, End, scrolling back down to 0) returns to the bottom.
 */

/** What the last painted frame looked like; anchoring is only meaningful for the same layout. */
export interface StickyScrollMemo {
  /** Total transcript rows of the last frame (before the viewport cut). */
  readonly historyRows: number;
  /** Layout key (width · view mode · session) — a different key re-wraps rows, so no anchoring. */
  readonly layout: string;
  /** Rows appended below since the person scrolled up (the «↓ N new» count). */
  readonly unseenRows: number;
}

export interface StickyScrollAnchor {
  readonly scroll: number;
  readonly unseenRows: number;
  /** Rows the transcript grew (+) or shrank (−) under a scrolled view; 0 when nothing moved. */
  readonly delta: number;
}

/**
 * Keep the same top row: given the previous frame memo and the new frame's total rows, return the
 * scroll that shows the same rows. At the bottom (scroll 0) nothing is anchored — new rows show.
 */
export function anchorStickyScroll(
  scroll: number,
  memo: StickyScrollMemo | null,
  historyRows: number,
  layout: string,
): StickyScrollAnchor {
  if (scroll <= 0) return { scroll: 0, unseenRows: 0, delta: 0 };
  if (!memo || memo.layout !== layout) return { scroll, unseenRows: memo?.unseenRows ?? 0, delta: 0 };
  const delta = historyRows - memo.historyRows;
  if (delta === 0) return { scroll, unseenRows: memo.unseenRows, delta: 0 };
  const next = Math.max(0, scroll + delta);
  // Rows that went away below were never «new»; only growth counts toward the hint.
  const unseenRows = next === 0 ? 0 : Math.max(0, memo.unseenRows + delta);
  return { scroll: next, unseenRows, delta };
}

/** The one-line hint shown while the person reads older rows and newer ones arrived below. */
export function stickyScrollHint(scroll: number, unseenRows: number): string {
  return scroll > 0 && unseenRows > 0 ? `↓ ${unseenRows} new · End to jump` : '';
}

/** Why the view went (or tried to go) back to the bottom — the `tui.scroll` log cause. */
export type StickyScrollResetCause = 'submit' | 'end-key' | 'session-switch' | 'compaction' | 'turn-end' | 'resume';

/**
 * Who may move a scrolled view to the bottom. A person's own action (submit, End, switching or
 * compacting the session they look at) resets; a turn ending (often a notice turn) never does.
 */
export function stickyScrollResetAllowed(cause: StickyScrollResetCause): boolean {
  return cause !== 'turn-end';
}
