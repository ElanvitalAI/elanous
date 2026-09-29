// ── Interactive TUI self-report (PLAN P1b · S1) ──
//
// The interactive dashboard TUI is a plain foreground process — nobody
// spawned it via startPty, so it's invisible to the PTY registry, the
// cross-process manifest, and every observatory (S1). It cannot be
// "forwarded" (no external PTY-holder). So it must SELF-REPORT: publish
// its own rendered frames.
//
// The seam is tui.ts `setFrameObserver` — render() feeds every composed
// full-screen frame here. We throttle, wrap it as a SelfReportFrame,
// and emit to BOTH:
//   - the in-process ChannelBus (P0) — same-process consumers,
//   - the cross-process pty-manifest frame column (P1a) — so the daemon
//     `/v1/terminals` + (P2) PWA can see the human's dashboard.
//
// Runtime observation and control initialization remain fail-soft so they
// never break TUI rendering. Advertising is fail-closed: a surface is never
// published unless its input channel is reachable. cf. PLAN §3-1
// (self-report mode), §5 (bridge), REPORT §5 (S1·S2).
//
// ⚠️ FIDELITY (P1b): render()'s `_lastFrameLines` is the BASE composited
// layer only. Modals / pickers / overlays are drawn via a separate
// overlay path (window.flushOverlay · render's `opts.overlay`, which is
// NOT stored in _lastFrameLines) — so they are NOT in the self-reported
// frame yet. Full fidelity (base + overlay + cursor, identical to what
// tmux/the user sees) needs the real output stream fed through an
// @xterm/headless emulator + renderScreen() — same approach the registry
// PTYs use. That is the P1b-2 follow-up; this cut ships the base frame,
// which already gives cross-process live visibility of the dashboard.

import type { SelfReportFrame } from './self-report-frame.js';
import { resolveInstanceName } from '../instance-identity.js';
import { getHarnessRunId } from '../harness/harness-space.js';
import { injectKey, setFrameObserver, splitKeys, termSize as tuiTermSize, type Key } from '../tui.js';
import { canTransitionAccessMode, type PtyAccessMode, type PtyTransitionPolicy } from '../pty-shell/pty-ref.js';
import { resolveWriteDecision, type PtyWriteActor } from '../pty-shell/pty-write-arbiter.js';
import { registerPtyControlTarget, startPtyControlPoller, type PtyControlTarget } from '../pty-shell/registry.js';
import { createTuiScreenMirror } from './tui-screen-mirror.js';
import { getChannelBus } from '../terminal-matrix/index.js';
import { publishSelfReportFrame } from './self-report-frame.js';
import {
  upsertPtyManifest, updatePtyManifestFrame, touchLivePtyManifest, markPtyManifestClosed, removePtyManifest,
} from '../pty-shell/pty-manifest.js';
import { writeHarnessScreen } from '../harness/harness-screen.js';
import { debug } from '../debug/log.js';

export interface TuiFrameObserverCfg {
  surfaceId: string;
  instance: string;
  /** K4 run-identity — 이 서피스가 속한 per-run join anchor(getHarnessRunId). 부재='' → 프레임서 생략. */
  runId?: string;
  throttleMs: number;
  now: () => number;
  /** Sink for a throttle-passing frame. Kept injectable so the observer
   *  logic is testable without a real bus / manifest. */
  emit: (frame: SelfReportFrame) => void;
  /** Frame text source. Default = `lines.join('\n')` (P1b base layer).
   *  P1b-2 injects a full-fidelity source (the screen-mirror grid, which
   *  includes overlays/cursor). Also the resize hook point — it receives
   *  the current dims and may (e.g.) resize the mirror before rendering. */
  textOf?: (lines: readonly string[], dims: { rows: number; cols: number }) => string;
}

/** Build the render() observer callback: throttles, joins the frame
 *  lines to text, and emits a SelfReportFrame. Pure w.r.t. its config —
 *  the only side effect is calling `emit`. Exported for direct testing. */
