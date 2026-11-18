// els attach view — the minimal centre-pane renderer (ELS-ATTACH-VIEW stage 2): the server's screen text, clipped to this
// terminal, one status line under it, and the herdr prefix keys. No colours of its own; status words come later from
// status-vocab. Pure functions: the terminal itself is wired in src/cli/els-cli.ts.

import { StringDecoder } from 'node:string_decoder';
import { childSummary, STATUS, type StatusColor, type StatusWord } from './status-vocab.js';

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

const SGR = /(\u001b\[[0-9;]*m)/;

/** `text` (may carry SGR colour sequences) cut to `width` terminal cells and padded; escapes cost no width, and any colour
 *  still open at the cut is closed with a reset so it cannot bleed into the next column. Other escapes are dropped. */
export function fitAnsi(text: string, width: number): string {
  let out = '';
  let used = 0;
  let styled = false;
  for (const part of text.split(SGR)) {
    if (SGR.test(part)) { out += part; styled = part !== '\u001b[0m' && part !== '\u001b[m'; continue; }
    for (const { segment } of graphemes.segment(part.replace(/\u001b\[[0-9;?]*[A-Za-ln-z]/g, ''))) {
      const cells = Bun.stringWidth(segment);
      if (used + cells > width) return `${out}${styled ? `${ESC}[0m` : ''}${' '.repeat(Math.max(0, width - used))}`;
      out += segment;
      used += cells;
    }
  }
  return `${out}${styled ? `${ESC}[0m` : ''}${' '.repeat(Math.max(0, width - used))}`;
}

export interface ViewInput { readonly screen: string; readonly cols: number; readonly rows: number; readonly status: string }

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
  return ` ${pane}${note ? ` · ${note}` : ''} · ctrl+b q 분리 `;
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

export const ENTER_VIEW = `${ESC}[?1049h${ESC}[2J${ESC}[H`;
export const LEAVE_VIEW = `${ESC}[?1049l`;

// ---- Stage 3: the herdr-shaped screen — spaces on the left, the live pane in the middle, one status line --------------

export const SIDEBAR_COLS = 28;
// 출처: seat-state/HAND-CLAUDE-ELS/DESIGN-ELS-ATTACH-VIEW.md §6 «좁은 터미널(<60칸) → 사이드바 자동 접힘»
export const MIN_COLS_FOR_SIDEBAR = 60;

export interface PaneRow {
  readonly pane: string; readonly wsId: string; readonly workspace: string; readonly title: string; readonly state: string;
  /** Set on a pane of another host (a registered els host or `herdr`): `pane` is then its full address `host:ws/tab/pane`. */
  readonly remote?: string;
}

/** The rows of an `els ls` answer, in the server's order. Anything that is not a list gives no rows. */
export function parsePaneRows(listJson: string): PaneRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(listJson); } catch { return []; }
  const panes = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { panes?: unknown }).panes : undefined;
  if (!Array.isArray(panes)) return [];
  const rows: PaneRow[] = [];
  for (const raw of panes) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.pane !== 'string' || typeof row.address !== 'string') continue;
    rows.push({ pane: row.pane, wsId: row.address.split('/')[0] ?? '', workspace: String(row.workspace ?? ''), title: String(row.title ?? row.pane), state: String(row.state ?? '') });
  }
  return rows;
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
  const rows: PaneRow[] = [];
  for (const raw of panes) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (row.reach !== 'up' || typeof row.host !== 'string' || typeof row.address !== 'string' || typeof row.ws !== 'string') continue;
    const title = String(row.title ?? '');
    const split = row.host === 'herdr' ? title.indexOf(' · ') : -1;
    const label = split > 0 ? title.slice(0, split) : row.ws;
    rows.push({ pane: row.address, wsId: `${row.host}:${row.ws}`, workspace: `⇄${row.host} ${label}`, title: split > 0 ? title.slice(split + 3) : title || String(row.pane ?? row.address),
      state: String(row.state ?? ''), remote: row.host });
  }
  return rows;
}

/** Pane state → the shared status word (`exited` reads as done: the screen it left is still there). */
export function wordOfState(state: string): StatusWord {
  return state === 'working' ? 'working' : state === 'blocked' ? 'blocked' : state === 'idle' ? 'idle' : 'done';
}

const COLOR_SGR: Readonly<Record<StatusColor, string>> = { green: `${ESC}[32m`, yellow: `${ESC}[33m`, dim: `${ESC}[2m`, red: `${ESC}[31m` };
const markOf = (word: StatusWord): string => `${COLOR_SGR[STATUS[word].color]}${STATUS[word].mark}${ESC}[0m`;
const REVERSE = `${ESC}[7m`;

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

export const sidebarWidthFor = (cols: number, open: boolean): number => open && cols >= MIN_COLS_FOR_SIDEBAR ? SIDEBAR_COLS : 0;

const CURSOR_HEADER = /^\[screen \d+x\d+ cursor=\(row (\d+), col (\d+), visible (true|false)\)\]\n/;

export interface ComposeInput {
  readonly cols: number; readonly rows: number; readonly sidebar: readonly string[] | null; readonly frame: string; readonly status: string;
  /** ELS-ONE-SPACE: the selected space's tab row (space-tabs-view buildTabRow), drawn as the centre's first line; the pane
   *  sits under it. Absent = no row (the pane starts at the top). */
  readonly tabRow?: string;
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
    const centreText = row < top ? fitCells(view.tabRow!, centre) : fitAnsi(body[row - top] ?? '', centre);
    lines.push(`${sidebar ? `${fitAnsi(sidebar[row] ?? '', SIDEBAR_COLS)}│` : ''}${centreText}`);
  }
  lines.push(`${REVERSE}${fitCells(view.status, view.cols)}${ESC}[0m`);
  const cursorRow = header ? Number(header[1]) + top : -1;
  const cursorCol = header ? Number(header[2]) : -1;
  const showCursor = header !== null && header[3] === 'true' && cursorRow < view.rows - 1 && cursorCol < centre;
  const place = showCursor ? `${ESC}[${cursorRow + 1};${left + cursorCol + 1}H${ESC}[?25h` : `${ESC}[?25l`;
  return `${ESC}[?25l${ESC}[H${lines.join('\r\n')}${place}`;
}

export const SIDEBAR_HELP = 'ctrl+b: j/k 이동 · w 작업공간 · 1-9 · c 새 pane · a 엘라누스 채팅 · N 새 작업공간 · x 닫기 · D 작업공간 닫기 · s 사이드바 · q 분리';
