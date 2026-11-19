import { debug } from '../debug/log.js';
import { emitTurnLife } from '../debug/turn-life.js';
import { readSeatMailSnapshot, type SeatMailSnapshot } from './seat-mail-boot.js';
import { createChildNoticeProducers, type ChildNoticeQueue } from './core/notice-producers.js';
import { headerFieldsOf } from '../msg/msg-context-header.js';
import type { NextTuiQueueTransitionListener } from './core/queue.js';
import type { SeatMailMessageRead, SeatReceiptWriter } from './seat-message-receipts.js';
import type { TurnEventOutcome } from '../turn-capsule/contract.js';
import { createSeatMailAdapter, type SeatMailAdapter } from './turn-events/mail-adapter.js';

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

/**
 * ELN-SEAT-MAIL-REPLAY — at most this many per-message seat-mail notices wait in the queue; the rest collapse into ONE
 * summary notice. Each notice opens its own turn, so 20 is already hours of turns. 11-18 live unread inboxes were
 * REL 8 and JUD 2, so an ordinary seat never meets the cap. `ELANOUS_SEAT_MAIL_QUEUE_CAP` (≥ 1) or the watcher option.
 */
export const SEAT_MAIL_QUEUE_CAP = 20;

export function resolveSeatMailQueueCap(option?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (option !== undefined && Number.isSafeInteger(option) && option >= 1) return option;
  const raw = env.ELANOUS_SEAT_MAIL_QUEUE_CAP;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : SEAT_MAIL_QUEUE_CAP;
}

/** The one notice that stands for the mail over the cap (ids are the ledger's; the seat reads them with `msg list`). */
export function seatMailOverflowNotice(seat: string, count: number, firstId: number, lastId: number, truncated: boolean, unreadTotal?: number): string {
  const howMany = count === 0 ? 'more unread mails beyond the read limit' : `${count}${truncated ? '+' : ''} more unread mails`;
  return `[seat-mail] ${howMany} for ${seat}, ids #${firstId}..#${lastId}${unreadTotal === undefined ? '' : ` · unread total ${unreadTotal}`} — not queued one by one; read them with: eln msg list --to ${seat}`;
}

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
export type SeatMailWatchQueue = ChildNoticeQueue & {
  onTransition?: (listener: NextTuiQueueTransitionListener) => () => void;
  cancel?: (id: string, reason?: string) => unknown;
};

