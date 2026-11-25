/** Stat — a two-line tile (label / value) · StatRow — tiles laid left to right, wrapping to the width. */
import { cells, clean, fit, num, pad } from './text.js';

export type StatTone = 'good' | 'warn' | 'bad' | 'neutral';
export interface StatProps {
  readonly label: string;
  readonly value: number | string;
  readonly unit?: string;
  /** Change since the last reading: ▲ up · ▼ down. */
  readonly delta?: number;
  readonly target?: number | string;
  readonly tone?: StatTone;
}

export const STAT_TONE_MARK: Readonly<Record<StatTone, string>> = { good: '✓', warn: '!', bad: '✗', neutral: '' };

const show = (value: number | string): string => (typeof value === 'number' ? num(value) : clean(value));

/** The tile's two lines, each fitted to `width`. */
export function renderStat(props: StatProps, width: number): string[] {
  const value = [
    `${show(props.value)}${props.target !== undefined ? ` / ${show(props.target)}` : ''}${props.unit ? ` ${clean(props.unit)}` : ''}`,
    ...(props.delta !== undefined && props.delta !== 0 ? [`${props.delta > 0 ? '▲' : '▼'}${num(Math.abs(props.delta))}`] : []),
    ...(props.tone && STAT_TONE_MARK[props.tone] ? [STAT_TONE_MARK[props.tone]] : []),
  ].join(' ');
  return [fit(clean(props.label), width), fit(value, width)];
}

const GAP = '   ';

/** Tiles side by side, as many per band as fit; a band is two lines. Lines are right-trimmed. */
export function renderStatRow(stats: readonly StatProps[], width: number): string[] {
  const tiles = stats.map((stat) => {
    const lines = renderStat(stat, width);
    return { lines, w: Math.max(...lines.map(cells)) };
  });
  const out: string[] = [];
  let band: typeof tiles = [];
  let used = 0;
  const flush = () => {
    if (!band.length) return;
    for (const row of [0, 1]) out.push(band.map((tile) => pad(tile.lines[row]!, tile.w)).join(GAP).trimEnd());
    band = [];
    used = 0;
  };
  for (const tile of tiles) {
    const need = (band.length ? GAP.length : 0) + tile.w;
    if (band.length && used + need > width) flush();
    used += (band.length ? GAP.length : 0) + tile.w;
    band.push(tile);
  }
  flush();
  return out;
}
