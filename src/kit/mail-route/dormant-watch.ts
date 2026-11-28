// KIT mail-route · dormant watch (DORMANT-SEAT-ROUTE · 0.3.38 P0) — mail to a dormant seat (RES etc.) is rerouted at the
// sender entrance to its live reader (hand-routes.yaml `dormant.routes` · the guardian loop agent for RES). This watch
// closes the other half: a rerouted mail its reader has not answered after `dormant.unansweredMinutes` (10) becomes ONE
// OP card (`dormant.cardTo`) — never silence, never one card per mail.
//
// S: 05:43 4th recurrence — POOL-2 → RES #188995 ✋ ×14 (23:53 · 00:18 · 03:15 · 05:43). The reroute moved the mail; when
//    the reader did not answer, nobody noticed and the hand asked again.
// C: stateless over the mail ledger (any tick can run it · same answer) · idempotent (a row is carded once: ref
//    `dormant-unanswered:<id>` on the card) · one card per tick at most · nothing is moved or acked.
// A: answered = a reply in the row's thread · the reader mailed the sender after it · a terminal receipt (accepted/done) or
//    a `done` ack by the reader. A plain ack is reading, not answering.
//
// 세 얼굴: 관측 = debug `msg.dormant-watch` {carded, cardId} ⊕ the card's `dormant-unanswered:<id>` refs · 판단 근거 = the
// ledger rows above (structured · no body text) · 수복과 인계 = OP answers the card (or the reader answers late — the card
// stays as the record); a revived seat tab gets its mail directly again (live probe at the entrance).
import type { Message, MsgStore } from '../../msg/msg-store.js';
import { REROUTED_FROM_REF } from '../../msg/op-machine-digest.js';
import { buildFederationLadder, dedupeHands, forwardOnce, openHands } from '../../msg/hand-raise-ladder.js';
import { HAND_COORDINATOR, LOOP_HAND_ROUTED_FROM, readHandRoutes, type HandRoutesTable } from './hand-routes.js';

export const DORMANT_UNANSWERED_REF = 'dormant-unanswered:';
export const DORMANT_CARD_REF = 'dormant-card';

interface Row { readonly id: number; readonly sender: string; readonly recipient: string; readonly created_at: string; readonly body: string; readonly refs_json: string | null }

export interface DormantOverdue { readonly id: number; readonly from: string; readonly reader: string; readonly dormant: string; readonly waitedMin: number; readonly body: string }
export interface DormantWatchReport { readonly overdue: readonly DormantOverdue[]; readonly cardId: number | null; readonly line: string }

