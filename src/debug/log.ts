// ── Debug log — runtime tracer for LLM calls + plugin dispatch ──
//
// This module centralizes runtime debug-event capture, enrichment, and delivery to configured sinks.
// A singleton ring-buffer-ish tracer that instrumented code paths
// (LLM adapters, plugin-host dispatchers, key routing, streaming)
// call into via `debug.log(category, event, data?)`.
//
// MSS M2.2 Phase A1 (2026-04-25) — the file/ring/mirror concerns were
// extracted into concrete `LogSink` classes under `src/mss/logging/sink.ts`;
// this file is now a thin façade that owns the four on/off gates
// (file/mirror/verbose/diag), payload compaction, the MSS enrichment
// path, and the singleton lifecycle. External code can register
// additional sinks (e.g. `StderrSink`) via `debug.registerSink(sink)`.
//
// Four INDEPENDENT gates:
//   - fileEnabled  — persist to `<cwd>/log/debug-<ts>.log` (project-
//                    local). Default ON (auto-capture from startup).
//                    Users disable via config.debug.file=false or
//                    `/debug file off`.
//   - mirrorEnabled — mirror each event into chatLines via mirrorHook.
//                     Default OFF (no chat spam at startup). Flip via
//                     `/debug mirror on` when you want live feed.
//   - verboseEnabled — full-detail payloads + high-volume call sites
//                      opt in (agent:tool-call, raw LLM bodies).
//                      Default OFF. `/debug verbose on`.
//   - diagEnabled  — OPEN the 122-site hot-path gate (`if (debug.enabled)
//                    debug.log(...)`) without turning on the mirror.
//                    Use case: diagnose a subsystem (drag QA, context
//                    menu routing, key dispatch) by capturing the full
//                    hot-path trail to file while keeping the chat
//                    pane quiet. Default OFF. `/debug diag` (file-only
//                    loud) or `/debug diag on|off` to control.
//                    Added 2026-04-22 — formalizes what the temp
//                    fc8d92e revert enabled ad-hoc.
//   - ringEnabled  — always ON when any sink is on; used by
//                     `/debug tail` to read the last N events from
//                     memory even if the file write failed.
//
// `enabled` getter = mirrorEnabled || verboseEnabled || diagEnabled
// (2026-04-20 + 2026-04-22 — was originally `fileEnabled ||
// mirrorEnabled`, which caused the default file-only forensic trail to
// fire all 122 `if (debug.enabled) debug.log` hot-path gates, flooding
// per-frame events into the log without user intent. The 2026-04-20
// narrowing to `mirror || verbose` fixed the flood but left no clean
// way to capture hot-path events to FILE without also streaming them
// into chat — which was needed for the drag QA diagnostic. The
// 2026-04-22 `diagEnabled` gate fills that gap as an explicit
// opt-in.) Critical low-frequency events (LLM requests, plugin
// lifecycle, errors) call `debug.log` unconditionally and still reach
// the file sink per `fileEnabled`, independent of every gate flag.
//
// File format: JSONL, one event per line. Filename includes the
// process start time (YYYYMMDDHHMMSS) so every invocation gets its
// own log — no append-across-sessions ambiguity when debugging a
// specific run.
//
// Secrets must be redacted by the caller before passing to debug.log
// — this module does not scrub beyond what `redactSecrets()` helper
// offers.

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'fs';
import { excludeProjectDotElanous } from '../instance/project-local-exclude.js';
import { formatClock } from '../time/format.js';
import { homedir } from 'os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { perf } from '../perf-counters.js';
import { getSessionCwd, getSessionProjectRoot } from '../session/working-dir.js';
import { getFlags } from '../mss/feature-flags.js';
import { getOrCreateElanousId } from '../mss/identity.js';
import { getParentSpanId, getSpanId, getTraceId } from '../mss/trace-context.js';
import {
  FileSink,
  MirrorSink,
  RingSink,
  type LogSink,
  type MirrorHook as MirrorHookType,
} from '../mss/logging/sink.js';
import { redactLogRecord } from '../mss/logging/redaction.js';
import { isRenderCategory } from '../mss/logging/render-categories.js';
import type { LogSource, LogLevel } from '../mss/logging/record.js';
import { cleanupLogDir } from '../mss/logging/retention.js';
import { createStderrSinkFromFlags } from '../mss/logging/sinks/stderr-sink.js';
import { createOtelGenAISinkFromFlags } from '../mss/logging/sinks/otel-genai-sink.js';

/** DebugEvent is the legacy shape. Pre-MSS callers only read/write
 *  `ts` / `category` / `event` / `data`. MSS M2.1 adds four optional
 *  fields that are silently attached when `MSS_ENABLED` is live —
 *  any consumer that ignores them sees the exact same JSONL shape as
 *  before (back-compat per PLAN §11.4). */
export interface DebugEvent {
  ts: string;        // ISO timestamp
  category: string;  // 'llm.request', 'plugin.slash', 'key.route', …
  event: string;     // short human-readable one-liner
  data?: unknown;    // optional structured payload
  // ── OH10 explicit severity channel (2026-07-24) ──
  // When set, `deriveLogLevel` returns it verbatim instead of guessing
  // from the category/event suffix. Most sites still omit it (suffix
  // derivation stays in place — PR-a is purely additive, zero-risk); the
  // suffix path is removed in PR-b once explicit levels are seeded.
  level?: LogLevel;
  // ── MSS M2.1 enrichment (optional, absent when MSS_ENABLED=false) ──
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  elanous_id?: string;
  // ── Session attribution (ambient — set by chat command at turn
  // start so every downstream event correlates to the session id the
  // user/LLM is conversing with). Lets `grep '"session_id":"abc"'`
  // pick out one chat session out of a multi-session log file.
  session_id?: string;
  // Ambient run attribution falls back here when `data` is not a plain
  // object, preserving primitive and non-plain payload identity.
  runId?: string;
  // ── SAM S0 seed — source block (platform disambiguation) ──
  source?: LogSource;
}

export type MirrorHook = MirrorHookType;

