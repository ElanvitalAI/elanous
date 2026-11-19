// els client · ELS-ONE-SPACE (대표 11-18 «사이드탭 제품 분리»: the side panel is els's, not eln's) — herdr's layout as two
// pure parts the attach app draws:
//   • the folded space list (left): one line per workspace — selected ▸, the most urgent status mark inside it, the
//     name, the pane count — and «+ new · ≡ menu» at the end; no pane lines, no category headings;
//   • the tab row (top of the centre): the selected workspace's panes as «emoji title mark» tabs, ‹ › when they do not
//     fit, no row at all when the workspace has no panes.
// Input = the `els ls` rows (attach-view parsePaneRows) plus each pane's command, for the emoji. Plain text: colour and
// reverse video are the composer's (attach-view). Nothing here imports eln.

import { fitCells, UNREACHABLE_MARK, wordOfState, type PaneRow } from './attach-view.js';
import { STATUS, type StatusWord } from './status-vocab.js';

export interface SpaceTabRow extends PaneRow {
  readonly command?: readonly string[];
  /** ELS-PANE-AGENT-DETECT: the agent running in the pane's foreground now (eln · codex · claude · grok) — the tab's name. */
  readonly agent?: string;
}

/** `els ls` rows with each pane's command (for its emoji); same order and the same skips as parsePaneRows. */
export function withCommands(rows: readonly PaneRow[], listJson: string): SpaceTabRow[] {
  let panes: unknown;
  try { panes = (JSON.parse(listJson) as { panes?: unknown }).panes; } catch { panes = undefined; }
  const commands = new Map<string, readonly string[]>();
  const agents = new Map<string, string>();
  if (Array.isArray(panes)) {
    for (const raw of panes) {
      const row = raw as { pane?: unknown; command?: unknown; kind?: unknown; fgCommand?: unknown };
      if (!raw || typeof row.pane !== 'string') continue;
      if (Array.isArray(row.command)) commands.set(row.pane, row.command.map(String));
      // ELS-PANE-AGENT-DETECT: an agent in the foreground now decides the emoji and the name; a shell (again) or any
      // other program keeps the pane's own.
      if (typeof row.kind === 'string' && AGENT_KINDS.has(row.kind) && Array.isArray(row.fgCommand)) {
        commands.set(row.pane, row.fgCommand.map(String));
        agents.set(row.pane, row.kind);
      }
    }
  }
  return rows.map((row) => ({ ...row, ...(commands.has(row.pane) ? { command: commands.get(row.pane)! } : {}), ...(agents.has(row.pane) ? { agent: agents.get(row.pane)! } : {}) }));
}

const AGENT_KINDS = new Set(['eln', 'codex', 'claude', 'grok']);
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
  // ELS-REMOTE-MARKER: a space whose host is down (every pane stale) reads «?», not its last live state.
  if (rows.length > 0 && rows.every((row) => row.stale)) return UNREACHABLE_MARK;
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
/** parseRemoteRows gives herdr panes the workspace id `herdr:<ws>`. */
export const HERDR_WS_PREFIX = 'herdr:';

/** The folded space list: exactly `height` lines of `width` cells; scrolled so the selected space shows. */
export function buildSpaceList(rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number, height: number): string[] {
  const chosen = selectedSpace(rows, selectedPane);
  const line = (space: ReturnType<typeof spacesOf>[number], indent = ''): string =>
    `${indent}${space.wsId === chosen ? '▸' : ' '}${markOf(space.panes)} ${space.name} · ${space.panes.length}`;
  // ELS-FIRST-RUN-FU3 ③ (orders/ELS-FIRST-RUN-UX-1119.md 4): herdr's seat panes are one bundle under a «herdr» head, folded
  // by default, below this host's own spaces; it opens only while one of its spaces is the selected one.
  const all = spacesOf(rows);
  const mine = all.filter((space) => !space.wsId.startsWith(HERDR_WS_PREFIX));
  const herdr = all.filter((space) => space.wsId.startsWith(HERDR_WS_PREFIX));
  const herdrOpen = herdr.some((space) => space.wsId === chosen);
  const items = mine.map((space) => line(space));
  const spaceAt = new Map(mine.map((space, index) => [space.wsId, index]));
  if (herdr.length > 0) {
    items.push(`${herdrOpen ? ' ⊟' : ' ⊞'} herdr · ${herdr.length}`);
    if (herdrOpen) for (const space of herdr) { spaceAt.set(space.wsId, items.length); items.push(line(space, '  ')); }
  }
  items.push(SPACE_LIST_END);
  const at = spaceAt.get(chosen ?? '') ?? (herdrOpen ? items.length - 1 : 0);
  const start = items.length <= height ? 0 : Math.max(0, Math.min(at - Math.floor(height / 2), items.length - height));
  const focusAt = spaceAt.get(chosen ?? '');
  const shown = items.slice(start, start + height).map((text, index) => start + index === focusAt ? `${FOCUS_ON}${fitCells(text, width)}${FOCUS_OFF}` : fitCells(text, width));
  while (shown.length < height) shown.push(' '.repeat(width));
  return shown;
}

