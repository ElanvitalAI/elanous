// 대표 11-18: the person's turn band is a neutral grey just off the terminal background, text ≥ WCAG 4.5:1, per theme.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { TURN_BAND_TOKENS, turnBandTheme, userTurnBandSgr } from './turn-band-theme.js';
import { USER_TURN_BAND_SGR, userTurnBandRow } from './log-view.js';

// The band colour follows COLORFGBG (turn-band-theme.ts); pin it so the expectation never depends on the terminal
// the tests run in (#38379 REVIEW-1). '15;0' = light text on a dark background → the dark token.
const previousColorfgbg = process.env.COLORFGBG;
beforeEach(() => { process.env.COLORFGBG = '15;0'; });
afterEach(() => { if (previousColorfgbg === undefined) delete process.env.COLORFGBG; else process.env.COLORFGBG = previousColorfgbg; });

/** xterm-256 → sRGB channels (0–255). Only the cube and the grey ramp are used here. */
function rgb(n: number): [number, number, number] {
  if (n >= 232) { const v = 8 + 10 * (n - 232); return [v, v, v]; }
  const steps = [0, 95, 135, 175, 215, 255];
  const i = n - 16;
  return [steps[Math.floor(i / 36)]!, steps[Math.floor(i / 6) % 6]!, steps[i % 6]!];
}
const luminance = (n: number) => {
  const [r, g, b] = rgb(n).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
// 출처: #38379 — WCAG 2.x SC 1.4.3 minimum for normal text (AA).
const WCAG_AA_TEXT = 4.5;
// 출처: #38379 — «close to the terminal background»: band-vs-terminal contrast below this (the old band was ≈ 2.9:1).
const QUIET_BAND_MAX = 1.5;
const contrast = (a: number, b: number) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

// The band colours as literals (대표 11-18 toned-down band): the checks below measure these, and the product must equal them.
const BAND = { dark: { bg: 235, fg: 252 }, light: { bg: 255, fg: 235 } } as const;

test('the product tokens are the literal band colours', () => {
  expect(TURN_BAND_TOKENS).toEqual(BAND);
});

test('both themes: text on the band reads at WCAG ≥ 4.5:1', () => {
  for (const theme of ['dark', 'light'] as const) {
    const { bg, fg } = BAND[theme];
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  }
});

test('the band is a neutral grey that sits close to the terminal background (symmetric for dark and light)', () => {
  // A typical dark terminal ≈ black (xterm 16), a light one ≈ white (231).
  const [dark, light] = [BAND.dark.bg, BAND.light.bg];
  for (const n of [dark, light]) { const [r, g, b] = rgb(n); expect(r === g && g === b).toBe(true); }
  expect(contrast(dark, 16)).toBeLessThan(QUIET_BAND_MAX);
  expect(contrast(light, 231)).toBeLessThan(QUIET_BAND_MAX);
  expect(contrast(24, 16)).toBeGreaterThan(QUIET_BAND_MAX); // the old band, for the record
});

test('theme follows COLORFGBG (light only when the terminal says so); the row paints with that token', () => {
  expect(turnBandTheme({})).toBe('dark');
  expect(turnBandTheme({ COLORFGBG: '0;15' })).toBe('light');
  expect(turnBandTheme({ COLORFGBG: '15;0' })).toBe('dark');
  expect(userTurnBandSgr({ COLORFGBG: '0;15' })).toBe('48;5;255;38;5;235');
  expect(USER_TURN_BAND_SGR).toBe('48;5;235;38;5;252');
  expect(userTurnBandRow('> hi', 10)).toStartWith('\x1b[48;5;235;38;5;252m'); // dark (COLORFGBG pinned to dark)
});