/** Debug verbosity knob — orders the cost/detail spectrum.
 *
 *   • off     — every sink gated shut. setKeyTracer snapshot skipped,
 *               no file I/O, no ring buffer, no mirror. Use this when
 *               you want zero debug overhead.
 *
 *   • trail   — file ON, compactForLog ON, mirror OFF, detail events
 *               OFF, diag OFF. Forensic log trail preserved for
 *               post-mortem, but high-volume per-call-site events
 *               (agent tool timelines, raw LLM bodies) and the 122
 *               `if (debug.enabled)` hot-path gates are skipped.
 *               Default. Intended to satisfy "debug off == fast"
 *               while still leaving a bug-report breadcrumb.
 *
 *   • diag    — file ON, diag ON, mirror OFF, verbose OFF. Opens
 *               the 122 hot-path gates so EVERY instrumented site
 *               reaches the file, but the chat pane stays quiet.
 *               Use when diagnosing a specific subsystem (drag,
 *               context-menu routing, key dispatch) from the log
 *               file without the noise of a live mirror. Added
 *               2026-04-22 — replaces the ad-hoc fc8d92e temp
 *               revert with a first-class mode.
 *
 *   • normal  — file ON, mirror ON. Hot-path gates fire (via
 *               mirror) so chat gets a live event feed.
 *               (Legacy level kept so existing /debug status and
 *               config readers continue to work.)
 *
 *   • detail  — file ON, compactForLog OFF (full raw payloads),
 *               mirror ON, detail-level call sites emit (agent:
 *               tool-call display events, tool-result bodies, full
 *               LLM request/response bodies). Explicit opt-in for
 *               deep debugging; writes tens of MB per skill run.
 *               Renamed from legacy `verbose` but that name is still
 *               accepted for back-compat.
 *
 *   • keytrace — DEEPEST level for keyboard/mouse dispatch analysis.
 *               Adds a per-key `key.trace.*` firehose that records
 *               every priority-key-route step + outcome, every modal /
 *               chord matcher result, every mouse hit-test target,
 *               every IME mirror translation, and every kitty `>3u`
 *               raw byte. file ON, diag ON (so existing voice.* /
 *               window.* / capture.* events also reach the file),
 *               mirror OFF (the firehose would flood chat). Use this
 *               when you can't tell why a key didn't fire / fired in
 *               the wrong surface / triggered the wrong chord.
 *               Orthogonal `setKeyTraceEnabled(on)` flag also exists
 *               so an existing `diag` or `detail` session can layer
 *               keytrace on top without losing its other gates.
 */
export type DebugLevel = 'off' | 'trail' | 'diag' | 'normal' | 'verbose' | 'detail' | 'keytrace';

/** The repository root is resolved from this module rather than the CLI entry
 *  so debug placement stays independent of CLI wiring. */
const ELANOUS_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Same relative-path containment test as harness-write-boundary. It stays local
 *  because that module imports this one for harness observations. */
function isWithinSourceRoot(target: string): boolean {
  const rel = relative(ELANOUS_SOURCE_ROOT, resolve(target));
  return rel === '' || (!(rel === '..' || rel.startsWith(`..${sep}`)) && !isAbsolute(rel));
}

/** Log directory stays next to Elanous source during development. External session
 *  projects instead use their existing `.elanous` directory, keeping internal logs
 *  out of the project root. Failed directory creation retains the home fallback.
 *  Both candidates are eagerly created so no manual mkdir step is required. */
function resolveLogDir(): string {
  const sessionCwd = getSessionCwd();
  const local = isWithinSourceRoot(sessionCwd)
    ? join(sessionCwd, 'log')
    : join(getSessionProjectRoot().path, '.elanous', 'debug');
  try {
    mkdirSync(local, { recursive: true });
    // 사용자 프로젝트면 `.elanous/` 를 그 저장소의 로컬 무시 목록에(UX 13 · 사용자 git status 를 더럽히지 않게).
    if (!isWithinSourceRoot(sessionCwd)) excludeProjectDotElanous(getSessionProjectRoot().path);
    return local;
  } catch { /* selected location unwritable — fall through */ }

  const fallback = join(homedir(), '.local', 'share', 'elanous', 'debug');
  try {
    mkdirSync(fallback, { recursive: true });
  } catch { /* both failed — log() later absorbs the write error */ }
  return fallback;
}
const LOG_DIR = resolveLogDir();

/** Debug log directory; source sessions use `<sessionCwd>/log`, others `.elanous/debug`. */
export function debugLogDir(): string { return LOG_DIR; }

/** ISO-ish timestamp without separators: `20260415034521`. Used as
 *  the per-run log-file suffix so every `elanous` invocation gets a
 *  dedicated file. Matches the user-requested yyyymmddhhmmss shape. */
