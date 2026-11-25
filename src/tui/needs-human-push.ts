// NEED-HUMAN-PUSH (11-24): when the TUI publishes the needs-person block it also pushes ONE structured mail up the
// escalation ladder  seat → its space coordinator → OP → CEO (decision card). Push, not polling.
//   • one mail per blockId (the same block re-rendered never re-posts)
//   • no reply in ESCALATE_AFTER_MS and still blocked → ONE forward to the next rung («escalated from <rung> after 5m»)
//   • a reply (replyTo = one of this block's mail ids — a structured field, never text matching) from ANY rung resumes the seat
//   • the rung already handled it (11-25 06:18 UX→OP: OP answered in 19 s, the CEO still got the card at 06:25) → no next rung.
//     Checked at the 5-min check only (never an always-on poll), against the shared mail ledger: the rung's turn took the mail in
//     (seen/done receipt) · the rung mailed the blocked seat after routing · the mail row was acked. The ✋ stays until the seat resumes.
//   • a seat with no coordinator, or that IS the coordinator, skips straight to the next rung; OP itself goes to the CEO card
// Machine fields ride in `refs` (block:/seat:/pane:/reason:) and `correlationId` = blockId; priority comes from intent=decision (P1).
import type { BlockReason, HandCause } from '../agent-events/protocol.js';
import type { MessageEnvelope } from '../msg/msg-store.js';

export const ESCALATE_AFTER_MS = 5 * 60_000;

