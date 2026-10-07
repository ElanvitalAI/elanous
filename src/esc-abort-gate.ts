// ESC abort gate — T3-B2.
//
// Bundles the "confirm before aborting a stream when sub-agents are
// running" logic so dashboard.ts's attachChatStreamingKeys stays
// lean and the gate is unit-testable without standing up the full
// dashboard.
//
// Contract:
//
//   • `handleEscape()` — called when the user hits Esc.
//       - If `running === 0` → abortTurnOnly(abortCtrl) immediately.
//
//   ⛔⭐⭐⭐ 2026-08-19 (대표 *"ESC 에 하니스 자식이라던지 sub agent 를 죽이는 일이 없도록"*):
//     ESC 의 취소는 ***`turn-only` 뜻으로*** 나간다. 그래서 이 게이트가 「예」를 받아도
//     ***하니스 자식 goal-loop PTY 와 서브에이전트는 죽지 않는다*** — 도는 턴만 멎는다.
//     자식 수명은 `childLifetimeSignal` 이 «구조»로 갈라 두었다(`turn-abort-scope.ts`).
//     ⇒ 📌 그래서 이 모달은 「자식을 죽일까요」가 아니라 「이 턴을 멈출까요」를 묻는 자리가 된다.
//       - Otherwise, pops an approval modal via `mountModal`; when
//         the user answers yes, calls abortCtrl.abort().
//
//   • `handleKey(ev)` — while `isGateOpen()` returns true, ALL keys
//     route into the modal's handler (y=confirm, n/Esc=keep running).
//     When closed, returns false so the caller handles the key
//     normally.
//
//   • `isGateOpen()` — lets the caller branch their stdin listener.

import {
  createApprovalModal,
  type ApprovalModalHandle,
} from './approval-modal.js';
import type { ModalBounds, ModalSurface } from './display/modal-stack.js';
import type { KeyEvent } from './display/types.js';
import type { ThemeTokens } from './theme/tokens.js';
import { debug } from './debug/log.js';
import { abortTurnOnly } from './turn-abort-scope.js';
import { SELF_IMPLEMENT_TOOL_NAMES } from './boot/daemon-tools/self-implement-names.js';

export const DASHBOARD_CLARIFICATION_REQUEST = Symbol.for('elanous.dashboard.clarification-request');

export interface EscAbortGateDeps {
  abortCtrl: AbortController;
  /** Return the count of running sub-agents. Called at each Escape
   *  so the value is live, not frozen at attach time. */
  getRunningCount: () => number;
  /** Push an ApprovalModalHandle.surface onto the coordinator's
   *  modal stack. Returns a dispose callback that pops it. */
  mountModal: (surface: ModalSurface) => () => void;
  /** Viewport for modal bounds calculation. */
  getViewport: () => { cols: number; rows: number };
  /** Redraw hook so the modal paint appears + disappears promptly. */
  requestRedraw?: () => void;
  /** U3 Bundle B — optional live theme accessor so the abort dialog
   *  can adopt the same static chrome rail as the rest of the UI. */
  getTheme?: () => ThemeTokens | null | undefined;
  /** Names shown/logged while a turn abort request is waiting for running work to unwind. */
  getWaitingTargetNames?: () => readonly string[];
  /** Called before abortTurnOnly so the UI can paint a visible pending state immediately. */
  onAbortPending?: (event: { running: number; repeat: number; targets: readonly string[] }) => void;
  /** Called when another Escape arrives after the first abort request. */
  onAbortRepeat?: (event: { running: number; repeat: number; targets: readonly string[]; phase: 'confirming' | 'pending' }) => void;
  /**
   * ⭐ 턴을 멈추기 «직전»에 부른다 — 살아남을 자식들을 백그라운드 라우팅으로 넘기는 자리.
   *
   * ⛔ 없으면 «고아»가 생긴다: `R1` 이후 자식은 살지만, 포그라운드 라우팅인 채로 끝나면
   *   `task-notification` 이 그 완료를 «안» 실어 나른다(그 큐는 background 만 본다).
   *   턴이 죽어 부모 툴 루프가 사라진 뒤엔 결과를 받을 자가 아무도 없다.
   * ⚠️ 선택적이다 — 미주입이면 종전 동작(넘기지 않음). 테스트·비-대시보드 호출부 보존.
   */
  handoffSurvivingChildren?: () => void;
}

