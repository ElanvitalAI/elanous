// 대시보드 ↔ 외부 주입 대기열(`input/external-input-queue`) 배선. `index.ts` 는 이 함수를 한 번 부르기만 한다.
import type { TextInputExternalSubmitRequest } from '../../chat/index.js';
import { pendingKeyCount } from '../../tui.js';
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
  /** 미소비 키 수 — 기본 tui.ts 키 큐. */
  pendingKeyCount?: () => number;
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
    onQueueChange: (pending, event) => {
      if (event === 'queued') {
        const notice = renderExternalInputQueueNotice(pending);
        if (notice) deps.pushNotice(notice);
        return;
      }
      deps.pushNotice(pending.length > 0
        ? `⤵ 외부 입력 1건 전송 · 남은 대기 ${pending.length}건`
        : '⤵ 외부 입력 1건 전송');
    },
  };
}
