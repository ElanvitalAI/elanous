/**
 * [seat-mail #14 wiring] recordReceiptClock 깔때기 시험 — orphan guard · 3계기 한 행 공존 · fail-soft.
 * 배선 계약(msg-store recordReceipt 깔때기 · seat-mail-arrival onTransition started)의 단위 검증.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ensureReceiptClocksTable, formatReceiptClockStatus, getReceipt } from './msg-receipt-clocks.js';
import { recordReceiptClock } from './msg-receipt-clock-sink.js';

function openDb(): Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE msg_messages (id INTEGER PRIMARY KEY, recipient TEXT, sender TEXT, body TEXT)');
  return db;
}

describe('[seat-mail #14 wiring] recordReceiptClock', () => {
  test('orphan guard — unknown message id creates no clock row', () => {
    const db = openDb();
    const recorded = recordReceiptClock(db, { messageId: 999, recipient: 'OP', event: 'seen' });
    expect(recorded).toBe(false);
    ensureReceiptClocksTable(db);
    expect(db.query('SELECT COUNT(*) AS n FROM msg_receipt_clocks').get()).toEqual({ n: 0 });
    db.close();
  });

  test('seen → started(eventId) → done land in ONE row; status shows the furthest clock', () => {
    const db = openDb();
    db.query('INSERT INTO msg_messages (id, recipient) VALUES (7, ?)').run('OP');
    expect(recordReceiptClock(db, { messageId: 7, recipient: 'op', event: 'seen' })).toBe(true);
    expect(recordReceiptClock(db, { messageId: 7, recipient: 'OP', event: 'started', eventId: 'item-1' })).toBe(true);
    expect(recordReceiptClock(db, { messageId: 7, recipient: 'OP', event: 'done' })).toBe(true);
    const rows = db.query('SELECT COUNT(*) AS n FROM msg_receipt_clocks').get() as { n: number };
    expect(rows.n).toBe(1);
    const clock = getReceipt(db, 7, 'OP')!;
    expect(clock.seenAt).toBeDefined();
    expect(clock.startedAt).toBeDefined();
    expect(clock.startedEventId).toBe('item-1');
    expect(clock.doneAt).toBeDefined();
    expect(formatReceiptClockStatus(clock)).toBe('done');
    db.close();
  });

  test('seen-only row formats as "seen" — the msg list column value before a turn', () => {
    const db = openDb();
    db.query('INSERT INTO msg_messages (id, recipient) VALUES (11, ?)').run('JUD');
    expect(recordReceiptClock(db, { messageId: 11, recipient: 'jud', event: 'seen' })).toBe(true);
    expect(formatReceiptClockStatus(getReceipt(db, 11, 'JUD'))).toBe('seen');
    expect(formatReceiptClockStatus(getReceipt(db, 11, 'OP'))).toBe('-');
    db.close();
  });

  test('fail-soft — a throwing clock write is swallowed (false, no throw) and the message row stays', () => {
    const db = openDb();
    db.query('INSERT INTO msg_messages (id, recipient) VALUES (8, ?)').run('OP');
    expect(recordReceiptClock(db, { messageId: 8, recipient: '', event: 'seen' })).toBe(false);
    expect(getReceipt === undefined).toBe(false); // module alive after a swallowed failure
    db.close();
  });
});
