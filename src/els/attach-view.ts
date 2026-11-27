// els attach view — the minimal centre-pane renderer (ELS-ATTACH-VIEW stage 2): the server's screen text, clipped to this
// terminal, one status line under it, and the herdr prefix keys. No colours of its own; status words come later from
// status-vocab. Pure functions: the terminal itself is wired in src/cli/els-cli.ts.

import { StringDecoder } from 'node:string_decoder';
import { childSummary, STATUS, wordOfSeatState, type StatusColor, type StatusWord } from './status-vocab.js';
import { parsePaneSeatStatus } from './seat-status.js';
import { isWaiting, needsPerson } from './seat-marks.js';
import type { BlockReason, SeatState } from '../agent-events/protocol.js';

const ESC = '\u001b';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** `text` cut to `width` terminal cells (wide characters count 2), padded with spaces. */
export function fitCells(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > width) break;
    out += segment;
    used += cells;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

/** `text` cut to `width` terminal cells (wide characters count 2), not padded. */
export function clipCells(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > width) break;
    out += segment;
    used += cells;
  }
  return out;
}

// One escape sequence of the pane's ANSI frame. SGR keeps its colon sub-parameters (`4:1` underline style, `58:2::r:g:b`), which the
// emulator emits for underlined cells; every other CSI, OSC (BEL or ST terminated, e.g. OSC 8 links) and two-byte escape is
// dropped. Escapes cost no cells: only the characters between them are measured.
const ESCAPE = /(\u001b\[[0-9;:]*m)|\u001b\[[0-9;:?<=> ]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[^[\]]?/g;
const isSgrReset = (sgr: string): boolean => /^\u001b\[0*(?:;0*)*m$/.test(sgr);

/** `text` (may carry SGR colour sequences) cut to `width` terminal cells and padded; escapes cost no width, and any colour
 *  still open at the cut is closed with a reset so it cannot bleed into the next column. Other escapes are dropped. */
export function fitAnsi(text: string, width: number): string {
  let out = '';
  let used = 0;
  let styled = false;
  const close = (): string => `${styled ? `${ESC}[0m` : ''}${' '.repeat(Math.max(0, width - used))}`;
  let from = 0;
  const take = (plain: string): boolean => {
    for (const { segment } of graphemes.segment(plain)) {
      const cells = Bun.stringWidth(segment);
      if (used + cells > width) return false;
      out += segment;
      used += cells;
    }
    return true;
  };
  for (const match of text.matchAll(ESCAPE)) {
    if (!take(text.slice(from, match.index))) return `${out}${close()}`;
    from = match.index + match[0].length;
    if (match[1] !== undefined) { out += match[1]; styled = !isSgrReset(match[1]); }
  }
  if (!take(text.slice(from))) return `${out}${close()}`;
  return `${out}${close()}`;
}

/** `base` (a row that may carry SGR colour) with the cells [at, at + width) replaced by `piece` cut and padded to `width`.
 *  The colour open at the cut point on the right is carried over; a wide glyph straddling either edge becomes a space. */
export function spliceCells(base: string, at: number, piece: string, width: number): string {
  let used = 0;
  let sgr = '';
  let right = '';
  let from = 0;
  const end = at + width;
  const take = (plain: string): void => {
    for (const { segment } of graphemes.segment(plain)) {
      const cells = Bun.stringWidth(segment);
      if (used >= end) right += segment;
      else if (used + cells > end) right += ' '.repeat(used + cells - end);
      used += cells;
    }
  };
  for (const match of base.matchAll(ESCAPE)) {
    take(base.slice(from, match.index));
    from = match.index + match[0].length;
    if (match[1] === undefined) continue;
    if (used >= end) right += match[1];
    else sgr = isSgrReset(match[1]) ? '' : sgr + match[1];
  }
  take(base.slice(from));
  return `${fitAnsi(base, at)}${ESC}[0m${fitAnsi(piece, width)}${ESC}[0m${sgr}${right}`;
}

/** ELS-APP-RENDER-SINGLE-FRAME: a dialog's rows, drawn with their top-left cell at (x, y) — 0-based — each `width` cells. */
export interface DialogBox { readonly x: number; readonly y: number; readonly width: number; readonly lines: readonly string[] }

export interface ViewInput { readonly screen: string; readonly cols: number; readonly rows: number; readonly status: string }

/** ELS-ATTACH-FRAME-DIFF (OP #127484 ③): the rows that changed since the previous painted body. `prev === undefined`
 *  means «everything is new» (the first paint of a view, or a repaint after a lost screen): every row counts as changed
 *  and no incremental paint is possible, so `paint` stays empty and the caller does one full repaint. A body that
 *  shrank (a resize down) repaints nothing incremental either: the caller's full repaint already covered it. */
export function changedRowsPaint(prev: readonly string[] | undefined, next: readonly string[], cols: number): { changed: number[]; paint: string } {
  if (prev === undefined || prev.length !== next.length) return { changed: next.map((_, i) => i), paint: '' };
  const changed: number[] = [];
  for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) changed.push(i);
  if (changed.length === 0) return { changed: [], paint: '' };
  // herdr protocol/render_ansi.rs pattern: cursor-address each changed row (1-based), pad it to the full width, no cursor move back —
  // the next changed row's addressing supersedes the old position.
  const paint = changed.map((row) => `${ESC}[${row + 1};1H${fitAnsi(next[row] ?? '', cols)}`).join('');
  return { changed, paint };
}

/** One full repaint: cursor home, the pane's lines (rows - 1 of them), then the status line in reverse video. */
export function drawView(view: ViewInput): string {
  // A live pane's screen starts with the emulator's «[screen 80x24 cursor=…]» header line (the `els pane read` format).
  const text = view.screen.replace(/^\[screen \d+x\d+ cursor=[^\]]*\]\n/, '');
  const body = text.replace(/\n+$/, '').split('\n').slice(0, Math.max(0, view.rows - 1));
  const lines: string[] = [];
  for (let row = 0; row < view.rows - 1; row++) lines.push(fitAnsi(body[row] ?? '', view.cols));
  lines.push(`${ESC}[7m${fitCells(view.status, view.cols)}${ESC}[0m`);
  return `${ESC}[H${lines.join(`\r\n`)}`;
}

/** The status line: where the pane is and how to leave. (Status words from status-vocab come with the left list, stage 3.) */
export function statusLine(pane: string, note?: string): string {
  return ` ${pane}${note ? ` · ${note}` : ''} · ctrl+b q detach `;
}

/** Keys from stdin, decoded as ONE stream: a multi-byte character (Korean…) split across two chunks is joined, never replaced. */
export function createKeyDecoder(): (chunk: Buffer) => string {
  const decoder = new StringDecoder('utf8');
  return (chunk) => decoder.write(chunk);
}

/** The pane's last screen as plain text for the normal terminal buffer: emulator header dropped, trailing blank lines cut. */
export function lastScreenText(screen: string): string {
  return screen.replace(/^\[screen \d+x\d+ cursor=[^\]]*\]\n/, '').replace(/\s+$/, '');
}

/** herdr's prefix: ctrl+b then a key. `q` detaches, ctrl+b twice sends one literal ctrl+b, any other key after the prefix is
 *  dropped (herdr's other keys arrive in later stages) and reported so the status line can say so. */
export function createPrefixFilter(): { feed: (bytes: string) => { send: string; detach: boolean; ignored: string } } {
  let armed = false;
  return {
    feed(bytes) {
      let send = '';
      let ignored = '';
      for (const char of bytes) {
        if (armed) {
          armed = false;
          if (char === 'q') return { send, detach: true, ignored };
          if (char === '\u0002') send += char;
          else ignored += char;
        } else if (char === '\u0002') armed = true;
        else send += char;
      }
      return { send, detach: false, ignored };
    },
  };
}

// Bare `els` (the app view) is mouse-driven: tab/button clicks arrive as SGR (1006) press reports, so the terminal must be asked
// to send them (1000 = button reports). Disabled again in reverse order on leave.
// ELS-TYPING-LATENCY: ?2004h — the person's terminal wraps a paste in ESC[200~ … ESC[201~, so the pane program gets the
// paste as ONE paste (not a stream of typed keys, each redrawn and a newline submitting early). The server drops the
// markers for a pane that did not ask for bracketed paste itself.
export const ENTER_VIEW = `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h${ESC}[2J${ESC}[H`;
export const LEAVE_VIEW = `${ESC}[?2004l${ESC}[?1006l${ESC}[?1000l${ESC}[?1049l`;
// `els attach <pane>`: ELS-WHEEL-HISTORY — mouse reporting ON (1000 + 1006 SGR) so a wheel over the pane is seen at all.
// Before this the terminal sent no wheel (or turned it into ↑/↓ itself) and eln's history never moved. Every report is
// routed by createPaneViewMouse (attach-mouse.ts) — none reaches a pane that does not track its own mouse.
// ELS-WHEEL-HISTORY: the pane view's mouse router lives with the mouse parser; re-exported so the CLI keeps one view import.
export { createPaneViewMouse } from './attach-mouse.js';
export const ENTER_PANE_VIEW = `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[2J${ESC}[H`;
export const LEAVE_PANE_VIEW = `${ESC}[?1006l${ESC}[?1000l${ESC}[?1049l`;

// ---- Stage 3: the herdr-shaped screen — spaces on the left, the live pane in the middle, one status line --------------

export const SIDEBAR_COLS = 28;
// 출처: seat-state/HAND-CLAUDE-ELS/DESIGN-ELS-ATTACH-VIEW.md §6 «좁은 터미널(<60칸) → 사이드바 자동 접힘»
export const MIN_COLS_FOR_SIDEBAR = 60;

export interface PaneRow {
  readonly pane: string; readonly tabId?: string; readonly wsId: string; readonly workspace: string; readonly title: string; readonly state: string;
  /** Set on a pane of another host (a registered els host or `herdr`): `pane` is then its full address `host:ws/tab/pane`. */
  readonly remote?: string;
  /** ELS-REMOTE-MARKER: its host is reported down — the last known row stays in the list, dimmed and marked «✕». */
  readonly stale?: boolean;
  /** Authoritative role from the workspace listing (never inferred from the title). */
  readonly role?: 'coordinator';
  readonly spaceCoordinator?: boolean;
  /** Seat reported by the local server, not inferred from a mutable tab title. */
  readonly seat?: string;
  /** ELS-SIDEBAR-HERDR-CLEAN: the pane's working folder (the selected space's path line). */
  readonly cwd?: string;
  /** SIDETAB-TWO-MARKS: the seat state code the pane published, its reason, and the seat's unread mail — the attention mark's inputs. */
  readonly seatState?: SeatState;
  readonly seatReason?: BlockReason;
  readonly seatSource?: 'reported' | 'derived';
  readonly unread?: number;
  /** DEMO-FANOUT-LIVE-OP-SEAT: the pane that opened this one through the tool door (a worker child) and the turns it finished. */
  readonly parentPane?: string;
  readonly turnsDone?: number;
}

/** Mark of a host the federated list reports down (design DESIGN-ELS-SIDETAB-SERVER §원격 «⇄aws1 ✕»; same «✕ ⇄host · 연결 끊김» as the sidetab rows). */
export const UNREACHABLE_MARK = '✕';

export function buildBadge(value: unknown, unknown = '[build unknown]'): string {
  const build = value && typeof value === 'object' ? value as { sha?: unknown; age?: unknown; version?: unknown; stamp?: unknown; channel?: unknown } : {};
  if (typeof build.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(build.sha)) return unknown;
  const version = typeof build.version === 'string' && build.version.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(build.version) ? build.version : undefined;
  const stamp = typeof build.stamp === 'string' && build.stamp.length === 11 && /^\d{6}_\d{4}$/.test(build.stamp) ? build.stamp : undefined;
  const channel = build.channel === 'official' || build.channel === 'dev' ? build.channel : undefined;
  const age = build.age === 'current' || build.age === 'older' || build.age === 'different' ? build.age : 'unknown';
  return `[자체보고·미인증:${[version, channel, stamp, build.sha.slice(0, 7), age].filter(Boolean).join(' ')}]`;
}

/** Group by host and stably put each host's coordinator workspace first. Pane order within a workspace is unchanged. */
function coordinatorFirst(rows: PaneRow[]): PaneRow[] {
  const hosts = new Map<string, Map<string, PaneRow[]>>();
  for (const row of rows) {
    const host = row.remote ?? '';
    if (!hosts.has(host)) hosts.set(host, new Map());
    const spaces = hosts.get(host)!;
    if (!spaces.has(row.wsId)) spaces.set(row.wsId, []);
    spaces.get(row.wsId)!.push(row);
  }
  return [...hosts.values()].flatMap((spaces) => {
    const groups = [...spaces.values()];
    return [...groups.filter((group) => group.some((row) => row.role === 'coordinator')),
      ...groups.filter((group) => !group.some((row) => row.role === 'coordinator'))].flat();
  });
}

/** Keep empty coordinator workspaces as metadata, never fabricate attachable panes. */
export function emptyCoordinatorSpaces(listJson: string, rows: readonly PaneRow[]): { wsId: string; name: string }[] {
  try {
    const workspaces = (JSON.parse(listJson) as { workspaces?: unknown }).workspaces;
    if (!Array.isArray(workspaces)) return [];
    return workspaces.flatMap((ws) => ws && typeof ws === 'object' && ws.role === 'coordinator'
      && typeof ws.id === 'string' && typeof ws.name === 'string' && !rows.some(row => row.wsId === ws.id)
      ? [{ wsId: ws.id, name: ws.name }] : []);
  } catch { return []; }
}

/** Remote metadata is kept separate from panes, so an empty space cannot become an attach target. */
export function emptyRemoteCoordinators(listJson: string, rows: readonly PaneRow[]): { wsId: string; name: string; remote: string; stale?: boolean }[] {
  try {
    const spaces = (JSON.parse(listJson) as { remoteWorkspaces?: unknown }).remoteWorkspaces;
    if (!Array.isArray(spaces)) return [];
    return spaces.flatMap((ws) => ws && typeof ws === 'object' && ws.role === 'coordinator' && ws.reach === 'up'
      && typeof ws.host === 'string' && typeof ws.id === 'string' && typeof ws.name === 'string'
      && !rows.some((row) => row.wsId === `${ws.host}:${ws.id}`)
      ? [{ wsId: `${ws.host}:${ws.id}`, name: `⇄${ws.host} ${ws.name}`, remote: ws.host }] : []);
  } catch { return []; }
}

/** The rows of an `els ls` answer. Anything that is not a list gives no rows. */
export function parsePaneRows(listJson: string): PaneRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(listJson); } catch { return []; }
  const panes = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { panes?: unknown }).panes : undefined;
  if (!Array.isArray(panes)) return [];
  const workspaces = (parsed as { workspaces?: unknown }).workspaces;
  const coordinators = new Set<string>();
  if (Array.isArray(workspaces)) for (const raw of workspaces) {
    if (raw && typeof raw === 'object' && raw.role === 'coordinator' && typeof raw.id === 'string') coordinators.add(raw.id);
  }
  const tabs = (parsed as { tabs?: Array<{ id: string; label: string }> }).tabs ?? [];
  const rows: PaneRow[] = [];
  for (const raw of panes) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.pane !== 'string' || typeof row.address !== 'string') continue;
    const wsId = row.address.split('/')[0] ?? '';
    rows.push({ pane: row.pane, ...(typeof row.tab === 'string' ? { tabId: row.tab } : {}), wsId, ...(coordinators.has(wsId) ? { role: 'coordinator' as const } : {}), ...(row.spaceCoordinator === true ? { spaceCoordinator: true } : {}), ...(typeof row.seat === 'string' && row.seat ? { seat: row.seat } : {}), workspace: String(row.workspace ?? ''), title: `${String(tabs.find(tab => tab.id === row.tab)?.label ?? row.title ?? row.pane)} ${buildBadge(row.build)}`, state: rowState(row), ...markFields(row), ...(typeof row.cwd === 'string' && row.cwd ? { cwd: row.cwd } : {}),
      ...(typeof row.parentPane === 'string' && row.parentPane ? { parentPane: row.parentPane, turnsDone: typeof row.turnsDone === 'number' && Number.isSafeInteger(row.turnsDone) && row.turnsDone > 0 ? row.turnsDone : 0 } : {}) });
  }
  return coordinatorFirst(rows);
}

