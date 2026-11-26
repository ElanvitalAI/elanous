// HAND-RAISE-REPLY-GATE (OP 11-25) — a ✋ NEED HUMAN mail is closed by an OUTCOME, not by a turn that «saw» it.
//
// S: JUD's ✋ #160695 (11:18) was settled `seen` / `turn-life:event-acked outcome:responded` the moment OP's turn ended,
//    while OP only wrote «다음 점검에서 확인하겠습니다».
// C: the system, not the model, must hold the ✋ open until the receiving seat gives it one outcome.
// Q: how is «closed» decided without reading words, and who climbs when the receiver does not?
// A: structured fields only — a ✋ mail is one whose refs carry `block:` and `reason:`; «closed» = an outcome row on the
//    ledger (HAND-RAISE-LADDER: resolve / reject reply, an escalation forward, or a reply to the sender). At the turn end
//    an unanswered ✋ is recorded `seen` but never acked / done (outcome `unanswered`). This gate is the receiver's own
//    reminder: 5 min open → one P0 item («give one outcome before it auto-escalates at 10m»); ≥3 open of the same shape →
//    ONE «change the rule» P0 item instead of one per hand. Climbing is NOT here any more: #40053's 20-min CLAUDE-OP mail
//    is replaced by the federation ladder sweep (src/msg/hand-raise-ladder.ts — 10 min → parent, OP → CEO card).
//
// 세 얼굴:
//   관측 = debug.log('tui', 'needhuman.open' | 'needhuman.unanswered' | 'needhuman.bulk' | 'needhuman.replied' | 'needhuman.expired')
//   인지 = isHandRaiseMail() (refs) · closed() (ledger outcome rows) — never the body
//   수복과 인계 = P0 reminder at 5 min · one bulk item per same-rule group · the ladder sweep climbs at 10 min

import type { MsgStore } from '../msg/msg-store.js';

export const HAND_RAISE_SURFACE_AFTER_MS = 5 * 60_000;
/** An open ✋ is dropped (logged) after this — the ladder reached the CEO long before. */
export const HAND_RAISE_FORGET_AFTER_MS = 2 * 60 * 60_000;
/** Same-shape (same reason code) open hands at this seat that become one «change the rule» item. */
export const HAND_RAISE_BULK_MIN = 3;
/** How often the TUI checks the open ✋ mails and runs the ladder sweep. */
export const HAND_RAISE_TICK_MS = 60_000;

/** A ✋ NEED HUMAN mail: NEED-HUMAN-PUSH puts `block:<id>` and `reason:<code>` in its refs (structured — never the body). */
export function isHandRaiseMail(m: { readonly refs?: readonly string[] | null }): boolean {
  const refs = m.refs ?? [];
  return refs.some((r) => r.startsWith('block:')) && refs.some((r) => r.startsWith('reason:'));
}

export interface HandRaiseQuery {
  readonly msgId: number;
  /** The receiving seat (who must answer). */
  readonly seat: string;
  /** The seat that raised its hand. */
  readonly sender: string;
  readonly correlationId?: string;
  /** The `reason:` code — the «shape» bulk grouping uses. */
  readonly reason?: string;
}

export interface HandRaiseOpen extends HandRaiseQuery {
  /** When the ✋ mail arrived (ledger created_at, else the moment it was found unanswered). */
  readonly openedAt: number;
  surfaced: boolean;
  /** The line this item put on the screen/queue (MSG-PENDING-QUESTION-STALE: retracted when the item closes). */
  surfacedLine?: string;
}

/**
 * Did `seat` (or CLAUDE-OP) reply to ✋ #msgId from `sender`? A later row to the sender whose reply_to is the ✋ id, or
 * which carries the same correlation id. (The ladder's handClosedOn adds resolve / reject / escalate outcomes.)
 */
