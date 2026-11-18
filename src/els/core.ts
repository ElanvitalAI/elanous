// els core — the single owner of the journal and of the pane PTYs (one server process; src/els/server.ts hosts it).
// The journal in memory is the truth; every change is saved by this module and nothing else writes the file.
// Rules that keep it correct without a lock:
//   - a pane is only added once its PTY exists AND the journal is saved; a failed save kills the PTY again,
//   - `exited` is recorded the moment the PTY ends and is final: a read or send that finishes later never overwrites
//     the exit state or the screen; the final screen is added afterwards only when it could be rendered,
//   - a failed screen render never replaces the last saved scrollback,
//   - for read, send and exit the change stays in memory when a save fails; the next successful save writes it,
//   - ids are random and checked against every id already in the journal.

import { randomBytes } from 'node:crypto';
import { addPane, addTab, findPane, findWorkspace, journalIds, patchPane, upsertWorkspace } from './journal.js';
import { emptyJournal, paneAddress, type Pane, type PaneState, type SpaceJournal, type Tab, type Workspace } from './space.js';

export interface ElsResult {
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
}

/** A pane PTY as the owner sees it (src/pty-shell/registry.ts PtyHandle in the server). */
export interface ElsPty {
  readonly id: string;
  isAlive(): boolean;
  write(text: string): void;
  /** The visible screen; `ansi: true` keeps colours/attributes as SGR sequences (the attach view paints them). */
  renderScreen(options?: { readonly ansi?: boolean }): Promise<string>;
  onExit(cb: () => void): void;
  kill(): void;
  /** Resize the terminal (SIGWINCH) — absent on a PTY that cannot be resized. */
  resize?(cols: number, rows: number): void;
}

export interface ElsCoreDeps {
  readonly load: () => SpaceJournal;
  readonly save: (journal: SpaceJournal) => void;
  /** `env` carries ELANOUS_ELS_WS (the server adds ELANOUS_ELS_SOCKET) so an eln started in the pane can report its children here. */
  readonly spawn: (command: readonly string[], cwd: string, title: string, env: Readonly<Record<string, string>>) => ElsPty;
  /** Random id candidate; the core retries on a collision. */
  readonly randomId?: (prefix: string) => string;
  /** Clock for the queue settle time (tests). */
  readonly now?: () => number;
}

export interface ElsNewInput {
  readonly ws: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly title?: string;
}

// 출처: ids carry 8 random hex digits (32 bits); retrying this many times on a collision is enough for any journal
// this owner can hold (the registry caps live PTYs per process).
const ID_ATTEMPTS = 16;

