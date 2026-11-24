import { debug } from '../debug/log.js';
import { emitTurnLife } from '../debug/turn-life.js';
import { readSeatMailSnapshot, resolveSeatId, type SeatMailSnapshot, type SeatMailWatchStatus } from './seat-mail-boot.js';
import { createChildNoticeProducers, type ChildNoticeQueue } from './core/notice-producers.js';
import { headerFieldsOf } from '../msg/msg-context-header.js';
import type { NextTuiQueueTransitionListener } from './core/queue.js';
import { NEXT_TUI_NOTICE_CAP } from './core/queue.js';
import type { SeatMailMessageRead, SeatReceiptWriter } from './seat-message-receipts.js';
import type { TurnEventOutcome } from '../turn-capsule/contract.js';
import type { MessageOrigin } from '../msg/msg-store.js';
import { isDecisionMail } from './seat-mail-priority.js';
import { createSeatMailAdapter, type SeatMailAdapter } from './turn-events/mail-adapter.js';
import { isInfoSeatMail } from './seat-mail-digest.js';
import { mkdirSync, realpathSync, statSync, unwatchFile, watch as fsWatch, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { ALL_SEAT_BELL, readSeatBell, seatBellDir, seatBellFile } from '../msg/seat-bell.js';

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
 * SEAT-MESSAGE-BUS stage 1 — with the seat doorbell armed, polling is only the safety net (watch failure · a missed
 * ring → `tui.seat-mail bell-missed`). Without a bell (no seat · watch failed) the watcher keeps the 15s poll above.
 */
export const SEAT_MAIL_SAFETY_POLL_MS = 120_000;

/** Rings inside this window share one ledger read (3 posts within 100 ms → one read with all three). */
export const SEAT_MAIL_BELL_DEBOUNCE_MS = 250;

/** The OS file watch the bell uses. Injectable for failure tests. `files` = the bell names this listener cares about. */
export type SeatBellWatchFn = (dir: string, onEvent: (filename: string | null) => void, onError: (error: unknown) => void, files: readonly string[]) => { close(): void };

/** Stat-watch period for the bell files (a stat of two tiny files — never a ledger read). */
export const SEAT_MAIL_BELL_STAT_MS = 200;

/**
 * Two OS watches on the bell, either one is enough:
 * - fs.watch on the bell folder (inotify on linux — instant). Probed on node-b (bun 1.4.2 · macOS 11-24): silent for a
 *   path under a symlink (/var → /private/var), and FSEvents batches 0.4–0.8 s behind on the real path — so it is
 *   the fast path only, opened on the realpath.
 * - fs.watchFile on each bell file (stat, {@link SEAT_MAIL_BELL_STAT_MS}) — fires on creation and every ring on every
 *   host; the same adapter the els mail event hub chose for the same bun behaviour (src/els/mail-event-hub.ts).
 * A ring seen by both is one read: the watcher debounces.
 */
const defaultBellWatch: SeatBellWatchFn = (dir, onEvent, _onError, files) => {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* keep the given path */ }
  let watcher: ReturnType<typeof fsWatch> | null = null;
  try {
    watcher = fsWatch(real, { persistent: false }, (_event, filename) => {
      onEvent(filename === null || filename === undefined ? null : String(filename));
    });
    // A dead folder watch leaves the stat watch running — the bell is still heard (only the fast path is gone).
    watcher.on('error', () => { try { watcher?.close(); } catch { /* fail-soft */ } watcher = null; });
    (watcher as { unref?: () => void }).unref?.();
  } catch { watcher = null; /* the stat watch below still hears the bell */ }
  const paths = files.map((file) => join(real, file));
  for (const [index, path] of paths.entries()) {
    const file = files[index]!;
    watchFile(path, { interval: SEAT_MAIL_BELL_STAT_MS, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino) onEvent(file);
    });
  }
  return {
    close: () => {
      try { watcher?.close(); } catch { /* fail-soft */ }
      // bun's two-argument unwatchFile throws — the one-argument form drops this process's listeners for the path.
      for (const path of paths) { try { unwatchFile(path); } catch { /* fail-soft */ } }
    },
  };
};