export interface SeatMailArrivalWatcher {
  poll(): SeatMailPollOutcome;
  /**
   * The turn that took this watcher's notices ended. `responded` → those messages are «seen» now. Otherwise (failed ·
   * cancelled · auth error) they are NOT seen and go back into the queue once; a second unanswered turn gives up loudly
   * (`tui.next seat-mail-gave-up` warn) and leaves the message unseen for A217 overdue / ACK-SLA. Idempotent per turn.
   */
  noteTurnFinished(responded: boolean, outcome?: TurnEventOutcome): void;
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
    /** Per-message notices allowed to wait at once (default {@link resolveSeatMailQueueCap}). */
    queueCap?: number;
    log?: (event: string, data: Record<string, unknown>) => void;
    /** OBSERVE-TURN-EVENT-LIFECYCLE — turn-life observation hook (fail-open). */
    turnLifeLog?: (event: string, data: Record<string, unknown>) => void;
    /**
     * The seat's one mail owner (CAPSULE-C3 · always on since CAPSULE-FLAGS-REMOVE-DEFAULT R4). The TUI passes ONE
     * adapter to this watcher and to the seat plan (entry.ts); absent = a private one. A msgId another path (the plan) owns is a duplicate; a failed turn
     * parks its mail for the adapter's back-off; a ledger read error is retried after the adapter's short back-off.
     */
    mailAdapter?: SeatMailAdapter;
    /** One-shot timer for the read retry (default setTimeout, unref'd). */
    retryTimer?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  } = {},
): SeatMailArrivalWatcher {
  const read = deps.readSnapshot ?? readSeatMailSnapshot;
  const intervalMs = deps.intervalMs ?? DEFAULT_SEAT_MAIL_POLL_MS;
  const timer = deps.timer ?? {
    set: (fn: () => void, ms: number) => setInterval(fn, ms),
    clear: (handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
  };
  // OBSERVE-TURN-EVENT-LIFECYCLE — 우편 관측 주입(기본: debug 직접 방출).
  const turnLifeLog = deps.turnLifeLog ?? emitTurnLife;
  const producers = createChildNoticeProducers(queue);
  let lastUnread: number | null = null;
  let handle: unknown = null;
  let lastMsgId: number | null = null;
  const queueCap = resolveSeatMailQueueCap(deps.queueCap);
  const log = deps.log ?? ((event: string, data: Record<string, unknown>) => {
    try { debug.log('tui.next', event, data, { level: 'warn' }); } catch { /* observability is fail-open */ }
  });
  /** msgIds this watcher already put in the queue (this process). The ledger side (cursor · seen) covers a restart. */
  const offered = new Set<number>();
  /** msgIds whose re-delivery was already reported (one `seat-mail-dedupe-hit` per msgId, not one per poll). */
  const dedupeLogged = new Set<number>();
  let overflowItemId: string | null = null;
  /** Highest msgId an overflow summary already announced — a truncated read that brings nothing newer adds no summary. */
  let summarizedThrough = 0;
  /** queue item id → message for notices this watcher made; the «seen» tap reads only these. */
  type NoticeMessage = { msgId: number; seat: string; message: Parameters<typeof producers.seatMessageArrived>[0]; attempt: number };
  const noticeMessages = new Map<string, NoticeMessage>();
  /**
   * Handed to the running turn, waiting for its outcome. ELN-SEAT-LIVE 11-18: «seen» used to be written the moment the
   * queue handed the notice over — a turn that then failed (Codex auth error on eln-main 83933f91) left the mail «seen»,
   * out of overdue, and never offered again (this watcher had already moved past its id): a silently lost message.
   */
  const inTurn = new Map<string, NoticeMessage>();
  const source = deps.messages;
  const adapter = deps.mailAdapter ?? createSeatMailAdapter();
  /** CAPSULE-C3: mail waiting for the adapter's back-off (a failed turn's, or new mail behind an open circuit). */
  const parked = new Map<number, NoticeMessage>();
  const retryTimer = deps.retryTimer ?? {
    set: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clear: (handle: unknown) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  };
  let readRetry: unknown = null;
  const detachTransition = source && queue.onTransition
    ? queue.onTransition((item) => {
      const mapped = noticeMessages.get(item.id);
      if (mapped === undefined) return;
      noticeMessages.delete(item.id);
      if (item.status === 'delivered') {
        inTurn.set(item.id, mapped);
        // [seat-mail #14 wiring] started 계기 — 큐가 턴에 인계한 순간(orphan guard·fail-soft는 sink/writer 안).
        source?.receipts?.recordStarted?.({ messageId: mapped.msgId, recipient: mapped.seat, eventId: item.id });
      }
      // Dropped before any turn (cancel · supersede): the claim goes back, so another path may still carry it.
      else adapter.release('notice', [mapped.msgId]);
    })
    : null;
  /** CAPSULE-C3: queue parked mail the adapter grants again. Returns how many notices it queued. */
  const reofferParked = (room: number): number => {
    if (parked.size === 0) return 0;
    const claim = adapter.claim('notice', [...parked.keys()]);
    for (const id of claim.duplicate) parked.delete(id);
    let queued = 0;
    for (const id of claim.granted) {
      const mapped = parked.get(id)!;
      if (queued >= room) { adapter.release('notice', [id]); continue; }
      parked.delete(id);
      const item = producers.seatMessageArrived(mapped.message);
      if (item === null) continue; // the same msgId is already queued
      noticeMessages.set(item.id, mapped);
      queued += 1;
      log('seat-mail-requeued', { msgId: id, seat: mapped.seat, attempt: mapped.attempt });
    }
    return queued;
  };
  const noteTurnFinished = (responded: boolean, outcome?: TurnEventOutcome): void => {
    // Another running turn may have acknowledged a message after the watcher
    // queued it. Recheck the authoritative cursor at the idle boundary so that
    // an already-acknowledged notice does not start a second turn.
    if (source && queue.cancel && queue.items.some(item => item.source === 'seat-mail' && typeof item.msgId === 'number')) {
      try {
        const cursor = source.read(cwd, lastMsgId ?? 0)?.cursor;
        if (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0) {
          for (const item of queue.items) {
            if (item.source !== 'seat-mail' || typeof item.msgId !== 'number' || item.msgId > cursor) continue;
            queue.cancel(item.id, 'mail-already-acknowledged');
            try { turnLifeLog('turn-life:event-while-busy', { source: 'seat-mail', action: 'drop', reason: 'already-acknowledged', eventId: item.msgId, itemId: item.id }); } catch { /* observability is fail-open */ }
          }
        }
      } catch (error) {
        (deps.onReadError ?? ((err: unknown) => debug.log('tui.next', 'seat-mail-read-error', { error: String(err) })))(error);
      }
    }
    if (inTurn.size === 0 || !source) return;
    const finished = [...inTurn];
    inTurn.clear();
    const settledOutcome: TurnEventOutcome = responded ? 'responded' : outcome === undefined || outcome === 'responded' ? 'failed' : outcome;
    const settled = adapter.settle('notice', finished.map(([, m]) => m.msgId),
      // An unanswered turn is never «responded» (#38483 seen-only-after-answer), whatever outcome the caller passed.
      settledOutcome);
    const seen = new Set(settled.seen);
    const retry = new Set(settled.retry);
    for (const [itemId, mapped] of finished) {
      if (seen.has(mapped.msgId)) source.receipts?.record({ messageId: mapped.msgId, recipient: mapped.seat, state: 'seen', queueItemId: itemId });
      else if (retry.has(mapped.msgId)) parked.set(mapped.msgId, { ...mapped, attempt: mapped.attempt + 1 });
      else if (settled.gaveUp.includes(mapped.msgId)) log('seat-mail-gave-up', { msgId: mapped.msgId, seat: mapped.seat, attempts: mapped.attempt });
      // OBSERVE-TURN-LIFE-DIAG-COMPLETE — 우편 사건의 끝(ack): 같은 eventId로 사슬을 닫는다(turn-start 지점은 임대 ③ 배선 뒤 완결).
      try { turnLifeLog('turn-life:event-acked', { eventId: mapped.msgId, msgId: mapped.msgId, itemId, source: 'seat-mail', outcome: settledOutcome,
        state: seen.has(mapped.msgId) ? 'seen' : retry.has(mapped.msgId) ? 'retry' : 'gave-up' }); } catch { /* observability is fail-open */ }
    }
    // Cancelled / stopped: due now (no back-off) — back in the queue for the next turn. Failed: the next poll after retryAt.
    const waiting = queue.items.filter((item) => item.source === 'seat-mail' && typeof item.msgId === 'number').length;
    if (reofferParked(Math.max(0, queueCap - waiting)) > 0) deps.onArrived?.();
  };

  const pollMessages = (src: SeatMessageSource): SeatMailPollOutcome => {
    // #38193: a ledger read failure leaves the queue alone (no turn, no steer) — same as the count mode.
    let read: SeatMailMessageRead | null;
    try { read = src.read(cwd, lastMsgId ?? 0); }
    catch (error) {
      (deps.onReadError ?? ((err: unknown) => debug.log('tui.next', 'seat-mail-read-error', { error: String(err) })))(error);
      // CAPSULE-C3 D10: «database is locked» is momentary — read again in 1s, 2s, 4s … not a whole poll period later.
      if (readRetry === null && handle !== null) {
        const wait = adapter.readFailed('notice');
        readRetry = retryTimer.set(() => { readRetry = null; poll(); }, wait);
        log('seat-mail-read-retry', { inMs: wait });
      }
      return { kind: 'read-error' };
    }
    adapter.readOk('notice');
    if (read === null) return { kind: 'no-seat' };
    const first = lastMsgId === null;
    const floor = lastMsgId ?? 0;
    // ELN-SEAT-MAIL-REPLAY: the next floor is the ledger's newest id, not the largest id of a 1000-row page — a page
    // floor walked the whole history forward one page per poll (REL 04:25:16 → 04:26:02: 3641 notices).
    lastMsgId = read.messages.reduce((max, m) => Math.max(max, m.id), Math.max(floor, read.latestId ?? 0));
    if (first && ((read.cursor ?? 0) > 0 || (read.seenSkipped ?? 0) > 0)) {
      log('seat-mail-replay-skipped', { seat: read.seat, cursor: read.cursor ?? 0, seenSkipped: read.seenSkipped ?? 0, unacked: read.messages.length });
    }
    const queuedIds = new Set(queue.items.flatMap((item) => (item.source === 'seat-mail' && typeof item.msgId === 'number' ? [item.msgId] : [])));
    const reoffered = reofferParked(Math.max(0, queueCap - queuedIds.size));
    const alreadyQueued = queuedIds.size + reoffered;
    const fresh: typeof read.messages = [];
    for (const message of [...read.messages].sort((a, b) => a.id - b.id)) {
      // #38517 r2 MF3: the duplicate check runs BEFORE the floor filter — a msgId offered on an earlier poll that comes
      // back (still unanswered, so still unseen) is a dedupe hit, not a silent `id <= floor` drop. One event per msgId
      // per watcher: an unanswered mail reappears on every poll, and an event per poll would be noise.
      if (offered.has(message.id) || queuedIds.has(message.id)) {
        if (!dedupeLogged.has(message.id)) {
          dedupeLogged.add(message.id);
          log('seat-mail-dedupe-hit', { seat: read.seat, msgId: message.id });
        }
        continue;
      }
      // At or below the floor and never offered by this watcher: it was announced by an earlier overflow summary.
      if (message.id <= floor) continue;
      queuedIds.add(message.id); // a second copy of the same row in this read is a dedupe hit too
      fresh.push(message);
    }
    const truncated = read.truncated === true;
    const lastReturnedId = read.messages.reduce((max, m) => Math.max(max, m.id), floor);
    // A truncated read announces only mail newer than what an earlier summary already announced (no summary per poll).
    const newlyTruncated = truncated && Math.max(read.latestId ?? lastReturnedId, lastReturnedId) > summarizedThrough;
    if (reoffered > 0) deps.onArrived?.();
    if (fresh.length === 0 && !newlyTruncated) return first ? { kind: 'baseline', unread: read.unreadTotal ?? read.messages.length } : { kind: 'quiet', unread: read.unreadTotal ?? read.messages.length };
    const room = Math.max(0, queueCap - alreadyQueued);
    let taken = fresh.slice(0, room);
    if (taken.length > 0) {
      // CAPSULE-C3 D9: one owner per msgId — mail the plan already carries is not a second turn; mail behind an open
      // circuit waits parked (offered, so the next poll does not see it as new).
      const claim = adapter.claim('notice', taken.map((m) => m.id));
      const granted = new Set(claim.granted);
      for (const message of taken) {
        if (granted.has(message.id)) continue;
        offered.add(message.id);
        if (claim.waiting.includes(message.id)) {
          parked.set(message.id, { msgId: message.id, seat: read.seat, attempt: 1, message: { id: message.id, sender: message.from,
            body: message.body, kind: message.kind ?? null, ...headerFieldsOf(message),
            ...(read.unreadTotal === undefined ? {} : { unreadTotal: read.unreadTotal }),
            ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }) } });
        } else log('seat-mail-dedupe-hit', { seat: read.seat, msgId: message.id, owner: adapter.owner(message.id) });
      }
      const over = fresh.slice(taken.length);
      taken = taken.filter((m) => granted.has(m.id));
      if (taken.length === 0 && over.length === 0 && !newlyTruncated) return { kind: 'messages', msgIds: [] };
    }
    const over = fresh.slice(room);
    const msgIds: number[] = [];
    for (const message of taken) {
      const input = {
        id: message.id,
        sender: message.from,
        body: message.body,
        kind: message.kind ?? null,
        ...headerFieldsOf(message),
        ...(read.unreadTotal === undefined ? {} : { unreadTotal: read.unreadTotal }),
        ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
      };
      const item = producers.seatMessageArrived(input);
      if (item === null) continue;
      // OBSERVE-TURN-EVENT-LIFECYCLE — 우편 한 통 도착(큐 적입 직후; busy 여부는 onArrived 문이 판정).
      try { turnLifeLog('turn-life:event-arrived', { source: 'seat-mail', eventId: message.id, msgId: message.id, itemId: item.id, arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
      offered.add(message.id);
      msgIds.push(message.id);
      noticeMessages.set(item.id, { msgId: message.id, seat: read.seat, message: input, attempt: 1 });
      src.receipts?.record({ messageId: message.id, recipient: read.seat, state: 'delivered', queueItemId: item.id });
    }
    // Over the cap, or #38517 r2 MF2 a read that stopped at its limit (any cap, even ≥ the read limit): ONE summary for
    // everything not queued one by one — the floor moves to the ledger's newest id, so without it that mail would be lost.
    if (over.length > 0 || newlyTruncated) {
      const firstId = over[0]?.id ?? lastReturnedId + 1;
      const lastId = truncated ? Math.max(read.latestId ?? lastReturnedId, over.at(-1)?.id ?? lastReturnedId) : over.at(-1)!.id;
      const pending = overflowItemId !== null && queue.items.some((item) => item.id === overflowItemId);
      if (!pending) {
        const summary = queue.enqueueNotice(seatMailOverflowNotice(read.seat, over.length, firstId, lastId, truncated, read.unreadTotal), 'seat-mail');
        overflowItemId = summary.id;
      }
      summarizedThrough = Math.max(summarizedThrough, lastId);
      log('seat-mail-cap-collapse', { seat: read.seat, cap: queueCap, collapsed: over.length, firstId, lastId,
        truncated, summaryQueued: !pending });
      if (!pending && msgIds.length === 0) deps.onArrived?.();
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
    noteTurnFinished,
    start(): void {
      if (handle !== null) return;
      handle = timer.set(poll, intervalMs);
    },
    stop(): void {
      detachTransition?.();
      if (readRetry !== null) { retryTimer.clear(readRetry); readRetry = null; }
      if (handle === null) return;
      timer.clear(handle);
      handle = null;
    },
  };
}
