// ── SEAT-INBOX B1-C — Next TUI 수신 쪽 영수증 (내부 문서 `SEAT-INBOX-PROTOCOL` §3a · §4a) ──
//
// 우편 한 통 = 입력 큐 notice 한 항목(`msgId` 를 구조 칸으로 갖는다).
//   delivered = 그 notice 항목이 큐에 생긴 순간(생산자가 돌려준 항목 id 와 함께 기록)
//   seen      = 그 항목이 status delivered 로 전이한 순간(queue.onTransition — 모델 맥락에 들어감)
// 기록은 원장(MsgStore.recordReceipt)에 한다 — 호환 ack(seen → acked)도 거기서 같이 쓴다.
// 모든 쓰기는 fail-soft: 영수증이 실패해도 우편 배달·TUI 는 멈추지 않는다(관측 = `msg.receipt-writer` 사건).

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import type { Message, MsgStore } from '../msg/msg-store.js';
import type { StructuredMessageFields } from '../msg/msg-context-header.js';
import { resolveSeatId } from './seat-mail-boot.js';

/** The structured fields a notice needs — B1-A columns (`origin` · `intent` · `crownDirective`) ride along. */
export interface SeatMailMessage extends StructuredMessageFields {
  id: number;
  from: string;
  body: string;
  kind?: string;
  /** Ledger `created_at`. The notice producer copies this into `occurredAt`. */
  createdAt?: string;
  /** QUEUE-FINISH-FIRST: ledger `reply_to` — a reply to a mail the current work waits on joins that work. */
  replyTo?: number;
  /** BULK-TRIAGE: ledger `deadline_at` and `priority` (urgent 2 · p0 1 · normal 0) — ranking fields for the triage card. */
  deadlineAt?: string;
  priority?: number;
  /** AUTOPILOT-GOAL-CLEARING: ledger refs (`goal-done:<ref>` · `goal:replace`) and the request's done condition. */
  refs?: string[];
  doneWhen?: string;
  /** CROWN-GOAL-APPLY: the structured goal field (`msg post --goal`) — the receiving autopilot applies it. */
  goal?: string;
  /** HAND-RAISE-REPLY-GATE: the request↔reply correlation id (a ✋ mail carries its blockId). */
  correlationId?: string;
  /** MAIL-TRIAGE-TASKQUEUE: supersedes · result envelope state — the triage merge/close fields. */
  supersedes?: number;
  /** DIRECTIVE-EXPIRY (Q5): the structured expiry (ISO) — goal pins close when it passes. */
  expiresAt?: string;
  result?: { state: 'done' | 'failed' };
  /** SEAT-MAIL-PASSIVE-DEFAULT: the sender's needs-reply flag (`needsAck`) — such a mail opens a turn. */
  needsAck?: boolean;
}

export interface SeatMailMessageRead {
  seat: string;
  messages: SeatMailMessage[];
  /** Actual ledger unread total, independent of the bounded message page. */
  unreadTotal?: number;
  /**
   * MSG-RECEIPT-IMPLIES-ACK ② — the part of {@link unreadTotal} that still needs this seat (MsgStore.actionableUnreadCount:
   * needsAck or request · decision · alert, no terminal receipt). The notice counter «[미읽음 총 N통]» shows this one.
   */
  actionableTotal?: number;
  /**
   * ELN-SEAT-MAIL-REPLAY (11-18 live: REL «Queue 3641», JUD «Queue 3225» with 8 and 2 unread): taken in the SAME
   * snapshot as `messages`. `latestId` = newest ledger id (the watcher's next floor, so it never pages history);
   * `cursor` = the recipient's ack cursor (`msg ack` — nothing at or below it is offered); `seenSkipped` = rows above the
   * cursor dropped because this seat already has a `seen`-or-later receipt (survives a restart); `truncated` = the page
   * hit {@link SEAT_MESSAGE_READ_LIMIT}. Absent on reads that predate these fields (tests' fakes).
   */
  latestId?: number;
  cursor?: number;
  seenSkipped?: number;
  truncated?: boolean;
}

export interface SeatReceiptWrite {
  messageId: number;
  recipient: string;
  state: 'delivered' | 'seen';
  queueItemId: string;
}

export interface SeatReceiptWriter {
  record(input: SeatReceiptWrite): void;
  /** [seat-mail #14 wiring] started 계기 — 큐 항목이 턴에 인계된 순간(onTransition delivered). 옵셔널: 구형 writer 무시. */
  recordStarted?(input: SeatReceiptStartedWrite): void;
  /** [seat-mail #16 wiring · S7 트리거] done 계기 — 턴이 우편에 답을 마친 순간(noteTurnFinished seen 정착). 옵셔널: 구형 writer 무시. */
  recordDone?(input: SeatReceiptDoneWrite): void;
  /** SEAT-MAIL-COALESCE-NOTICE — ack exactly one info mail after the digest turn that listed it (per id · never a cursor). */
  ack?(input: SeatReceiptDoneWrite): void;
}