/**
 * The panes of OTHER hosts in a federated `els ls` answer (reach «up»), as list rows: `pane` is the address, the workspace
 * line reads «⇄host label» (herdr titles are «workspace · name» — split there; any other host groups by its workspace id).
 * The local host's own panes are not taken from here (the local list comes from the owner, fast and without waiting on hosts).
 */
export function parseRemoteRows(listJson: string): PaneRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(listJson); } catch { return []; }
  const panes = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { panes?: unknown }).panes : undefined;
  if (!Array.isArray(panes)) return [];
  const spaces = (parsed as { remoteWorkspaces?: unknown }).remoteWorkspaces;
  const rows: PaneRow[] = [];
  for (const raw of panes) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (row.reach !== 'up' || typeof row.host !== 'string' || typeof row.address !== 'string' || typeof row.ws !== 'string') continue;
    const title = String(row.title ?? '');
    const split = row.host === 'herdr' ? title.indexOf(' · ') : -1;
    const space = Array.isArray(spaces) ? spaces.find((ws) => ws && typeof ws === 'object' && ws.host === row.host && ws.id === row.ws && typeof ws.name === 'string') : undefined;
    const label = split > 0 ? title.slice(0, split) : space?.name ?? row.ws;
    rows.push({ pane: row.address, wsId: `${row.host}:${row.ws}`, workspace: `⇄${row.host} ${label}`, title: `${split > 0 ? title.slice(split + 3) : title || String(row.pane ?? row.address)} ${buildBadge(row.build)}`,
      state: rowState(row), ...markFields(row), remote: row.host, ...(row.role === 'coordinator' ? { role: 'coordinator' as const } : {}), ...(row.spaceCoordinator === true ? { spaceCoordinator: true } : {}), ...(typeof row.cwd === 'string' && row.cwd ? { cwd: row.cwd } : {}) });
  }
  return coordinatorFirst(rows);
}

