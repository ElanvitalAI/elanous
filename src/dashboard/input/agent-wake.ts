// ── 배경 자식 완료 알림 `agent-wake` (TUI-AGENT-IDLE-WAKE 조각 1 · 0.2.31 · 2026-10-17) ─────────────────
//
// 🚨 무엇을 푸는가: `Agent(..., run_in_background)` 자식(⊕ RunShell bg 완료)이 끝나면
//   `globalTaskNotificationQueue` 에 쌓이고 «다음 턴 시작»에 `<task-notification>` 으로 실린다
//   (turn-preamble drain). 그런데 그 큐의 `onEnqueue` 를 비시험 코드가 아무도 구독하지 않아(구독 0),
//   쉬는 TUI 는 자식이 끝나도 아무 신호가 없었다 — 10-16 #71 «백그라운드 리뷰 4건 끝나고 12분 방치».
// ⭐ 이 모듈이 구독 «하나»다(구독 0 → 1). 완료 한 건마다 채팅 한 줄
//   «✓ 위임 끝: <이름> — 다음 턴에 결과»(입력칸 무접촉). 결과 본문은 기존 preamble drain 이 다음 턴에 싣는다.
// ⛔ 입력칸 버퍼·`injectKey`·`hostControl.submit`·pty 주입 0(대표 비침투 · 10-17 설계 정정).
// ⭐ 조각 2(TUI-AGENT-IDLE-WAKE-TURN · 0.2.32): `openTurn` 을 넘기면 자리 TUI(`detectSeatTui` — H1·H3 와 같은
//   판정)에서 H2 문(`startTurnIfIdle`, origin `child-complete`)으로 다음 턴을 연다. 사람 대화 TUI 는 알림만
//   (대표 «다음 턴에 싣기»). 거부 사유는 H2 값 그대로(NotIdle·HumanTyping·Cap …) — 여기서 새 판정을 짓지 않는다.
//   턴 중(NotIdle)·입력 중(HumanTyping)에 온 완료는 «대기»: 입력칸이 다시 뜰 때(`wrapAgentWakePort`) 그 결과가
//   아직 큐에 남아 있으면(=어느 턴도 안 실었으면) 한 번만 다시 청한다. 이미 실렸으면(drain) 아무것도 안 한다.
// ⛔ 같은 알림(taskId)은 한 번만 — 큐 `seen` 이 `clear()` 로 비워져도, 대시보드가 재진입해도 막는다.
//
// 세 얼굴:
//   관측 = debug.log('tui.agent-wake', 'notified' | 'opened' | 'rejected' | 'deferred', { taskId, agent, state, seat, shown, reason })
//          ⊕ H2 자체 관측 `tui.autoturn` opened|rejected { origin:'child-complete' }
//   인지 = 배경 완료 도착(⊕ 이미 알린 taskId 인가) ⊕ 자리 TUI 인가 ⊕ H2 가 열어 주나
//   힐링 = 채팅 한 줄로 사람·자리에게 «결과가 왔다»를 보인다 · 자리 TUI 면 H2 로 한 턴(화면 «↻ 자동 재개
//          (child-complete): 위임 끝: <이름>») · 결과는 유실 0(큐 그대로 → 연 턴/다음 턴 preamble) ·
//          그리기 실패는 shown:false · 거부는 사유 로그 → TF 가 본다(`eln logs --category tui.agent-wake`)

