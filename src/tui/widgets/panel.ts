/**
 * Panel — framed, titled boxes built from toned segments (the tui-widgets-demo look: ┌─ Title ─── right ┐).
 * Pure: a Row is a list of [text, tone] segments; `paintRow` turns it into ANSI (or plain text for tests/captures).
 * Tones follow the demo palette: g = fine · a = watch · r = act · c = running/active · d = dim · k = track · w = strong.
 */
import { cells, cut } from './text.js';

export type Tone = 't' | 'd' | 'k' | 'g' | 'a' | 'r' | 'c' | 'w' | 'h' | 'b' | 'inv' | 'hot' | 'calm';
export type Seg = readonly [text: string, tone?: Tone];
export type Row = readonly Seg[];

export const rowText = (row: Row): string => row.map(([t]) => t).join('');
export const rowCells = (row: Row): number => cells(rowText(row));

/** Cut a row to `width` cells by whole graphemes, then pad with spaces to exactly `width`. */
export function fitRow(row: Row, width: number, fill: Tone = 't'): Row {
  const out: Seg[] = [];
  let used = 0;
  for (const [text, tone] of row) {
    if (used >= width) break;
    const w = cells(text);
    if (used + w <= width) { out.push([text, tone]); used += w; continue; }
    const head = cut(text, width - used);
    out.push([head, tone]);
    used += cells(head);
    break;
  }
  if (used < width) out.push([' '.repeat(width - used), fill]);
  return out;
}

export interface PanelOpts {
  readonly title: string;
  readonly right?: string;
  readonly width: number;
  /** Total height incl. borders; body is padded or cut to fit. */
  readonly height: number;
  readonly border?: Tone;
  readonly titleTone?: Tone;
  readonly rightTone?: Tone;
}

/** ┌ Title ─────── right ┐ / │ body │ / └────┘ — exactly width × height. */
export function panel(opts: PanelOpts, body: readonly Row[]): Row[] {
  const w = Math.max(4, opts.width);
  const h = Math.max(2, opts.height);
  const b = opts.border ?? 'b';
  const title = ` ${opts.title} `;
  const right = opts.right ? ` ${opts.right} ` : '';
  const room = w - 2;
  const titleFit = cut(title, Math.max(0, room - 1));
  const rightFit = cells(titleFit) + cells(right) + 1 <= room ? right : '';
  const dashes = Math.max(0, room - 1 - cells(titleFit) - cells(rightFit));
  const top: Row = [['┌─', b], [titleFit, opts.titleTone ?? 'w'], ['─'.repeat(dashes), b], [rightFit, opts.rightTone ?? 'd'], ['┐', b]];
  const rows: Row[] = [fitRow(top, w)];
  for (let i = 0; i < h - 2; i++) rows.push([['│', b], ...fitRow(body[i] ?? [], w - 2), ['│', b]]);
  rows.push([['└', b], ['─'.repeat(w - 2), b], ['┘', b]]);
  return rows;
}

/** Place equal-height column blocks side by side with `gap` spaces. */
export function besides(blocks: readonly (readonly Row[])[], gap = 1): Row[] {
  const h = Math.max(0, ...blocks.map((b) => b.length));
  const out: Row[] = [];
  for (let y = 0; y < h; y++) {
    const row: Seg[] = [];
    blocks.forEach((block, i) => {
      if (i > 0 && gap > 0) row.push([' '.repeat(gap)]);
      const width = block[0] ? rowCells(block[0]) : 0;
      row.push(...(block[y] ?? [[' '.repeat(width)]]));
    });
    out.push(row);
  }
  return out;
}

/** ████░░░ with an optional threshold mark ┃ at `mark` (0..1). */
export function gaugeSegs(ratio: number | null, width: number, tone: Tone, mark?: number): Seg[] {
  if (ratio === null || !Number.isFinite(ratio)) return [['░'.repeat(width), 'k']];
  const r = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(r * width);
  const chars = Array.from({ length: width }, (_, i) => (i < filled ? '█' : '░'));
  const at = mark === undefined ? -1 : Math.min(width - 1, Math.max(0, Math.round(mark * width)));
  const segs: Seg[] = [];
  for (let i = 0; i < width; i++) {
    const t: Tone = i === at ? 'a' : i < filled ? tone : 'k';
    const ch = i === at ? '┃' : chars[i]!;
    const last = segs.at(-1);
    if (last && last[1] === t) segs[segs.length - 1] = [last[0] + ch, t];
    else segs.push([ch, t]);
  }
  return segs;
}

const SPARK = '▁▂▃▄▅▆▇█';
/** Sparkline segments; values at/above target are green, below amber; empty → «no data». */
export function sparkSegs(values: readonly number[], target?: number, max?: number): Seg[] {
  if (!values.length) return [['no data', 'd']];
  const top = Math.max(1, max ?? 0, target ?? 0, ...values);
  return values.map((v) => [SPARK[Math.min(7, Math.max(0, Math.round((v / top) * 7)))]!, target === undefined ? 'c' : v >= target ? 'g' : 'a'] as Seg);
}

/** A chip: ‹ text › with a tone. */
export const chip = (text: string, tone: Tone): Seg => [` ${text} `, tone === 'r' ? 'hot' : tone === 'g' ? 'g' : tone];

const SGR: Record<Tone, string> = {
  t: '38;5;252', d: '38;5;245', k: '38;5;238', g: '38;5;78', a: '38;5;214', r: '38;5;203', c: '38;5;80', w: '1;38;5;255', h: '1;38;5;209',
  b: '38;5;240', inv: '1;38;5;16;48;5;250', hot: '1;38;5;231;48;5;160', calm: '38;5;250;48;5;236',
};

/** ANSI for a row (color) or its plain text. */
export function paintRow(row: Row, color: boolean): string {
  if (!color) return rowText(row);
  let out = '';
  for (const [text, tone] of row) out += tone && tone !== 't' ? `\x1b[${SGR[tone]}m${text}\x1b[0m` : text;
  return out;
}
