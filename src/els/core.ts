import { buildAge, desiredSha, gitAncestor } from './build-badge.js';
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
import { paneStatus } from './pane-status.js';
import { tabBadge } from './tab-badge.js';
import type { Foreground } from './foreground.js';
import type { SpawnParent } from './server-auth.js';
import { grepScreens, type GrepHit } from './pane-grep.js';
import { readUnreadMailBadges } from '../msg/msg-store.js';

export type QueueAudit = (result: 'queued' | 'delivering' | 'delivered' | 'delivery-failed' | 'discarded', reason?: string) => boolean;

export interface ElsResult {
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
  /** Client-observed transport status; answered does not imply the operation succeeded or was side-effect free. */
  readonly transport?:
    | { readonly outcome: 'answered' }
    | { readonly outcome: 'not-sent'; readonly reason: 'path' | 'connect' | 'timeout' | 'disconnect' }
    | { readonly outcome: 'unknown'; readonly reason: 'timeout' | 'disconnect' | 'malformed' };
  /** Accepted into an in-memory queue, not delivered; lost if the owner or pane exits. */
  readonly queued?: number;
}

/** A pane PTY as the owner sees it (src/pty-shell/registry.ts PtyHandle in the server). */
export interface ElsPty {
  readonly id: string;
  isAlive(): boolean;
  write(text: string): void;
  writeAll?(text: string): Promise<void>;
  bracketedPasteEnabled?(): boolean;
  /** The visible screen; `ansi: true` keeps colours/attributes as SGR sequences (the attach view paints them). */
  renderScreen(options?: { readonly ansi?: boolean; readonly scrollBack?: number }): Promise<string>;
  onExit(cb: () => void): void;
  /** PTY 출력 구독 — 등록부 어댑터 경유 (src/els/server.ts registryPty). */
  onOutput?(cb: (data: string) => void): { dispose(): void };
  kill(): void;
  /** D1a: the PTY lives in an outside holder — release the connection without killing the child (a server stop keeps panes alive). */
  detach?(): void;
  /** Resize the terminal (SIGWINCH) — absent on a PTY that cannot be resized. */
  resize?(cols: number, rows: number): void;
  /** When the PTY last produced output (ms) — absent = not known (ELS-PANE-STATUS says unknown). */
  lastOutputAt?(): number | undefined;
  /** The shell's process id (ELS-PANE-AGENT-DETECT reads its terminal's foreground group); absent = not known. */
  readonly pid?: number;
  /** OS identity captured when the holder's PTY generation was bound. */
  readonly processBinding?: { readonly pid: number; readonly generation: string; readonly start: string };
}

export interface ElsCoreDeps {
  readonly load: () => SpaceJournal;
  readonly save: (journal: SpaceJournal) => void;
  /** `env` carries ELANOUS_ELS_WS (the server adds ELANOUS_ELS_SOCKET) so an eln started in the pane can report its children here. */
  readonly spawn: (command: readonly string[], cwd: string, title: string, env: Readonly<Record<string, string>>, parent?: SpawnParent) => ElsPty;
  /** D1a: adopt a pane whose PTY an outside holder still owns after a restart; undefined = it is gone. */
  readonly reattach?: (pane: Pane) => ElsPty | undefined;
  /** D1b: read (non-destructively) a reboot-orphaned pane's saved screen snapshot (holder's <paneId>.snap.json);
   *  returns the restored screen, or undefined when none remains. */
  readonly restoreScreen?: (paneId: string) => string | undefined;
  /** D1b: delete that snapshot — called only after the journal commit that records its screen succeeded. */
  readonly consumeScreenSnapshot?: (paneId: string) => void;
  /** Random id candidate; the core retries on a collision. */
  readonly randomId?: (prefix: string) => string;
  /** Clock for the queue settle time (tests). */
  readonly now?: () => number;
  /** Durable screen and identity archive; throws to leave the exited pane in the journal. */
  readonly archiveExited?: (pane: Pane) => void;
}

export interface ElsNewInput {
  readonly ws: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly title?: string;
  /** Requester's role threaded straight from the server (JUD #39071: direct argument — no queue). */
  readonly parent?: SpawnParent;
  /** Server-verified creator, never sourced from request data. */
  readonly ownerSeat?: string;
}

// 출처: ids carry 8 random hex digits (32 bits); retrying this many times on a collision is enough for any journal
// this owner can hold (the registry caps live PTYs per process).
const ID_ATTEMPTS = 16;

// 출처: eln's own working line shows «Turn running» (Korean UI: «응답 중») while a turn is in flight; typing into the
// prompt then would interleave with it, so `do` waits (queues) instead.
export const BUSY_SCREEN = /Turn running|응답 중/;
// Observed Claude/Codex working hint; limit to the status area, not scrollback.
const turnStarted = (screen: string): boolean => BUSY_SCREEN.test(screen) || /(?:esc|ctrl\+c) to interrupt/i.test(screen.split('\n').slice(-6).join('\n'));
// D10 (els-round1b-a110): a fast turn (mock provider, 0s) finishes before the first 100ms poll renders
// «Turn running», so the busy markers never appear — the fresh completion hint («✻ Worked for … · done …»)
// is then the only on-screen evidence the turn started. Absent before the submit, present after: started.
const TURN_DONE_HINT = /✻ Worked for/;
// A queued line is delivered at most this often per pane: right after a write the screen may not show «Turn running» yet.
const QUEUE_SETTLE_MS = 2_000;
const MAX_QUEUE = 20;
export const MAX_DO_CHARS = 8_000;
/** Plain (unbracketed) sends: CR, LF and every C0 control except TAB, and DEL, are not text (JUD-B #103319). */
const PLAIN_UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f]/;
/** Control characters (ESC, CR, NL, …) would let the sender drive the terminal instead of typing text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;   // C0 + DEL + C1 (0x9b is a one-byte CSI)
export const clean = (value: string): string => value.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
/** Any control in a send-text payload can leave an approval key behind after cleaning. */
const SEND_TEXT_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The choice row is pinned to the visible bottom; a long command may scroll its title out of view. */
export const hitlApprovalPending = (screen: string): boolean => {
  const bottom = screen.split('\n').slice(-8).join('').replace(/\s/g, '');
  return /(?:EnterdefaultN|Enter기본N)/.test(bottom)
    && /(?:yrun|yapprove|y실행|y승인)/.test(bottom)
    && /(?:Escdeny|Esc거부)/.test(bottom);
};

