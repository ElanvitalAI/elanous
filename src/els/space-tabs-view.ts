// els client · ELS-ONE-SPACE (대표 11-18 «사이드탭 제품 분리»: the side panel is els's, not eln's) — herdr's layout as two
// pure parts the attach app draws:
//   • the folded space list (left): one line per workspace — selected ▸, the most urgent status mark inside it, the
//     name, the pane count — and «+ new · ≡ menu» at the end; no pane lines, no category headings;
//   • the tab row (top of the centre): the selected workspace's panes as «emoji title mark» tabs, ‹ › when they do not
//     fit, no row at all when the workspace has no panes.
// Input = the `els ls` rows (attach-view parsePaneRows) plus each pane's command, for the emoji. Plain text: colour and
// reverse video are the composer's (attach-view). Nothing here imports eln.

import { fitCells, wordOfState, type PaneRow } from './attach-view.js';
import { STATUS, type StatusWord } from './status-vocab.js';

export interface SpaceTabRow extends PaneRow { readonly command?: readonly string[] }

/** `els ls` rows with each pane's command (for its emoji); same order and the same skips as parsePaneRows. */
export function withCommands(rows: readonly PaneRow[], listJson: string): SpaceTabRow[] {
  let panes: unknown;
  try { panes = (JSON.parse(listJson) as { panes?: unknown }).panes; } catch { panes = undefined; }
  const commands = new Map<string, readonly string[]>();
  if (Array.isArray(panes)) {
    for (const raw of panes) {
      const row = raw as { pane?: unknown; command?: unknown };
      if (raw && typeof row.pane === 'string' && Array.isArray(row.command)) commands.set(row.pane, row.command.map(String));
    }
  }
  return rows.map((row) => ({ ...row, ...(commands.has(row.pane) ? { command: commands.get(row.pane)! } : {}) }));
}

// 대표 11-18 emoji set: 💬 chat ⌨️ shell 🤖 agent 🛠 harness 📦 pod 🌐 remote.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'nu', 'pwsh']);
const AGENTS = new Set(['claude', 'codex', 'grok', 'gemini', 'opencode', 'aider']);
const CHATS = new Set(['eln', 'elanous', 'elanous.mjs']);
// 출처: #38438 review must[2] — runtime wrappers (bun/node/…) are skipped to expose the real executable; agent and
// chat names are matched against that executable only, never against arguments (ssh claude, kubectl exec <pod>…).
const WRAPPERS = new Set(['bun', 'bunx', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'deno']);
const baseName = (part: string) => part.split('/').pop() ?? part;

/** The tab emoji, from what the pane runs: no command = a harness child, a shell, an agent CLI, or eln's chat. */
export function paneEmoji(row: SpaceTabRow): string {
  if ((row as { remote?: string }).remote) return '🌐';
  const command = row.command ?? [];
  if (command.length === 0) return '🛠';
  let at = 0;
  while (at + 1 < command.length && WRAPPERS.has(baseName(command[at]!))) at++;
  const exe = baseName(command[at]!);
  if (CHATS.has(exe)) return '💬';
  if (AGENTS.has(exe)) return '🤖';
  if (SHELLS.has(exe)) return '⌨️';
  if (exe === 'kubectl') return '📦';
  if (exe === 'ssh') return '🌐';
  return '⌨️';
}

const URGENCY: readonly StatusWord[] = ['failed', 'blocked', 'working', 'idle', 'done'];
const markOf = (rows: readonly PaneRow[]): string => {
  const words = rows.map((row) => wordOfState(row.state));
  return STATUS[URGENCY.find((word) => words.includes(word)) ?? 'done'].mark;
};

interface Space { readonly wsId: string; readonly name: string; readonly panes: readonly SpaceTabRow[] }
const spacesOf = (rows: readonly SpaceTabRow[]): Space[] =>
  [...new Set(rows.map((row) => row.wsId))].map((wsId) => {
    const panes = rows.filter((row) => row.wsId === wsId);
    return { wsId, name: panes[0]!.workspace, panes };
  });

