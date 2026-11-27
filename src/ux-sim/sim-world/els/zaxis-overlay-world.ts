// ELS-ZAXIS sim world — the z-axis overlay path end to end, deterministic and seeded: a REAL overlay registry (the els
// server's one stack, files under a temp dir, a fake clock and fake timers) wired to one or more REAL attach apps
// (createAttachApp with fake socket deps, the same shape as src/els/overlay-attach.test.ts). Scenarios drive raw key and
// SGR mouse bytes through app.key(...) and read back the rendered frames (ANSI stripped) and the registry state.
// The PRNG picks the path (scroll steps, which note, how many rapid cycles); every seed must reach the same invariants.
// Self-contained on purpose: not registered in the sim-world kernel/YAML ledger (the kernel wiring is a separate step).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachHandlers, Attached } from '../../../els/attach-client.js';
import { createAttachApp, type AttachApp, type AttachAppDeps } from '../../../els/attach-app.js';
import type { ElsResult } from '../../../els/core.js';
import type { ElsRequest } from '../../../els/server.js';
import { createOverlayRegistry, type OverlayRegistry } from '../../../els/overlay-registry.js';
import { createTabHostSync } from '../../../els/element-host.js';
import { closeLayer, emptyStack, focusLayer, openLayer, raiseLayer, updateLayer, type OpenSpec, type OverlayRect, type OverlayStack } from '../../../els/overlay-stack.js';
import { createAppFrameWriter } from '../../../els/attach-view.js';
import { Terminal } from '@xterm/headless';
import { elementKeys, elementRenderers } from '../../../els/elements/index.js';
import type { ElementContext } from '../../../els/elements/element.js';

/** mulberry32 — a tiny deterministic PRNG (same seed, same path). */
export function prng(seed: number): { readonly next: () => number; readonly int: (lo: number, hi: number) => number } {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) };
}

export const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
export const rowsOf = (screen: string): string[] => plain(screen).split('\r\n');
export const click = (x: number, y: number): string => `\u001b[<0;${x};${y}M`;
export const release = (x: number, y: number): string => `\u001b[<0;${x};${y}m`;
export const KEY = { down: 'j', up: 'k', enter: '\r', space: ' ', back: '\u007f', esc: '\u001b', tile: '\u0002t' } as const;

export interface PaneRow { readonly address: string; readonly workspace: string; readonly pane: string; readonly title: string; readonly state: string; readonly tab: string }
export const paneRow = (ws: string, pane: string, title: string): PaneRow => ({ address: `${ws}/t-${pane}/${pane}`, workspace: `name-${ws}`, pane, title, state: 'idle', tab: `t-${pane}` });

/** The fake els server clock and timers the registry arms (toast ttl) — every armed handle is tracked until it fires or is cleared. */
export interface FakeTimers {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly active: () => number;
}

export function fakeTimers(start = 1_700_000_000_000): FakeTimers {
  let clock = start;
  let nextId = 0;
  const armed = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => clock,
    advance(ms) {
      clock += ms;
      for (const [id, one] of [...armed].sort((a, b) => a[1].at - b[1].at)) if (one.at <= clock && armed.delete(id)) one.callback();
    },
    setTimer: (callback, ms) => { const id = ++nextId; armed.set(id, { at: clock + ms, callback }); return id; },
    clearTimer: (handle) => { armed.delete(handle as number); },
    active: () => armed.size,
  };
}

/** One attach stream a viewer opened (a pane, or ELS-POPUP-TERM's popup pane): what went in and how it was sized. */
export interface AttachmentLog {
  readonly pane: string; readonly typed: string[]; readonly handlers: AttachHandlers;
  /** The size asked at attach time, then every resize. */
  readonly size: { cols: number; rows: number }; readonly resizes: { cols: number; rows: number }[]; readonly scrolls: number[]; detached: boolean;
}

