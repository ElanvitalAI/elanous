import { ansi, termSize } from './tui.js';
import { perf } from './perf-counters.js';
import { noteInputLagPaint } from './tui/input-lag-probe.js';
import { sliceAnsiByColumns, visibleWidth } from './tui-string-width.js';

// ── Frame observer (self-observation capture · PLAN P1b) ──
// The lowest-layer seam for self-report: render() feeds every composed
// full-screen frame here. Off by default (null); the TUI self-report
// wiring registers it. Mirrors setKeyTracer — one optional callback,
// try/catch guarded so a buggy observer can NEVER break rendering.
type FrameObserver = (lines: readonly string[], dims: { rows: number; cols: number }) => void;
let _frameObserver: FrameObserver | null = null;
export function setFrameObserver(fn: FrameObserver | null): void {
  _frameObserver = fn;
}


export interface RenderOptions {
  /** Absolute-positioned draw commands emitted after changed base rows.
  *  Used for modal overlays so the whole frame flushes as one write. */
  overlay?: string;
  /** Modal cells are painted by `overlay`; base-row updates must leave
   *  these columns resident so an uncovered frame never exposes the base. */
  preserveBounds?: { row: number; col: number; width: number; height: number };
  /** Drop the cached frame and repaint every row. Use after resize or
  *  when an overlay closes and the covered rows must be restored. */
  force?: boolean;
  /** Physical cursor ANSI emitted after overlays as the last bytes of the frame. */
  cursor?: string;
  /** Called after this frame finishes rendering and stdout settles. */
  onWriteComplete?: (error?: Error | null) => void;
}

let _lastFrameLines: string[] = [];
let _lastFrameRows = 0;
let _lastFrameCols = 0;

function padAnsiToColumns(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

export function resetRenderCache(): void {
  _lastFrameLines = [];
  _lastFrameRows = 0;
  _lastFrameCols = 0;
}

/** True when the frame cache says `row` (0-based) currently shows
 *  exactly `text` — a direct writer can skip repainting it. Invalidated
 *  rows hold a sentinel that never matches. */
export function renderCacheRowIs(row: number, text: string): boolean {
  return row >= 0 && row < _lastFrameLines.length && _lastFrameLines[row] === text;
}

/** Invalidate a specific row in the frame cache without nuking the
 *  whole thing. Callers that do direct stdout writes to a narrow
 *  band (input prompt, cursor moves) use this instead of
 *  resetRenderCache — the next render() pass re-emits only the
 *  touched rows plus whatever genuinely changed elsewhere, so we
 *  avoid re-painting the entire screen just because the input line
 *  redrew itself.
 *  `row` is 0-based. Out-of-range values no-op. */
export function invalidateRenderCacheRow(row: number): void {
  if (row < 0 || row >= _lastFrameLines.length) return;
  // Stash a sentinel that can NEVER match a real rendered row (ANSI
  // strings never contain a raw 0x00). The render-loop diff then
  // treats this row as dirty on the next tick.
  _lastFrameLines[row] = '\x00dirty';
}

/** Invalidate every row at or below the given 0-based row. For
 *  callers that paint the input zone + anything under it. Same
 *  sentinel semantics as invalidateRenderCacheRow. */
export function invalidateRenderCacheFromRow(row: number): void {
  for (let i = Math.max(0, row); i < _lastFrameLines.length; i++) {
    _lastFrameLines[i] = '\x00dirty';
  }
}

export function render(lines: string[], opts: RenderOptions = {}): void {
  perf.markDrawStart();
  const { rows, cols } = termSize();
  const resized = rows !== _lastFrameRows || cols !== _lastFrameCols;
  const force = opts.force || resized || _lastFrameLines.length === 0;
  const preserveBounds = opts.preserveBounds;
  const maxRows = Math.max(0, rows);
  const lineCount = Math.min(lines.length, maxRows);
  const dirtyRows = Math.max(lineCount, Math.min(_lastFrameLines.length, maxRows));

  // A forced dashboard repaint still keeps an active modal's cells intact:
  // its overlay is appended below in this same write. Once the modal closes,
  // preserveBounds is absent and the normal full reset restores the base.
  let buf = force && !preserveBounds
    ? (ansi.hideCursor + ansi.moveTo(1, 1) + ansi.eraseDown)
    : ansi.hideCursor;
  for (let i = 0; i < dirtyRows; i++) {
    const next = i < lineCount ? lines[i]! : '';
    const prev = _lastFrameLines[i] ?? '';
    if (force || next !== prev) {
      const bounds = preserveBounds;
      const row = i + 1;
      if (bounds && row >= bounds.row && row < bounds.row + bounds.height) {
        const leftWidth = Math.max(0, bounds.col - 1);
        const rightStart = Math.max(0, bounds.col - 1 + bounds.width);
        const rightWidth = Math.max(0, cols - rightStart);
        const left = padAnsiToColumns(sliceAnsiByColumns(next, 0, leftWidth), leftWidth);
        const right = padAnsiToColumns(sliceAnsiByColumns(next, rightStart, rightStart + rightWidth), rightWidth);
        // Update only visible base columns. The popup overlay is appended
        // below and paints the preserved middle cells last in this frame.
        if (leftWidth > 0) buf += ansi.moveTo(row, 1) + left;
        if (rightWidth > 0) buf += ansi.moveTo(row, rightStart + 1) + right;
      } else {
        // Clear only rows that changed. tmux shows full-screen erase/repaint
        // as visible flicker, so keep unchanged rows resident.
        buf += ansi.moveTo(row, 1) + ansi.clearLine + next;
      }
    }
  }
  if (opts.overlay) buf += opts.overlay;
  if (opts.cursor) buf += opts.cursor;
  let writeSettled = false;
  let writeError: Error | null | undefined;
  let rendered = false;
  const finishWrite = () => {
    if (!opts.onWriteComplete || !writeSettled || !rendered) return;
    try { opts.onWriteComplete(writeError); } catch { /* observation must not break rendering */ }
  };
  if (opts.onWriteComplete) {
    process.stdout.write(buf, (error) => {
      writeError = error;
      writeSettled = true;
      finishWrite();
    });
  } else {
    process.stdout.write(buf);
  }
  perf.recordStdoutWrite(buf.length, true);
  perf.markDrawEnd();
  noteInputLagPaint();

  _lastFrameLines = lines.slice(0, lineCount);
  _lastFrameRows = rows;
  _lastFrameCols = cols;

  // Self-observation seam (P1b) — feed the full composed frame to the
  // observer (if any). Guarded: observation must never break the draw.
  // `_lastFrameLines` is mutable + replaced (not mutated in place) on the
  // next render, so a synchronous consumer (the current self-report just
  // join()s it) is safe. An async consumer MUST copy — it receives
  // `readonly string[]` as a reminder, but must not retain the reference.
  if (_frameObserver) {
    try { _frameObserver(_lastFrameLines, { rows, cols }); } catch { /* swallow */ }
  }
  rendered = true;
  finishWrite();
}

