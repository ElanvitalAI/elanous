import { expect, test } from 'bun:test';
import { createKeyDecoder, createPrefixFilter, drawView, ENTER_PANE_VIEW, ENTER_VIEW, fitAnsi, fitCells, LEAVE_PANE_VIEW, LEAVE_VIEW, lastScreenText, statusLine } from './attach-view.js';

test('fitCells clips by terminal cells (a wide character is two), pads, and never splits a character', () => {
  expect(fitCells('abc', 5)).toBe('abc  ');
  expect(fitCells('가나다', 5)).toBe('가나 ');
  expect(fitCells('가나다', 6)).toBe('가나다');
  expect(fitCells('abcdef', 3)).toBe('abc');
});

test('drawView: pane lines clipped to the terminal, one row left for the status line, home cursor first', () => {
  const out = drawView({ screen: 'one\ntwo\nthree\nfour\n', cols: 6, rows: 3, status: ' s ' });
  expect(out).toBe('\u001b[H' + ['one   ', 'two   ', '\u001b[7m s    \u001b[0m'].join('\r\n'));
  expect(drawView({ screen: '', cols: 4, rows: 2, status: 'x' })).toBe('\u001b[H    \r\n\u001b[7mx   \u001b[0m');
});

test('drawView drops the emulator header line of a live pane and keeps any other first line', () => {
  const live = '[screen 80x24 cursor=(row 0, col 8, visible true)]\nsh$ ';
  expect(drawView({ screen: live, cols: 6, rows: 3, status: 's' })).toBe('\u001b[H' + ['sh$   ', '      ', '\u001b[7ms     \u001b[0m'].join('\r\n'));
  expect(drawView({ screen: '[not a header]\nx', cols: 14, rows: 3, status: 's' })).toContain('[not a header]');
});

test('statusLine names the pane, an optional note, and how to leave', () => {
  expect(statusLine('w1/t1/p1')).toBe(' w1/t1/p1 · ctrl+b q 분리 ');
  expect(statusLine('p1', 'x')).toBe(' p1 · x · ctrl+b q 분리 ');
});

test('key decoder joins a multi-byte character split across stdin chunks (Korean, emoji) instead of replacing it', () => {
  const decode = createKeyDecoder();
  const bytes = Buffer.from('한글🙂', 'utf8');
  for (let cut = 1; cut < bytes.length; cut++) {
    const fresh = createKeyDecoder();
    expect(fresh(bytes.subarray(0, cut)) + fresh(bytes.subarray(cut))).toBe('한글🙂');
  }
  expect(decode(bytes.subarray(0, 2)) + decode(bytes.subarray(2, 4)) + decode(bytes.subarray(4))).toBe('한글🙂');
  expect(`${decode(bytes.subarray(0, 2))}${decode(bytes.subarray(2))}`.includes('\uFFFD')).toBe(false);
});

test('lastScreenText: emulator header and trailing blank lines are cut, the rest is kept as is', () => {
  expect(lastScreenText('[screen 80x24 cursor=(row 1, col 2, visible true)]\nfoo\n  bar\n\n\n')).toBe('foo\n  bar');
  expect(lastScreenText('plain\n')).toBe('plain');
});

test('prefix keys: ctrl+b q detaches, ctrl+b ctrl+b is one literal ctrl+b, another key after the prefix is dropped and reported, and the prefix survives a chunk boundary', () => {
  const filter = createPrefixFilter();
  expect(filter.feed('ls\r')).toEqual({ send: 'ls\r', detach: false, ignored: '' });
  expect(filter.feed('a\u0002q')).toEqual({ send: 'a', detach: true, ignored: '' });
  expect(filter.feed('\u0002\u0002x')).toEqual({ send: '\u0002x', detach: false, ignored: '' });
  expect(filter.feed('\u0002z')).toEqual({ send: '', detach: false, ignored: 'z' });
  expect(filter.feed('\u0002')).toEqual({ send: '', detach: false, ignored: '' });
  expect(filter.feed('q')).toEqual({ send: '', detach: true, ignored: '' });
});

// ELS-MOUSE-REPORT (JUD #111411 ①): the app view must ASK the terminal for mouse reports, or the SGR click handling never fires.
test('ENTER_VIEW switches to the alt screen and enables mouse reporting (1000 + SGR 1006); LEAVE_VIEW disables it in reverse and leaves the alt screen', () => {
  expect(ENTER_VIEW).toBe('\u001b[?1049h\u001b[?1000h\u001b[?1006h\u001b[2J\u001b[H');
  expect(LEAVE_VIEW).toBe('\u001b[?1006l\u001b[?1000l\u001b[?1049l');
});

test('the single-pane attach view never enables mouse reporting (its stdin goes raw into the pane)', () => {
  expect(ENTER_PANE_VIEW).toBe('\u001b[?1049h\u001b[2J\u001b[H');
  expect(LEAVE_PANE_VIEW).toBe('\u001b[?1049l');
});

test('fitAnsi: colon-form SGR (underline style/colour) is an escape, OSC 8 links and other CSI cost no cells, an open style is closed at the cut', () => {
  const E = '\u001b';
  const link = `${E}]8;;https://example.com/a/very/long/target${E}\\한국${E}]8;;${E}\\`;
  expect(fitAnsi(`${link}abc`, 8)).toBe('한국abc ');
  expect(fitAnsi(`${E}]8;;https://x.test${E}\\ab${E}]8;;\u0007`, 4)).toBe('ab  ');
  expect(fitAnsi(`${E}[4:3;58:5:6mabcdef${E}[0m`, 3)).toBe(`${E}[4:3;58:5:6mabc${E}[0m`);
  expect(fitAnsi(`${E}[4:1mab${E}[0mcd`, 6)).toBe(`${E}[4:1mab${E}[0mcd  `);
  expect(fitAnsi(`${E}[2Kab${E}[?25l`, 3)).toBe('ab ');
});
