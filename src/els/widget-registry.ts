/**
 * BURST-BOARD-GENERAL (대표 11-26 14:4x «위젯이 먼저 · 탭으로 쉽게 추가되도록»): read-only board widgets as els tabs.
 *   `els widget add <name> [--ws W]` opens the board as a tab titled «▦ <name>» in the current (or named) workspace;
 *   the command is journaled by `els new`, so the tab comes back after an els restart. `els widget ls` lists them.
 *   ElsControl action `widget` opens the same tab in the caller's own workspace (eln: «버스트 보드 탭 띄워줘»).
 * Every entry is a read-only board: it never starts, stops or launches anything. Operational actions stay behind
 * their own confirm gates (burst-board b/x need --test-universe).
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface WidgetDef {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  /** argv the tab runs; a string = why it is unavailable on this host. */
  readonly command: (env: Readonly<Record<string, string | undefined>>) => readonly string[] | string;
}

const fedBoardScript = (env: Readonly<Record<string, string | undefined>>): string => join(env.HOME ?? '', 'elanous-hq', 'seat-state', 'OPS', 'tools', 'fed-board.sh');

export const WIDGETS: readonly WidgetDef[] = [
  { name: 'burst-board', aliases: ['burst', 'burst-board-live'], description: 'Burst Board live — planner · burst state · fed-state · RES (read-only)',
    command: () => ['elanous', 'burst-board'] },
  { name: 'fed-board', aliases: ['federation', 'federation-board', 'fed'], description: 'Federation Board — release · bulletin · spaces · hosts (60 s redraw, read-only)',
    command: (env) => { const s = fedBoardScript(env); return existsSync(s) ? ['zsh', s] : `fed-board script not found: ${s}`; } },
  { name: 'invest-board', aliases: ['invest'], description: 'Invest Research Board — replay of the latest pinned run (read-only)',
    command: () => ['elanous', 'demo', 'invest', 'board', '--replay'] },
  { name: 'release-board', aliases: ['release'], description: 'Release Board — the current release graph (read-only)',
    command: () => ['elanous', 'release', 'graph', 'board'] },
];

export const widgetTitle = (name: string): string => `▦ ${name}`;

/** Name or alias (case-insensitive, spaces/underscores → dashes) → registry entry. */
export function resolveWidget(name: string): WidgetDef | undefined {
  const key = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return WIDGETS.find((w) => w.name === key || w.aliases.includes(key));
}

/** The workspace a widget opens in: --ws, else the els workspace this shell runs in, else the folder name (els new's default). */
export function widgetWorkspace(ws: string | undefined, env: Readonly<Record<string, string | undefined>>, cwd: string): string {
  return ws?.trim() || env.ELANOUS_ELS_WS?.trim() || basename(cwd) || 'els';
}

export type WidgetLaunch = { readonly ok: true; readonly name: string; readonly title: string; readonly command: readonly string[] } | { readonly ok: false; readonly reason: string };

export function widgetLaunch(name: string, env: Readonly<Record<string, string | undefined>>): WidgetLaunch {
  const w = resolveWidget(name);
  if (!w) return { ok: false, reason: `unknown widget «${name}» — one of: ${WIDGETS.map((x) => x.name).join(', ')}` };
  const command = w.command(env);
  if (typeof command === 'string') return { ok: false, reason: `${w.name}: ${command}` };
  return { ok: true, name: w.name, title: widgetTitle(w.name), command };
}

/** `els widget ls` lines: name · aliases · available or why not · description. */
export function widgetListing(env: Readonly<Record<string, string | undefined>>): string {
  return WIDGETS.map((w) => {
    const c = w.command(env);
    return `${w.name.padEnd(14)} ${typeof c === 'string' ? 'unavailable' : 'ready      '}  ${w.description}${w.aliases.length ? ` (aliases: ${w.aliases.join(', ')})` : ''}${typeof c === 'string' ? ` — ${c}` : ''}`;
  }).join('\n');
}
