// [SEAT-MAIL-ACK-SLA FU] done 계기 배선 검증 — writer 기능(원장 done_at) + 도착 배선 리터럴.
import { describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedgerReceiptWriter } from './seat-message-receipts.js';
import { MsgStore } from '../msg/msg-store.js';

const ARRIVAL = readFileSync(new URL('./seat-mail-arrival.ts', import.meta.url), 'utf8');
const RECEIPTS = readFileSync(new URL('./seat-message-receipts.ts', import.meta.url), 'utf8');

describe('done receipt wiring [literal]', () => {
  test('seat-message-receipts writer implements recordDone via the clock sink funnel', () => {
    expect(RECEIPTS.includes('recordDone(input: SeatReceiptDoneWrite)')).toBe(true);
    expect(RECEIPTS.includes("event: 'done'")).toBe(true);
  });
  test('seat-mail-arrival noteTurnFinished records done alongside seen', () => {
    expect(ARRIVAL.includes('receipts?.recordDone?.({ messageId: mapped.msgId, recipient: mapped.seat })')).toBe(true);
  });
});

describe('done receipt wiring [functional]', () => {
  test('recordDone writes done_at on the clocks row (idempotent, first write preserved)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'done-clock-'));
    const dbPath = join(dir, 'messages.db');
    const store = new MsgStore(dbPath);
    const id = (store.post({ from: 'OP', to: 'HAND-TUI-E', body: 'wiring probe' }) as { id: number }).id;
    const writer = createLedgerReceiptWriter(dbPath);
    writer.recordDone?.({ messageId: id, recipient: 'HAND-TUI-E' });
    const row = store.db.query('SELECT seen_at, started_at, done_at FROM msg_receipt_clocks WHERE message_id = ? AND recipient = ?').get(id, 'HAND-TUI-E') as any;
    expect(row.done_at).toBeTruthy();
    expect(row.seen_at).toBeNull(); // done 계기는 clock 전용 — 수신 상태기(msg_receipts)를 오염하지 않는다
    const first = row.done_at;
    writer.recordDone?.({ messageId: id, recipient: 'HAND-TUI-E' }); // 멱등 — 첫 기록 보존
    const row2 = store.db.query('SELECT done_at FROM msg_receipt_clocks WHERE message_id = ? AND recipient = ?').get(id, 'HAND-TUI-E') as any;
    expect(row2.done_at).toBe(first);
    store.close();
  });
});