function ymdhms(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Batched-write policy for the FileSink. Flushes on any of:
 *    • buffer ≥ FLUSH_BATCH_SIZE events (deferred via setImmediate)
 *    • FLUSH_INTERVAL_MS elapsed since last flush (sync on own tick)
 *    • process.beforeExit / SIGINT / clear() / setFileEnabled(false) (sync)
 *  Picked so a 100ms flush window = max 1 visible lag on /debug tail,
 *  and a 32-event batch handles burst writes (e.g. LLM streaming
 *  emits many chunks per tick) without growing the buffer unbounded.
 *  Trade-off: data loss window of 100ms on hard crash (SIGKILL).
 *  Acceptable since forensic use case tolerates a small tail loss. */
const FLUSH_INTERVAL_MS = 100;
const FLUSH_BATCH_SIZE  = 32;
/** Secondary overflow trigger — flush when pending bytes crosses this
 *  even if the 32-event count threshold hasn't been hit. Guards
 *  against a single large payload (LLM streaming chunk, rendered
 *  context snapshot) sitting in memory for a full 100ms flush window
 *  just because the event count is low. */
const FLUSH_BATCH_BYTES = 64 * 1024;
/** Size-based log rotation threshold. When the active log file
 *  crosses this, it's renamed to `<base>.1.log` and a fresh file is
 *  created at the original path. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** How many rotated files to keep. Oldest is unlinked on each
 *  rotation so the on-disk footprint is bounded at
 *  ~MAX_FILE_BYTES × (ROTATION_KEEP + 1). */
const ROTATION_KEEP = 3;

class DebugLog {
  // ── Gates (user-facing level semantics) ─────────────────────────

  // File capture — default ON so every run has a forensic trail the
  // user can `tail -f` from another terminal.
  private _fileEnabled = true;
  // Chat mirror — default OFF; opt-in via `/debug mirror on`.
  private _mirrorEnabled = false;
  // Verbose payloads — default OFF; gate on bulk-field capture at
  // call sites (e.g. raw LLM bodies) and on `compactForLog`.
  private _verboseEnabled = false;
  // Diag gate — default OFF; opens the hot-path gate without streaming
  // to chat. Added 2026-04-22.
  private _diagEnabled = false;
  // Key-trace gate — orthogonal to diag/detail. When ON, the
  // priority-key-route + mouse dispatch + IME mirror sites emit a
  // per-event `key.trace.*` firehose so a single dev run captures
  // every dispatch decision in order. Default OFF (high-volume).
  // Added 2026-04-30 in experiment/voice-chat-realtime-rebind.
  private _keyTraceEnabled = false;
  // Render-log mute (OH9 · 2026-07-24) — ORTHOGONAL to the level gates
  // above. When ON, render/input-frame categories (isRenderCategory)
  // are silenced across EVERY sink even while diag/keytrace stay open,
  // so the user can keep "진단 켜두고 렌더만 끈다". Seeded from
  // uiMode(essential→ON) / config.debug.renderLogs / level.json.render.
  // Default OFF here (boot wiring flips it) so a lib import doesn't mute.
  private _renderSuppressed = false;

  // ── Sinks (backing storage for the gates above) ─────────────────

  private readonly _fileSink: FileSink;
  /** Chat-only sibling. Mirrors the firehose into a separate file
   *  filtered by category prefix (`chat.*` / `llm.*`), so triaging a
   *  conversation no longer means grepping past input-core / mouse /
   *  focus-manager noise. Symlink lands at `log/latest_chat`. Same
   *  rotation + batching as the main sink — just a narrower category
   *  filter and a different symlink name. */
  private readonly _chatFileSink: FileSink;
  private readonly _ringSink = new RingSink(500);
  private readonly _mirrorSink = new MirrorSink(formatLine);
  private readonly _extraSinks: LogSink[] = [];
  private readonly _redactEnabled: boolean;

  constructor() {
    const ts = ymdhms();
    const filePath = join(LOG_DIR, `debug-${ts}.log`);
    this._fileSink = new FileSink({
      logDir: LOG_DIR,
      filePath,
      flushIntervalMs: FLUSH_INTERVAL_MS,
      flushBatchSize: FLUSH_BATCH_SIZE,
      flushBatchBytes: FLUSH_BATCH_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
      rotationKeep: ROTATION_KEEP,
      installExitHandlers: true,
    }, true);
    this._chatFileSink = new FileSink({
      logDir: LOG_DIR,
      filePath: join(LOG_DIR, `chat-${ts}.log`),
      flushIntervalMs: FLUSH_INTERVAL_MS,
      flushBatchSize: FLUSH_BATCH_SIZE,
      flushBatchBytes: FLUSH_BATCH_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
      rotationKeep: ROTATION_KEEP,
      installExitHandlers: true,
      categoryPattern: /^(chat|llm)\./,
      symlinkName: 'latest_chat',
    }, true);
    // MSS M2.3 — cache the redaction flag once so the hot path avoids
    // a `getFlags()` lookup per event. Opt-in, default false.
    let redact = false;
    try { redact = getFlags().redactLogs; } catch { /* ignore */ }
    this._redactEnabled = redact;
    // MSS M2.3 — age/size retention. Detached via setImmediate so the
    // fs scan never blocks process startup. Flag-off (both knobs 0) →
    // true zero cost: cleanupLogDir fast-returns before any fs call.
    this._scheduleRetention();
  }

  private _scheduleRetention(): void {
    let maxAgeDays = 0;
    let maxTotalMb = 0;
    try {
      const flags = getFlags();
      maxAgeDays = flags.logRetentionMaxAgeDays;
      maxTotalMb = flags.logRetentionMaxTotalMb;
    } catch { return; }
    if (maxAgeDays <= 0 && maxTotalMb <= 0) return;
    setImmediate(() => {
      try {
        cleanupLogDir(LOG_DIR, { maxAgeDays, maxTotalMb });
      } catch { /* startup must not block on fs errors */ }
    });
  }

  /** True when a "loud" tracing sink is live — mirror-to-chat,
   *  verbose/detail payload capture, explicit diag mode, or the
   *  keytrace firehose. Hot-path gates (`if (debug.enabled)
   *  debug.log(...)`) short-circuit when false so silent file capture
   *  (the default forensic-trail mode at startup) does NOT churn
   *  per-frame events into the log. */
  get enabled(): boolean {
    return this._mirrorEnabled || this._verboseEnabled || this._diagEnabled || this._keyTraceEnabled;
  }

  /** True when any sink is live (file OR mirror OR verbose OR diag OR keytrace). */
  isAnySinkEnabled(): boolean {
    return this._fileEnabled
      || this._mirrorEnabled
      || this._verboseEnabled
      || this._diagEnabled
      || this._keyTraceEnabled;
  }

  isFileEnabled(): boolean { return this._fileEnabled; }
  isMirrorEnabled(): boolean { return this._mirrorEnabled; }
  isVerboseEnabled(): boolean { return this._verboseEnabled; }
  /** Alias of isVerboseEnabled() under the new level naming. */
  isDetailEnabled(): boolean { return this._verboseEnabled; }
  isDiagEnabled(): boolean { return this._diagEnabled; }
  /** True when key.trace.* firehose is live. Hot path for input
   *  dispatch sites — call before building the snapshot to skip the
   *  allocation when off. */
  isKeyTraceEnabled(): boolean { return this._keyTraceEnabled; }

  level(): DebugLevel {
    // Precedence picks the most specific level for the current gate
    // set: keytrace > detail > normal > diag > trail > off. keytrace
    // wins when both keytrace and (diag|detail|normal) are on, since
    // the keyboard/mouse firehose is the most specific debugging
    // intent the user could have selected. The orthogonal flag also
    // works without a level — diag + setKeyTraceEnabled(true) reads
    // back as 'keytrace' here.
    if (!this.isAnySinkEnabled()) return 'off';
    if (this._keyTraceEnabled) return 'keytrace';
    if (this._verboseEnabled) return 'detail';
    if (this._mirrorEnabled) return 'normal';
    if (this._diagEnabled) return 'diag';
    return 'trail';
  }

  setLevel(level: DebugLevel): void {
    if (level === 'off') {
      this.setFileEnabled(false);
      this._mirrorEnabled = false;
      this._verboseEnabled = false;
      this._diagEnabled = false;
      this._keyTraceEnabled = false;
      return;
    }
    if (level === 'trail') {
      this.setFileEnabled(true);
      this._mirrorEnabled = false;
      this._verboseEnabled = false;
      this._diagEnabled = false;
      this._keyTraceEnabled = false;
      return;
    }
    if (level === 'diag') {
      this.setFileEnabled(true);
      this._mirrorEnabled = false;
      this._verboseEnabled = false;
      this._diagEnabled = true;
      this._keyTraceEnabled = false;
      return;
    }
    if (level === 'keytrace') {
      // file ON + diag ON (so existing voice.* / window.* / capture.*
      // events still reach the file) + key.trace.* firehose ON.
      // mirror OFF — the firehose is too loud for chat. detail OFF —
      // keytrace's intent is not to capture LLM bodies.
      this.setFileEnabled(true);
      this._mirrorEnabled = false;
      this._verboseEnabled = false;
      this._diagEnabled = true;
      this._keyTraceEnabled = true;
      return;
    }
    if (level === 'normal') {
      this.setFileEnabled(true);
      this._mirrorEnabled = true;
      this._verboseEnabled = false;
      this._diagEnabled = false;
      this._keyTraceEnabled = false;
      return;
    }
    // 'detail' (new) or legacy 'verbose' — max payloads + mirror.
    this.setFileEnabled(true);
    this._mirrorEnabled = true;
    this._verboseEnabled = true;
    this._diagEnabled = false;
    this._keyTraceEnabled = false;
  }

  /** OH9 — render-log mute. ORTHOGONAL to setLevel/setDiagEnabled: this
   *  flag never touches the four level gates, and `get enabled()` /
   *  `isAnySinkEnabled()` never read it. When true, `log()` drops render
   *  categories (isRenderCategory) before any sink — every other
   *  category (llm.*, goal.loop, error.*, …) flows unchanged. */
  setRenderSuppressed(on: boolean): void { this._renderSuppressed = on; }
  isRenderSuppressed(): boolean { return this._renderSuppressed; }

  setDiagEnabled(on: boolean): void { this._diagEnabled = on; }
  /** Toggle the key.trace.* firehose without disturbing other levels.
   *  Useful when an existing diag/detail session needs a temporary
   *  keyboard inspection window (e.g., reproducing a chord miss). */
  setKeyTraceEnabled(on: boolean): void { this._keyTraceEnabled = on; }

  /** @deprecated — use isMirrorEnabled(). */
  get mirror(): boolean { return this._mirrorEnabled; }

  /** Absolute path to this run's log file (one per invocation). */
  path(): string { return this._fileSink.path(); }

  /** Set (or clear) the hook that mirrors events into chatLines. */
  setMirrorHook(hook: MirrorHook | null): void {
    this._mirrorSink.setHook(hook);
  }

  /** Register an additional sink. Returns an unregister function so the
   *  caller (or a test) can remove it. Built-in file/ring/mirror sinks
   *  are not registered this way — they are owned by DebugLog directly
   *  and driven by the four gates above. */
  registerSink(sink: LogSink): () => void {
    this._extraSinks.push(sink);
    return () => {
      const idx = this._extraSinks.indexOf(sink);
      if (idx >= 0) this._extraSinks.splice(idx, 1);
    };
  }

  // Unified controls — historical API. "enable/disable" toggles the
  // mirror (the sink the user typically means when they type `/debug
  // on`), while file capture has its own getter/setter so config and
  // the `/debug file` sub-command can target it independently.
  enable(): void { this._mirrorEnabled = true; }
  disable(): void { this._mirrorEnabled = false; }
  toggle(): boolean { this._mirrorEnabled = !this._mirrorEnabled; return this._mirrorEnabled; }
  setMirror(on: boolean): void { this._mirrorEnabled = on; }

  /** Turn the file sink on or off. When switched off mid-session the
   *  ring buffer still captures events in-memory for /debug tail.
   *  Flushes any buffered writes before flipping off so no tail is
   *  lost at the moment of disable. */
  setFileEnabled(on: boolean): void {
    this._fileEnabled = on;
    this._fileSink.setEnabled(on);
    this._chatFileSink.setEnabled(on);
  }
  setVerboseEnabled(on: boolean): void { this._verboseEnabled = on; }

  /** Drop every event from the ring buffer AND truncate the file. */
  clear(): void {
    this._ringSink.clear();
    this._fileSink.clear();
    this._chatFileSink.clear();
  }

  /** Last N events from the ring buffer, formatted as human lines. */
  tail(n: number = 50): string[] {
    return this._ringSink.events(n).map(formatLine);
  }

  /** Last N structured events from the ring buffer, oldest first. */
  events(n: number = 50): DebugEvent[] {
    return this._ringSink.events(n).map(ev => ({
      ...ev,
      ...(ev.data !== undefined ? { data: ev.data } : {}),
    }));
  }

  status(): {
    file: boolean;
    mirror: boolean;
    verbose: boolean;
    diag: boolean;
    renderSuppressed: boolean;
    level: DebugLevel;
    path: string;
    buffered: number;
    bytesWritten: number;
  } {
    return {
      file: this._fileEnabled,
      mirror: this._mirrorEnabled,
      verbose: this._verboseEnabled,
      diag: this._diagEnabled,
      renderSuppressed: this._renderSuppressed,
      level: this.level(),
      path: this._fileSink.path(),
      buffered: this._ringSink.length,
      bytesWritten: this._fileSink.bytesWritten(),
    };
  }

  /** Bytes appended to the active log file this session. */
  bytesWritten(): number { return this._fileSink.bytesWritten(); }

  /** Read the entire log file. Falls back to the ring buffer when the
   *  file doesn't exist or file-sink is off. */
  readFile(): string {
    const disk = this._fileSink.readFile();
    if (disk.length > 0) return disk;
    return this._ringSink.events().map(formatLine).join('\n');
  }

  /** Force any buffered events to disk immediately. */
  flush(): void {
    this._fileSink.flush();
    this._chatFileSink.flush();
    for (const sink of this._extraSinks) {
      try { sink.flush?.(); } catch { /* swallow */ }
    }
  }

  /** Override the rotation threshold (bytes). */
  setMaxFileBytes(bytes: number): void { this._fileSink.setMaxFileBytes(bytes); }

  /** The core tracer. No-op when every gate is off.
   *  `opts.level` (OH10) explicitly stamps severity — critical-junction
   *  emitters pass it so `elanous logs --level …` doesn't rely on suffix
   *  guessing. Omitting it keeps the legacy derive-from-suffix path. */
  log(
    category: string,
    event: string,
    data?: unknown,
    opts?: { level?: LogLevel; compact?: CompactOpts },
  ): void {
    if (!this.isAnySinkEnabled()) return;
    // OH9 — render-log mute (orthogonal to the level gates). Single
    // short-circuit here covers all sinks (file/chatFile/ring/mirror/
    // extra) so `elanous logs`, log/debug-*.log and log/chat-*.log are
    // cleaned in lock-step. Non-render categories are unaffected — diag
    // stays fully alive.
    if (this._renderSuppressed && isRenderCategory(category)) return;
    perf.bumpDebugCall(category);
    const payload = data === undefined
      ? undefined
      : this._verboseEnabled
        ? data
        : compactForLog(data, opts?.compact);
    let rec: DebugEvent = {
      ts: new Date().toISOString(),
      category,
      event,
      ...(payload !== undefined ? { data: payload } : {}),
      ...(opts?.level ? { level: opts.level } : {}),
    };
    // MSS M2.1 enrichment — append trace/elanous context when live.
    enrichDebugRecord(rec);
    // MSS M2.3 sink-level redaction — runs once per event before any
    // sink sees it, so file/ring/mirror/extra observe the same
    // scrubbed payload. Opt-in flag cached at ctor (no per-event cost
    // when off).
    if (this._redactEnabled) rec = redactLogRecord(rec) as DebugEvent;

    // Ring buffer — always populated when at least one sink is live so
    // `/debug tail` shows activity even when the file write failed.
    this._ringSink.emit(rec);

    // File append — the sink owns batching + rotation.
    if (this._fileEnabled) {
      this._fileSink.emit(rec);
      // Chat-only mirror (#5). FileSink filters internally by
      // `categoryPattern`, so non-chat events fast-return before any
      // I/O. Same `_fileEnabled` gate as the main sink — `/debug off`
      // silences both.
      this._chatFileSink.emit(rec);
    }

    // Chat mirror — only when mirror gate is open.
    if (this._mirrorEnabled) this._mirrorSink.emit(rec);

    // External sinks registered via `registerSink`. Each runs inside
    // its own try/catch as defense-in-depth — a throwing sink must
    // not block downstream sinks.
    for (const sink of this._extraSinks) {
      try { sink.emit(rec); } catch { /* swallow */ }
    }
  }

  /** Convenience: start a timer for a scoped event — caller invokes
   *  the returned `done(result?)` at the end. Emits `<category>.start`
   *  and `<category>.done` with duration ms. */
  timed(category: string, event: string, data?: unknown): (result?: unknown) => void {
    if (!this.enabled) return () => {};
    const startedAt = Date.now();
    this.log(category + '.start', event, data);
    return (result?: unknown) => {
      this.log(category + '.done', event, {
        durationMs: Date.now() - startedAt,
        ...(result !== undefined ? { result } : {}),
      });
    };
  }
}

// ── Ambient session_id ───────────────────────────────────────────────
// Process-wide tag for the conversation currently being driven. CLI
// commands (`elanous chat` / `elanous ask`) set this at turn start; the
// dashboard sets it on session switch. enrichDebugRecord picks it up
// so every event in the same turn carries `session_id`, letting one
// log file hold many sessions while still being grep-separable
// (`grep '"session_id":"abc12345"' log/latest`).
let ambientSessionId: string | null = null;
const ambientSessionStorage = new AsyncLocalStorage<string>();

export function setAmbientSessionId(id: string | null): void {
  ambientSessionId = id || null;
}

/**
 * Run a callback with a session identifier isolated to its async execution context.
 *
 * ⭐⭐⭐ 스코프가 **갈아탈 때 그 관계를 남긴다** (`session.link/child-scope`).
 *
 * ⛔ 왜 필요한가 (실측 2026-08-02 · 원장 `MEAS-S14`): 채팅 턴은 채팅 세션 스코프 안에서 도는데,
 * 그 안에서 하위 런타임(grounding · goal-loop · ACP)이 **자기 세션으로 다시 감싼다**. 그러면
 * 그 뒤의 모든 로그(`capability.resolve/tool-selected` 포함)가 **자식 세션**으로 찍히고,
 * ***부모 세션으로 조회하면 그 턴의 툴이 사라진다.*** NL 코퍼스가 위임 턴을 전부 `no-fire` 로
 * 읽은 것이 이것이다 — 능력이 아니라 **조인이 끊긴 것**을 쟀다.
 *
 * ⇒ 관계를 **부모 스코프에서** 한 줄 남긴다. 행의 `session_id` 는 부모가 되고 payload 가 자식을 가리키므로
 * `--session <부모>` 조회에 **반드시 걸린다**(자식을 찾아 두 번째 조회를 할 수 있다).
 * ⚠️ 세션 값을 **바꾸지 않는다** — 기존 소비자는 무손상이고, 없던 **간선**만 생긴다.
 */
export function withAmbientSessionScope<T>(sessionId: string, fn: () => T): T {
  const parent = getAmbientSessionId();
  // ⛔ 부모가 없거나 같은 세션이면 간선이 아니다(자기 자신을 가리키는 링크를 만들지 않는다).
  if (parent && parent !== sessionId) {
    // ⚠️ **부모 스코프에서** 찍는다 — 새 스코프 안에서 찍으면 그 행마저 자식으로 귀속돼
    //    부모 조회에 안 걸리고, 이 수리가 고치려는 바로 그 결함을 반복한다.
    debug.log('session.link', 'child-scope', { parentSessionId: parent, childSessionId: sessionId });
  }
  return ambientSessionStorage.run(sessionId, fn);
}

export function getAmbientSessionId(): string | null {
  return ambientSessionStorage.getStore() ?? ambientSessionId;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Append MSS context fields (trace_id / span_id / parent_span_id /
 *  elanous_id) onto an existing DebugEvent. No-op when `MSS_ENABLED=false`
 *  so the legacy JSONL shape is byte-identical to pre-MSS output. */
function enrichDebugRecord(rec: DebugEvent): void {
  try {
    // Session correlation is a logs.db query contract, not MSS telemetry:
    // retain it even when the optional MSS trace enrichment is disabled.
    const sessionId = getAmbientSessionId();
    if (sessionId) rec.session_id = sessionId;
    // logs.db joins plain-object payloads through data.runId. Preserve payload
    // identity for primitives and non-plain objects by attributing their record.
    const runId = process.env.ELANOUS_RUN_ID;
    if (runId) {
      if (rec.data === undefined) {
        rec.runId = runId;
      } else if (isPlainObject(rec.data)) {
        if (!Object.hasOwn(rec.data, 'runId')) rec.data = { ...rec.data, runId };
      } else {
        rec.runId = runId;
      }
    }
    // 실행 칸·벤치 팔 귀속(RFC fleet 슈퍼바이저 §A1 · 2026-09-25) — Pod·벤치 팔만 env 를 세운다.
    //   env 가 없으면 아무것도 안 붙인다(평소 로그 모양 바이트 동일) · 호출자가 준 값이 이긴다 · plain object 만.
    const substrate = process.env.ELANOUS_SUBSTRATE;
    const armId = process.env.ELANOUS_ARM_ID;
    const hostId = process.env.ELANOUS_HOST_ID;
    if ((substrate || armId || hostId) && isPlainObject(rec.data)) {
      const data: Record<string, unknown> = rec.data;
      rec.data = {
        ...data,
        ...(substrate && !Object.hasOwn(data, 'substrate') ? { substrate } : {}),
        ...(armId && !Object.hasOwn(data, 'armId') ? { armId } : {}),
        ...(hostId && !Object.hasOwn(data, 'hostId') ? { hostId } : {}),
      };
    }
    const flags = getFlags();
    if (!flags.enabled) return;
    const tid = getTraceId();
    if (tid) rec.trace_id = tid;
    const sid = getSpanId();
    if (sid) rec.span_id = sid;
    const psid = getParentSpanId();
    if (psid) rec.parent_span_id = psid;
    try {
      rec.elanous_id = getOrCreateElanousId();
    } catch { /* identity write failed — leave elanous_id unset */ }
    // SAM S0 seed — multi-platform disambiguation. Caller-supplied
    // source values win; we only fill `platform` when it's absent.
    const platform = process.platform;
    if (platform) {
      rec.source = rec.source
        ? { ...rec.source, platform: rec.source.platform ?? platform }
        : { platform };
    }
  } catch {
    // Any unexpected error in enrichment must never break logging —
    // logging is a forensic safety net and silent failures defeat that.
  }
}

/**
 * Take at most `limit` UTF-16 code units without splitting a surrogate pair.
 * `fromEnd` selects a suffix instead of the default prefix.
 */
function safeStringSlice(value: string, limit: number, fromEnd = false): string {
  const slice = fromEnd ? value.slice(-limit) : value.slice(0, limit);
  if (!slice) return slice;

  if (!fromEnd && /[\uD800-\uDBFF]$/.test(slice)) return slice.slice(0, -1);
  if (fromEnd && /^[\uDC00-\uDFFF]/.test(slice)) return slice.slice(1);
  return slice;
}

/** Format a single event as a compact one-line string. Long payloads
 *  get truncated at ~400 chars so the chat mirror doesn't flood the
 *  log pane on a big LLM response. */
export function formatLine(ev: DebugEvent): string {
  const time = formatClock(ev.ts, { millis: true }); // 사용자 시간대 HH:MM:SS.mmm
  const head = `[${time}] [${ev.category}] ${ev.event}`;
  if (ev.data === undefined) return head;
  let payload: string;
  try { payload = JSON.stringify(ev.data); } catch { payload = String(ev.data); }
  if (payload.length > 400) payload = safeStringSlice(payload, 397) + '…';
  return `${head}  ${payload}`;
}

// ── Payload compaction ──
//
// A singleton tracer means we see EVERY hot-path event, including LLM
// request bodies that embed the entire system prompt + tool schemas
// (tens of KB per event). A 1000-event file becomes 20MB of noise,
// making grep / manual reading useless. `compactForLog` runs as a
// pre-serialization pass inside `debug.log` to keep structure but
// elide bulk:
//
//   • Strings longer than stringMax → first stringMax chars + a
//     tail marker `«+Nc»` showing how many chars were dropped.
//   • Arrays longer than arrayMax → first arrayMax entries + a
//     trailing `{"_more": N}` marker at the same nesting level.
//   • Depth past maxDepth → `{"_compact_depth_exceeded": true}`
//     so the caller knows something was there without its bulk.
//   • Circular references → `"_circular"` sentinel.
//
// Defaults are tuned for LLM request bodies: 256 char / 6 array /
// depth 4. Callers that need the raw payload pass explicit limits,
// or temporarily bypass via a preflight raw-JSON.stringify.

export interface CompactOpts {
  stringMax?: number;
  arrayMax?: number;
  maxDepth?: number;
}

// ⛔⭐⭐ `arrayMax` 를 6 → 200 으로 올렸다 (2026-08-25 · 🅕 측정 · 🅣 유보 철회).
//
// 📏 왜 6 이 문제였나 — 7일 표본 20,000행 실측:
//    · 절단된 관측 51건에서 ***1202개***가 사라졌다
//    · 「상한에 닿은」 관측 중 ***48.1%***가 데이터를 잃었다(드문 사고가 아니다)
//    · 잃은 것 중엔 `self-implement/importerTestsNotRun` — ***게이트 자신의 관측***도 있었다
//
// 📏 왜 200 이 안전한가 — 비용을 «두 손잡이로 갈라» 쟀다:
//    · arrayMax  6 → ∞  =  ***+0.51%***   (0.050 MB / 9.75 MB)
//    · stringMax 256 → ∞ =  +3.81%        ⇒ ***「로그 폭증」은 «문자열» 이야기였다***
//    ⇒ 이 파일 머리말의 *"LLM request bodies … system prompt + tool schemas"* 는
//      `stringMax` 의 근거지 `arrayMax` 의 근거가 아니다. 둘이 한 문단에 있어 «같이» 무서웠다.
//
// ⛔⭐ 그리고 ***∞ 가 아니라 «큰 유한값»***이다(🅣 권고) —
//    ***무한은 다음 사람이 절단을 «잴 수» 있는 자를 없앤다.*** 200 은 관측된 최대 실제 길이(56)의
//    약 3.5배라 현행 페이로드는 다 담기면서, 폭주하는 배열은 여전히 `{_more:N}` 으로 «말한다».
//
// ⚠️ ⛔ 이 값을 올려도 ***위층 캡은 남는다*** — 호출부가 먼저 자르면 여기선 안 잘린다
//    (예: `importer-test-index.ts` 의 20 · `fold-stack.ts` 의 8). 그때는 ***호출부가***
//    「진짜 몇 개인가」를 «안 잘리는 스칼라»로 같이 내야 한다(`rework-policy.ts:51~54` 가 그 본).
// 📄 근거 = 내부 문서 `FINDING-the-observation-channel-truncates-arrays-at-six-and-1202-items-vanished-2026-08-25`
//        ⊕ 내부 문서 `FINDING-the-log-explosion-fear-belongs-to-stringmax-not-arraymax-2026-08-25`
const DEFAULT_COMPACT: Required<CompactOpts> = {
  stringMax: 256,
  arrayMax: 200,
  maxDepth: 4,
};

/** Compact a log payload in-place-safe (returns a new structure). */
export function compactForLog<T>(data: T, opts: CompactOpts = {}): T {
  const limits = { ...DEFAULT_COMPACT, ...opts };
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'string') {
      const s = v as string;
      if (s.length <= limits.stringMax) return s;
      const prefix = safeStringSlice(s, limits.stringMax);
      return prefix + `«+${s.length - prefix.length}c»`;
    }
    if (t === 'number' || t === 'boolean' || t === 'bigint') return v;
    if (t === 'function' || t === 'symbol') return `<${t}>`;
    // object / array from here
    if (depth >= limits.maxDepth) {
      if (Array.isArray(v)) return { _compact_depth_exceeded: true, _len: v.length };
      return { _compact_depth_exceeded: true };
    }
    if (seen.has(v as object)) return '<circular>';
    seen.add(v as object);
    if (Array.isArray(v)) {
      if (v.length <= limits.arrayMax) return v.map(x => walk(x, depth + 1));
      const head = v.slice(0, limits.arrayMax).map(x => walk(x, depth + 1));
      return [...head, { _more: v.length - limits.arrayMax }];
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val, depth + 1);
    }
    return out;
  };
  return walk(data, 0) as T;
}