export interface EscAbortGate {
  handleEscape(): void;
  handleKey(ev: KeyEvent): boolean;
  isGateOpen(): boolean;
  /** Reset per-abort-request observation state at turn boundaries or explicit withdrawal. */
  resetAbortRequestState(): void;
  /** Force-close without aborting (tests + dashboard /quit). */
  dispose(): void;
}

/**
 * Route one streaming-window key through the ESC abort gate. A live modal
 * owns every key; otherwise only Escape is considered, after the caller's
 * drag interceptor has had the first chance to consume it.
 */
export async function routeStreamingEscapeKey(
  key: { name: string; kind?: 'press' | 'repeat' | 'release' },
  gate: Pick<EscAbortGate, 'handleEscape' | 'handleKey' | 'isGateOpen'>,
  gateEvent: KeyEvent,
  consumeDragEscape: () => Promise<boolean>,
  consumeTopModalEscape: () => boolean | 'passthrough' = () => false,
): Promise<boolean> {
  if (key.kind && key.kind !== 'press') return false;
  if (key.name === 'escape') {
    const modalResult = consumeTopModalEscape();
    if (modalResult === true) return true;
    if (modalResult === 'passthrough') return false;
  }
  if (gate.isGateOpen()) {
    gate.handleKey(gateEvent);
    return true;
  }
  if (key.name !== 'escape') return false;
  if (await consumeDragEscape()) return true;
  gate.handleEscape();
  return true;
}

export function consumeStreamingTopModalEscape(input: {
  modal: Pick<ModalSurface, 'id' | 'onKey'> | null;
  abortGateModalId: string | null;
  event: KeyEvent;
  question?: { id: string; dispose(cancelled: boolean): void; isClarification: boolean };
  onClarificationClosed(): void;
  topModalId(): string | null;
  redraw(): void;
}): boolean | 'passthrough' {
  const { modal, question } = input;
  if (!modal || modal.id === input.abortGateModalId) return false;
  if (modal.id === question?.id) {
    question.dispose(true);
    if (question.isClarification) input.onClarificationClosed();
    input.redraw();
    return true;
  }
  if (!modal.onKey) return 'passthrough';
  modal.onKey(input.event);
  input.redraw();
  return input.topModalId() === modal.id ? 'passthrough' : true;
}

export function createHarnessEscHint(pushLine: (line: string) => void): (targets: readonly string[]) => boolean {
  let shown = false;
  return (targets) => {
    if (!targets.some(name => (SELF_IMPLEMENT_TOOL_NAMES as readonly string[]).includes(name))) return false;
    if (!shown) {
      pushLine('하니스 런은 따로 계속 돈다 — 멈추려면 /harness stop <space-id> · 목록은 /harness runs');
      shown = true;
    }
    return true;
  };
}

