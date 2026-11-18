// M6 PR 1 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) — debug.log
// → `debug.line` envelope bridge.
//
// Mirrors low-frequency daemon `debug.log(category, event, data?)` events
// onto the carrier-agnostic Feedback Envelope wire so PWA chat `/chat?debug-
// tap=on` can render a live tail (off-canvas drawer in M6 PR 2). The bridge
// transposes the M5 PR 2 grep emit pattern onto the debug tracer:
//
//   debug.log(...) ──► DebugBridgeSink ──► category filter
//                  └─► ring buffer (cap 200)
//                  └─► activate gate
//                     └─► makeEnvelope(kind: 'debug.line') ──► opts.emit
//
// Activate gate semantics (mirror gate default OFF — matches `/debug
// mirror` legacy):
//   activate()   : subsequent matching events ALSO emit envelopes.
//   deactivate() : events still hit the ring (for in-memory audit)
//                  but stop emitting.
//   dispose()    : unregister sink + drop ring. Idempotent.
//
// Hot-path gates: only low-frequency call sites (LLM requests, plugin
// lifecycle, errors) call `debug.log` unconditionally — those reach this
// sink. The 122 `if (debug.enabled) debug.log(...)` hot-path sites only
// flow when `debug.enabled` is true (mirror|verbose|diag|keytrace). Users
// who want the full firehose flip `/debug diag on` alongside `?debug-
// tap=on`. M6 doc §8 records this trade-off.
//
// Session scoping (CONTEXT-OWNER-ISOLATION-AUDIT H-1 · 2026-11-18): the sink sees every
// `debug.log` in the daemon, so it keeps a line only when the producer stamped it with THIS
// bridge's session — `rec.session_id` (set by `enrichDebugRecord` from the async scope
// `withAmbientSessionScope`, opened per turn in `run-core-turn.ts`) AND the live async scope
// both equal `opts.sessionId`. Other sessions, missing ids and the process-wide REPL fallback
// are dropped before the ring and counted. Child-scope lines (grounding · goal-loop) are not
// carried — read them with `elanous logs --session <child>`.
// Size, measured on the sent wire frame: each line ≤ DEBUG_LINE_MAX_BYTES, the bridge's lifetime
// (one turn = one response) ≤ DEBUG_RESPONSE_MAX_BYTES including the single overflow marker,
// after which nothing more is sent.

import type { AcpAudience } from '../acp/transport/types.js';
import { debug, getScopedAmbientSessionId } from '../debug/log.js';
import type { LogRecord } from '../mss/logging/record.js';
import type { LogSink } from '../mss/logging/sink.js';
import { formatElanousFeedbackEnvelope } from '../acp/elanous-extensions.js';
import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
} from './envelope.js';

/** Whitelist of debug categories mirrored onto the wire when the gate
 *  is open. Tunable per bridge instance; the default matches the
 *  user-relevant subsystems (chat turns, tool dispatch, agent state)
 *  while excluding hot-path noise (input.*, window.*, key.trace.*,
 *  mss.*) AND the bridge's own re-entrant categories.
 *
 *  **Critical exclusion** — `acp.*` is deliberately omitted because
 *  emitting an envelope triggers `acp.broadcast.fanout` debug.log
 *  events, which the bridge would re-capture → emit another envelope
 *  → another `acp.broadcast.fanout` → infinite feedback loop. A single
 *  user-driven debug emission was observed to balloon to ~46k
 *  fanouts/sec on iOS dogfood (2026-05-14), saturating the ACP WS
 *  socket and aborting the LLM turn 30s in.
 *
 *  If `acp.session.*` (less noisy ACP sub-category) becomes useful,
 *  add it as an opt-in via the per-bridge `categoryFilter` override
 *  rather than re-enabling the whole `acp.` prefix. */
export const DEFAULT_DEBUG_CATEGORY_FILTER = /^(chat|tool|agent)\./;

export const DEFAULT_DEBUG_RING_CAP = 200;

/** Provisional (no measured source yet · MOB-1 measures): 2 KiB per sent line frame — `debug.log` compacts
 *  strings to 256 chars, so ordinary producer lines (`llm.ts` previews) stay whole. */
const DEBUG_LINE_MAX_BYTES = 2048;
/** Provisional: 256 KiB of sent frames per turn, marker included = 4 × the 64 KiB `PWA_TOOL_RESULT_MAX_BYTES`. */
const DEBUG_RESPONSE_MAX_BYTES = 262144;

const DEBUG_AUDIENCES = new Map<string, AcpAudience>([['operator', 'operator'], ['member', 'member']]);

