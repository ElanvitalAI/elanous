// ── Capture substrate · frame → episodic self-memory (PLAN P5 · §5) ──
//
// Turn captured screen frames into low-signal observations. PLAN §5/§9: summarize the frame into a
// short line + store POINTERS in refs (surfaceId · instance · frameAt ·
// pngRef) — never the full-frame blob (surface_events has no BLOB column).
//
// The pipeline is three decoupled, testable pieces:
//   1. summarizeFrame(text, surfaceId) — pure heuristic (tool-calls +
//      salient line). NO LLM in the hot path (frames are high-frequency).
//   2. createFrameMemoryConsumer({record}) — debounce + dedup so we log
//      SALIENT changes, not one event per frame. Emits a SelfEventInput.
//   3. startFrameMemoryPoller — daemon-side: poll the pty-manifest for
//      framed tui/pty surfaces (cross-process · dashboard TUI + forwarded
//      children), summarize, and recordSelfEvent into surface_events.signals.
//
// cf. producer `tui-self-report.ts` · store `domains/surface-events.ts` ·
// recall `domains/self-awareness.ts` (recallSelfEvents).

import { debug } from '../debug/log.js';
import { listPtyManifest, type PtyManifestRow } from '../pty-shell/pty-manifest.js';
import type { SelfEventInput } from '../domains/self-awareness.js';

/** ANSI + box-drawing/pipe scrubber so the summary/FTS text is readable
 *  (the frame is a full grid with borders). */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const BOX_EDGE_RE = /[│┃|]/g;
const BOX_RE = /[┌┐└┘─━┄┅┈┉╭╮╯╰═║╔╗╚╝├┤┬┴┼╠╣╦╩╬▏▕]/g;

function cleanLine(l: string): string {
  return l.replace(ANSI_RE, '').replace(BOX_EDGE_RE, ' ').replace(BOX_RE, '').replace(/\s+/g, ' ').trim();
}

export interface FrameSummary {
  readonly summary: string;
  readonly kind: string;
}

/** ⭐PLAN §5 — pure heuristic summary of a rendered screen. Pulls recent
 *  tool-call markers (`⏺ Tool(…)`) + the last salient content line, prefixed
 *  by the surfaceId. Deterministic (no LLM) so it's cheap + unit-testable. */
export function summarizeFrame(text: string, surfaceId: string): FrameSummary {
  const content = text.split('\n').map(cleanLine).filter((l) => l.length > 0);
  const tools: string[] = [];
  for (const l of content) {
    const m = /⏺\s*([A-Za-z][\w-]*\([^)]*\))/.exec(l);
    if (m && m[1]) tools.push(m[1]);
  }
  const salient = content.length ? content[content.length - 1]! : '(empty screen)';
  // Assemble "<tools> · <salient>" under a 220-char cap, but PRIORITIZE the
  // salient line (current activity = recall relevance): if it doesn't all
  // fit, trim the tool-call prefix, never truncate the salient tail (review).
  const prefix = `${surfaceId}: `;
  const cap = 220;
  const toolsText = tools.length ? tools.slice(-3).join(' ') : '';
  const includeTools = toolsText && !salient.includes(toolsText);
  let body: string;
  const full = includeTools ? `${toolsText} · ${salient}` : salient;
  if ((prefix + full).length <= cap) {
    body = full;
  } else {
    const room = cap - prefix.length - salient.length - (includeTools ? 3 : 0);
    const trimmedTools = includeTools && room > 0 ? toolsText.slice(0, room) : '';
    body = trimmedTools ? `${trimmedTools} · ${salient}` : salient.slice(0, cap - prefix.length);
  }
  return { summary: (prefix + body).slice(0, cap), kind: 'frame' };
}

/** A normalized observation — decoupled from SelfReportFrame vs manifest row. */
export interface FrameObservation {
  readonly surfaceId: string;
  readonly instance: string;
  readonly text: string;
  readonly frameAt: number;
  readonly pngRef?: string;
}

export interface FrameMemoryConsumerOpts {
  /** Sink for a salient event (e.g. recordSelfEvent bound to a db). */
  readonly record: (input: SelfEventInput) => void;
  /** Minimum gap (ms) between recorded events for the SAME surface — rate
   *  limits rapid change bursts. Default 5s. */
  readonly minGapMs?: number;
  /** Clock (ms). Default Date.now. */
  readonly now?: () => number;
}

export interface FrameMemoryConsumer {
  /** Fold one observation. Records (and returns the event) only when it's
   *  SALIENT: the summary changed vs the last recorded for this surface AND
   *  at least minGapMs elapsed. Otherwise returns null (dedup / rate-limit). */
  observe(obs: FrameObservation): SelfEventInput | null;
}

/** Composite per-surface key — instance-scoped (recycled PIDs across
 *  instances mustn't collide). */
const OBS_KEY_SEP = '\u0000'; // NUL separator (escape → source stays text, not binary)
function obsKey(o: FrameObservation): string { return `${o.instance}${OBS_KEY_SEP}${o.surfaceId}`; }

