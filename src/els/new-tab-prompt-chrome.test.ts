// ELS-NEW-TAB-STANDARD-CHROME: the "+" new-tab dialog wears the yes/no confirm popup's chrome
// (src/approval-modal.ts → confirmPopupDialogChrome: theme tokens + static modalChrome rail + centred
// modal-dialog chromeSpec). Expectations are literals (frame glyphs, truecolor SGR of the default
// catppuccin-mocha modalChrome tokens) — not re-derived from the product's own helpers.
import { expect, test } from 'bun:test';
import { createNewTabPrompt } from './new-tab-prompt.js';
import { confirmPopupDialogChrome } from '../ui/chrome/dialog-chrome.js';
import { DEFAULT_THEME_TOKENS } from '../theme/tokens.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const BORDER_ACTIVE = '\u001b[38;2;137;180;250m';                       // modalChrome.borderActive #89b4fa
// The Printer re-serialises cell styles: bold first for the title bar; the close cell keeps its fg only.
const TITLE_TEXT = '\u001b[1;38;2;205;214;244;48;2;49;50;68m';           // modalChrome.titleText #cdd6f4 on #313244 bold
const CLOSE_BUTTON = '\u001b[38;2;243;139;168m ✕ ';                       // modalChrome.closeButton #f38ba8

function openBox(cols = 80, rows = 24, sidebar = 0) {
  const p = createNewTabPrompt({ save: () => {}, changed: () => {} });
  p.openPrompt();
  p.feed('work');
  return p.box(cols, rows, sidebar);
}

test('the confirm-popup chrome helper is the static modalChrome rail with a centred double dialog frame and a close glyph', () => {
  expect(confirmPopupDialogChrome('새 탭 이름', DEFAULT_THEME_TOKENS)).toEqual({
    theme: DEFAULT_THEME_TOKENS,
    chrome: 'static',
    chromeSpec: { variant: 'dialog', title: '새 탭 이름', titleAlign: 'center', showClose: true },
  });
  expect(confirmPopupDialogChrome('t', undefined).chrome).toBe('legacy');
});

test('new-tab dialog frame = confirm popup structure: double border, centred title, ✕ close, 7×48 cells', () => {
  const box = openBox();
  expect(box.width).toBe(48);
  expect(box.lines.length).toBe(7);
  const rows = box.lines.map(strip);
  expect(rows[0]).toBe('╔' + ' '.repeat(20) + '새 탭 이름' + ' '.repeat(14) + '✕ ╗');
  expect(rows[1]!.startsWith('║Name')).toBe(true);
  expect(rows[1]!.endsWith('║')).toBe(true);
  expect(rows[6]).toBe('╚' + '═'.repeat(46) + '╝');
  for (const row of rows) expect(Bun.stringWidth(row)).toBe(48);
});

test('new-tab dialog paints the modalChrome tokens: active border, title bar text, close button', () => {
  const box = openBox();
  expect(box.lines[0]).toContain(BORDER_ACTIVE);
  expect(box.lines[0]).toContain(TITLE_TEXT);
  expect(box.lines[0]).toContain(CLOSE_BUTTON);
  expect(box.lines[6]).toContain(BORDER_ACTIVE);
});

test('the spliced name field and its caret survive inside the standard frame (single-frame composition input)', () => {
  const box = openBox(80, 24, 29);
  const field = strip(box.lines[2]!);
  expect(field.startsWith('║ ')).toBe(true);
  expect(field).toContain('work▎');
  expect(field.endsWith('║')).toBe(true);
  expect(box.x).toBe(29 + Math.floor((51 - 48) / 2));
});