/**
 * ⭐ **텍스트 축 비밀 마스킹** (2026-07-27) — `redactSecrets` 는 **객체 키**(`authorization` 등)를 가린다.
 * 그런데 비밀은 **값 안의 자유 텍스트**로도 들어온다 — 대표적으로 **LLM 출력**(리뷰 지적·요약)이
 * 원문 diff 의 토큰을 그대로 인용하는 경우다. 키 축만으로는 그게 통과한다.
 *
 * ⚠️ **재발명 금지 조사 결과**(2026-07-27 · omni-crawl):
 *   · npm 의 `fast-redact`/`slow-redact`/`deep-redact`/`redact-secrets` 는 전부 **객체 경로** redaction —
 *     "필드를 아는" 경우용이라 자유 텍스트에 안 맞는다.
 *   · 자유 텍스트 탐지의 성숙한 자산은 **gitleaks**(MIT·27.7k★)인데 **외부 Go 바이너리**라
 *     로그 1줄마다 셸아웃할 수 없다(in-process 필요).
 *   ⇒ **런타임이 아니라 규칙(지식)을 재사용**한다 — 아래 패턴은 gitleaks 기본 config(MIT)의
 *     해당 rule 정규식을 **그대로 이식**했다. 출처를 rule id 로 남겨 상류 갱신 시 대조 가능하게 한다.
 *     https://github.com/gitleaks/gitleaks `config/gitleaks.toml`
 *
 * ⚠️ **한계 정직 표기**: 완전한 비밀 탐지는 원리적으로 불가능하다(일반 문자열과 구분 불가).
 * 이건 **최선의 방어**이지 보장이 아니며, 근본 방어는 애초에 **원문을 길게 싣지 않는 것**이다.
 */
