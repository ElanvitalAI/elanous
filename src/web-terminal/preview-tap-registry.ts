// WT-S-1 — PreviewTerminal ↔ ACP fan-out registry.
//
// Bridges the existing `PreviewTerminal.addRawOutputTap()` (T7c1) to
// the ACP `terminalOutput()` broadcast on a daemon-bound
// `AcpServerHandle`. Read-only direction: daemon stdout → web peers.
//
// Why a registry instead of wiring inline at the dashboard?
//   1. PreviewTerminal instances live in the dashboard layer; the
//      AcpServerHandle is bound on the daemon-public-server boot path.
//      The two converge here without either side knowing about the
//      other.
//   2. WT-S-2 will replace the direct `addRawOutputTap` hook with
//      PaneFactory's `addTap('raw', ...)` — keeping the handoff in one
//      file lets that swap stay surgical.
//
// Lifecycle: register at PreviewTerminal construction or session attach,
// unregister a session on detach or the whole shell on stop. Re-registering
// the same session replaces its tap; other sessions remain attached.

import type { PreviewTerminal } from '../preview/terminal.js';
import type { AcpServerHandle } from '../acp/server.js';
import { debug } from '../debug/log.js';
import { getDefaultPaneFactory } from '../panes/factory.js';
import { webTerminalPaneRef } from '../panes/web-terminal-pane.js';

interface SessionTap {
  unsubscribe: () => void;
}

interface Entry {
  terminalId: string;
  sessions: Map<string, SessionTap>;
  /** WT-S-3 — set when the web-terminal was successfully resolved
   *  through the PaneFactory. Cleared on unregister so capture engine
   *  / LLM tools don't see a stale pane after the PTY exits. */
  paneResolved: boolean;
  /** 최초 등록 시각(ms). 재등록 뒤에도 정렬 기준을 안정적으로 유지한다. */
  firstRegisteredAt: number;
  /** P4(2026-07-12) — 마지막 PTY 출력 시각(ms). output tap 에서 갱신 —
   *  터미널 탭 "최근 활동" 표면용. 등록 시각으로 초기화. */
  lastOutputAt: number;
}

const entries = new Map<PreviewTerminal, Entry>();

/** Attach one ACP session to a shell. Re-attaching that session replaces only
 *  its output tap; the returned thunk detaches only this registration. */
export function registerPreviewTerminalForWebTap(
  pt: PreviewTerminal,
  sessionId: string,
  terminalId: string,
  handle: AcpServerHandle,
): () => void {
  let entry = entries.get(pt);
  const firstRegisteredAt = entry?.firstRegisteredAt;
  if (entry && entry.terminalId !== terminalId) {
    unregisterPreviewTerminalForWebTap(pt);
    entry = undefined;
  }
  if (entry?.sessions.has(sessionId)) {
    // Replace only this session's tap; keep the entry and its activity clock.
    const previous = entry.sessions.get(sessionId)!;
    previous.unsubscribe();
    entry.sessions.delete(sessionId);
  }
  const off = pt.addRawOutputTap((chunk) => {
    if (debug.enabled) {
      debug.log('webterm.tap', 'chunk', {
        terminalId,
        bytes: chunk.length,
      });
    }
    const e = entries.get(pt);
    if (e) e.lastOutputAt = Date.now();
    void handle.terminalOutput(sessionId, terminalId, chunk);
  });
  // WT-S-3 — register through PaneFactory so capture engine /
  // ObserveSurface / DescribeSurface / Compare/WatchPane / Snapshot
  // tools all see the web-terminal as a first-class Pane. Best-effort:
  // factory may not be initialised in headless test contexts.
  let paneResolved = false;
  try {
    const factory = getDefaultPaneFactory();
    factory.resolveFromWebTerminal(webTerminalPaneRef(terminalId), {
      sessionId, terminalId, pty: pt,
    });
    paneResolved = true;
    if (debug.enabled) {
      debug.log('webterm.tap', 'pane.resolved', { sessionId, terminalId });
    }
  } catch (err) {
    if (debug.enabled) {
      debug.log('webterm.tap', 'pane.resolve-skip', {
        sessionId, terminalId, reason: String(err instanceof Error ? err.message : err),
      });
    }
  }
  const registeredAt = firstRegisteredAt ?? Date.now();
  if (!entry) {
    entry = {
      terminalId,
      sessions: new Map(),
      paneResolved,
      firstRegisteredAt: registeredAt,
      lastOutputAt: registeredAt,
    };
    entries.set(pt, entry);
  } else {
    entry.paneResolved ||= paneResolved;
  }
  const tap = { unsubscribe: off };
  entry.sessions.set(sessionId, tap);
  if (debug.enabled) {
    debug.log('webterm.tap', 'register', { sessionId, terminalId, paneResolved });
  }
  return () => {
    if (entries.get(pt)?.sessions.get(sessionId) === tap) {
      detachPreviewTerminalSession(pt, sessionId);
    }
  };
}

