// ELS new-tab prompt: retain grapheme-aware key handling while drawing the shared
// Dialog and EditView centered in the available pane. The frame is the yes/no confirm
// popup's standard chrome (confirmPopupDialogChrome: theme tokens + static modalChrome
// rail + centred modal-dialog chromeSpec) — never a hand-drawn box. Enter closes the prompt and
// hands the cleaned name to deps.save; an empty name selects the default tab.

import { clean } from './core.js';
import { Dialog } from '../ui/widgets/dialog.js';
import { confirmPopupDialogChrome } from '../ui/chrome/dialog-chrome.js';
import { DEFAULT_THEME_TOKENS } from '../theme/tokens.js';
import { EditView } from '../ui/widgets/edit-view.js';
import { Printer } from '../ui/printer.js';
import type { View, Size } from '../ui/view.js';
import { spliceCells, type DialogBox } from './attach-view.js';

/** The name's length cap in terminal cells (a wide glyph is two). */
export const NEW_TAB_NAME_MAX_CELLS = 40;
const HINT = ' ↵ save  ^c clear  esc cancel';
const LABEL = ' new tab ';
const NEW_TAB_TITLE = '새 탭 이름';
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
  readonly save: (name: string) => void | Promise<boolean | 'unknown'>;
  /** The row changed: repaint. */
  readonly changed: () => void;
}

export function createNewTabPrompt(deps: NewTabPromptDeps) {
  let open = false;
  let text = '';
  let fits = true;
  let cursor = 0;                                      // in graphemes
  let saving = false;
  let unknown = false;
  let duplicateRisk = false;
  const close = (): void => {
    open = false;
    // A risky retry selection is not a resolution: cancelling it must not
    // turn a later reopen into an unguarded fresh creation.
    if (duplicateRisk) unknown = true;
    if (!unknown) { text = ''; cursor = 0; duplicateRisk = false; }
    deps.changed();
  };
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
  const prompt = {
    openPrompt(): void { open = true; if (!unknown) { text = ''; cursor = 0; } deps.changed(); },
    isOpen: (): boolean => open,
    isSaving: (): boolean => saving,
    value: (): string => text,
    /** Keys while open: every byte is consumed here (a stray escape sequence is dropped, never typed). */
    feed(bytes: string): void {
      if (saving) return;
      if (!fits) { if (bytes === ESC) close(); return; }
      if (unknown) {
        if (bytes === ESC) close();
        else if (bytes[0] === 'r' || bytes[0] === 'R') { unknown = false; duplicateRisk = true; deps.changed(); } // discard the rest: retry requires a fresh Enter
        return;
      }
      // A risky retry must target the unresolved name and require a distinct Enter.
      if (duplicateRisk && bytes !== ESC && bytes !== '\r' && bytes !== '\n') return;
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
        } else if (char === '\r' || char === '\n') {
          const result = deps.save(clean(text));
          if (result === undefined) { unknown = false; duplicateRisk = false; close(); }
          else {
            saving = true;
            void result.then((ok) => { saving = false; if (ok === true) { unknown = false; duplicateRisk = false; close(); } else { unknown = ok === 'unknown'; deps.changed(); } }, () => { saving = false; unknown = true; deps.changed(); });
          }
          return;
        }
        else if (char === '\u0003') { text = ''; cursor = 0; }                // Ctrl+C = clear the buffer (the prompt stays)
        else if (char === '\u007f' || char === '\b') {
          if (cursor > 0) { const parts = split(text); parts.splice(cursor - 1, 1); text = parts.join(''); cursor--; }
        } else if (!isControl(char)) insert(char);
      }
      if (open) deps.changed();
    },
    /** ELS-APP-RENDER-SINGLE-FRAME: the dialog as rows at (x, y) — composeView splices them into the one composed frame
     *  (no separate cursor-addressed overlay write). The sidebar (`sidebar` columns on the left) is never covered. */
    box(cols: number, rows: number, sidebar = 0): DialogBox {
      const left = Math.max(0, Math.min(cols, sidebar));
      const available = cols - left;
      fits = available >= 24 && rows >= 7;
      if (!fits) return { x: left, y: 0, width: available, lines: ['Screen too small - Esc'.slice(0, Math.max(0, available))] };
      const width = Math.min(48, available - 2);
      const height = 7;
      const x = left + Math.floor((available - width) / 2), y = Math.floor((rows - height) / 2);
      const pieces = split(text);
      let start = 0;
      while (start < cursor && Bun.stringWidth(pieces.slice(start, cursor).join('')) > width - 6) start++;
      const before = pieces.slice(start, cursor).join('');
      const remaining = width - 4 - Bun.stringWidth(before) - 1;
      let after = '';
      for (const piece of pieces.slice(cursor)) {
        if (Bun.stringWidth(after + piece) > remaining) break;
        after += piece;
      }
      // Printer currently splits ZWJ graphemes into cells. Keep the shared
      // EditView as the field, then paint its clipped contents intact below.
      const input = new EditView({ initialValue: before });
      input.takeFocus();
      const body: View = {
        draw(p) {
          p.text(0, 0, 'Name');
          input.draw(p.sub(1, 1, Math.max(0, p.width - 2), 1, { focused: true }));
          p.text(0, 2, unknown ? (p.width < 31 ? 'Outcome unknown' : 'Outcome unknown: duplicate risk') : duplicateRisk ? (p.width < 30 ? 'Duplicate risk' : 'Duplicate risk: Enter to retry') : 'Enter save  ^C clear');
          p.text(0, 3, unknown ? (p.width < 31 ? 'R duplicate risk Esc' : 'Inspect tabs; R retry; Esc close') : duplicateRisk && p.width < 30 ? 'Enter retry; Esc' : 'Esc cancel');
        },
        onEvent: (ev) => input.onEvent(ev),
        layout: (_size: Size) => {},
        requiredSize: (size: Size) => size,
        takeFocus: () => input.takeFocus(),
      };
      const dialog = new Dialog({ title: NEW_TAB_TITLE, body, buttons: [], onSubmit: () => {}, ...confirmPopupDialogChrome(NEW_TAB_TITLE, DEFAULT_THEME_TOKENS) });
      dialog.layout({ width, height });
      const printer = Printer.create({ width, height, focused: true });
      dialog.draw(printer);
      const lines = printer.lines().map((line) => `${RESET}${line}${RESET}`);
      // The field row (third line): cells 2 … width-2 carry the clipped name with its caret, graphemes intact.
      lines[2] = spliceCells(lines[2]!, 2, `${before}▎${after}`, width - 4);
      return { x, y, width, lines };
    },
    /** The box serialised cursor-addressed (one CUP per row) — kept for callers that paint the dialog on its own. */
    dialog(cols: number, rows: number, sidebar = 0): string {
      const box = prompt.box(cols, rows, sidebar);
      return box.lines.map((line, i) => `\u001b[${box.y + i + 1};${box.x + 1}H\u001b[0m${line}`).join('') + '\u001b[?25l';
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
  return prompt;
}
