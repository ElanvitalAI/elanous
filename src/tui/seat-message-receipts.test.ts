// SEAT-INBOX B1-C §3a·§4a — Next TUI 수신 쪽: 메시지 한 통 = notice 한 항목(msgId) · delivered(적입) → seen(큐 delivered).
// 진짜 createNextTuiQueue(로그 조용) ⊕ :memory: 원장 ⊕ 가짜 읽기(폴링 타이머 0 — poll() 을 직접 부른다).
import { afterEach, expect, test } from 'bun:test';
import { createNextTuiQueue } from './core/queue.js';
import { seatMessageNotice } from './core/notice-producers.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { readSeatMailMessages, seatMailMessageOf, type SeatMailMessageRead, type SeatReceiptWriter } from './seat-message-receipts.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';

const SEAT = 'TC';
const BODY = '구현 시작 — inbox-b1c 본문';
const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new MsgStore(':memory:');
  stores.push(store);
  const queue = createNextTuiQueue({ log: () => {} });
  const writer: SeatReceiptWriter = {
    record: (input) => { store.recordReceipt({ ...input, source: 'tui-queue' }); },
  };
  let reads = 0;
  const read = (_cwd: string, afterId: number): SeatMailMessageRead => {
    reads += 1;
    return { seat: SEAT, messages: store.listByRecipient(SEAT, afterId).map(seatMailMessageOf) };
  };
  const watcher = createSeatMailArrivalWatcher('/h', queue, { messages: { read, receipts: writer } });
  return { store, queue, watcher, reads: () => reads };
}

const states = (store: MsgStore, id: number) => store.listReceipts({ messageId: id }).map(r => r.state);

test('도착 → 메시지마다 notice(msgId) · delivered 기록 · 큐 delivered → seen 기록 ⊕ 호환 ack', () => {
  const { store, queue, watcher } = fixture();
  expect(watcher.poll()).toEqual({ kind: 'baseline', unread: 0 });
  const first = store.post({ from: 'OP', to: SEAT, body: BODY, kind: 'question' });
  const second = store.post({ from: 'RES', to: SEAT, body: `${BODY} 2` });
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [first.id, second.id] });
  expect(queue.items.map(item => ({ kind: item.kind, source: item.source, msgId: item.msgId, text: item.text }))).toEqual([
    { kind: 'notice', source: 'seat-mail', msgId: first.id, text: seatMessageNotice({ id: first.id, sender: 'OP', kind: 'question', body: BODY }) },
    { kind: 'notice', source: 'seat-mail', msgId: second.id, text: seatMessageNotice({ id: second.id, sender: 'RES', kind: null, body: `${BODY} 2` }) },
  ]);
  expect(states(store, first.id)).toEqual(['posted', 'delivered']);
  expect(store.listReceipts({ messageId: first.id }).at(-1)!.queueItemId).toBe(queue.items[0]!.id);
  expect(store.unreadCount(SEAT)).toBe(2);
  // 유휴 경계 — 큐가 꺼내면(status delivered) 그 순간이 seen.
  const handoff = queue.dequeue();
  expect(handoff.kind).toBe('submit');
  expect(states(store, first.id)).toEqual(['posted', 'delivered', 'seen']);
  expect(states(store, second.id)).toEqual(['posted', 'delivered']);
  expect(store.messageStatus(SEAT, first.id)).toBe('acked');
  expect(store.unreadCount(SEAT)).toBe(1);
  watcher.stop();
});

test('§5d — 큐에서 모델로 가는 글 = 머리줄 «[from OP · request]» ⊕ 전문 · 사람 입력엔 머리줄 없음', () => {
  const { store, queue, watcher } = fixture();
  watcher.poll();
  const posted = store.post({ from: 'OP', to: SEAT, body: BODY, kind: 'question' });
  watcher.poll();
  queue.enqueue('사람이 친 줄');
  const drained = queue.drain();
  expect(drained.kind).toBe('batch');
  const userBatch = drained.kind === 'batch' ? drained.items.map(item => item.text) : [];
  expect(userBatch).toEqual(['사람이 친 줄']); // user 가 notice 보다 먼저 · 머리줄 없음
  const next = queue.drain();
  const noticeText = next.kind === 'batch' ? next.items[0]!.text : '';
  expect(noticeText.split('\n')[0]).toBe('[from OP · request]');
  expect(noticeText).toContain(`msg:${posted.id} · ${BODY}`);
  expect(states(store, posted.id)).toEqual(['posted', 'delivered', 'seen']);
  watcher.stop();
});

test('§5d — 원장의 intent · crown_directive 칸이 큐 notice 머리줄까지 간다(옛 kind 보다 우선)', () => {
  const { store, queue, watcher } = fixture();
  watcher.poll();
  store.post({ from: 'OP', to: SEAT, body: BODY, kind: 'question', intent: 'decision', crownDirective: 'd-7' });
  watcher.poll();
  const next = queue.drain();
  const noticeText = next.kind === 'batch' ? next.items[0]!.text : '';
  expect(noticeText.split('\n')[0]).toBe('[from OP · decision · crown]');
  watcher.stop();
});

