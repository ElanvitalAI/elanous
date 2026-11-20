// els client · ELS-ONE-SPACE (대표 11-18 «사이드탭 제품 분리»: the side panel is els's, not eln's) — herdr's layout as two
// pure parts the attach app draws:
//   • the folded space list (left): a «spaces» head, one line per workspace — the most urgent status dot inside it and the
//     UPPERCASE name (the selected one reverse video, its path on the line under it) — and «new · menu» last; no pane
//     lines, no category headings, no pane count;
//   • the tab row (top of the centre): the selected workspace's panes as «emoji title mark» tabs, ‹ › when they do not
//     fit, no row at all when the workspace has no panes.
// Input = the `els ls` rows (attach-view parsePaneRows) plus each pane's command, for the emoji. Plain text: colour and
// reverse video are the composer's (attach-view). Nothing here imports eln.

import { clipCells, fitCells, UNREACHABLE_MARK, wordOfState, type PaneRow } from './attach-view.js';
import { STATUS, type StatusWord } from './status-vocab.js';

export interface SpaceTabRow extends PaneRow {
  readonly command?: readonly string[];
  /** ELS-PANE-AGENT-DETECT: the agent running in the pane's foreground now (eln · codex · claude · grok) — the tab's name. */
  readonly agent?: string;
  /** ELS-TAB-STATE-BADGE: the server's stall verdict for the pane (a working pane with no event for the window). */
  readonly stalled?: boolean;
}

const STALL_MARK = '⏸';

