// ELS-POPUP-STYLE (대표 11-26 20:5x «simple · fancy 스타일로 config 에 의해 한번에 바뀔 수 있도록») — ONE style layer for every
// z-axis popup. Elements draw their content in the plain frame (their own render); this layer decides how that frame is
// worn, for all registered popups at once:
//   simple — the element's own frame, untouched (today's look · the default);
//   fancy  — a filled title bar (the state lit) with an optional chip, a shaded panel distinct from the pane under it,
//            speaker gutters for chat elements (you ▌ · answer ▏ · error ▌ red), an input well, key-lit hint footer and a
//            one-cell ▒ drop shadow.
// The switch is ONE config key, `els.popupStyle` (`eln config set els.popupStyle fancy`); anything else reads as simple.
// The attach client re-reads it when the config file changes (an mtime check at most once a second) and the next repaint
// (the 1 s listing poll) draws every popup in the new style — no restart.
//
// The plain text of every row stays the element's own (people and tests read the same words); fancy only adds colours,
// the ✦ mark, the chip, gutters and the shadow. A frame it does not recognise is drawn simple (never a broken popup).
//
// Ideas copied from classic (8/31 export, ~/elanous-hq/ref/elanous-classic-20260831 — src/dashboard NOT imported):
//   src/ui/decor.ts ShadowView — a 1-cell ▒ shadow on the right and bottom edge (the corner cells hang off) ·
//   src/expression/renderer/modal.ts — rounded frame, tinted title bar, variant accent colours ·
//   chat turn styling — the speaker shown by a coloured gutter, the input as its own well.

import { statSync } from 'node:fs';
import { truncateCells, visibleWidth } from './elements/markdown-render.js';

export const POPUP_STYLES = ['simple', 'fancy'] as const;
export type PopupStyle = (typeof POPUP_STYLES)[number];
/** The config key that switches every popup at once. */
export const POPUP_STYLE_KEY = 'els.popupStyle';

/** How an element wears the fancy frame (absent on an element = it is always drawn simple — toasts). */
export interface PopupDress {
  /** A chip on the right of the title bar (e.g. the model tier). */
  readonly chip?: string;
  /** A chat transcript: rows starting «› » are the person's questions, the rows after them the answer (speaker gutters). */
  readonly chat?: boolean;
}

/** A config value → a style. Anything but a known name (absent, a typo, a number) is simple. */
export function popupStyleOf(raw: unknown): PopupStyle {
  return typeof raw === 'string' && (POPUP_STYLES as readonly string[]).includes(raw.trim()) ? raw.trim() as PopupStyle : 'simple';
}

