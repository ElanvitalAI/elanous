// NEXT-TUI-USER-TURN-COLOR tone-down (대표 11-18 05:4x): the person's turn band is a quiet neutral grey that sits just off
// the terminal background (dark: a step lighter · light: a step darker), with text that still reads at WCAG ≥ 4.5:1.
// The tokens live here only; log-view.ts paints with them. NO_COLOR is decided by the caller (unchanged).
import { detectTerminalBgLightness } from '../../code-edit/diff-render.js';

export type TurnBandTheme = 'dark' | 'light';

/** xterm-256 greys (232–255 = 8 + 10·(n−232) per channel). 출처: xterm 256-colour grey ramp. */
export const TURN_BAND_TOKENS: Readonly<Record<TurnBandTheme, { readonly bg: number; readonly fg: number }>> = {
  // 235 = #262626 on a black/near-black terminal (≈ 1.4:1 against black); 252 = #d0d0d0 → ≈ 9.9:1.
  dark: { bg: 235, fg: 252 },
  // 255 = #eeeeee on a white terminal (≈ 1.15:1 against white); 235 = #262626 → ≈ 13:1.
  light: { bg: 255, fg: 235 },
};

/** Light only when the terminal says so (COLORFGBG); anything unknown is dark, as before. */
export function turnBandTheme(env: NodeJS.ProcessEnv = process.env): TurnBandTheme {
  return detectTerminalBgLightness(env) === true ? 'light' : 'dark';
}

/** The SGR parameters of the person's turn band for this terminal. */
export function userTurnBandSgr(env: NodeJS.ProcessEnv = process.env): string {
  const token = TURN_BAND_TOKENS[turnBandTheme(env)];
  return `48;5;${token.bg};38;5;${token.fg}`;
}