/** `els ls` rows with each pane's command (for its emoji); same order and the same skips as parsePaneRows. */
export function withCommands(rows: readonly PaneRow[], listJson: string): SpaceTabRow[] {
  let panes: unknown;
  try { panes = (JSON.parse(listJson) as { panes?: unknown }).panes; } catch { panes = undefined; }
  const commands = new Map<string, readonly string[]>();
  const agents = new Map<string, string>();
  const stalled = new Set<string>();
  if (Array.isArray(panes)) {
    for (const raw of panes) {
      const row = raw as { pane?: unknown; command?: unknown; kind?: unknown; fgCommand?: unknown; stalled?: unknown };
      if (!raw || typeof row.pane !== 'string') continue;
      if (row.stalled === true) stalled.add(row.pane);
      if (Array.isArray(row.command)) commands.set(row.pane, row.command.map(String));
      // ELS-PANE-AGENT-DETECT: an agent in the foreground now decides the emoji and the name; a shell (again) or any
      // other program keeps the pane's own.
      if (typeof row.kind === 'string' && AGENT_KINDS.has(row.kind) && Array.isArray(row.fgCommand)) {
        commands.set(row.pane, row.fgCommand.map(String));
        agents.set(row.pane, row.kind);
      }
    }
  }
  return rows.map((row) => ({ ...row, ...(commands.has(row.pane) ? { command: commands.get(row.pane)! } : {}), ...(agents.has(row.pane) ? { agent: agents.get(row.pane)! } : {}), ...(stalled.has(row.pane) ? { stalled: true } : {}) }));
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
/**
 * The stalled badge (ELS-TAB-STATE-BADGE), kept apart from markOf so it composes with the other precedence edits to it. Most urgent
 * state wins (WORKER-MIGRATION-PHASE1-1119): an unreachable space (every pane stale), then failed and blocked (approval wait) outrank
 * stalled, so a stalled pane never hides a failed or approval-waiting pane in the same space; stalled outranks plain working.
 */
const stalledMark = (rows: readonly (PaneRow & { readonly stalled?: boolean })[]): string | undefined => {
  if (!rows.some((row) => row.stalled) || rows.every((row) => row.stale)) return undefined;
  const words = rows.map((row) => wordOfState(row.state));
  return words.includes('failed') || words.includes('blocked') ? undefined : STALL_MARK;
};
const markOf = (rows: readonly PaneRow[]): string => {
  const stall = stalledMark(rows);
  if (stall) return stall;
  // ELS-REMOTE-MARKER: a space whose host is down (every pane stale) reads «✕», not its last live state.
  if (rows.length > 0 && rows.every((row) => row.stale)) return UNREACHABLE_MARK;
  const words = rows.map((row) => row.state === 'failed' ? 'failed' as const : wordOfState(row.state));
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

export const SPACE_LIST_HEAD = ' spaces';
/** ELS-SIDEBAR-HERDR-CLEAN: the list's last line, herdr's «new · menu» (the word cells are the hit boxes). */
export const SPACE_LIST_END = ' new · menu';
/** parseRemoteRows gives herdr panes the workspace id `herdr:<ws>`. */
export const HERDR_WS_PREFIX = 'herdr:';

export interface SidebarBox { readonly y: number; readonly from: number; readonly to: number }
export interface SpaceListLayout {
  /** Exactly `height` lines of `width` cells. */
  readonly lines: string[];
  /** One per visible space name row: `y` = screen row (1-based; the first list line is row 1), `pane` = the space's first pane. */
  readonly spaces: readonly { readonly y: number; readonly ws: string; readonly pane: string }[];
  /** The words «new» and «menu» in the last line (columns zero-based, end exclusive); absent when the list is too short to show it. */
  readonly newBox?: SidebarBox;
  readonly menuBox?: SidebarBox;
}

/** The last `width` cells of `text`, led by «…» when it was cut (a path keeps its tail: the folder you are in). */
function tailCells(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((one) => one.segment);
  let used = 1;
  let out = '';
  for (let at = parts.length - 1; at >= 0; at--) {
    const cells = Bun.stringWidth(parts[at]!);
    if (used + cells > width) break;
    out = parts[at]! + out;
    used += cells;
  }
  return `…${out}`;
}
const headCells = (text: string, width: number): string => Bun.stringWidth(text) <= width ? text : `${clipCells(text, Math.max(0, width - 1))}…`;
const homePath = (cwd: string, home: string | undefined): string => home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;

/**
 * ELS-SIDEBAR-HERDR-CLEAN (대표 11-21 «워크스페이스 쪽이 왜 이리 지저분하죠»): herdr's list — a «spaces» head, one line per
 * workspace «● NAME» (the name UPPERCASE for display only, one status dot = the most urgent state inside it), the selected
 * space's path on one dim line under it (home as «~», cut by cells), «new · menu» pinned to the last line. No pane count.
 */
export function layoutSpaceList(rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number, height: number, home?: string): SpaceListLayout {
  const chosen = selectedSpace(rows, selectedPane);
  type Item = { readonly text: string; readonly ws?: string; readonly pane?: string; readonly mode?: 'focus' | 'dim' };
  const nameOf = (space: Space): string => `${markOf(space.panes)} ${space.name.toLocaleUpperCase()}`;
  const items: Item[] = [];
  const spaceLine = (space: Space, indent: string): void => {
    const selected = space.wsId === chosen;
    items.push({ text: headCells(` ${indent}${nameOf(space)}`, width), ws: space.wsId, pane: space.panes[0]!.pane, ...(selected ? { mode: 'focus' as const } : {}) });
    const cwd = space.panes[0]!.cwd;
    if (selected && cwd) items.push({ text: `   ${indent}${tailCells(homePath(cwd, space.panes[0]!.remote ? undefined : home), Math.max(1, width - 3 - indent.length))}`, mode: 'dim' });
  };
  // ELS-FIRST-RUN-FU3 ③: herdr's seat panes are one bundle under a «herdr» head, folded unless one of its spaces is selected.
  const all = spacesOf(rows);
  const mine = all.filter((space) => !space.wsId.startsWith(HERDR_WS_PREFIX));
  const herdr = all.filter((space) => space.wsId.startsWith(HERDR_WS_PREFIX));
  const herdrOpen = herdr.some((space) => space.wsId === chosen);
  for (const space of mine) spaceLine(space, '');
  if (herdr.length > 0) {
    items.push({ text: `${herdrOpen ? ' ⊟' : ' ⊞'} HERDR · ${herdr.length}` });
    if (herdrOpen) for (const space of herdr) spaceLine(space, '  ');
  }
  const head = height >= 3;
  const foot = height >= 2;
  const room = height - (head ? 1 : 0) - (foot ? 1 : 0);
  const at = Math.max(0, items.findIndex((item) => item.mode === 'focus'));
  const tail = items[at + 1]?.mode === 'dim' ? 1 : 0;      // the selected name and its path line show together
  const start = items.length <= room ? 0 : Math.min(at, Math.max(Math.min(Math.max(0, at - Math.floor(room / 2)), items.length - room), at + tail + 1 - room));
  const lines: string[] = [];
  const spaces: { y: number; ws: string; pane: string }[] = [];
  if (head) lines.push(`\u001b[2m${fitCells(SPACE_LIST_HEAD, width)}\u001b[22m`);
  for (const item of items.slice(start, start + room)) {
    if (item.ws !== undefined) spaces.push({ y: lines.length + 1, ws: item.ws, pane: item.pane! });
    const text = fitCells(item.text, width);
    lines.push(item.mode === 'focus' ? `${FOCUS_ON}${text}${FOCUS_OFF}` : item.mode === 'dim' ? `\u001b[2m${text}\u001b[22m` : text);
  }
  while (lines.length < height - (foot ? 1 : 0)) lines.push(' '.repeat(width));
  let newBox: SidebarBox | undefined;
  let menuBox: SidebarBox | undefined;
  if (foot) {
    const gap = SPACE_LIST_END.indexOf('new');
    newBox = { y: lines.length + 1, from: gap, to: gap + 3 };
    menuBox = { y: lines.length + 1, from: SPACE_LIST_END.indexOf('menu'), to: SPACE_LIST_END.indexOf('menu') + 4 };
    lines.push(fitCells(SPACE_LIST_END, width));
  }
  return { lines, spaces, ...(newBox ? { newBox, menuBox: menuBox! } : {}) };
}

/** The folded space list: exactly `height` lines of `width` cells (see layoutSpaceList for the hit boxes). */
export const buildSpaceList = (rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number, height: number, home?: string): string[] =>
  layoutSpaceList(rows, selectedPane, width, height, home).lines;

export interface TabRow {
  /** The row, or none when the selected workspace has no panes. */
  readonly line?: string;
  /** Each tab's columns in the row (zero-based, end exclusive) and its pane — for clicks. */
  readonly tabs: readonly { readonly from: number; readonly to: number; readonly pane: string }[];
  /** ELS-NEW-TAB-NAME-WIDGET: the «+» cell (zero-based, end exclusive) — a click opens the new-tab name prompt. Absent when the row overflows («›» instead). */
  readonly plus?: { readonly from: number; readonly to: number };
}

// ELS-FIRST-RUN-FU3 (OP #101592 · #101606): the tab row reads like herdr's — «emoji name» per tab, two spaces between,
// «+» (new tab) last. No command path (a path keeps its last name), no build badge, no status dot, no ▸.
// ELS-TAB-STYLE-HERDR (대표 11-21): herdr's look — names UPPERCASE (display only; the stored title is untouched), each tab a padded
// block: the focused one on a blue background (SGR 44;37), every other one on a gray background (SGR 100;37). Basic 16-colour SGR.
const TAB_SEP = ' ';
const TAB_PAD = ' ';
const NEW_TAB = '+';
const FOCUS_ON = '\u001b[7m';
const FOCUS_OFF = '\u001b[27m';
export const TAB_ACTIVE_ON = '\u001b[44;37m';
export const TAB_INACTIVE_ON = '\u001b[100;37m';
export const TAB_OFF = '\u001b[49;39m';
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

/** «emoji [⇄host ]name»: a pane of another host carries ⇄host in its tab title (the local host has no mark). */
const remoteLabel = (row: SpaceTabRow, upper = false): string => {
  const name = row.agent ?? tabName(row.title);
  return `${paneEmoji(row)} ${row.remote ? `⇄${row.remote} ` : ''}${upper ? name.toUpperCase() : name}`;   // ELS-TAB-STYLE-HERDR: UPPERCASE name only (host and emoji as they are)
};

/** The selected workspace's panes as tabs; the focused one in reverse video. Overflow keeps the focused tab and shows ‹ / ›. */
export function buildTabRow(rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number): TabRow {
  const chosen = selectedSpace(rows, selectedPane);
  const panes = rows.filter((row) => row.wsId === chosen);
  if (panes.length === 0 || width < 3) return { tabs: [] };
  // ELS-REMOTE-MARKER: a tab of a host that is down keeps its «✕» (unreachable is not a status dot).
  const labels = panes.map((row) => ({ pane: row.pane, text: `${TAB_PAD}${remoteLabel(row, true)}${row.stale ? ` ${UNREACHABLE_MARK}` : row.stalled ? ` ${STALL_MARK}` : ''}${TAB_PAD}` }));
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
  let plus: { from: number; to: number } | undefined;
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
  else { plus = { from: cells(line), to: cells(line) + cells(NEW_TAB) }; line += NEW_TAB; }
  const focused = tabs.find((tab) => tab.pane === selectedPane);
  const plain = fitCells(line, width);
  // ELS-FIRST-RUN-LIVE-PANE: an exited pane's tab is dimmed (it stays; nothing closes it on its own).
  const exited = new Set(panes.filter((row) => row.state === 'exited').map((row) => row.pane));
  const marks = [
    ...tabs.filter((tab) => exited.has(tab.pane)).flatMap((tab) => [{ at: tab.from, text: DIM_ON }, { at: tab.to, text: DIM_OFF }]),
    ...tabs.flatMap((tab) => [{ at: tab.from, text: tab === focused ? TAB_ACTIVE_ON : TAB_INACTIVE_ON }, { at: tab.to, text: TAB_OFF }]),
  ];
  return { line: marks.length > 0 ? markCells(plain, marks) : plain, tabs, ...(plus ? { plus } : {}) };
}

/** The panes in the order the dropdown lists them (spaces in first-seen order, each space's tabs together). */
export const dropdownOrder = (rows: readonly SpaceTabRow[]): string[] => spacesOf(rows).flatMap((space) => space.panes.map((row) => row.pane));

export interface TabDropdown {
  /** The folded top row: «emoji current-tab-name ▾». */
  readonly line: string;
  /** The open list: a dim space heading, then its tabs «emoji name mark» (status mark = the same one as the space list); the cursor tab in reverse video. */
  readonly list: readonly string[];
  /** Click targets: the screen row (1-based; the list starts under the top row) of each tab line. */
  readonly hits: readonly { readonly y: number; readonly pane: string }[];
}

/** ELS-NARROW-TAB-DROPDOWN: the narrow screen's replacement for the side list + tab row. `maxLines` windows the list around the cursor. */
export function buildTabDropdown(rows: readonly SpaceTabRow[], selectedPane: string | undefined, cursor: string | undefined, width: number, maxLines: number): TabDropdown {
  const label = remoteLabel;
  const upper = (row: SpaceTabRow): string => `${TAB_PAD}${remoteLabel(row, true)}${TAB_PAD}`;
  const now = rows.find((row) => row.pane === selectedPane) ?? rows[0];
  const lines: { text: string; pane?: string }[] = [];
  for (const space of spacesOf(rows)) {
    lines.push({ text: `${DIM_ON} ${space.name}${DIM_OFF}` });
    for (const row of space.panes) lines.push({ text: `  ${label(row)} ${markOf([row])}`, pane: row.pane });
  }
  const at = Math.max(0, lines.findIndex((line) => line.pane === cursor));
  const start = lines.length <= maxLines ? 0 : Math.max(0, Math.min(at - Math.floor(maxLines / 2), lines.length - maxLines));
  const shown = lines.slice(start, start + maxLines);
  return {
    line: now ? markCells(fitCells(`${upper(now)} ▾`, width), [{ at: 0, text: TAB_ACTIVE_ON }, { at: Bun.stringWidth(upper(now)), text: TAB_OFF }]) : fitCells('▾', width),
    list: shown.map((line) => line.pane !== undefined && line.pane === cursor ? `${FOCUS_ON}${fitCells(line.text, width)}${FOCUS_OFF}` : fitCells(line.text, width)),
    hits: shown.flatMap((line, index) => line.pane !== undefined ? [{ y: index + 2, pane: line.pane }] : []),
  };
}
