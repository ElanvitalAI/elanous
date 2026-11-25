/** Gauge — «label ███│░░ value/max unit · over|under threshold» on one line. */
import { cells, clean, fit, num } from './text.js';

export interface GaugeProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly threshold?: number;
  readonly unit?: string;
}

export type GaugeTone = 'over' | 'under' | 'none';

/** Above the threshold = over; at or below = under; no threshold = none. */
export function gaugeTone(props: GaugeProps): GaugeTone {
  if (props.threshold === undefined) return 'none';
  return props.value > props.threshold ? 'over' : 'under';
}

const MIN_BAR = 4;
const MAX_BAR = 24;

export function renderGauge(props: GaugeProps, width: number): string {
  const label = clean(props.label);
  const tone = gaugeTone(props);
  const tail = `${num(props.value)}/${num(props.max)}${props.unit ? ` ${clean(props.unit)}` : ''}${tone === 'none' ? '' : ` · ${tone} ${num(props.threshold!)}`}`;
  const room = width - cells(label) - cells(tail) - 2;
  if (room < MIN_BAR) return fit(`${label} ${tail}`, width);
  const barW = Math.min(MAX_BAR, room);
  const max = props.max > 0 ? props.max : 1;
  const filled = Math.round(Math.min(1, Math.max(0, props.value / max)) * barW);
  const cellsArr: string[] = Array.from({ length: barW }, (_, i) => (i < filled ? '█' : '░'));
  if (props.threshold !== undefined) {
    const at = Math.min(barW - 1, Math.max(0, Math.round((props.threshold / max) * barW)));
    cellsArr[at] = '│';
  }
  return `${label} ${cellsArr.join('')} ${tail}`;
}
