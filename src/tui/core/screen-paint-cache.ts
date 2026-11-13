import { wrapAnsiByWidth } from '../../tui-string-width.js';

export interface ScreenPaintDiff {
  readonly clear: boolean;
  readonly changedRows: readonly { readonly row: number; readonly text: string }[];
}

/** Tracks the base TUI frame; invalidate after another owner writes over it. */
export class ScreenPaintCache {
  #previous: readonly (string | undefined)[] | null = null;
  #size = '';

  diff(lines: readonly string[], columns: number, rows: number): ScreenPaintDiff {
    const size = `${columns}x${rows}`;
    const prior = this.#size === size ? this.#previous : null;
    // Writing a row below the physical viewport scrolls the terminal and
    // invalidates every cached position. Only paint rows the terminal owns.
    const visible = lines.slice(0, Math.max(0, rows));
    const changedRows: { row: number; text: string }[] = [];
    for (let row = 0; row < Math.max(visible.length, prior?.length ?? 0); row++) {
      const text = visible[row] ?? '';
      if (prior?.[row] === text) continue;
      changedRows.push({ row, text });
    }
    this.#previous = [...visible];
    this.#size = size;
    return { clear: prior === null, changedRows };
  }

  invalidate(terminalRows: number): void {
    if (this.#previous !== null) {
      // An overlay can paint below the last logical TUI line. Repaint the
      // full viewport on the next frame so those rows are restored too.
      this.#previous = Array.from({ length: Math.max(0, terminalRows) }, () => undefined);
    }
  }
}

/** PTY snapshots contain SGR but no cursor motion; turn their visible rows into paintable cells. */
export function remoteFrameRows(frame: string, columns: number, maxRows: number): string[] {
  const normalized = frame.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!normalized || maxRows <= 0) return [];
  return wrapAnsiByWidth(normalized, columns).slice(-Math.floor(maxRows));
}