export function createTuiFrameObserver(
  cfg: TuiFrameObserverCfg,
): (lines: readonly string[], dims: { rows: number; cols: number }) => void {
  // -Infinity so the FIRST frame always emits regardless of the clock
  // (a fresh surface should self-report immediately, then throttle).
  let lastAt = Number.NEGATIVE_INFINITY;
  const textOf = cfg.textOf ?? ((lines: readonly string[]) => lines.join('\n'));
  return (lines, dims) => {
    const t = cfg.now();
    if (t - lastAt < cfg.throttleMs) return;   // throttle — near-zero work on the hot path
    lastAt = t;
    const frame: SelfReportFrame = {
      surfaceId: cfg.surfaceId,
      instance: cfg.instance,
      kind: 'tui',
      mode: 'self-report',
      // Keep ANSI (colours) — richer for `elanous self screen`/PWA render;
      // text-only consumers (memory summary) strip via stripScreenAnsi.
      text: textOf(lines, dims),
      cols: dims.cols,
      rows: dims.rows,
      at: t,
      ...(cfg.runId ? { runId: cfg.runId } : {}),   // K4 — 프레임→run join
    };
    try { cfg.emit(frame); } catch { /* fail-soft — observation never breaks draw */ }
  };
}

/** Dependency seams for `startTuiSelfReport` — defaulted to the real
 *  tui.ts hook / ChannelBus / pty-manifest, overridable in tests. */
export interface TuiControlTargetDeps {
  injectKey?: (key: Key) => boolean;
  splitKeys?: (input: string) => Key[];
  /** The foreground terminal's real size; `undefined` when it cannot be known (stdout is not a TTY). */
  dims?: () => { readonly cols: number; readonly rows: number } | undefined;
}

function stdoutDims(): { cols: number; rows: number } | undefined {
  const out = process.stdout;
  return out.isTTY && out.columns > 0 && out.rows > 0 ? { cols: out.columns, rows: out.rows } : undefined;
}

export interface TuiControlTarget extends PtyControlTarget {
  deactivate(): void;
}

/** Adapt the foreground TUI's own terminal to the existing PTY control
 * protocol without pretending it is a spawned child process. */
export function createTuiControlTarget(surfaceId: string, deps: TuiControlTargetDeps = {}): TuiControlTarget {
  const inject = deps.injectKey ?? injectKey;
  const parse = deps.splitKeys ?? splitKeys;
  const dims = deps.dims ?? stdoutDims;
  let alive = true;
  let accessMode: PtyAccessMode = 'write';
  let transitionPolicy: PtyTransitionPolicy = 'open';
  return {
    id: surfaceId,
    get cols() { return dims()?.cols; },
    get rows() { return dims()?.rows; },
    get accessMode() { return accessMode; },
    set accessMode(mode: PtyAccessMode) { accessMode = mode; },
    get transitionPolicy() { return transitionPolicy; },
    set transitionPolicy(policy: PtyTransitionPolicy) { transitionPolicy = policy; },
    setAccessMode(mode: PtyAccessMode): boolean {
      if (!canTransitionAccessMode(accessMode, mode, transitionPolicy)) return false;
      accessMode = mode;
      return true;
    },
    isAlive: () => alive,
    canWrite: (actor: PtyWriteActor = 'human') => resolveWriteDecision(accessMode, actor).allow,
    write(chars: string): void {
      const keys = parse(chars);
      if (!keys.length || !keys.every(inject)) throw new Error('tui-input-undelivered');
    },
    resize: () => { throw new Error('tui-resize-unsupported'); },
    deactivate: () => { alive = false; },
  };
}

