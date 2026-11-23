// els client · ELS-ONE-SPACE (decision 11-18 «사이드탭 제품 분리»: the side panel is els's, not eln's) — herdr's layout as two
// pure parts the attach app draws:
//   • the folded space list (left): a «spaces» head, one line per workspace — the most urgent status dot inside it and the
//     UPPERCASE name (the selected one reverse video, its path on the line under it) — and «new · menu» last; no pane
//     lines, no category headings, no pane count;
//   • the tab row (top of the centre): the selected workspace's panes as «title [glyph]» tabs, ‹ › when they do not
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
  /** ELS-POD-TAB: the pane's physical place from the ls answer ({ host, runtime }); a pod runtime draws the tab badge. */
  readonly place?: { readonly host?: string; readonly runtime: 'process' | 'pod' };
  /** ELS-AGENTS-HIDE-SHELL: the server says the pane runs a bare shell now (kind «shell», or a shell command with no agent in front). */
  readonly bareShell?: boolean;
}

const STALL_MARK = '⏸';
/** ELS-POD-TAB: the explicit place.runtime=pod badge. The 📦 emoji stays WHAT the pane runs (kubectl); «[pod]» marks WHERE — a pod place under the host. */
const POD_BADGE = '[pod]';

/** `els ls` rows with each pane's command (for its emoji); same order and the same skips as parsePaneRows. */
export function withCommands(rows: readonly PaneRow[], listJson: string): SpaceTabRow[] {
  let panes: unknown;
  try { panes = (JSON.parse(listJson) as { panes?: unknown }).panes; } catch { panes = undefined; }
  const commands = new Map<string, readonly string[]>();
  const agents = new Map<string, string>();
  const stalled = new Set<string>();
  const places = new Map<string, { host?: string; runtime: 'process' | 'pod' }>();
  const bareShells = new Set<string>();
  if (Array.isArray(panes)) {
    for (const raw of panes) {
      const row = raw as { pane?: unknown; command?: unknown; kind?: unknown; fgCommand?: unknown; stalled?: unknown; place?: unknown };
      if (!raw || typeof row.pane !== 'string') continue;
      if (row.stalled === true) stalled.add(row.pane);
      // ELS-POD-TAB: the server's place rides the same lane as command/stalled — validated, then passed through.
      const place = row.place as { host?: unknown; runtime?: unknown } | undefined;
      const runtime = place?.runtime === 'pod' ? 'pod' as const : place?.runtime === 'process' ? 'process' as const : undefined;
      if (place && runtime) places.set(row.pane, { ...(typeof place.host === 'string' ? { host: place.host } : {}), runtime });
      if (Array.isArray(row.command)) commands.set(row.pane, row.command.map(String));
      // ELS-PANE-AGENT-DETECT: an agent in the foreground now decides the emoji and the name; a shell (again) or any
      // other program keeps the pane's own.
      if (typeof row.kind === 'string' && AGENT_KINDS.has(row.kind) && Array.isArray(row.fgCommand)) {
        commands.set(row.pane, row.fgCommand.map(String));
        agents.set(row.pane, row.kind);
      } else if (row.kind === 'shell' || (row.kind === undefined && Array.isArray(row.command) && isShellCommand(row.command.map(String)))) {
        // ELS-AGENTS-HIDE-SHELL: an agent that exited leaves its tab at a plain prompt — kept in the tab bar, not an agent.
        bareShells.add(row.pane);
      }
    }
  }
  return rows.map((row) => ({ ...row, ...(bareShells.has(row.pane) ? { bareShell: true } : {}), ...(commands.has(row.pane) ? { command: commands.get(row.pane)! } : {}), ...(agents.has(row.pane) ? { agent: agents.get(row.pane)! } : {}), ...(stalled.has(row.pane) ? { stalled: true } : {}), ...(places.has(row.pane) ? { place: places.get(row.pane)! } : {}) }));
}

