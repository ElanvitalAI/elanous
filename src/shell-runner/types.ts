// ── ShellRunner — unified 4-mode shell execution types (NT track) ──
//
// Session nt. PLAN-session-nt + LESSONS-native-terminal-preflight.
//
// ShellRequest → CaptureEngine (File | Pty) → ShellHandle (stream +
// boundary + kill + bg) → ShellSurface (inline | bg | modal | vw) →
// ShellResult. The four surface modes share a single execution core
// and differ only in how they render / route user input.
//
// Why a new module rather than extending shell-primitive? That module
// is purposely scoped to one-shot argv for internal callers (skill
// routers, diagnostics) — it has no notion of PTY, long-lived
// handles, user-visible surfaces, or VW placement. ShellRunner is
// the outer layer that also wraps shell-primitive when mode='inline'
// + non-interactive + short-lived. The two types intentionally stay
// separate; shell-runner may delegate to shell-primitive internally
// for the file-capture path.
//
// Invariants:
//   • One ShellHandle = one running command. Not one PTY. The PTY
//     may host many sequential commands (VW runner); each command
//     spawns its own handle bound to a BufferMark.
//   • Surface swap never re-spawns the process.
//   • Boundary is multi-strategy (exit → OSC 133 → quiet-idle →
//     timeout). The first to fire wins; the others are ignored.
//   • focusPolicy='output-only' (vw default): the pane never steals
//     focus, but three interrupt chords (Ctrl+C / Ctrl+D / Ctrl+\)
//     are still forwarded to the running command regardless.

import type { GlobalTerminalId } from '../terminal-matrix/types.js';

// ── Request ────────────────────────────────────────────────────────

/** How the command is surfaced to the user + captured for the LLM. */
export type ShellMode =
  /** Runner engine picks based on req (interactive?, VW available?).
   *  Default resolution in session nt: interactive OR default → 'vw'. */
  | 'auto'
  /** Chat-log inline one-liner + collapsible detail. File engine.
   *  Legacy Bash-tool compatible. Auto-promotes to 'bg' past
   *  `backgroundAfterMs`. Not user-visible as a terminal surface. */
  | 'inline'
  /** Status-bar pill + ShellRegistry entry only. No dedicated view.
   *  File engine. User can `/shell list` / `/shell attach <id>`. */
  | 'bg'
  /** Centered interactive modal. PTY engine. User focus is stolen
   *  while open (legacy /term spawn behavior). Transient TTL
   *  configurable; default interactive=true. */
  | 'modal'
  /** Runner VW pane (label='runner' by default). PTY engine.
   *  focusPolicy='output-only' by default. This is the session-nt
   *  target default mode. */
  | 'vw';

/** Pane focus behavior for mode='vw'. */
export type FocusPolicy =
  /** Never joins Alt+N / ^B Tab focus rotation. User sees output
   *  but keystrokes do not route to the pane. Three interrupt chords
   *  (see INTERRUPT_CHORDS) are an exception and still forward. */
  | 'output-only'
  /** Full keyboard interaction when focused. Equivalent to a normal
   *  terminal pane. User must manually `^B <n>` / click to focus. */
  | 'interactive';

/** Multi-strategy boundary detection policy. */
export interface BoundaryPolicy {
  /** Use child-process exit code as end-of-command. Always on. */
  readonly exit: true;
  /** Use OSC 133;B sentinel. PTY engine only (requires rc injection).
   *  Default true for PTY, ignored for File engine. */
  readonly osc133?: boolean;
  /** Declare end if no output chunk arrives within this window, after
   *  the child has been running at least `quietGraceMs`. PTY fallback
   *  when OSC 133 rc injection fails. Default 1500 ms. Set null to
   *  disable. */
  readonly quietIdleMs?: number | null;
  /** Hard wall-clock cap. SIGTERM on breach, SIGKILL after
   *  `sigkillAfterMs`. Default per-mode (see DEFAULT_TIMEOUTS). */
  readonly timeoutMs?: number;
}

export interface VwPlacementHint {
  /** Reuse the VW with this label (`^B R` user-rename friendly), or
   *  create a fresh one. Default 'runner'. */
  windowLabel?: string;
  /** Bypass label lookup and target an exact VW. */
  windowId?: string;
  /** Slot inside the VW. Default 'main'. */
  slotId?: string;
  /** Default 'output-only' for mode='vw'. */
  focusPolicy?: FocusPolicy;
}