/** Fail-closed audience read: only the exact strings 'operator' / 'member'; anything else is 'unknown'. */
export function normalizeDebugAudience(raw: unknown): AcpAudience {
  return typeof raw === 'string' ? DEBUG_AUDIENCES.get(raw) ?? 'unknown' : 'unknown';
}

/** ACP twin of SSE `?debug-tap=on`: `_meta.elanous.debugTap === true` (own keys only). */
export function readDebugTapRequest(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || !Object.hasOwn(meta, 'elanous')) return false;
  const elanous = (meta as Record<string, unknown>).elanous;
  if (!elanous || typeof elanous !== 'object' || !Object.hasOwn(elanous, 'debugTap')) return false;
  return (elanous as Record<string, unknown>).debugTap === true;
}

/** The debug envelope reaches a response only when explicitly requested AND the caller is an operator. */
export function debugEnvelopeAllowed(audience: unknown, requested: boolean): boolean {
  return requested === true && normalizeDebugAudience(audience) === 'operator';
}

export interface DebugLineEntry {
  category: string;
  event: string;
  data?: unknown;
  /** ms epoch parsed from `debug.log`'s ISO timestamp. */
  loggedAt: number;
}

export interface DebugBridgeOpts {
  /** Wire writer — typically `dualEmitFeedback` from meta-api's
   *  handlePromptStreamPost. Called synchronously; errors swallow so
   *  a misbehaving consumer can't break debug logging. */
  emit: (env: FeedbackEnvelope) => void;
  sessionId: string;
  /** Override the default whitelist. Set to `/^.*$/` to mirror every
   *  category (combine with `/debug diag on` for full firehose). */
  categoryFilter?: RegExp;
  /** Override the default 200-entry in-memory ring. Floored at 1. */
  ringBufferCap?: number;
  /** Injected for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface DebugBridge {
  /** Open the mirror gate. Idempotent. */
  activate(): void;
  /** Close the mirror gate. Idempotent. Events keep landing in the
   *  ring buffer; only envelope emit stops. */
  deactivate(): void;
  /** True iff the gate is currently open. */
  isActive(): boolean;
  /** Snapshot copy of the in-memory ring (oldest first). */
  getRing(): readonly DebugLineEntry[];
  /** Unregister sink + clear ring. After dispose, all methods are no-ops. */
  dispose(): void;
}

/** Stable session-level merge key — every `debug.line` envelope in a
 *  given session carries this blockId so the PWA accumulator collapses
 *  the entire daemon trace into a single `debug_session` block (drawer
 *  feeds off that one block's `lines` ring). */
export function makeDebugSessionBlockId(sessionId: string): string {
  return `${sessionId}:debug:session`;
}