export function createFrameMemoryConsumer(opts: FrameMemoryConsumerOpts): FrameMemoryConsumer {
  const minGapMs = opts.minGapMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const last = new Map<string, { at: number; summary: string }>();
  return {
    observe(obs: FrameObservation): SelfEventInput | null {
      const { summary, kind } = summarizeFrame(obs.text, obs.surfaceId);
      const key = obsKey(obs);
      const prev = last.get(key);
      const t = now();
      // Dedup unchanged screens; rate-limit rapid changes per surface.
      if (prev && (summary === prev.summary || t - prev.at < minGapMs)) return null;
      last.set(key, { at: t, summary });
      const input: SelfEventInput = {
        tool: 'tui-observe',
        kind,
        summary,
        importance: 4, // ambient observation — below deliberate impl/change (7)
        refs: {
          surfaceId: obs.surfaceId,
          instance: obs.instance,
          frameAt: obs.frameAt,
          ...(obs.pngRef ? { pngRef: obs.pngRef } : {}),
        },
      };
      opts.record(input);
      return input;
    },
  };
}

export interface FrameMemoryPollerDeps {
  /** recordSelfEvent bound to an open surface_events db. Required. */
  readonly record: (input: SelfEventInput) => void;
  readonly listManifest?: () => PtyManifestRow[];
  readonly intervalMs?: number;
  readonly minGapMs?: number;
  readonly now?: () => number;
  readonly setIntervalFn?: (fn: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (h: unknown) => void;
}

/** One poll pass — summarize any live tui/pty frame into memory (salient
 *  only, via the consumer's dedup/rate-limit). Exported for tests. Returns
 *  the number of events recorded this pass. */
export function pollFrameMemory(consumer: FrameMemoryConsumer, deps: Pick<FrameMemoryPollerDeps, 'listManifest'>): number {
  const listManifest = deps.listManifest ?? listPtyManifest;
  let rows: PtyManifestRow[];
  try { rows = listManifest(); } catch { return 0; }
  let recorded = 0;
  for (const row of rows) {
    if (!row.alive || !row.frame || row.frameAt <= 0) continue;
    if (row.kind !== 'tui' && row.kind !== 'pty') continue; // same allowlist as the broadcaster
    const ev = consumer.observe({ surfaceId: row.id, instance: row.instance, text: row.frame, frameAt: row.frameAt });
    if (ev) recorded += 1;
  }
  return recorded;
}

/** Start the daemon-side frame→memory poller. Reads the shared pty-manifest
 *  for framed surfaces (cross-process) and records salient screen changes
 *  into surface_events (dedup/rate-limited). Returns a stop thunk. No-op
 *  (returns a no-op stop) when disabled via `ELANOUS_TUI_FRAME_MEMORY=0`.
 *
 *  Isolation is STRUCTURAL, not by instance filtering: the pty-manifest and
 *  the surface_events db the caller binds `record` to are BOTH scoped to the
 *  same `ELANOUS_STATE_DIR`, so every framed row this poller sees already
 *  belongs to this scope's memory. `refs.instance` preserves per-surface
 *  provenance (prod vs test:… vs a worktree sharing the dir). A hard
 *  current-instance filter is deliberately avoided — it would drop forwarded
 *  self-implement children spawned by a differently-named process sharing
 *  the same state dir (the very surfaces P3 exists to observe). */
export function startFrameMemoryPoller(deps: FrameMemoryPollerDeps): () => void {
  if (process.env.ELANOUS_TUI_FRAME_MEMORY === '0') {
    if (debug.enabled) debug.log('capture.frame-memory', 'disabled', { reason: 'killswitch' });
    return () => {};
  }
  const intervalMs = deps.intervalMs ?? 5_000;
  const setIntervalFn: (fn: () => void, ms: number) => unknown = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn: (h: unknown) => void =
    deps.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const consumerDeps: FrameMemoryConsumerOpts = { record: deps.record };
  if (deps.minGapMs !== undefined) (consumerDeps as { minGapMs?: number }).minGapMs = deps.minGapMs;
  if (deps.now) (consumerDeps as { now?: () => number }).now = deps.now;
  const consumer = createFrameMemoryConsumer(consumerDeps);
  let inFlight = false;
  const handle = setIntervalFn(() => {
    if (inFlight) return;
    inFlight = true;
    try {
      const n = pollFrameMemory(consumer, deps.listManifest ? { listManifest: deps.listManifest } : {});
      if (n > 0 && debug.enabled) debug.log('capture.frame-memory', 'recorded', { count: n });
    } catch { /* fail-soft */ } finally { inFlight = false; }
  }, intervalMs);
  (handle as { unref?: () => void }).unref?.();
  if (debug.enabled) debug.log('capture.frame-memory', 'started', { intervalMs });
  return () => { clearIntervalFn(handle); if (debug.enabled) debug.log('capture.frame-memory', 'stopped', {}); };
}
