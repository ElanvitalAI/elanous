// HAND-RAISE-REPLY-GATE — the seat-mail watcher never reports `responded` / acks a ✋ NEED HUMAN mail the turn did not answer.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { readSeatMailMessages, type SeatReceiptWriter } from './seat-message-receipts.js';
import { handRaiseRepliedOn } from './hand-raise-reply-gate.js';

function universe() {
  const root = mkdtempSync(join(tmpdir(), 'hand-raise-watch-'));
  const seat = 'SIMSEAT';
  const cwd = join(root, 'elanous-hq', 'seats', seat);
  const db = join(root, 'messages.db');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'elanous-hq', 'seat-state', seat), { recursive: true });
  const store = new MsgStore(db);
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const calls: string[] = [];
  const life: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const unanswered: Array<Record<string, unknown>> = [];
  const receipts: SeatReceiptWriter = {
    record: (r) => { calls.push(`record:${r.state}:${r.messageId}`); },
    recordDone: (r) => { calls.push(`done:${r.messageId}`); },
    ack: (r) => { calls.push(`ack:${r.messageId}`); },
  };
  const watcher = createSeatMailArrivalWatcher(cwd, queue, {
    messages: { read: (dir, after) => readSeatMailMessages(dir, after, { home: root, msgPath: db, env: {} }), receipts },
    log: (event) => { logs.push(event); },
    turnLifeLog: (name, data) => { if (name === 'turn-life:event-acked') life.push(data); },
    handRaise: { replied: (q) => handRaiseRepliedOn(store, q), noteUnanswered: (q) => { unanswered.push({ ...q }); } },
  });
  const raise = () => store.post({ from: 'JUD', to: seat, kind: 'request', intent: 'decision', correlationId: 'blk-x-1',
    body: '[✋ NEED HUMAN · JUD] 원장 명령이 필요함', refs: ['block:blk-x-1', 'seat:JUD', 'pane:p1', 'reason:TOOL_DENIED'] });
  return { root, seat, store, queue, watcher, calls, life, logs, unanswered, raise,
    close: () => { watcher.stop(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('✋ answered only with «I will check next time» elsewhere → seen, NOT acked/done, outcome unanswered, handed to the gate', () => {
  const u = universe();
  try {
    u.watcher.poll();
    const raised = u.raise();
    u.watcher.poll();
    expect(u.queue.dequeue().kind).toBe('submit');
    u.store.post({ from: u.seat, to: 'TC', body: '다음 점검에서 확인하겠습니다' });
    u.watcher.noteTurnFinished(true, 'responded');
    expect(u.calls.filter((c) => !c.startsWith('record:delivered'))).toEqual([`record:seen:${raised.id}`]);
    expect(u.life).toEqual([{ eventId: raised.id, msgId: raised.id, itemId: 'q1', source: 'seat-mail', outcome: 'unanswered', state: 'open' }]);
    expect(u.logs).toContain('seat-mail-hand-raise-open');
    expect(u.unanswered).toEqual([{ msgId: raised.id, seat: u.seat, sender: 'JUD', correlationId: 'blk-x-1', reason: 'TOOL_DENIED', arrivedAt: Date.parse(raised.createdAt) }]);
    // Seen: the watcher does not offer it again as a fresh notice.
    u.watcher.poll();
    expect(u.queue.items.filter((i) => i.status === 'queued')).toEqual([]);
  } finally { u.close(); }
});

test('✋ the turn replied to (reply-to the sender) → the normal seen · done · ack · responded path', () => {
  const u = universe();
  try {
    u.watcher.poll();
    const raised = u.raise();
    u.watcher.poll();
    expect(u.queue.dequeue().kind).toBe('submit');
    u.store.post({ from: u.seat, to: 'JUD', body: '다른 방법으로 재개해 주세요.', replyTo: raised.id });
    u.watcher.noteTurnFinished(true, 'responded');
    expect(u.calls.filter((c) => !c.startsWith('record:delivered'))).toEqual([`record:seen:${raised.id}`, `done:${raised.id}`, `ack:${raised.id}`]);
    expect(u.life).toEqual([{ eventId: raised.id, msgId: raised.id, itemId: 'q1', source: 'seat-mail', outcome: 'responded', state: 'seen' }]);
    expect(u.unanswered).toEqual([]);
  } finally { u.close(); }
});

test('an ordinary request mail is unaffected (acked at the turn end without any reply)', () => {
  const u = universe();
  try {
    u.watcher.poll();
    const plain = u.store.post({ from: 'TC', to: u.seat, kind: 'request', intent: 'request', body: 'PR 리뷰 부탁' });
    u.watcher.poll();
    expect(u.queue.dequeue().kind).toBe('submit');
    u.watcher.noteTurnFinished(true, 'responded');
    expect(u.calls.filter((c) => !c.startsWith('record:delivered'))).toEqual([`record:seen:${plain.id}`, `done:${plain.id}`, `ack:${plain.id}`]);
    expect(u.unanswered).toEqual([]);
  } finally { u.close(); }
});
