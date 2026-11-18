import { debug } from '../debug/log.js';
import { readSeatMailSnapshot, type SeatMailSnapshot } from './seat-mail-boot.js';
import { createChildNoticeProducers, type ChildNoticeQueue } from './core/notice-producers.js';
import { headerFieldsOf } from '../msg/msg-context-header.js';
import type { NextTuiQueueTransitionListener } from './core/queue.js';
import type { SeatMailMessageRead, SeatReceiptWriter } from './seat-message-receipts.js';

/**
 * ELN-CHILD-NOTICE-INTO-QUEUE — «자리 우편 도착» 생산 배선(3곳 중 1).
 * 부트 스냅숏(`readSeatMailSnapshot`)을 다시 읽어 안 읽은 수가 늘어나면 큐에 notice 를 넣는다.
 * 첫 관측은 기준선만 잡는다(부팅 전에 온 우편으로 첫 프레임을 시끄럽게 하지 않는다).
 */

/**
 * 기본 폴링 주기. 15초의 정본은 이 상수 하나다.
 * 판정 상한은 이 주기를 import 하는 external-event-receipt 가 여유를 더해 정한다.
 */
export const DEFAULT_SEAT_MAIL_POLL_MS = 15_000;

export type SeatMailPollOutcome =
  | { kind: 'no-seat' }
  | { kind: 'baseline'; unread: number }
  | { kind: 'quiet'; unread: number }
  | { kind: 'arrived'; unread: number; noticeText: string | null }
  | { kind: 'read-error' }
  /** SEAT-INBOX B1-C per-message mode: one notice per new message (receipt `delivered` recorded for each). */
  | { kind: 'messages'; msgIds: number[] };

/**
 * SEAT-INBOX B1-C — per-message source. When given, the watcher reads messages (not a count), enqueues one
 * notice per message carrying `msgId`, and records receipts: `delivered` on enqueue, `seen` when the queue
 * item turns delivered. Absent = the #38031 count notice, unchanged.
 */
export interface SeatMessageSource {
  read: (cwd: string, afterId: number) => SeatMailMessageRead | null;
  receipts?: SeatReceiptWriter;
}

/** The queue surface per-message mode needs on top of the notice surface — `onTransition` is the «seen» source. */
export type SeatMailWatchQueue = ChildNoticeQueue & { onTransition?: (listener: NextTuiQueueTransitionListener) => () => void };

export interface SeatMailArrivalWatcher {
  poll(): SeatMailPollOutcome;
  start(): void;
  stop(): void;
}

export function createSeatMailArrivalWatcher(
  cwd: string,
  queue: SeatMailWatchQueue,
  deps: {
    readSnapshot?: (cwd: string) => SeatMailSnapshot | null;
    /** Ledger read failure. Default: log and leave the queue alone (no turn, no steer). */
    onReadError?: (error: unknown) => void;
    messages?: SeatMessageSource;
    intervalMs?: number;
    timer?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
    /**
     * Called after a new seat-mail notice is queued. The TUI wakes the idle door when no turn is running;
     * a notice that lands during a turn stays queued until that turn settles.
     */
    onArrived?: () => void;
  } = {},
): SeatMailArrivalWatcher {
  const read = deps.readSnapshot ?? readSeatMailSnapshot;
  const intervalMs = deps.intervalMs ?? DEFAULT_SEAT_MAIL_POLL_MS;
  const timer = deps.timer ?? {
    set: (fn: () => void, ms: number) => setInterval(fn, ms),
    clear: (handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
  };
  const producers = createChildNoticeProducers(queue);
  let lastUnread: number | null = null;
  let handle: unknown = null;
  let lastMsgId: number | null = null;
  /** queue item id → (msgId, seat) for notices this watcher made; the «seen» tap reads only these. */
  const noticeMessages = new Map<string, { msgId: number; seat: string }>();
  const source = deps.messages;
  const detachTransition = source && queue.onTransition
    ? queue.onTransition((item) => {
      const mapped = noticeMessages.get(item.id);
      if (mapped === undefined) return;
      noticeMessages.delete(item.id);
      if (item.status === 'delivered') {
        source.receipts?.record({ messageId: mapped.msgId, recipient: mapped.seat, state: 'seen', queueItemId: item.id });
      }
    })
    : null;

  const pollMessages = (src: SeatMessageSource): SeatMailPollOutcome => {
    // #38193: a ledger read failure leaves the queue alone (no turn, no steer) — same as the count mode.
    let read: SeatMailMessageRead | null;
    try { read = src.read(cwd, lastMsgId ?? 0); }
    catch (error) {
      (deps.onReadError ?? ((err: unknown) => debug.log('tui.next', 'seat-mail-read-error', { error: String(err) })))(error);
      return { kind: 'read-error' };
    }
    if (read === null) return { kind: 'no-seat' };
    const maxId = read.messages.reduce((max, m) => Math.max(max, m.id), lastMsgId ?? 0);
    if (lastMsgId === null) {
      // 첫 관측은 기준선만(#38031 규칙 그대로) — 부팅 전 우편으로 첫 프레임을 채우지 않는다.
      lastMsgId = maxId;
      return { kind: 'baseline', unread: read.messages.length };
    }
    const fresh = read.messages.filter((m) => m.id > (lastMsgId ?? 0)).sort((a, b) => a.id - b.id);
    lastMsgId = maxId;
    if (fresh.length === 0) return { kind: 'quiet', unread: read.messages.length };
    const msgIds: number[] = [];
    for (const message of fresh) {
      const item = producers.seatMessageArrived({
        id: message.id,
        sender: message.from,
        body: message.body,
        kind: message.kind ?? null,
        ...headerFieldsOf(message),
        ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
      });
      if (item === null) continue;
      msgIds.push(message.id);
      noticeMessages.set(item.id, { msgId: message.id, seat: read.seat });
      src.receipts?.record({ messageId: message.id, recipient: read.seat, state: 'delivered', queueItemId: item.id });
    }
    // #38193: a new notice wakes the idle door once (the TUI decides: idle → next turn · busy → stays queued, no steer).
    // Duplicates (same msgId still queued) are not new arrivals.
    if (msgIds.length > 0) deps.onArrived?.();
    return { kind: 'messages', msgIds };
  };

  const poll = (): SeatMailPollOutcome => {
    if (source) return pollMessages(source);
    let snapshot: SeatMailSnapshot | null;
    try { snapshot = read(cwd); }
    catch (error) {
      (deps.onReadError ?? ((err: unknown) => debug.log('tui.next', 'seat-mail-read-error', { error: String(err) })))(error);
      return { kind: 'read-error' };
    }
    if (snapshot === null || snapshot.unread === null) return { kind: 'no-seat' };
    const prev = lastUnread;
    if (prev === null) {
      lastUnread = snapshot.unread;
      return { kind: 'baseline', unread: snapshot.unread };
    }
    if (snapshot.unread > prev) {
      lastUnread = snapshot.unread;
      const item = producers.seatMailArrived({ seat: snapshot.seat, unread: snapshot.unread });
      // A duplicate (same text still queued) is not a new arrival — do not offer it again.
      if (item !== null) deps.onArrived?.();
      return { kind: 'arrived', unread: snapshot.unread, noticeText: item === null ? null : item.text };
    }
    lastUnread = snapshot.unread;
    return { kind: 'quiet', unread: snapshot.unread };
  };

  return {
    poll,
    start(): void {
      if (handle !== null) return;
      handle = timer.set(poll, intervalMs);
    },
    stop(): void {
      detachTransition?.();
      if (handle === null) return;
      timer.clear(handle);
      handle = null;
    },
  };
}
