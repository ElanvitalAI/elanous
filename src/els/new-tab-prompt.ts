// ELS-NEW-TAB-NAME-WIDGET (대표 11-21): the herdr-look prompt row for a new tab's name —
//   « new tab [name▏        ] ↵ save  ^c clear  esc cancel »
// Pure state machine: key bytes in, one ANSI row out (the app draws it as the overlay row under the tab row and routes keys here
// while it is open, so nothing typed reaches the pane). Saving hands the cleaned name to `deps.save`; an empty name saves '' (the
// default tab, as `ctrl+b c` made before).
//
// Reuse notes (HAND-TUI-D design ELS-HERDR-LOOK-INVENTORY-AND-MIGRATION-1121 §1.5 (a)): the key map is the classic single-line
// input's (src/ui/widgets/edit-view.ts EditView: ←/→/Home/End/Backspace/Delete, Enter = submit, Esc = cancel, a maxLength), and the
// name is cleaned with core.ts clean(). EditView itself is NOT imported: it draws into the classic Printer cell grid with the
// theme palette `C` (src/tui.ts), counts UTF-16 units not cells, and has no Ctrl+C = clear — importing it would drag the classic
// stack into the els client. Only its pure editing rules are carried here, on graphemes and terminal cells (Bun.stringWidth, the
// same width the els view uses), so a Korean or wide glyph is one step of the cursor and two cells of the field.

import { clean } from './core.js';

/** The name's length cap in terminal cells (a wide glyph is two). */
export const NEW_TAB_NAME_MAX_CELLS = 40;
const HINT = ' ↵ save  ^c clear  esc cancel';
const LABEL = ' new tab ';
const ESC = '\u001b';
const REVERSE = `${ESC}[7m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const graphemes = new Intl.Segmenter();
const split = (text: string): string[] => [...graphemes.segment(text)].map((part) => part.segment);
/** C0, DEL and C1 are never name text (ESC, CR, NL, … would drive the terminal instead of typing). */
const isControl = (char: string): boolean => /^[\u0000-\u001f\u007f-\u009f]$/.test(char);

export interface NewTabPromptDeps {
  /** Enter: the cleaned name ('' = the default tab). The prompt is already closed. */
  readonly save: (name: string) => void;
  /** The row changed: repaint. */
  readonly changed: () => void;
}

export function createNewTabPrompt(deps: NewTabPromptDeps) {
  let open = false;
  let text = '';
  let cursor = 0;                                      // in graphemes
  const close = (): void => { open = false; text = ''; cursor = 0; deps.changed(); };
  const insert = (char: string): void => {
    const before = split(text).slice(0, cursor).join('') + char;
    const next = before + split(text).slice(cursor).join('');
    if (Bun.stringWidth(next) > NEW_TAB_NAME_MAX_CELLS) return;           // at the cap: the key is dropped
    text = next;
    cursor = split(before).length;
  };
  const edit = (sequence: string): void => {
    const parts = split(text);
    if (sequence === 'D') cursor = Math.max(0, cursor - 1);
    else if (sequence === 'C') cursor = Math.min(parts.length, cursor + 1);
    else if (sequence === 'H' || sequence === '1~' || sequence === '7~') cursor = 0;
    else if (sequence === 'F' || sequence === '4~' || sequence === '8~') cursor = parts.length;
    else if (sequence === '3~' && cursor < parts.length) { parts.splice(cursor, 1); text = parts.join(''); }
  };
  return {
    openPrompt(): void { open = true; text = ''; cursor = 0; deps.changed(); },
    isOpen: (): boolean => open,
    value: (): string => text,
    /** Keys while open: every byte is consumed here (a stray escape sequence is dropped, never typed). */
    feed(bytes: string): void {
      const chars = [...bytes];
      for (let at = 0; at < chars.length && open; at++) {
        const char = chars[at]!;
        if (char === ESC) {
          const next = chars[at + 1];
          if (next !== '[' && next !== 'O') { close(); return; }              // a lone Esc (or Alt+key) = cancel
          let end = at + 2;
          while (end < chars.length && !/[@-~]/.test(chars[end]!)) end++;
          edit(chars.slice(at + 2, end + 1).join(''));
          at = end;
        } else if (char === '\r' || char === '\n') { const name = clean(text); close(); deps.save(name); return; }
        else if (char === '\u0003') { text = ''; cursor = 0; }                // Ctrl+C = clear the buffer (the prompt stays)
        else if (char === '\u007f' || char === '\b') {
          if (cursor > 0) { const parts = split(text); parts.splice(cursor - 1, 1); text = parts.join(''); cursor--; }
        } else if (!isControl(char)) insert(char);
      }
      if (open) deps.changed();
    },
    /** The prompt row, `cols` cells wide (the field shrinks, then drops the hint, on a narrow terminal). */
    line(cols: number): string {
      const hint = cols >= Bun.stringWidth(LABEL) + 12 + Bun.stringWidth(HINT) ? HINT : '';
      const field = Math.max(3, Math.min(NEW_TAB_NAME_MAX_CELLS + 1, cols - Bun.stringWidth(LABEL) - Bun.stringWidth(hint) - 2));
      let parts = split(text);
      let at = cursor;
      while (parts.length > 0 && Bun.stringWidth(parts.slice(0, at).join('')) > field - 2) { parts = parts.slice(1); at--; }   // scroll so the caret stays in the field
      const caret = parts[at] ?? ' ';
      const shown = `${parts.slice(0, at).join('')}${REVERSE}${caret}${RESET}${parts.slice(at + (parts[at] === undefined ? 0 : 1)).join('')}`;
      const used = Bun.stringWidth(parts.join('')) + (parts[at] === undefined ? 1 : 0);
      return `${REVERSE}${LABEL}${RESET}[${shown}${' '.repeat(Math.max(0, field - used))}]${DIM}${hint}${RESET}`;
    },
  };
}
