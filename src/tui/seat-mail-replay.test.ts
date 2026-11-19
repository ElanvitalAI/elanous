/**
 * ELN-SEAT-MAIL-REPLAY — a new session must not replay the seat's mail history into the queue (11-18 live: REL
 * «Queue 3641», JUD «Queue 3225», with 8 and 2 unread). Real ledger file in a temp dir, the real read
 * (`readSeatMailMessages`), the real queue, the real receipt writer. Expectations are literals.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { MSG_RECEIPTS_SCHEMA } from '../msg/msg-receipts.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { createLedgerReceiptWriter, readSeatMailMessages } from './seat-message-receipts.js';

const SEAT = 'QSEAT';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'seat-mail-replay-'));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
  const cwd = join(root, 'seats', SEAT);
  mkdirSync(cwd, { recursive: true });
  const msgPath = join(root, 'messages.db');
  const events: Array<[string, Record<string, unknown>]> = [];
  const boot = (queueCap?: number) => {
    const queue = createNextTuiQueue({ log: () => {} });
    const watcher = createSeatMailArrivalWatcher(cwd, queue, {
      messages: { read: (c, afterId) => readSeatMailMessages(c, afterId, { home, msgPath }), receipts: createLedgerReceiptWriter(msgPath) },
      log: (event, data) => { events.push([event, data]); },
      ...(queueCap === undefined ? {} : { queueCap }),
    });
    return { queue, watcher };
  };
  const post = (count: number, body: (i: number) => string) => {
    const store = new MsgStore(msgPath);
    try { store.db.transaction(() => { for (let i = 0; i < count; i += 1) store.post({ from: 'OP', to: SEAT, body: body(i) }); }).immediate(); }
    finally { store.close(); }
  };
  const ackThrough = (id: number) => { const store = new MsgStore(msgPath); try { store.ack(SEAT, id); } finally { store.close(); } };
  /** Receipts written straight into the ledger (one transaction) — the same rows the real writers produce. */
  const receipt = (ids: number[], state: string, source: string) => {
    const store = new MsgStore(msgPath);
    try {
      store.db.exec(MSG_RECEIPTS_SCHEMA);
      const insert = store.db.query('INSERT INTO msg_receipts (message_id, recipient, state, at, source) VALUES (?, ?, ?, ?, ?)');
      store.db.transaction(() => { for (const id of ids) insert.run(id, SEAT, state, '2026-11-18T00:00:00.000Z', source); }).immediate();
    } finally { store.close(); }
  };
  const noticeIds = (queue: ReturnType<typeof createNextTuiQueue>) => queue.items.filter((item) => item.source === 'seat-mail').map((item) => item.msgId ?? null);
  return { boot, post, ackThrough, receipt, noticeIds, events, msgPath };
}

test('fresh session over 3000 acknowledged mails and 2 unacknowledged → exactly 2 notices, and the skip is an event', () => {
  const w = world();
  w.post(3000, (i) => `old report ${i}`);
  w.ackThrough(3000);
  w.post(2, (i) => `new request ${i}`);
  const { queue, watcher } = w.boot();
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [3001, 3002] });
  expect(w.noticeIds(queue)).toEqual([3001, 3002]);
  expect(w.events).toEqual([['seat-mail-replay-skipped', { seat: 'QSEAT', cursor: 3000, seenSkipped: 0, unacked: 2 }]]);
  // The next polls start after the ledger's newest id — nothing is paged forward.
  expect(watcher.poll()).toEqual({ kind: 'quiet', unread: 2 }); // queued mail remains unread until acknowledged
  expect(w.noticeIds(queue)).toEqual([3001, 3002]);
});

test('a mail that lands right after the startup scan is offered on the next poll, once', () => {
  const w = world();
  w.post(2, (i) => `before boot ${i}`);
  const { queue, watcher } = w.boot();
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [1, 2] });
  w.post(1, () => 'during startup');
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [3] });
  expect(w.noticeIds(queue)).toEqual([1, 2, 3]);
});

test('the same msgId delivered twice → one notice and a dedupe event', () => {
  const queue = createNextTuiQueue({ log: () => {} });
  const events: string[] = [];
  const message = { id: 41, from: 'OP', body: 'once only' };
  const floorSeen: number[] = [];
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    // A source that hands the same row back regardless of the floor (a ledger read racing an ack).
    messages: { read: (_cwd, afterId) => { floorSeen.push(afterId); return { seat: SEAT, messages: [message] }; } },
    log: (event) => { events.push(event); },
  });
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [41] });
  queue.dequeue();
  expect(watcher.poll()).toEqual({ kind: 'quiet', unread: 1 });
  expect(queue.items).toEqual([]);
  expect(floorSeen).toEqual([0, 41]);
  // Same row offered back while still in the queue is a dedupe hit too.
  const again = createSeatMailArrivalWatcher('/h', queue, { messages: { read: () => ({ seat: SEAT, messages: [message, message] }) }, log: (event) => { events.push(event); } });
  expect(again.poll()).toEqual({ kind: 'messages', msgIds: [41] });
  expect(queue.items.map((item) => item.msgId)).toEqual([41]);
  // #38517 r2 MF3: the re-delivery on the second poll (below the floor) is reported too — one per msgId per watcher.
  expect(events).toEqual(['seat-mail-dedupe-hit', 'seat-mail-dedupe-hit']);
});