export interface SeatReceiptDoneWrite {
  messageId: number;
  recipient: string;
}

export interface SeatReceiptStartedWrite {
  messageId: number;
  recipient: string;
  /** 시작 이벤트 식별자 — 큐 항목 전이가 곧 시작이라 queue item id 를 쓴다(생략 가능). */
  eventId?: string | null;
}

/** Ledger row → notice input: transport fields ⊕ the B1-A structured fields the §5d header reads. */
export function seatMailMessageOf(m: Message): SeatMailMessage {
  return {
    id: m.id, from: m.from, body: m.body, ...(m.kind === undefined ? {} : { kind: m.kind }),
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    ...(m.origin === undefined ? {} : { origin: m.origin }), ...(m.intent === undefined ? {} : { intent: m.intent }),
    ...(m.crownDirective === undefined ? {} : { crownDirective: m.crownDirective }),
    ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }),
    ...(m.deadlineAt ? { deadlineAt: m.deadlineAt } : {}), ...(typeof m.priority === 'number' && m.priority > 0 ? { priority: m.priority } : {}),
    ...(m.refs?.length ? { refs: m.refs } : {}), ...(m.doneWhen ? { doneWhen: m.doneWhen } : {}),
    ...(m.goal ? { goal: m.goal } : {}), ...(m.correlationId ? { correlationId: m.correlationId } : {}),
    ...(typeof m.supersedes === 'number' ? { supersedes: m.supersedes } : {}), ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}), ...(m.result ? { result: { state: m.result.state } } : {}),
    ...(m.needsAck === true ? { needsAck: true } : {}),
  };
}

/** Bounded read — one poll never pulls more than this many unread messages. */
export const SEAT_MESSAGE_READ_LIMIT = 1000;

/**
 * Unacknowledged messages for this cwd's seat with id > `afterId` (read-only · cursor untouched).
 * null = no seat here, or the seat-state folder is absent (same gate as `readSeatMailSnapshot`).
 */
export function readSeatMailMessages(
  cwd: string,
  afterId: number,
  deps: { home?: string; env?: NodeJS.ProcessEnv; msgPath?: string } = {},
): SeatMailMessageRead | null {
  const seat = resolveSeatId(cwd, { env: deps.env ?? process.env });
  if (seat === null) return null;
  try {
    if (!statSync(join(deps.home ?? homedir(), 'elanous-hq', 'seat-state', seat)).isDirectory()) return null;
  } catch { return null; }
  const msgPath = deps.msgPath ?? join(elanousStateRoot(), 'msg', 'messages.db');
  try { statSync(msgPath); } catch { return { seat, messages: [] }; }
  // #38244 REVIEW-1: an open/read failure is NOT «no mail» — it throws, so the watcher reports `read-error` and does not
  // take an empty read as its baseline (which would flood every unread message as new on the next good read).
  const mod = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const store: MsgStore = new mod.MsgStore(msgPath, { readOnly: true });
  try {
    // One read snapshot: a mail committed between the list and `latestId` would otherwise sit below the next floor unseen.
    return store.db.transaction((): SeatMailMessageRead => {
      // The ack cursor is a floor: `listByRecipient` alone only hides rows with a per-message ack, so every message
      // acknowledged by `msg ack --id N` (cursor) came back from id 0 — the whole history, 1000 rows per poll.
      const cursor = store.getCursor(seat);
      const floor = Math.max(afterId, cursor);
      // #38517 r2 MF1: exclusions apply BEFORE the read limit. Filtering a 1000-row page after the fact dropped every
      // unseen mail behind a page of already-seen rows (the watcher then moved its floor past them). Page on until
      // the limit is filled with offerable rows, the ledger runs out, or the scan bound is hit (then `truncated`).
      const excluded = takenMessageIds(store, seat, floor);
      const messages: SeatMailMessage[] = [];
      let skipped = 0;
      let after = floor;
      let truncated = false;
      for (let page = 0; ; page += 1) {
        const rows = store.listByRecipient(seat, after, SEAT_MESSAGE_READ_LIMIT);
        for (const row of rows) {
          if (excluded.has(row.id)) { skipped += 1; continue; }
          if (messages.length >= SEAT_MESSAGE_READ_LIMIT) { truncated = true; break; }
          messages.push(seatMailMessageOf(row));
        }
        if (truncated || rows.length < SEAT_MESSAGE_READ_LIMIT) break;
        after = rows.at(-1)!.id;
        if (page + 1 >= SEAT_MESSAGE_SCAN_PAGES) { truncated = true; break; }
      }
      return { seat, messages, unreadTotal: store.unreadCount(seat), actionableTotal: store.actionableUnreadCount(seat), latestId: store.latestId(), cursor, seenSkipped: skipped, truncated };
    }).deferred();
  } finally { store.close(); }
}