export interface SeatBellOptions {
  /** The bell folder (`seatBellDir(<ledger path>)`). */
  dir: string;
  /** The seat this process holds — it listens to `<seat>.bell` and `ALL.bell`. */
  seat: string;
  watch?: SeatBellWatchFn;
  debounceMs?: number;
  /** One-shot timer for the debounce (default setTimeout, unref'd). */
  schedule?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>, level: 'debug' | 'info' | 'warn') => void;
}

/**
 * The seat whose bell this process listens to = the seat this cwd holds (the same resolution the ledger reader uses,
 * gated on its seat-state folder). Baton acting is not observable here: the lease lives in the els server process and
 * its display snapshot is not a credential, and the reader only reads this cwd's seat — so own seat only.
 */
export function resolveDefaultSeatBell(cwd: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): SeatBellOptions | null {
  const seat = resolveSeatId(cwd, { env });
  if (seat === null) return null;
  try { if (!statSync(join(home, 'elanous-hq', 'seat-state', seat)).isDirectory()) return null; } catch { return null; }
  return { dir: seatBellDir(join(elanousStateRoot(), 'msg', 'messages.db')), seat };
}

/**
 * ELN-SEAT-MAIL-REPLAY — at most this many per-message seat-mail notices wait in the queue; the rest collapse into ONE
 * summary notice. Each notice opens its own turn, so 20 is already hours of turns. 11-18 live unread inboxes were
 * REL 8 and JUD 2, so an ordinary seat never meets the cap. `ELANOUS_SEAT_MAIL_QUEUE_CAP` (≥ 1) or the watcher option.
 */
export const SEAT_MAIL_QUEUE_CAP = 20;

/**
 * SEAT-STEER-PREEMPT JUD-B MF — a decision mail (any sender) is never folded into the overflow summary. A decision
 * admitted beyond the ordinary cap carries at most this many body characters; the full mail stays in the ledger.
 */
export const SEAT_MAIL_DECISION_OVER_CAP_BODY_MAX = 500;

function boundDecisionBody<T extends { id: number; body: string }>(message: T, seat: string): T {
  if (message.body.length <= SEAT_MAIL_DECISION_OVER_CAP_BODY_MAX) return message;
  return { ...message, body: `${message.body.slice(0, SEAT_MAIL_DECISION_OVER_CAP_BODY_MAX)} … [본문 ${message.body.length}자 중 ${SEAT_MAIL_DECISION_OVER_CAP_BODY_MAX}자 · 전문: eln msg list --to ${seat}]` };
}

export function resolveSeatMailQueueCap(option?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (option !== undefined && Number.isSafeInteger(option) && option >= 1) return option;
  const raw = env.ELANOUS_SEAT_MAIL_QUEUE_CAP;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : SEAT_MAIL_QUEUE_CAP;
}

/** The one notice that stands for the mail over the cap (ids are the ledger's; the seat reads them with `msg list`). */
/**
 * MSG-RECEIPT-IMPLIES-ACK ② — the per-notice counter «[미읽음 총 N통]» counts mail that still needs this seat
 * (`actionableTotal`); reads that predate the field keep the raw unread total.
 */
function noticeTotalField(read: SeatMailMessageRead): { unreadTotal?: number } {
  const total = read.actionableTotal ?? read.unreadTotal;
  return total === undefined ? {} : { unreadTotal: total };
}

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
  /** Live health: running requires a successful seat read, not merely an armed timer. */
  getStatus(): SeatMailWatchStatus;
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

