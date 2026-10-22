// ── In-process clipboard history ──
//
// Polls the system clipboard at a configurable interval and stores
// unique text snapshots in an in-memory ring buffer. The dashboard's
// scratch pane "clipboard mode" renders this list so the user can
// scroll back through what they've copied during the session and
// re-promote any past entry to the live clipboard with one keypress.
//
// Why polling vs an OS event hook: macOS doesn't expose a clipboard-
// changed notification to userland binaries without entitlements.
// Keep a short active cadence, then back off while the TUI is idle so
// an open terminal does not spawn pbpaste every 1.5s indefinitely.
// CLASSIC-IDLE-CLIPBOARD (2026-10-21): callers that only show the history
// inside a panel start with `active: false` and flip `setActive(true)` while
// the panel is visible — a closed panel spawns zero pbpaste processes
// (5-minute idle classic TUI measured 88 reads before this change).
//
// Image entries: we already track a separate path-based registry for
// pasted screenshots (context.ts). This module is text-only by
// design — image previews live in the main scratchpad already.

import { readClipboardText, isClipboardSupported } from './index.js';
import { debug } from '../debug/log.js';

export interface ClipboardEntry {
  /** UTF-8 text. Trimmed of a single trailing newline so visually
   *  identical pastes don't fragment the history. */
  text: string;
  /** epoch ms when this snapshot was first seen. */
  ts: number;
}

export interface ClipboardHistoryOpts {
  /** Polling interval in ms. Defaults to 1500. */
  intervalMs?: number;
  /** Start slowing clipboard reads after this much user inactivity. Defaults to 2 minutes. */
  idleAfterMs?: number;
  /** Poll interval multiplier after idleAfterMs. Defaults to 10 (15s with the default cadence). */
  idleIntervalMultiplier?: number;
  /** Start the deepest backoff after this much user inactivity. Defaults to 10 minutes. */
  longIdleAfterMs?: number;
  /** Poll interval multiplier after longIdleAfterMs. Defaults to 60 (90s with the default cadence). */
  longIdleIntervalMultiplier?: number;
  /** Start polling immediately. Defaults to true. `false` keeps the poller
   *  dormant (no reads, no timer) until `setActive(true)`. */
  active?: boolean;
  /** Busy streams keep the active cadence and restart the idle grace period when they finish. */
  isBusy?: () => boolean;
  /** Cap on stored entries; oldest fall off when exceeded. Defaults
   *  to 50 — enough for a typical session, not so big the list
   *  becomes unscrollable. */
  maxEntries?: number;
  /** Reject snapshots longer than this many bytes — protects against
   *  accidentally stuffing a giant clipboard contents (a whole
   *  source file etc.) into history. Defaults to 8KB; bypass by
   *  setting to 0. */
  maxBytes?: number;
}

/** Dependencies are injectable so tests can exercise the real poller without
 * process-wide `mock.module()` state. Production callers use the defaults. */
export interface ClipboardHistoryDependencies {
  readClipboardText(): Promise<string | null>;
  isClipboardSupported(): boolean;
  /** Observation sink for poll-state transitions. Defaults to
   *  `debug.log('clipboard.history', …)`; tests inject a recorder because
   *  the debug sink arms its own flush timer. */
  observe?(event: 'poll-state', data: { active: boolean; reason: string }): void;
}

export interface ClipboardHistory {
  /** Snapshot list, newest first. Caller may read but should not
   *  mutate — use `clear` to reset. */
  readonly entries: ReadonlyArray<ClipboardEntry>;
  /** Subscribe to new entries. Returns an unsubscribe function. */
  onChange(fn: () => void): () => void;
  /** Stop polling. Idempotent. */
  stop(): void;
  /** Drop everything. Useful for `/scratch clipboard clear`. */
  clear(): void;
  /** Force one immediate poll — useful after writeClipboard so the
   *  history reflects the just-promoted entry without waiting for
   *  the next tick. */
  pokeNow(): Promise<void>;
  /** Mark TUI input. Wakes the poller immediately if it had slowed down. */
  noteActivity(): void;
  /** Notify the poller immediately when its busy source changes state. */
  noteBusyChange(): void;
  /** Start/stop background polling (e.g. history panel opened/closed).
   *  Activating reads once immediately; deactivating clears the timer.
   *  Repeating the current state is a no-op. */
  setActive(active: boolean, reason?: string): void;
}

/** Start polling. No-op on non-clipboard platforms — returns a stub
 *  with empty entries so callers don't need to guard every call. */
