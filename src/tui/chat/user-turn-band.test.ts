import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import { logViewLines, userTurnBandEnabled, userTurnBandRow } from './log-view.js';

// The band colour follows COLORFGBG (turn-band-theme.ts); pin it so the expectation never depends on the terminal
// the tests run in (#38379 REVIEW-1). '15;0' = light text on a dark background → the dark token.
const previousColorfgbg = process.env.COLORFGBG;
beforeEach(() => { process.env.COLORFGBG = '15;0'; });
afterEach(() => { if (previousColorfgbg === undefined) delete process.env.COLORFGBG; else process.env.COLORFGBG = previousColorfgbg; });

const previousNoColor = process.env.NO_COLOR;
afterEach(() => { if (previousNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previousNoColor; });

const turn = (role: 'user' | 'assistant', content: string): SerializedMessage => ({ role, content, ts: '2026-11-17T00:00:00Z' });
// The dark token (COLORFGBG pinned to dark): grey 235 band, grey 252 text — a literal (rule 11).
const BAND = '\x1b[48;5;235;38;5;252m';

test('a user turn is one band per row across the full width; «>» bold, the body normal weight; answers are not banded', () => {
  delete process.env.NO_COLOR;
  const columns = 30;
  const lines = logViewLines([turn('user', 'first line\nsecond line that wraps past the edge'), turn('assistant', 'answer')], columns);
  const banded = lines.filter((line) => line.startsWith(BAND));
  // Both source lines and the wrapped continuation are banded: the band is continuous.
  const userRows = lines.slice(0, lines.indexOf(''));
  expect(banded).toEqual(userRows);
  for (const row of userRows) {
    expect(Bun.stringWidth(row)).toBe(columns);
    expect(row.endsWith('\x1b[0m')).toBe(true);
  }
  expect(userRows[0]).toStartWith(`${BAND}\x1b[1m❯\x1b[22m first line`);
  expect(Bun.stripANSI(userRows[1]!).trimEnd()).toBe('  second line that wraps past');
  expect(lines.some((line) => line.includes('answer') && line.includes(BAND))).toBe(false);
});

test('NO_COLOR keeps «> » and the two-column indent with no escape codes', () => {
  process.env.NO_COLOR = '1';
  const lines = logViewLines([turn('user', 'hello\nworld')], 30);
  expect(lines.slice(0, 2)).toEqual(['❯ hello', '  world']);
  expect(lines.join('').includes('\x1b[')).toBe(false);
});

test('NO_COLOR follows the no-color.org rule: present and non-empty disables color', () => {
  expect(userTurnBandEnabled({})).toBe(true);
  expect(userTurnBandEnabled({ NO_COLOR: '' })).toBe(true);
  expect(userTurnBandEnabled({ NO_COLOR: '1' })).toBe(false);
  expect(userTurnBandRow('❯ hi', 6)).toBe(`${BAND}\x1b[1m❯\x1b[22m hi  \x1b[0m`);
});
