/**
 * Canvas — a styled cell grid for framed scenes (the tui-widgets-demo look): titled boxes, tone colours, bars, chips,
 * block letters. One drawing, three outputs: plain lines (tests · width checks), ANSI (terminal), HTML spans (preview).
 * Tones are the demo page's palette: t text · d dim · d2 dimmer · k faint · w white · c cyan · g green · a amber ·
 * r red · m magenta · bl blue · b border. Pure: no I/O.
 */
import { cells, clean } from './text.js';

export type Tone = 't' | 'd' | 'd2' | 'k' | 'w' | 'c' | 'g' | 'a' | 'r' | 'm' | 'bl' | 'b';
export type Bg = '' | 'bar' | 'sel' | 'acc' | 'g' | 'a' | 'r';
interface Cell { ch: string; tone: Tone; bold: boolean; bg: Bg; skip?: boolean }

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ANSI_FG: Readonly<Record<Tone, number>> = { t: 252, d: 245, d2: 242, k: 238, w: 255, c: 81, g: 114, a: 214, r: 203, m: 177, bl: 111, b: 240 };
const ANSI_BG: Readonly<Record<Exclude<Bg, ''>, number>> = { bar: 235, sel: 236, acc: 24, g: 22, a: 58, r: 52 };

/** Emoji and flags render at different widths per terminal; scenes drop them from untrusted titles. */
export const stripEmoji = (text: string): string => text.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}]/gu, '').replace(/\s{2,}/gu, ' ').trim();

export class Canvas {
  readonly cells: Cell[][];
  constructor(readonly width: number, readonly height: number) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, (): Cell => ({ ch: ' ', tone: 't', bold: false, bg: '' })));
  }

  /** Write text from (x, y), never past maxX (exclusive); returns the next x. Wide graphemes take two cells. */
  text(x: number, y: number, str: string, tone: Tone = 't', maxX = this.width, bold = false): number {
    if (y < 0 || y >= this.height) return x;
    const limit = Math.min(maxX, this.width);
    for (const { segment } of graphemes.segment(clean(str))) {
      const w = cells(segment);
      if (w === 0) continue;
      if (x + w > limit) break;
      if (x >= 0) {
        const bg = this.cells[y]![x]!.bg;
        this.cells[y]![x] = { ch: segment, tone, bold, bg };
        if (w === 2 && x + 1 < this.width) this.cells[y]![x + 1] = { ch: '', tone, bold, bg: this.cells[y]![x + 1]!.bg, skip: true };
      }
      x += w;
    }
    return x;
  }

  /** Text cut with «…» to fit `room` cells. */
  fitText(x: number, y: number, str: string, room: number, tone: Tone = 't', bold = false): number {
    const s = clean(str);
    if (room <= 0) return x;
    if (cells(s) <= room) return this.text(x, y, s, tone, x + room, bold);
    let out = '', used = 0;
    for (const { segment } of graphemes.segment(s)) { const w = cells(segment); if (used + w > room - 1) break; out += segment; used += w; }
    return this.text(x, y, `${out}…`, tone, x + room, bold);
  }

  fillBg(x: number, y: number, w: number, bg: Bg): void {
    if (y < 0 || y >= this.height) return;
    for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) this.cells[y]![i]!.bg = bg;
  }

  repeat(x: number, y: number, n: number, ch: string, tone: Tone): void { for (let i = 0; i < n; i++) this.text(x + i, y, ch, tone); }

  /** Rounded box with a title on the top border (left) and an optional note (right). */
  box(x: number, y: number, w: number, h: number, o: { title?: string; right?: string; tone?: Tone; titleTone?: Tone; rightTone?: Tone } = {}): void {
    if (w < 2 || h < 2) return;
    const bc = o.tone ?? 'b';
    this.text(x, y, '╭', bc); this.repeat(x + 1, y, w - 2, '─', bc); this.text(x + w - 1, y, '╮', bc);
    for (let j = 1; j < h - 1; j++) { this.text(x, y + j, '│', bc); this.text(x + w - 1, y + j, '│', bc); }
    this.text(x, y + h - 1, '╰', bc); this.repeat(x + 1, y + h - 1, w - 2, '─', bc); this.text(x + w - 1, y + h - 1, '╯', bc);
    let tx = x + 1;
    if (o.title) { tx = this.text(tx, y, ' ', bc); tx = this.fitText(tx, y, o.title, w - 6, o.titleTone ?? 'w', true); tx = this.text(tx, y, ' ', bc); }
    if (o.right) {
      const r = ` ${clean(o.right)} `;
      const rx = x + w - 2 - cells(r);
      if (rx > tx + 1) this.text(rx, y, r, o.rightTone ?? 'd');
    }
  }

  /** «█████░░░» bar for a 0..1 ratio. */
  bar(x: number, y: number, w: number, ratio: number, tone: Tone): void {
    const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    const f = Math.round(r * w);
    this.repeat(x, y, f, '█', tone); this.repeat(x + f, y, w - f, '░', 'k');
  }

  lines(): string[] {
    return this.cells.map((row) => row.filter((c) => !c.skip).map((c) => c.ch).join('').trimEnd());
  }

  ansi(): string[] {
    return this.cells.map((row) => {
      let out = '', key = '';
      for (const c of row) {
        if (c.skip) continue;
        const k = `${c.tone}|${c.bold}|${c.bg}`;
        if (k !== key) { out += `\x1b[0m\x1b[38;5;${ANSI_FG[c.tone]}m${c.bold ? '\x1b[1m' : ''}${c.bg ? `\x1b[48;5;${ANSI_BG[c.bg]}m` : ''}`; key = k; }
        out += c.ch;
      }
      return `${out}\x1b[0m`;
    });
  }

  /** HTML rows: <div class="row"> with spans classed by tone (and B for bold, bg-* for backgrounds). */
  html(): string {
    const esc = (s: string) => s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    return this.cells.map((row) => {
      let out = '', key = '', buf = '';
      const flush = () => { if (buf) out += key ? `<span class="${key}">${buf}</span>` : buf; buf = ''; };
      for (const c of row) {
        if (c.skip) continue;
        const k = [c.tone, c.bold ? 'B' : '', c.bg ? `bg-${c.bg}` : ''].filter(Boolean).join(' ');
        if (k !== key) { flush(); key = k; }
        buf += cells(c.ch) === 2 ? `<i class="gl2">${esc(c.ch)}</i>` : c.ch.codePointAt(0)! > 127 ? `<i class="gl">${esc(c.ch)}</i>` : esc(c.ch);
      }
      flush();
      return `<div class="row">${out}</div>`;
    }).join('');
  }
}

