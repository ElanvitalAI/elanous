/**
 * HostTile — one host on one line: slots gauge vs its measured cap, load, role, and burst state.
 * Local hosts fill first, LAN next, cloud last; the next scale-up target blinks its «← next» marker per snapshot (pass the tick as `frame`).
 */
import { cells, clean, fit, num, pad } from './text.js';

export type HostState = 'on' | 'off' | 'card' | 'cap';
export interface HostTileProps {
  readonly name: string;
  readonly kind: 'local' | 'lan' | 'cloud';
  readonly used: number;
  readonly cap: number;
  readonly load?: number;
  /** e.g. «hands 6» · «pregate 3». */
  readonly role?: string;
  readonly state: HostState;
  readonly next?: boolean;
  /** A simulated host (replay / test universe) — labelled «sim» so nobody reads it as a paid VM. */
  readonly sim?: boolean;
  readonly frame: number;
}

const BAR = 6;

export function renderHostTile(props: HostTileProps, width: number): string {
  const name = pad(`${clean(props.name)}${props.sim ? ' sim' : ''}`, props.sim ? 9 : 7);
  if (props.state === 'off') return fit(`${name} ○ off`, width);
  if (props.state === 'card') return fit(`${name} $? cloud card pending — press v to approve`, width);
  const cap = Math.max(1, props.cap);
  const filled = Math.round(Math.min(1, props.used / cap) * BAR);
  const gauge = `${'▓'.repeat(filled)}${'░'.repeat(BAR - filled)} ${num(props.used)}/${num(props.cap)}`;
  const atCap = props.state === 'cap' || props.used >= props.cap;
  const parts = [
    `${name} ${props.kind === 'cloud' ? '◉' : ' '} ${gauge}${atCap ? ' cap' : ''}`,
    props.load === undefined ? '' : `load ${num(props.load)}`,
    props.role ? clean(props.role) : '',
  ].filter(Boolean);
  let line = parts[0]!;
  for (const part of parts.slice(1)) line = `${pad(line, Math.max(cells(line) + 2, line === parts[0] ? 26 : 38))}${part}`;
  if (props.next) line += props.frame % 2 === 0 ? '  ← next' : '        ';
  return fit(line.trimEnd(), width);
}
