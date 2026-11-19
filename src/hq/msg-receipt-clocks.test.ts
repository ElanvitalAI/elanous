import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  ensureReceiptClocksTable,
  formatReceiptClockStatus,
  getReceipt,
  listReceipts,
  markMessageDone,
  markMessageSeen,
  markMessageStarted,
} from './msg-receipt-clocks.js';

const SEEN_AT = new Date('2026-11-18T01:00:00.000Z');
const STARTED_AT = new Date('2026-11-18T02:00:00.000Z');
const DONE_AT = new Date('2026-11-18T03:00:00.000Z');
const REPLAY_AT = new Date('2026-11-18T04:00:00.000Z');
const at = (date: Date): { now: () => Date } => ({ now: () => date });

describe('[seat-mail #14] msg 수신 영수증 3계기 (seen · started · done)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureReceiptClocksTable(db);
    db.query('SELECT 1').get();
  });
  afterEach(() => db.close(true));

  test('① seen 기록 — markMessageSeen 은 seen_at 을 남긴다', () => {
    const receipt = markMessageSeen(db, 101, 'TC-H-POOL-2', at(SEEN_AT));
    expect(receipt).toEqual({ messageId: 101, recipient: 'TC-H-POOL-2', seenAt: SEEN_AT.toISOString() });
    expect(getReceipt(db, 101, 'TC-H-POOL-2')).toEqual(receipt);
  });

  test('② started 기록 — started_at + started_event_id 함께', () => {
    const receipt = markMessageStarted(db, 102, 'OP', 'evt-42', at(STARTED_AT));
    expect(receipt).toEqual({ messageId: 102, recipient: 'OP', startedAt: STARTED_AT.toISOString(), startedEventId: 'evt-42' });
  });

  test('③ done 기록 — done_at 남긴다', () => {
    const receipt = markMessageDone(db, 103, 'MK', at(DONE_AT));
    expect(receipt).toEqual({ messageId: 103, recipient: 'MK', doneAt: DONE_AT.toISOString() });
  });

  test('④ seen→started→done 순차 전이 — 한 행에 3계기 공존', () => {
    markMessageSeen(db, 104, 'TC', at(SEEN_AT));
    const started = markMessageStarted(db, 104, 'TC', 'evt-start', at(STARTED_AT));
    expect(formatReceiptClockStatus(started)).toBe('started:evt-start');
    const done = markMessageDone(db, 104, 'TC', at(DONE_AT));
    expect(done).toEqual({
      messageId: 104, recipient: 'TC',
      seenAt: SEEN_AT.toISOString(), startedAt: STARTED_AT.toISOString(), startedEventId: 'evt-start', doneAt: DONE_AT.toISOString(),
    });
    expect(formatReceiptClockStatus(done)).toBe('done');
    const rowCount = (db.query('SELECT COUNT(*) AS n FROM msg_receipt_clocks').get() as { n: number }).n;
    expect(rowCount).toBe(1);
  });

  test('⑤ 동일 (message_id, recipient) 재기록 = upsert — 중복행 없음, 첫 기록 보존', () => {
    markMessageSeen(db, 105, 'TC', at(SEEN_AT));
    markMessageSeen(db, 105, 'TC', at(REPLAY_AT));
    markMessageDone(db, 105, 'TC', at(REPLAY_AT));
    const rows = (db.query('SELECT seen_at FROM msg_receipt_clocks WHERE message_id = 105 AND recipient = \'TC\'').all()) as { seen_at: string | null }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.seen_at).toBe(SEEN_AT.toISOString());
    expect(getReceipt(db, 105, 'tc')?.doneAt).toBe(REPLAY_AT.toISOString());
  });

  test('⑥ getReceipt — 3계기 통합 조회', () => {
    markMessageSeen(db, 106, 'UX', at(SEEN_AT));
    markMessageStarted(db, 106, 'UX', 'evt-106', at(STARTED_AT));
    markMessageDone(db, 106, 'UX', at(DONE_AT));
    expect(getReceipt(db, 106, 'UX')).toEqual({
      messageId: 106, recipient: 'UX',
      seenAt: SEEN_AT.toISOString(), startedAt: STARTED_AT.toISOString(), startedEventId: 'evt-106', doneAt: DONE_AT.toISOString(),
    });
  });

  test('⑦ listReceipts — 수신자 필터', () => {
    markMessageSeen(db, 107, 'OP', at(SEEN_AT));
    markMessageSeen(db, 108, 'MK', at(SEEN_AT));
    const all = listReceipts(db);
    expect(all.map(r => [r.messageId, r.recipient])).toEqual([[107, 'OP'], [108, 'MK']]);
    const only = listReceipts(db, 'op');
    expect(only.length).toBe(1);
    expect(only[0]!.recipient).toBe('OP');
    expect(listReceipts(db, 'TC')).toEqual([]);
  });

  test('⑧ 미기록 — getReceipt null · listReceipts 빈', () => {
    expect(getReceipt(db, 999, 'OP')).toBe(null);
    expect(listReceipts(db)).toEqual([]);
    expect(listReceipts(db, 'OP')).toEqual([]);
    expect(formatReceiptClockStatus(null)).toBe('-');
  });

  test('⑨ started_event_id nullable — eventId 생략 시 NULL', () => {
    const receipt = markMessageStarted(db, 109, 'TC', undefined, at(STARTED_AT));
    expect(receipt).toEqual({ messageId: 109, recipient: 'TC', startedAt: STARTED_AT.toISOString() });
    const raw = db.query('SELECT started_event_id FROM msg_receipt_clocks WHERE message_id = 109').get() as { started_event_id: string | null };
    expect(raw.started_event_id).toBe(null);
    expect(formatReceiptClockStatus(receipt)).toBe('started');
  });
});