const like = (s: string): string => `%${s.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
const oneLine = (s: string, n: number): string => { const t = s.replace(/\s+/gu, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const table = (store: Pick<MsgStore, 'db'>, name: string): boolean => store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;

/** Did the reader answer rerouted row `r`? Structured ledger facts only. */
export function dormantAnswered(store: MsgStore, r: Pick<Row, 'id' | 'sender' | 'recipient'>): boolean {
  if (store.db.query('SELECT 1 FROM msg_messages WHERE reply_to = ? AND sender <> ? LIMIT 1').get(r.id, r.sender) !== null) return true;
  if (store.db.query('SELECT 1 FROM msg_messages WHERE id > ? AND sender = ? AND recipient = ? LIMIT 1').get(r.id, r.recipient, r.sender) !== null) return true;
  if (table(store, 'msg_receipts') && store.db.query(`SELECT 1 FROM msg_receipts WHERE message_id = ? AND recipient = ? AND state IN ('accepted', 'done') LIMIT 1`)
    .get(r.id, r.recipient) !== null) return true;
  try { return store.messageStatus(r.recipient, r.id) === 'done'; } catch { return false; }
}

/**
 * One tick. `live=false` computes the same overdue list without writing. `nowMs` is compared with the rows' wall-clock
 * `created_at`. Never throws on a read; a failed card write is reported in the line.
 */
export function sweepDormantUnanswered(store: MsgStore, deps: { readonly nowMs?: number; readonly live?: boolean; readonly table?: HandRoutesTable; readonly log?: (event: string, data: Record<string, unknown>) => void } = {}): DormantWatchReport {
  const t = (deps.table ?? readHandRoutes()).dormant;
  const now = deps.nowMs ?? Date.now();
  const since = new Date(now - t.sweepWindowMs).toISOString();
  const until = new Date(now - t.unansweredMs).toISOString();
  const rows = store.db.query(`SELECT id, sender, recipient, created_at, body, refs_json FROM msg_messages
    WHERE created_at >= ? AND created_at <= ? AND refs_json LIKE ? ESCAPE '\\' ORDER BY id ASC`).all(since, until, like(`"${REROUTED_FROM_REF}`)) as Row[];
  const carded = (id: number): boolean => store.db.query(`SELECT 1 FROM msg_messages WHERE recipient = ? AND refs_json LIKE ? ESCAPE '\\' LIMIT 1`)
    .get(t.cardTo, like(`"${DORMANT_UNANSWERED_REF}${id}"`)) !== null;
  const overdue: DormantOverdue[] = [];
  for (const r of rows) {
    const reader = r.recipient.trim().toUpperCase();
    // Mail rerouted to the card's own recipient (the OP digest) is already in front of it.
    if (reader === t.cardTo) continue;
    let refs: string[] = [];
    try { refs = JSON.parse(r.refs_json ?? '[]') as string[]; } catch { refs = []; }
    const dormant = refs.find((x) => typeof x === 'string' && x.startsWith(REROUTED_FROM_REF))?.slice(REROUTED_FROM_REF.length) ?? '?';
    if (dormantAnswered(store, r) || carded(r.id)) continue;
    overdue.push({ id: r.id, from: r.sender, reader, dormant, waitedMin: Math.floor((now - Date.parse(r.created_at)) / 60_000), body: r.body });
  }
  const minutes = Math.round(t.unansweredMs / 60_000);
  if (overdue.length === 0) return { overdue, cardId: null, line: `dormant watch: 0 unanswered ≥${minutes}m` };
  if (deps.live === false) return { overdue, cardId: null, line: `dormant watch (shadow): ${overdue.length} unanswered ≥${minutes}m` };
  const readers = [...new Set(overdue.map((o) => o.reader))];
  const body = `[잠든 자리 · ${minutes}분 무응답 → OP] ${overdue.length} mail rerouted from a dormant seat got no answer from ${readers.join('·')}: `
    + overdue.slice(0, 6).map((o) => `#${o.id} ${o.from}→${o.dormant}→${o.reader} ${o.waitedMin}m «${oneLine(o.body.replace(/^\[rerouted from [^\]]*\]\s*/u, ''), 90)}»`).join(' | ')
    + `${overdue.length > 6 ? ` | …+${overdue.length - 6}` : ''} · answer the sender (eln msg post --to <sender> --reply-to <id>) or fix ${readers.join('·')}'s wake.`;
  let card: Message | null = null;
  try {
    card = store.appendWithProvenance({
      from: readers.length === 1 ? readers[0]! : 'MAIL-ROUTE', to: t.cardTo, kind: 'request', intent: 'decision', priority: 1,
      refs: [DORMANT_CARD_REF, ...overdue.map((o) => `${DORMANT_UNANSWERED_REF}${o.id}`)], body,
    }, `dormant-unanswered-card:${overdue[0]!.id}:${overdue.length}`);
  } catch (error) {
    try { deps.log?.('msg.dormant-watch', { phase: 'card-failed', error: String(error).slice(0, 200), overdue: overdue.map((o) => o.id) }); } catch { /* fail-open */ }
    return { overdue, cardId: null, line: `dormant watch: ${overdue.length} unanswered ≥${minutes}m · card write failed` };
  }
  try { deps.log?.('msg.dormant-watch', { phase: 'carded', cardId: card.id, overdue: overdue.map((o) => o.id), readers }); } catch { /* fail-open */ }
  return { overdue, cardId: card.id, line: `dormant watch: ${overdue.length} unanswered ≥${minutes}m → ${t.cardTo} card #${card.id}` };
}