/** 3-row block letters for big verdict words (BUY · HOLD · SELL · digits). */
const BIG: Readonly<Record<string, readonly [string, string, string]>> = {
  B: ['█▀▄', '█▀▄', '█▄▀'], U: ['█ █', '█ █', '▀▄▀'], Y: ['█ █', '▀▄▀', ' █ '], H: ['█ █', '█▀█', '█ █'], O: ['█▀█', '█ █', '█▄█'],
  L: ['█  ', '█  ', '█▄▄'], D: ['█▀▄', '█ █', '█▄▀'], S: ['█▀▀', '▀▀█', '▄▄█'], E: ['█▀▀', '█▀ ', '█▄▄'], '?': ['▀▀█', ' ▀ ', ' ▄ '],
  '0': ['█▀█', '█ █', '█▄█'], '1': ['▀█ ', ' █ ', '▄█▄'], '2': ['▀▀█', '█▀▀', '█▄▄'], '3': ['▀▀█', ' ▀█', '▄▄█'], '4': ['█ █', '▀▀█', '  █'],
  '5': ['█▀▀', '▀▀█', '▄▄█'], '6': ['█▀▀', '█▀█', '█▄█'], '7': ['▀▀█', '  █', '  █'], '8': ['█▀█', '█▀█', '█▄█'], '9': ['█▀█', '▀▀█', '▄▄█'],
};
/** Draws a word in block letters; returns its width. Unknown letters draw as «?». */
export function bigText(c: Canvas, x: number, y: number, word: string, tone: Tone): number {
  let cx = x;
  for (const ch of word.toUpperCase()) {
    const g = BIG[ch] ?? BIG['?']!;
    for (let r = 0; r < 3; r++) c.text(cx, y + r, g[r]!, tone, c.width, true);
    cx += 4;
  }
  return Math.max(0, cx - x - 1);
}

const LEVELS = '▁▂▃▄▅▆▇█';
/** Sparkline of values scaled to their own min..max (signed flows read as a shape, not a sign). */
export function sparkCells(values: readonly number[]): string {
  if (!values.length) return '';
  const lo = Math.min(...values), hi = Math.max(...values);
  return values.map((v) => LEVELS[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
}

export const ACTION_TONE: Readonly<Record<string, Tone>> = { BUY: 'g', HOLD: 'a', SELL: 'r' };
