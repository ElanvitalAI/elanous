// FEDERATION MAIL WATCH (CEO 11-26 23:xx «watch federation/mail/TC closely») — three deterministic reads/steps, LLM 0,
// run by the org steward (board-steward graph, every 10 min) and read by the OP planner.
//
// S: build 2307 · 11-26: TC inbox 52 unacked; all 18 hands idle. Hands' ✋ NEED HUMAN to TC (TC-H-POOL-1 #179849 #179852 ·
//    TC-H-CX-2 #179859 #179867 #179877 · MOB-1 #179851 #179857 #179865, from 01:14Z) sat 13 h unanswered after TC's
//    blanket ban (#178978 «시험·원격·운영·자격 접근 금지»). The rule ✋ hand → coordinator 10 min → OP 10 min → CEO never
//    fired: the ladder sweep runs only inside TUIs (TC is not an eln TUI), looks back 2 h, and never mails OP itself.
// A: ① escalationStep() — every open ✋ (24 h lookback): at a coordinator > 10 min → ONE re-post to OP (intent alert =
//      P0 at OP, ref `coordinator-silent`, the original quoted); at OP > 10 min → ONE CEO decision card (the existing
//      CEO rung: copy to CLAUDE-OP + `decisions raise`). Idempotent per ✋ id and hop (provenance `hand-escalate:<id>`,
//      the same key the TUI sweep uses — never two escalations of one hop).
//    ② broadcastHolds() — a coordinator mail to ≥ 2 hands (one ALL/group mail, or the same body to ≥ 2 hands in 10 min)
//      that names no cells (`cells:` ref) and no expiry (`until:` ref) is an unscoped hold; the hands that raised ✋ to
//      that coordinator after it are «frozen by it». The planner puts «N hands frozen by <coordinator> hold #id for Xh»
//      in front of OP (decide: narrow to cells ⊕ expiry, or lift).
//    ③ unackedBySeat() — unacked mail per seat with the oldest age («TC 52 unacked · oldest 13h»).
//
// 세 얼굴: 관측 = the escalation mails / cards (provenance keys) ⊕ the board digest row (unacked · holds) ⊕ the OP plan
// block · 판단 근거 = ✋ age at its receiver ⊕ the broadcast's refs ⊕ the msg store counts · 수복과 인계 = the hop's
// escalation goes to the next rung; an unscoped hold becomes OP's decision.
import type { MsgStore } from './msg-store.js';
import { appendOnce, dedupeHands, HAND_AUTO_ESCALATE_AFTER_MS, HAND_CEO, HAND_CEO_COPY_TO, handClosedOn, openHands, readHandMail, readHandMailsSince,
  type CeoCard, type FederationLadder } from './hand-raise-ladder.js';

// 출처: CEO 11-26 23:xx — ✋ unanswered 13 h; the 2 h sweep window hid them. One day covers any overnight silence.
export const ESCALATION_LOOKBACK_MS = 24 * 60 * 60_000;

