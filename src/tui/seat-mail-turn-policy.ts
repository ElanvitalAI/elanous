/**
 * SEAT-MAIL-PASSIVE-DEFAULT (SIM-STEWARD-AB-1125 FU 1·3·5·4b) — which seat mail opens a turn, and which waits for the digest.
 *
 * S: on 11-25 77% of OP's mail (796/1068) carried no kind or kind=notice. Both fell through to «action» and opened a
 *    turn each; the sim measured 93% of OP's turns opened by mail and 6% escalation precision.
 * C: a turn is the seat's scarcest resource; most mail is a status line, a reply, an announce or a request the seat can
 *    batch. A mail that someone actually waits on must still open a turn at once.
 * Q: how do we decide «turn now» vs «ride the digest» without reading the prose and without an LLM?
 * A: the default flips to passive. Only these open a turn immediately — everything else rides the 10-min digest:
 *      crown   — a crown directive / crown delegation
 *      human   — a person's own mail (origin kind human)
 *      hand    — a ✋ HandRaise (`block:` ⊕ `reason:` refs), escalated ones included
 *      question— an explicit question/decision (question · ask · decision kind, intent decision) or the needs-reply flag
 *      alert   — a P0 alert (intent alert · alert/urgent/interrupt kind · ledger priority ≥ 1 · an urgent mark) — a
 *                wait-cancel notice is not one
 *      failed  — a result envelope that failed
 *      order   — any mail from a seat ABOVE the recipient on the federation ladder (a work order, or the answer the seat
 *                waits on, flows down and starts — kind-less included); a request from a peer or a subordinate is routine and waits for the digest (the coordinator/steward
 *                resolves it by policy) unless it names an HQ-level reason ref (`reason:BUDGET|SECURITY|CROSS_SCOPE|…`).
 *                Ladder unknown → a request still opens a turn (fail-safe: an order is never silenced).
 *      delegated-result — SEAT-TURN-FOLLOWUPS ②: mail from below that replies to a mail this seat sent, or carries a
 *                result/pr:/receipt: ref for a cell this seat owns or assigned (class P1 → batched by the 60 s join).
 *    Signals are structured ledger fields only: kind · intent · crownDirective · origin · refs · result · needsAck ·
 *    the sender's ladder position (computed by the caller). The body is never parsed (the urgent mark is the existing
 *    leading-glyph convention of isUrgentSeatMail, not prose).
 *
 * 세 얼굴: 관측 = the route ⊕ reason ride the notice (`passive`) and the triage log (`mail.triage {route, reason}`) ·
 *          인지 = this table · 수복과 인계 = passive mail is never dropped — the digest lists it, the ack follows the digest.
 */
import { isUrgentSeatMail } from './seat-mail-priority.js';

export type SeatMailRoute = 'turn' | 'passive';
export type SeatMailRouteReason =
  | 'crown' | 'human' | 'hand' | 'question' | 'needs-reply' | 'alert' | 'failed-result' | 'order' | 'hq-reason' | 'order-unknown-ladder'
  | 'delegated-result' | 'wait-cancel' | 'routine-request' | 'reply' | 'info' | 'no-kind';

export interface SeatMailRouteInput {
  readonly kind?: string | null;
  readonly intent?: string | null;
  readonly crownDirective?: string | null;
  readonly origin?: { readonly kind?: string; readonly delegatedByCrown?: boolean } | null;
  readonly fromKind?: string | null;
  readonly refs?: readonly string[] | null;
  readonly replyTo?: number | null;
  readonly resultState?: 'done' | 'failed' | null;
  readonly needsAck?: boolean | null;
  /** Ledger priority (urgent 2 · p0 1 · normal 0): ≥ 1 is a P0 mark. */
  readonly priority?: number | null;
  readonly doneWhen?: string | null;
  readonly deadlineAt?: string | null;
  /** The sender sits above the recipient on the federation ladder (true) · at or below it (false) · ladder unknown (undefined). */
  readonly senderAbove?: boolean | null;
  /** Read only for the leading urgent glyph (isUrgentSeatMail) — never parsed otherwise. */
  readonly body?: string;
  /** SEAT-TURN-FOLLOWUPS ② — `replyTo` points at a mail this seat sent (computed by the caller from the ledger). */
  readonly replyToOwn?: boolean | null;
  /** SEAT-TURN-FOLLOWUPS ② — a `cell:` ref of this mail names a cell this seat owns or assigned (caller-computed). */
  readonly cellDelegated?: boolean | null;
}

/** Ref prefixes that carry a delegated result (with a `cell:` ref the recipient owns or assigned). */
export const SEAT_MAIL_RESULT_REF_PREFIXES: readonly string[] = ['result:', 'pr:', 'receipt:'];

/**
 * SEAT-TURN-FOLLOWUPS ② — a delegated result wakes the delegator: mail from at/below this seat that answers a mail this
 * seat sent, or that carries a result (`result:` · `pr:` · `receipt:` ref or a done result envelope) for a cell this seat
 * owns or assigned. Structured fields only. Back-pressure: the producer gives it class P1, so several results inside
 * the 60 s join window ride one turn while work is open (queue-finish-first.ts QUEUE_P1_JOIN_AFTER_MS).
 */