/** One attach window (a viewer) on the shared registry. */
export interface Viewer {
  readonly app: AttachApp;
  readonly attachments: AttachmentLog[];
  /** What reached the person's terminal: every composed screen through the real createAppFrameWriter (diff writes). */
  readonly wire: string[];
  /** Push one pane frame to the live attach (the server's frame stream); the screen may start with the cursor header. */
  readonly paneFrame: (screen: string) => void;
  /** The emulated terminal fed every wire write so far (@xterm/headless), read as cells. */
  readonly emulated: () => Promise<EmuScreen>;
  readonly writes: string[];
  readonly acts: { action: string; id: string; props?: unknown }[];
  readonly size: { cols: number; rows: number };
  readonly last: () => string[];
  readonly press: (...keys: string[]) => void;
  readonly clickAt: (x: number, y: number) => void;
  /** Fire the app's poll interval (the listing refresh) and let its promise chain settle. */
  readonly poll: () => Promise<void>;
  readonly watching: () => boolean;
  readonly dispose: () => void;
}

export interface ZaxisWorld {
  readonly root: string;
  readonly registry: OverlayRegistry;
  readonly timers: FakeTimers;
  readonly rand: ReturnType<typeof prng>;
  readonly listing: { panes: PaneRow[] };
  readonly setVault: (path: string) => void;
  readonly viewer: (opts?: ViewerOpts) => Promise<Viewer>;
  readonly openObsidian: (props?: Record<string, unknown>) => string;
  readonly dispose: () => void;
}

/** Where a viewer's overlay stack comes from: the real registry (default), a scripted stack, or none (a twin that never
 *  sees any overlay — the «pane only» reference). */
export interface StackSource {
  readonly stack: () => OverlayStack;
  readonly onChange: (listener: (stack: OverlayStack) => void) => { readonly dispose: () => void };
  readonly act: (one: { action: string; id: string; props?: unknown; frame?: string; dx?: number; dy?: number; view?: { cols: number; rows: number } }) => unknown;
}
export interface ViewerOpts {
  cols?: number; rows?: number; pane?: string; tile?: AttachAppDeps['tile']; source?: StackSource | 'none';
  /** Answer (and record) any request but `ls` — undefined falls back to the empty success. ELS-FILES: overlay opens, new tabs. */
  request?: (request: ElsRequest) => ElsResult | undefined;
}

/** A hand-driven overlay stack (the server's pure stack functions, no registry): any kind, any rect, rect updates. Acts from
 *  the client (close · raise · focus · update props) are applied the way the server applies them. */
export interface ScriptedStack extends StackSource {
  readonly open: (spec: OpenSpec) => string;
  readonly close: (id: string) => void;
  readonly raise: (id: string) => void;
  readonly focus: (id: string) => void;
  readonly setRect: (id: string, rect: OverlayRect) => void;
}
export function createScriptedStack(): ScriptedStack {
  let current = emptyStack();
  const listeners = new Set<(stack: OverlayStack) => void>();
  const commit = (next: OverlayStack): void => { if (next === current) return; current = next; for (const one of [...listeners]) one(current); };
  return {
    stack: () => current,
    onChange: (listener) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    act: (one) => {
      if (one.action === 'close') commit(closeLayer(current, one.id));
      else if (one.action === 'raise') commit(raiseLayer(current, one.id));
      else if (one.action === 'focus') commit(focusLayer(current, one.id));
      else if (one.action === 'update') {
        const layer = current.layers.find((l) => l.id === one.id);
        const props = { ...(layer?.props && typeof layer.props === 'object' ? layer.props as object : {}), ...(one.props && typeof one.props === 'object' ? one.props as object : {}) };
        commit(updateLayer(current, one.id, { props }));
      }
    },
    open: (spec) => { const made = openLayer(current, spec); commit(made.stack); return made.id; },
    close: (id) => commit(closeLayer(current, id)),
    raise: (id) => commit(raiseLayer(current, id)),
    focus: (id) => commit(focusLayer(current, id)),
    setRect: (id, rect) => commit(updateLayer(current, id, { rect })),
  };
}

/** One emulated screen: per row the cells (char, width) and the plain text; the cursor position (0-based). */
export interface EmuScreen { readonly rows: { chars: string[]; widths: number[]; text: string }[]; readonly cursor: { x: number; y: number } }

