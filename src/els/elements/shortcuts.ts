// ELS-SHORTCUTS-POPUP (대표 11-28 19:2x) — ctrl+b ? : every els key at a glance, as a popup on the ELS-ZAXIS overlay stack.
// The rows are GENERATED from the one key table (key-bindings.ts shortcutSections) — this file holds no key of its own.
// Wide boxes show two columns (column-major, a group heading never ends a column), narrow boxes one; taller than the box =
// ↑↓ / PgUp PgDn / Home End scroll. The context it was opened in (tile grid · popup terminal · a focused popup) puts that
// group first. Esc (the overlay's own close) or ctrl+b ? again closes it.

import { fitAnsi } from '../attach-view.js';
import { SHORTCUT_CONTEXTS, shortcutSections, type ShortcutContext } from '../key-bindings.js';
import type { ElementDef } from './element.js';
import { truncateCells, visibleWidth } from './markdown-render.js';

export interface ShortcutsProps {
  readonly context: ShortcutContext;
  /** First shown line (clamped to the content when drawn). */
  readonly scroll: number;
}

const FRAME = '\u001b[36m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const R = '\u001b[0m';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function shortcutsProps(raw: unknown): ShortcutsProps | undefined {
  if (raw !== undefined && !isRecord(raw)) return undefined;
  const value = (raw ?? {}) as Record<string, unknown>;
  const context = SHORTCUT_CONTEXTS.includes(value.context as ShortcutContext) ? value.context as ShortcutContext : 'normal';
  const scroll = typeof value.scroll === 'number' && Number.isInteger(value.scroll) && value.scroll > 0 ? Math.min(value.scroll, lineCount(context) - 1) : 0;
  return { context, scroll };
}

/** One printable line of the list: a group heading or a «chord  label» row. */
type Line = { readonly heading: string } | { readonly chord: string; readonly label: string };
const linesOf = (context: ShortcutContext): Line[] => shortcutSections(context).flatMap((section) => [{ heading: section.group }, ...section.rows.map((one) => ({ chord: one.chord, label: one.label }))]);
const lineCount = (context: ShortcutContext): number => linesOf(context).length;

/** What the title says about where the popup was opened. */
const TITLES: Readonly<Record<ShortcutContext, string>> = {
  normal: 'Shortcuts · press ctrl+b, then the key',
  tile: 'Shortcuts · Tile view: Enter = back to the pane',
  'popup-term': 'Shortcuts · on the popup terminal',
  overlay: 'Shortcuts · on a popup',
};

/** Each line's chord column width: the widest chord of its own group (a group's labels line up; groups do not have to). */
function chordWidths(lines: readonly Line[]): number[] {
  const widths: number[] = [];
  let start = 0;
  const close = (end: number): void => {
    const widest = Math.max(0, ...lines.slice(start, end).map((one) => 'chord' in one ? visibleWidth(one.chord) : 0));
    for (let at = start; at < end; at++) widths[at] = widest;
  };
  lines.forEach((one, at) => { if ('heading' in one && at > start) { close(at); start = at; } });
  close(lines.length);
  return widths;
}
/** A column of lines drawn `width` cells wide: headings bold, chords padded to their group's widest chord. */
function column(lines: readonly Line[], width: number): string[] {
  const widths = chordWidths(lines);
  return lines.map((one, at) => 'heading' in one
    ? fitAnsi(`${BOLD}${truncateCells(one.heading, width)}${R}`, width)
    : fitAnsi(` ${one.chord}${' '.repeat(Math.max(0, widths[at]! - visibleWidth(one.chord)))}  ${DIM}${truncateCells(one.label, Math.max(0, width - widths[at]! - 3))}${R}`, width));
}
const naturalWidth = (lines: readonly Line[]): number => {
  const widths = chordWidths(lines);
  return Math.max(...lines.map((one, at) => 'heading' in one ? visibleWidth(one.heading) : 1 + widths[at]! + 2 + visibleWidth(one.label)));
};