const selectedSpace = (rows: readonly SpaceTabRow[], selectedPane: string | undefined): string | undefined =>
  rows.find((row) => row.pane === selectedPane)?.wsId ?? rows[0]?.wsId;

export const SPACE_LIST_END = ' + new · ≡ menu';

/** The folded space list: exactly `height` lines of `width` cells; scrolled so the selected space shows. */
export function buildSpaceList(rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number, height: number): string[] {
  const chosen = selectedSpace(rows, selectedPane);
  const spaces = spacesOf(rows);
  const items = [...spaces.map((space) => `${space.wsId === chosen ? '▸' : ' '}${markOf(space.panes)} ${space.name} · ${space.panes.length}`), SPACE_LIST_END];
  const at = Math.max(0, spaces.findIndex((space) => space.wsId === chosen));
  const start = items.length <= height ? 0 : Math.max(0, Math.min(at - Math.floor(height / 2), items.length - height));
  const shown = items.slice(start, start + height).map((text) => fitCells(text, width));
  while (shown.length < height) shown.push(' '.repeat(width));
  return shown;
}

export interface TabRow {
  /** The row, or none when the selected workspace has no panes. */
  readonly line?: string;
  /** Each tab's columns in the row (zero-based, end exclusive) and its pane — for clicks. */
  readonly tabs: readonly { readonly from: number; readonly to: number; readonly pane: string }[];
}

/** The selected workspace's panes as tabs; the selected one marked ▸. Overflow keeps the selected tab and shows ‹ / ›. */
export function buildTabRow(rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number): TabRow {
  const chosen = selectedSpace(rows, selectedPane);
  const panes = rows.filter((row) => row.wsId === chosen);
  if (panes.length === 0 || width < 3) return { tabs: [] };
  const labels = panes.map((row) => ({ pane: row.pane, text: `${row.pane === selectedPane ? '▸' : ' '}${paneEmoji(row)} ${row.title} ${STATUS[wordOfState(row.state)].mark} ` }));
  const cells = (text: string) => Bun.stringWidth(text);
  const SEP = '│';
  const total = labels.reduce((sum, label) => sum + cells(label.text) + cells(SEP), 0);
  let first = 0;
  const chosenAt = Math.max(0, labels.findIndex((label) => label.pane === selectedPane));
  if (total > width) {
    const room = width - 2; // a leading ‹ and a trailing ›
    while (first < chosenAt && labels.slice(first, chosenAt + 1).reduce((sum, label) => sum + cells(label.text) + cells(SEP), 0) > room) first++;
  }
  let line = first > 0 ? '‹' : '';
  const tabs: { from: number; to: number; pane: string }[] = [];
  let last = first - 1;
  for (let at = first; at < labels.length; at++) {
    const piece = labels[at]!.text + SEP;
    const reserve = at < labels.length - 1 ? 1 : 0;
    if (cells(line) + cells(piece) + reserve > width) break;
    tabs.push({ from: cells(line), to: cells(line) + cells(labels[at]!.text), pane: labels[at]!.pane });
    line += piece;
    last = at;
  }
  // 출처: #38438 review must[1] — the selected tab alone can be wider than the row: clip it instead of dropping it,
  // so a long title in a narrow row still shows the tab's visible part and keeps its click range (start column, width).
  if (tabs.length === 0 && chosenAt < labels.length) {
    const room = width - cells(line);
    if (room > 0) {
      tabs.push({ from: cells(line), to: cells(line) + Math.min(cells(labels[chosenAt]!.text), room), pane: labels[chosenAt]!.pane });
      line += fitCells(labels[chosenAt]!.text, room);
    }
  } else if (last < labels.length - 1) line += '›';
  return { line: fitCells(line, width), tabs };
}
