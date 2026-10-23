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
  upsertPtyManifest, updatePtyManifestFrame, touchLivePtyManifest, markPtyManifestClosed, removePtyManifest, getPtyManifest,
  updatePtyManifestBuild,
} from '../pty-shell/pty-manifest.js';
import { writeHarnessScreen } from '../harness/harness-screen.js';
import { runningBuild, startTuiRunStateRecorder } from '../pty-shell/tui-run-state.js';
import { debug } from '../debug/log.js';
import { setTuiLogName, setTuiLogSession } from '../debug/tui-log-tag.js';
import { getActiveSessionId } from '../session/index.js';
import { routeExternalInput, type ExternalInputRoute } from '../input/external-input-queue.js';

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
  /** 외부 주입 라우터 — 글 한 줄을 사용자 버퍼에 섞지 않고 별도 대기열로 돌린다(`input/external-input-queue`). */
  routeExternal?: (chars: string) => ExternalInputRoute;
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
  const routeExternal = deps.routeExternal ?? routeExternalInput;
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
      // ⭐ 이 write 는 «바깥»(제어 IPC)에서만 온다 — 키보드와 섞이기 전에 라우터가 먼저 가른다.
      if (routeExternal(chars) !== 'passthrough') return;
      const keys = parse(chars);
      if (!keys.length || !keys.every(inject)) throw new Error('tui-input-undelivered');
    },
    resize: () => { throw new Error('tui-resize-unsupported'); },
    deactivate: () => { alive = false; },
  };
}

// ── 재기동 세션 소유(TUI-H9-ACTIVE-SESSION-ID · 0.2.36) ──
//
// 재기동은 «지금 이 TUI 가 보여 주던 대화» 로만 이어 간다. 기동 때의 `--resume` 값이나 전역 최신
// 세션은 이 TUI 의 것이 아닐 수 있으므로, 이 TUI 가 화면을 그리며 «직접 본» 활성 id 만 여기 적는다.
// 확인이 안 되면 재기동을 막는 쪽이 기본값이다(⛔ 비슷한 id 로 메우지 않는다).

export interface TuiOwnedSession {
  readonly sessionId: string;
  /** 이 TUI 가 그 대화를 «화면으로 확인한» 시각(`at`). */
  readonly at: number;
}

let ownedSession: TuiOwnedSession | null = null;

function normalizeSessionId(value: string | null | undefined): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id || null;
}

/** 이 TUI 가 지금 보여 주는 대화 id 를 적는다. 빈 값이면 «소유 없음» 으로 되돌린다(추측 금지). */
export function claimTuiOwnedSession(
  sessionId: string | null | undefined,
  at: number = Date.now(),
): TuiOwnedSession | null {
  const id = normalizeSessionId(sessionId);
  ownedSession = id ? { sessionId: id, at } : null;
  setTuiLogSession(id);
  return ownedSession;
}

/** 이 TUI 가 화면으로 확인한 대화 — 모르면 null(전역 최신·기동 resume 으로 메우지 않는다). */
export function getTuiOwnedSession(): TuiOwnedSession | null {
  return ownedSession;
}

// 재기동 «요청» — 사용자가 q 로 끄는 것은 재기동이 아니다(기본 동작 보존). 재기동은 누군가(H9 유휴
// 재기동 방아쇠 등)가 «다시 뜨려고» TUI 를 닫을 때만 일어난다 — 그 쪽이 닫기 전에 이것을 부른다.
let restartRequest: { readonly reason: string; readonly at: number } | null = null;

/** TUI 를 «다시 뜨려고» 닫는다고 적는다 — 종료 경계(`exitTuiRun`)가 한 번 읽고 지운다. */
export function requestTuiSelfRestart(reason: string, at: number = Date.now()): void {
  const why = reason.trim();
  restartRequest = { reason: why || 'unspecified', at };
}

/** 재기동 요청을 꺼낸다(꺼내면 사라진다) — 없으면 null = 사용자 종료. */
export function takeTuiSelfRestartRequest(): { readonly reason: string; readonly at: number } | null {
  const request = restartRequest;
  restartRequest = null;
  return request;
}

/** 재기동을 막는 이유 — 전부 «확인 실패» 다(전역 최신·기동 resume 으로 폴백하지 않는다). */
export type TuiRestartBlockReason =
  /** 지금 이 TUI 가 보여 주는 활성 대화가 없다(집중 표식 비었음·읽기 실패). */
  | 'no-active-session'
  /** 이 TUI 가 화면으로 확인한 대화 기록이 없다(발행된 프레임 0). */
  | 'no-owned-session'
  /** 마지막 관측 뒤 활성 대화가 움직였다 — 어느 쪽이 맞는지 확인할 수 없다. */
  | 'owned-session-mismatch'
  /** 확인한 id 의 대화가 저장소에 없다. */
  | 'active-session-missing';

