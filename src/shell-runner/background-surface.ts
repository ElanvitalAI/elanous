// ── BackgroundSurface (NT-B2) ──
//
// Surface adapter for ShellMode='bg'. The background surface has no
// dedicated view pane of its own — it surfaces summary data into
// two consumer locations (wired in NT-C):
//   • Status-bar pill(s)         (e.g. "bg:2 ⇣")
//   • `/shell list` slash output (rich table rows)
//
// Unlike InlineSurface, this adapter tracks *many* handles at once
// and emits a single aggregate `BgRollup` that the status-bar can
// render with one glance. Per-handle detail is available via
// `describe(id)` for the list slash.
//
// Relation to ShellRegistry: the registry is the authoritative store
// of handles + policy timers; this surface is a reactive projection
// tuned for display. It mirrors registry contents but also watches
// chunks to surface "last activity" timestamps the registry doesn't
// need to care about.

import type {
  OutputChunk,
  ShellHandle,
  ShellStatus,
  ShellSurface,
  Unsubscribe,
} from './types.js';
import type { TerminalExposureSnapshot } from '../terminal/posture.js';
import { classifyBackgroundTerminalExposure } from '../terminal/posture.js';

export interface BgEntry {
  /** Handle id. */
  id: string;
  status: ShellStatus;
  exposure: TerminalExposureSnapshot;
  /** ms since attach to this surface. */
  elapsedMs: number;
  /** Bytes pushed through this handle so far. */
  totalBytes: number;
  /** ms since the last chunk / status event. */
  idleMs: number;
  /** Free-form label — typically set from ShellRequest.description
   *  by the dispatcher that registered the handle. */
  label?: string;
}

export interface BgRollup {
  entries: BgEntry[];
  /** Count summaries for the status-bar pill. */
  running: number;
  backgrounded: number;
  finished: number;
  /** Total entries (running + backgrounded + finished). */
  total: number;
  /** TUI-BG-JOB-VISIBILITY (#71) — live handles that outlive the turn:
   *  `mode === 'bg'` handles still running ⊕ any handle flipped to
   *  'backgrounded'. Inline/foreground runs are excluded (they end with
   *  the turn and already show as `running`). Feeds the status-bar
   *  `⧗ 백그라운드 N` segment. */
  background: number;
}

export interface BackgroundSurfaceOpts {
  onUpdate?: (rollup: BgRollup) => void;
  now?: () => number;
  /** How long after a handle finishes we keep its entry visible
   *  (so users can still see "✓ exit=0" briefly before it falls
   *  off). Default 30_000ms. Set 0 for instant removal. */
  retainCompletedMs?: number;
  /** Scheduler override (parity with other adapters). */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (t: unknown) => void;
  };
}

export interface BackgroundSurface extends ShellSurface {
  /** Add another handle. attach() from ShellSurface (inherited
   *  signature) adds a single handle too — `track()` is a more
   *  descriptive alias for the common "add multiple over time" case. */
  track(handle: ShellHandle, label?: string): void;
  /** Stop mirroring a handle without killing it. */
  forget(id: string): void;
  /** Return the full detail row for a single handle, or null. */
  describe(id: string): BgEntry | null;
  /** Return current rollup without waiting for a change. */
  snapshot(): BgRollup;
}

interface TrackedRow {
  handle: ShellHandle;
  label?: string;
  started: number;
  totalBytes: number;
  lastActivity: number;
  status: ShellStatus;
  finished: boolean;
  disposeTimer: unknown;
  unsubs: Unsubscribe[];
}

export function createBackgroundSurface(
  opts: BackgroundSurfaceOpts = {},
): BackgroundSurface {
  const now = opts.now ?? Date.now;
  const onUpdate = opts.onUpdate;
  const retainMs = opts.retainCompletedMs ?? 30_000;
  const sched = opts.scheduler ?? {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };

  const rows = new Map<string, TrackedRow>();

  const emit = () => {
    const snap = buildRollup(rows, now);
    if (onUpdate) { try { onUpdate(snap); } catch { /* isolate */ } }
  };

  const armRetention = (row: TrackedRow) => {
    if (retainMs <= 0) {
      rows.delete(row.handle.id);
      return;
    }
    if (row.disposeTimer) sched.clearTimeout(row.disposeTimer);
    row.disposeTimer = sched.setTimeout(() => {
      rows.delete(row.handle.id);
      emit();
    }, retainMs);
  };

  const track = (handle: ShellHandle, label?: string) => {
    if (rows.has(handle.id)) return;
    const row: TrackedRow = {
      handle,
      label,
      started: now(),
      totalBytes: 0,
      lastActivity: now(),
      status: handle.status,
      finished: false,
      disposeTimer: null,
      unsubs: [],
    };
    rows.set(handle.id, row);
    row.unsubs.push(handle.onChunk((c: OutputChunk) => {
      row.totalBytes += Buffer.byteLength(c.bytes, 'utf8');
      row.lastActivity = now();
      emit();
    }));
    row.unsubs.push(handle.onStatus((s: ShellStatus) => {
      row.status = s;
      row.lastActivity = now();
      if (s === 'completed' || s === 'killed') {
        row.finished = true;
        armRetention(row);
      }
      emit();
    }));
    emit();
  };

  const forget = (id: string) => {
    const row = rows.get(id);
    if (!row) return;
    for (const u of row.unsubs) { try { u(); } catch { /* ignore */ } }
    if (row.disposeTimer) sched.clearTimeout(row.disposeTimer);
    rows.delete(id);
    emit();
  };

  return {
    kind: 'bg',
    attach(handle) { track(handle); },
    detach() {
      for (const row of rows.values()) {
        for (const u of row.unsubs) { try { u(); } catch { /* ignore */ } }
        if (row.disposeTimer) sched.clearTimeout(row.disposeTimer);
      }
      rows.clear();
    },
    track,
    forget,
    describe(id) {
      const row = rows.get(id);
      if (!row) return null;
      return entryOf(row, now);
    },
    snapshot() { return buildRollup(rows, now); },
  };
}

function entryOf(row: TrackedRow, now: () => number): BgEntry {
  const entry: BgEntry = {
    id: row.handle.id,
    status: row.status,
    exposure: classifyBackgroundTerminalExposure(row.status),
    elapsedMs: Math.max(0, now() - row.started),
    totalBytes: row.totalBytes,
    idleMs: Math.max(0, now() - row.lastActivity),
  };
  if (row.label) entry.label = row.label;
  return entry;
}

function buildRollup(
  rows: Map<string, TrackedRow>,
  now: () => number,
): BgRollup {
  let running = 0, backgrounded = 0, finished = 0, background = 0;
  const entries: BgEntry[] = [];
  for (const row of rows.values()) {
    entries.push(entryOf(row, now));
    if (row.status === 'running') {
      running++;
      if (row.handle.mode === 'bg') background++;
    } else if (row.status === 'backgrounded') {
      backgrounded++;
      background++;
    } else finished++;
  }
  return { entries, running, backgrounded, finished, total: entries.length, background };
}