const AGENT_KINDS = new Set(['eln', 'codex', 'claude', 'grok']);
// decision 11-18 emoji set: 💬 chat ⌨️ shell 🤖 agent 🛠 harness 📦 pod 🌐 remote.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'nu', 'pwsh']);
const AGENTS = new Set(['claude', 'codex', 'grok', 'gemini', 'opencode', 'aider']);
const CHATS = new Set(['eln', 'elanous', 'elanous.mjs']);
// 출처: #38438 review must[2] — runtime wrappers (bun/node/…) are skipped to expose the real executable; agent and
// chat names are matched against that executable only, never against arguments (ssh claude, kubectl exec <pod>…).
const WRAPPERS = new Set(['bun', 'bunx', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'deno']);
const baseName = (part: string) => part.split('/').pop() ?? part;
const isShellCommand = (command: readonly string[]): boolean => {
  let at = 0;
  while (at + 1 < command.length && WRAPPERS.has(baseName(command[at]!))) at++;
  return command.length > 0 && SHELLS.has(baseName(command[at]!).replace(/^-/, ''));
};
/** ELS-AGENTS-HIDE-SHELL: a local pane with no agent that runs a bare shell or has exited — never an agents row of its own. */
const isBareShell = (row: SpaceTabRow): boolean => !row.agent && !row.remote && (row.bareShell === true || row.state === 'exited');
const EXITED_MARK = '⏹';

/**
 * ELS-AGENTS-HIDE-SHELL (OP 11-23 screenshot: «OP · eln» and «OP ✅ · shell» both under agents): the agents panel lists
 * agent panes only. A bare-shell pane is dropped; when its seat has no other pane left in the list, the seat gets one
 * «⏹ SEAT exited» row instead (one per seat, however many dead tabs it has). A shell pane without a seat shows nothing.
 */
export function agentPanelRows<T extends { readonly row: SpaceTabRow }>(entries: readonly T[], all: readonly SpaceTabRow[]): { readonly entry: T; readonly exited: boolean }[] {
  const liveSeats = new Set(all.filter((row) => row.seat && !isBareShell(row)).map((row) => `${row.remote ?? ''}|${row.seat}`));
  const exitedShown = new Set<string>();
  const out: { entry: T; exited: boolean }[] = [];
  for (const entry of entries) {
    if (!isBareShell(entry.row)) { out.push({ entry, exited: false }); continue; }
    const seat = entry.row.seat;
    if (!seat || liveSeats.has(`|${seat}`) || exitedShown.has(seat)) continue;
    exitedShown.add(seat);
    out.push({ entry, exited: true });
  }
  return out;
}

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

const URGENCY: readonly StatusWord[] = ['failed', 'blocked', 'working', 'unknown', 'idle', 'done'];
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
  readonly emptySpaces: readonly { readonly y: number; readonly ws: string }[];
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
 * ELS-SIDEBAR-HERDR-CLEAN (decision 11-21 «워크스페이스 쪽이 왜 이리 지저분하죠»): herdr's list — a «spaces» head, one line per
 * workspace «● NAME» (the name UPPERCASE for display only, one status dot = the most urgent state inside it), the selected
 * space's path on one dim line under it (home as «~», cut by cells), «new · menu» pinned to the last line. No pane count.
 */