function detachPreviewTerminalSession(pt: PreviewTerminal, sessionId: string): void {
  const e = entries.get(pt);
  if (!e?.sessions.has(sessionId)) return;
  e.sessions.get(sessionId)!.unsubscribe();
  e.sessions.delete(sessionId);
  if (e.sessions.size === 0) {
    if (e.paneResolved) {
      try { getDefaultPaneFactory().invalidate(webTerminalPaneRef(e.terminalId)); }
      catch { /* factory may have reset */ }
    }
    entries.delete(pt);
  }
  if (debug.enabled) debug.log('webterm.tap', 'unregister', {
    sessionId, terminalId: e.terminalId, paneInvalidated: e.sessions.size === 0 && e.paneResolved,
  });
}

/** Drop the entire shell (on PTY exit/destroy). A registration's returned
 *  thunk detaches only that session; the last detach invalidates its pane. */
export function unregisterPreviewTerminalForWebTap(pt: PreviewTerminal): void {
  const e = entries.get(pt);
  if (!e) return;
  for (const tap of e.sessions.values()) tap.unsubscribe();
  if (e.paneResolved) {
    try { getDefaultPaneFactory().invalidate(webTerminalPaneRef(e.terminalId)); }
    catch { /* factory may have reset */ }
  }
  entries.delete(pt);
  if (debug.enabled) debug.log('webterm.tap', 'unregister', {
    terminalId: e.terminalId, paneInvalidated: e.paneResolved,
  });
}

/** Test/diagnostic — number of currently registered PreviewTerminals. */
export function getRegisteredPreviewTerminalCount(): number {
  return entries.size;
}

/** WT-A-1 — reverse lookup. Returns the registered PreviewTerminal
 *  whose (sessionId, terminalId) matches, or null. Used by the daemon
 *  ACP `terminal/input` / `terminal/resize` handlers to route incoming
 *  PWA writes to the right PTY. */
export function lookupPreviewTerminal(
  sessionId: string,
  terminalId: string,
): import('../preview/terminal.js').PreviewTerminal | null {
  for (const [pt, e] of entries) {
    if (e.sessions.has(sessionId) && e.terminalId === terminalId) return pt;
  }
  return null;
}

/** Return each shell registered under this ID, with its attached session IDs. */
export function findPreviewTerminalsById(terminalId: string): Array<{ pt: PreviewTerminal; sessionIds: string[] }> {
  return Array.from(entries, ([pt, e]) => ({ pt, e }))
    .filter(({ e }) => e.terminalId === terminalId)
    .map(({ pt, e }) => ({ pt, sessionIds: [...e.sessions.keys()] }));
}

/** WT-S-2 — public-facing list entry shape returned by the
 *  `terminal/list` ACP ext method. Kept narrow on purpose: pid + dims +
 *  alive flag are the only fields the PWA TabsBar needs to render
 *  per-terminal status. Add fields conservatively (each becomes part of
 *  the wire contract). */
export interface PreviewTerminalListEntry {
  /** A registered ACP session (first attached for the shell-wide listing). */
  sessionId: string;
  terminalId: string;
  pid: number;
  cols: number;
  rows: number;
  isAlive: boolean;
  /** 최초 등록 시각(epoch ms). 재등록 중에도 유지되는 터미널 시작 시각. */
  firstRegisteredAt: number;
  /** P4 — 마지막 PTY 출력 시각(epoch ms). 탭 "최근 활동" 표면용. */
  lastOutputAt: number;
}

function toPreviewTerminalListEntry(
  pt: PreviewTerminal,
  entry: Entry,
  sessionId: string,
): PreviewTerminalListEntry {
  return {
    sessionId,
    terminalId: entry.terminalId,
    pid: pt.pid,
    cols: pt.cols,
    rows: pt.rows,
    isAlive: pt.isAlive,
    firstRegisteredAt: entry.firstRegisteredAt,
    lastOutputAt: entry.lastOutputAt,
  };
}

/** Enumerate each registered shell once in the global registry. */
export function listAllPreviewTerminals(): PreviewTerminalListEntry[] {
  return Array.from(entries, ([pt, entry]) => {
    const sessionId = entry.sessions.keys().next().value;
    return sessionId === undefined ? null : toPreviewTerminalListEntry(pt, entry, sessionId);
  }).filter((entry): entry is PreviewTerminalListEntry => entry !== null);
}

/** WT-S-2 — enumerate active terminals for `sessionId`. Used by the
 *  daemon `terminal/list` extMethod handler. Linear scan over the
 *  global registry — fine for the expected ≤10 terminals per session;
 *  if that scales out, partition `entries` by sessionId here without
 *  touching the call sites. */
export function listPreviewTerminals(sessionId: string): PreviewTerminalListEntry[] {
  return Array.from(entries, ([pt, entry]) => entry.sessions.has(sessionId)
    ? toPreviewTerminalListEntry(pt, entry, sessionId) : null)
    .filter((entry): entry is PreviewTerminalListEntry => entry !== null);
}

/** Test-only — wipe all entries. Production callers should use
 *  `unregisterPreviewTerminalForWebTap` per terminal. */
export function __resetPreviewTapRegistry(): void {
  for (const e of entries.values()) for (const tap of e.sessions.values()) tap.unsubscribe();
  entries.clear();
}