export type TuiRestartSessionDecision =
  | { readonly ok: true; readonly sessionId: string; readonly claimedAt: number }
  | { readonly ok: false; readonly reason: TuiRestartBlockReason };

/**
 * 재기동에 실을 세션 id 를 정한다. `owned`(이 TUI 가 본 것)와 `liveActiveSessionId`(지금 집중된 것)가
 * «같고 그 대화가 실재할 때만» 통과한다 — 하나라도 어긋나면 막는다.
 */
export function decideTuiRestartSession(input: {
  readonly owned: TuiOwnedSession | null;
  readonly liveActiveSessionId: string | null | undefined;
  readonly sessionExists: (sessionId: string) => boolean;
}): TuiRestartSessionDecision {
  const live = normalizeSessionId(input.liveActiveSessionId);
  if (!live) return { ok: false, reason: 'no-active-session' };
  const owned = input.owned;
  if (!owned) return { ok: false, reason: 'no-owned-session' };
  if (owned.sessionId !== live) return { ok: false, reason: 'owned-session-mismatch' };
  let exists = false;
  try {
    exists = input.sessionExists(live);
  } catch {
    exists = false;
  }
  if (!exists) return { ok: false, reason: 'active-session-missing' };
  return { ok: true, sessionId: live, claimedAt: owned.at };
}

export interface TuiSelfReportDeps {
  surfaceId?: string;
  /** `elanous --name <name>` — 자기 manifest 행 별명. `pty list`·`pty snapshot <name>` 이 이것으로 부른다. */
  nickname?: string;
  throttleMs?: number;
  now?: () => number;
  register?: (fn: ((lines: readonly string[], dims: { rows: number; cols: number }) => void) | null) => void;
  publishFrame?: (frame: SelfReportFrame) => void;
  registerRow?: (surfaceId: string, now: number, nickname?: string) => void;
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
  /** 행 등록 직후 실행 판 ⊕ 턴(idle) 기록을 연다 — `elanous pty state` 가 읽는다. 반환 = 정리. */
  startRunState?: (surfaceId: string) => (() => void);
  /** 미룬 우편 깨움 폴러(TUI-H4)를 연다 — 반환 = 정리. 기본은 실 행 등록과 짝일 때만 늦게 불러온 `startPendingWakePoller`. */
  startWakePoller?: (surfaceId: string) => (() => void);
  /** 박동마다 자기 행을 본다 — 없으면 null · ⛔ 조회 실패는 «던진다»(없다로 읽지 않는다). 기본 = `getPtyManifest(id, { strict })`. */
  lookupRow?: (surfaceId: string) => TuiOwnRowView | null;
  /** 재등록 뒤 실행 판(build) 칸을 다시 적는다 — 기본 = 기동 때 판(`runningBuild`). */
  restoreBuild?: (surfaceId: string) => void;
  /** 이 TUI 가 지금 보여 주는 대화 id 를 읽는다 — 프레임을 발행할 때마다 소유 기록을 갱신한다
   *  (TUI-H9). 기본 = `getActiveSessionId()`. ⛔ 읽기 실패는 «모른다»(소유 없음)로 접는다. */
  readActiveSessionId?: () => string | null;
  /** 박동 스케줄러 — 기본 setInterval(unref). 시험이 박동을 손으로 돌린다. */
  driveHeartbeat?: (tick: () => void, ms: number) => (() => void);
  /** SIGCONT 수신 훅(행 상실 단서) — 반환 = 해제. 기본 = process.on('SIGCONT'). */
  onSigcont?: (fn: () => void) => (() => void);
  /** 행 상실 관측 — 기본 = debug.log('tui.self-report', 'row-missing', data). */
  logRowMissing?: (data: TuiRowMissingEvent) => void;
}

/** 박동이 보는 자기 행 — `PtyManifestRow` 의 부분(재등록 뒤 frame·build 복원 확인에도 쓴다). */
export interface TuiOwnRowView {
  readonly alive: boolean;
  readonly frameAt?: number;
  readonly build?: unknown;
}

