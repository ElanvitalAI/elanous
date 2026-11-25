/** FanoutBoard — one parent and its N children, one row each: glyph · name · model · progress · elapsed · last line. */
import { bar, cells, clean, elapsed, fit, pad, padStart } from './text.js';

export type FanoutState = 'running' | 'done' | 'failed' | 'waiting';

export interface FanoutAgent {
  readonly name: string;
  /** Where it runs, e.g. «terra» or «terra · codex CLI». */
  readonly modelTail?: string;
  readonly state: FanoutState;
  /** 0..1, or null when unknown. */
  readonly progress?: number | null;
  readonly elapsedMs?: number;
  /** The newest line the agent printed. */
  readonly lastLine?: string;
}

export interface FanoutBoardProps {
  readonly parent: FanoutAgent;
  readonly children: readonly FanoutAgent[];
}

export const FANOUT_GLYPH: Readonly<Record<FanoutState, string>> = { running: '●', done: '✓', failed: '✗', waiting: '◌' };

const BAR = 10;

function percent(agent: FanoutAgent): string {
  if (typeof agent.progress === 'number' && Number.isFinite(agent.progress)) return `${Math.round(Math.min(1, Math.max(0, agent.progress)) * 100)}%`;
  return agent.state === 'done' ? '100%' : '—';
}

function ratio(agent: FanoutAgent): number {
  if (typeof agent.progress === 'number') return agent.progress;
  return agent.state === 'done' ? 1 : 0;
}

/** Parent summary row, then one tree row per child; every row ≤ width. Narrow widths drop model, then bar. */
export function renderFanoutBoard(props: FanoutBoardProps, width: number): string[] {
  const { parent, children } = props;
  const count = (state: FanoutState) => children.filter((child) => child.state === state).length;
  const tally = [
    `${children.length} agent${children.length === 1 ? '' : 's'}`,
    ...(['running', 'done', 'failed', 'waiting'] as const).filter((s) => count(s) > 0).map((s) => `${count(s)} ${s}`),
  ].join(' · ');
  const head = `${FANOUT_GLYPH[parent.state]} ${clean(parent.name)}${parent.modelTail ? ` · ${clean(parent.modelTail)}` : ''} — ${tally}`;
  const lines = [fit(head, width)];
  const nameW = Math.min(12, Math.max(4, ...children.map((child) => cells(clean(child.name)))));
  const modelW = Math.min(18, Math.max(0, ...children.map((child) => cells(clean(child.modelTail ?? '')))));
  const showModel = width >= 72 && modelW > 0;
  const showBar = width >= 52;
  children.forEach((child, index) => {
    const branch = index === children.length - 1 ? '└─' : '├─';
    const parts = [
      `${branch} ${FANOUT_GLYPH[child.state]} ${pad(clean(child.name), nameW)}`,
      ...(showModel ? [pad(clean(child.modelTail ?? ''), modelW)] : []),
      `${showBar ? `${bar(ratio(child), BAR)} ` : ''}${padStart(percent(child), 4)}`,
      padStart(elapsed(child.elapsedMs ?? 0), 5),
    ];
    const left = parts.join('  ');
    const last = clean(child.lastLine ?? '');
    lines.push(fit(last ? `${left}  ${last}` : left, width).trimEnd());
  });
  return lines;
}