export function handRaiseRepliedOn(store: Pick<MsgStore, 'db'>, q: HandRaiseQuery): boolean {
  // Lazy: the seat-mail watcher imports this module for isHandRaiseMail and must not load the ledger module eagerly.
  const { canonicalMessageAddress } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const seat = canonicalMessageAddress(q.seat);
  const sender = canonicalMessageAddress(q.sender);
  const responders = [seat, 'CLAUDE-OP'];
  const hasCorrelation = (store.db.query("SELECT COUNT(*) AS n FROM pragma_table_info('msg_messages') WHERE name = 'correlation_id'").get() as { n: number }).n > 0;
  const correlation = hasCorrelation && q.correlationId ? ' OR correlation_id = ?' : '';
  const row = store.db.query(`SELECT 1 FROM msg_messages WHERE id > ? AND sender IN (?, ?) AND recipient = ?
    AND (reply_to = ?${correlation}) LIMIT 1`)
    .get(...[q.msgId, ...responders, sender, q.msgId, ...(correlation ? [q.correlationId!] : [])]);
  return row !== null && row !== undefined;
}

/** Closed on the ledger by any outcome (resolve · reject · escalate · reply) — the production `closed` dep. */
export function handRaiseClosedOn(store: MsgStore, q: HandRaiseQuery): boolean {
  const ladder = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js');
  const hand = ladder.readHandMail(store, q.msgId);
  if (!hand) return handRaiseRepliedOn(store, q);
  return ladder.handClosedOn(store, hand) !== null;
}

export interface HandRaiseGateDeps {
  readonly now: () => number;
  /** The ✋ has an outcome on the ledger. */
  readonly closed: (q: HandRaiseQuery) => boolean;
  /** Put one P0 item at the top of the queue (and wake the idle door). */
  readonly surface: (line: string, opens: readonly HandRaiseOpen[]) => void;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /**
   * MSG-PENDING-QUESTION-STALE — an item closed (answered · acked · dismissed) or expired after its line was surfaced:
   * take that line back off the screen and the queue. Omitted = the line stays (old behaviour).
   */
  readonly retract?: (line: string, open: HandRaiseOpen) => void;
}

export interface HandRaiseReplyGate {
  /** ✋ #msgId is held open at this seat (arrival or a turn end without an outcome). Idempotent. */
  noteUnanswered(input: HandRaiseQuery & { readonly arrivedAt?: number }): void;
  /** Re-check every open ✋ (outcome → closed · 5 min → P0 reminder · ≥3 same shape → one bulk item). */
  tick(): void;
  open(): readonly HandRaiseOpen[];
  /** /new — drop every open item (their surfaced lines are retracted) and return them for one digest line. */
  dropAll(): readonly HandRaiseOpen[];
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));

/** The P0 reminder line (English UI text). */
export const handRaiseSurfaceLine = (sender: string, waitedMs: number, msgId: number): string =>
  `✋ ${sender} waiting ${minutes(waitedMs)}m — give one outcome before it auto-escalates at 10m: eln msg hand ${msgId} resolve|reject|escalate "<text>"`;

/** The one P0 line for ≥3 open hands of the same shape (English UI text). */
export const handRaiseBulkLine = (reason: string, opens: readonly Pick<HandRaiseOpen, 'sender' | 'msgId'>[]): string =>
  `✋ ${opens.length} hands blocked on the same rule — change the rule (reason ${reason} · ${opens.map((o) => `${o.sender} #${o.msgId}`).join(', ')})`;

/**
 * MSG-WAIT-CONTRACT ④ — the same open-item machinery for a received question/decision (not a ✋): its own surface delay,
 * line and log prefix, no bulk grouping. Omitted = the ✋ gate exactly as before.
 */
export interface OpenItemGateOptions {
  readonly surfaceAfterMs?: number;
  readonly surfaceLine?: (sender: string, waitedMs: number, msgId: number) => string;
  /** false = never group same-shape items into one «change the rule» item. */
  readonly bulk?: boolean;
  /** Log event prefix (default `needhuman`). */
  readonly eventPrefix?: string;
}