export interface TabRow {
  /** The row, or none when the selected workspace has no panes. */
  readonly line?: string;
  /** Each tab's columns in the row (zero-based, end exclusive) and its pane — for clicks. */
  readonly tabs: readonly { readonly from: number; readonly to: number; readonly pane: string }[];
}

// ELS-FIRST-RUN-FU3 (OP #101592 · #101606): the tab row reads like herdr's — «emoji name» per tab, two spaces between,
// «+» (new tab) last. No command path (a path keeps its last name), no build badge, no status dot, no ▸: the focused tab is
// a reverse-video block (SGR 7), and the block moves with the focus.
const TAB_SEP = '  ';
const NEW_TAB = '+';
const FOCUS_ON = '\u001b[7m';
const FOCUS_OFF = '\u001b[27m';
const BADGE = /\s*\[[^\]]*\]\s*$/;

/** A tab's name: the pane title without its build badge(s); a command path keeps only its last name. */
export function tabName(title: string): string {
  let name = title;
  while (BADGE.test(name)) name = name.replace(BADGE, '');
  name = name.trim();
  return name.startsWith('/') ? baseName(name.split(/\s+/)[0]!) : name;
}

/** Insert escape marks into a PLAIN line at cell positions, in one pass (escapes take no width, so click ranges stay). */
export function markCells(line: string, marks: readonly { readonly at: number; readonly text: string }[]): string {
  let out = '';
  let used = 0;
  const at = (cell: number): string => marks.filter((mark) => mark.at === cell).map((mark) => mark.text).join('');
  for (const { segment } of new Intl.Segmenter().segment(line)) {
    out += at(used);
    out += segment;
    used += Bun.stringWidth(segment);
  }
  return out + at(used);
}

/** Wrap cells [from, to) of a plain line in reverse video. */
export function focusCells(line: string, from: number, to: number): string {
  return markCells(line, [{ at: from, text: FOCUS_ON }, { at: to, text: FOCUS_OFF }]);
}

const DIM_ON = '\u001b[2m';
const DIM_OFF = '\u001b[22m';

/** The selected workspace's panes as tabs; the focused one in reverse video. Overflow keeps the focused tab and shows ‹ / ›. */
export function buildTabRow(rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number): TabRow {
  const chosen = selectedSpace(rows, selectedPane);
  const panes = rows.filter((row) => row.wsId === chosen);
  if (panes.length === 0 || width < 3) return { tabs: [] };
  // ELS-REMOTE-MARKER: a tab of a host that is down keeps its «?» (unreachable is not a status dot).
  const labels = panes.map((row) => ({ pane: row.pane, text: `${paneEmoji(row)} ${row.agent ?? tabName(row.title)}${row.stale ? ` ${UNREACHABLE_MARK}` : ''}` }));
  const cells = (text: string) => Bun.stringWidth(text);
  const chosenAt = Math.max(0, labels.findIndex((label) => label.pane === selectedPane));
  const total = labels.reduce((sum, label) => sum + cells(label.text) + cells(TAB_SEP), 0) + cells(NEW_TAB);
  let first = 0;
  if (total > width) {
    const room = width - 2; // a leading ‹ and a trailing ›
    while (first < chosenAt && labels.slice(first, chosenAt + 1).reduce((sum, label) => sum + cells(label.text) + cells(TAB_SEP), 0) > room) first++;
  }
  let line = first > 0 ? '‹' : '';
  const tabs: { from: number; to: number; pane: string }[] = [];
  let last = first - 1;
  for (let at = first; at < labels.length; at++) {
    const piece = labels[at]!.text + TAB_SEP;
    const reserve = at < labels.length - 1 ? 1 : cells(NEW_TAB);
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
  else line += NEW_TAB;
  const focused = tabs.find((tab) => tab.pane === selectedPane);
  const plain = fitCells(line, width);
  // ELS-FIRST-RUN-LIVE-PANE: an exited pane's tab is dimmed (it stays; nothing closes it on its own).
  const exited = new Set(panes.filter((row) => row.state === 'exited').map((row) => row.pane));
  const marks = [
    ...tabs.filter((tab) => exited.has(tab.pane)).flatMap((tab) => [{ at: tab.from, text: DIM_ON }, { at: tab.to, text: DIM_OFF }]),
    ...(focused ? [{ at: focused.from, text: FOCUS_ON }, { at: focused.to, text: FOCUS_OFF }] : []),
  ];
  return { line: marks.length > 0 ? markCells(plain, marks) : plain, tabs };
}