// 출처: eln's own working line shows «Turn running» (Korean UI: «응답 중») while a turn is in flight; typing into the
// prompt then would interleave with it, so `do` waits (queues) instead.
const BUSY_SCREEN = /Turn running|응답 중/;
// A queued line is delivered at most this often per pane: right after a write the screen may not show «Turn running» yet.
const QUEUE_SETTLE_MS = 2_000;
const MAX_QUEUE = 20;
export const MAX_DO_CHARS = 8_000;
/** Control characters (ESC, CR, NL, …) would let the sender drive the terminal instead of typing text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;   // C0 + DEL + C1 (0x9b is a one-byte CSI)
export const clean = (value: string): string => value.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();

// 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — a terminal grid outside these bounds is a client bug, not a size.
const MIN_COLS = 10;
const MAX_COLS = 500;
const MIN_ROWS = 3;
const MAX_ROWS = 200;
// 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — one `input` chunk is a paste, not a file (the socket line cap is 1 MB).
const MAX_INPUT_BYTES = 65_536;
export const DEFAULT_PANE_COLS = 80;
export const DEFAULT_PANE_ROWS = 24;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createElsCore(deps: ElsCoreDeps) {
  const randomId = deps.randomId ?? ((prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`);
  let journal: SpaceJournal = emptyJournal();
  const ptys = new Map<string, ElsPty>();
  const now = deps.now ?? Date.now;
  /** `do` lines waiting for a pane whose turn is running (memory only: a restart drops them). */
  const queues = new Map<string, { from: string; text: string }[]>();
  const lastDelivery = new Map<string, number>();
  /** The terminal size an attached client last asked for (default 80x24). */
  const sizes = new Map<string, { cols: number; rows: number }>();
  /** Panes whose drain step is in flight: one stuck render stops only that pane's queue, never the others'. */
  const draining = new Set<string>();
  /** One `do` at a time per pane: the busy check and the delivery (or enqueue) are one step, in arrival order. */
  const doLocks = new Map<string, Promise<unknown>>();
  const serialized = <T>(paneId: string, work: () => Promise<T>): Promise<T> => {
    const previous = doLocks.get(paneId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    doLocks.set(paneId, tail);
    void tail.then(() => { if (doLocks.get(paneId) === tail) doLocks.delete(paneId); });
    return run;
  };

  /** Save `next`, then make it the truth. A failed save leaves memory and the file as they were (used by `new`). */
  const commit = (next: SpaceJournal): void => {
    deps.save(next);
    journal = next;
  };
  /** Make `next` the truth, then save it. A failed save is reported; memory keeps the change for the next save. */
  const persist = (next: SpaceJournal): string | undefined => {
    journal = next;
    try { deps.save(next); return undefined; } catch (error) { return message(error); }
  };

  const freshId = (prefix: string, taken: Set<string>): string => {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const candidate = randomId(prefix);
      if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
    }
    throw new Error(`could not find a free ${prefix} id`);
  };

  /** Apply a patch only while the pane is still the live one it was for (same PTY, not exited). */
  const patchLive = (paneId: string, ptyId: string, patch: Partial<Pane>): string | undefined => {
    const pane = journal.panes.find((row) => row.id === paneId);
    if (!pane || pane.state === 'exited' || pane.ptyId !== ptyId) return undefined;
    return persist(patchPane(journal, paneId, patch));
  };

  /** The pane's PTY ended: record `exited` now (once). Returns false when this exit is not the pane's live PTY. */
  const recordExit = (paneId: string, ptyId: string): boolean => {
    ptys.delete(paneId);
    queues.delete(paneId);
    const pane = journal.panes.find((row) => row.id === paneId);
    if (!pane || pane.state === 'exited' || pane.ptyId !== ptyId) return false;
    const saveError = persist(patchPane(journal, paneId, { state: 'exited', ptyId: '' }));
    if (saveError) process.stderr.write(`els: exit of ${paneId} not saved yet: ${saveError}\n`);
    return true;
  };
  /** The final screen of an exited pane, once rendered. A failed render keeps the saved scrollback. */
  const recordFinalScreen = (paneId: string, screen: string): void => {
    const pane = journal.panes.find((row) => row.id === paneId);
    if (!pane || pane.state !== 'exited') return;
    const saveError = persist(patchPane(journal, paneId, { scrollback: screen }));
    if (saveError) process.stderr.write(`els: final screen of ${paneId} not saved yet: ${saveError}\n`);
  };

  const livePty = (pane: Pane): ElsPty | undefined => {
    const pty = ptys.get(pane.id);
    return pty && pane.state !== 'exited' && pane.ptyId === pty.id && pty.isAlive() ? pty : undefined;
  };

  const resolve = (ref: string): { pane: Pane; tab: Tab; ws: Workspace } | undefined => {
    const pane = findPane(journal, ref);
    const tab = pane ? journal.tabs.find((row) => row.id === pane.tabId) : undefined;
    const ws = tab ? journal.workspaces.find((row) => row.id === tab.workspaceId) : undefined;
    return pane && tab && ws ? { pane, tab, ws } : undefined;
  };

  const deliver = (pane: Pane, pty: ElsPty, from: string, text: string): ElsResult => {
    try { pty.write(`⇢ ${from} · ${text}\r`); }
    catch (error) { return { exitCode: 1, message: `els do: ${message(error)}` }; }
    lastDelivery.set(pane.id, now());
    const saveError = patchLive(pane.id, pty.id, { state: 'working' });
    return { exitCode: 0, message: `els do: ${pane.id} delivered ${text.length} chars from ${from}${saveError ? ` (state not saved: ${saveError})` : ''}` };
  };

  /** Deliver the next waiting line of one pane when its screen is idle. At most one step per pane in flight. */
  const drainPane = async (paneId: string): Promise<void> => {
    if (draining.has(paneId)) return;
    draining.add(paneId);
    try {
      const pane = journal.panes.find((row) => row.id === paneId);
      const pty = pane ? livePty(pane) : undefined;
      if (!pane || !pty) { queues.delete(paneId); return; }
      if (now() - (lastDelivery.get(paneId) ?? -Infinity) < QUEUE_SETTLE_MS) return;
      let busy: boolean;
      try { busy = BUSY_SCREEN.test(await pty.renderScreen()); } catch { return; }
      const queue = queues.get(paneId);
      if (busy || !queue || !livePty(pane)) return;
      const [next, ...rest] = queue;
      if (rest.length) queues.set(paneId, rest); else queues.delete(paneId);
      if (next) {
        const result = deliver(pane, pty, next.from, next.text);
        if (result.exitCode !== 0) process.stderr.write(`${result.message}\n`);
      }
    } finally { draining.delete(paneId); }
  };

  return {
    /**
     * Load the journal once. Panes whose PTY belonged to a previous server lose it: ptyId is cleared and a live
     * state becomes idle (exited stays exited); cwd, command and scrollback stay. Returns a refusal when the journal
     * cannot be read or the restart state cannot be saved — the file is never replaced by an empty one.
     */
    start(): ElsResult | undefined {
      let loaded: SpaceJournal;
      try { loaded = deps.load(); } catch (error) { return { exitCode: 1, message: `els serve: ${message(error)}` }; }
      const gone = new Set(loaded.panes.filter((pane) => pane.kind === 'harness-child').map((pane) => pane.tabId));
      const kept: SpaceJournal = gone.size === 0 ? loaded : { ...loaded, tabs: loaded.tabs.filter((tab) => !gone.has(tab.id)),
        panes: loaded.panes.filter((pane) => pane.kind !== 'harness-child') };
      const restarted: SpaceJournal = { ...kept, panes: kept.panes.map((pane) =>
        pane.ptyId === '' ? pane : { ...pane, ptyId: '', state: pane.state === 'exited' ? 'exited' : 'idle' }) };
      try {
        if (gone.size > 0 || restarted.panes.some((pane, index) => pane !== kept.panes[index])) commit(restarted);
        else journal = restarted;
      } catch (error) {
        return { exitCode: 1, message: `els serve: cannot save the journal: ${message(error)}` };
      }
      return undefined;
    },

    newPane(input: ElsNewInput): ElsResult {
      if (!input.ws.trim()) return { exitCode: 2, message: 'els new: --ws is required' };
      if (!input.cwd.trim()) return { exitCode: 2, message: 'els new: --cwd is required' };
      if (!input.command[0]) return { exitCode: 2, message: 'els new: command after -- is required' };
      const label = input.title?.trim() || input.command[0];
      // Decide the workspace and ids first: the PTY's env names its workspace, and the PTY must exist before the journal changes.
      let ws: Workspace; let existing: Workspace | undefined; let tabId: string; let paneId: string;
      try {
        const taken = journalIds(journal);
        existing = findWorkspace(journal, input.ws);
        ws = existing ?? { id: freshId('w', taken), name: input.ws, rootCwd: input.cwd, purpose: '', host: 'local' };
        tabId = freshId('t', taken);
        paneId = freshId('p', taken);
      } catch (error) { return { exitCode: 1, message: `els new: ${message(error)}` }; }
      let pty: ElsPty;
      try { pty = deps.spawn(input.command, input.cwd, label, { ELANOUS_ELS_WS: ws.name }); }
      catch (error) { return { exitCode: 1, message: `els new: failed to spawn: ${message(error)}` }; }
      let address = '';
      try {
        const tab: Tab = { id: tabId, workspaceId: ws.id, label, focusPaneId: paneId };
        const pane: Pane = { id: paneId, tabId, kind: 'pty', title: label, cwd: input.cwd, command: input.command,
          state: 'working', restore: 'cwd', ptyId: pty.id, scrollback: '' };
        address = paneAddress(ws, tab, pane);
        commit(addPane(addTab(existing ? journal : upsertWorkspace(journal, ws), tab), pane));
      } catch (error) {
        // Nothing records this PTY: stop it rather than leave an unlisted process.
        try { pty.kill(); } catch { /* already gone */ }
        return { exitCode: 1, message: `els new: ${message(error)}` };
      }
      ptys.set(paneId, pty);
      const ptyId = pty.id;
      pty.onExit(() => {
        if (!recordExit(paneId, ptyId)) return;
        void pty.renderScreen().then((screen) => recordFinalScreen(paneId, screen), () => { /* keep the saved scrollback */ });
      });
      return { exitCode: 0, message: JSON.stringify({ address, pane: paneId, ptyId, cwd: input.cwd }) };
    },

    list(): ElsResult {
      // Panes come out in the order a person set: workspaces in journal order, tabs in journal order inside each, panes by
      // journal order inside a tab — so every client (els, the eln side tab) draws the same list from the same answer.
      const wsAt = (id: string): number => journal.workspaces.findIndex((row) => row.id === id);
      const tabAt = (id: string): number => journal.tabs.findIndex((row) => row.id === id);
      const ordered = journal.panes.map((pane, index) => ({ pane, index, tab: journal.tabs.find((row) => row.id === pane.tabId) }))
        .filter((row): row is { pane: Pane; index: number; tab: Tab } => row.tab !== undefined)
        .sort((a, b) => wsAt(a.tab.workspaceId) - wsAt(b.tab.workspaceId) || tabAt(a.tab.id) - tabAt(b.tab.id) || a.index - b.index);
      const panes = ordered.flatMap(({ pane, tab }) => {
        const ws = journal.workspaces.find((row) => row.id === tab.workspaceId);
        if (!ws) return [];
        const live = livePty(pane);
        return [{ address: paneAddress(ws, tab, pane), workspace: ws.name, tab: tab.id, pane: pane.id, title: pane.title, kind: pane.kind,
          cwd: pane.cwd, command: pane.command, state: pane.state === 'exited' ? 'exited' : live ? pane.state : 'idle',
          ptyId: live ? pane.ptyId : '', restore: pane.restore }];
      });
      return { exitCode: 0, message: JSON.stringify({ workspaces: journal.workspaces, tabs: journal.tabs, panes }, null, 2) };
    },

    /**
     * Move a workspace (before another workspace, or to the end) or a tab (before another tab of the SAME workspace, or to
     * the end of its workspace). The order is the journal's own array order, saved with the journal: it survives a restart
     * and every client reads the same one. A failed save leaves the order as it was.
     */
    reorder(input: { kind: string; id: string; before?: string }): ElsResult {
      if (input.kind !== 'workspace' && input.kind !== 'tab') return { exitCode: 2, message: 'els reorder: kind must be workspace or tab' };
      if (typeof input.id !== 'string' || (input.before !== undefined && typeof input.before !== 'string')) return { exitCode: 2, message: 'els reorder: id and before must be strings' };
      // The end is spelled three ways — omitted, "" or "end" — and means the same (a caller with an empty --before must not
      // be refused or, worse, move something else). Any other text must name an existing workspace/tab.
      const before = input.before === undefined || input.before === '' || input.before === 'end' ? undefined : input.before;
      if (input.kind === 'workspace') {
        const moving = findWorkspace(journal, input.id);
        if (!moving) return { exitCode: 1, message: `els reorder: unknown workspace ${input.id}` };
        const target = before === undefined ? undefined : findWorkspace(journal, before);
        if (before !== undefined && !target) return { exitCode: 1, message: `els reorder: unknown workspace ${before}` };
        if (target?.id === moving.id) return { exitCode: 0, message: `els reorder: ${moving.id} stays` };
        const rest = journal.workspaces.filter((row) => row.id !== moving.id);
        const at = target ? rest.findIndex((row) => row.id === target.id) : rest.length;
        const workspaces = [...rest.slice(0, at), moving, ...rest.slice(at)];
        try { commit({ ...journal, workspaces }); } catch (error) { return { exitCode: 1, message: `els reorder: not saved: ${message(error)}` }; }
        return { exitCode: 0, message: `els reorder: workspace ${moving.id} moved` };
      }
      const moving = journal.tabs.find((row) => row.id === input.id);
      if (!moving) return { exitCode: 1, message: `els reorder: unknown tab ${input.id}` };
      const target = before === undefined ? undefined : journal.tabs.find((row) => row.id === before);
      if (before !== undefined && !target) return { exitCode: 1, message: `els reorder: unknown tab ${before}` };
      if (target && target.workspaceId !== moving.workspaceId) return { exitCode: 2, message: 'els reorder: a tab moves inside its own workspace' };
      if (target?.id === moving.id) return { exitCode: 0, message: `els reorder: ${moving.id} stays` };
      const rest = journal.tabs.filter((row) => row.id !== moving.id);
      const at = target
        ? rest.findIndex((row) => row.id === target.id)
        : rest.reduce((last, row, index) => row.workspaceId === moving.workspaceId ? index + 1 : last, rest.length);
      const tabs = [...rest.slice(0, at), moving, ...rest.slice(at)];
      try { commit({ ...journal, tabs }); } catch (error) { return { exitCode: 1, message: `els reorder: not saved: ${message(error)}` }; }
      return { exitCode: 0, message: `els reorder: tab ${moving.id} moved` };
    },

    /** A person typing in an attached view: raw bytes to the pane's PTY, no queue and no «⇢» line. The settle clock starts,
     *  so a queued `do` waits for the person to stop typing instead of landing in the middle of a word. */
    input(ref: string, bytes: string): ElsResult {
      if (typeof bytes !== 'string') return { exitCode: 2, message: 'els input: bytes must be a string' };
      if (Buffer.byteLength(bytes, 'utf8') > MAX_INPUT_BYTES) return { exitCode: 2, message: `els input: more than ${MAX_INPUT_BYTES} bytes at once` };
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els input: unknown pane ${ref}` };
      const pty = livePty(hit.pane);
      if (!pty) return { exitCode: 1, message: `els input: ${hit.pane.id} is not running` };
      try { pty.write(bytes); } catch (error) { return { exitCode: 1, message: `els input: ${message(error)}` }; }
      lastDelivery.set(hit.pane.id, now());
      return { exitCode: 0, message: '' };
    },

    /** The attached client's terminal size → the pane's PTY (the last client to ask wins; stage 2 has one view). */
    resize(ref: string, cols: number, rows: number): ElsResult {
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < MIN_COLS || cols > MAX_COLS || rows < MIN_ROWS || rows > MAX_ROWS) {
        return { exitCode: 2, message: `els resize: cols ${MIN_COLS}-${MAX_COLS} and rows ${MIN_ROWS}-${MAX_ROWS} (got ${String(cols)}x${String(rows)})` };
      }
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els resize: unknown pane ${ref}` };
      const pty = livePty(hit.pane);
      if (pty?.resize) {
        try { pty.resize(cols, rows); } catch (error) { return { exitCode: 1, message: `els resize: ${message(error)}` }; }
      }
      sizes.set(hit.pane.id, { cols, rows });
      return { exitCode: 0, message: `${cols}x${rows}` };
    },

    /** The pane's screen for an attached view: ANSI-coloured while the PTY runs, the saved text otherwise. Unlike `read` it
     *  never writes the journal — an attach asks ten times a second. */
    async frame(ref: string): Promise<ElsResult> {
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els attach: unknown pane ${ref}` };
      const pty = livePty(hit.pane);
      if (!pty) return { exitCode: 0, message: hit.pane.scrollback };
      try { return { exitCode: 0, message: await pty.renderScreen({ ansi: true }) }; }
      catch (error) { return { exitCode: 1, message: `els attach: cannot render ${hit.pane.id}: ${message(error)}` }; }
    },

    /** True while the pane's PTY runs (a virtual or exited pane is shown but not live). */
    paneIsLive(paneId: string): boolean {
      const hit = resolve(paneId);
      return hit ? livePty(hit.pane) !== undefined || hit.pane.kind !== 'pty' && hit.pane.state !== 'exited' : false;
    },

    paneSize(paneId: string): { cols: number; rows: number } {
      return sizes.get(paneId) ?? { cols: DEFAULT_PANE_COLS, rows: DEFAULT_PANE_ROWS };
    },

    /** The pane's id when `ref` names one (attach checks this before it opens a stream). */
    paneExists(ref: string): string | undefined {
      return resolve(ref)?.pane.id;
    },

    async read(ref: string): Promise<ElsResult> {
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els read: unknown pane ${ref}` };
      const pty = livePty(hit.pane);
      if (!pty) return { exitCode: 0, message: hit.pane.scrollback };
      let screen: string;
      try { screen = await pty.renderScreen(); }
      catch (error) { return { exitCode: 1, message: `els read: cannot render ${hit.pane.id}: ${message(error)}` }; }
      const saveError = patchLive(hit.pane.id, pty.id, { scrollback: screen, state: 'idle' });
      if (saveError) process.stderr.write(`els read: screen not saved: ${saveError}\n`);
      return { exitCode: 0, message: screen };
    },

    async send(ref: string, text: string): Promise<ElsResult> {
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els send: unknown pane ${ref}` };
      const pty = livePty(hit.pane);
      if (!pty) return { exitCode: 1, message: `els send: pane ${hit.pane.id} has no live pty (restart restores cwd only)` };
      try { pty.write(text); }
      catch (error) { return { exitCode: 1, message: `els send: ${message(error)}` }; }
      const saveError = patchLive(hit.pane.id, pty.id, { state: 'working' });
      return { exitCode: 0, message: `els send: ${hit.pane.id} ${text.length} chars${saveError ? ` (state not saved: ${saveError})` : ''}` };
    },

    /**
     * `do`: type a line into a live pane on behalf of `from`, marked «⇢ from · text» and submitted with Enter.
     * Control characters are dropped. If the pane's turn is running (or lines are already waiting) the line is queued
     * in order — it never overwrites a running turn — and `drain` delivers it when the screen is idle.
     * If the busy check itself fails the line is NOT sent (fail closed).
     */
    async do(ref: string, rawText: string, rawFrom: string): Promise<ElsResult> {
      const text = clean(rawText);
      const from = clean(rawFrom).slice(0, 64) || 'unknown';
      if (!text) return { exitCode: 2, message: 'els do: text is empty' };
      if (text.length > MAX_DO_CHARS) return { exitCode: 2, message: `els do: text is longer than ${MAX_DO_CHARS} chars` };
      const first = resolve(ref);
      if (!first) return { exitCode: 1, message: `els do: unknown pane ${ref}` };
      // Concurrent `do` to one pane run one after another: the first may deliver, the next sees it and queues behind it.
      return serialized(first.pane.id, async () => {
        const hit = resolve(first.pane.id);
        if (!hit) return { exitCode: 1, message: `els do: unknown pane ${ref}` };
        const pty = livePty(hit.pane);
        if (!pty) return { exitCode: 1, message: `els do: pane ${hit.pane.id} has no live pty (restart restores cwd only)` };
        // Waiting lines, or a line delivered a moment ago (the screen may not show «Turn running» yet), mean busy.
        let busy = queues.has(hit.pane.id) || now() - (lastDelivery.get(hit.pane.id) ?? -Infinity) < QUEUE_SETTLE_MS;
        if (!busy) {
          try { busy = BUSY_SCREEN.test(await pty.renderScreen()); }
          catch (error) { return { exitCode: 1, message: `els do: cannot check whether ${hit.pane.id} is busy, not sent: ${message(error)}` }; }
        }
        if (busy) {
          // The pane may have exited while its screen was being rendered.
          const queue = queues.get(hit.pane.id) ?? [];
          if (!livePty(hit.pane)) return { exitCode: 1, message: `els do: pane ${hit.pane.id} ended before the line was queued` };
          if (queue.length >= MAX_QUEUE) return { exitCode: 1, message: `els do: ${hit.pane.id} already has ${MAX_QUEUE} lines waiting, not queued` };
          queues.set(hit.pane.id, [...queue, { from, text }]);
          return { exitCode: 0, message: `els do: queued ${queue.length + 1} for ${hit.pane.id} (turn running)` };
        }
        // Idle: a queue may have appeared while the screen was rendering (a drain cannot, but stay safe) — then go behind it.
        if (queues.has(hit.pane.id)) {
          queues.set(hit.pane.id, [...queues.get(hit.pane.id)!, { from, text }]);
          return { exitCode: 0, message: `els do: queued ${queues.get(hit.pane.id)!.length} for ${hit.pane.id}` };
        }
        if (!livePty(hit.pane)) return { exitCode: 1, message: `els do: pane ${hit.pane.id} ended before the line was sent` };
        return deliver(hit.pane, pty, from, text);
      });
    },

    /** Deliver the next waiting `do` line to every pane that is idle again. Called on a timer by the server. */
    async drain(): Promise<void> {
      await Promise.all([...queues.keys()].map((paneId) => drainPane(paneId)));
    },

    /** Lines waiting per pane (tests and status). */
    queued(ref: string): number {
      const hit = resolve(ref);
      return hit ? queues.get(hit.pane.id)?.length ?? 0 : 0;
    },

    /**
     * `close`: stop the pane's PTY (if live) and remove the pane — and its tab when it was the tab's last pane — from
     * the journal. The workspace stays (close it with `closeWorkspace`). A failed save is reported; memory keeps the change.
     */
    close(ref: string): ElsResult {
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els close: unknown pane ${ref}` };
      const paneId = hit.pane.id;
      const pty = ptys.get(paneId);
      ptys.delete(paneId);
      queues.delete(paneId);
      if (pty) { try { pty.kill(); } catch { /* already gone */ } }
      const panes = journal.panes.filter((row) => row.id !== paneId);
      const tabs = panes.some((row) => row.tabId === hit.tab.id) ? journal.tabs : journal.tabs.filter((row) => row.id !== hit.tab.id);
      const saveError = persist({ ...journal, panes, tabs });
      return { exitCode: 0, message: `els close: ${paneId}${saveError ? ` (not saved yet: ${saveError})` : ''}` };
    },

    /** `close` for every pane of a workspace, then the workspace itself. */
    closeWorkspace(ref: string): ElsResult {
      const ws = findWorkspace(journal, ref);
      if (!ws) return { exitCode: 1, message: `els workspace close: unknown workspace ${ref}` };
      const tabIds = new Set(journal.tabs.filter((tab) => tab.workspaceId === ws.id).map((tab) => tab.id));
      const doomed = journal.panes.filter((pane) => tabIds.has(pane.tabId));
      for (const pane of doomed) {
        const pty = ptys.get(pane.id);
        ptys.delete(pane.id);
        queues.delete(pane.id);
        if (pty) { try { pty.kill(); } catch { /* already gone */ } }
      }
      const saveError = persist({ ...journal, workspaces: journal.workspaces.filter((row) => row.id !== ws.id),
        tabs: journal.tabs.filter((tab) => tab.workspaceId !== ws.id), panes: journal.panes.filter((pane) => !tabIds.has(pane.tabId)) });
      return { exitCode: 0, message: `els workspace close: ${ws.id} (${doomed.length} panes)${saveError ? ` (not saved yet: ${saveError})` : ''}` };
    },

    /**
     * A tab that has no PTY: a child component (sub-agent, harness child, graph node, mission, background shell) shown
     * live. Output is appended with `appendVirtual`; the tab goes away with `closeVirtual`. `start()` drops these (a
     * child does not outlive the server that watched it).
     */
    openVirtual(input: { readonly ws: string; readonly cwd: string; readonly title: string; readonly text: string }): ElsResult {
      try {
        const taken = journalIds(journal);
        const existing = findWorkspace(journal, input.ws);
        const ws: Workspace = existing ?? { id: freshId('w', taken), name: input.ws, rootCwd: input.cwd, purpose: '', host: 'local' };
        const tabId = freshId('t', taken);
        const paneId = freshId('p', taken);
        const tab: Tab = { id: tabId, workspaceId: ws.id, label: input.title, focusPaneId: paneId };
        const pane: Pane = { id: paneId, tabId, kind: 'harness-child', title: input.title, cwd: input.cwd, command: [],
          state: 'working', restore: 'none', ptyId: '', scrollback: input.text };
        // A child tab has no PTY to lose, so a failed save keeps the tab in memory (the next save writes it) and says so.
        const saveError = persist(addPane(addTab(existing ? journal : upsertWorkspace(journal, ws), tab), pane));
        if (saveError) process.stderr.write(`els child: tab ${paneId} not saved yet: ${saveError}\n`);
        return { exitCode: 0, message: JSON.stringify({ address: paneAddress(ws, tab, pane), pane: paneId }) };
      } catch (error) { return { exitCode: 1, message: `els child: ${message(error)}` }; }
    },

    /** Change a virtual tab's text, title or state. Unknown or PTY-backed panes are refused. */
    patchVirtual(paneId: string, patch: { readonly text?: string; readonly title?: string; readonly state?: PaneState }): ElsResult {
      const pane = journal.panes.find((row) => row.id === paneId);
      if (!pane || pane.kind !== 'harness-child') return { exitCode: 1, message: `els child: unknown child tab ${paneId}` };
      const next = patchPane(journal, paneId, {
        ...(patch.text !== undefined ? { scrollback: patch.text } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}) });
      const tabPatch = patch.title !== undefined
        ? { ...next, tabs: next.tabs.map((tab) => tab.id === pane.tabId ? { ...tab, label: patch.title! } : tab) } : next;
      const saveError = persist(tabPatch);
      return { exitCode: 0, message: saveError ? `not saved yet: ${saveError}` : 'ok' };
    },

    /** Remove a virtual tab (its tab too). A PTY-backed pane is never closed here. */
    closeVirtual(paneId: string): ElsResult {
      const pane = journal.panes.find((row) => row.id === paneId);
      if (!pane || pane.kind !== 'harness-child') return { exitCode: 1, message: `els child: unknown child tab ${paneId}` };
      const saveError = persist({ ...journal, panes: journal.panes.filter((row) => row.id !== paneId),
        tabs: journal.tabs.filter((tab) => tab.id !== pane.tabId) });
      return { exitCode: 0, message: saveError ? `not saved yet: ${saveError}` : 'ok' };
    },

    /** The pane id at `ws/tab/pane` (ids, as in an address), or undefined when no pane has that address. */
    locate(ws: string, tab: string, pane: string): string | undefined {
      const hit = journal.panes.find((row) => row.id === pane && row.tabId === tab);
      const owner = hit ? journal.tabs.find((row) => row.id === tab && row.workspaceId === ws) : undefined;
      return hit && owner ? hit.id : undefined;
    },

    /** Stop every pane PTY (server shutdown). The journal keeps the panes; the next start clears their pty ids. */
    stopAll(): void {
      for (const pty of ptys.values()) { try { pty.kill(); } catch { /* already gone */ } }
    },
  };
}

export type ElsCore = ReturnType<typeof createElsCore>;