export interface TuiSelfReportDeps {
  surfaceId?: string;
  throttleMs?: number;
  now?: () => number;
  register?: (fn: ((lines: readonly string[], dims: { rows: number; cols: number }) => void) | null) => void;
  publishFrame?: (frame: SelfReportFrame) => void;
  registerRow?: (surfaceId: string, now: number) => void;
  writeFrame?: (surfaceId: string, text: string, now: number) => void;
  /** B(harness-screens 파일) sink — `elanous self screen` 이 읽는 substrate.
   *  자식 harness 발행과 대칭(tmux 없이 L2 대시보드 자기 화면 관측). */
  writeScreen?: (surfaceId: string, text: string) => void;
  heartbeat?: (surfaceId: string, now: number) => void;
  markClosed?: (surfaceId: string, now: number) => void;
  rollbackRow?: (surfaceId: string) => void;
  onExit?: (stop: () => void) => void;
  heartbeatMs?: number;
  /** Live terminal dims (mirror path). Default = tui.ts termSize(). */
  termSize?: () => { rows: number; cols: number };
  /** Snapshot-tick scheduler (mirror path). Default = setInterval; returns
   *  a stop fn. Injected by tests to drive the tick manually. */
  driveTicks?: (tick: () => void, ms: number) => (() => void);
  /** P1b-2 full-fidelity screen mirror (base + overlay + cursor). Seam —
   *  default creates a real `TuiScreenMirror` (tapping process.stdout)
   *  unless `ELANOUS_TUI_SELF_REPORT=0`. Returns null → fall back to the
   *  P1b base layer (`_lastFrameLines`). */
  createMirror?: () => TuiScreenMirrorLike | null;
  createControlTarget?: (surfaceId: string) => TuiControlTarget;
  registerControlTarget?: (target: TuiControlTarget) => (() => void);
  startControlPoller?: () => (() => void);
  reportControlInitFailure?: (stage: TuiControlInitStage, error: unknown) => void;
  reportControlCleanupFailure?: (stage: TuiControlCleanupStage, error: unknown) => void;
}

export type TuiControlInitStage = 'create-target' | 'register-target' | 'start-poller' | 'publish-manifest';
export type TuiControlCleanupStage = 'rollback-manifest' | 'stop-poller' | 'unregister-target' | 'deactivate-target';

/** Minimal shape of the screen mirror this module needs (structural —
 *  keeps the mirror module out of the test graph unless the real seam
 *  is used). */
export interface TuiScreenMirrorLike {
  renderScreen(): string;
  resize(cols: number, rows: number): void;
  stop(): void;
}

/** Wire the interactive TUI's self-report: establish its control target and
 *  poller, then register a manifest row, observe frames, publish + persist
 *  them (throttled), heartbeat while alive, and mark closed on exit. Runtime
 *  and initialization failures are fail-soft; advertising remains fail-closed. */