const R = '\u001b[0m';
const SGR_RESET = /\u001b\[0?m/g;
const ANSI = /\u001b\[[0-9;:?<=> ]*[@-~]/g;
const plainOf = (row: string): string => row.replace(ANSI, '');

// 256-colour palette (catppuccin-ish, the classic modal's family). Unfocused = the same shapes in grey.
interface Theme { readonly border: string; readonly bar: string; readonly barText: string; readonly chip: string }
const THEME: Readonly<Record<'focused' | 'idle', Theme>> = {
  focused: { border: '\u001b[38;5;141m', bar: '\u001b[48;5;55m', barText: '\u001b[1;38;5;231m', chip: '\u001b[48;5;183;38;5;17m' },
  idle: { border: '\u001b[38;5;60m', bar: '\u001b[48;5;238m', barText: '\u001b[1;38;5;250m', chip: '\u001b[48;5;245;38;5;234m' },
};
const PANEL = '\u001b[48;5;235m';          // the shaded panel — never the terminal's own background
const WELL = '\u001b[48;5;233m';           // the input well (rows under a ├ rule)
const BUBBLE = '\u001b[48;5;237m';         // a question row
const SHADOW = '\u001b[38;5;236m';
const YOU = '\u001b[38;5;117m';            // cyan gutter: your question
const ANSWER = '\u001b[38;5;141m';         // violet gutter: the answer
const ERROR = '\u001b[38;5;203m';
const KEY = '\u001b[1;38;5;117m';
const DIMMED = '\u001b[38;5;246m';
const LIGHT: Readonly<Record<'waiting' | 'streaming' | 'done', string>> = { waiting: '\u001b[38;5;221m', streaming: '\u001b[38;5;120m', done: '\u001b[38;5;246m' };

/** Below this the shadow and the bar give way to the element's own frame (70% of an 80x24 terminal is 56x16). */
export const FANCY_MIN = { w: 24, h: 7 } as const;
// 출처: 70% of an 80-column terminal = 56 cells — from there up the shadow costs no words that matter.
export const SHADOW_MIN_W = 56;
// 출처: 대표 11-26 (fancy 80x24 capture) — a 16-row popup's bottom shadow lands on the hint line of the float under it; boxes
// shorter than 20 rows (70% of a terminal under ~30 rows) leave the cells around them to the layers below.
export const SHADOW_MIN_H = 20;

/** Paint `content` (exactly `cells` wide, may carry SGR) on a background that survives every reset inside it. */
const onBg = (bg: string, content: string): string => `${bg}${content.replace(SGR_RESET, (reset) => `${reset}${bg}`)}${R}`;

/** The title bar: ` ✦ <title> ` on the filled bar — the title's own words, untouched («Sidechat · ⠸ thinking…», «📓 vault · /»)
 *  — the part after the first « · » lit (amber thinking · green answering · grey otherwise), and the chip on the right when
 *  everything fits (the title wins a narrow box). */
function titleBar(title: string, cells: number, theme: Theme, chipText: string | undefined): string {
  const cut = title.indexOf(' · ');
  const name = cut < 0 ? title : title.slice(0, cut);
  const status = cut < 0 ? '' : title.slice(cut);
  const light = /thinking/.test(status) ? LIGHT.waiting : /answering/.test(status) ? LIGHT.streaming : LIGHT.done;
  const head = truncateCells(` ✦ ${name}${status} `, cells);
  const headCells = visibleWidth(head);
  const nameCells = Math.min(headCells, visibleWidth(` ✦ ${name}`));
  // Split the (maybe truncated) head back into the name and the status part by cells, to colour them apart.
  let left = '';
  let used = 0;
  let rest = '';
  for (const ch of Array.from(head)) { if (used < nameCells) { left += ch; used += visibleWidth(ch); } else rest += ch; }
  const chip = chipText ? ` ${chipText} ` : '';
  const room = cells - headCells;
  const withChip = chip !== '' && room >= visibleWidth(chip) + 1;
  const fill = Math.max(0, room - (withChip ? visibleWidth(chip) : 0));
  return `${theme.bar}${theme.barText}${left}${R}${theme.bar}${light}${rest}${R}${theme.bar}${' '.repeat(fill)}${R}${withChip ? `${theme.chip}${chip}${R}` : ''}`;
}

/** The hint footer: «Enter send · Esc close» with the keys lit (the words themselves unchanged), right-aligned. */
function hintFooter(help: string, cells: number, theme: Theme): string {
  const text = truncateCells(help ? ` ${help} ` : '', Math.max(0, cells - 1));
  const lit = text.split(' · ').map((part) => part.replace(/^(\s*)(\S+)/, `$1${KEY}$2${R}${DIMMED}`)).join(` ${R}${theme.border}·${R}${DIMMED} `);
  const rule = Math.max(0, cells - visibleWidth(text));
  return `${theme.border}╰${'─'.repeat(rule)}${R}${DIMMED}${lit}${R}${theme.border}╯${R}`;
}

const TOP = /^[╭┌].*[╮┐]$/;
const BOTTOM = /^[╰└].*[╯┘]$/;

/** Restyle an element's framed rows (╭/┌ title · │ rows · optional ├ rule · ╰/└ hints). Undefined = a row it does not
 *  recognise (the caller then keeps the element's own frame). `inAnswer` = a chat whose first visible rows are an answer
 *  (its question scrolled off the top). */
export function fancyFrame(rows: readonly string[], focused: boolean, dress: PopupDress, inAnswer = false): string[] | undefined {
  const theme = focused ? THEME.focused : THEME.idle;
  const top = plainOf(rows[0] ?? '');
  const bottom = plainOf(rows.at(-1) ?? '');
  if (rows.length < 3 || !TOP.test(top) || !BOTTOM.test(bottom)) return undefined;
  const cells = visibleWidth(top) - 2;
  const title = top.slice(1, -1).replace(/^─+/, '').replace(/─+$/, '').trim();
  const help = bottom.slice(1, -1).replace(/^─+/, '').replace(/─+$/, '').trim();
  const sep = rows.findIndex((row) => plainOf(row).startsWith('├'));
  const out = [`${theme.border}╭${R}${titleBar(title, cells, theme, dress.chip)}${theme.border}╮${R}`];
  let speaker: 'you' | 'answer' | undefined = dress.chat && inAnswer ? 'answer' : undefined;
  for (let at = 1; at < rows.length - 1; at++) {
    const row = rows[at]!;
    const flat = plainOf(row);
    if (flat.startsWith('├')) { out.push(`${theme.border}├${'╌'.repeat(cells)}┤${R}`); continue; }
    if (!flat.startsWith('│') || !flat.endsWith('│')) return undefined;
    // The content between the frame's two │: cut at the first and the last │ (the element paints each as COLOUR│RESET).
    let content = row.slice(row.indexOf('│') + 1, row.lastIndexOf('│')).replace(/^\u001b\[0m/, '').replace(/(\u001b\[[0-9;]*m)+$/, '');
    const text = flat.slice(1, -1);
    const input = sep >= 0 && at > sep;
    let bg = input ? WELL : PANEL;
    const header = at === 1 && text.trimStart().startsWith('context: ');     // sidechat A1's dim context row: no speaker
    if (dress.chat && !input && !header) {
      const question = text.trimStart().startsWith('› ');
      if (question) speaker = 'you';
      else if (speaker === 'you' && text.trim()) speaker = 'answer';
      const gutter = text.includes('⚠ ') ? `${ERROR}▌` : question ? `${YOU}▌` : speaker === 'answer' && text.trim() ? `${ANSWER}▏` : '';
      if (question) bg = BUBBLE;
      // The leading pad cell becomes the gutter; the words do not move.
      if (gutter && content.startsWith(' ')) content = `${gutter}${R}${content.slice(1)}`;
    }
    out.push(`${theme.border}│${R}${onBg(bg, content)}${theme.border}│${R}`);
  }
  out.push(hintFooter(help, cells, theme));
  return out;
}

/** What the style layer needs from an element (a subset of ElementDef). */
export interface StyledElement<P> {
  readonly render: (props: P, size: { readonly w: number; readonly h: number }, focused: boolean) => readonly string[];
  readonly dress?: PopupDress;
}

/** Draw one popup in `style`. simple = the element's own rows. fancy = the dressed frame, and on a box of at least
 *  SHADOW_MIN_W × SHADOW_MIN_H cells a ▒ shadow in its last column and row (classic ShadowView: the top-right and bottom-left cells hang
 *  off); a narrower box keeps every cell for the text; a tiny box, an element without a dress or an unknown frame = simple. */
export function paintPopup<P>(def: StyledElement<P>, props: P, size: { readonly w: number; readonly h: number }, focused: boolean, style: PopupStyle): readonly string[] {
  const { w, h } = size;
  if (style !== 'fancy' || !def.dress || w < FANCY_MIN.w || h < FANCY_MIN.h) return def.render(props, size, focused);
  const shadow = w >= SHADOW_MIN_W && h >= SHADOW_MIN_H;
  const framed = def.render(props, shadow ? { w: w - 1, h: h - 1 } : size, focused);
  const turns = (props as { turns?: unknown } | undefined)?.turns;
  const dressed = fancyFrame(framed, focused, def.dress, Array.isArray(turns) && turns.length > 0);
  if (!dressed) return def.render(props, size, focused);
  if (!shadow) return dressed;
  return [
    `${dressed[0]} `,
    ...dressed.slice(1).map((row) => `${row}${SHADOW}▒${R}`),
    ` ${SHADOW}${'▒'.repeat(w - 1)}${R}`,
  ];
}

/** The live style for an attach client: `read` gives the raw config value, `stamp` the config file's change stamp (mtime;
 *  undefined = no file). The value is re-read only when the stamp changes, and the stamp is looked at most once per
 *  `everyMs` — so every paint may call `get()` (no file read on the typing path). */
export function popupStyleSource(deps: { readonly read: () => unknown; readonly stamp: () => number | undefined; readonly now?: () => number; readonly everyMs?: number }): { readonly get: () => PopupStyle } {
  const now = deps.now ?? Date.now;
  // 출처: the attach app's listing poll is 1 s (pollMs) — a flip shows on the next poll's repaint.
  const everyMs = deps.everyMs ?? 1_000;
  let checkedAt = -Infinity;
  let stamp: number | undefined | null = null;
  let style: PopupStyle = 'simple';
  return {
    get: () => {
      if (now() - checkedAt < everyMs) return style;
      checkedAt = now();
      let next: number | undefined;
      try { next = deps.stamp(); } catch { next = undefined; }
      if (next === stamp) return style;
      stamp = next;
      try { style = popupStyleOf(deps.read()); } catch { style = 'simple'; }
      return style;
    },
  };
}

/** The production source: this universe's elanous config file, the raw key `els.popupStyle` (read straight from the file —
 *  the typed config view keeps only the keys it knows, and a re-read here must not reset another reader's cache). */
export function configPopupStyleSource(): { readonly get: () => PopupStyle } {
  const config = (): typeof import('../user-config.js') => require('../user-config.js') as typeof import('../user-config.js');
  return popupStyleSource({
    stamp: () => statSync(config().userConfigPath()).mtimeMs,
    read: () => {
      const { readUserConfigObject } = require('../user-config/read.js') as typeof import('../user-config/read.js');
      const raw = readUserConfigObject(config().userConfigPath());
      const els = raw?.els;
      return els && typeof els === 'object' && !Array.isArray(els) ? (els as Record<string, unknown>).popupStyle : undefined;
    },
  });
}