/** `tui.self-report` · `row-missing` 한 줄 — 살아 있는 TUI 의 manifest 행이 사라졌을 때(재등록 시도 결과 ⊕ 원인 단서). */
export interface TuiRowMissingEvent {
  readonly surfaceId: string;
  readonly pid: number;
  /** 'absent' = 행이 없다 · 'closed' = 행은 있는데 alive=0 · 'lookup-failed' = 조회 자체가 실패(재등록 안 함). */
  readonly state: 'absent' | 'closed' | 'lookup-failed';
  /** 마지막으로 자기 행을 «본» 시각(등록·재등록 포함). */
  readonly lastSeenAt: number;
  readonly sinceMs: number;
  /** 직전 박동과의 간격 — 박동 주기보다 훨씬 크면 그 사이 프로세스가 멈췄다(SIGSTOP·SIGTTIN·이벤트 루프 정체). */
  readonly gapMs: number;
  readonly heartbeatMs: number;
  /** 마지막 SIGCONT 시각(없으면 null) — `lastSeenAt` 뒤면 «정지 → 재개» 사이에 걷혔다는 단서. */
  readonly sigcontAt: number | null;
  readonly sigcontSinceLastSeen: boolean;
  readonly reRegistered: boolean;
  /** 재등록이 비운 frame 칸에 마지막 화면을 다시 적었나(`pty snapshot` 이 바로 닿는다). */
  readonly frameRestored: boolean;
  /** 재등록이 비운 실행 판(build) 칸을 다시 적었나(다시 읽어 확인). */
  readonly buildRestored: boolean;
  readonly error?: string;
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
    const nickname = deps.nickname?.trim() || undefined;
    setTuiLogName(nickname);
    registerRow(surfaceId, now(), nickname);
    if (nickname) debug.log('pty.rename', 'tui-launch-name', { ptyId: surfaceId, nickname });
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
  let stopRunState: () => void = () => {};
  // 행 등록을 갈아 끼운 호출자(시험)는 실 manifest 를 안 건드린다 — 기본 녹음기는 기본 행 등록과 짝일 때만.
  const startRunState = deps.startRunState ?? (deps.registerRow ? () => () => {} : startTuiRunStateRecorder);
  try { stopRunState = startRunState(surfaceId); } catch { /* fail-soft — recorder logs its own write failures */ }
  // 미룬 우편 깨움(TUI-H4) — 이 TUI 가 턴 중·5분 창이라 못 받은 깨움을 idle 로 «기록»된 뒤 한 번 다시 두드린다.
  // 실 행 등록과 짝일 때만(시험이 행 등록을 갈아 끼우면 0) · 무거운 모듈은 늦게 불러온다.
  let stopWakePoller: () => void = () => {};
  let wakePollerStopped = false;
  if (deps.startWakePoller) {
    try { stopWakePoller = deps.startWakePoller(surfaceId); } catch { /* fail-soft */ }
  } else if (!deps.registerRow) {
    void import('../loops/msg-wake.js').then(mod => {
      if (!wakePollerStopped) stopWakePoller = mod.startPendingWakePoller(surfaceId);
    }).catch(() => { /* fail-soft — the post-time wake still runs */ });
  }
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