export function createEscAbortGate(deps: EscAbortGateDeps): EscAbortGate {
  let current: ApprovalModalHandle | null = null;
  let currentDispose: (() => void) | null = null;
  let abortPending = false;
  let escapePresses = 0;

  const redraw = (): void => {
    try { deps.requestRedraw?.(); } catch { /* ignore */ }
  };

  const waitingTargets = (): readonly string[] => {
    try { return deps.getWaitingTargetNames?.() ?? []; } catch { return []; }
  };

  const beginAbortPending = (running: number, repeat: number): void => {
    abortPending = true;
    const targets = waitingTargets();
    debug.log('esc.abort', 'abort-requested-pending', { running, repeat, targets });
    try { deps.onAbortPending?.({ running, repeat, targets }); } catch { /* ignore */ }
    redraw();
  };

  const repeatAbortRequest = (running: number, phase: 'confirming' | 'pending'): void => {
    const repeat = Math.max(1, escapePresses - 1);
    const targets = waitingTargets();
    debug.log('esc.abort', 'abort-repeat-waiting', { running, repeat, phase, targets });
    try { deps.onAbortRepeat?.({ running, repeat, phase, targets }); } catch { /* ignore */ }
    redraw();
  };

  const resetAbortRequestState = (): void => {
    abortPending = false;
    escapePresses = 0;
  };

  const abortPendingTurn = (running: number): void => {
    beginAbortPending(running, Math.max(0, escapePresses - 1));
    deps.handoffSurvivingChildren?.();   // ⛔ abort «전»에 — 고아 방지(위 dep 주석)
    abortTurnOnly(deps.abortCtrl);
  };

  const close = (): void => {
    if (currentDispose) {
      try { currentDispose(); } catch { /* ignore */ }
    }
    current = null;
    currentDispose = null;
    redraw();
  };

  return {
    handleEscape(): void {
      escapePresses += 1;
      if (abortPending) {
        repeatAbortRequest(deps.getRunningCount(), 'pending');
        return;
      }
      if (current) {
        // ⛔⭐⭐⭐ `A2`(2026-08-19 · 대표 지시) — ***두 번째 Esc 는 「철회」가 아니라 «의지의 반복»이다.***
        //   📏 종전 실측: 버튼이 `[ Abort (y) ] [ Keep (n/Esc) ]` 라 Esc 가 «Keep» 에 묶여 있었고,
        //     ***ESC 를 연타하면 모달이 열렸다 닫혔다만 반복하고 턴이 «영원히» 안 죽었다***(5회 실측).
        //   ⇒ 📌 사용자가 ESC 를 두 번 누르는 것은 «더 세게 멈추려는 것»이다. 철회는 `n` 으로 «명시»한다.
        debug.log('esc.abort', 'confirm-by-repeat', { decision: 'abort', repeat: Math.max(1, escapePresses - 1) });
        repeatAbortRequest(deps.getRunningCount(), 'confirming');
        current.dispose(true);
        return;
      }
      const running = deps.getRunningCount();
      if (running <= 0) {
        debug.log('esc.abort', 'abort-immediately', { running, repeat: Math.max(0, escapePresses - 1) });
        abortPendingTurn(running);
        return;
      }
      debug.log('esc.abort', 'open-confirmation', { running });
      const { cols, rows } = deps.getViewport();
      const width = Math.min(50, Math.max(34, cols - 6));
      const height = 7;
      const bounds: ModalBounds = {
        row: Math.max(1, Math.floor((rows - height) / 2)),
        col: Math.max(1, Math.floor((cols - width) / 2)),
        width,
        height,
      };
      const handle = createApprovalModal({
        id: `esc-abort:${Date.now().toString(36)}`,
        bounds,
        // ⛔⭐⭐ 문면을 «참»으로 되돌린다 — `R1`(취소 축 가르기) 이후 종전 문면은 «거짓»이다.
        //   종전: *"This will cancel their in-flight tool calls."*
        //   ⇒ 이제 ESC 는 `turn-only` 로 나가므로 ***자식의 in-flight 는 «취소되지 않는다»***.
        //     그대로 두면 도구가 사용자에게 거짓을 말하고, 사용자는 멈출 수 있는데도 안 멈춘다.
        title: 'Stop this turn?',
        prompt: `${running} sub-agent${running > 1 ? 's' : ''} still running`,
        detail: 'Sub-agents keep running — only this turn stops.',
        yesLabel: 'Stop turn (y/Esc)',
        noLabel: 'Keep going (n)',
        theme: deps.getTheme?.() ?? undefined,
      });
      current = handle;
      currentDispose = deps.mountModal(handle.surface);
      redraw();
      handle.promise.then((yes) => {
        const wasCurrent = current;
        close();
        if (yes && wasCurrent) {
          abortPendingTurn(deps.getRunningCount());
        } else {
          resetAbortRequestState();
        }
      });
    },
    handleKey(ev: KeyEvent): boolean {
      if (!current) return false;
      // ⛔⭐ `A2` — 공용 `approval-modal` 은 escape 를 «no» 로 해석한다(그 계약은 다른 모달들이 쓴다).
      //   ⇒ ***여기서만*** 가로채 「반복 = 중단」으로 읽는다. 공용 모듈의 의미를 바꾸지 않는다.
      if ((ev.name ?? '').toLowerCase() === 'escape') {
        escapePresses += 1;
        debug.log('esc.abort', 'confirm-by-repeat', {
          decision: 'abort', via: 'handleKey', repeat: Math.max(1, escapePresses - 1),
        });
        repeatAbortRequest(deps.getRunningCount(), 'confirming');
        current.dispose(true);
        return true;
      }
      current.handleKey(ev);
      return true;
    },
    isGateOpen(): boolean {
      return current !== null;
    },
    resetAbortRequestState(): void {
      resetAbortRequestState();
    },
    dispose(): void {
      if (current) current.dispose(false);
      resetAbortRequestState();
      close();
    },
  };
}