/** 규칙 = gitleaks 기본 config(MIT)의 rule 정규식 이식. `re` 의 **그룹1이 식별 접두**이고 나머지가
 *  비밀 본문이다(그룹이 없으면 전체를 가린다). 접두를 남기는 이유 = "무엇이 샜나"는 읽혀야 한다. */
const SECRET_TEXT_RULES: readonly { readonly id: string; readonly re: RegExp; readonly to: string }[] = [
  // gitleaks: private-key — 블록 전체를 가린다(접두 보존 없음).
  { id: 'private-key', re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/gi, to: '<private-key redacted>' },
  { id: 'anthropic-api-key', re: /\b(sk-ant-(?:api|admin)[0-9]{0,2}-)[A-Za-z0-9_-]{8,}/g, to: '$1***' },
  { id: 'openai-api-key-scoped', re: /\b(sk-(?:proj|svcacct|admin)-)[A-Za-z0-9_-]{8,}/g, to: '$1***' },
  { id: 'openrouter-api-key', re: /\b(sk-or-v1-)[A-Za-z0-9]{16,}/g, to: '$1***' },
  { id: 'openai-api-key', re: /\b(sk-)[A-Za-z0-9]{16,}/g, to: '$1***' },
  { id: 'xai-api-key', re: /\b(xai-)[A-Za-z0-9]{20,}/g, to: '$1***' },
  { id: 'github-fine-grained-pat', re: /\b(github_pat_)\w{20,}/g, to: '$1***' },
  { id: 'github-token', re: /\b((?:ghp|gho|ghu|ghs|ghr)_)[0-9a-zA-Z]{20,}/g, to: '$1***' },
  { id: 'aws-access-token', re: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA))[A-Z2-7]{16}\b/g, to: '$1***' },
  { id: 'slack-token', re: /\b(xox[abprs]-)[0-9A-Za-z-]{10,}/g, to: '$1***' },
  { id: 'gcp-api-key', re: /\b(AIza)[0-9A-Za-z_-]{35}\b/g, to: '$1***' },
  { id: 'jwt', re: /\b(ey)[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9._\\/-]{10,}/g, to: '$1***' },
  // gitleaks: generic-api-key 축소판 — `key = value` 형태.
  { id: 'generic-api-key', re: /\b(api[_-]?key|secret|password|passwd|token|credential)\b(\s*[:=]\s*)["']?[^\s"',;)]{4,}/gi, to: '$1$2***' },
  // 환경변수 형태 `OPENROUTER_API_KEY=…` — 위 규칙은 `_API_KEY` 앞에 단어 경계가 없어 못 잡는다. 값에 글자가 있어야 한다(`MAX_TOKEN=4096` 은 그대로).
  { id: 'env-secret', re: /\b([A-Z][A-Z0-9]*_(?:[A-Z0-9]+_)*(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY))(\s*[:=]\s*)["']?(?=[^\s"',;)]*[A-Za-z])[^\s"',;)]{8,}/g, to: '$1$2***' },
  // Authorization 헤더(로그에서 흔하다).
  { id: 'authorization-header', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, to: '$1 ***' },
];