  // 마지막으로 내보낸 화면 — 재등록이 frame 칸을 비우면 다시 적는다(거울은 바뀐 화면만 내보내 idle 이면 영영 빈 칸).
  let lastEmittedText: string | null = null;
  const emitText = (text: string, cols: number, rows: number): void => {
    const at = now();
    lastEmittedText = text;
    // TUI-H9 — 이 프레임이 «지금 이 TUI 가 보여 주는 대화» 의 소유 기록이다. 재기동은 이 id 로만 잇는다
    // (읽기 실패 → 소유 없음 → 재기동 막힘 · 다른 세션으로 대체하지 않는다).
    try { claimTuiOwnedSession(readActiveSessionId(), at); } catch { claimTuiOwnedSession(null, at); }
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
  // ⭐ 박동마다 자기 행을 본다 — 남이 걷어 간 행(정지 중 stale 수거 등)을 같은 박동에서 다시 세운다.
  //   행이 없으면 pty text/key/snapshot·우편 깨움이 이 TUI 에 영영 안 닿는다(#75 · #84).
  // 행 등록을 갈아 끼운 호출자(시험)는 실 manifest 를 안 읽는다 — 기본 조회는 기본 행 등록과 짝일 때만.
  const lookupRow: (id: string) => TuiOwnRowView | null = deps.lookupRow
    ?? (deps.registerRow ? () => ({ alive: true }) : (id: string) => getPtyManifest(id, { strict: true }));
  const restoreBuild = deps.restoreBuild ?? (deps.registerRow ? () => {} : (id: string) => { updatePtyManifestBuild(id, runningBuild()); });
  const logRowMissing = deps.logRowMissing ?? ((data: TuiRowMissingEvent) => debug.log('tui.self-report', 'row-missing', data));
  const readActiveSessionId: () => string | null = deps.readActiveSessionId
    ?? (() => { try { return getActiveSessionId(); } catch { return null; } });
  const rowNickname = deps.nickname?.trim() || undefined;
  let lastSeenAt = now();
  let lastBeatAt = lastSeenAt;
  let sigcontAt: number | null = null;
  let stopSigcont: () => void = () => {};
  try {
    stopSigcont = (deps.onSigcont ?? ((fn) => {
      process.on('SIGCONT', fn);
      return () => { process.off('SIGCONT', fn); };
    }))(() => { sigcontAt = now(); });
  } catch { /* fail-soft — 단서일 뿐 */ }
  let stopped = false;
  const beat = (): void => {
    if (stopped) return;
    const at = now();
    const prevSeenAt = lastSeenAt;
    const gapMs = at - lastBeatAt;
    lastBeatAt = at;
    let state: TuiRowMissingEvent['state'] | null = null;
    let error: string | undefined;
    try {
      const row = lookupRow(surfaceId);
      if (!row) state = 'absent';
      else if (!row.alive) state = 'closed';
    } catch (e) {
      state = 'lookup-failed';
      error = e instanceof Error ? e.message : String(e);
    }
    if (state === null) {
      lastSeenAt = at;
      try { heartbeat(surfaceId, at); } catch { /* fail-soft */ }
      return;
    }
    let reRegistered = false;
    let frameRestored = false;
    let buildRestored = false;
    if (state === 'lookup-failed') {
      // ⛔ 실패를 «없다»로 읽지 않는다 — 재등록 없이 평소 박동만.
      try { heartbeat(surfaceId, at); } catch { /* fail-soft */ }
    } else {
      try {
        registerRow(surfaceId, at, rowNickname);
        // 기본 행 등록은 fail-soft(조용히 삼킨다) — «다시 세웠다» 는 다시 읽어서만 말한다.
        reRegistered = lookupRow(surfaceId)?.alive === true;
        if (!reRegistered) throw new Error('row-still-missing-after-register');
        lastSeenAt = at;
        // 재등록은 실행 판·턴 칸을 비운다 — 판은 기동 때 값으로 다시 적는다. 턴은 비운 채(unknown) 둔다:
        // 녹음기를 다시 열면 «idle» 을 적는데, 턴 도중이면 거짓 idle 이 깨움을 끼어들게 한다. 다음 턴 변화가 채운다.
        const restoreErrors: string[] = [];
        try { restoreBuild(surfaceId); } catch (e) { restoreErrors.push(`build: ${e instanceof Error ? e.message : String(e)}`); }
        if (lastEmittedText !== null) {
          try { writeFrame(surfaceId, lastEmittedText, at); } catch (e) { restoreErrors.push(`frame: ${e instanceof Error ? e.message : String(e)}`); }
        }
        // 기본 쓰기도 fail-soft — «복원했다» 는 다시 읽어서만 말한다.
        try {
          const after = lookupRow(surfaceId);
          frameRestored = lastEmittedText !== null && (after?.frameAt ?? 0) >= at;
          buildRestored = after?.build != null;
        } catch (e) { restoreErrors.push(`verify: ${e instanceof Error ? e.message : String(e)}`); }
        if (restoreErrors.length) error = restoreErrors.join('; ');
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    try {
      logRowMissing({
        surfaceId, pid: process.pid, state, lastSeenAt: prevSeenAt, sinceMs: at - prevSeenAt, gapMs, heartbeatMs,
        sigcontAt, sigcontSinceLastSeen: sigcontAt !== null && sigcontAt >= prevSeenAt,
        reRegistered, frameRestored, buildRestored, ...(error ? { error } : {}),
      });
    } catch { /* fail-soft diagnostic */ }
  };
  const stopHeartbeat = (deps.driveHeartbeat ?? ((tick, ms) => {
    // setImmediate 로 한 칸 미룬다 — 정지(SIGSTOP·SIGTTIN)에서 풀리면 밀린 타이머가 SIGCONT 처리기보다 «먼저» 돈다
    // (WSL bun 실측). 미뤄야 같은 박동의 row-missing 이 sigcontAt 을 본다.
    const t = setInterval(() => { setImmediate(tick); }, ms);
    (t as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  }))(beat, heartbeatMs);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try { stopSource(); } catch { /* fail-soft — unregisters observer / clears tick timer */ }
    try { mirror?.stop(); } catch { /* fail-soft — restores stdout.write */ }
    try { stopHeartbeat(); } catch { /* fail-soft */ }
    try { stopSigcont(); } catch { /* fail-soft */ }
    try { stopRunState(); } catch { /* fail-soft */ }
    wakePollerStopped = true;
    try { stopWakePoller(); } catch { /* fail-soft */ }
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

function defaultRegisterRow(surfaceId: string, now: number, nickname?: string): void {
  upsertPtyManifest({ id: surfaceId, kind: 'tui', ...(nickname ? { nickname } : {}), cmd: 'elanous', startedAt: now, now });
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
