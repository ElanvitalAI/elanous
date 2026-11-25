/**
 * HandGrid — one cell per hand, grouped by host. States come from the snapshot; the frame only times the entry/exit
 * transition (a new hand shows «+» for the first half of the tween, then «▪»; a closing hand fades «▪» → «·» → gone).
 */
import { cells, clean, fit, pad } from './text.js';

export type HandState = 'idle' | 'busy' | 'new' | 'closing';
export interface Hand {
  readonly host: string;
  readonly state: HandState;
  /** The card the hand just claimed — shown once, on its entry snapshot. */
  readonly task?: string;
}
export interface HandGridProps {
  readonly hands: readonly Hand[];
  /** 0..frames-1 inside one snapshot interval. */
  readonly frame: number;
  readonly frames?: number;
  /** Max lines; extra hosts fold into a «+N more» tail. */
  readonly maxRows?: number;
}

export const HAND_GLYPH: Readonly<Record<'idle' | 'busy' | 'enter' | 'fade', string>> = { idle: '·', busy: '▪', enter: '+', fade: '·' };

function glyph(hand: Hand, frame: number, frames: number): string {
  const early = frame < frames / 2;
  switch (hand.state) {
    case 'idle': return HAND_GLYPH.idle;
    case 'busy': return HAND_GLYPH.busy;
    case 'new': return early ? HAND_GLYPH.enter : HAND_GLYPH.busy;
    case 'closing': return early ? HAND_GLYPH.fade : ' ';
  }
}

export function renderHandGrid(props: HandGridProps, width: number): string[] {
  const frames = props.frames ?? 4;
  const hosts: string[] = [];
  for (const hand of props.hands) if (!hosts.includes(hand.host)) hosts.push(hand.host);
  const nameW = Math.min(8, Math.max(0, ...hosts.map((h) => cells(clean(h)))));
  const out: string[] = [];
  const maxRows = props.maxRows ?? Infinity;
  for (const [i, host] of hosts.entries()) {
    if (out.length >= maxRows) break;
    if (out.length === maxRows - 1 && i < hosts.length - 1) {
      out.push(fit(`+${hosts.length - i} more hosts`, width));
      break;
    }
    const mine = props.hands.filter((hand) => hand.host === host);
    const grid = mine.map((hand) => glyph(hand, props.frame, frames)).join(' ');
    const claimed = props.frame < frames / 2 ? mine.filter((h) => h.state === 'new' && h.task).map((h) => clean(h.task!)) : [];
    const note = claimed.length ? `  ${claimed.join(' ')}` : '';
    out.push(fit(`${pad(clean(host), nameW)} ${grid}${note}`.trimEnd(), width));
  }
  return out;
}