const canon = (s: string) => s.trim().toUpperCase();
const oneLine = (text: string, max = 240) => { const t = text.replace(/\s+/gu, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const mins = (ms: number) => Math.max(0, Math.floor(ms / 60_000));

export interface EscalationDeps {
  readonly ladder: FederationLadder;
  readonly now: () => number;
  readonly raiseDecision: (card: CeoCard) => void;
  /** false = report what would be escalated, write nothing (shadow). */
  readonly live: boolean;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export interface EscalationRow { readonly msgId: number; readonly from: string; readonly to: string; readonly hop: 'coordinator→OP' | 'OP→CEO'; readonly waitedMin: number; readonly members: number; readonly mailId: number | null; readonly fresh: boolean }

/** ① One pass: escalate every open ✋ one rung past a silent coordinator / a silent OP. */
export function escalationStep(store: MsgStore, deps: EscalationDeps): EscalationRow[] {
  const now = deps.now();
  const hq = canon(deps.ladder.hq);
  const groups = dedupeHands(openHands(store, { now, ladder: deps.ladder, windowMs: ESCALATION_LOOKBACK_MS }));
  const out: EscalationRow[] = [];
  for (const g of groups) {
    const hand = g.lead;
    if (hand.waitedMs < HAND_AUTO_ESCALATE_AFTER_MS) continue;
    const receiver = canon(hand.receiver);
    const members = g.members.filter(m => m.id !== hand.id).map(m => `hand-escalated-from:${m.id}`);
    const root = readHandMail(store, hand.rootId) ?? hand;
    if (receiver === hq) {
      // OP silent > 10 min → the CEO lane: a copy mail to the CEO's proxy (CLAUDE-OP) and ONE decision card.
      const key = `hand-escalate:${hand.id}`;
      if (!deps.live) { if (!store.findByProvenanceKey(key)) out.push({ msgId: hand.id, from: receiver, to: HAND_CEO, hop: 'OP→CEO', waitedMin: mins(hand.waitedMs), members: g.members.length, mailId: null, fresh: true }); continue; }
      const w = appendOnce(store, key, () => ({ from: hand.receiver, to: HAND_CEO_COPY_TO, kind: 'request', intent: 'alert',
        refs: [`needhuman:${hand.id}`, `hand-of:${root.id}`, `hand-escalated-from:${hand.id}`, ...members, 'hand-ceo', 'op-silent', `block:${hand.blockId}`, `seat:${root.sender}`],
        body: `[✋ → CEO decision card · OP silent ${mins(hand.waitedMs)}m · ✋ #${hand.id}] ${root.sender}'s ✋ #${root.id} has no outcome at OP · ${oneLine(root.body)}` }));
      if (w.fresh) {
        try {
          deps.raiseDecision({ title: `[✋ NEED HUMAN · ${root.sender}] ${oneLine(root.body, 120)}`, seat: root.sender, reason: hand.reason, blockId: hand.blockId, msgId: hand.id,
            summary: `${root.sender} is blocked; ${hand.sender === root.sender ? '' : `${hand.sender} was silent, then `}OP gave no outcome in ${mins(hand.waitedMs)}m. Choices: resume / stop / another way.` });
        } catch (error) { deps.log?.('fedwatch.ceo-card-failed', { msgId: hand.id, error: String(error).slice(0, 200) }); }
        deps.log?.('fedwatch.escalated', { msgId: hand.id, hop: 'OP→CEO', waitedMin: mins(hand.waitedMs), mailId: w.mail.id });
      }
      out.push({ msgId: hand.id, from: receiver, to: HAND_CEO, hop: 'OP→CEO', waitedMin: mins(hand.waitedMs), members: g.members.length, mailId: w.mail.id, fresh: w.fresh });
      continue;
    }
    // A coordinator (depth 2) whose parent is HQ, silent > 10 min → ONE re-post to OP (P0 · `coordinator-silent`).
    if (deps.ladder.depthOf(receiver) !== 2 || canon(deps.ladder.parentOf(receiver)) !== hq) continue;
    const key = `hand-escalate:${hand.id}`;
    if (!deps.live) { if (!store.findByProvenanceKey(key)) out.push({ msgId: hand.id, from: receiver, to: hq, hop: 'coordinator→OP', waitedMin: mins(hand.waitedMs), members: g.members.length, mailId: null, fresh: true }); continue; }
    const w = appendOnce(store, key, () => ({ from: hand.receiver, to: hq, kind: 'request', intent: 'alert',
      ...(hand.correlationId ? { correlationId: hand.correlationId } : {}),
      refs: [`block:${hand.blockId}`, `seat:${root.sender}`, `reason:${hand.reason}`, `hand-of:${root.id}`, `hand-escalated-from:${hand.id}`, ...members, 'hand-escalation:auto', 'coordinator-silent'],
      body: `[✋ ESCALATED · ${hand.receiver} → ${hq} · coordinator silent · ✋ #${hand.id} · no outcome in ${mins(hand.waitedMs)}m${g.members.length > 1 ? ` · ×${g.members.length} same cause` : ''}] from ${root.sender} #${root.id}: ${oneLine(root.body)} · `
        + 'Close it with one outcome: HandRaise(action=resolve|reject|escalate, msgId=<this mail>) or eln msg hand <this mail> resolve|reject|escalate "<text>"' }));
    if (w.fresh) deps.log?.('fedwatch.escalated', { msgId: hand.id, hop: 'coordinator→OP', from: receiver, waitedMin: mins(hand.waitedMs), mailId: w.mail.id, members: g.members.length });
    out.push({ msgId: hand.id, from: receiver, to: hq, hop: 'coordinator→OP', waitedMin: mins(hand.waitedMs), members: g.members.length, mailId: w.mail.id, fresh: w.fresh });
  }
  return out;
}

export interface UnackedSeat { readonly seat: string; readonly count: number; readonly oldestMin: number }

/** ③ Unacked mail per seat with the oldest age (read-only), most first. */
export function unackedBySeat(store: MsgStore, nowMs: number): UnackedSeat[] {
  const by = new Map<string, { count: number; minId: number }>();
  for (const r of store.listUnreadRows()) {
    const s = canon(r.recipient); const cur = by.get(s);
    by.set(s, cur ? { count: cur.count + 1, minId: Math.min(cur.minId, r.id) } : { count: 1, minId: r.id });
  }
  return [...by].map(([seat, v]) => {
    const at = Date.parse(store.getMessage(v.minId)?.createdAt ?? '');
    return { seat, count: v.count, oldestMin: Number.isFinite(at) ? mins(nowMs - at) : 0 };
  }).sort((a, b) => b.count - a.count || a.seat.localeCompare(b.seat));
}

export function unackedLine(rows: readonly UnackedSeat[], top = 5): string {
  const age = (m: number) => (m >= 120 ? `${Math.floor(m / 60)}h` : `${m}m`);
  return rows.length ? rows.slice(0, top).map(r => `${r.seat} ${r.count} unacked · oldest ${age(r.oldestMin)}`).join(' | ') : 'no unacked mail';
}

export interface BroadcastHold { readonly coordinator: string; readonly msgId: number; readonly at: string; readonly hands: readonly string[]; readonly frozen: readonly string[]; readonly scoped: boolean; readonly body: string }

// 출처: one coordinator «round» — the same body to several hands is typed in a few minutes; 10 min keeps one round.
export const BROADCAST_WINDOW_MS = 10 * 60_000;

/**
 * ② Coordinator broadcasts in the lookback (one mail to ALL/group:*, or the same body to ≥ 2 hands within 10 min) and the
 * hands frozen behind each (they raised a ✋ to that coordinator after it, still open). `scoped` = the broadcast names
 * cells (`cells:` ref) and an expiry (`until:` ref). Structure only — the body text is never parsed for words.
 */
export function broadcastHolds(store: MsgStore, input: { ladder: FederationLadder; nowMs: number; lookbackMs?: number }): BroadcastHold[] {
  const since = new Date(input.nowMs - (input.lookbackMs ?? ESCALATION_LOOKBACK_MS)).toISOString();
  const mails = store.listCreatedBetween(since, new Date(input.nowMs + 1000).toISOString());
  const isCoord = (s: string) => input.ladder.depthOf(s) === 2;
  const isHand = (s: string) => input.ladder.depthOf(s) === 3;
  const rounds = new Map<string, { coordinator: string; msgId: number; at: string; hands: Set<string>; refs: readonly string[]; body: string }>();
  for (const m of mails) {
    const from = canon(m.from); const to = canon(m.to);
    if (!isCoord(from)) continue;
    const broad = to === 'ALL' || to.startsWith('GROUP:');
    if (!broad && !isHand(to)) continue;
    const bucket = Math.floor(Date.parse(m.createdAt) / BROADCAST_WINDOW_MS);
    const key = broad ? `id:${m.id}` : `${from}|${bucket}|${m.body}`;
    const r = rounds.get(key) ?? { coordinator: from, msgId: m.id, at: m.createdAt, hands: new Set<string>(), refs: m.refs ?? [], body: m.body };
    if (broad) r.hands.add(to); else r.hands.add(to);
    rounds.set(key, r);
  }
  // Frozen = a ✋ to that coordinator after the broadcast that got no answer (open, or only escalated past it).
  const raised = readHandMailsSince(store, input.nowMs - (input.lookbackMs ?? ESCALATION_LOOKBACK_MS)).filter(h => {
    const closed = handClosedOn(store, h, input.ladder); return closed === null || closed === 'escalated';
  });
  const out: BroadcastHold[] = [];
  for (const r of rounds.values()) {
    const broad = [...r.hands].some(h => h === 'ALL' || h.startsWith('GROUP:'));
    if (!broad && r.hands.size < 2) continue;
    const after = Date.parse(r.at);
    const frozen = [...new Set(raised.filter(h => canon(h.receiver) === r.coordinator && h.createdAtMs >= after && (broad || r.hands.has(canon(h.blockedSeat)))).map(h => canon(h.blockedSeat)))].sort();
    const scoped = r.refs.some(x => x.startsWith('cells:')) && r.refs.some(x => x.startsWith('until:'));
    out.push({ coordinator: r.coordinator, msgId: r.msgId, at: r.at, hands: [...r.hands].sort(), frozen, scoped, body: oneLine(r.body, 120) });
  }
  return out.filter(h => h.frozen.length > 0).sort((a, b) => b.frozen.length - a.frozen.length || a.msgId - b.msgId);
}
