// SEAT-INBOX B1-C §3a·§4a — Next TUI 수신 쪽: 메시지 한 통 = notice 한 항목(msgId) · delivered(적입) → seen(큐 delivered).
// 진짜 createNextTuiQueue(로그 조용) ⊕ :memory: 원장 ⊕ 가짜 읽기(폴링 타이머 0 — poll() 을 직접 부른다).
import { afterEach, expect, test } from 'bun:test';
import { createNextTuiQueue } from './core/queue.js';
import { seatMessageNotice } from './core/notice-producers.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { createSeatMailAdapter } from './turn-events/mail-adapter.js';
import { readSeatMailMessages, seatMailMessageOf, type SeatMailMessageRead, type SeatReceiptWriter } from './seat-message-receipts.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';

const SEAT = 'TC';
const BODY = '구현 시작 — inbox-b1c 본문';
const FUTURE_WINDOW_MS = 60_000; // One minute beyond fixture message timestamps.
const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(opts: { now?: () => number } = {}) {
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
  const watcher = createSeatMailArrivalWatcher('/h', queue, { messages: { read, receipts: writer },
    ...(opts.now ? { mailAdapter: createSeatMailAdapter({ now: opts.now }) } : {}) });
  return { store, queue, watcher, reads: () => reads };
}

const states = (store: MsgStore, id: number) => store.listReceipts({ messageId: id }).map(r => r.state);

test('unseen request kind exclusions apply before the SQL limit and are opt-in', () => {
  const { store, watcher } = fixture();
  const request = store.post({ from: 'OP', to: SEAT, body: 'request', intent: 'request', kind: 'request', needsAck: true });
  const notice = store.post({ from: 'OP', to: SEAT, body: 'notice', intent: 'request', kind: 'info', needsAck: true });
  const SINGLE_ROW_PAGE = 1; // Fixture: one row makes ordering before pagination observable.
  const range = { postedBefore: new Date(Date.now() + FUTURE_WINDOW_MS), postedAfter: new Date(0), limit: SINGLE_ROW_PAGE };
  expect(store.listUnseenRequests(range).map(row => row.message.id)).toEqual([notice.id]);
  expect(store.listUnseenRequests({ ...range, excludedKinds: ['info'] }).map(row => row.message.id)).toEqual([request.id]);
  watcher.stop();
});

test('structured notice exclusions leave five requests out of fifteen before pagination', () => {
  const { store, watcher } = fixture();
  const requestIds = Array.from({ length: 5 }, (_, i) => store.post({ from: 'OP', to: SEAT, body: `work ${i}`, intent: 'request', kind: 'request', needsAck: true }).id);
  for (let i = 0; i < 10; i++) store.post({ from: 'OP', to: SEAT, body: `notice ${i}`, intent: 'request', kind: i % 2 ? 'coord' : 'info', needsAck: true });
  const rows = store.listUnseenRequests({ stage: 'ack', postedBefore: new Date(Date.now() + 60_000), postedAfter: new Date(0), limit: 5, excludedKinds: ['info', 'coord'] });
  expect(rows.map(row => row.message.id).sort((a, b) => a - b)).toEqual(requestIds);
  watcher.stop();
});

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
  // 유휴 경계 — 큐가 꺼내 턴에 넘긴 것만으로는 seen 이 아니다(ELN-SEAT-LIVE 11-18) · 그 턴이 답해야 seen.
  const handoff = queue.dequeue();
  expect(handoff.kind).toBe('submit');
  expect(states(store, first.id)).toEqual(['posted', 'delivered']);
  watcher.noteTurnFinished(true);
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
  watcher.noteTurnFinished(true);
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

test('#38244 REVIEW-1 — a failed first read is not a baseline: the next good read offers the unacked mail once, then only new mail', () => {
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
  // ELN-SEAT-MAIL-REPLAY (OP 11-18): the first GOOD read offers the unacknowledged mail once — never the acked history.
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [1, 2, 3] });
  expect(queue.items).toHaveLength(3);
  expect(delivered).toEqual([1, 2, 3]);
  const fresh = store.post({ from: 'OP', to: SEAT, body: 'new' });
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [fresh.id] });
  expect(delivered).toEqual([1, 2, 3, fresh.id]);
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

test('ELN-SEAT-LIVE 11-18 — the turn that took the notice FAILED: not seen · back-off, then requeued once · a second failure gives up (still unseen)', () => {
  let at = 1_000_000;
  const { store, queue, watcher } = fixture({ now: () => at });
  watcher.poll();
  const posted = store.post({ from: 'SLA-PROBE', to: SEAT, body: '노크 우편 — 받으면 한 줄', intent: 'request' });
  watcher.poll();
  expect(queue.dequeue().kind).toBe('submit');
  watcher.noteTurnFinished(false); // e.g. «Codex 인증에 실패했습니다»
  expect(states(store, posted.id)).toEqual(['posted', 'delivered']);
  expect(queue.items.filter(item => item.kind === 'notice')).toEqual([]); // CAPSULE-C3: parked for the back-off, not requeued at once
  // 출처: #38589 — MAIL_BACKOFF_BASE_MS (one watch period) after the first failure
  at += 15_000;
  watcher.poll();
  expect(queue.items.filter(item => item.kind === 'notice').map(item => item.msgId)).toEqual([posted.id]); // offered again
  watcher.noteTurnFinished(false); // idempotent: nothing was in the turn
  expect(queue.items.filter(item => item.kind === 'notice')).toHaveLength(1);
  expect(queue.dequeue().kind).toBe('submit');
  watcher.noteTurnFinished(false); // the retry failed too
  // 출처: #38589 — the second failure doubles the back-off; the mail is given up, never offered again
  at += 30_000;
  watcher.poll();
  expect(states(store, posted.id)).toEqual(['posted', 'delivered']);
  expect(queue.items.filter(item => item.kind === 'notice')).toEqual([]); // gave up — overdue / ACK-SLA take it from here
  expect(store.listUnseenRequests({ postedBefore: new Date(Date.now() + 60_000), postedAfter: new Date(0) }).map(row => row.message.id)).toEqual([posted.id]);
  watcher.stop();
});

test('ELN-SEAT-LIVE 11-18 — a failed turn then an answered retry → seen exactly once', () => {
  let at = 1_000_000;
  const { store, queue, watcher } = fixture({ now: () => at });
  watcher.poll();
  const posted = store.post({ from: 'OP', to: SEAT, body: BODY, intent: 'request' });
  watcher.poll();
  queue.dequeue();
  watcher.noteTurnFinished(false);
  // 출처: #38589 — MAIL_BACKOFF_BASE_MS before the retry
  at += 15_000;
  watcher.poll();
  queue.dequeue();
  watcher.noteTurnFinished(true);
  expect(states(store, posted.id)).toEqual(['posted', 'delivered', 'seen']);
  watcher.stop();
});