export interface ShellRequest {
  /** Command. String → `<loginShell> -lc "<cmd>"`. Array → direct
   *  argv (no shell, no quoting surprises). Prefer array for
   *  machine-generated commands; string for user-visible shell one-
   *  liners that depend on expansion / pipes. */
  command: string | readonly string[];
  /** Working directory. Defaults to getSessionCwd() at run time. */
  cwd?: string;
  /** Merged over process.env for the child. */
  env?: Record<string, string>;
  /** Optional data fed to child stdin before the boundary wait. */
  stdin?: string;

  /** Surface + engine mode. See ShellMode. Default 'vw'. */
  mode?: ShellMode;
  /** Does the user / LLM need to write to the command after it
   *  starts? Default false. When true: PTY engine forced; mode
   *  'inline' becomes invalid (auto-upgraded to 'vw'). */
  interactive?: boolean;
  /** VW placement hint (mode='vw' only). */
  vw?: VwPlacementHint;

  /** Limits. */
  timeoutMs?: number;         // default per-mode
  quietIdleMs?: number | null; // default 1500
  /** Head+tail trunc cap on stdout/stderr returned in ShellResult. */
  maxOutputBytes?: number;    // default 262_144 (256 KiB)
  /** If a foreground (inline/modal) command runs longer than this,
   *  the runner auto-flips it to 'bg' and returns a
   *  { backgroundTaskId } result. Default 15_000 (claude-code). Set
   *  null / Infinity to disable. */
  backgroundAfterMs?: number | null;

  /** Sandbox policy. Passed through to shell-primitive when engine
   *  delegates; PTY engine forwards to node-pty wrapper when the
   *  platform sandbox is available. */
  sandbox?: 'off' | 'auto' | 'strict';
  /** Free-form label shown in logs + UI (one-liner headline). */
  description?: string;
  /** Caller-supplied cancellation. */
  signal?: AbortSignal;
}

// ── Handle ─────────────────────────────────────────────────────────

export type ShellStatus = 'running' | 'backgrounded' | 'completed' | 'killed';

/** One chunk of output, before LLM-safe rendering. */
export interface OutputChunk {
  stream: 'stdout' | 'stderr' | 'pty';
  bytes: string;
  ts: number;
}

/** Fired when a boundary strategy decides this command ended. */
export interface BoundaryEvent {
  kind: 'prompt-start' | 'cmd-end';
  exitCode?: number;
  source: 'exit' | 'osc-133' | 'quiet' | 'timeout';
  at: number;
}

/** Opaque position marker into a PTY terminal buffer. File engine
 *  returns a no-op mark (all fields zero). */
export interface BufferMark {
  row: number;
  col: number;
  ts: number;
  bytes: number;
}

export type Unsubscribe = () => void;

export interface PromoteOpts {
  vw?: VwPlacementHint;
  modalId?: string;
}

export interface ShellHandle {
  readonly id: string;
  readonly mode: Exclude<ShellMode, 'auto'>;
  readonly status: ShellStatus;
  /** Underlying matrix terminal when the engine is PTY-backed.
   *  File engine → undefined. */
  readonly terminalId?: GlobalTerminalId;
  /** Mark captured immediately before the command was injected.
   *  Always present for PTY; all-zero for File. */
  readonly bookmark: BufferMark;

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  /** Flip surface to 'bg'; keeps running. Idempotent. Returns false
   *  if the command is already finished. */
  background(): boolean;
  /** Migrate surface at runtime. Engine does not change. */
  promote(to: 'modal' | 'vw' | 'inline', opts?: PromoteOpts): boolean;
  /** Send bytes to the child (PTY engine only; no-op + warn on File). */
  write(bytes: string): void;
  /** Resize the PTY (PTY engine only). */
  resize(cols: number, rows: number): void;

  onChunk(cb: (c: OutputChunk) => void): Unsubscribe;
  onBoundary(cb: (ev: BoundaryEvent) => void): Unsubscribe;
  onStatus(cb: (s: ShellStatus) => void): Unsubscribe;

  /** Resolves on boundary (or immediately if already done). */
  readonly result: Promise<ShellResult>;
}

// ── Result ─────────────────────────────────────────────────────────

export interface StreamOutput {
  text: string;
  /** When the underlying stream exceeded `maxOutputBytes`, this is
   *  the byte offset at which we cut (head preserved, tail may have
   *  been preserved separately — see `tail`). */
  truncatedAfterBytes?: number;
  /** Optional tail-half retained after head was capped. */
  tail?: string;
}

