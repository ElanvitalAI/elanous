/**
 * [seat-mail #14] MAIL-RECEIPT-SEEN-STARTED-DONE — msg 수신 영수증 3계기(seen · started · done) 순수 기록 모듈.
 *
 * 설계: 표 1행 = (message_id, recipient) 1쌍. seen_at · started_at+started_event_id · done_at 세 계기가
 * 그 한 행에 공존하며, 각 mark* 호출은 해당 계기만 upsert 한다(첫 기록 우선 — 재기록은 타임스탬프를
 * 갱신하지 않고 행을 늘리지도 않는다).
 *
 * 배선 금지: 이 모듈은 기록 API + 상태 문자열 포맷터만 제공한다. TUI 큐 진입(seen) · 턴 시작(started) ·
 * 턴 종료(done) 배선은 사후 승인 단계에서 연결한다(미션 계약: 기록 API 제공, 배선 금지).
 *
 * 표명 주: 미션 설계 명칭은 `msg_receipts`였으나 그 표명은 SEAT-INBOX B1-C 수신 영수증 상태기
 * (부록형 receipt 스키마, PK id · UNIQUE(message_id, recipient, state))가 이미 점유 중이라
 * 스키마 충돌 없이 공존하는 이름 `msg_receipt_clocks`로 정했다.
 */
import type { Database } from 'bun:sqlite';

