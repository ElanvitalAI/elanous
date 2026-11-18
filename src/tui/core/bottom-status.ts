// DESIGN §2b (#38392): when the status line is the last row, and what it may show there.
// Pure decisions, tested across screen height × panel × turn × layout (src/tui/core/bottom-status.test.ts).

/**
 * Keep the status line under the input unless the screen cannot hold it: the header, the footer (an open panel or an
 * approval included), one input row, the status line and at least one conversation row must all fit. A panel alone
 * never removes it (#38392 r2 ①) — only a lack of rows does, and then the status line is the first thing to go.
 */
export function keepBottomStatus(input: { readonly rows: number; readonly headerRows: number; readonly footerRows: number }): boolean {
  // 출처: #38392 r2 — one input row, the status row itself, and one row of conversation.
  const INPUT_ROWS = 1;
  const STATUS_ROWS = 1;
  const MIN_BODY_ROWS = 1;
  return input.rows - input.headerRows - input.footerRows - INPUT_ROWS - STATUS_ROWS >= MIN_BODY_ROWS;
}