export function startClipboardHistory(
  opts: ClipboardHistoryOpts = {},
  dependencies: ClipboardHistoryDependencies = { readClipboardText, isClipboardSupported },
): ClipboardHistory {
  const intervalMs = opts.intervalMs ?? 1500;
  const idleAfterMs = opts.idleAfterMs ?? 2 * 60_000;
  const idleIntervalMultiplier = opts.idleIntervalMultiplier ?? 10;
  const longIdleAfterMs = opts.longIdleAfterMs ?? 10 * 60_000;
  const longIdleIntervalMultiplier = opts.longIdleIntervalMultiplier ?? 60;
  const maxEntries = opts.maxEntries ?? 50;
  const maxBytes = opts.maxBytes ?? 8 * 1024;

  const entries: ClipboardEntry[] = [];
  const subs = new Set<() => void>();
  let stopped = false;
  let lastSeenText: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let immediatePollAfterInFlight = false;
  let queuedActivityPoll: Promise<void> | null = null;
  let lastActivityAt = Date.now();
  let wasBusy = readBusy();
  let active = opts.active ?? true;

  function readBusy(): boolean {
    try { return opts.isBusy?.() ?? false; } catch { return false; }
  }

  const idleMs = (): number => {
    const busy = readBusy();
    if (wasBusy && !busy) lastActivityAt = Date.now();
    wasBusy = busy;
    return busy ? 0 : Math.max(0, Date.now() - lastActivityAt);
  };

  const nextDelayMs = (): number => {
    const idle = idleMs();
    if (idle >= longIdleAfterMs) return intervalMs * longIdleIntervalMultiplier;
    if (idle >= idleAfterMs) return intervalMs * idleIntervalMultiplier;
    return intervalMs;
  };

  const scheduleNext = (): void => {
    if (stopped || !active) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, nextDelayMs());
  };

  if (!dependencies.isClipboardSupported()) {
    return {
      entries,
      onChange: (fn) => { subs.add(fn); return () => subs.delete(fn); },
      stop: () => { stopped = true; },
      clear: () => { entries.length = 0; },
      pokeNow: async () => { /* no-op */ },
      noteActivity: () => {},
      noteBusyChange: () => {},
      setActive: () => {},
    };
  }

  const ingest = (raw: string | null): void => {
    if (raw == null) return;
    // Normalise: strip a single trailing newline, drop empty + whitespace-only.
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (text.trim() === '') return;
    if (maxBytes > 0 && Buffer.byteLength(text, 'utf8') > maxBytes) return;
    if (text === lastSeenText) return;
    lastSeenText = text;
    // De-dup against existing entries by text — re-promotion just
    // bubbles the entry to the front so the user sees it as "most
    // recent" without doubling up.
    const dupIdx = entries.findIndex(e => e.text === text);
    if (dupIdx >= 0) entries.splice(dupIdx, 1);
    entries.unshift({ text, ts: Date.now() });
    while (entries.length > maxEntries) entries.pop();
    for (const fn of subs) { try { fn(); } catch { /* ignore */ } }
  };

  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const run = Promise.resolve().then(async (): Promise<void> => {
      try { ingest(await dependencies.readClipboardText()); } catch { /* swallow */ }
      finally {
        inFlight = null;
        if (immediatePollAfterInFlight && !stopped) {
          immediatePollAfterInFlight = false;
          queuedActivityPoll = poll();
          void queuedActivityPoll;
        } else {
          immediatePollAfterInFlight = false;
          scheduleNext();
        }
      }
    });
    inFlight = run;
    return run;
  };

  const pollImmediately = (): void => {
    if (inFlight) {
      immediatePollAfterInFlight = true;
      return;
    }
    void poll();
  };

  const noteActivity = (): void => {
    const wokeFromIdle = idleMs() >= idleAfterMs;
    lastActivityAt = Date.now();
    wasBusy = readBusy();
    if (wokeFromIdle && active) {
      if (timer) clearTimeout(timer);
      timer = null;
      pollImmediately();
    }
  };

  const noteBusyChange = (): void => {
    const busy = readBusy();
    if (busy === wasBusy) return;
    wasBusy = busy;
    lastActivityAt = Date.now();
    if (!active) return;
    if (timer) clearTimeout(timer);
    timer = null;
    pollImmediately();
  };

  const setActive = (next: boolean, reason = 'unspecified'): void => {
    if (stopped || next === active) return;
    active = next;
    const observe = dependencies.observe
      ?? ((event: string, data: unknown) => { debug.log('clipboard.history', event, data); });
    try { observe('poll-state', { active, reason }); } catch { /* observation must not break polling */ }
    if (timer) clearTimeout(timer);
    timer = null;
    if (!active) {
      immediatePollAfterInFlight = false;
      return;
    }
    lastActivityAt = Date.now();
    wasBusy = readBusy();
    pollImmediately();
  };

  // Kick off immediately so the very first frame already has at
  // least one entry (whatever's currently on the clipboard).
  // A dormant poller (active:false) reads on its first setActive(true).
  if (active) void poll();

  return {
    entries,
    onChange: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    clear: () => { entries.length = 0; lastSeenText = null; },
    pokeNow: async () => {
      // Keep this request independent from noteActivity. If a wake poll is
      // already queued behind the current read, it will satisfy this poke.
      lastActivityAt = Date.now();
      wasBusy = readBusy();
      const currentRead = inFlight;
      const canUseQueuedWake = Boolean(currentRead && immediatePollAfterInFlight);
      if (timer) clearTimeout(timer);
      timer = null;
      if (currentRead) {
        await currentRead;
        if (canUseQueuedWake && queuedActivityPoll) {
          await queuedActivityPoll;
          return;
        }
        if (timer) clearTimeout(timer);
        timer = null;
      }
      // Reads already in progress may have captured the clipboard before
      // this promotion, so take a fresh snapshot after they finish.
      await poll();
    },
    noteActivity,
    noteBusyChange,
    setActive,
  };
}