export function startTuiSelfReport(deps: TuiSelfReportDeps = {}): () => void {
  const now = deps.now ?? Date.now;
  const surfaceId = deps.surfaceId ?? `tui:${process.pid}`;
  const throttleMs = deps.throttleMs ?? 1500;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  let instance = 'prod';
  try { instance = resolveInstanceName(); } catch { /* fail-soft default */ }
  // ★ K4 run-identity(2026-07-25·[[PLAN §K/K4]]) — 이 서피스 프레임을 run 에 join. K1/K2 가 env 로 전파한
  //   ELANOUS_RUN_ID(없으면 ''=run 밖·생략). 발행 프레임(emitText)+observer 둘 다 스탬프.
  let runId = '';
  try { runId = getHarnessRunId(); } catch { /* fail-soft */ }

  const register = deps.register ?? defaultRegister;
  const publishFrame = deps.publishFrame ?? defaultPublishFrame;
  const registerRow = deps.registerRow ?? defaultRegisterRow;
  const writeFrame = deps.writeFrame ?? defaultWriteFrame;
  const writeScreen = deps.writeScreen ?? defaultWriteScreen;
  const heartbeat = deps.heartbeat ?? defaultHeartbeat;
  const markClosed = deps.markClosed ?? defaultMarkClosed;
  const rollbackRow = deps.rollbackRow ?? removePtyManifest;
  const termSize = deps.termSize ?? tuiTermSize;
  const reportControlInitFailure = deps.reportControlInitFailure ?? ((stage: TuiControlInitStage, error: unknown) => {
    debug.log('pty.takeover', 'tui-control-init-failed', { id: surfaceId, stage, error: error instanceof Error ? error.message : String(error) });
  });
  const reportControlCleanupFailure = deps.reportControlCleanupFailure ?? ((stage: TuiControlCleanupStage, error: unknown) => {
    debug.log('pty.takeover', 'tui-control-cleanup-failed', { id: surfaceId, stage, error: error instanceof Error ? error.message : String(error) });
  });
  let controlTarget: TuiControlTarget | null = null;
  let unregisterControlTarget: () => void = () => {};
  let stopControlPoller: () => void = () => {};
  let controlInitStage: TuiControlInitStage = 'create-target';
  const initDisposers: Array<{ stage: TuiControlCleanupStage; dispose: () => void }> = [];
  try {
    controlTarget = (deps.createControlTarget ?? createTuiControlTarget)(surfaceId);
    initDisposers.push({ stage: 'deactivate-target', dispose: () => controlTarget?.deactivate() });
    controlInitStage = 'register-target';
    unregisterControlTarget = (deps.registerControlTarget ?? registerPtyControlTarget)(controlTarget);
    initDisposers.push({ stage: 'unregister-target', dispose: unregisterControlTarget });
    controlInitStage = 'start-poller';
    stopControlPoller = (deps.startControlPoller ?? startPtyControlPoller)();
    initDisposers.push({ stage: 'stop-poller', dispose: stopControlPoller });
    controlInitStage = 'publish-manifest';
    initDisposers.push({ stage: 'rollback-manifest', dispose: () => rollbackRow(surfaceId) });
    registerRow(surfaceId, now());
  } catch (error) {
    for (let disposer = initDisposers.pop(); disposer; disposer = initDisposers.pop()) {
      try { disposer.dispose(); } catch (cleanupError) {
        try { reportControlCleanupFailure(disposer.stage, cleanupError); } catch { /* fail-soft diagnostic */ }
      }
    }
    try { reportControlInitFailure(controlInitStage, error); } catch { /* fail-soft diagnostic */ }
    return () => {};
  }
  const activeControlTarget = controlTarget;
  const driveTicks = deps.driveTicks ?? ((tick, ms) => {
    const t = setInterval(tick, ms);
    (t as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  });

  // P1b-2 full-fidelity mirror (base + overlay + cursor). If it comes up,
  // it captures the whole stdout stream — including overlays/pickers that
  // are written OUTSIDE render() (§reference: single-PTY grid is capturable).
  const createMirror = deps.createMirror ?? defaultCreateMirror;
  let mirror: TuiScreenMirrorLike | null = null;
  try { mirror = createMirror(); } catch { mirror = null; }

  // The manifest row is published only after both input capabilities are
  // live. A listed TUI therefore always has a registered target and poller.

  const emitText = (text: string, cols: number, rows: number): void => {
    const at = now();
    const frame: SelfReportFrame = { surfaceId, instance, kind: 'tui', mode: 'self-report', text, cols, rows, at, ...(runId ? { runId } : {}) };
    try { publishFrame(frame); } catch { /* fail-soft */ }
    // `at` is shared with the manifest write → its internal throttle keys
    // off the SAME clock and can never drift from ours.
    try { writeFrame(surfaceId, text, at); } catch { /* fail-soft */ }
    // B(harness-screens 파일) — `elanous self screen` 이 읽는 substrate. 자식 harness 와
    // 대칭으로 발행해 tmux 없이 L2 대시보드 자기 화면을 관측한다(뷰어·TUI 동일 state-dir 전제).
    try { writeScreen(surfaceId, text); } catch { /* fail-soft */ }
  };

  // Two capture modes:
  //   mirror  → TIMER-driven grid sample. The mirror accumulates every
  //             stdout byte (base + overlay), so a periodic read captures
  //             overlay-only changes (pickers) that render() never ticks.
  //             Dedup skips idle (unchanged) frames.
  //   no mirror → render()-observer on the base layer (P1b fallback).
  let stopSource: () => void = () => {};
  if (mirror) {
    const m = mirror;
    let lastText = '';
    let lastCols = -1, lastRows = -1;
    const tick = (): void => {
      try {
        const { rows, cols } = termSize();
        if (cols !== lastCols || rows !== lastRows) {   // only resize on actual change (ACP review)
          m.resize(cols, rows);
          lastCols = cols; lastRows = rows;
        }
        const text = m.renderScreen();
        if (!text || text === lastText) return;   // idle / unchanged → skip write
        lastText = text;
        emitText(text, cols, rows);
      } catch { /* fail-soft */ }
    };
    const stopTicks = driveTicks(tick, throttleMs);
    stopSource = () => { try { stopTicks(); } catch { /* fail-soft */ } };
  } else {
    const observer = createTuiFrameObserver({
      surfaceId, instance, throttleMs, now, ...(runId ? { runId } : {}),
      emit: (frame) => emitText(frame.text, frame.cols, frame.rows),
    });
    try { register(observer); } catch { /* fail-soft */ }
    stopSource = () => { try { register(null); } catch { /* fail-soft */ } };
  }

  // Heartbeat so a live-but-idle TUI isn't culled by reapStale.
  const hb = setInterval(() => { try { heartbeat(surfaceId, now()); } catch { /* fail-soft */ } }, heartbeatMs);
  (hb as { unref?: () => void }).unref?.();

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try { stopSource(); } catch { /* fail-soft — unregisters observer / clears tick timer */ }
    try { mirror?.stop(); } catch { /* fail-soft — restores stdout.write */ }
    clearInterval(hb);
    try { markClosed(surfaceId, now()); } catch { /* fail-soft */ }
    try { activeControlTarget?.deactivate(); } catch { /* fail-soft */ }
    try { stopControlPoller(); } catch { /* fail-soft */ }
    try { unregisterControlTarget(); } catch { /* fail-soft */ }
  };
  (deps.onExit ?? ((s) => process.on('exit', s)))(stop);
  return stop;
}