import { homedir } from 'node:os';
import type { TextInputInternalTurnYieldPort } from '../../chat/index.js';
import { debug } from '../../debug/log.js';
import type { PendingTaskNotification } from '../../agent/task-notification.js';
import { detectSeatTui, type SeatDetection } from '../seat-boot-preamble.js';
import type { InternalTurnRejectReason, StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';

/** 자리 TUI 에서 다음 턴을 여는 길(조각 2). 없으면 알림만(조각 1 동작 그대로). */
export interface AgentWakeOpenTurnDeps {
  /** H2 문 — 대시보드의 `internalTurnGate.startTurnIfIdle`. */
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  getCwd: () => string;
  /** 그 완료가 아직 어느 턴에도 안 실렸나 — 대시보드는 `globalTaskNotificationQueue.has`. «대기» 재시도의 근거. */
  isPending: (taskId: string) => boolean;
  home?: string;
  detectSeat?: (cwd: string) => SeatDetection | null;
  /** 입력칸이 다시 뜬 뒤 재시도를 미루는 자리(마운트 «중»에 물러남을 청하지 않게). 기본 setTimeout 0 · unref. */
  defer?: (fn: () => void) => void;
}

/** 이 모듈이 내는 거부 사유(H2 밖) — 나머지는 H2 `InternalTurnRejectReason` 그대로. */
export type AgentWakeTurnSkipReason =
  /** 사람 대화 TUI — 알림만, 턴은 안 연다. */
  | 'not-seat'
  /** 자리 판정 자체가 실패했다(권한 오류 등) — 모르면 열지 않는다. */
  | 'seat-unknown';

/** H2 가 «지금은 안 된다»로 거부한 것 — 입력칸이 다시 뜰 때 한 번 더 청한다. */
const DEFERRABLE: ReadonlySet<InternalTurnRejectReason> = new Set(['NotIdle', 'HumanTyping']);

export interface AgentWakeDeps {
  /** 큐 구독 — 대시보드는 `globalTaskNotificationQueue.onEnqueue` 를 넘긴다. 해제 함수를 돌려준다. */
  subscribe: (listener: (n: PendingTaskNotification) => void) => () => void;
  /** 채팅 한 줄(입력칸 무접촉). */
  notify: (line: string) => void;
  /** 이미 알린 taskId — 설치를 가로질러 공유한다(기본: 이 컨트롤러만의 집합). */
  handled?: Set<string>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** 조각 2 — 자리 TUI 에서 H2 로 다음 턴을 연다. 없으면 알림만. */
  openTurn?: AgentWakeOpenTurnDeps;
}

export interface AgentWakeController {
  /** 이 컨트롤러의 구독만 푼다(여러 번 불러도 안전). */
  dispose(): void;
  /** 입력칸이 다시 떴다 — «대기» 중인 완료가 아직 안 실렸으면 H2 로 한 번 더 청한다. */
  onInputMounted(): void;
}

function displayName(n: Pick<PendingTaskNotification, 'label' | 'agentName'>): string {
  return ((n.label ?? '').trim() || n.agentName).replace(/\s+/g, ' ').slice(0, 60);
}

/** 채팅 한 줄 — «✓ 위임 끝: <이름> — 다음 턴에 결과»(실패·중단이면 ✗ ⊕ 상태). */
export function formatAgentWakeNotice(n: Pick<PendingTaskNotification, 'label' | 'agentName' | 'state'>): string {
  const name = displayName(n);
  const glyph = n.state === 'done' ? '✓' : '✗';
  const state = n.state === 'done' ? '' : ` (${n.state})`;
  return `${glyph} 위임 끝: ${name}${state} — 다음 턴에 결과`;
}

/** 자리 TUI 에서 여는 내부 턴의 입력 — 결과 본문은 turn-preamble 이 `<task-notification>` 으로 싣는다. */
export function formatAgentWakePrompt(n: Pick<PendingTaskNotification, 'label' | 'agentName' | 'state'>): string {
  return `[자동 재개] 위임 끝: ${displayName(n)} (${n.state}) — <task-notification> 의 결과를 읽고 이어서 처리`;
}

export function createAgentWake(deps: AgentWakeDeps): AgentWakeController {
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  const handled = deps.handled ?? new Set<string>();

  const open = deps.openTurn;
  const home = open?.home ?? homedir();
  const detect = open?.detectSeat ?? ((cwd: string) => detectSeatTui(cwd, { home }));
  const defer = open?.defer ?? ((fn: () => void) => {
    const t = setTimeout(fn, 0);
    (t as { unref?: () => void }).unref?.();
  });
  /** H2 가 «지금은 안 된다»로 거부한 마지막 완료 — 입력칸이 다시 뜰 때 한 번만 다시 청한다. */
  let deferred: PendingTaskNotification | null = null;

  const tryOpen = (n: PendingTaskNotification, trigger: 'enqueue' | 'input-mounted'): void => {
    if (!open) return;
    const base = { taskId: n.taskId, agent: n.agentName, state: n.state, trigger };
    let seat: string | null = null;
    try { seat = detect(open.getCwd())?.seat ?? null; } catch (error) {
      log('tui.agent-wake', 'rejected', { ...base, reason: 'seat-unknown' satisfies AgentWakeTurnSkipReason,
        detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!seat) {
      log('tui.agent-wake', 'rejected', { ...base, seat, reason: 'not-seat' satisfies AgentWakeTurnSkipReason });
      return;
    }
    let result: StartTurnIfIdleResult;
    try {
      result = open.startTurnIfIdle(formatAgentWakePrompt(n), { origin: 'child-complete', reason: `위임 끝: ${displayName(n)}` });
    } catch (error) {
      log('tui.agent-wake', 'rejected', { ...base, seat, reason: 'error', detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (result.opened) {
      deferred = null;
      log('tui.agent-wake', 'opened', { ...base, seat, turnId: result.turnId });
      return;
    }
    const wait = DEFERRABLE.has(result.reason) && trigger === 'enqueue';
    if (wait) deferred = n;
    log('tui.agent-wake', wait ? 'deferred' : 'rejected', { ...base, seat, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) });
  };

  const handle = (n: PendingTaskNotification): boolean => {
    const base = { taskId: n.taskId, agent: n.agentName, state: n.state };
    if (handled.has(n.taskId)) {
      log('tui.agent-wake', 'rejected', { ...base, reason: 'duplicate' });
      return false;
    }
    handled.add(n.taskId);
    // 그리기 실패가 큐·형제 리스너를 막지 않는다 — 대신 관측에 남긴다(알림이 실제로 안 보였음을 볼 수 있게).
    let notifyError: string | null = null;
    try { deps.notify(formatAgentWakeNotice(n)); } catch (error) {
      notifyError = error instanceof Error ? error.message : String(error);
    }
    log('tui.agent-wake', 'notified', { ...base, shown: notifyError === null, ...(notifyError !== null ? { notifyError } : {}) });
    if (open) tryOpen(n, 'enqueue');
    return true;
  };

  let unsubscribe: (() => void) | null = deps.subscribe((n) => { handle(n); });

  return {
    dispose() {
      const off = unsubscribe;
      unsubscribe = null;
      deferred = null;
      off?.();
    },
    onInputMounted() {
      if (!open || !deferred || unsubscribe === null) return;
      const n = deferred;
      deferred = null; // 재시도는 «한 번» — 다시 거부돼도 쌓지 않는다(결과는 다음 턴 preamble 이 싣는다).
      defer(() => {
        try {
          // 예약 뒤 이 대시보드가 닫혔다 → 옛 H2 문에 청하지 않는다.
          if (unsubscribe === null) return;
          // 그 사이 어느 턴이 «그» 결과를 이미 실었다(drain) → 열 이유가 없다(다른 결과는 자기 enqueue 가 청한다).
          if (!open.isPending(n.taskId)) {
            log('tui.agent-wake', 'rejected', { taskId: n.taskId, agent: n.agentName, state: n.state, trigger: 'input-mounted', reason: 'already-carried' });
            return;
          }
          tryOpen(n, 'input-mounted');
        } catch (error) {
          // fail-soft: 깨움은 입력을 막지 않는다 — 다만 «조용히 죽은» 이유는 TF 가 봐야 한다(거부는 사유 로그).
          log('tui.agent-wake', 'rejected', {
            taskId: n.taskId, agent: n.agentName, state: n.state, trigger: 'input-mounted', reason: 'error',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

/** 대시보드 `notify` — 채팅 줄을 넣고 그린다. ⛔ 예외를 삼키지 않는다: 줄 넣기·그리기가 실패하면 던져서
 *  `handle` 이 `notified{shown:false, notifyError}` 로 남기게 한다(삼키면 «보였다»고 거짓 관측). */
export function createDashboardAgentWakeNotify(
  pushLine: (line: string) => void,
  draw: () => void,
): (line: string) => void {
  return (line) => {
    pushLine(line);
    draw();
  };
}

// ── 대시보드 수명 ────────────────────────────────────────────────────────────────────
// showDashboard 는 다시 들어올 수 있다. ① 구독은 언제나 하나 — 설치가 앞 설치를 먼저 푼다.
// ② 각 대시보드는 «자기» 컨트롤러만 푼다(늦게 닫힌 앞 대시보드가 새 구독을 끊지 않는다).
// ③ 이미 알린 taskId 는 설치를 가로질러 하나의 집합 — 재진입 뒤 큐 clear ⊕ 같은 taskId 도 다시 안 알린다
//    (큐 `seen` 과 같은 수명·같은 크기 정책: 한 세션 O(100) 건).
const sharedHandled = new Set<string>();
let installed: AgentWakeController | null = null;
// ④ 프로세스 종료 정리는 모듈에 «하나»만 — 재진입마다 beforeExit 리스너가 쌓이지 않게(설치 수와 무관하게 1개).
let exitHookArmed = false;
export function agentWakeBeforeExitHook(): void {
  installed?.dispose();
}

/** 입력칸 문(H2 port)을 감싼다 — 입력칸이 뜰 때마다 «지금 설치된» 깨움에 알린다(port 는 설치보다 먼저 만들어진다). */
export function wrapAgentWakePort(port: TextInputInternalTurnYieldPort): TextInputInternalTurnYieldPort {
  return {
    attach(requestYield) {
      port.attach(requestYield);
      try { installed?.onInputMounted(); } catch { /* fail-soft */ }
    },
    detach(opts) { port.detach(opts); },
    declined(detail) { port.declined?.(detail); },
  };
}

/** 대시보드용 설치 — 앞 설치를 먼저 풀고(구독 정확히 1) 공유 dedupe 집합을 쓴다. */
export function installAgentWake(deps: Omit<AgentWakeDeps, 'handled'>): AgentWakeController {
  installed?.dispose();
  if (!exitHookArmed) {
    exitHookArmed = true;
    process.on('beforeExit', agentWakeBeforeExitHook);
  }
  const ctl = createAgentWake({ ...deps, handled: sharedHandled });
  const own: AgentWakeController = {
    dispose() {
      ctl.dispose();
      if (installed === own) installed = null;
    },
    onInputMounted() { ctl.onInputMounted(); },
  };
  installed = own;
  return own;
}

/** 시험 격리용 — 설치·공유 dedupe 를 비운다. */
export function resetAgentWakeForTest(): void {
  installed?.dispose();
  installed = null;
  sharedHandled.clear();
}
