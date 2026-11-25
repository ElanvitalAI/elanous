// ELS-EXIT-BG-BUTTONS (OP #102571): two buttons at the right end of the attach screen's bottom line, like the tab row —
// short words, no frames. ⏏ 백그라운드 = leave els running and go back to the shell (same as ctrl+b q); ✕ 종료 = close this
// space's panes and leave (asks first when something in it is running). Pure: the text, where each button sits, and which
// one a click at column x hits.

export type ButtonId = 'background' | 'quit';

export const BUTTONS: readonly { readonly id: ButtonId; readonly label: string }[] = [
  { id: 'background', label: '⏏ Background' },
  { id: 'quit', label: '✕ Quit' },
];
const GAP = '  ';

/** The buttons as one string (a leading and trailing space), and each button's 1-based columns when it ends at `cols`. */
export function buttonsLayout(cols: number): { readonly text: string; readonly at: readonly { readonly id: ButtonId; readonly from: number; readonly to: number }[] } {
  const text = ` ${BUTTONS.map((button) => button.label).join(GAP)} `;
  let x = cols - Bun.stringWidth(text) + 1 + 1;          // 1-based column of the first label (after the leading space)
  const at = BUTTONS.map((button) => {
    const width = Bun.stringWidth(button.label);
    const place = { id: button.id, from: x, to: x + width - 1 };
    x += width + Bun.stringWidth(GAP);
    return place;
  });
  return { text, at };
}

/** Which button a click on the bottom line at 1-based column `x` hits (none when the screen is too narrow to show them). */
export function hitButton(x: number, cols: number): ButtonId | null {
  const { text, at } = buttonsLayout(cols);
  if (Bun.stringWidth(text) > cols) return null;
  return at.find((button) => x >= button.from && x <= button.to)?.id ?? null;
}