/**
 * 자유 텍스트에서 알려진 비밀 패턴을 가린다(순수). **식별 접두는 남기고 본문만** 가려
 * "무엇이 샜나"는 읽히되 값은 복원 불가하게 한다.
 * ⚠️ `redactSecrets` 의 문자열 값에도 적용된다(키 축 ⊕ 텍스트 축).
 */
export function redactSecretText(input: string): string {
  let out = String(input ?? '');
  for (const { re, to } of SECRET_TEXT_RULES) {
    re.lastIndex = 0;              // g 플래그 재사용 안전(순서 의존 제거)
    out = out.replace(re, to);
  }
  return out;
}

/** Redact common secret fields from a payload. Used by callers
 *  before handing objects to debug.log — we never want
 *  `Authorization: Bearer sk-...` written to disk.
 *  ⭐ 2026-07-27 — **문자열 값에는 텍스트 축(`redactSecretText`)도 적용**한다(키 축만으론 값 안의
 *  토큰이 통과한다). 비-문자열·구조는 종전과 동일. */
export function redactSecrets<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj;
  const copy: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (
      keyLower === 'authorization'
      || keyLower === 'api-key' || keyLower === 'apikey'
      || keyLower === 'x-api-key'
      || keyLower === 'openai-api-key'
      || keyLower === 'cookie'
      || keyLower === 'access_token' || keyLower === 'accesstoken'
      || keyLower === 'refresh_token' || keyLower === 'refreshtoken'
    ) {
      copy[k] = typeof v === 'string' && v.length > 12
        ? safeStringSlice(v, 4) + '…' + safeStringSlice(v, 4, true)
        : '<redacted>';
    } else if (typeof v === 'object' && v !== null) {
      copy[k] = redactSecrets(v);
    } else if (typeof v === 'string') {
      copy[k] = redactSecretText(v);   // ⭐ 텍스트 축 — 값 안의 토큰도 가린다
    } else {
      copy[k] = v;
    }
  }
  return copy as T;
}

/** The singleton. Import as `debug` from this module. */
export const debug = new DebugLog();

// MSS M2.2 Phase A2 — opt-in stderr mirror. Default off, so this is a
// no-op unless `MSS_STDERR_SINK=1` is set in the environment. Kept as
// the only "extra sink" wire point baked into the debug module; future
// sinks should register themselves from their consuming subsystem
// rather than being listed here, so this stays small.
try {
  const stderrSink = createStderrSinkFromFlags(getFlags());
  if (stderrSink) debug.registerSink(stderrSink);
} catch { /* flag-parse failure must not block the rest of the tracer */ }

// PLAN §4.6 / Arc 2.2 — opt-in OTel GenAI sink. Default off; wire only
// when `MSS_OTEL_ENDPOINT` is set so a missing collector is silent.
try {
  const otelSink = createOtelGenAISinkFromFlags(getFlags());
  if (otelSink) debug.registerSink(otelSink);
} catch { /* flag-parse / sink-init failure must not block the tracer */ }