/** The list laid out for `inner` cells: two columns when both fit side by side at their natural width, else one. */
export function shortcutsLayout(context: ShortcutContext, inner: number): { readonly columns: 1 | 2; readonly lines: readonly string[] } {
  const lines = linesOf(context);
  let cut = Math.ceil(lines.length / 2);
  while (cut > 0 && 'heading' in lines[cut - 1]!) cut--;             // a heading never ends the left column
  const left = lines.slice(0, cut);
  // A group split across the columns says so on top of the right one.
  const open = [...left].reverse().find((one): one is { heading: string } => 'heading' in one);
  const right: Line[] = [...(open && lines[cut] && !('heading' in lines[cut]!) ? [{ heading: `${open.heading} (cont.)` }] : []), ...lines.slice(cut)];
  const gap = 2;
  const leftW = naturalWidth(left);
  if (right.length && leftW + gap + naturalWidth(right) <= inner) {
    const a = column(left, leftW);
    const b = column(right, inner - leftW - gap);
    return { columns: 2, lines: Array.from({ length: Math.max(a.length, b.length) }, (_, at) => `${a[at] ?? ' '.repeat(leftW)}${' '.repeat(gap)}${b[at] ?? ''}`) };
  }
  return { columns: 1, lines: column(lines, inner) };
}

export function renderShortcuts(raw: ShortcutsProps | undefined, size: { readonly w: number; readonly h: number }, _focused: boolean): string[] {
  const props: ShortcutsProps = raw ?? { context: 'normal', scroll: 0 };
  const { w, h } = size;
  if (w < 6 || h < 3) return [];
  const inner = w - 2;
  const bodyH = h - 2;
  const { lines } = shortcutsLayout(props.context, inner);
  const scroll = Math.max(0, Math.min(props.scroll, lines.length - bodyH));
  const shown = lines.slice(scroll, scroll + bodyH);
  while (shown.length < bodyH) shown.push('');
  const title = truncateCells(` ${TITLES[props.context]} `, Math.max(0, inner - 1));
  const top = `${FRAME}╭─${R}${BOLD}${title}${R}${FRAME}${'─'.repeat(Math.max(0, inner - 1 - visibleWidth(title)))}╮${R}`;
  const more = lines.length > bodyH;
  const hint = more ? `${scroll + 1}-${scroll + shown.filter((one) => one).length}/${lines.length} · ↑↓ scroll · Esc close` : 'Esc or ctrl+b ? close';
  const foot = truncateCells(` ${hint} `, inner);
  const bottom = `${FRAME}╰${'─'.repeat(Math.max(0, inner - visibleWidth(foot)))}${R}${DIM}${foot}${R}${FRAME}╯${R}`;
  return [top, ...shown.map((one) => `${FRAME}│${R}${fitAnsi(one, inner)}${FRAME}│${R}`), bottom].slice(0, h);
}

// 출처: ELS-SHORTCUTS-POPUP — PgUp/PgDn step ten lines (a screenful of a short popup; the list is ~50 lines).
const PAGE = 10;
/** Scroll keys → the next props; everything else is the popup's (consumed — nothing reaches the pane under it). Esc is
 *  consumed too, so the overlay closes the layer. */
export function shortcutsKey(props: ShortcutsProps, key: string): ShortcutsProps | 'consumed' {
  const last = Math.max(0, lineCount(props.context) - 1);
  const to = (scroll: number): ShortcutsProps | 'consumed' => {
    const next = Math.max(0, Math.min(last, scroll));
    return next === props.scroll ? 'consumed' : { ...props, scroll: next };
  };
  if (key === '\u001b[A' || key === '\u001bOA' || key === 'k') return to(props.scroll - 1);
  if (key === '\u001b[B' || key === '\u001bOB' || key === 'j') return to(props.scroll + 1);
  if (key === '\u001b[5~') return to(props.scroll - PAGE);
  if (key === '\u001b[6~' || key === ' ') return to(props.scroll + PAGE);
  if (key === '\u001b[H' || key === '\u001b[1~' || key === '\u001bOH') return to(0);
  if (key === '\u001b[F' || key === '\u001b[4~' || key === '\u001bOF') return to(last);
  return 'consumed';
}

export const shortcuts: ElementDef<ShortcutsProps> = {
  kind: 'shortcuts',
  defaults: { band: 'popup', focus: 'owns' },
  frames: ['popup'],
  dress: {},                                              // ELS-POPUP-STYLE fancy: bar · shading · shadow
  props: (raw) => shortcutsProps(raw),
  // 출처: ELS-SHORTCUTS-POPUP — 110×27 cells holds both columns (≈46 lines → 24 a column) with the fancy shadow; a smaller
  // view clamps the box to itself (resolveRect) and the list turns into one scrolling column.
  rect: () => ({ anchor: 'center', w: 110, h: 27 }),
  render: (props, size, focused) => renderShortcuts(props, size, focused),
  key: (layer, bytes) => {
    const props = shortcutsProps(layer.props);
    if (!props) return 'consumed';
    const next = shortcutsKey(props, bytes);
    return next === 'consumed' ? 'consumed' : { update: next };
  },
};
