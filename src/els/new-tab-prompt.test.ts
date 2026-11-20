import { expect, test } from 'bun:test';
import { createNewTabPrompt, NEW_TAB_NAME_MAX_CELLS } from './new-tab-prompt.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
function prompt() {
  const saved: string[] = [];
  let repaints = 0;
  const p = createNewTabPrompt({ save: (name) => { saved.push(name); }, changed: () => { repaints++; } });
  p.openPrompt();
  return { p, saved, repaints: () => repaints };
}

test('type, backspace, left/right edit at the caret; Enter saves the typed name and closes', () => {
  const { p, saved } = prompt();
  p.feed('abd'); p.feed('\u001b[D'); p.feed('c');                 // abcd (caret moved left once, then c inserted)
  expect(p.value()).toBe('abcd');
  p.feed('\u007f'); expect(p.value()).toBe('abd');
  p.feed('\u001b[H'); p.feed('\u001b[3~'); expect(p.value()).toBe('bd');   // Home, Delete
  p.feed('\u001b[F'); p.feed('x\r');
  expect(saved).toEqual(['bdx']);
  expect(p.isOpen()).toBe(false);
});

test('Ctrl+C clears the buffer and keeps the prompt open; Esc cancels without saving; empty Enter saves the empty (default) name', () => {
  const { p, saved } = prompt();
  p.feed('hello'); p.feed('\u0003');
  expect(p.value()).toBe('');
  expect(p.isOpen()).toBe(true);
  p.feed('abc'); p.feed('\u001b');
  expect(p.isOpen()).toBe(false);
  expect(saved).toEqual([]);
  p.openPrompt(); expect(p.value()).toBe('');                    // reopened empty
  p.feed('\r');
  expect(saved).toEqual(['']);
});

test('Korean and wide glyphs: one cursor step each, two cells each; the cap is in cells', () => {
  const { p } = prompt();
  p.feed('한국어'); p.feed('\u001b[D'); p.feed('\u007f');
  expect(p.value()).toBe('한어');                                 // backspace removed exactly one glyph
  p.feed('가'.repeat(30));
  expect(Bun.stringWidth(p.value())).toBe(NEW_TAB_NAME_MAX_CELLS);   // 20 wide glyphs fill it; the rest was dropped
  p.feed('a');
  expect(Bun.stringWidth(p.value())).toBe(NEW_TAB_NAME_MAX_CELLS);
});

test('control bytes are never name text: they are dropped, and an unknown escape sequence is swallowed whole', () => {
  const { p, saved } = prompt();
  p.feed('a\u0000\u0007\u0015\tb\u009bc\u001b[1;5Zd');
  expect(p.value()).toBe('abcd');
  p.feed('\u001b[200~'); expect(p.isOpen()).toBe(true);
  p.feed('\r');
  expect(saved).toEqual(['abcd']);
});

test('the row reads «new tab [name] ↵ save ^c clear esc cancel», one terminal row, and a narrow row drops the hint', () => {
  const { p } = prompt();
  p.feed('work');
  expect(strip(p.line(100))).toContain(' new tab [work ');
  expect(strip(p.line(100))).toContain('↵ save  ^c clear  esc cancel');
  expect(strip(p.line(20))).not.toContain('save');
});