export const MSG_RECEIPT_CLOCKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS msg_receipt_clocks (
  message_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  seen_at TEXT,
  started_at TEXT,
  started_event_id TEXT,
  done_at TEXT,
  PRIMARY KEY(message_id, recipient)
);
CREATE INDEX IF NOT EXISTS idx_msg_receipt_clocks_recipient ON msg_receipt_clocks(recipient);
`;

/** msg 원장 스토어 패턴 준수: 열린 db에 이 모듈의 스키마를 멱등 적용한다. */
export function ensureReceiptClocksTable(db: Database): void {
  db.exec(MSG_RECEIPT_CLOCKS_SCHEMA);
}

/** 3계기 영수증 행 — 타임스탬프는 ISO-8601 문자열, 미기록 계기는 필드 자체를 생략한다. */
export interface ReceiptClocks {
  messageId: number;
  recipient: string;
  seenAt?: string;
  startedAt?: string;
  startedEventId?: string;
  doneAt?: string;
}

export interface MarkClockOptions {
  /** 시간 표기: msg-store 패턴 — 주입 가능한 시계(시험 고정 시각용). 기본 실제 현재 시각. */
  now?: () => Date;
}

interface ReceiptClockRow {
  message_id: number;
  recipient: string;
  seen_at: string | null;
  started_at: string | null;
  started_event_id: string | null;
  done_at: string | null;
}

function validateKey(messageId: number, recipient: string): void {
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error(`invalid message id: ${messageId}`);
  if (typeof recipient !== 'string' || recipient.trim() === '') throw new TypeError('recipient must be a non-empty string');
}

function rowToReceiptClocks(row: ReceiptClockRow): ReceiptClocks {
  return {
    messageId: row.message_id,
    recipient: row.recipient,
    ...(row.seen_at === null ? {} : { seenAt: row.seen_at }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.started_event_id === null || row.started_event_id === undefined ? {} : { startedEventId: row.started_event_id }),
    ...(row.done_at === null ? {} : { doneAt: row.done_at }),
  };
}

/**
 * 한 계기 upsert — ON CONFLICT(message_id, recipient)로 행을 늘리지 않고, COALESCE 로 첫 기록을
 * 보존한다(재기록 = 멱등). 원장 스토어 패턴 준수: 쓰기는 immediate 트랜잭션으로 직렬화.
 */
function upsertClock(
  db: Database,
  messageId: number,
  recipient: string,
  setClock: () => { column: string; value: string | null },
): void {
  const { column, value } = setClock();
  const write = (): void => {
    db.query(
      `INSERT INTO msg_receipt_clocks(message_id, recipient, ${column}) VALUES (?, ?, ?)
       ON CONFLICT(message_id, recipient) DO UPDATE SET ${column} = COALESCE(msg_receipt_clocks.${column}, excluded.${column})`,
    ).run(messageId, recipient, value);
  };
  db.inTransaction ? write() : db.transaction(write).immediate();
}

/** ① seen 계기: 수신자가 메시지를 봤다(TUI 큐 진입 지점 배선용 — 지금은 API만 제공). */
export function markMessageSeen(db: Database, messageId: number, recipient: string, options: MarkClockOptions = {}): ReceiptClocks {
  validateKey(messageId, recipient);
  const seenAt = (options.now ?? (() => new Date()))().toISOString();
  upsertClock(db, messageId, recipient.trim().toUpperCase(), () => ({ column: 'seen_at', value: seenAt }));
  return getReceipt(db, messageId, recipient)!;
}

/** ② started 계기: 수신자의 턴이 시작됐다. started_event_id 는 시작 이벤트 식별자(생략 가능 = nullable). */
export function markMessageStarted(
  db: Database,
  messageId: number,
  recipient: string,
  eventId?: string | null,
  options: MarkClockOptions = {},
): ReceiptClocks {
  validateKey(messageId, recipient);
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const write = (): void => {
    db.query(
      `INSERT INTO msg_receipt_clocks(message_id, recipient, started_at, started_event_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id, recipient) DO UPDATE SET
         started_at = COALESCE(msg_receipt_clocks.started_at, excluded.started_at),
         started_event_id = COALESCE(msg_receipt_clocks.started_event_id, excluded.started_event_id)`,
    ).run(messageId, recipient.trim().toUpperCase(), startedAt, eventId ?? null);
  };
  db.inTransaction ? write() : db.transaction(write).immediate();
  return getReceipt(db, messageId, recipient)!;
}

/** ③ done 계기: 수신자의 턴(그 메시지에 대한 처리)이 끝났다. */
export function markMessageDone(db: Database, messageId: number, recipient: string, options: MarkClockOptions = {}): ReceiptClocks {
  validateKey(messageId, recipient);
  const doneAt = (options.now ?? (() => new Date()))().toISOString();
  upsertClock(db, messageId, recipient.trim().toUpperCase(), () => ({ column: 'done_at', value: doneAt }));
  return getReceipt(db, messageId, recipient)!;
}

/** 미기록이면 null. */
export function getReceipt(db: Database, messageId: number, recipient: string): ReceiptClocks | null {
  validateKey(messageId, recipient);
  const row = db.query(
    'SELECT message_id, recipient, seen_at, started_at, started_event_id, done_at FROM msg_receipt_clocks WHERE message_id = ? AND recipient = ?',
  ).get(messageId, recipient.trim().toUpperCase()) as ReceiptClockRow | null;
  return row === null ? null : rowToReceiptClocks(row);
}

/** 수신자 필터 목록 — recipient 생략 시 전체. message_id 오름차순. */
export function listReceipts(db: Database, recipient?: string): ReceiptClocks[] {
  const rows = (recipient === undefined
    ? db.query('SELECT message_id, recipient, seen_at, started_at, started_event_id, done_at FROM msg_receipt_clocks ORDER BY message_id ASC')
    : db.query('SELECT message_id, recipient, seen_at, started_at, started_event_id, done_at FROM msg_receipt_clocks WHERE recipient = ? ORDER BY message_id ASC')
  ).all(...(recipient === undefined ? [] : [recipient.trim().toUpperCase()])) as ReceiptClockRow[];
  return rows.map(rowToReceiptClocks);
}

/**
 * msg-list 상태 열 표시용 상태 문자열 조립(부가 포맷터 — msg-cli.ts 편집 금지 계약).
 * 진행 계기: done > started > seen 중 가장 먼 계기 하나. 미기록행은 '-'.
 */
export function formatReceiptClockStatus(clock: ReceiptClocks | null): string {
  if (clock === null) return '-';
  if (clock.doneAt !== undefined) return 'done';
  if (clock.startedAt !== undefined) return clock.startedEventId === undefined ? 'started' : `started:${clock.startedEventId}`;
  if (clock.seenAt !== undefined) return 'seen';
  return '-';
}