// ── GUARDIAN-HAND-SLA (0.3.38 P0) — ✋ at a loop-agent address never stays open ─────────────────────────────────────────
//
// S: 11-27/28 ✋ moved to GUARDIAN by the domain table (e.g. #198743 TC-H-POOL-3 · DEPENDENCY_WAIT «수집기 시간 초과 · rc·영수
//    없음 · TC 에 복구 담당선 요청») sat 25–53 min: the guardian's voice skips ✋, and its ladder parent is HQ, whose timer
//    never mails OP — only the capped beacon (3 cards / 10 min) reached it.
// C: stateless over the ledger · exactly once per ✋ (the ladder's own `hand-escalate:<id>` provenance) · one forward per
//    cause (dedupeHands) · the table decides, not TypeScript (hand-routes.yaml `loopHands`).
// A: an open ✋ at a `loopHands.receivers` address older than `slaMinutes` is forwarded to its reason's taker —
//    `coordinator` = the blocked hand's own coordinator (federation ladder parent · falls back to `routed-from`) ·
//    `routed-from` = the rung the table moved it from (its leader · TC for dependency/design waits) · an address = there ·
//    the HQ seat = left to the HQ beacon card on the same tick (counted, not written here). The forward is itself a ✋, so
//    the taker's 10-min ladder applies from there.
//    HAND-ROUTE-GUARDIAN-MISROUTE (11-28): the steward graph was this sweep's only carrier and died at R1 for 14 ticks —
//    every eln TUI's minute ✋ tick now runs it too (`involving` = that seat: the ✋ it sent, holds or would take).
//
// 세 얼굴: 관측 = debug `msg.loop-hand-sla` {msgId, from, to, waitedMin, mailId} ⊕ the forward's `hand-escalated-from:` /
// `hand-loop-sla` refs · 판단 근거 = openHands (no outcome / reply / escalation) ⊕ hand-routes.yaml loopHands · 수복과 인계 =
// the taker answers or climbs; the loop agent may still answer late (its reply closes nothing twice).

export const LOOP_HAND_SLA_REF = 'hand-loop-sla';

export interface LoopHandMove { readonly msgId: number; readonly seat: string; readonly reason: string; readonly from: string; readonly to: string; readonly waitedMin: number; readonly mailId: number | null; readonly members: number }
export interface LoopHandReport { readonly moved: readonly LoopHandMove[]; readonly toBeacon: readonly LoopHandMove[]; readonly line: string }

const refOf = (refs: readonly string[] | undefined, prefix: string): string | undefined => refs?.find((r) => r.startsWith(prefix))?.slice(prefix.length);