export function createDebugBridge(opts: DebugBridgeOpts): DebugBridge {
  const filter = opts.categoryFilter ?? DEFAULT_DEBUG_CATEGORY_FILTER;
  const ringCap = Math.max(1, opts.ringBufferCap ?? DEFAULT_DEBUG_RING_CAP);
  const now = opts.now ?? ((): number => Date.now());
  const seqTracker = createSeqTracker();
  const blockId = makeDebugSessionBlockId(opts.sessionId);

  let activated = false;
  let disposed = false;
  const ring: DebugLineEntry[] = [];
  const counts = { otherSession: 0, missingSession: 0, truncated: 0, oversize: 0, overCap: 0 };
  let sentBytes = 0;
  let capped = false;

  // Size is measured on the wire: the ACP text frame (`formatElanousFeedbackEnvelope`) — the larger
  // of the two carriers (SSE writes the bare envelope JSON) — of the envelope exactly as sent.
  const wireBytes = (env: FeedbackEnvelope): number =>
    Buffer.byteLength(formatElanousFeedbackEnvelope({ method: 'emit', payload: env }));
  // Built against a fixed seq so a dropped candidate never burns a seq (clients detect seq gaps).
  const build = (entry: DebugLineEntry, seq: number): FeedbackEnvelope | null => {
    try {
      return makeEnvelope({
        kind: 'debug.line', sessionId: opts.sessionId, blockId, phase: 'delta',
        payload: {
          category: entry.category,
          event: entry.event,
          ...(entry.data !== undefined ? { data: entry.data } : {}),
          loggedAt: entry.loggedAt,
        },
        asciiFallback: [renderAscii(entry)],
        now,
      }, { next: () => seq, peek: () => seq - 1, forget() {}, clear() {} });
    } catch {
      return null;
    }
  };
  /** Whole wire frame ≤ DEBUG_LINE_MAX_BYTES: else `data` becomes a truncation marker with a shrinking
   *  preview; if even an empty preview does not fit (huge event name), the line is dropped and counted. */
  const fitLine = (entry: DebugLineEntry, seq: number): FeedbackEnvelope | null => {
    const env = build(entry, seq);
    if (env && wireBytes(env) <= DEBUG_LINE_MAX_BYTES) return env;
    const json = safeJson(entry.data);
    const originalBytes = Buffer.byteLength(json);
    for (const n of [600, 300, 150, 75, 37, 18, 9, 4, 0]) {
      const cut = build({ ...entry, data: { truncated: true, originalBytes, preview: json.slice(0, n) } }, seq);
      if (cut && wireBytes(cut) <= DEBUG_LINE_MAX_BYTES) { counts.truncated += 1; return cut; }
    }
    counts.oversize += 1;
    return null;
  };
  const capMarker = (sent: number): DebugLineEntry => ({
    category: 'debug.bridge', event: 'response-cap-reached',
    data: { capBytes: DEBUG_RESPONSE_MAX_BYTES, sentBytes: sent }, loggedAt: now(),
  });
  const send = (env: FeedbackEnvelope): void => {
    seqTracker.next(blockId);
    sentBytes += wireBytes(env);
    try {
      opts.emit(env);
    } catch {
      /* wire glue swallows — bridge must not break the LLM stream. */
    }
  };

  const sink: LogSink = {
    name: `feedback-debug-bridge:${opts.sessionId}`,
    emit(rec: LogRecord): void {
      if (disposed) return;
      if (typeof rec.category !== 'string') return;
      if (!filter.test(rec.category)) return;
      const lineSession = (rec as { session_id?: unknown }).session_id;
      if (typeof lineSession !== 'string' || !lineSession) { counts.missingSession += 1; return; }
      if (!opts.sessionId || lineSession !== opts.sessionId || getScopedAmbientSessionId() !== opts.sessionId) {
        counts.otherSession += 1;
        return;
      }
      const entry: DebugLineEntry = {
        category: rec.category,
        event: rec.event,
        ...(rec.data !== undefined ? { data: rec.data } : {}),
        loggedAt: parseLogTs(rec.ts),
      };
      ring.push(entry);
      if (ring.length > ringCap) ring.splice(0, ring.length - ringCap);
      if (!activated) return;
      // After the first overflow: the one marker is already out — every later line is dropped.
      if (capped) { counts.overCap += 1; return; }
      const seq = seqTracker.peek(blockId) + 1;
      const env = fitLine(entry, seq);
      if (!env) return;
      // Reserve room for the marker (its largest form: sentBytes at the cap) so the marker fits too.
      const reserve = ((m) => (m ? wireBytes(m) : 0))(build(capMarker(DEBUG_RESPONSE_MAX_BYTES), seq));
      if (sentBytes + wireBytes(env) + reserve > DEBUG_RESPONSE_MAX_BYTES) {
        capped = true;
        counts.overCap += 1;
        const marker = build(capMarker(sentBytes), seq);
        if (marker) send(marker);
        return;
      }
      send(env);
    },
  };

  const unregister = debug.registerSink(sink);

  return {
    activate() {
      if (disposed) return;
      activated = true;
    },
    deactivate() {
      activated = false;
    },
    isActive() {
      return activated && !disposed;
    },
    getRing() {
      return ring.slice();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activated = false;
      // Never silent: dropped/truncated lines leave one counter row (`feedback.*` is outside the filter).
      if (counts.otherSession + counts.missingSession + counts.truncated + counts.oversize + counts.overCap > 0) {
        debug.log('feedback.debug-bridge', 'line-filter-summary', { sessionId: opts.sessionId, ...counts }, { level: 'info' });
      }
      ring.length = 0;
      try {
        unregister();
      } catch {
        /* swallow — already removed */
      }
      seqTracker.clear();
    },
  };
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
}

function parseLogTs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Date.now();
}

/** Pre-rendered ASCII fallback for dumb renderers (TUI · iOS text · CLI
 *  dump). Format mirrors `src/debug/log.ts:formatLine` minus the colour
 *  codes — `[HH:MM:SS.mmm] [category] event  payload`. */
function renderAscii(entry: DebugLineEntry): string {
  const time = new Date(entry.loggedAt).toISOString().slice(11, 23);
  const head = `[${time}] [${entry.category}] ${entry.event}`;
  if (entry.data === undefined) return head;
  let payload: string;
  try {
    payload = JSON.stringify(entry.data);
  } catch {
    payload = String(entry.data);
  }
  if (payload.length > 200) payload = payload.slice(0, 197) + '…';
  return `${head}  ${payload}`;
}