export interface ShellResult {
  exitCode?: number;
  /** Failure detail captured at the execution boundary (for example,
   *  the original spawn error). Kept separate from outcome so callers
   *  can explain why no process exit status exists. */
  failureReason?: string;
  stdout: StreamOutput;
  stderr: StreamOutput;
  /** Merged (interleaved) stream in spawn order. For File engine
   *  this is reconstructed from per-chunk timestamps; for PTY it's
   *  the rendered buffer slice from `bookmark` to end. */
  aggregated: StreamOutput;
  durationMs: number;
  timedOut: boolean;
  interrupted: boolean;
  truncated: boolean;
  /** Taxonomy aligned with shell-primitive ShellResult.outcome. */
  outcome: 'exit' | 'timeout' | 'aborted' | 'denied' | 'spawn-error';
  /** Present when the handle was flipped to 'bg' and the caller
   *  should poll ShellRegistry.get(backgroundTaskId) for completion. */
  backgroundTaskId?: string;
  /** Set by File engine when output was spilled to disk (>8 MiB). */
  outputFilePath?: string;
  /** PTY engine — the bookmark used for the slice. Echoes
   *  handle.bookmark so the LLM can request a re-slice later. */
  bookmarkId?: string;
}

// ── Capture engines ───────────────────────────────────────────────

export interface RunCtx {
  /** Session working dir resolver (WD track). */
  getCwd(): string;
  /** Invoked once the handle settles. */
  onSettled?: (result: ShellResult) => void;
  /** Audit / telemetry hook. */
  onEvent?: (ev: { kind: string; at: number; payload?: unknown }) => void;
}

export interface CaptureEngine {
  readonly kind: 'file' | 'pty';
  run(req: ShellRequest, ctx: RunCtx): ShellHandle;
}

// ── Surface ────────────────────────────────────────────────────────

export interface ShellSurface {
  readonly kind: 'inline' | 'bg' | 'modal' | 'vw';
  attach(handle: ShellHandle): void;
  detach(): void;
  /**
   * PR-1 of multi-platform substrate ROADMAP — return the current
   * posture snapshot for the attached handle.
   *
   * Returns null when:
   *   - no handle is attached
   *   - the surface kind has no user-facing posture concept (inline)
   *
   * Per G7 (no stale posture): callers should treat this as a
   * lazy lookup. Surfaces should compute fresh posture on each call,
   * never cache. The `ShellRegistry.describePosture` proxy relies on
   * this freshness contract.
   */
  posture?(): import('../terminal/posture.js').TerminalExposureSnapshot | null;
  /**
   * Subscribe to posture transitions on the attached handle.
   *
   * Surface fires the callback after internal state changes that affect
   * exposure (status transitions · focusPolicy flip · attach · detach).
   * Per G7 the callback should NOT fire on chunk events that don't move
   * the posture diff — surface-side filtering is preferred over
   * registry-side debouncing.
   */
  onPostureChanged?(
    cb: (next: import('../terminal/posture.js').TerminalExposureSnapshot | null) => void,
  ): () => void;
}

// ── Registry ───────────────────────────────────────────────────────

export interface ShellListFilter {
  status?: ShellStatus;
  mode?: Exclude<ShellMode, 'auto'>;
  /** N3 — include settled (completed/killed) handles even after the
   *  SETTLED_TTL elapsed. Defaults to false: default `list()` hides
   *  long-finished handles so `/shell list` and the rollup popup stay
   *  focused on what's actionable. Debug paths + `/shell list all`
   *  opt in. */
  includeSettled?: boolean;
}

/** B-10-α (Phase P7-γ) — multi-subscriber event bus. Emitted whenever
 *  a handle is registered or unregistered. Independent of the
 *  single-callback `onRegister`/`onUnregister` policy hooks in
 *  `ShellRegistryOpts` (those stay for SP-B BackgroundSurface wiring);
 *  this bus supports N consumers so downstream bridges (SurfaceRegistry
 *  mirror, skill-runner telemetry, test spies) can coexist. */
export type ShellRegistryEvent =
  | { readonly kind: 'register'; readonly handle: ShellHandle }
  | { readonly kind: 'unregister'; readonly id: string };

export type ShellRegistrySubscriber = (event: ShellRegistryEvent) => void;

/**
 * PR-1 of multi-platform substrate ROADMAP — emitted whenever a handle's
 * posture transitions. Per G7 (no stale posture) registry diffs the
 * surface-fired posture against the last seen value and only emits when
 * `exposure` actually changed.
 */
export interface ShellPostureEvent {
  readonly kind: 'posture-changed';
  readonly shellId: string;
  readonly prev: import('../terminal/posture.js').TerminalExposureSnapshot | null;
  readonly next: import('../terminal/posture.js').TerminalExposureSnapshot | null;
}