// 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — a terminal grid outside these bounds is a client bug, not a size.
const MIN_COLS = 10;
const MAX_COLS = 500;
const MIN_ROWS = 3;
const MAX_ROWS = 200;
// 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — one `input` chunk is a paste, not a file (the socket line cap is 1 MB).
const MAX_INPUT_BYTES = 65_536;
export const EXITED_PANE_RETENTION_MS = 30 * 60_000;
export const DEFAULT_PANE_COLS = 80;
export const DEFAULT_PANE_ROWS = 24;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createElsCore(deps: ElsCoreDeps) {
  const randomId = deps.randomId ?? ((prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`);
  let journal: SpaceJournal = emptyJournal();
  const ptys = new Map<string, ElsPty>();
  const builds = new Map<string, { sha: string; seen: number; version?: string; stamp?: string }>();
  const now = deps.now ?? Date.now;
  /** ELS-PANE-AGENT-DETECT: what each live pane runs in its foreground now (refreshed by the server). */
  const foregrounds = new Map<string, Foreground>();
  /** `do` lines waiting for a pane whose turn is running (memory only: a restart drops them). */
  const queues = new Map<string, { from: string; text: string; typed?: boolean; audit?: QueueAudit; validate?: () => Promise<boolean> }[]>();
  const lastDelivery = new Map<string, number>();
  const rawInputVersion = new Map<string, number>();
  // A screen can change while the final authorization performs asynchronous OS checks.
  const finalAuthorization = async (pty: ElsPty, validate?: () => Promise<boolean>) => {
    let changed = false;
    let subscription: { dispose(): void } | undefined;
    try {
      subscription = pty.onOutput?.(() => { changed = true; });
      const allowed = !validate || await validate().catch(() => false);
      return { allowed, changed };
    } catch { return { allowed: false, changed: true }; }
    finally { subscription?.dispose(); }
  };

  const tuiNeedsPaste = (pane: Pane, pty: ElsPty, screen?: string): boolean =>
    pty.bracketedPasteEnabled?.() !== true && (
      foregrounds.get(pane.id)?.kind === 'eln'
      || pane.command.some((part, at) => part === '--tui' && pane.command[at + 1] === 'next')
      || screen?.split('\n').slice(0, 4).some(line => line.trim() === 'elanous') === true
    );
  const machineInputRefusal = async (pane: Pane, pty: ElsPty, refuseBusy = false): Promise<string | undefined> => {
    try {
      const screen = await pty.renderScreen();
      if (hitlApprovalPending(screen)) return 'HITL approval pending; use an authenticated human attach key';
      if (tuiNeedsPaste(pane, pty, screen)) return 'TUI paste mode not confirmed; machine input denied';
      if (refuseBusy && turnStarted(screen)) return 'turn running; use the queued seat input path';
      return undefined;
    }
    catch { return 'cannot inspect the pane before machine input'; }
  };
  // A paste is one semantic key in Next TUI. The approval handler ignores paste keys, even if
  // the panel opens between our screen inspection and the PTY write. A following Enter is safe:
  // on an approval panel it chooses the default N, while at the composer it submits the text.
  const machinePaste = (pane: Pane, pty: ElsPty, text: string, enter: boolean): string => {
    const pasteMode = pty.bracketedPasteEnabled?.() === true;
    // A shell can turn into Next TUI after the last screen inspection. Without a paste
    // envelope, an approval letter would become a raw key at the new panel.
    if (!pasteMode && (tuiNeedsPaste(pane, pty) || /[yY]/.test(text))) throw new Error('safe paste mode not confirmed for approval letter; machine input denied');
    return pasteMode && text
      ? `\x1b[200~${text}\x1b[201~${enter ? '\r' : ''}`
      : `${text}${enter ? '\r' : ''}`;
  };

  /** ELS-TAB-STATE-BADGE: when this server first knew each pane — the «last event» of a pane that never printed or got a `do`. */
  const firstSeen = new Map<string, number>();
  /** The terminal size an attached client last asked for (default 80x24). */
  const sizes = new Map<string, { cols: number; rows: number }>();
  /** Panes whose drain step is in flight: one stuck render stops only that pane's queue, never the others'. */
  const draining = new Set<string>();
  /** One `do` at a time per pane: the busy check and the delivery (or enqueue) are one step, in arrival order. */
  const doLocks = new Map<string, Promise<unknown>>();
  const serialized = <T>(paneId: string, work: () => Promise<T>): Promise<T> => {
    const previous = doLocks.get(paneId);
    const run = previous ? previous.then(work, work) : work();
    const tail = run.catch(() => undefined);
    doLocks.set(paneId, tail);
    void tail.then(() => { if (doLocks.get(paneId) === tail) doLocks.delete(paneId); });
    return run;
  };

  // ELS-DESKTOP-SIDETAB-SUBSCRIBE: a subscriber (the `subscribe` op) is told that the list may have changed; it re-reads `list()`.
  const changeListeners = new Set<() => void>();
  const notifyChange = (): void => { for (const listener of [...changeListeners]) { try { listener(); } catch { /* a listener never breaks a mutation */ } } };

  /** Save `next`, then make it the truth. A failed save leaves memory and the file as they were (used by `new`). */
  const commit = (next: SpaceJournal): void => {
    deps.save(next);
    journal = next;
    notifyChange();
  };
  /** Make `next` the truth, then save it. A failed save is reported; memory keeps the change for the next save. */
  const persist = (next: SpaceJournal): string | undefined => {
    journal = next;
    notifyChange();
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

  const discardQueue = (paneId: string, reason: string): void => {
    const queue = queues.get(paneId);
    queues.delete(paneId);
    for (const item of queue ?? []) item.audit?.('discarded', reason);
  };

  /** The pane's PTY ended: record `exited` now (once). Returns false when this exit is not the pane's live PTY. */
  const recordExit = (paneId: string, ptyId: string): boolean => {
    ptys.delete(paneId);
    builds.delete(paneId);
    discardQueue(paneId, 'pane exited');
    const pane = journal.panes.find((row) => row.id === paneId);
    if (!pane || pane.state === 'exited' || pane.ptyId !== ptyId) return false;
    const saveError = persist(patchPane(journal, paneId, { state: 'exited', ptyId: '', exitedAt: now() }));
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
    try { pty.write(machinePaste(pane, pty, `⇢ ${from} · ${text}`, true)); }
    catch (error) { return { exitCode: 1, message: `els do: ${message(error)}` }; }
    lastDelivery.set(pane.id, now());
    const saveError = patchLive(pane.id, pty.id, { state: 'working' });
    return { exitCode: 0, message: `els do: ${pane.id} delivered ${text.length} chars from ${from}${saveError ? ` (state not saved: ${saveError})` : ''}` };
  };
  /** OP #17 OP-DIRECT-SEAT-INPUT: a typed line without the «⇢» marker — the pane sees it as if the person at
   *  the keyboard typed it and pressed Enter. Same one-line, no-control-characters rules as `do`. */
  const deliverTyped = (pane: Pane, pty: ElsPty, text: string): ElsResult => {
    try { pty.write(machinePaste(pane, pty, text, true)); }
    catch (error) { return { exitCode: 1, message: `els input: ${message(error)}` }; }
    lastDelivery.set(pane.id, now());
    const saveError = patchLive(pane.id, pty.id, { state: 'working' });
    return { exitCode: 0, message: `els input: ${pane.id} typed ${text.length} chars${saveError ? ` (state not saved: ${saveError})` : ''}` };
  };

  /** Deliver the next waiting line of one pane when its screen is idle. At most one step per pane in flight. */
  const drainPane = async (paneId: string): Promise<void> => {
    if (draining.has(paneId)) return;
    draining.add(paneId);
    try {
      await serialized(paneId, async () => {
      const pane = journal.panes.find((row) => row.id === paneId);
      const pty = pane ? livePty(pane) : undefined;
      if (!pane || !pty) { discardQueue(paneId, 'pane unavailable'); return; }
      if (now() - (lastDelivery.get(paneId) ?? -Infinity) < QUEUE_SETTLE_MS) return;
      const inputVersion = rawInputVersion.get(paneId) ?? 0;
      let busy: boolean;
      try { const screen = await pty.renderScreen(); busy = BUSY_SCREEN.test(screen) || hitlApprovalPending(screen); } catch { return; }
      if ((rawInputVersion.get(paneId) ?? 0) !== inputVersion) return;
      const queue = queues.get(paneId);
      if (busy || !queue || !livePty(pane)) return;
      const [next, ...rest] = queue;
      if (rest.length) queues.set(paneId, rest); else queues.delete(paneId);
      if (next) {
        if (next.validate && !(await next.validate().catch(() => false))) {
          next.audit?.('discarded', 'authorization changed');
          return;
        }
        // Authorization can await OS lookups while the target starts a turn on its own.
        // A stale idle snapshot must never authorize delivery; failed rendering defers too.
        let stillIdle = false;
        try { const screen = await pty.renderScreen(); stillIdle = !BUSY_SCREEN.test(screen) && !hitlApprovalPending(screen); } catch { /* defer */ }
        const current = journal.panes.find((row) => row.id === paneId);
        if (!current || livePty(current) !== pty) {
          next.audit?.('discarded', 'pane ended before delivery');
          return;
        }
        if (!stillIdle || (rawInputVersion.get(paneId) ?? 0) !== inputVersion) {
          queues.set(paneId, [next, ...(queues.get(paneId) ?? [])]);
          return;
        }
        const final = await finalAuthorization(pty, next.validate);
        if (!final.allowed) {
          next.audit?.('discarded', 'authorization changed');
          return;
        }
        if (final.changed || livePty(current) !== pty || (rawInputVersion.get(paneId) ?? 0) !== inputVersion) {
          queues.set(paneId, [next, ...(queues.get(paneId) ?? [])]);
          return;
        }
        if (next.audit && !next.audit('delivering')) {
          next.audit('discarded', 'delivery intent audit failed');
          return;
        }
        const result = next.typed ? deliverTyped(pane, pty, next.text) : deliver(pane, pty, next.from, next.text);
        next.audit?.(result.exitCode === 0 ? 'delivered' : 'delivery-failed', result.exitCode === 0 ? undefined : 'pty write failed');
        if (result.exitCode !== 0) process.stderr.write(`${result.message}\n`);
      }
      });
    } finally { draining.delete(paneId); }
  };

  return {
    /**
     * Load the journal once. A pane whose PTY an outside holder still owns is adopted as it is (D1a); the panes
     * without one lose their PTY: ptyId is cleared and a live state becomes idle (exited stays exited); cwd,
     * command and scrollback stay. Returns a refusal when the journal cannot be read or the restart state cannot
     * be saved — the file is never replaced by an empty one.
     */
    start(): ElsResult | undefined {
      let loaded: SpaceJournal;
      try { loaded = deps.load(); } catch (error) { return { exitCode: 1, message: `els serve: ${message(error)}` }; }
      const gone = new Set(loaded.panes.filter((pane) => pane.kind === 'harness-child').map((pane) => pane.tabId));
      const kept: SpaceJournal = gone.size === 0 ? loaded : { ...loaded, tabs: loaded.tabs.filter((tab) => !gone.has(tab.id)),
        panes: loaded.panes.filter((pane) => pane.kind !== 'harness-child') };
      // D1b: panes the reboot ended with a saved screen. The screen goes into the same journal commit that marks
      // the pane exited; the snapshot files are consumed only after that commit succeeded, so a failed save
      // leaves the original on disk and the next start recovers the same screen.
      const consumable: string[] = [];
      // A restore that returns undefined, an empty screen or throws did not apply anything: never consumed.
      const safeRestore = (paneId: string): string | undefined => {
        try { const screen = deps.restoreScreen?.(paneId); return screen === undefined || screen === '' ? undefined : screen; } catch { return undefined; }
      };
      const restarted: SpaceJournal = { ...kept, panes: kept.panes.map((pane) => {
        if (pane.ptyId === '') {
          // D1b: a pane that already has no PTY may still have the holder's screen file. When the journal holds a
          // recorded screen the file is only a leftover — dropped after the commit. When the recorded screen is empty
          // (an adopted holder that never answered: its exit carried no final screen) the file is the only copy, so
          // it is applied into the scrollback in this commit and consumed only after that commit succeeded.
          // Consume only after applied: an undefined / empty / throwing restore (a transient read error) is "not
          // applied" — the file stays and the next start retries.
          if (pane.scrollback !== '') { consumable.push(pane.id); return pane; }
          const saved = safeRestore(pane.id);
          if (saved === undefined) return pane;
          consumable.push(pane.id);
          return { ...pane, scrollback: saved };
        }
        // D1a: a pane whose PTY an outside holder still owns is adopted as it is (ptyId and state intact); without
        // a holder — or with a dead one — the pane loses its PTY exactly as before.
        const adopted = pane.state === 'exited' ? undefined : deps.reattach?.(pane);
        if (!adopted) {
          // D1b: no holder answers and no meta remains (a reboot took the holder away). For a live pane the
          // snapshot is its last screen — the pane ended with the reboot and shows it; for an already exited
          // pane the recorded final screen stays and the stale file is dropped (after the commit).
          const restored = safeRestore(pane.id);
          if (restored !== undefined) {
            consumable.push(pane.id);
            if (pane.state !== 'exited') return { ...pane, ptyId: '', state: 'exited', scrollback: restored };
          }
          return { ...pane, ptyId: '', state: pane.state === 'exited' ? 'exited' : 'idle' };
        }
        ptys.set(pane.id, adopted);
        const adoptedId = adopted.id;
        adopted.onExit(() => {
          if (!recordExit(pane.id, adoptedId)) return;
          void adopted.renderScreen().then((screen) => recordFinalScreen(pane.id, screen), () => { /* keep the saved scrollback */ });
        });
        return { ...pane, ptyId: adoptedId, state: pane.state };
      }) };
      const aged: SpaceJournal = { ...restarted, panes: restarted.panes.map((pane) =>
        pane.state === 'exited' && pane.exitedAt === undefined ? { ...pane, exitedAt: now() } : pane) };
      try {
        if (gone.size > 0 || aged.panes.some((pane, index) => pane !== kept.panes[index])) commit(aged);
        else journal = aged;
      } catch (error) {
        return { exitCode: 1, message: `els serve: cannot save the journal: ${message(error)}` };
      }
      // D1b: the journal holds the screens — only now are the snapshot files consumed.
      for (const paneId of consumable) {
        try { deps.consumeScreenSnapshot?.(paneId); } catch { /* a leftover file is harmless; the pane is exited */ }
      }
      return undefined;
    },

    /** Archive the original saved screen before removing an aged exited pane. Live panes are never candidates. */
    reapExited(): number {
      if (!deps.archiveExited) return 0;
      let reaped = 0;
      for (const pane of [...journal.panes]) {
        if (pane.state !== 'exited' || pane.exitedAt === undefined || ptys.has(pane.id)
          || now() - pane.exitedAt < EXITED_PANE_RETENTION_MS) continue;
        try {
          deps.archiveExited(pane);
          const panes = journal.panes.filter((row) => row.id !== pane.id);
          const tabs = panes.some((row) => row.tabId === pane.tabId)
            ? journal.tabs : journal.tabs.filter((row) => row.id !== pane.tabId);
          commit({ ...journal, panes, tabs });
          reaped += 1;
        } catch (error) {
          process.stderr.write(`els reap: ${pane.id} kept: ${message(error)}\n`);
        }
      }
      return reaped;
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
      try { pty = deps.spawn(input.command, input.cwd, label, { ELANOUS_ELS_WS: ws.name, ELANOUS_ELS_PANE: paneId }, input.parent); }
      catch (error) { return { exitCode: 1, message: `els new: failed to spawn: ${message(error)}` }; }
      let address = '';
      try {
        const tab: Tab = { id: tabId, workspaceId: ws.id, label, focusPaneId: paneId };
        const pane: Pane = { id: paneId, tabId, kind: 'pty', title: label, cwd: input.cwd, command: input.command,
          state: 'working', restore: 'cwd', ptyId: pty.id, scrollback: '', ...(input.ownerSeat ? { ownerSeat: input.ownerSeat } : {}) };
        address = paneAddress(ws, tab, pane);
        firstSeen.set(pane.id, now());
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

    reportBuild(paneId: string, sha: string, version?: string, stamp?: string): ElsResult {
      const pane = journal.panes.find((row) => row.id === paneId);
      if (!pane || !livePty(pane) || !/^[a-f0-9]{40}$/i.test(sha)) return { exitCode: 1, message: 'els build: invalid pane or sha' };
      const label = typeof version === 'string' && version.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
      const timestamp = typeof stamp === 'string' && /^\d{6}_\d{4}$/.test(stamp) ? stamp : undefined;
      builds.set(paneId, { sha: sha.toLowerCase(), seen: now(), version: label, stamp: timestamp });
      return { exitCode: 0, message: 'els build: recorded' };
    },

    /** The list may have changed (any journal change or a pane's foreground kind). The callback must be cheap. */
    onChange(listener: () => void): { dispose(): void } {
      changeListeners.add(listener);
      return { dispose: () => { changeListeners.delete(listener); } };
    },

    list(): ElsResult {
      // Panes come out in the order a person set: workspaces in journal order, tabs in journal order inside each, panes by
      // journal order inside a tab — so every client (els, the eln side tab) draws the same list from the same answer.
      const wsAt = (id: string): number => journal.workspaces.findIndex((row) => row.id === id);
      const tabAt = (id: string): number => journal.tabs.findIndex((row) => row.id === id);
      const ordered = journal.panes.map((pane, index) => ({ pane, index, tab: journal.tabs.find((row) => row.id === pane.tabId) }))
        .filter((row): row is { pane: Pane; index: number; tab: Tab } => row.tab !== undefined)
        .sort((a, b) => wsAt(a.tab.workspaceId) - wsAt(b.tab.workspaceId) || tabAt(a.tab.id) - tabAt(b.tab.id) || a.index - b.index);
      const desired = desiredSha();
      // JUD #39000 FU: the mail ledger is read once per listing for all seats (not once per pane), with a short wait.
      const badges = mailBadgesOf(ordered.map(({ pane }) => seatOf(pane.cwd)).filter((seat): seat is string => seat !== null));
      const panes = ordered.flatMap(({ pane, tab }) => {
        const ws = journal.workspaces.find((row) => row.id === tab.workspaceId);
        if (!ws) return [];
        const live = livePty(pane);
        const report = builds.get(pane.id);
        const sha = live && report && now() - report.seen < 90_000 ? report.sha : undefined;
        const build = { sha: sha ?? null, source: sha ? 'self-reported' : 'unknown', trusted: false, desired: desired ?? null,
          age: buildAge(sha, desired, gitAncestor),
          ...(sha && report?.version ? { version: report.version } : {}),
          ...(sha && report?.stamp ? { stamp: report.stamp } : {}) };
        const seat = seatOf(pane.cwd);
        const unreadMail = seat !== null ? badges.get(seat) ?? null : null;
        // ELS-TAB-STATE-BADGE: the badge is the contract state; a working pane with no output, `do` or first sight for the
        // stall window reads `stalled`. The server computes it (one clock), so every client — `els ls`, sidetab — shows the same.
        const listedState = pane.state === 'exited' ? 'exited' : live ? pane.state : 'idle';
        if (!firstSeen.has(pane.id)) firstSeen.set(pane.id, now());
        // Last-event policy: the REAL last event wins — the PTY's own lastOutputAt (a reattached holder pane keeps the output
        // time it really had before this server restarted) or the last `do` delivered, whichever is later. firstSeen
        // (the first time THIS server run saw the pane) is only the floor for a pane with no real event at all (never
        // printed, no `do`, no timestamp from its PTY); it never overrides an older real output. Memory only, nothing persisted.
        const realEventAtMs = Math.max(live?.lastOutputAt?.() ?? 0, lastDelivery.get(pane.id) ?? 0);
        const lastEventAtMs = realEventAtMs > 0 ? realEventAtMs : firstSeen.get(pane.id)!;
        const badge = tabBadge({ state: listedState, lastEventAtMs }, now());
        return [{ build, lastEventAtMs, badge: badge.state, badgeLabel: badge.label, stalled: badge.stalled, address: paneAddress(ws, tab, pane), workspace: ws.name, tab: tab.id, pane: pane.id, title: pane.title, kind: pane.kind,
          cwd: pane.cwd, command: pane.command, state: pane.state === 'exited' ? 'exited' : live ? pane.state : 'idle',
          ptyId: live ? pane.ptyId : '', ...(live?.pid ? { pid: live.pid } : {}), restore: pane.restore, seat, unreadMail,
          ...(live && foregrounds.has(pane.id) ? { kind: foregrounds.get(pane.id)!.kind, fgCommand: foregrounds.get(pane.id)!.command } : {}) }];
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

    /**
     * ELS-DOOR-STRUCT-OPS: rename a workspace or a tab. The name is a person-facing label only — permissions key on
     * stable ids, never names (control.ts pins names to ids on load), so a rename moves no permission.
     */
    rename(input: { kind: string; id: string; name: string }): ElsResult {
      if (input.kind !== 'workspace' && input.kind !== 'tab') return { exitCode: 2, message: 'els rename: kind must be workspace or tab' };
      if (typeof input.id !== 'string' || typeof input.name !== 'string' || !input.name.trim()) return { exitCode: 2, message: 'els rename: id and a non-empty name are required' };
      if (input.kind === 'workspace') {
        const ws = findWorkspace(journal, input.id);
        if (!ws) return { exitCode: 1, message: `els rename: unknown workspace ${input.id}` };
        const workspaces = journal.workspaces.map((row) => row.id === ws.id ? { ...row, name: input.name } : row);
        try { commit({ ...journal, workspaces }); } catch (error) { return { exitCode: 1, message: `els rename: not saved: ${message(error)}` }; }
        return { exitCode: 0, message: `els rename: workspace ${ws.id} renamed to ${input.name}` };
      }
      const tab = journal.tabs.find((row) => row.id === input.id);
      if (!tab) return { exitCode: 1, message: `els rename: unknown tab ${input.id}` };
      const tabs = journal.tabs.map((row) => row.id === tab.id ? { ...row, label: input.name } : row);
      try { commit({ ...journal, tabs }); } catch (error) { return { exitCode: 1, message: `els rename: not saved: ${message(error)}` }; }
      return { exitCode: 0, message: `els rename: tab ${tab.id} renamed to ${input.name}` };
    },

    /** ELS-DOOR-STRUCT-OPS: close every pane of a tab, then the tab itself. Same shape as `close` for a pane. */
    closeTab(ref: string): ElsResult {
      if (typeof ref !== 'string' || !ref) return { exitCode: 2, message: 'els tab close: tab id required' };
      const tab = journal.tabs.find((row) => row.id === ref);
      if (!tab) return { exitCode: 1, message: `els close: unknown tab ${ref}` };
      const panes = journal.panes.filter((row) => row.tabId === tab.id);
      for (const pane of panes) {
        const pty = ptys.get(pane.id);
        ptys.delete(pane.id);
        queues.delete(pane.id);
        if (pty) { try { pty.kill(); } catch { /* already gone */ } }
      }
      const saveError = persist({ ...journal, tabs: journal.tabs.filter((row) => row.id !== tab.id),
        panes: journal.panes.filter((row) => row.tabId !== tab.id) });
      return { exitCode: 0, message: `els close: tab ${tab.id} (${panes.length} panes)${saveError ? ` (not saved yet: ${saveError})` : ''}` };
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
      rawInputVersion.set(hit.pane.id, (rawInputVersion.get(hit.pane.id) ?? 0) + 1);
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
    async frame(ref: string, scrollBack = 0): Promise<ElsResult> {
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els attach: unknown pane ${ref}` };
      const pty = livePty(hit.pane);
      if (!pty) return { exitCode: 0, message: hit.pane.scrollback };
      try { return { exitCode: 0, message: await pty.renderScreen({ ansi: true, ...(scrollBack > 0 ? { scrollBack } : {}) }) }; }
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

    /** The live PTY's data stream (attach turns it into immediate frame pushes — UX #38884 ④). */
    onOutput(paneId: string, cb: (data: string) => void): { dispose(): void } | undefined {
      const hit = resolve(paneId);
      const pty = hit ? livePty(hit.pane) : undefined;
      return pty?.onOutput?.(cb);
    },

    /** The pane's id when `ref` names one (attach checks this before it opens a stream). */
    paneExists(ref: string): string | undefined {
      return resolve(ref)?.pane.id;
    },

    /** #38608 REVIEW must ① — the journal's answer to «which workspace holds this pane». A caller's workspace
     *  is a claim the executor checks against this truth; never the other way round. */
    workspaceOf(ref: string): { readonly id: string; readonly name: string } | undefined {
      const hit = resolve(ref);
      return hit ? { id: hit.ws.id, name: hit.ws.name } : undefined;
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

    /**
     * ELS-GREP-PANES: every pane's last screen searched for a literal `pattern` — the owner's whole pane universe, in
     * the `list` order. A live PTY is rendered plainly (like `read`), an exited pane uses the saved scrollback; but
     * unlike `read` nothing is saved — a search is not a change — and a pane whose screen cannot be rendered is
     * reported in `errors`, never silently skipped. Exit 0 with `hits: []` means «nothing found», not a failure;
     * the empty pattern is a usage error (2). The federation half of the command (remote hosts, herdr rows) lives
     * in the CLI and reuses each host's read path.
     */
    async grep(pattern: string): Promise<ElsResult> {
      if (typeof pattern !== 'string' || pattern === '') return { exitCode: 2, message: 'els grep: needs a pattern' };
      const wsAt = (id: string): number => journal.workspaces.findIndex((row) => row.id === id);
      const tabAt = (id: string): number => journal.tabs.findIndex((row) => row.id === id);
      const ordered = journal.panes.map((pane, index) => ({ pane, index, tab: journal.tabs.find((row) => row.id === pane.tabId) }))
        .filter((row): row is { pane: Pane; index: number; tab: Tab } => row.tab !== undefined)
        .sort((a, b) => wsAt(a.tab.workspaceId) - wsAt(b.tab.workspaceId) || tabAt(a.tab.id) - tabAt(b.tab.id) || a.index - b.index);
      const hits: GrepHit[] = [];
      const errors: string[] = [];
      for (const { pane, tab } of ordered) {
        const ws = journal.workspaces.find((row) => row.id === tab.workspaceId);
        if (!ws) continue;
        const pty = livePty(pane);
        let screen: string;
        if (pty) {
          try { screen = await pty.renderScreen(); }
          catch (error) { errors.push(`els grep: cannot render ${pane.id}: ${message(error)}`); continue; }
        } else screen = pane.scrollback;
        hits.push(...grepScreens(pattern, [{ address: paneAddress(ws, tab, pane), screen }]));
      }
      return { exitCode: 0, message: JSON.stringify({ hits, errors }, null, 2) };
    },

    /** ELS-PANE-STATUS: what the pane is doing (JSON PaneStatus) — read from the live PTY; unknown + reason otherwise. */
    async status(ref: string): Promise<ElsResult> {
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els status: unknown pane ${ref}` };
      const pty = livePty(hit.pane);
      let screen: string | undefined;
      if (pty) { try { screen = await pty.renderScreen(); } catch { screen = undefined; } }
      const status = paneStatus({ pane: hit.pane.id, alive: pty !== undefined, exited: hit.pane.state === 'exited',
        screen, lastOutputAt: pty?.lastOutputAt?.(), now: now() });
      const fg = pty ? foregrounds.get(hit.pane.id) : undefined;
      return { exitCode: 0, message: JSON.stringify(fg ? { ...status, kind: fg.kind, pid: fg.pid } : status) };
    },

    /** A live holder binding for the server-issued pane identity, never a client-supplied PID. */
    paneProcessBinding(paneId: string): { readonly pid: number; readonly generation: string; readonly start: string } | undefined {
      const pane = journal.panes.find(p => p.id === paneId);
      return pane ? livePty(pane)?.processBinding : undefined;
    },
    /** Live server-owned seat bindings, excluding panes whose process generation is not verified. */
    seatBindings(): { pane: string; seat: string; pid: number; generation: string; start: string }[] {
      return journal.panes.flatMap(pane => {
        const binding = livePty(pane)?.processBinding;
        return pane.ownerSeat && binding ? [{ pane: pane.id, seat: pane.ownerSeat, ...binding }] : [];
      });
    },
    /** ELS-PANE-AGENT-DETECT: the live panes with a known shell pid (what the server probes). */
    shellPids(): { readonly pane: string; readonly pid: number }[] {
      return journal.panes.flatMap((pane) => { const pid = livePty(pane)?.pid; return pid ? [{ pane: pane.id, pid }] : []; });
    },
    /** Set what each probed pane runs now; panes not in `next` are forgotten. Returns the panes whose kind changed. */
    setForegrounds(next: ReadonlyMap<string, Foreground>): string[] {
      const changed = [...next].filter(([pane, fg]) => foregrounds.get(pane)?.kind !== fg.kind).map(([pane]) => pane);
      const forgotten = [...foregrounds.keys()].some((pane) => !next.has(pane));
      foregrounds.clear();
      for (const [pane, fg] of next) foregrounds.set(pane, fg);
      if (changed.length > 0 || forgotten) notifyChange();
      return changed;
    },

    /** Submit one intact paste, then report whether this PTY displayed a new running turn. */
    async sendVerified(ref: string, text: string, requireEmpty = false): Promise<ElsResult> {
      if (!text || text.includes('\x1b') || text.includes('\x00')) return { exitCode: 2, message: 'els send: empty text or unsupported control character; not sent' };
      const first = resolve(ref);
      if (!first) return { exitCode: 1, message: `els send: unknown pane ${ref}` };
      return serialized(first.pane.id, async () => {
        const hit = resolve(first.pane.id);
        const pty = hit && livePty(hit.pane);
        if (!hit || !pty) return { exitCode: 1, message: `els send: pane ${first.pane.id} has no live pty` };
        let before: string;
        try { before = await pty.renderScreen(); }
        catch (error) { return { exitCode: 1, message: `els send: cannot inspect pane, not sent: ${message(error)}` }; }
        if (hitlApprovalPending(before)) return { exitCode: 1, message: 'els send: HITL approval pending; authenticated human attach key required' };
        if (tuiNeedsPaste(hit.pane, pty, before)) return { exitCode: 1, message: 'els send: TUI paste mode not confirmed; not sent' };
        if (turnStarted(before)) return { exitCode: 1, message: `els send: ${hit.pane.id} is already running, not sent` };
        if (requireEmpty) {
          const view = paneStatus({ pane: hit.pane.id, alive: true, exited: false, screen: before, lastOutputAt: pty.lastOutputAt?.(), now: now() });
          if (view.state !== 'idle' || view.inputEmpty !== true) return { exitCode: 1, message: `els send: pane not idle with empty input; not sent (${view.reason})` };
        }
        if (!livePty(hit.pane)) return { exitCode: 1, message: `els send: ${hit.pane.id} exited, not sent` };
        const pasteMode = pty.bracketedPasteEnabled?.() === true;
        if (!pty.writeAll) return { exitCode: 1, message: 'els send: PTY cannot verify complete writes; not sent' };
        // JUD-B #103319 must: without bracketed paste the shell reads every byte as typed — a line break inside the text
        // would submit more than one command and a control byte (Ctrl-C/D …) would be a signal. Plain mode takes one line
        // only (a trailing line break is the Enter it adds anyway); anything else is refused before a byte is written.
        const line = text.replace(/[\r\n]+$/, '');
        if (!pasteMode && /[yY]/.test(line)) return { exitCode: 1, message: 'els send: safe paste mode not confirmed for approval letter; not sent' };
        if (!pasteMode && PLAIN_UNSAFE.test(line)) return { exitCode: 2, message: 'els send: plain 모드는 한 줄 텍스트만 — 줄바꿈·제어 문자가 있어 보내지 않음 (bracketed paste 를 켠 pane 에선 여러 줄 가능)' };
        const submitted = pasteMode ? `\x1b[200~${text}\x1b[201~\r` : `${line}\r`;
        try { await pty.writeAll(submitted); }
        catch (error) { return { exitCode: 1, message: `els send: write failed; delivery unknown: ${message(error)}` }; }
        if (!pasteMode) {
          const saveError = patchLive(hit.pane.id, pty.id, { state: 'working' });
          return { exitCode: 0, message: `els send: ${hit.pane.id} submitted ${text.length} chars; mode=plain; turn start unverified${saveError ? ` (state not saved: ${saveError})` : ''}` };
        }
        for (let attempt = 0; attempt < 30; attempt++) { // 3 seconds, inside the client request timeout.
          await new Promise<void>(resolve => setTimeout(resolve, 100));
          if (!livePty(hit.pane)) return { exitCode: 1, message: `els send: ${hit.pane.id} exited after submit; turn start unknown` };
          try {
            const screen = await pty.renderScreen();
            if (turnStarted(screen)) {
              const saveError = patchLive(hit.pane.id, pty.id, { state: 'working' });
              return { exitCode: 0, message: `els send: ${hit.pane.id} submitted ${text.length} chars; turn started${saveError ? ` (state not saved: ${saveError})` : ''}` };
            }
            // D10: the turn already finished before the busy marker could be observed (fast turn).
            if (TURN_DONE_HINT.test(screen) && !TURN_DONE_HINT.test(before)) {
              return { exitCode: 0, message: `els send: ${hit.pane.id} submitted ${text.length} chars; turn started (already completed before the busy marker could be observed)` };
            }
          } catch (error) { return { exitCode: 1, message: `els send: submitted; turn start unknown: ${message(error)}` }; }
        }
        return { exitCode: 1, message: `els send: ${hit.pane.id} submitted; turn start not observed (do not blindly retry)` };
      });
    },

    async send(ref: string, rawText: string): Promise<ElsResult> {
      if (typeof rawText !== 'string' || SEND_TEXT_CONTROL.test(rawText)) return { exitCode: 2, message: 'els send: control byte refused; nothing sent' };
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els send: unknown pane ${ref}` };
      return serialized(hit.pane.id, async () => {
        const current = resolve(hit.pane.id);
        const pty = current && livePty(current.pane);
        if (!current || !pty) return { exitCode: 1, message: `els send: pane ${hit.pane.id} has no live pty (restart restores cwd only)` };
        const refusal = await machineInputRefusal(current.pane, pty, true);
        if (refusal) return { exitCode: 1, message: `els send: ${refusal}; nothing sent` };
        if (livePty(current.pane) !== pty) return { exitCode: 1, message: 'els send: pane changed; nothing sent' };
        const text = clean(rawText);
        try { pty.write(machinePaste(current.pane, pty, text, false)); }
        catch (error) { return { exitCode: 1, message: `els send: ${message(error)}` }; }
        const saveError = patchLive(current.pane.id, pty.id, { state: 'working' });
        return { exitCode: 0, message: `els send: ${current.pane.id} ${text.length} chars${saveError ? ` (state not saved: ${saveError})` : ''}` };
      });
    },

    /** One-shot socket input is machine input. Only the authenticated attach stream calls raw input(). */
    async machineInput(ref: string, bytes: string, allowBusyInterrupt = false): Promise<ElsResult> {
      if (typeof bytes !== 'string') return { exitCode: 2, message: 'els input: bytes must be a string' };
      const hit = resolve(ref);
      if (!hit) return { exitCode: 1, message: `els input: unknown pane ${ref}` };
      return serialized(hit.pane.id, async () => {
        const current = resolve(hit.pane.id);
        const pty = current && livePty(current.pane);
        if (!current || !pty) return { exitCode: 1, message: `els input: pane ${hit.pane.id} is not running` };
        const refusal = await machineInputRefusal(current.pane, pty, !allowBusyInterrupt);
        if (refusal) return { exitCode: 1, message: `els input: ${refusal}; nothing sent` };
        if (allowBusyInterrupt && bytes === '\x1b') return this.input(current.pane.id, bytes);
        const pasteMode = pty.bracketedPasteEnabled?.() === true;
        if (pasteMode) {
          const enter = bytes.endsWith('\r');
          const text = enter ? bytes.slice(0, -1) : bytes;
          if (text && !SEND_TEXT_CONTROL.test(text)) return this.input(current.pane.id, machinePaste(current.pane, pty, text, enter));
          // Pure editing keys may still be sent, but raw control mixtures and approval letters
          // cannot bypass the send-keys allowlist by addressing the socket directly.
          if (/^(?:\r|\t|\x7f|\x1b\[(?:[ABCDHFZ]|3~|5~|6~))+$/.test(bytes)) return this.input(current.pane.id, bytes);
          return { exitCode: 2, message: 'els input: unsupported control byte on TUI machine path; not sent' };
        }
        const plain = /[\r\n]$/.test(bytes) ? bytes.slice(0, -1) : bytes;
        if (!SEND_TEXT_CONTROL.test(plain) && !/[yY]/.test(plain)) return this.input(current.pane.id, bytes);
        if (/^(?:\r|\n|\t|\x7f|\x1b\[(?:[ABCDHFZ]|3~|5~|6~))+$/.test(bytes)) return this.input(current.pane.id, bytes);
        return { exitCode: 2, message: 'els input: control sequence or approval letter needs safe paste mode; not sent' };
      });
    },

    /**
     * `do`: type a line into a live pane on behalf of `from`, marked «⇢ from · text» and submitted with Enter.
     * Control characters are dropped. If the pane's turn is running (or lines are already waiting) the line is queued
     * in order — it never overwrites a running turn — and `drain` delivers it when the screen is idle.
     * If the busy check itself fails the line is NOT sent (fail closed).
     */
    async do(ref: string, rawText: string, rawFrom: string, audit?: QueueAudit, validate?: () => Promise<boolean>): Promise<ElsResult> {
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
        const approvalRefusal = await machineInputRefusal(hit.pane, pty);
        if (approvalRefusal) return { exitCode: 1, message: `els do: ${approvalRefusal}; not sent` };
        // A raw attach input can arrive while screen inspection or authorization awaits.
        const inputVersion = rawInputVersion.get(hit.pane.id) ?? 0;
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
          if (audit && !audit('queued')) return { exitCode: 1, message: 'els do: not queued (audit not writable)' };
          queues.set(hit.pane.id, [...queue, { from, text, audit, validate }]);
          return { exitCode: 0, queued: queue.length + 1, message: `els do: queued ${queue.length + 1} for ${hit.pane.id} (turn running)` };
        }
        // Idle: a queue may have appeared while the screen was rendering (a drain cannot, but stay safe) — then go behind it.
        if (queues.has(hit.pane.id)) {
          const queue = queues.get(hit.pane.id)!;
          if (queue.length >= MAX_QUEUE) return { exitCode: 1, message: `els do: ${hit.pane.id} already has ${MAX_QUEUE} lines waiting, not queued` };
          if (audit && !audit('queued')) return { exitCode: 1, message: 'els do: not queued (audit not writable)' };
          queues.set(hit.pane.id, [...queue, { from, text, audit, validate }]);
          return { exitCode: 0, queued: queue.length + 1, message: `els do: queued ${queue.length + 1} for ${hit.pane.id}` };
        }
        if (validate && !(await validate().catch(() => false))) return { exitCode: 1, message: 'els do: authorization changed, not sent' };
        let stillIdle = false;
        try { stillIdle = !BUSY_SCREEN.test(await pty.renderScreen()); } catch { /* defer */ }
        const current = journal.panes.find((row) => row.id === hit.pane.id);
        if (!current || livePty(current) !== pty) return { exitCode: 1, message: `els do: pane ${hit.pane.id} ended before the line was sent` };
        if (!stillIdle || (rawInputVersion.get(hit.pane.id) ?? 0) !== inputVersion) {
          const queue = queues.get(hit.pane.id) ?? [];
          if (queue.length >= MAX_QUEUE) return { exitCode: 1, message: `els do: ${hit.pane.id} already has ${MAX_QUEUE} lines waiting, not queued` };
          if (audit && !audit('queued')) return { exitCode: 1, message: 'els do: not queued (audit not writable)' };
          queues.set(hit.pane.id, [...queue, { from, text, audit, validate }]);
          return { exitCode: 0, queued: queue.length + 1, message: `els do: queued ${queue.length + 1} for ${hit.pane.id} (input changed)` };
        }
        const final = await finalAuthorization(pty, validate);
        if (!final.allowed) return { exitCode: 1, message: 'els do: authorization changed, not sent' };
        const finalRefusal = await machineInputRefusal(current, pty);
        if (finalRefusal) return { exitCode: 1, message: `els do: ${finalRefusal}; not sent` };
        if (livePty(current) !== pty) return { exitCode: 1, message: 'els do: pane changed, not sent' };
        if (final.changed || (rawInputVersion.get(hit.pane.id) ?? 0) !== inputVersion) {
          const queue = queues.get(hit.pane.id) ?? [];
          if (queue.length >= MAX_QUEUE) return { exitCode: 1, message: 'els do: queue full, not sent' };
          if (audit && !audit('queued')) return { exitCode: 1, message: 'els do: not queued (audit not writable)' };
          queues.set(hit.pane.id, [...queue, { from, text, audit, validate }]);
          return { exitCode: 0, queued: queue.length + 1, message: 'els do: queued after target changed' };
        }
        return deliver(current, pty, from, text);
      });
    },

    /**
     * `input`: type a line into a live pane as the person at the keyboard would — no «⇢» marker, submitted with
     * Enter (OP #17 OP-DIRECT-SEAT-INPUT; the control door lets only OP and RES-INFRA reach this). Same rules as
     * `do`: one line, no control characters, queued while the pane's turn runs, fail closed.
     */
    async inputLine(ref: string, rawText: string, rawFrom: string, audit?: QueueAudit, validate?: () => Promise<boolean>): Promise<ElsResult> {
      const text = clean(rawText);
      const from = clean(rawFrom).slice(0, 64) || 'unknown';
      if (!text) return { exitCode: 2, message: 'els input: text is empty' };
      if (text.length > MAX_DO_CHARS) return { exitCode: 2, message: `els input: text is longer than ${MAX_DO_CHARS} chars` };
      const first = resolve(ref);
      if (!first) return { exitCode: 1, message: `els input: unknown pane ${ref}` };
      return serialized(first.pane.id, async () => {
        const hit = resolve(first.pane.id);
        if (!hit) return { exitCode: 1, message: `els input: unknown pane ${ref}` };
        const pty = livePty(hit.pane);
        if (!pty) return { exitCode: 1, message: `els input: pane ${hit.pane.id} has no live pty (restart restores cwd only)` };
        const approvalRefusal = await machineInputRefusal(hit.pane, pty);
        if (approvalRefusal) return { exitCode: 1, message: `els input: ${approvalRefusal}; nothing sent` };
        const inputVersion = rawInputVersion.get(hit.pane.id) ?? 0;
        let busy = queues.has(hit.pane.id) || now() - (lastDelivery.get(hit.pane.id) ?? -Infinity) < QUEUE_SETTLE_MS;
        if (!busy) {
          try { busy = BUSY_SCREEN.test(await pty.renderScreen()); }
          catch (error) { return { exitCode: 1, message: `els input: cannot check whether ${hit.pane.id} is busy, not sent: ${message(error)}` }; }
        }
        if (busy) {
          // The pane may have exited while its screen was being rendered.
          const queue = queues.get(hit.pane.id) ?? [];
          if (!livePty(hit.pane)) return { exitCode: 1, message: `els input: pane ${hit.pane.id} ended before the line was queued` };
          if (queue.length >= MAX_QUEUE) return { exitCode: 1, message: `els input: ${hit.pane.id} already has ${MAX_QUEUE} lines waiting, not queued` };
          if (audit && !audit('queued')) return { exitCode: 1, message: 'els input: not queued (audit not writable)' };
          const at = queue.findIndex((item) => !item.typed);
          const index = at < 0 ? queue.length : at;
          queues.set(hit.pane.id, [...queue.slice(0, index), { from, text, typed: true, audit, validate }, ...queue.slice(index)]);
          return { exitCode: 0, queued: queue.length + 1, message: `els input: queued ${queue.length + 1} for ${hit.pane.id} (turn running; memory only, not yet delivered)` };
        }
        // Idle: a queue may have appeared while the screen was rendering (a drain cannot, but stay safe) — then go behind it.
        if (queues.has(hit.pane.id)) {
          const queue = queues.get(hit.pane.id)!;
          if (queue.length >= MAX_QUEUE) return { exitCode: 1, message: `els input: ${hit.pane.id} already has ${MAX_QUEUE} lines waiting, not queued` };
          if (audit && !audit('queued')) return { exitCode: 1, message: 'els input: not queued (audit not writable)' };
          const at = queue.findIndex((item) => !item.typed);
          const index = at < 0 ? queue.length : at;
          queues.set(hit.pane.id, [...queue.slice(0, index), { from, text, typed: true, audit, validate }, ...queue.slice(index)]);
          return { exitCode: 0, queued: queues.get(hit.pane.id)!.length, message: `els input: queued ${queues.get(hit.pane.id)!.length} for ${hit.pane.id} (memory only, not yet delivered)` };
        }
        if (validate && !(await validate().catch(() => false))) return { exitCode: 1, message: 'els input: authorization changed, not sent' };
        let stillIdle = false;
        try { stillIdle = !BUSY_SCREEN.test(await pty.renderScreen()); } catch { /* defer */ }
        const current = journal.panes.find((row) => row.id === hit.pane.id);
        if (!current || livePty(current) !== pty) return { exitCode: 1, message: `els input: pane ${hit.pane.id} ended before the line was sent` };
        if (!stillIdle || (rawInputVersion.get(hit.pane.id) ?? 0) !== inputVersion) {
          const queue = queues.get(hit.pane.id) ?? [];
          if (queue.length >= MAX_QUEUE) return { exitCode: 1, message: `els input: ${hit.pane.id} already has ${MAX_QUEUE} lines waiting, not queued` };
          if (audit && !audit('queued')) return { exitCode: 1, message: 'els input: not queued (audit not writable)' };
          const at = queue.findIndex(item => !item.typed);
          const index = at < 0 ? queue.length : at;
          queues.set(hit.pane.id, [...queue.slice(0, index), { from, text, typed: true, audit, validate }, ...queue.slice(index)]);
          return { exitCode: 0, queued: queue.length + 1, message: `els input: queued ${queue.length + 1} for ${hit.pane.id} (input changed; memory only, not yet delivered)` };
        }
        const final = await finalAuthorization(pty, validate);
        if (!final.allowed) return { exitCode: 1, message: 'els input: authorization changed, not sent' };
        const finalRefusal = await machineInputRefusal(current, pty);
        if (finalRefusal) return { exitCode: 1, message: `els input: ${finalRefusal}; nothing sent` };
        if (livePty(current) !== pty) return { exitCode: 1, message: 'els input: pane changed, not sent' };
        if (final.changed || (rawInputVersion.get(hit.pane.id) ?? 0) !== inputVersion) {
          const queue = queues.get(hit.pane.id) ?? [];
          if (queue.length >= MAX_QUEUE) return { exitCode: 1, message: 'els input: queue full, not sent' };
          if (audit && !audit('queued')) return { exitCode: 1, message: 'els input: not queued (audit not writable)' };
          const at = queue.findIndex(item => !item.typed);
          const index = at < 0 ? queue.length : at;
          queues.set(hit.pane.id, [...queue.slice(0, index), { from, text, typed: true, audit, validate }, ...queue.slice(index)]);
          return { exitCode: 0, queued: queue.length + 1, message: 'els input: queued after target changed' };
        }
        return deliverTyped(current, pty, text);
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
      discardQueue(paneId, 'pane closed');
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
        discardQueue(pane.id, 'workspace closed');
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

    /** Stop every pane PTY (server shutdown). A holder-owned PTY is released, not killed (D1a: the next server
     *  re-attaches to the holder, the pane survives the restart); a PTY in this process still dies. The journal keeps the panes. */
    stopAll(): void {
      for (const paneId of queues.keys()) discardQueue(paneId, 'server shutdown');
      for (const pty of ptys.values()) {
        if (typeof pty.detach === 'function') { try { pty.detach(); } catch { /* already gone */ } }
        else { try { pty.kill(); } catch { /* already gone */ } }
      }
    },
  };
}

export type ElsCore = ReturnType<typeof createElsCore>;

/** The seat a pane belongs to by its cwd (`…/seats/<SEAT>/…`), or null when the pane has no seat folder — the OP seat-mail badge (#22 주소록 cwd 규약). */
function seatOf(cwd: string): string | null {
  const i = cwd.lastIndexOf('/seats/');
  if (i < 0) return null;
  const seat = cwd.slice(i + '/seats/'.length).split('/')[0] ?? '';
  return seat.length > 0 ? seat : null;
}

/** Unread mail badges (미ack 수 + 최장 대기) for the listed seats — one ledger read; absent/locked ledger → none, never throws (ls must not fail on badge lookup). */
function mailBadgesOf(seats: readonly string[]): ReadonlyMap<string, { count: number; oldestCreatedAt: string | null } | null> {
  try { return readUnreadMailBadges(seats); } catch { return new Map(); }
}