/** How many pages a single read may scan for offerable rows before it reports `truncated` (bounds a seat with a huge seen backlog). */
export const SEAT_MESSAGE_SCAN_PAGES = 20;

/**
 * Messages above `afterId` this seat already took in — never offered again, across restarts:
 * - `seen` or a later receipt (any source), and
 * - #38517 r2 (boot plan + per-message double notice): anything the seat plan absorbed (`source = 'plan'`, any state).
 *   The plan boots before the watcher (entry.ts), writes `delivered`/`plan` for the mail it consumed, and its active
 *   item is already in the queue as the plan notice — a second per-message notice for the same mail is the double.
 */
function takenMessageIds(store: MsgStore, seat: string, afterId: number): Set<number> {
  const table = store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'msg_receipts'").get();
  if (!table) return new Set();
  const rows = store.db.query(`SELECT DISTINCT message_id FROM msg_receipts WHERE recipient = ? AND message_id > ?
    AND (state IN ('seen', 'accepted', 'rejected', 'done', 'expired') OR source = 'plan')`).all(seat, afterId) as Array<{ message_id: number }>;
  return new Set(rows.map(row => row.message_id));
}

/** Writer that opens the ledger per write (the TUI holds no long-lived write handle). */
export function createLedgerReceiptWriter(msgPath: string = join(elanousStateRoot(), 'msg', 'messages.db')): SeatReceiptWriter {
  return {
    record(input) {
      try {
        const mod = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
        const store = new mod.MsgStore(msgPath);
        try {
          store.recordReceipt({ messageId: input.messageId, recipient: input.recipient, state: input.state, source: 'tui-queue', queueItemId: input.queueItemId });
        } finally { store.close(); }
      } catch (error) {
        try {
          debug.log('msg.receipt-writer', 'record-failed', { msgId: input.messageId, recipient: input.recipient, state: input.state,
            error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        } catch { /* observability is fail-open */ }
      }
    },
    // [seat-mail #14 wiring] started 계기 — 원장을 열어 clock sink 로 직접 기록(state 기계와 무관한 clock 전용 이벤트).
    // [seat-mail #16 wiring · S7 트리거] done 계기 — started와 같은 깔때기(sink 직접, clock 전용 이벤트).
    recordDone(input: SeatReceiptDoneWrite) {
      try {
        const mod = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
        const sink = require('../hq/msg-receipt-clock-sink.js') as typeof import('../hq/msg-receipt-clock-sink.js');
        const store = new mod.MsgStore(msgPath);
        try { sink.recordReceiptClock(store.db, { messageId: input.messageId, recipient: input.recipient, event: 'done' }); }
        finally { store.close(); }
      } catch (error) {
        try {
          debug.log('msg.receipt-writer', 'record-done-failed', { msgId: input.messageId, recipient: input.recipient,
            error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        } catch { /* observability is fail-open */ }
      }
    },
    ack(input: SeatReceiptDoneWrite) {
      try {
        const mod = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
        const store = new mod.MsgStore(msgPath);
        // Only a still-open mail: never rewinds a `done` ack (the §4c seen compat write may already have acked it).
        try { if (store.messageStatus(input.recipient, input.messageId) === 'delivered') store.ackMessage(input.recipient, input.messageId, 'acked'); }
        finally { store.close(); }
      } catch (error) {
        try {
          debug.log('msg.receipt-writer', 'ack-failed', { msgId: input.messageId, recipient: input.recipient,
            error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        } catch { /* observability is fail-open */ }
      }
    },
    recordStarted(input: SeatReceiptStartedWrite) {
      try {
        const mod = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
        const sink = require('../hq/msg-receipt-clock-sink.js') as typeof import('../hq/msg-receipt-clock-sink.js');
        const store = new mod.MsgStore(msgPath);
        try { sink.recordReceiptClock(store.db, { messageId: input.messageId, recipient: input.recipient, event: 'started', eventId: input.eventId ?? null }); }
        finally { store.close(); }
      } catch (error) {
        try {
          debug.log('msg.receipt-writer', 'record-started-failed', { msgId: input.messageId, recipient: input.recipient,
            error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        } catch { /* observability is fail-open */ }
      }
    },
  };
}