export type ShellPostureSubscriber = (event: ShellPostureEvent) => void;

export interface ShellRegistry {
  register(handle: ShellHandle): void;
  unregister(id: string): void;
  get(id: string): ShellHandle | null;
  list(filter?: ShellListFilter): ShellHandle[];
  /** Locate a vw-hosted runner by VW label (defaults to 'runner'). */
  findVwRunner(label?: string): ShellHandle | null;
  /** SP-C — reverse lookup used by `/shell attach <id>`. Returns the
   *  VW label associated with a handle id (set via tagVwRunner), or
   *  null when the handle isn't bound to a VW surface. */
  getVwLabel(id: string): string | null;
  /** B-10-α — observe register/unregister events. Returns unsubscribe.
   *  Subscribers are called in insertion order; a throw in one does not
   *  stop the others (isolated). */
  subscribe(cb: ShellRegistrySubscriber): Unsubscribe;
  /**
   * PR-1 — attach a surface adapter so registry can lazy-proxy posture
   * lookups. Multiple surfaces may attach to the same handle (e.g. vw
   * + bg snapshot mirror); the first non-null `posture()` wins.
   *
   * If the surface implements `onPostureChanged`, registry forwards
   * those transitions through `subscribePosture` callbacks (with
   * exposure-level diffing per G7).
   *
   * Returns unsubscribe. Calling the unsubscribe also fires a final
   * posture-changed event (next = recomputed without this surface).
   */
  attachSurface(id: string, surface: ShellSurface): Unsubscribe;
  /**
   * PR-1 — current posture for a handle. Lazy proxy, never cached.
   *
   * Resolution order:
   *   1. attached surfaces (first non-null `posture()` wins)
   *   2. mode='bg' fallback: classify from handle.status
   *      (BackgroundSurface tracks bg handles centrally, no per-handle
   *      attach. The fallback keeps describePosture honest for bg.)
   *   3. mode='inline' or unknown: null (no user-facing surface)
   */
  describePosture(id: string): import('../terminal/posture.js').TerminalExposureSnapshot | null;
  /**
   * PR-1 — enumerate handles + their current posture in one call.
   * Honors the same filter as `list()`. posture is null for handles
   * with no attached surface and a mode that has no fallback (inline).
   */
  listWithPosture(filter?: ShellListFilter): Array<{
    readonly handle: ShellHandle;
    readonly posture: import('../terminal/posture.js').TerminalExposureSnapshot | null;
  }>;
  /**
   * PR-1 — subscribe to posture transitions across all handles.
   *
   * Per G7: registry diffs prev/next at exposure level and fires only
   * on real change. Surface chunk events that don't move exposure do
   * not propagate.
   *
   * Per G2: this arc the only intended subscriber is the dashboard
   * facade (PR-3). External hosts (ACP/Discord/PWA) don't subscribe
   * directly — they go through the facade's serializable mirror.
   */
  subscribePosture(cb: ShellPostureSubscriber): Unsubscribe;
}

// ── Constants ──────────────────────────────────────────────────────

/** Default mode when `ShellRequest.mode` is omitted.
 *  Decision 2026-04-18 (session nt §7#4): 'vw' — every shell command
 *  lives in the runner VW so history stays visible and the LLM can
 *  re-slice old output. */
export const DEFAULT_SHELL_MODE: ShellMode = 'vw';

/** Mode → default timeout (ms). bg is longest because it is the
 *  landing zone for anything that didn't finish quickly. */
export const DEFAULT_TIMEOUTS: Record<Exclude<ShellMode, 'auto'>, number> = {
  inline: 30_000,
  bg: 300_000,      // §7#8 confirmed: 5 min, matches codex
  modal: 600_000,
  vw: 600_000,
};

export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;       // 256 KiB head+tail
export const DEFAULT_QUIET_IDLE_MS = 1500;
export const DEFAULT_BACKGROUND_AFTER_MS = 15_000;     // claude-code ASSISTANT_BLOCKING_BUDGET_MS

/** Chord bytes that an 'output-only' VW pane MUST still forward.
 *  §7#6: "특별 조합 키 인터럽트만 허용". Anything else is swallowed. */
export const INTERRUPT_CHORDS = Object.freeze({
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlBackslash: '\x1c',
});

/** VW label under which mode='vw' commands cohabit by default.
 *  User-renamable via ^B R (VW-P2 B1). */
export const DEFAULT_VW_RUNNER_LABEL = 'runner';