export function isDelegatedResultMail(input: Pick<SeatMailRouteInput, 'senderAbove' | 'replyTo' | 'replyToOwn' | 'cellDelegated' | 'refs' | 'resultState'>): boolean {
  if (input.senderAbove === true) return false;
  if (input.replyToOwn === true && typeof input.replyTo === 'number' && input.replyTo > 0) return true;
  if (input.cellDelegated !== true || !hasRef(input.refs, 'cell:')) return false;
  return input.resultState === 'done' || SEAT_MAIL_RESULT_REF_PREFIXES.some((prefix) => hasRef(input.refs, prefix));
}

/** Kinds that ask a question someone waits on. */
export const SEAT_MAIL_QUESTION_KINDS: readonly string[] = ['question', 'ask', 'decision'];
/** Kinds that are a P0 alert by themselves. */
export const SEAT_MAIL_ALERT_KINDS: readonly string[] = ['alert', 'urgent', 'interrupt'];
/** Kinds that ask for work (a request — a turn only when it flows down the ladder). */
export const SEAT_MAIL_REQUEST_KINDS: readonly string[] = ['request', 'task', 'work-order', 'assign', 'approval'];
/** `reason:` ref values that make a request from below HQ-level (cross-scope · budget · security · priority conflict). */
export const SEAT_MAIL_HQ_REASONS: readonly string[] = ['BUDGET', 'SECURITY', 'CROSS_SCOPE', 'PRIORITY_CONFLICT', 'HUMAN_DECISION', 'CREDENTIAL'];

const lower = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const hasRef = (refs: readonly string[] | null | undefined, prefix: string): boolean => (refs ?? []).some((ref) => ref.startsWith(prefix));
const refValues = (refs: readonly string[] | null | undefined, prefix: string): string[] =>
  (refs ?? []).filter((ref) => ref.startsWith(prefix)).map((ref) => ref.slice(prefix.length).trim().toUpperCase());

export function seatMailRoute(input: SeatMailRouteInput): { route: SeatMailRoute; reason: SeatMailRouteReason } {
  const kind = lower(input.kind);
  const intent = lower(input.intent);
  const turn = (reason: SeatMailRouteReason) => ({ route: 'turn' as const, reason });
  const passive = (reason: SeatMailRouteReason) => ({ route: 'passive' as const, reason });
  if (input.crownDirective || input.origin?.delegatedByCrown) return turn('crown');
  if (input.origin?.kind === 'human' || input.fromKind === 'human') return turn('human');
  if (hasRef(input.refs, 'block:') && hasRef(input.refs, 'reason:')) return turn('hand');
  // #40065 wait-contract cancel notices (intent alert by construction) are bookkeeping for the asker: digest.
  if (hasRef(input.refs, 'wait-cancelled-of:')) return passive('wait-cancel');
  if (intent === 'decision' || SEAT_MAIL_QUESTION_KINDS.includes(kind)) return turn('question');
  if (input.needsAck === true) return turn('needs-reply');
  // From above on the ladder: a work order or the answer this seat waits on — whatever its kind (kind-less included).
  if (input.senderAbove === true) return turn('order');
  if (input.resultState === 'failed') return turn('failed-result');
  if (intent === 'alert' || SEAT_MAIL_ALERT_KINDS.includes(kind) || (typeof input.priority === 'number' && input.priority >= 1) || isUrgentSeatMail({ kind: input.kind ?? null, body: input.body ?? '' })) return turn('alert');
  const request = intent === 'request' || SEAT_MAIL_REQUEST_KINDS.includes(kind) || Boolean(input.doneWhen) || Boolean(input.deadlineAt);
  if (request) {
    if (input.senderAbove === undefined || input.senderAbove === null) return turn('order-unknown-ladder');
    if (refValues(input.refs, 'reason:').some((reason) => SEAT_MAIL_HQ_REASONS.includes(reason))) return turn('hq-reason');
    return passive('routine-request');
  }
  if (isDelegatedResultMail(input)) return turn('delegated-result');
  if (typeof input.replyTo === 'number' && input.replyTo > 0) return passive('reply');
  return passive(kind === '' ? 'no-kind' : 'info');
}

/** Convenience: true when the mail must not open a turn of its own (it rides the digest). */
export function isPassiveSeatMail(input: SeatMailRouteInput): boolean {
  return seatMailRoute(input).route === 'passive';
}

/** The ladder relation the router reads: is `sender` above `recipient`? undefined when either side is unknown. */
export function senderAboveOnLadder(ladder: { depthOf(seat: string): number; parentOf(seat: string): string } | null | undefined,
  sender: string | null | undefined, recipient: string | null | undefined): boolean | undefined {
  if (!ladder || !sender || !recipient) return undefined;
  try {
    const s = sender.trim().toUpperCase();
    const r = recipient.trim().toUpperCase();
    if (s === r) return false;
    if (ladder.parentOf(r).toUpperCase() === s) return true;
    return ladder.depthOf(s) < ladder.depthOf(r);
  } catch { return undefined; }
}
