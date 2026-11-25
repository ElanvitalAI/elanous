/**
 * Ticker — newest event enters from the right. It slides in over the tween frames only on the snapshot that
 * produced it (`fresh`); older events sit still. Nothing scrolls without a new event.
 */
import { cells, clean, cut, fit } from './text.js';

export interface TickerEvent {
  readonly at: string;
  readonly text: string;
}
export interface TickerProps {
  /** Newest first. */
  readonly events: readonly TickerEvent[];
  /** The newest event arrived in this snapshot. */
  readonly fresh: boolean;
  readonly frame: number;
  readonly frames?: number;
}

const SEP = ' · ';

export function renderTicker(props: TickerProps, width: number): string {
  if (!props.events.length || width <= 0) return '';
  const parts = props.events.map((event) => `${clean(event.at)} ${clean(event.text)}`);
  const line = parts.join(SEP);
  if (!props.fresh) return fit(line, width);
  const frames = props.frames ?? 4;
  const newest = parts[0]!;
  const rest = parts.slice(1).join(SEP);
  // Newest slides in from the right: during frame f it occupies the last (f+1)/frames of the line's head span.
  const shown = Math.min(cells(newest), Math.ceil((cells(newest) * (props.frame + 1)) / frames));
  const lead = Math.max(0, cells(newest) - shown);
  const text = `${' '.repeat(lead)}${cut(newest, shown)}${rest ? SEP + rest : ''}`;
  return fit(text, width);
}
