// SEAT-CAP-RESUME-NOTICE(연속 큐 미재개 · ELN-DOGFOOD 11-16 23:42) — 자리 턴 상한 소진 마감 직전
// run-goal-loop 가 onSeatCapExhausted 를 발화하면, 해당 자리 우편함(SQLite 원장 MsgPost 와 동일 경로)에
// 재개 안내 우편을 남긴다.
//
// 설계 경계(e3cd96b01d — 같은 루프 reinject 제거 존중): 이 모듈은 «우편 원장에 재개 알림 남김 + 관측 로그»
// 까지가 최소 수리 범위다. 우편 자체는 next-mail-wake(autowake 동의 파일이 있을 때 미읽음 우편으로 자리 TUI 턴을
// 여는 저장소 기존 훅)를 통해 다음 자리 턴 재개로 이어질 수 있다 — 이 모듈은 그 훅을 건드리지 않는다.

import { debug } from '../debug/log.js';
import { dispatchMsgPost, type MsgLedgerDeps } from '../skills/tools/ops-ledger.js';
import { SEAT_TURN_CAP_CONTINUE_PROMPT, seatCapCheckpoint } from './seat-turn-cap.js';

export interface SeatCapResumeNoticeDeps extends MsgLedgerDeps {
  /** Observation sink override for tests. */
  log?: (category: string, event: string, data: Record<string, unknown>, opts?: { level: 'info' | 'warn' }) => void;
}

/** runGoalLoop 의 onSeatCapExhausted 에 그대로 연결할 수 있는 1회용 재개 안내 발송기.
 *  from 은 시스템(OP) — 상한 마감을 관측한 주체가 안내를 남긴다. 원장 쓰기가 async 이므로 Promise 를 반환한다. */
export function postSeatCapResumeNotice(deps: SeatCapResumeNoticeDeps = {}): (info: { seat: string; finalText: string; iterations: number }) => Promise<void> {
  const log = deps.log ?? ((category: string, event: string, data: Record<string, unknown>, opts?: { level: 'info' | 'warn' }) => debug.log(category, event, data, opts));
  return async (info) => {
    // 진행 요약(finalText)을 본문에 넣는다. 재개 깨움은 우편 번호만 치고, 다음 턴이 msg list 로 이 본문을 읽는다.
    const body = `[SEAT TURN CAP] ${info.seat} 자리 턴이 상한(도구 수 또는 벽시계)에 닿아 마감됐다(반복 ${info.iterations}회). `
      + SEAT_TURN_CAP_CONTINUE_PROMPT
      + seatCapCheckpoint(info.finalText);
    try {
      // dispatchMsgPost 는 async(SQLite 원장)다 — 완료를 기다린 뒤 관측 로그를 남긴다.
      const posted = await dispatchMsgPost({ from: 'OP', to: info.seat, body, kind: 'seat-cap-resume' }, deps);
      log('goal.loop', 'seat-cap-resume-notice-posted', {
        seat: info.seat, iterations: info.iterations,
        messageId: posted?.message?.id ?? null,
        bodyChars: body.length,
      }, { level: 'warn' });
    } catch (error) {
      // 안내 실패가 자리 턴 마감을 되돌리지 않는다(fail-soft).
      log('goal.loop', 'seat-cap-resume-notice-failed', { seat: info.seat, error: String(error) }, { level: 'warn' });
    }
  };
}