test('취소된 notice 는 seen 이 아니다 · 같은 msgId 는 대기 중 다시 넣지 않는다 · stop 뒤 구독 해제', () => {
  const { store, queue, watcher } = fixture();
  watcher.poll();
  const posted = store.post({ from: 'OP', to: SEAT, body: BODY });
  watcher.poll();
  const itemId = queue.items[0]!.id;
  queue.cancel(itemId, 'user');
  expect(states(store, posted.id)).toEqual(['posted', 'delivered']);
  watcher.stop();
  const later = store.post({ from: 'OP', to: SEAT, body: BODY });
  watcher.poll();
  queue.dequeue();
  // stop 뒤 큐 전이는 seen 을 만들지 않는다(구독 해제) — 적입 때의 delivered 만 남는다.
  expect(states(store, later.id)).toEqual(['posted', 'delivered']);
});

test('per-message 모드가 아니면 #38031 개수 notice 그대로(msgId 없음)', () => {
  const queue = createNextTuiQueue({ log: () => {} });
  let unread = 0;
  const watcher = createSeatMailArrivalWatcher('/h', queue, { readSnapshot: () => ({ seat: SEAT, unread }) });
  watcher.poll();
  unread = 1;
  watcher.poll();
  expect(queue.items.map(item => item.msgId)).toEqual([undefined]);
});

test('#38193 ⊕ B1-C: per-message mode wakes the idle door once per new batch, never for a still-queued one; a read error touches nothing', () => {
  const store = new MsgStore(':memory:');
  stores.push(store);
  const queue = createNextTuiQueue({ log: () => {} });
  let arrived = 0;
  let failRead = false;
  const errors: unknown[] = [];
  const read = (_cwd: string, afterId: number): SeatMailMessageRead => {
    if (failRead) throw new Error('ledger locked');
    return { seat: SEAT, messages: store.listByRecipient(SEAT, afterId).map(m => ({ id: m.id, from: m.from, body: m.body })) };
  };
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    messages: { read }, onArrived: () => { arrived += 1; }, onReadError: (error) => { errors.push(error); },
  });
  watcher.poll(); // baseline
  store.post({ from: 'OP', to: SEAT, body: 'a' });
  store.post({ from: 'OP', to: SEAT, body: 'b' });
  expect(watcher.poll()).toMatchObject({ kind: 'messages' });
  expect(arrived).toBe(1); // one wake for the batch (the TUI opens the next turn only when idle)
  expect(watcher.poll()).toMatchObject({ kind: 'quiet' });
  expect(arrived).toBe(1);
  failRead = true;
  const before = queue.items.length;
  expect(watcher.poll()).toEqual({ kind: 'read-error' });
  expect(errors).toHaveLength(1);
  expect(queue.items.length).toBe(before);
  expect(arrived).toBe(1);
  watcher.stop();
});

test('#38244 REVIEW-1 — a failed first read is not a baseline: the next good read sets it, no flood of old mail', () => {
  const store = new MsgStore(':memory:');
  stores.push(store);
  for (const body of ['old 1', 'old 2', 'old 3']) store.post({ from: 'OP', to: SEAT, body });
  const queue = createNextTuiQueue({ log: () => {} });
  const delivered: number[] = [];
  let fail = true;
  const errors: unknown[] = [];
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    messages: {
      read: (_cwd, afterId) => {
        if (fail) throw new Error('ledger open failed');
        return { seat: SEAT, messages: store.listByRecipient(SEAT, afterId).map(seatMailMessageOf) };
      },
      receipts: { record: (input) => { delivered.push(input.messageId); } },
    },
    onReadError: (error) => { errors.push(error); },
  });
  expect(watcher.poll()).toEqual({ kind: 'read-error' }); // boot read fails
  fail = false;
  expect(watcher.poll()).toEqual({ kind: 'baseline', unread: 3 }); // first GOOD read = baseline
  expect(queue.items).toHaveLength(0);
  expect(delivered).toEqual([]);
  const fresh = store.post({ from: 'OP', to: SEAT, body: 'new' });
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [fresh.id] });
  expect(delivered).toEqual([fresh.id]);
  expect(errors).toHaveLength(1);
  watcher.stop();
});

test('#38244 REVIEW-1 — readSeatMailMessages surfaces an unreadable ledger as an error, not as «no mail»', () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-read-error-'));
  try {
    mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
    const msgPath = join(home, 'messages.db');
    writeFileSync(msgPath, 'not a sqlite database');
    expect(() => readSeatMailMessages('/x', 0, { home, env: { COORD_ID: SEAT }, msgPath })).toThrow();
    // A missing ledger is still a real «no mail yet» (not an error).
    expect(readSeatMailMessages('/x', 0, { home, env: { COORD_ID: SEAT }, msgPath: join(home, 'absent.db') })).toEqual({ seat: SEAT, messages: [] });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
