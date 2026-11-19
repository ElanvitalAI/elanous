/**
 * [seat-mail #14 wiring] MAIL-RECEIPT-SEEN-STARTED-DONE — 3계기(seen · started · done) 기록 깔때기.
 *
 * 계약(#38869 API 조각 위 배선 단계):
 *  - orphan guard: 원장(msg-receipts.ts recordReceiptOn §4a 패턴)처럼 msg_messages에 없는 id 는
 *    조용히 거짓을 돌려주고 clock 행을 만들지 않는다(unknown id 로 orphan clock 행이 늘어나는 JUD-B FU 방지).
 *  - fail-soft: clock 기록 실패가 영수증 본경로(recordReceiptOn)를 막지 않는다. 관측은 debug.log.
 *  - 이중 기록 무해: msg_receipt_clocks upsert 는 멱등(첫 기록 보존)이므로 여러 경로가 겹쳐도 안전.
 */
import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { ensureReceiptClocksTable, markMessageDone, markMessageSeen, markMessageStarted } from './msg-receipt-clocks.js';

/** clock 이벤트 종류 — 수신 상태기(state)와 달리 계기 이름을 그대로 쓴다. */
export type ReceiptClockEvent = 'seen' | 'started' | 'done';

export interface ReceiptClockSinkInput {
  messageId: number;
  recipient: string;
  event: ReceiptClockEvent;
  /** started 계기의 시작 이벤트 식별자(생략 가능). */
  eventId?: string | null;
}

/**
 * 한 계기를 기록한다. 메시지가 원장에 없으면(unknown id) 기록하지 않고 false. 실패해도 던지지 않는다.
 * 반환: 기록 성공 true · orphan(false) · 내부 실패(false — debug 로그로 관측).
 */
export function recordReceiptClock(db: Database, input: ReceiptClockSinkInput): boolean {
  const failSoft = (event: string, error: unknown): false => {
    try { debug.log('msg.receipt-clock-sink', event, { ...input, error: String(error) }); } catch { /* observability is fail-open */ }
    return false;
  };
  try {
    // §4a orphan guard — msg_messages 없는 id 에는 clock 행을 만들지 않는다.
    const message = db.query('SELECT recipient FROM msg_messages WHERE id = ?').get(input.messageId) as { recipient: string } | null;
    if (message === null) return false;
    ensureReceiptClocksTable(db);
    if (input.event === 'seen') markMessageSeen(db, input.messageId, input.recipient);
    else if (input.event === 'started') markMessageStarted(db, input.messageId, input.recipient, input.eventId ?? null);
    else markMessageDone(db, input.messageId, input.recipient);
    return true;
  } catch (error) {
    return failSoft('record-failed', error);
  }
}