/** SEAT-STATE-ENUM: a row's state word from its status code when the server sent one (WAITING_APPROVAL/BLOCKED 🟡, STALLED ⏸),
 *  else the activity state as before. The code decides; the pane's screen is never read for it. */
function rowState(row: Record<string, unknown>): string {
  const status = parsePaneSeatStatus(row.status);
  // SIDETAB-TWO-MARKS: a seat that needs a person (or waits on a reply/timer) is IDLE in slot 1; the attention mark says why.
  if (status && (needsPerson(status.state, status.reason, status.source) || isWaiting(status.state, status.reason, status.source))) return 'idle';
  return status ? wordOfSeatState(status.state) : String(row.activityState ?? row.state ?? '');
}

/** SIDETAB-TWO-MARKS: the attention inputs of a list row (codes and the mail badge only). */
function markFields(row: Record<string, unknown>): Pick<PaneRow, 'seatState' | 'seatReason' | 'seatSource' | 'unread'> {
  const status = parsePaneSeatStatus(row.status);
  const mail = (row.unreadMail as { count?: unknown } | null | undefined)?.count;
  return { ...(status ? { seatState: status.state, ...(status.reason ? { seatReason: status.reason } : {}), seatSource: status.source } : {}),
    ...(typeof mail === 'number' && mail > 0 ? { unread: mail } : {}) };
}