test('500 unacknowledged with cap 20 → 20 notices plus ONE summary, and the collapse is an event', () => {
  const w = world();
  w.post(500, (i) => `backlog ${i}`);
  const { queue, watcher } = w.boot(20);
  const outcome = watcher.poll();
  expect(outcome).toEqual({ kind: 'messages', msgIds: Array.from({ length: 20 }, (_, i) => i + 1) });
  const seatMail = queue.items.filter((item) => item.source === 'seat-mail');
  expect(seatMail).toHaveLength(21);
  expect(seatMail.at(-1)!.text).toBe('[seat-mail] 480 more unread mails for QSEAT, ids #21..#500 · unread total 500 — not queued one by one; read them with: eln msg list --to QSEAT');
  expect(seatMail[0]!.text).toContain('[미읽음 총 500통]');
  // 출처: #38517 — cap 20 (11-18 live unread REL 8 · JUD 2; justification in the PR body)
  expect(w.events).toEqual([['seat-mail-cap-collapse', { seat: 'QSEAT', cap: 20, collapsed: 480, firstId: 21, lastId: 500, truncated: false, summaryQueued: true }]]);
});

test('the seen state survives a restart: a mail answered before the restart is not offered again', () => {
  const w = world();
  w.post(2, (i) => `request ${i}`);
  const first = w.boot();
  expect(first.watcher.poll()).toEqual({ kind: 'messages', msgIds: [1, 2] });
  first.queue.dequeue();
  first.watcher.noteTurnFinished(true); // #38483: seen only after the answered turn
  first.watcher.stop();
  const restarted = w.boot();
  expect(restarted.watcher.poll()).toEqual({ kind: 'messages', msgIds: [2] });
  expect(w.noticeIds(restarted.queue)).toEqual([2]);
});

// ── #38517 r2 must-fixes (remote-terra-38517-38517-e5306bfaea0f.json) ──

test('r2 MF1: 1000 already-seen mails ahead of 2 unseen → both unseen are offered (exclusion before the read limit)', () => {
  const w = world();
  w.post(1002, (i) => `mail ${i}`);
  w.receipt(Array.from({ length: 1000 }, (_, i) => i + 1), 'seen', 'tui-queue');
  const { queue, watcher } = w.boot();
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [1001, 1002] });
  expect(w.noticeIds(queue)).toEqual([1001, 1002]);
  expect(w.events).toEqual([['seat-mail-replay-skipped', { seat: 'QSEAT', cursor: 0, seenSkipped: 1000, unacked: 2 }]]);
});

test('r2 MF2: cap ≥ the read limit and 1500 unacknowledged → 1000 notices plus ONE summary for the rest', () => {
  const w = world();
  w.post(1500, (i) => `backlog ${i}`);
  const { queue, watcher } = w.boot(2000);
  const outcome = watcher.poll();
  expect(outcome).toEqual({ kind: 'messages', msgIds: Array.from({ length: 1000 }, (_, i) => i + 1) });
  const seatMail = queue.items.filter((item) => item.source === 'seat-mail');
  expect(seatMail).toHaveLength(1001);
  expect(seatMail.at(-1)!.text).toBe('[seat-mail] more unread mails beyond the read limit for QSEAT, ids #1001..#1500 · unread total 1500 — not queued one by one; read them with: eln msg list --to QSEAT');
  // 출처: #38517 r2 MF2 — cap 2000 ≥ SEAT_MESSAGE_READ_LIMIT 1000 (the reviewer's «cap ≥ read limit» case)
  expect(w.events).toEqual([['seat-mail-cap-collapse', { seat: 'QSEAT', cap: 2000, collapsed: 0, firstId: 1001, lastId: 1500, truncated: true, summaryQueued: true }]]);
});

test('r2 MF2: cap 20 and 1500 unacknowledged → 20 notices plus ONE summary naming the truncated rest; a later poll adds no second summary', () => {
  const w = world();
  w.post(1500, (i) => `backlog ${i}`);
  const { queue, watcher } = w.boot(20);
  watcher.poll();
  const summaries = () => queue.items.filter((item) => item.source === 'seat-mail' && item.msgId === undefined);
  expect(summaries().map((item) => item.text)).toEqual(['[seat-mail] 980+ more unread mails for QSEAT, ids #21..#1500 · unread total 1500 — not queued one by one; read them with: eln msg list --to QSEAT']);
  watcher.poll(); // same truncated ledger, nothing newer than the announced #1500
  expect(summaries()).toHaveLength(1);
  expect(w.events.filter(([event]) => event === 'seat-mail-cap-collapse')).toHaveLength(1);
});

test('r2 MF3: a msgId offered on an earlier poll that comes back below the floor → one dedupe event, no second notice, not one event per poll', () => {
  const queue = createNextTuiQueue({ log: () => {} });
  const events: Array<[string, Record<string, unknown>]> = [];
  const message = { id: 7, from: 'OP', body: 'redelivered' };
  // A read that keeps handing back row 7 after the floor has moved past it (latestId 9) — the reviewer's re-delivery.
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    messages: { read: () => ({ seat: SEAT, messages: [message], latestId: 9 }) },
    log: (event, data) => { events.push([event, data]); },
  });
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [7] });
  queue.dequeue();
  expect(watcher.poll()).toEqual({ kind: 'quiet', unread: 1 });
  expect(watcher.poll()).toEqual({ kind: 'quiet', unread: 1 });
  expect(queue.items).toEqual([]);
  expect(events).toEqual([['seat-mail-dedupe-hit', { seat: 'QSEAT', msgId: 7 }]]);
});

test('r2 boot-plan double: mail the seat plan absorbed (receipt source plan) gets no per-message notice', () => {
  const w = world();
  w.post(2, (i) => `request ${i}`);
  w.receipt([1], 'delivered', 'plan');
  const { queue, watcher } = w.boot();
  expect(watcher.poll()).toEqual({ kind: 'messages', msgIds: [2] });
  expect(w.noticeIds(queue)).toEqual([2]);
});