export function layoutSpaceList(rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number, height: number, home?: string, ceoPendingRed = 0, emptyCoordinators: readonly { wsId: string; name: string; remote?: string; stale?: boolean }[] = [], selectedEmpty?: string, agentsOrder: 'grouped' | 'status' = 'grouped', actingSeat?: string): SpaceListLayout {
  const chosen = selectedEmpty ?? selectedSpace(rows, selectedPane);
  type Item = { readonly text: string; readonly ws?: string; readonly pane?: string; readonly mode?: 'focus' | 'dim'; readonly bold?: boolean };
  // 출처: OP #134199/#134203 — 스페이스 줄에는 동작 상태를 표시하지 않는다(조율자 ⭐ 표식과 원격 사망 ✕만).
  const isActing = (row: SpaceTabRow): boolean => !!actingSeat && !row.remote && row.seat === actingSeat;
  const nameOf = (space: Space): string => `${space.panes.some(isActing) ? '[OP 대행] ' : ''}${space.panes.some((row) => row.stale) ? `${UNREACHABLE_MARK} ` : ''}${space.panes.some((row) => row.role === 'coordinator') ? '⭐ ' : ''}${space.name.toLocaleUpperCase()}${actingSeat && space.panes.some(row => !row.remote && row.seat === 'OP') ? ` → ${actingSeat} acting` : ''}`;
  const items: Item[] = [];
  const pendingEmpty = emptyCoordinators.filter((space) => !rows.some((row) => row.wsId === space.wsId));
  const addEmpty = (space: typeof pendingEmpty[number]): void => {
    const baton = actingSeat && !space.remote && space.name.toLocaleUpperCase() === 'OP' ? ` → ${actingSeat} acting` : '';
    items.push({ text: headCells(` ${space.stale ? `${UNREACHABLE_MARK} ` : ''}⭐ ${space.name.toLocaleUpperCase()}${baton}`, width), ws: space.wsId, ...(chosen === space.wsId ? { mode: 'focus' as const } : {}) });
  };
  for (const space of pendingEmpty.filter((space) => !space.remote)) addEmpty(space);
  const spaceLine = (space: Space, indent: string): void => {
    const selected = space.wsId === chosen;
    items.push({ text: headCells(` ${indent}${nameOf(space)}`, width), ws: space.wsId, pane: space.panes[0]!.pane, ...(selected ? { mode: 'focus' as const } : {}) });
    // 출처: OP #134227 — 포커스된 스페이스만 2줄(부제 «N agents · 가지»), 그 어떤 스페이스도 2줄을 넘지 않는다.
    const cwd = space.panes[0]!.cwd;
    const branch = cwd ? (baseName(cwd) || cwd) : space.name;
    if (selected) items.push({ text: `   ${indent}${tailCells(`${space.panes.length} agent${space.panes.length === 1 ? '' : 's'} · ${branch}`, Math.max(1, width - 3 - indent.length))}`, mode: 'dim' });
  };
  // ELS-FIRST-RUN-FU3 ③: herdr's seat panes are one bundle under a «herdr» head, folded unless one of its spaces is selected.
  const all = spacesOf(rows);
  // A HERDR coordinator must remain visible and ahead of ordinary spaces even
  // when the HERDR bundle is folded. Do not render it again in the bundle.
  const pinned = all.filter((space) => space.wsId.startsWith(HERDR_WS_PREFIX) && space.panes.some((row) => row.role === 'coordinator'));
  const visible = all.filter((space) => !space.wsId.startsWith(HERDR_WS_PREFIX) || pinned.includes(space));
  const herdr = all.filter((space) => space.wsId.startsWith(HERDR_WS_PREFIX) && !pinned.includes(space));
  const herdrOpen = herdr.some((space) => space.wsId === chosen);
  const shownEmptyHosts = new Set<string>();
  const addHostEmpty = (host: string | undefined): void => {
    if (!host || shownEmptyHosts.has(host)) return;
    shownEmptyHosts.add(host);
    for (const space of pendingEmpty.filter((entry) => entry.remote === host)) addEmpty(space);
  };
  for (const space of visible) { addHostEmpty(space.panes[0]?.remote); spaceLine(space, ''); }
  addHostEmpty(herdr[0]?.panes[0]?.remote);
  if (herdr.length > 0) {
    items.push({ text: `${herdrOpen ? ' ⊟' : ' ⊞'} HERDR · ${herdr.length}` });
    if (herdrOpen) for (const space of herdr) spaceLine(space, '  ');
  }
  for (const space of pendingEmpty) addHostEmpty(space.remote);
  // 출처: OP #134199/#134203/#134223 — 아래 칸 «agents»: herdr 식 2단 행(1줄 = 상태 이모지 ⊕ 이름 · 2줄 = 흐린 부제
  // «런타임 · 소속 스페이스»)·머리 단어가 정렬 모드다 — «grouped» = 스페이스별 묶음 안에서 상태순(working →
  // blocked → stalled → idle → failed → offline), «status» = 스페이스를 평탄해 전체 상태순. width < 20 이면 1단으로 줄인다(OP #134220 «좁으면 상태 이모지 + 탭 이름만»).
  const agentSpaces = [...visible, ...(herdrOpen ? herdr : [])];
  const rankOf = (row: SpaceTabRow): number => row.stale ? 6    // 출처: OP #134223 — 상태순 정렬 계수(working 0 → offline 6, 미지 word 5)
    : { working: 0, blocked: 1, stalled: 2, idle: 3, failed: 4, done: 5, unknown: 5 }[wordOfState(row.state)] ?? 5; // done = 스펙 순서 밖(완료·dim) — 미지 폴백(5)과 동급
  const twoLine = width >= 20;
  if (agentSpaces.length > 0) {
    items.push({ text: '─'.repeat(width) });
    // ELS-AGENTS-GROUPED-TOGGLE-FU (OP #134722 ②): the head word is the mode — «grouped» keeps herdr's
    // 스페이스별 묶음, «status» flattens every space's panes into one rank order(같은 계수 — OP #134223).
    const orderWord = agentsOrder === 'status' ? 'status' : 'grouped';
    items.push({ text: ` agents${' '.repeat(Math.max(1, width - 7 - orderWord.length))}${orderWord}` });
    const ordered: readonly { readonly space: Space; readonly row: SpaceTabRow }[] = agentsOrder === 'status'
      ? agentSpaces.flatMap((space) => space.panes.map((row) => ({ space, row }))).sort((a, b) => rankOf(a.row) - rankOf(b.row))
      : agentSpaces.flatMap((space) => [...space.panes].sort((a, b) => rankOf(a) - rankOf(b)).map((row) => ({ space, row })));
    for (const { entry: { space, row }, exited } of agentPanelRows(ordered, rows)) {
      if (exited) {
        items.push({ text: headCells(` ${EXITED_MARK} ${row.seat} exited`, width), pane: row.pane, ws: space.wsId, ...(row.pane === selectedPane ? { mode: 'focus' as const } : {}) });
        if (twoLine) items.push({ text: `       shell · ${space.name}`, mode: 'dim' });
        continue;
      }
      const mark = row.stale ? UNREACHABLE_MARK : STATUS[wordOfState(row.state)].mark;
      items.push({ text: headCells(` ${mark} ${isActing(row) ? '[OP 대행] ' : ''}${row.remote ? `⇄${row.remote} ` : ''}${labelName(row)}`, width), pane: row.pane, ws: space.wsId, ...(row.spaceCoordinator ? { bold: true } : {}), ...(row.pane === selectedPane ? { mode: 'focus' as const } : {}) });
      if (twoLine) items.push({ text: `       ${row.agent ?? 'shell'} · ${space.name}`, mode: 'dim' });
    }
  }
  const head = height >= 3;
  const foot = height >= 2;
  const room = height - (head ? 1 : 0) - (foot ? 1 : 0);
  const at = Math.max(0, items.findIndex((item) => item.mode === 'focus'));
  const tail = items[at + 1]?.mode === 'dim' ? 1 : 0;      // the selected name and its path line show together
  const start = items.length <= room ? 0 : Math.min(at, Math.max(Math.min(Math.max(0, at - Math.floor(room / 2)), items.length - room), at + tail + 1 - room));
  const lines: string[] = [];
  const spaces: { y: number; ws: string; pane: string }[] = [];
  const emptySpaces: { y: number; ws: string }[] = [];
  if (head) lines.push(ceoPendingRed !== 0
    ? `\u001b[31m${fitCells(ceoPendingRed < 0 ? ' 🔴 대표 대기 글 확인 불가' : ` 🔴 대표 대기 글 ${ceoPendingRed}`, width)}\u001b[39m`
    : `\u001b[2m${fitCells(SPACE_LIST_HEAD, width)}\u001b[22m`);
  for (const item of items.slice(start, start + room)) {
    if (item.ws !== undefined) {
      if (item.pane !== undefined) spaces.push({ y: lines.length + 1, ws: item.ws, pane: item.pane });
      else emptySpaces.push({ y: lines.length + 1, ws: item.ws });
    }
    const fitted = fitCells(item.text, width);
    const text = item.bold ? `\u001b[1m${fitted}\u001b[22m` : fitted;
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
  return { lines, spaces, emptySpaces, ...(newBox ? { newBox, menuBox: menuBox! } : {}) };
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

// ELS-FIRST-RUN-FU3 (OP #101592 · #101606): the tab row reads like herdr's — one name per tab, «+» (new tab) last.
// ELS-AGENT-STATUS-UNKNOWN-AND-TAB-BAR (OP 11-23): no runtime emoji on a tab (the agents list shows the runtime); ⭐ marks the
// space's coordinator tab; one status glyph only when the tab is not plainly working or idle; two cells of padding inside
// each tab and two between tabs. A narrow row cuts the name, never the glyphs. No command path (a path keeps its last name), no build badge, no status dot, no ▸.
// ELS-TAB-STYLE-HERDR (decision 11-21): herdr's look — names UPPERCASE (display only; the stored title is untouched), each tab a padded
// block: the focused one on a blue background (SGR 44;37), every other one on a gray background (SGR 100;37). Basic 16-colour SGR.
const TAB_SEP = '  ';
const TAB_PAD = '  ';
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

/**
 * ELS-TAB-NAME-LABEL-FIRST: the tab reads the seat/tab name (its title) first; the agent kind (eln · codex · claude · grok)
 * names it only when the title is empty or just a default command name (a shell, an agent or chat CLI, a runtime wrapper).
 * The kind stays visible in the agents list and the dropdown's emoji. 출처: #39040 put the kind over every title («JUD-B» read «ELN»).
 */
const DEFAULT_COMMAND_NAMES = new Set([...SHELLS, ...AGENTS, ...CHATS, ...WRAPPERS, ...AGENT_KINDS]);
const labelName = (row: SpaceTabRow): string => {
  const name = tabName(row.title);
  if (!row.agent) return name;
  return name === '' || DEFAULT_COMMAND_NAMES.has(name.replace(/^-/, '').toLowerCase()) ? row.agent : name;
};

/** The dropdown list's «emoji [⇄host ]name» line: a pane of another host carries ⇄host (the local host has no mark). */
const remoteLabel = (row: SpaceTabRow): string => {
  const name = labelName(row);
  // Keyboard emoji presentation has terminal-dependent width (xterm renders ⌨️ as one cell while Bun counts two).
  // Force its text presentation and explicitly pad it to two cells, keeping drawing and hitboxes aligned.
  const icon = paneEmoji(row);
  const emoji = icon === '⌨️' ? '⌨︎ ' : icon;
  return `${row.spaceCoordinator ? '⭐ ' : ''}${emoji} ${row.remote ? `⇄${row.remote} ` : ''}${name}`;
};

/** The one glyph a tab carries after its name: down host ✕, exited or failed 🔴, waiting on a person 🟡, stalled ⏸; none otherwise. */
const tabStatusGlyph = (row: SpaceTabRow): string =>
  row.stale ? UNREACHABLE_MARK : row.state === 'exited' || row.state === 'failed' ? STATUS.failed.mark
    : row.state === 'blocked' ? STATUS.blocked.mark : row.stalled ? STATUS.stalled.mark : '';

/** A tab in three parts, so a narrow row can cut the name and keep the ⭐ and the status glyph. */
const tabParts = (row: SpaceTabRow): { head: string; name: string; tail: string } => {
  const glyph = tabStatusGlyph(row);
  // ELS-POD-TAB: «[pod]» badges the tab row right after the name (the 📦 emoji stays in the dropdown — WHAT the pane
  // runs; «[pod]» is WHERE, a pod place under the host), inside the name part so a narrow row cuts it as the name gives way.
  return { head: `${TAB_PAD}${row.spaceCoordinator ? '⭐ ' : ''}`, name: `${row.remote ? `⇄${row.remote} ` : ''}${labelName(row).toUpperCase()}${row.place?.runtime === 'pod' ? ` ${POD_BADGE}` : ''}`, tail: `${glyph ? ` ${glyph}` : ''}${TAB_PAD}` };
};

/** A tab drawn into `room` cells: the name gives way first; ⭐, the status glyph and the padding stay while they fit at all. */
const fitTab = ({ head, name, tail }: { head: string; name: string; tail: string }, room: number): string => {
  const nameRoom = room - Bun.stringWidth(head) - Bun.stringWidth(tail);
  return nameRoom >= 0 ? head + clipCells(name, nameRoom) + tail : fitCells(head + name + tail, room);
};

/** The selected workspace's panes as tabs; the focused one in reverse video. Overflow keeps the focused tab and shows ‹ / ›. */
export function buildTabRow(rows: readonly SpaceTabRow[], selectedPane: string | undefined, width: number): TabRow {
  const chosen = selectedSpace(rows, selectedPane);
  const panes = rows.filter((row) => row.wsId === chosen);
  if (panes.length === 0 || width < 3) return { tabs: [] };
  // ELS-REMOTE-MARKER: a tab of a host that is down keeps its «✕» (unreachable is not a status dot).
  const labels = panes.map((row) => { const parts = tabParts(row); return { pane: row.pane, parts, text: parts.head + parts.name + parts.tail }; });
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
      const text = fitTab(labels[chosenAt]!.parts, room);
      tabs.push({ from: cells(line), to: cells(line) + Math.min(cells(text), room), pane: labels[chosenAt]!.pane });
      line += fitCells(text, room);
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

export type DropdownTarget = { readonly pane: string } | { readonly ws: string };
type EmptyDropdownSpace = { readonly wsId: string; readonly name: string; readonly remote?: string; readonly stale?: boolean };
const sameTarget = (a: DropdownTarget | undefined, b: DropdownTarget | undefined): boolean =>
  !!a && !!b && ('pane' in a ? 'pane' in b && a.pane === b.pane : 'ws' in b && a.ws === b.ws);

/** Empty coordinator workspaces are targets in their own right, not synthetic panes. */
function dropdownLines(rows: readonly SpaceTabRow[], empty: readonly EmptyDropdownSpace[]): { text: string; target?: DropdownTarget }[] {
  const lines: { text: string; target?: DropdownTarget }[] = [];
  const pending = empty.filter((space) => !rows.some((row) => row.wsId === space.wsId));
  const hosts = new Set<string>();
  const addEmpty = (space: EmptyDropdownSpace): void => {
    lines.push({ text: `  ⭐ ${space.name}${space.stale ? ` ${UNREACHABLE_MARK}` : ''}`, target: { ws: space.wsId } });
  };
  for (const space of pending.filter((space) => !space.remote)) addEmpty(space);
  const addHost = (host: string | undefined): void => {
    if (!host || hosts.has(host)) return;
    hosts.add(host);
    for (const space of pending.filter((entry) => entry.remote === host)) addEmpty(space);
  };
  for (const space of spacesOf(rows)) {
    addHost(space.panes[0]?.remote);
    lines.push({ text: `${DIM_ON} ${space.panes.some((row) => row.role === 'coordinator') ? '⭐ ' : ''}${space.name}${DIM_OFF}` });
    for (const row of space.panes) lines.push({ text: `  ${remoteLabel(row)} ${markOf([row])}`, target: { pane: row.pane } });
  }
  for (const space of pending) addHost(space.remote);
  return lines;
}
export const dropdownTargets = (rows: readonly SpaceTabRow[], empty: readonly EmptyDropdownSpace[]): DropdownTarget[] =>
  dropdownLines(rows, empty).flatMap((line) => line.target ? [line.target] : []);

export interface TabDropdown {
  readonly line: string;
  readonly list: readonly string[];
  readonly hits: readonly ({ readonly y: number } & DropdownTarget)[];
}

/** ELS-NARROW-TAB-DROPDOWN: window the list around the selected pane or empty workspace. */
export function buildTabDropdown(rows: readonly SpaceTabRow[], selectedPane: string | undefined, cursor: string | undefined, width: number, maxLines: number,
  empty: readonly EmptyDropdownSpace[] = [], selectedEmpty?: string, emptyCursor?: string): TabDropdown {
  const now = rows.find((row) => row.pane === selectedPane) ?? rows[0];
  const currentEmpty = empty.find((space) => space.wsId === selectedEmpty);
  const target: DropdownTarget | undefined = emptyCursor !== undefined ? { ws: emptyCursor } : cursor !== undefined ? { pane: cursor } : undefined;
  const lines = dropdownLines(rows, empty);
  const at = Math.max(0, lines.findIndex((line) => sameTarget(line.target, target)));
  const start = lines.length <= maxLines ? 0 : Math.max(0, Math.min(at - Math.floor(maxLines / 2), lines.length - maxLines));
  const shown = lines.slice(start, start + maxLines);
  // The narrow header is the tab row in one tab: the same rule (cut the name, keep ⭐ · glyph · padding), with room left for « ▾».
  const upper = currentEmpty ? ` ⭐ ${currentEmpty.name} ` : now ? fitTab(tabParts(now), Math.max(0, width - 2)) : '';
  return {
    line: upper ? markCells(fitCells(`${upper} ▾`, width), [{ at: 0, text: TAB_ACTIVE_ON }, { at: Bun.stringWidth(clipCells(upper, width)), text: TAB_OFF }]) : fitCells('▾', width),
    list: shown.map((line) => sameTarget(line.target, target) ? `${FOCUS_ON}${fitCells(line.text, width)}${FOCUS_OFF}` : fitCells(line.text, width)),
    hits: shown.flatMap((line, index) => line.target ? [{ y: index + 2, ...line.target }] : []),
  };
}