/** Default mirror factory — creates the real stdout-tapping screen
 *  mirror sized to the live terminal, unless disabled by kill-switch. */
function defaultCreateMirror(): TuiScreenMirrorLike | null {
  if (process.env.ELANOUS_TUI_SELF_REPORT === '0') return null;   // kill-switch
  try {
    const { rows, cols } = tuiTermSize();
    return createTuiScreenMirror({ cols, rows });
  } catch {
    return null;   // no mirror → base-layer self-report still works
  }
}

// ── Default (production) dependency implementations ──
// SYNCHRONOUS (ACP review fix) — the former lazy dynamic imports made
// row-register / observer-register async, so the first frame's UPDATE
// could race ahead of the row INSERT (and the observer could register
// after the first render). Static imports + sync calls give a strict
// order: registerRow() completes, THEN register(observer). Tests never
// hit these (they inject their own seams), so no coupling cost.

function defaultRegister(fn: ((lines: readonly string[], dims: { rows: number; cols: number }) => void) | null): void {
  setFrameObserver(fn);
}

function defaultPublishFrame(frame: SelfReportFrame): void {
  publishSelfReportFrame(getChannelBus(), frame);
}

function defaultRegisterRow(surfaceId: string, now: number): void {
  upsertPtyManifest({ id: surfaceId, kind: 'tui', cmd: 'elanous', startedAt: now, now });
}

function defaultWriteFrame(surfaceId: string, text: string, now: number): void {
  updatePtyManifestFrame(surfaceId, () => text, now);
}

function defaultWriteScreen(surfaceId: string, text: string): void {
  writeHarnessScreen(surfaceId, text);
}

function defaultHeartbeat(surfaceId: string, now: number): void {
  touchLivePtyManifest(new Set([surfaceId]), now);
}

function defaultMarkClosed(surfaceId: string, now: number): void {
  markPtyManifestClosed(surfaceId, 0, now);
}
