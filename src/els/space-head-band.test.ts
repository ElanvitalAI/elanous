import { expect, test } from 'bun:test';
import { spaceHeadBand } from './space-tabs-view.js';

// SIDETAB-SPACE-HEADER-BAND — independent literals (not built from product constants).
const ON = '\u001b[100m';
const OFF = '\u001b[49m';
const B = '\u001b[1m';
const b = '\u001b[22m';
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

test('expanded header: band, ⌄, bold name, count right-aligned', () => {
  expect(spaceHeadBand(false, 'OP', '1', 20)).toBe(`${ON} ⌄ ${B}OP${b}             1 ${OFF}`);
});

test('collapsed header: › glyph', () => {
  expect(spaceHeadBand(true, 'UX', '1', 20)).toBe(`${ON} › ${B}UX${b}             1 ${OFF}`);
});

test('with ✋ count, expanded and collapsed', () => {
  expect(spaceHeadBand(false, 'TC', '16 ✋1', 20)).toBe(`${ON} ⌄ ${B}TC${b}        16 ✋1 ${OFF}`);
  expect(spaceHeadBand(true, 'TC', '16 ✋1', 20)).toBe(`${ON} › ${B}TC${b}        16 ✋1 ${OFF}`);
});

test('every header row is exactly the sidebar width (CJK and emoji aware)', () => {
  for (const width of [8, 12, 20, 28, 40]) {
    for (const [name, right] of [['OP', '1'], ['한글스페이스이름길다', '3 ✋2'], ['TC', '16 ✋1'], ['A-VERY-LONG-SPACE-NAME-HERE', '120']] as const) {
      for (const folded of [false, true]) expect(Bun.stringWidth(plain(spaceHeadBand(folded, name, right, width)))).toBe(width);
    }
  }
});
