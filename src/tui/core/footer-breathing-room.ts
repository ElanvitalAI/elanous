// TUI-FOOTER-BREATHING-ROOM (대표 11-18 14:3x capture: «하단이 스페이스 없이 붙어 답답함»): the bottom
// area's spare rows. Pure decisions with literal expectations (footer-breathing-room.test.ts); the
// entry draws from them (src/tui/entry.ts).

/** Rows the breathing bottom needs besides the header and the footer: ③ one margin row after the
 * conversation, ② one blank row above the input, the separator over the input (the old rule stays,
 * 대표 r2), the input row, ① the separator under the input, the bottom status line, and at least one
 * conversation row. */
export const FOOTER_BREATHING_MIN_ROWS = 7;

/** The bottom area breathes — two blank rows and the old separator over the input, plus a thin
 * separator between the input and the bottom status line (대표 r2: both rules) — only on a roomy
 * screen: taller than the compact height (at or under it the spare rows fold first ④ and today's
 * tight layout stays, so the #38392 separator lock keeps its row), with the bottom status line on,
 * and with every bottom row plus one conversation row fitting beside the header and the footer. */
export function footerBreathingRoom(input: {
  readonly rows: number;
  readonly headerRows: number;
  readonly footerRows: number;
  readonly compactHeight: number;
  readonly bottomStatus: boolean;
}): boolean {
  return input.bottomStatus
    && input.rows > input.compactHeight
    && input.rows - input.headerRows - input.footerRows >= FOOTER_BREATHING_MIN_ROWS;
}