export function createHandRaiseReplyGate(deps: HandRaiseGateDeps, options: OpenItemGateOptions = {}): HandRaiseReplyGate {
  const surfaceAfterMs = options.surfaceAfterMs ?? HAND_RAISE_SURFACE_AFTER_MS;
  const surfaceLine = options.surfaceLine ?? handRaiseSurfaceLine;
  const bulkOn = options.bulk !== false;
  const prefix = options.eventPrefix ?? 'needhuman';
  const opens = new Map<number, HandRaiseOpen>();
  /** reason → the group size last surfaced as one bulk item (a bigger group surfaces once more). */
  const bulkSurfaced = new Map<string, number>();
  const log = (event: string, data: Record<string, unknown>): void => { try { deps.log?.(prefix === 'needhuman' ? event : event.replace(/^needhuman\./, `${prefix}.`), data); } catch { /* fail-open */ } };
  const closedSafe = (q: HandRaiseQuery): boolean | null => {
    try { return deps.closed(q); } catch (error) { log('needhuman.check-failed', { msgId: q.msgId, error: String(error).slice(0, 200) }); return null; }
  };
  const surface = (line: string, list: readonly HandRaiseOpen[]): void => {
    try { deps.surface(line, list); } catch (error) { log('needhuman.surface-failed', { msgIds: list.map((o) => o.msgId), error: String(error).slice(0, 200) }); }
  };
  const retract = (open: HandRaiseOpen): void => {
    if (!open.surfacedLine || !deps.retract) return;
    try { deps.retract(open.surfacedLine, open); } catch (error) { log('needhuman.retract-failed', { msgId: open.msgId, error: String(error).slice(0, 200) }); }
  };
  return {
    noteUnanswered(input) {
      if (opens.has(input.msgId)) return;
      const t = deps.now();
      const openedAt = typeof input.arrivedAt === 'number' && Number.isFinite(input.arrivedAt) && input.arrivedAt <= t ? input.arrivedAt : t;
      opens.set(input.msgId, { msgId: input.msgId, seat: input.seat, sender: input.sender,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}), ...(input.reason ? { reason: input.reason } : {}), openedAt, surfaced: false });
      log('needhuman.open', { msgId: input.msgId, seat: input.seat, sender: input.sender, waitedMs: t - openedAt });
    },
    tick() {
      if (opens.size === 0) return;
      const t = deps.now();
      for (const open of [...opens.values()]) {
        const waited = t - open.openedAt;
        const closed = closedSafe(open);
        if (closed === true) {
          opens.delete(open.msgId);
          retract(open);
          log('needhuman.replied', { msgId: open.msgId, seat: open.seat, sender: open.sender, waitedMs: waited });
          continue;
        }
        if (waited >= HAND_RAISE_FORGET_AFTER_MS) {
          opens.delete(open.msgId);
          retract(open);
          log('needhuman.expired', { msgId: open.msgId, seat: open.seat, sender: open.sender, waitedMs: waited });
        }
      }
      // Bulk first: ≥3 open of one shape → one item for the group, never one per hand.
      const byShape = new Map<string, HandRaiseOpen[]>();
      for (const open of opens.values()) {
        if (!open.reason) continue;
        byShape.set(open.reason, [...(byShape.get(open.reason) ?? []), open]);
      }
      for (const [reason, list] of byShape) {
        if (!bulkOn || list.length < HAND_RAISE_BULK_MIN) continue;
        for (const open of list) open.surfaced = true;
        if ((bulkSurfaced.get(reason) ?? 0) >= list.length) continue;
        bulkSurfaced.set(reason, list.length);
        log('needhuman.bulk', { seat: list[0]!.seat, reason, count: list.length, msgIds: list.map((o) => o.msgId) });
        surface(handRaiseBulkLine(reason, list), list);
      }
      for (const open of opens.values()) {
        if (open.surfaced || t - open.openedAt < surfaceAfterMs) continue;
        open.surfaced = true;
        log('needhuman.unanswered', { msgId: open.msgId, seat: open.seat, sender: open.sender, waitedMs: t - open.openedAt });
        const line = surfaceLine(open.sender, t - open.openedAt, open.msgId);
        open.surfacedLine = line;
        surface(line, [open]);
      }
    },
    open: () => [...opens.values()],
    dropAll() {
      const dropped = [...opens.values()];
      opens.clear();
      bulkSurfaced.clear();
      for (const open of dropped) retract(open);
      if (dropped.length > 0) log('needhuman.dropped-on-new', { msgIds: dropped.map((o) => o.msgId) });
      return dropped;
    },
  };
}
