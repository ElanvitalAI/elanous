/**
 * Seat-mail arrival wiring, pulled out of entry.ts so the busy/idle door is a seam.
 * A notice that lands while a turn is running stays queued. The idle door (injectKey)
 * opens only when nothing is running. This path never offers the running turn a steer.
 *
 * OP #106762 ⓐ — a mail that lands during a busy turn carries its real notice text
 * (본문 원문 · msgId · 보낸 자리) into the mid-turn event box; when that event is drained
 * into the model input, the queued notice is removed from the original queue, so the
 * same msgId surfaces exactly once per session and nothing re-opens a later turn.
 */

import { emitTurnLife } from '../debug/turn-life.js';
import type { SeatMailArrivalInfo } from './seat-mail-arrival.js';

export interface SeatMailOnArrivedDeps {
  busy: () => boolean;
  injectKey: (key: unknown) => boolean | void;
  queueWake: unknown;
  /**
   * SEAT-TURN-MIDTURN-MAIL 어댑터 — 턴 중 도착은 이벤트함에 한 건(id = ledger msgId).
   * `onDrained` 는 그 건이 배수될 때 불린다(원본 큐에서 이 노티스를 지우는 뒷정리 · fail-open).
   */
  enqueueMidTurn?: (event: { kind: string; id: string; text: string; from?: string; intent?: string | null }, onDrained?: () => void) => boolean;
  /** OP #106762 ⓐ — 배수된 사건의 대기 큐 노티스를 지운다(fail-open · 지운 건수를 돌려준다). */
  removeQueuedNotice?: (match: { source: string; msgId?: number; text?: string }) => number;
}

export function seatMailOnArrived(deps: SeatMailOnArrivedDeps): (arrivals?: readonly SeatMailArrivalInfo[]) => void {
  return (arrivals) => {
    if (deps.busy()) {
      // OBSERVE-TURN-EVENT-LIFECYCLE — 바쁜 턴: 원문은 이벤트함에, 큐 노티스는 배수 때 지운다(이 모듈은 관측만).
      const msgIds = (arrivals ?? []).flatMap((arrival) => (arrival.msgId === undefined ? [] : [arrival.msgId]));
      try {
        emitTurnLife('turn-life:event-while-busy', { source: 'seat-mail', action: 'wait', ...(msgIds.length === 0 ? {} : { msgIds }) });
      } catch { /* observability is fail-open */ }
      for (const arrival of arrivals ?? []) {
        // 수 모드 노티스엔 msgId 가 없다 — 세션 1회 계약을 못 세우니 턴 끝 노크에 맡긴다.
        if (arrival.msgId === undefined) continue;
        // JUD security HOLD: no sender (OP · 대표) preempts — `--from` is not authenticated. Every mail, decisions
        // included, rides the same mid-turn event box in arrival (msgId) order.
        deps.enqueueMidTurn?.(
          { kind: 'seat-mail', id: String(arrival.msgId), text: arrival.text,
            ...(arrival.sender === undefined ? {} : { from: arrival.sender }), ...(arrival.intent === undefined ? {} : { intent: arrival.intent }) },
          deps.removeQueuedNotice === undefined ? undefined : () => { deps.removeQueuedNotice?.({ source: 'seat-mail', msgId: arrival.msgId }); },
        );
      }
      return;
    }
    deps.injectKey(deps.queueWake);
  };
}