/** A headless terminal that measures glyphs the way the product does (Bun.stringWidth: emoji like 📓 and 😀 are 2 cells).
 *  xterm's built-in Unicode 6 table counts them as 1, which would shift every cell after one — not what a modern terminal
 *  draws. The property value packs (width << 1 | join) the way xterm's own providers do. */
export function emulatorTerminal(cols: number, rows: number): Terminal {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  // 출처: #40244 a terminal cell holds at most a 2-cell glyph (xterm IUnicodeVersionProvider.wcwidth: 0 | 1 | 2)
  const wcwidth = (point: number): 0 | 1 | 2 => Math.min(2, Bun.stringWidth(String.fromCodePoint(point))) as 0 | 1 | 2;
  term.unicode.register({
    version: 'bun-width',
    wcwidth,
    charProperties: (point, preceding) => {
      let width = wcwidth(point);
      let join = width === 0 && preceding !== 0;
      if (join) { const before = (preceding >> 1) & 3; if (before === 0) join = false; else if (before > width) width = before as 1 | 2; }
      return (width << 1) | (join ? 1 : 0);
    },
  });
  term.unicode.activeVersion = 'bun-width';
  return term;
}

/** Feed `writes` into a fresh (or the given) @xterm/headless terminal and read it back cell by cell. */
export async function emulate(term: Terminal, writes: readonly string[]): Promise<EmuScreen> {
  for (const one of writes) await new Promise<void>((done) => term.write(one, done));
  const buffer = term.buffer.active;
  const rows: EmuScreen['rows'] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)!;
    const chars: string[] = [];
    const widths: number[] = [];
    for (let x = 0; x < term.cols; x++) { const cell = line.getCell(x)!; chars.push(cell.getChars()); widths.push(cell.getWidth()); }
    rows.push({ chars, widths, text: line.translateToString(false) });
  }
  return { rows, cursor: { x: buffer.cursorX, y: buffer.cursorY } };
}

/** The reference composite: the last composed frame (no diffs) drawn alone on a fresh terminal of this size. */
export async function referenceOf(composed: string, size: { cols: number; rows: number }): Promise<EmuScreen> {
  const term = emulatorTerminal(size.cols, size.rows);
  try { return await emulate(term, [composed]); } finally { term.dispose(); }
}

const settle = async (): Promise<void> => { for (let at = 0; at < 5; at++) await Promise.resolve(); await new Promise((done) => setImmediate(done)); };

/** World options: `hostTabs` wires the REAL tab-host sync (createTabHostSync) to the fake listing — a spawned host pane
 *  appears in `listing.panes` (with its command), a closed one leaves it. */
export interface ZaxisWorldOpts { readonly hostTabs?: boolean }