export interface NeedsHumanDeps {
  /** This seat's name; null = not a seat TUI (nothing is pushed). */
  readonly seat: () => string | null;
  readonly paneId: () => string;
  /** The seat's space coordinator (els workspace coordinator), or null/undefined when it has none. */
  readonly coordinatorOf: () => string | null | undefined;
  /** BEACON-LADDER — the ✋'s urgency field (normal | urgent | security | crown-conflict); absent = normal (no ref). */
  readonly urgencyOf?: (reason: string, detail: string) => 'normal' | 'urgent' | 'security' | 'crown-conflict';
  /** Posts one mail; returns its ledger id. */
  readonly postMail: (envelope: MessageEnvelope) => number | undefined;
  /** The CEO rung: an existing `decisions raise` card. */
  readonly raiseDecision: (card: { title: string; seat: string; reason: BlockReason; blockId: string; summary: string }) => void;
  /** A rung replied: resume the seat with the reply text as its input. */
  readonly resumeWith: (text: string) => void;
  /** Did `rung` handle mail #msgId (sent by `seat`) since it was routed? null = not yet (the ladder escalates as before). */
  readonly handledBy?: (input: { msgId: number; rung: string; seat: string }) => NeedsHumanHandledBy | null;
  /** Ack mail #msgId for `rung` once handled (its ✉ count drops); a no-op when already acked. */
  readonly ackFor?: (rung: string, msgId: number) => void;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly newBlockId?: () => string;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export type NeedsHumanHandledBy = 'turn-ack' | 'reply' | 'ack';

export interface NeedsHumanArrival { readonly msgId?: number; readonly replyTo?: number; readonly text: string }

export interface NeedsHumanPush {
  /** The TUI published the needs-person block. */
  /** `cause` (WRITER-CHECK-RESOLVER) rides as ref `cause:<c>` — the steward answers that family itself. */
  blocked(reason: BlockReason, detail: string, cause?: HandCause): void;
  /** The block is over (a person typed, or a turn was opened by a person). */
  resumed(): void;
  /** Mail arrivals of this seat: a structured reply to this block's mail resumes the seat. Returns true when it did. */
  noteArrivals(arrivals: readonly NeedsHumanArrival[] | undefined): boolean;
  activeBlockId(): string | null;
}

export function createNeedsHumanPush(deps: NeedsHumanDeps): NeedsHumanPush {
  let counter = 0;
  const newId = deps.newBlockId ?? (() => `blk-${Date.now().toString(36)}-${++counter}`);
  let active: { blockId: string; reason: BlockReason; detail: string; cause?: HandCause; mailIds: Set<number>; rung: string; lastMailId: number | null; timer: unknown } | null = null;
  const log = (event: string, data: Record<string, unknown>): void => { try { deps.log?.(event, data); } catch { /* observation never breaks the turn */ } };

  const send = (seat: string, to: string, from: string | null, note?: string): boolean => {
    const block = active!;
    const line = block.detail || block.reason;
    const body = `[✋ NEED HUMAN · ${seat}] ${line} · 원하는 것: 이 막힘을 풀 결정·입력 (답장하면 그대로 재개) · 선택지: 재개/중단/다른 방법${note ? ` · ${note}` : ''}`;
    let id: number | undefined;
    let failure = 'postMail threw';
    try {
      id = deps.postMail({ from: seat, to, kind: 'request', intent: 'decision', body, correlationId: block.blockId,
        refs: [`block:${block.blockId}`, `seat:${seat}`, `pane:${deps.paneId()}`, `reason:${block.reason}`, ...(block.cause ? [`cause:${block.cause}`] : []), ...urgencyRef(block)] });
      if (!Number.isSafeInteger(id) || id! <= 0) { failure = 'postMail returned no valid message id'; throw new Error(failure); }
    } catch {
      log('seat.needs-human', { phase: 'route-failed', error: failure, rung: to, seat, blockId: block.blockId });
      return false;
    }
    block.mailIds.add(id!);
    block.rung = to;
    block.lastMailId = id!;
    log('seat.needs-human', { phase: from === null ? 'routed' : 'escalated', rung: to, ...(from === null ? {} : { from, to, ...(note?.includes('after 5m') ? { afterMs: ESCALATE_AFTER_MS } : {}) }), msgId: id, seat, blockId: block.blockId });
    return true;
  };
  const urgencyRef = (block: { reason: string; detail: string }): string[] => {
    let u: string = 'normal';
    try { u = deps.urgencyOf?.(block.reason, block.detail) ?? 'normal'; } catch { /* normal */ }
    return u === 'normal' ? [] : [`urgency:${u}`];
  };
  const toCeo = (seat: string): void => {
    const block = active!;
    block.rung = 'CEO';
    log('seat.needs-human', { phase: 'routed', rung: 'CEO', seat, blockId: block.blockId });
    try {
      deps.raiseDecision({ title: `[✋ NEED HUMAN · ${seat}] ${block.detail || block.reason}`, seat, reason: block.reason, blockId: block.blockId,
        summary: `${seat} is blocked and needs a person (${block.reason}). Choices: resume / stop / another way.` });
    } catch (error) { log('seat.needs-human', { phase: 'decision-raise-failed', error: String(error).slice(0, 160), seat }); }
  };
  // The rung's own mail was handled (its process acked / its turn took it in / it mailed the seat) → stop the ladder here.
  const handled = (seat: string): boolean => {
    const block = active!;
    const msgId = block.lastMailId;
    if (msgId === null || !deps.handledBy) return false;
    let by: NeedsHumanHandledBy | null = null;
    try { by = deps.handledBy({ msgId, rung: block.rung, seat }); }
    catch (error) { log('seat.needs-human', { phase: 'handled-check-failed', error: String(error).slice(0, 160), rung: block.rung, msgId, seat }); return false; }
    if (!by) return false;
    log('seat.needs-human', { phase: 'handled', rung: block.rung, by, msgId, seat, blockId: block.blockId });
    try { deps.ackFor?.(block.rung, msgId); }
    catch (error) { log('seat.needs-human', { phase: 'handled-ack-failed', error: String(error).slice(0, 160), rung: block.rung, msgId, seat }); }
    return true;
  };
  const arm = (seat: string): void => {
    const block = active!;
    block.timer = deps.setTimer(() => {
      if (active !== block) return;
      if (handled(seat)) return;
      const from = block.rung;
      if (from === 'OP' || seat === 'OP') {
        // The last mail rung went unanswered: a direction call (HUMAN_DECISION) reaches the CEO as a decision card.
        if (block.reason === 'HUMAN_DECISION' && from !== 'CEO') toCeo(seat);
        return;
      }
      // BEACON-LADDER (대표 11-25 21:1x «ONE path»): a hand never mails OP itself. The ✋ stays at its leader; the OP-scope
      // steward watcher (beaconHands) climbs for it on its own thresholds.
      log('seat.needs-human', { phase: 'held-at-leader', rung: from, seat, blockId: block.blockId });
    }, ESCALATE_AFTER_MS);
  };

  return {
    blocked(reason, detail, cause) {
      const seat = deps.seat();
      if (!seat) return;
      // The same block persisting (same code and same reason text, e.g. a mail-wake turn that ends still blocked): one mail per blockId.
      // A different reason text is a new block — it goes to the first rung again (05:57 TC-H-CX-1: a second block was swallowed
      // because only the code was compared while the first block, already escalated to OP, was never cleared).
      if (active && active.reason === reason && active.detail === detail) return;
      if (active) { deps.clearTimer(active.timer); active = null; }
      active = { blockId: newId(), reason, detail, ...(cause ? { cause } : {}), mailIds: new Set(), rung: '', lastMailId: null, timer: null };
      const coordinator = deps.coordinatorOf();
      const first = coordinator && coordinator !== seat ? coordinator : seat === 'OP' ? 'CEO' : 'OP';
      if (first === 'CEO') { toCeo(seat); return; }
      if (send(seat, first, null)) { arm(seat); return; }
      // Delivery to the leader failed (no ledger row for the watcher to see): the CEO card is the only rung left.
      toCeo(seat);
    },
    resumed() {
      if (!active) return;
      deps.clearTimer(active.timer);
      active = null;
    },
    noteArrivals(arrivals) {
      const block = active;
      if (!block || !arrivals) return false;
      const hit = arrivals.find((a) => a.replyTo !== undefined && block.mailIds.has(a.replyTo));
      if (!hit) return false;
      deps.clearTimer(block.timer);
      active = null;
      log('seat.needs-human', { phase: 'resumed-by-reply', rung: block.rung, blockId: block.blockId, replyTo: hit.replyTo });
      deps.resumeWith(hit.text);
      return true;
    },
    activeBlockId: () => active?.blockId ?? null,
  };
}