/** One tick. `live=false` computes the same moves without writing. `hq` = the HQ seat (its ✋ go through the beacon card). */
export interface LoopHandSlaDeps {
  readonly nowMs?: number;
  readonly live?: boolean;
  readonly hq?: string;
  readonly table?: HandRoutesTable;
  /** The federation ladder parent of a seat (the `coordinator` taker). Absent → `coordinator` reads as `routed-from`. */
  readonly parentOf?: ((seat: string) => string) | null;
  /** Only the ✋ this seat sent, holds or would take (a TUI's own tick). Absent = every ✋. */
  readonly involving?: string;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

/** The taker of one ✋ (upper-case address · the HQ seat = the beacon card). Pure over its inputs. */
export function loopHandTaker(hand: { readonly reason: string; readonly refs?: readonly string[]; readonly receiver: string; readonly blockedSeat: string },
  t: HandRoutesTable['loopHands'], hq: string, parentOf?: ((seat: string) => string) | null): string {
  const receiver = hand.receiver.trim().toUpperCase();
  const seat = hand.blockedSeat.trim().toUpperCase();
  const word = t.byReason[hand.reason.trim().toUpperCase()] ?? t.otherwise;
  const fallback = t.otherwise !== HAND_COORDINATOR && t.otherwise !== LOOP_HAND_ROUTED_FROM ? t.otherwise : undefined;
  const routedFrom = (): string | undefined => refOf(hand.refs, 'hand-routed-from:') ?? fallback;
  let named: string | undefined;
  if (word === HAND_COORDINATOR) {
    let parent = '';
    try { parent = (parentOf?.(seat) ?? '').trim().toUpperCase(); } catch { parent = ''; }
    named = parent && parent !== seat && parent !== receiver ? parent : routedFrom();
  } else named = word === LOOP_HAND_ROUTED_FROM ? routedFrom() : word;
  const to = (named ?? hq).trim().toUpperCase();
  return !to || to === LOOP_HAND_ROUTED_FROM.toUpperCase() || to === HAND_COORDINATOR.toUpperCase() || to === receiver || to === seat ? hq : to;
}

export function sweepLoopHandSla(store: MsgStore, deps: LoopHandSlaDeps = {}): LoopHandReport {
  const t = (deps.table ?? readHandRoutes()).loopHands;
  const now = deps.nowMs ?? Date.now();
  const hq = (deps.hq ?? 'OP').trim().toUpperCase();
  const slaMin = Math.round(t.slaMs / 60_000);
  if (t.receivers.size === 0) return { moved: [], toBeacon: [], line: 'loop ✋ SLA: no receivers' };
  const who = deps.involving?.trim().toUpperCase() || null;
  const opens = openHands(store, { now }).filter((h) => t.receivers.has(h.receiver.trim().toUpperCase()))
    .filter((h) => !who || h.sender.trim().toUpperCase() === who || h.receiver.trim().toUpperCase() === who || h.blockedSeat.trim().toUpperCase() === who
      || loopHandTaker(h, t, hq, deps.parentOf) === who);
  const moved: LoopHandMove[] = [];
  const toBeacon: LoopHandMove[] = [];
  // a minimal ladder: forwardOnce reads it only on the CEO rung, which this sweep never targets
  const ladderDeps = { ladder: buildFederationLadder({ hq, spaces: [] }), now: () => now, raiseDecision: () => {} };
  for (const group of dedupeHands(opens)) {
    const hand = group.lead;
    if (hand.waitedMs < t.slaMs) continue;
    const receiver = hand.receiver.trim().toUpperCase();
    const to = loopHandTaker(hand, t, hq, deps.parentOf);
    const waitedMin = Math.floor(hand.waitedMs / 60_000);
    const move = { msgId: hand.id, seat: hand.blockedSeat, reason: hand.reason, from: receiver, to, waitedMin, mailId: null, members: group.members.length };
    if (to === hq) { toBeacon.push(move); continue; }
    if (deps.live === false) { moved.push(move); continue; }
    try {
      const forward = forwardOnce(store, hand, to, `${receiver} has no ✋ responder — no outcome in ${waitedMin}m (SLA ${slaMin}m · hand-routes.yaml loopHands · ${hand.reason} → ${to})`,
        true, hand.waitedMs, ladderDeps, group.members, [LOOP_HAND_SLA_REF]);
      if (!forward.fresh) continue;
      moved.push({ ...move, mailId: forward.mail.id });
      try { deps.log?.('msg.loop-hand-sla', { msgId: hand.id, from: receiver, to, waitedMin, mailId: forward.mail.id, members: group.members.length }); } catch { /* fail-open */ }
    } catch (error) {
      try { deps.log?.('msg.loop-hand-sla', { phase: 'forward-failed', msgId: hand.id, to, error: String(error).slice(0, 200) }); } catch { /* fail-open */ }
    }
  }
  const parts = [...moved.map((m) => `#${m.msgId} ${m.seat} ${m.reason} ${m.from}→${m.to}${m.mailId ? ` #${m.mailId}` : ''} ${m.waitedMin}m`),
    ...toBeacon.map((m) => `#${m.msgId} ${m.seat} ${m.reason} ${m.from}→${hq} card ${m.waitedMin}m`)];
  return { moved, toBeacon, line: parts.length ? `loop ✋ SLA ${slaMin}m${deps.live === false ? ' (shadow)' : ''}: ${parts.join(' | ')}` : `loop ✋ SLA: 0 open ≥${slaMin}m` };
}