/** OP #106762 ⓐ — what `onArrived` carries: the ledger msgId (세션 1회 계약의 키) and the queued notice text. */
export interface SeatMailArrivalInfo {
  /** Ledger msgId — 수 모드 노티스엔 없다. */
  readonly msgId?: number;
  /** 큐 항목과 같은 문면(seatMessageNotice — 머리줄 ⊕ msg:<id> ⊕ 전문). */
  readonly text: string;
  /** 받은 자리. */
  readonly seat: string;
  /** 보낸 자리. */
  readonly sender?: string;
  /** Structured ledger fields; the rendered notice body is never parsed for priority. */
  readonly origin?: MessageOrigin;
  readonly intent?: string | null;
  readonly crownDirective?: string | null;
  /** The ledger `replyTo` (structured reply correlation — never parsed from the body). */
  readonly replyTo?: number;
  readonly createdAt?: string;
  /** SEAT-MAIL-COALESCE-NOTICE — an info mail: it waits for the next digest (no mid-turn carry, no wake of its own). */
  readonly passive?: boolean;
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
     *
     * OP #106762 ⓐ — receives what actually arrived (msgId · the queued notice text · seats) so a busy
     * turn's mid-turn event can carry the real body. undefined = a re-submission with no fresh info.
     */
    onArrived?: (arrivals?: readonly SeatMailArrivalInfo[]) => void;
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
    /**
     * SEAT-MESSAGE-BUS stage 1 — the seat doorbell. Default (no `bell` and no injected `timer`): resolved from cwd
     * ({@link resolveDefaultSeatBell}). An injected `timer` means the caller drives time, so the bell stays off unless
     * passed. `false` = off.
     */
    bell?: SeatBellOptions | false;
    heartbeat?: { getSessionId: () => string | null; seatStateRoot?: string; host?: string;
      schedule?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
      cancel?: (timer: ReturnType<typeof setInterval>) => void };
  } = {},
): SeatMailArrivalWatcher {
  const read = deps.readSnapshot ?? readSeatMailSnapshot;
  const bellOptions: SeatBellOptions | null = deps.bell === false ? null
    : deps.bell ?? (deps.timer === undefined ? (() => { try { return resolveDefaultSeatBell(cwd); } catch { return null; } })() : null);
  const timer = deps.timer ?? {
    set: (fn: () => void, ms: number) => setInterval(fn, ms),
    clear: (handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
  };
  // OBSERVE-TURN-EVENT-LIFECYCLE — 우편 관측 주입(기본: debug 직접 방출).
  const turnLifeLog = deps.turnLifeLog ?? emitTurnLife;
  const producers = createChildNoticeProducers(queue);
  let lastUnread: number | null = null;
  let handle: unknown = null;
  let heartbeat: { stop(): void } | null = null;
  let status: SeatMailWatchStatus = 'stopped';
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
  let detachTransition: (() => void) | null = null;
  const attachTransition = (): void => {
    if (detachTransition || !source || !queue.onTransition) return;
    detachTransition = queue.onTransition((item) => {
      const mapped = noticeMessages.get(item.id);
      if (mapped === undefined) return;
      noticeMessages.delete(item.id);
      // «mid-turn-carried»: the running turn drained this mail into its model input, so that turn's outcome settles it
      // (seen on a completed turn · retry on failed/cancelled) — releasing it here would leave it processed but never acked.
      if (item.status === 'cancelled' && item.cancelReason === 'mid-turn-carried') {
        inTurn.set(item.id, mapped);
        return;
      }
      if (item.status === 'delivered') {
        inTurn.set(item.id, mapped);
        // [seat-mail #14 wiring] started 계기 — 큐가 턴에 인계한 순간(orphan guard·fail-soft는 sink/writer 안).
        source?.receipts?.recordStarted?.({ messageId: mapped.msgId, recipient: mapped.seat, eventId: item.id });
      }
      // Dropped before any turn (cancel · supersede): the claim goes back, so another path may still carry it.
      else adapter.release('notice', [mapped.msgId]);
    });
  };
  // Manual poll() before start is supported too.
  attachTransition();
  /** CAPSULE-C3: queue parked mail the adapter grants again. Returns how many notices it queued. */
  const reofferParked = (room: number): number => {
    if (parked.size === 0) return 0;
    const claim = adapter.claim('notice', [...parked.keys()]);
    for (const id of claim.duplicate) parked.delete(id);
    let queued = 0;
    let ordinaryQueued = 0;
    for (const id of claim.granted) {
      const mapped = parked.get(id)!;
      // A parked decision is never held back by the ordinary cap (JUD-B MF) — delivery only, no priority.
      const decision = isDecisionMail(mapped.message);
      if (!decision && ordinaryQueued >= room) { adapter.release('notice', [id]); continue; }
      parked.delete(id);
      const item = producers.seatMessageArrived(mapped.message);
      if (item === null) continue; // the same msgId is already queued
      noticeMessages.set(item.id, mapped);
      queued += 1;
      if (!decision) ordinaryQueued += 1;
      log('seat-mail-requeued', { msgId: id, seat: mapped.seat, attempt: mapped.attempt });
    }
    return queued;
  };
  /**
   * OP #129667 ①(SEAT-NOTICE-BUNDLE-DRAIN 수리) — 큐 상한(NEXT_TUI_NOTICE_CAP)은 모든 대기 알림을
   * 센다(자리 우편만이 아님). 이 값이 자리 우편이 실제 항목이 될 수 있는 남은 방이다: 방이 없으면
   * 우편은 큐에 들가지 않고(가이드 항목이 우편 msgId 를 가로채는 일 없이) pending 으로 남아
   * 다음 poll 이 다시 제공한다.
   */
  const queueNoticeRoom = (): number =>
    Math.max(0, NEXT_TUI_NOTICE_CAP - queue.items.filter((item) => item.kind === 'notice').length);
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
    if (inTurn.size === 0 || !source) { bellRecheck(); return; }
    const finished = [...inTurn];
    inTurn.clear();
    // `responded` only says some output or tool activity appeared. «seen» (the ack) needs a completed turn: an outcome of
    // cancelled · stopped · failed wins over responded=true (a partial answer then cancel must not ack — it is retried).
    // No outcome given (older callers) keeps the plain responded → seen meaning.
    const settledOutcome: TurnEventOutcome = outcome === 'cancelled' || outcome === 'stopped' || outcome === 'failed' ? outcome
      : responded ? 'responded' : 'failed';
    const settled = adapter.settle('notice', finished.map(([, m]) => m.msgId),
      // An unanswered turn is never «responded» (#38483 seen-only-after-answer), whatever outcome the caller passed.
      settledOutcome);
    const seen = new Set(settled.seen);
    const retry = new Set(settled.retry);
    for (const [itemId, mapped] of finished) {
      if (seen.has(mapped.msgId)) {
        source.receipts?.record({ messageId: mapped.msgId, recipient: mapped.seat, state: 'seen', queueItemId: itemId });
        // [seat-mail #16 wiring · S7 트리거] done 계기 — 턴이 이 우편에 답을 마친 순간(seen 정착 = answered).
        source?.receipts?.recordDone?.({ messageId: mapped.msgId, recipient: mapped.seat });
        // SEAT-MAIL-COALESCE-NOTICE · MSG-FILTERS-RELAX — every mail whose body rode the completed turn (info AND request)
        // is acked by id (never a cursor move) once the turn finished without error; the seat need not ack it by hand.
        source.receipts?.ack?.({ messageId: mapped.msgId, recipient: mapped.seat });
        log(isInfoSeatMail(mapped.message) ? 'seat-mail-info-acked' : 'seat-mail-turn-acked', { msgId: mapped.msgId, seat: mapped.seat });
      }
      else if (retry.has(mapped.msgId)) parked.set(mapped.msgId, { ...mapped, attempt: mapped.attempt + 1 });
      else if (settled.gaveUp.includes(mapped.msgId)) log('seat-mail-gave-up', { msgId: mapped.msgId, seat: mapped.seat, attempts: mapped.attempt });
      // OBSERVE-TURN-LIFE-DIAG-COMPLETE — 우편 사건의 끝(ack): 같은 eventId로 사슬을 닫는다(turn-start 지점은 임대 ③ 배선 뒤 완결).
      try { turnLifeLog('turn-life:event-acked', { eventId: mapped.msgId, msgId: mapped.msgId, itemId, source: 'seat-mail', outcome: settledOutcome,
        state: seen.has(mapped.msgId) ? 'seen' : retry.has(mapped.msgId) ? 'retry' : 'gave-up' }); } catch { /* observability is fail-open */ }
    }
    // Cancelled / stopped: due now (no back-off) — back in the queue for the next turn. Failed: the next poll after retryAt.
    const waiting = queue.items.filter((item) => item.source === 'seat-mail' && typeof item.msgId === 'number').length;
    if (reofferParked(Math.max(0, Math.min(queueCap - waiting, queueNoticeRoom()))) > 0) deps.onArrived?.();
    bellRecheck();
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
    // OP #129667 ②③ — floor 갱신은 taken 확정 뒤로 미뤘다(아래): 읽힌 최대 id(lastestId 포함)를
    // 무조건 넘기면 상한 밖 pending 우편이 floor 너머로 밀려 다음 poll 이 다시 내놓지 못한다.
    if (first && ((read.cursor ?? 0) > 0 || (read.seenSkipped ?? 0) > 0)) {
      log('seat-mail-replay-skipped', { seat: read.seat, cursor: read.cursor ?? 0, seenSkipped: read.seenSkipped ?? 0, unacked: read.messages.length });
    }
    const queuedIds = new Set(queue.items.flatMap((item) => (item.source === 'seat-mail' && typeof item.msgId === 'number' ? [item.msgId] : [])));
    // OP #129667 ① — reoffer 전에 잰다: reoffered 는 이 방에서 나간다(큐 항목이 되니까).
    const queueRoom = queueNoticeRoom();
    const reoffered = reofferParked(Math.max(0, Math.min(queueCap - queuedIds.size, queueRoom)));
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
    // OP #129667 ① — 자리 우편 상한(queueCap)과 큐 알림 상한(NEXT_TUI_NOTICE_CAP) 둘 다 지킨다:
    // queueRoom 중 reoffered 가 이미 쓴 방을 빼면, 이번 poll 이 새로 넣을 수 있는 우편 수다.
    // ② — truncated 안내 한 줄도 큐 방 하나를 쓴다: 그 방을 남겨둔다. 안내가 가이드로 접히면
    // 읽기 한계 너머 꼬리(다시 닿을 수 없다)가 영영 조용해진다.
    const room = Math.max(0, Math.min(queueCap - alreadyQueued, queueRoom - reoffered - (newlyTruncated ? 1 : 0)));
    // JUD-B MF (OP rule · main 병합 보존): a decision mail (structured intent, ANY sender — the sender name is
    // not authenticated) is never collapsed into the read-the-inbox summary — every one is queued in msgId order,
    // so each body reaches the next actual turn. Decisions use ordinary room first; those beyond the cap carry a
    // bounded body plus a ledger pointer. Only ordinary notices stay pending for the next poll (OP #129667 ②).
    // This is a delivery guarantee, not a priority.
    const decisions = fresh.filter((message) => isDecisionMail(message));
    const decisionIds = new Set(decisions.map((message) => message.id));
    const selectedDecisions = decisions.map((message, index) => (index < room ? message : boundDecisionBody(message, read.seat)));
    const selectedOrdinary = fresh.filter((message) => !decisionIds.has(message.id))
      .slice(0, Math.max(0, room - selectedDecisions.length));
    let taken = [...selectedDecisions, ...selectedOrdinary].sort((a, b) => a.id - b.id);
    const selectedIds = new Set(taken.map((message) => message.id));
    const over = fresh.filter((message) => !selectedIds.has(message.id));
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
            ...(message.origin ? { origin: message.origin } : {}),
            ...(typeof message.replyTo === 'number' ? { replyTo: message.replyTo } : {}),
            ...noticeTotalField(read),
            ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }) } });
        } else log('seat-mail-dedupe-hit', { seat: read.seat, msgId: message.id, owner: adapter.owner(message.id) });
      }
      taken = taken.filter((m) => granted.has(m.id));
      if (taken.length === 0 && over.length === 0 && !newlyTruncated) return { kind: 'messages', msgIds: [] };
    }
    // OP #129667 ②③ — floor 는 실제로 큐 항목이 된(granted) 우편만큼만 올라간다. 상한 밖
    // pending 우편은 floor 너머로 밀리지 않는다 → 다음 poll 이 그대로 다시 제공한다(재시작 불요).
    // truncated 읽기만 예외: 읽기 한계 너머 꼬리는 poll 이 다시 닿을 수 없으니 latestId 까지(아래 안내와 한 쌍).
    lastMsgId = truncated
      ? Math.max(floor, read.latestId ?? 0)
      : taken.reduce((max, m) => Math.max(max, m.id), floor);
    const msgIds: number[] = [];
    const arrivals: SeatMailArrivalInfo[] = []; // OP #106762 ⓐ — onArrived 가 실 도착 정보(msgId·본문 문면·자리)를 싣는다
    for (const message of taken) {
      const input = {
        id: message.id,
        sender: message.from,
        body: message.body,
        kind: message.kind ?? null,
        ...headerFieldsOf(message),
        ...(message.origin ? { origin: message.origin } : {}),
        ...(typeof message.replyTo === 'number' ? { replyTo: message.replyTo } : {}),
        ...noticeTotalField(read),
        ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
      };
      const item = producers.seatMessageArrived(input);
      if (item === null) continue;
      // OBSERVE-TURN-EVENT-LIFECYCLE — 우편 한 통 도착(큐 적입 직후; busy 여부는 onArrived 문이 판정).
      try { turnLifeLog('turn-life:event-arrived', { source: 'seat-mail', eventId: message.id, msgId: message.id, itemId: item.id, arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
      offered.add(message.id);
      msgIds.push(message.id);
      arrivals.push({ msgId: message.id, seat: read.seat, sender: message.from, text: item.text, ...(item.passive ? { passive: true } : {}),
        ...(message.origin ? { origin: message.origin } : {}),
        ...(message.intent ? { intent: message.intent } : {}),
        ...(message.crownDirective ? { crownDirective: message.crownDirective } : {}),
        ...(typeof message.replyTo === 'number' ? { replyTo: message.replyTo } : {}),
        ...(message.createdAt ? { createdAt: message.createdAt } : {}) });
      noticeMessages.set(item.id, { msgId: message.id, seat: read.seat, message: input, attempt: 1 });
      src.receipts?.record({ messageId: message.id, recipient: read.seat, state: 'delivered', queueItemId: item.id });
    }
    // OP #129667 ① — 상한 밖 우편(over)은 원장 안내 한 줄로 접는다(완료선: 넘치면 안내 한 줄 · main #39526 seat-mail-replay 계약 복원).
    // ③ — 접힌 우편 자체는 pending: floor 는 granted(taken)만큼만 올라가(위 lastMsgId) 다음 poll 이 다시 제공한다(재시작 불요).
    // ② — truncated 읽기(#38517 r2 MF2 — 읽기 한계 너머 꼬리)에도 안내는 반드시 한 줄: 위 room 계산이 방 1칸을 예약한다.
    if (over.length > 0 || newlyTruncated) {
      const firstId = over[0]?.id ?? lastReturnedId + 1;
      const lastId = truncated ? Math.max(read.latestId ?? lastReturnedId, over.at(-1)?.id ?? lastReturnedId) : over.at(-1)!.id;
      const pending = overflowItemId !== null && queue.items.some((item) => item.id === overflowItemId);
      if (!pending) {
        // OP #130302/#130531 합의 — 안내는 «seat-mail-guide» 별도 종류(msgId 없음 · poll당 1줄 · 초과든 truncated든).
        const summary = queue.enqueueNotice(seatMailOverflowNotice(read.seat, over.length, firstId, lastId, truncated, read.unreadTotal), 'seat-mail-guide');
        overflowItemId = summary.id;
      }
      summarizedThrough = Math.max(summarizedThrough, lastId);
      log('seat-mail-cap-collapse', { seat: read.seat, cap: queueCap, collapsed: over.length, firstId, lastId,
        truncated, summaryQueued: !pending });
      if (!pending && msgIds.length === 0) deps.onArrived?.();
    }
    // #38193: a new notice wakes the idle door once (the TUI decides: idle → next turn · busy → stays queued, no steer).
    // Duplicates (same msgId still queued) are not new arrivals.
    if (msgIds.length > 0) deps.onArrived?.(arrivals);
    return { kind: 'messages', msgIds };
  };

  let pollGeneration = 0;
  const poll = (): SeatMailPollOutcome => {
    const generation = ++pollGeneration;
    const outcome = pollOnce();
    if (handle !== null && generation === pollGeneration) status = outcome.kind === 'read-error' || outcome.kind === 'no-seat' ? 'read-error' : 'running';
    return outcome;
  };

  const pollOnce = (): SeatMailPollOutcome => {
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
      // OP #106762 ⓐ — 수 모드 노티스엔 msgId 가 없다(정보만 전달; 어댑터는 세션 1회 계약이 못 되는 이벤트를 만들지 않는다).
      if (item !== null) deps.onArrived?.([{ text: item.text, seat: snapshot.seat }]);
      return { kind: 'arrived', unread: snapshot.unread, noticeText: item === null ? null : item.text };
    }
    lastUnread = snapshot.unread;
    return { kind: 'quiet', unread: snapshot.unread };
  };

  // SEAT-MESSAGE-BUS stage 1 — the doorbell. A ring (msg post · relay · ack · terminal receipt) wakes one ledger read
  // after a short debounce; the interval timer above becomes the safety net only.
  const bellSchedule = bellOptions?.schedule ?? {
    set: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clear: (h: unknown) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  };
  const bellNow = bellOptions?.now ?? Date.now;
  const bellLog = bellOptions?.log ?? ((event: string, data: Record<string, unknown>, level: 'debug' | 'info' | 'warn') => {
    try { debug.log('tui.seat-mail', event, data, { level }); } catch { /* observability is fail-open */ }
  });
  const bellFiles = bellOptions ? new Set([seatBellFile(bellOptions.seat), seatBellFile(ALL_SEAT_BELL)]) : new Set<string>();
  let bellWatch: { close(): void } | null = null;
  let bellDebounce: unknown = null;
  let bellRangAt: number | null = null;
  /** Highest lastMsgId across this seat's bells at the last read — the final re-check compares against it. */
  let bellSeenThrough = 0;
  const bellStamps = (): { through: number; at: number | null } => {
    if (!bellOptions) return { through: 0, at: null };
    let through = 0;
    let at: number | null = null;
    for (const file of bellFiles) {
      const stamp = readSeatBell(join(bellOptions.dir, file));
      if (stamp === null) continue;
      through = Math.max(through, stamp.lastMsgId);
      const rungAt = Date.parse(stamp.at);
      if (Number.isFinite(rungAt)) at = Math.max(at ?? 0, rungAt);
    }
    return { through, at };
  };
  const bellStampNow = (): number => bellStamps().through;
  const bellRead = (reason: 'ring' | 'start' | 'settle'): void => {
    if (bellDebounce !== null) { bellSchedule.clear(bellDebounce); bellDebounce = null; }
    const rangAt = bellRangAt;
    bellRangAt = null;
    const stamps = bellStamps();
    bellSeenThrough = Math.max(bellSeenThrough, stamps.through);
    // latency = ring written → read starts (the newest stamp's own clock; the first observed event when unreadable).
    if (reason === 'ring' && rangAt !== null) bellLog('bell-wake', { latencyMs: Math.max(0, bellNow() - (stamps.at ?? rangAt)) }, 'debug');
    if (handle === null) return;
    try { poll(); } catch (error) { bellLog('bell-read-failed', { error: String(error) }, 'warn'); }
  };
  const ring = (filename: string | null, reason: 'ring' | 'start' = 'ring'): void => {
    if (filename !== null && !bellFiles.has(filename)) return; // tmp files of the atomic write · other seats' bells
    if (handle === null) return;
    bellRangAt ??= bellNow();
    if (bellDebounce !== null) return; // one read for every ring inside the window
    bellDebounce = bellSchedule.set(() => { bellDebounce = null; bellRead(reason); }, bellOptions?.debounceMs ?? SEAT_MAIL_BELL_DEBOUNCE_MS);
  };
  const disarmBell = (): void => {
    if (bellDebounce !== null) { bellSchedule.clear(bellDebounce); bellDebounce = null; }
    bellRangAt = null;
    try { bellWatch?.close(); } catch { /* fail-soft */ }
    bellWatch = null;
  };
  const bellLost = (error: unknown): void => {
    // The watch died: go back to the plain 15s poll (the safety net would otherwise be the only path for 2 minutes).
    bellLog('bell-watch-failed', { seat: bellOptions?.seat, error: String(error) }, 'warn');
    disarmBell();
    if (handle === null || deps.intervalMs !== undefined) return;
    try { timer.clear(handle); handle = timer.set(safetyTick, DEFAULT_SEAT_MAIL_POLL_MS); } catch { /* keep the old timer */ }
  };
  const armBell = (): boolean => {
    if (!bellOptions) return false;
    try {
      mkdirSync(bellOptions.dir, { recursive: true });
      bellWatch = (bellOptions.watch ?? defaultBellWatch)(bellOptions.dir, (filename) => ring(filename), bellLost, [...bellFiles]);
      bellSeenThrough = bellStampNow();
      return true;
    } catch (error) {
      bellLog('bell-watch-failed', { seat: bellOptions.seat, error: String(error) }, 'warn');
      bellWatch = null;
      return false;
    }
  };
  /** The safety net: a read that finds mail the bell never announced is a miss — one info line, then it delivers. */
  const safetyTick = (): void => {
    const outcome = poll();
    if (!bellOptions || bellDebounce !== null) return; // a ring is already on its way — not a miss
    const count = outcome.kind === 'messages' ? outcome.msgIds.length : outcome.kind === 'arrived' ? 1 : 0;
    if (count > 0) bellLog('bell-missed', { count, seat: bellOptions.seat, watching: bellWatch !== null }, 'info');
  };
  /**
   * Final re-check right before the queue goes idle (opencode run-coordinator pattern): a ring that landed while the
   * turn settled is read now instead of waiting for the next ring or the safety net.
   */
  const bellRecheck = (): void => {
    if (!bellOptions || bellWatch === null || handle === null) return;
    if (bellDebounce !== null || bellStampNow() > bellSeenThrough) bellRead('settle');
  };

  return {
    getStatus: () => status,
    poll,
    noteTurnFinished,
    start(): void {
      if (handle !== null) return;
      attachTransition();
      status = 'starting';
      const bellOn = armBell();
      try { handle = timer.set(safetyTick, deps.intervalMs ?? (bellOn ? SEAT_MAIL_SAFETY_POLL_MS : DEFAULT_SEAT_MAIL_POLL_MS)); }
      catch (error) { disarmBell(); status = 'start-error'; throw error; }
      // Mail that landed before this process listened: one read right after boot, not a safety period later.
      if (bellOn) ring(null, 'start');
      try {
        if (deps.heartbeat) {
          const { resolveSeatId } = require('./seat-mail-boot.js') as typeof import('./seat-mail-boot.js');
          const seat = resolveSeatId(cwd);
          if (seat) {
            const { startInboxHeartbeat, seatInboxAlivePath, writeInboxBeatAtomic } = require('../loops/inbox-liveness.js') as typeof import('../loops/inbox-liveness.js');
            const { resolveSeatStateRoot } = require('../loops/msg-wake.js') as typeof import('../loops/msg-wake.js');
            const { hostname } = require('node:os') as typeof import('node:os');
            const hb = deps.heartbeat;
            heartbeat = startInboxHeartbeat(seatInboxAlivePath(hb.seatStateRoot ?? resolveSeatStateRoot(), seat),
              { pid: process.pid, host: hb.host ?? hostname(), sessionId: '' }, {
                getSessionId: () => { try { return status === 'running' ? hb.getSessionId() : null; } catch { return null; } },
                write: (path, payload) => { try { writeInboxBeatAtomic(path, payload); } catch { /* fail-soft */ } },
                ...(hb.schedule ? { schedule: hb.schedule } : {}), ...(hb.cancel ? { cancel: hb.cancel } : {}),
              });
          }
        }
      } catch { /* heartbeat is optional; polling must continue */ }
    },
    stop(): void {
      try { heartbeat?.stop(); } catch { /* fail-soft */ }
      heartbeat = null;
      ++pollGeneration;
      status = 'stopped';
      detachTransition?.();
      detachTransition = null;
      disarmBell();
      if (readRetry !== null) { retryTimer.clear(readRetry); readRetry = null; }
      if (handle === null) return;
      timer.clear(handle);
      handle = null;
    },
  };
}