/** Pane state → the shared status word (`exited` reads as done: the screen it left is still there). */
export function wordOfState(state: string): StatusWord {
  // `failed` is a contract word no PaneState carries today; a list that says it (or a future server) must read as failed, not done.
  // 출처: OP #134199 — `stalled`(ELS-TAB-STATE-BADGE 판정)도 상태 단어로 읽는다(마크 ⏸, #134208 어휘).
  return state === 'working' ? 'working' : state === 'blocked' ? 'blocked' : state === 'stalled' ? 'stalled' : state === 'idle' ? 'idle' : state === 'failed' ? 'failed' : state === 'unknown' ? 'unknown' : 'done';
}

const COLOR_SGR: Readonly<Record<StatusColor, string>> = { green: `${ESC}[32m`, yellow: `${ESC}[33m`, dim: `${ESC}[2m`, red: `${ESC}[31m` };
const markOf = (word: StatusWord): string => `${COLOR_SGR[STATUS[word].color]}${STATUS[word].mark}${ESC}[0m`;
const REVERSE = `${ESC}[7m`;

// 출처: seat-state/OP/orders/ELS-FIRST-RUN-UX-1119.md ③ 하단 항상 · UX #38884 FIRST_RUN_HINT 리터럴
export const FIRST_RUN_HINT = 'ctrl+b c new shell · a chat · s list · j/k move · x close · q quit · ? help';

