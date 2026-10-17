// 대시보드 ↔ 외부 주입 대기열(`input/external-input-queue`) 배선. `index.ts` 는 이 함수를 한 번 부르기만 한다.
import type { TextInputExternalSubmitRequest } from '../../chat/index.js';
import { pendingKeyCount } from '../../tui.js';
import type { EscAbortGate } from '../../esc-abort-gate.js';
import {
  renderExternalInputQueueNotice,
  type ExternalInputHost,
} from '../../input/external-input-queue.js';

export interface DashboardExternalInputHostDeps {
  isTurnActive: () => boolean;
  promptCtl: {
    /** 합성 Enter 가 들어갔으면 true · 못 들어갔으면 false(옛 구현은 void). */
    submit?: (request?: string | TextInputExternalSubmitRequest) => boolean | void;
    getBufferText?: () => string;
  };
  /** 채팅 로그에 한 줄(표지)을 남기고 다시 그린다. */
  pushNotice: (line: string) => void;
  /** 외부 입력 대기열의 현재 상태 한 줄을 설정하거나(문면) 지운다(null). */
  setQueueNotice: (line: string | null) => void;
  /** 지금 턴의 ESC 중단 경로(escGate) — 턴 밖이면 null. 외부 `/stop` 이 이것을 부른다. */
  getTurnStop?: () => (() => void) | null;
  /** 미소비 키 수 — 기본 tui.ts 키 큐. */
  pendingKeyCount?: () => number;
}

export function updateDashboardExternalInputQueueNotice(
  lines: string[],
  previousNotice: string | null,
  nextNotice: string | null,
  formatNotice: (notice: string) => string = (notice) => notice,
): boolean {
  const previousLine = previousNotice === null ? null : formatNotice(previousNotice);
  const nextLine = nextNotice === null ? null : formatNotice(nextNotice);
  if (previousLine === nextLine) return false;
  const previousIndex = previousLine === null ? -1 : lines.indexOf(previousLine);
  if (previousIndex >= 0) {
    if (nextLine === null) lines.splice(previousIndex, 1);
    else lines[previousIndex] = nextLine;
  } else if (nextLine !== null) {
    lines.push(nextLine);
  }
  return true;
}

export function createDashboardExternalInputHost(deps: DashboardExternalInputHostDeps): ExternalInputHost {
  // ⚠️ submit/insertAtCursor 는 textInput 이 내려간 뒤에도 남아 있다 — «composer 가 떠 있나»는
  //    getBufferText 유무로만 판단한다(내려가면 undefined).
  const composerLive = (): boolean => typeof deps.promptCtl.getBufferText === 'function';
  return {
    isTurnActive: deps.isTurnActive,
    composerText: () => deps.promptCtl.getBufferText?.(),
    hasPendingKeys: () => (deps.pendingKeyCount ?? pendingKeyCount)() > 0,
    submit: (text, source) => {
      if (!composerLive() || !deps.promptCtl.submit) return false;
      return deps.promptCtl.submit({ text, source }) !== false;
    },
    requestStop: () => {
      const stop = deps.getTurnStop?.() ?? null;
      if (!stop) return false;
      stop();
      return true;
    },
    onExternalStop: (result) => {
      deps.pushNotice(result === 'stopped' ? '⏹ 외부 /stop — 대기열을 건너뛰고 이 턴에 중단을 요청했습니다'
        : result === 'no-turn' ? '⏹ 외부 /stop — 도는 턴이 없어 무시했습니다'
        : '⏹ 외부 /stop — 이 턴의 중단 경로에 닿지 못했습니다(Esc 로 멈춰 주세요)');
    },
    onQueueChange: (pending) => {
      deps.setQueueNotice(renderExternalInputQueueNotice(pending));
    },
  };
}

/**
 * 외부 `/stop` 을 지금 턴의 escGate 에 «Esc 와 같은 경로»로 넘긴다.
 * 자식이 돌아 확인 모달이 뜨면 한 번 더 눌러 확정한다 — 바깥 `/stop` 은 «명시 의지»이고,
 * escGate 자신도 두 번째 Esc 를 «철회가 아니라 의지의 반복»(A2)으로 읽는다.
 */
export function stopTurnViaEscGate(gate: Pick<EscAbortGate, 'handleEscape' | 'isGateOpen'>): void {
  // 이미 확인 모달이 떠 있으면(사용자가 Esc 를 한 번 눌렀다) 한 번이 곧 확정이다.
  const wasOpen = gate.isGateOpen();
  gate.handleEscape();
  if (!wasOpen && gate.isGateOpen()) gate.handleEscape();
}
