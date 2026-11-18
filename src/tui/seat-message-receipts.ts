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
}

export interface SeatMailMessageRead {
  seat: string;
  messages: SeatMailMessage[];
}

export interface SeatReceiptWrite {
  messageId: number;
  recipient: string;
  state: 'delivered' | 'seen';
  queueItemId: string;
}

export interface SeatReceiptWriter {
  record(input: SeatReceiptWrite): void;
}

/** Ledger row → notice input: transport fields ⊕ the B1-A structured fields the §5d header reads. */
export function seatMailMessageOf(m: Message): SeatMailMessage {
  return {
    id: m.id, from: m.from, body: m.body, ...(m.kind === undefined ? {} : { kind: m.kind }),
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    ...(m.origin === undefined ? {} : { origin: m.origin }), ...(m.intent === undefined ? {} : { intent: m.intent }),
    ...(m.crownDirective === undefined ? {} : { crownDirective: m.crownDirective }),
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
    const messages = store.listByRecipient(seat, afterId, SEAT_MESSAGE_READ_LIMIT).map(seatMailMessageOf);
    return { seat, messages };
  } finally { store.close(); }
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
  };
}