export function createZaxisWorld(seed: number, vault: string, extraContext?: () => Omit<ElementContext, 'vault'>, opts: ZaxisWorldOpts = {}): ZaxisWorld {
  const root = mkdtempSync(join(tmpdir(), `els-zaxis-sim-${seed}-`));
  const timers = fakeTimers();
  let vaultPath = vault;
  const listing: { panes: (PaneRow & { command?: string[]; ptyId?: string })[] } = { panes: [paneRow('w1', 'p1', 'one'), paneRow('w1', 'p2', 'two')] };
  let hostSeq = 0;
  const tabHosts = opts.hostTabs ? createTabHostSync({ cwd: '/work',
    panes: () => listing.panes.map((row) => ({ id: row.pane, command: row.command, state: row.state, ptyId: row.ptyId ?? `h:${row.pane}` })),
    newPane: (input) => { const pane = `ph${++hostSeq}`; listing.panes.push({ ...paneRow('w1', pane, input.title), command: input.command }); return { exitCode: 0, message: JSON.stringify({ pane }) }; },
    close: (pane) => { listing.panes = listing.panes.filter((row) => row.pane !== pane); } }) : undefined;
  const registry = createOverlayRegistry({ dir: join(root, 'els'), now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, context: () => ({ ...(extraContext?.() ?? {}), vault: vaultPath }),
    ...(tabHosts ? { onTabHosts: tabHosts } : {}) });
  const renderers = elementRenderers();
  const keys = elementKeys();
  const viewers: Viewer[] = [];

  const registrySource: StackSource = {
    stack: () => registry.stack(),
    onChange: (listener) => registry.onChange(listener),
    act: (one) => { const { action, ...rest } = one; return registry.apply({ ...rest, action: action as 'close' }); },   // every act field (frame, move/resize deltas, view) as sent; the answer goes back
  };
  const viewer = async (opts: ViewerOpts = {}): Promise<Viewer> => {
    const size = { cols: opts.cols ?? 120, rows: opts.rows ?? 30 };
    const source = opts.source === 'none' ? undefined : opts.source ?? registrySource;
    const attachments: AttachmentLog[] = [];
    const writes: string[] = [];
    const wire: string[] = [];
    const toWire = createAppFrameWriter((text) => { wire.push(text); });
    let term: Terminal | undefined;
    let fed = 0;
    let paneSeq = 0;
    const acts: { action: string; id: string; props?: unknown }[] = [];
    const intervals: (() => void)[] = [];
    let open = false;
    const app = createAttachApp({
      request: async (request: ElsRequest): Promise<ElsResult> => request.op === 'ls'
        ? { exitCode: 0, message: JSON.stringify({ workspaces: [], tabs: [], panes: listing.panes }) } : opts.request?.(request) ?? { exitCode: 0, message: '' },
      attach: (pane: string, _size: unknown, handlers: AttachHandlers): Attached => {
        const entry: AttachmentLog = { pane, typed: [], handlers, size: { ..._size as { cols: number; rows: number } }, resizes: [], scrolls: [], detached: false };
        attachments.push(entry);
        return { input: (bytes) => { entry.typed.push(bytes); }, resize: (cols, rows) => { entry.resizes.push({ cols, rows }); },
          scroll: (lines) => { entry.scrolls.push(lines); }, detach: () => { entry.detached = true; } };
      },
      write: (text) => { writes.push(text); toWire(text); },
      size: () => size,
      cwd: '/work',
      env: { SHELL: '/bin/zsh' },
      setInterval: (callback) => { intervals.push(callback); return intervals.length; },
      clearInterval: () => {},
      pollMs: 1000,
      chatCommand: ['/opt/elanous/bin/elanous'],
      memory: { load: () => ({}), save: () => {} },
      ...(opts.tile ? { tile: opts.tile } : {}),
      ...(source ? { overlays: {
        // The server's overlay-watch: the stack at once, then every changed stack (registry.onChange).
        watch: (onStack: (stack: OverlayStack) => void) => {
          open = true;
          const sub = source.onChange(() => onStack(source.stack()));
          onStack(source.stack());
          return { close: () => { open = false; sub.dispose(); } };
        },
        act: (one: { action: string; id: string; props?: unknown; frame?: string; dx?: number; dy?: number; view?: { cols: number; rows: number } }) => { acts.push(one); return source.act(one); },
        renderers,
        keys,
      } } : {}),
    } as AttachAppDeps);
    await app.start(opts.pane ?? 'p1');
    await settle();
    const made: Viewer = {
      app, attachments, writes, acts, size, wire,
      paneFrame: (screen) => {
        // the pane's stream (not a popup terminal's: ELS-POPUP-TERM panes live in workspace els-popup)
        const live = [...attachments].reverse().find((one) => listing.panes.find((row) => row.pane === one.pane)?.workspace !== 'els-popup')!;
        live.handlers.onFrame({ pane: live.pane, seq: ++paneSeq, cols: size.cols, rows: size.rows, back: 0, screen });
      },
      emulated: async () => {
        if (!term || term.cols !== size.cols || term.rows !== size.rows) {
          if (term) term.resize(size.cols, size.rows); else term = emulatorTerminal(size.cols, size.rows);
        }
        const fresh = wire.slice(fed);
        fed = wire.length;
        return emulate(term, fresh);
      },
      last: () => rowsOf(writes.at(-1) ?? ''),
      press: (...seq) => { for (const one of seq) app.key(one); },
      clickAt: (x, y) => { app.key(click(x, y)); app.key(release(x, y)); },
      poll: async () => { intervals[0]?.(); await settle(); },
      watching: () => open,
      dispose: () => { term?.dispose(); term = undefined; },
    };
    viewers.push(made);
    return made;
  };

  return {
    root, registry, timers, rand: prng(seed), listing,
    setVault: (path) => { vaultPath = path; },
    viewer,
    openObsidian: (props = {}) => {
      const answer = registry.apply({ action: 'open', kind: 'obsidian', props: { dir: '', cursor: 0, scroll: 0, ...props } });
      if (answer.exitCode !== 0) throw new Error(answer.message);
      return (JSON.parse(answer.message) as { id: string }).id;
    },
    dispose: () => {
      for (const one of viewers) { one.app.key('\u0002q'); one.dispose(); }
      registry.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---- vault devices ----

// 출처: #40244 sim device — 30 notes is more than one popup page (21 body rows at 120x30), so j/space really scroll
export const NOTE_COUNT = 30;
// 출처: #40244 sim device — 60 lines is more than one popup page, so the note scrolls
export const NOTE_LINES = 60;
export const noteName = (at: number): string => `note-${String(at).padStart(2, '0')}`;
export const noteLine = (note: number, line: number): string => `Line ${String(line).padStart(2, '0')} of ${noteName(note)}`;

/** A vault of NOTE_COUNT notes, each a heading and NOTE_LINES plain lines (no blank lines: rendered row i = line i). */
export function writeNotesVault(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (let note = 0; note < NOTE_COUNT; note++) {
    const lines = [`# ${noteName(note)}`];
    for (let line = 1; line <= NOTE_LINES; line++) lines.push(noteLine(note, line));
    writeFileSync(join(dir, `${noteName(note)}.md`), `${lines.join('\n')}\n`);
  }
  return dir;
}

/** A vault of `count` empty notes (the large-vault device). */
export function writeLargeVault(dir: string, count: number): string {
  mkdirSync(dir, { recursive: true });
  for (let at = 0; at < count; at++) writeFileSync(join(dir, `n${String(at).padStart(5, '0')}.md`), '');
  return dir;
}

/** Korean names: a folder 프로젝트/ with one note, and 가나다.md at the root. */
export function writeKoreanVault(dir: string): string {
  mkdirSync(join(dir, '프로젝트'), { recursive: true });
  writeFileSync(join(dir, '가나다.md'), '# 가나다 노트\n\n첫째 줄 한글 본문\n');
  writeFileSync(join(dir, '프로젝트', '계획.md'), '# 계획\n\n- 하나\n- 둘\n');
  return dir;
}

// ---- frame readers ----

/** The rest of a frame line from cell column `x` (wide glyphs are 2 cells), '' when the line is shorter. */
export function fromCell(line: string, x: number): string {
  let used = 0;
  for (let at = 0; at < line.length;) {
    if (used >= x) return line.slice(at);
    const point = line.codePointAt(at)!;
    const char = String.fromCodePoint(point);
    used += Bun.stringWidth(char);
    at += char.length;
  }
  return '';
}

/** The popup box as drawn: top/bottom row index, the cell column of its left edge and its width in cells. */
export function popupBox(lines: readonly string[]): { top: number; bottom: number; x: number; w: number } | undefined {
  const top = lines.findIndex((line) => line.includes('┌ 📓'));
  if (top < 0) return undefined;
  const at = lines[top]!.indexOf('┌ 📓');
  const x = Bun.stringWidth(lines[top]!.slice(0, at));
  const end = lines[top]!.indexOf('┐', at);
  const w = Bun.stringWidth(lines[top]!.slice(at, end + 1));
  let bottom = top + 1;
  while (bottom < lines.length && !fromCell(lines[bottom]!, x).startsWith('└')) bottom++;
  return { top, bottom, x, w };
}

/** The popup body rows (between the frame edges), as drawn. */
export function popupBody(lines: readonly string[]): string[] {
  const box = popupBox(lines);
  if (!box) return [];
  return lines.slice(box.top + 1, box.bottom).map((line) => {
    const inner = fromCell(line, box.x + 1);
    const after = fromCell(inner, box.w - 2);
    return inner.slice(0, inner.length - after.length).trimEnd();
  });
}