/** The workspace line shows the most urgent state inside it (blocked, then working, then idle, then done). */
function rolledUp(words: readonly StatusWord[]): StatusWord {
  for (const word of ['blocked', 'working', 'idle'] as const) if (words.includes(word)) return word;
  return 'done';
}

/** The left list: one line per workspace (rolled-up mark, name, «⎇n ●n» when several panes), its panes under it with their
 *  status mark in the shared colours; the selected pane in reverse video. Exactly `height` lines of `width` cells. */
export function buildSidebar(rows: readonly PaneRow[], selected: string | undefined, width: number, height: number): string[] {
  const lines: { text: string; selected: boolean }[] = [];
  const order = [...new Set(rows.map((row) => row.wsId))];
  for (const wsId of order) {
    const inside = rows.filter((row) => row.wsId === wsId);
    const words = inside.map((row) => wordOfState(row.state));
    const summary = inside.length > 1 ? ` ${childSummary(words)}` : '';
    lines.push({ text: ` ▾ ${markOf(rolledUp(words))} ${inside[0]!.workspace}${summary}`, selected: false });
    // A pane that has exited is dimmed whole: it is history, not something running.
    for (const row of inside) lines.push({ text: row.state === 'exited' ? `${ESC}[2m    ${STATUS.done.mark} ${row.title}${ESC}[0m` : `    ${markOf(wordOfState(row.state))} ${row.title}`, selected: row.pane === selected });
  }
  const at = Math.max(0, lines.findIndex((line) => line.selected));
  const start = lines.length <= height ? 0 : Math.max(0, Math.min(at - Math.floor(height / 2), lines.length - height));
  const shown = lines.slice(start, start + height).map((line) => {
    const fitted = fitAnsi(line.text, width);
    return line.selected ? `${REVERSE}${fitted.replaceAll(`${ESC}[0m`, `${ESC}[0m${REVERSE}`)}${ESC}[0m` : fitted;
  });
  while (shown.length < height) shown.push(' '.repeat(width));
  return shown;
}

/** ELS-NARROW-TAB-DROPDOWN: under this width the side list folds away and the tabs become one top row «emoji name ▾» that opens a list.
 *  (80 = the plain terminal width; the done-line needs 60 to be narrow, so this is above the old 60-col hide.) Widening to it restores the side list. */
export const NARROW_BELOW_COLS = 80;
export const sidebarWidthFor = (cols: number, open: boolean): number => open && cols >= NARROW_BELOW_COLS ? SIDEBAR_COLS : 0;

const CURSOR_HEADER = /^\[screen \d+x\d+ cursor=\(row (\d+), col (\d+), visible (true|false)\)\]\n/;

export interface ComposeInput {
  readonly cols: number; readonly rows: number; readonly sidebar: readonly string[] | null; readonly frame: string; readonly status: string;
  /** ELS-ONE-SPACE: the selected space's tab row (space-tabs-view buildTabRow), drawn as the centre's first line; the pane
   *  sits under it. Absent = no row (the pane starts at the top). */
  readonly tabRow?: string;
  /** ELS-EXIT-BG-BUTTONS: drawn at the right end of the status line (the status is cut to the room left). */
  readonly buttons?: string;
  /** ELS-NARROW-TAB-DROPDOWN: the open tab list, drawn over the pane from the row under the top row (the cursor is hidden). */
  readonly overlay?: readonly string[];
  /** ELS-APP-RENDER-SINGLE-FRAME: a dialog spliced into the rows it covers (the cursor is hidden) — one frame, no overlay write. */
  readonly dialog?: DialogBox;
  /** ELS-ZAXIS S2: the overlay stack's boxes, bottom → top, spliced over panes and the side list (under the client's own
   *  dialog). The pane cursor is hidden only when a box covers it. */
  readonly layers?: readonly DialogBox[];
  /** ELS-ZAXIS hardening: a focused overlay owns the keys — the pane cursor is hidden while it does (restored after). */
  readonly hideCursor?: boolean;
  /** ELS-POPUP-TERM: put the terminal cursor here (0-based view cell) — the focused popup terminal's own cursor. */
  readonly cursorAt?: { readonly x: number; readonly y: number };
}

/** One full repaint: sidebar (when it fits) | pane, the status line last, and the terminal cursor put where the pane's is. */
export function composeView(view: ComposeInput): string {
  const sidebar = view.sidebar !== null && view.cols >= MIN_COLS_FOR_SIDEBAR ? view.sidebar : null;
  const left = sidebar ? SIDEBAR_COLS + 1 : 0;
  const centre = view.cols - left;
  const header = CURSOR_HEADER.exec(view.frame);
  const body = view.frame.replace(CURSOR_HEADER, '').replace(/^\[screen [^\]]*\]\n/, '').replace(/\n+$/, '').split('\n');
  const top = view.tabRow !== undefined ? 1 : 0;
  const lines: string[] = [];
  for (let row = 0; row < view.rows - 1; row++) {
    const centreText = row < top ? fitAnsi(view.tabRow!, centre) : fitAnsi(body[row - top] ?? '', centre);
    lines.push(`${sidebar ? `${fitAnsi(sidebar[row] ?? '', SIDEBAR_COLS)}│` : ''}${centreText}`);
  }
  (view.overlay ?? []).forEach((text, at) => { if (at + 1 < lines.length) lines[at + 1] = fitAnsi(text, view.cols); });
  for (const layer of view.layers ?? []) layer.lines.forEach((text, at) => {
    const y = layer.y + at;
    if (y >= 0 && y < lines.length && layer.x < view.cols) lines[y] = spliceCells(lines[y]!, layer.x, text, Math.min(layer.width, view.cols - layer.x));
  });
  const box = view.dialog;
  box?.lines.forEach((text, at) => { if (box.y + at < lines.length) lines[box.y + at] = spliceCells(lines[box.y + at]!, box.x, text, Math.min(box.width, view.cols - box.x)); });
  // 출처: seat-state/OP/orders/ELS-FIRST-RUN-UX-1119.md ③ — status 는 리터럴 그대로 (패딩 없이; trimRight 화면 판독과 양립)
  // ELS-FIRST-RUN-FU3 ①: cut to the width (no padding) — a long status on a narrow terminal must not wrap and push the
  // whole repaint up a line.
  const buttons = view.buttons !== undefined && Bun.stringWidth(view.buttons) < view.cols ? view.buttons : '';
  const room = view.cols - Bun.stringWidth(buttons);
  const status = clipCells(view.status, room);
  lines.push(`${REVERSE}${status}${buttons ? `${' '.repeat(room - Bun.stringWidth(status))}${ESC}[0m${buttons}` : ''}${ESC}[0m`);
  const cursorRow = header ? Number(header[1]) + top : -1;
  const cursorCol = header ? Number(header[2]) : -1;
  const underLayer = (view.layers ?? []).some((layer) => left + cursorCol >= layer.x && left + cursorCol < layer.x + layer.width && cursorRow >= layer.y && cursorRow < layer.y + layer.lines.length);
  const showCursor = !view.overlay && !view.dialog && !underLayer && !view.hideCursor && header !== null && header[3] === 'true' && cursorRow < view.rows - 1 && cursorCol < centre;
  const at = view.cursorAt && !view.dialog && view.cursorAt.y < view.rows - 1 && view.cursorAt.x < view.cols ? view.cursorAt : undefined;
  const place = at ? `${ESC}[${at.y + 1};${at.x + 1}H${ESC}[?25h` : showCursor ? `${ESC}[${cursorRow + 1};${left + cursorCol + 1}H${ESC}[?25h` : `${ESC}[?25l`;
  return `${ESC}[?25l${ESC}[H${lines.join('\r\n')}${place}`;
}

/** DEC 2026 synchronized update: the terminal shows the frame between these two as one (herdr render_ansi). */
export const SYNC_BEGIN = `${ESC}[?2026h`;
export const SYNC_END = `${ESC}[?2026l`;
const COMPOSED_HEAD = `${ESC}[?25l${ESC}[H`;
const CURSOR_TAIL = /(?:\u001b\[\d+;\d+H\u001b\[\?25h|\u001b\[\?25l)$/;

/** ELS-APP-RENDER-SINGLE-FRAME: the terminal side of the full-screen app. Each composed frame (composeView's output) goes
 *  out as ONE write wrapped in a synchronized update; after the first frame only the rows that changed since the previous
 *  frame are written (changedRowsPaint), and an unchanged frame writes nothing. A different row count (the first frame, a
 *  resize) is a full repaint from home — no 2J (the view's entry already cleared the screen once). */
export function createAppFrameWriter(write: (text: string) => void): (screen: string) => void {
  let previous: string[] | undefined;
  let lastTail = '';
  return (screen) => {
    if (!screen.startsWith(COMPOSED_HEAD)) { previous = undefined; write(`${SYNC_BEGIN}${screen}${SYNC_END}`); return; }
    const rows = screen.slice(COMPOSED_HEAD.length).split('\r\n');
    const tail = CURSOR_TAIL.exec(rows[rows.length - 1]!)?.[0] ?? '';
    rows[rows.length - 1] = `${rows[rows.length - 1]!.slice(0, rows[rows.length - 1]!.length - tail.length)}${ESC}[K`;
    const cols = Bun.stringWidth(rows[0]!.replace(ESCAPE, ''));   // every composed row is exactly the terminal's width
    const step = changedRowsPaint(previous, rows, cols);
    const full = previous === undefined || previous.length !== rows.length;
    previous = rows;
    if (!full && step.changed.length === 0 && tail === lastTail) return;
    lastTail = tail;
    const paint = full ? `${COMPOSED_HEAD}${rows.join('\r\n')}` : `${ESC}[?25l${step.paint}`;
    write(`${SYNC_BEGIN}${paint}${tail}${SYNC_END}`);
  };
}

export const SIDEBAR_HELP = 'ctrl+b: m move tab · , rename tab · j/k move · w workspace · 1-9 · c new pane · a Elanous chat · N new workspace · x close · D close workspace · s sidebar · g sort agents · / sidechat · o Obsidian · PgUp/PgDn/Home/End list · ←/→ tabs · q detach';
