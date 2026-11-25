/**
 * MAIL-ANTI-FLOOD E·F·G (대표 11-25 · steward A/B world «B''») — the sender side of seat mail.
 *
 * S: 11-25 08–14 OP received 1068 mails (≈180/h). 26% were OP's own wakes/reminders posted to itself, 10% were coach
 *    (CLAUDE-OP) context injections, 60% carried no kind at all. Every one of them could open a turn.
 * C: the receiver-side triage (B') decides «turn now vs digest» from structured fields — but it can only be as good as
 *    the fields the sender wrote, and it cannot stop the volume (a row is a row).
 * Q: how do we cut what is GENERATED, deterministically, without reading prose?
 * A: three levers at the post entrance (CLI `msg post` · MsgPost tool):
 *    E  structured post — `kind` from a closed set ⊕ `needsReply` (bool). The CLI refuses a kind-less post with a
 *       one-line fix; the tool path auto-tags from sender role ⊕ replyTo ⊕ structured refs (never the body); any other
 *       (programmatic) caller is read as kind=info · needsReply=false — passive, not a turn.
 *    F  self-mail and coach injections leave the mailbox — a seat's mail to itself becomes a scheduled wake
 *       (`self-wakes.ts`); a coach mail without needsReply/crown becomes a coach note (`coach-notes.ts`, one line per
 *       30 min into the next turn). Only coach mail with needsReply or a crown flag stays mail.
 *    G  back-pressure — when the receiver's pending passive queue > N (default 30) or its MAIL-OPENED turns/h > M
 *       (default 20 · self-wakes and goal-drive turns do not count · RAIL30 ①), a non-urgent post is folded into the
 *       receiver's digest ledger instead of becoming a row: «receiver saturated — recorded to ledger/digest».
 *       ✋ · crown · question/decision needsReply · P0 · a result answering the receiver's own ask always pass.
 *       RAIL30 ② one owner each: G folds per sender at post time and never folds what Q9 (tui/seat-mail-flood.ts)
 *       would let through; Q9 decides turn-opening on the receiver and its meter counts folded arrivals too.
 *
 * 세 얼굴: 관측 = debug.log('msg', 'msg.post.shape' | 'msg.post.diverted' | 'msg.backpressure' {to, folded}) ·
 *          인지 = these pure functions (one table each, unit-tested with literals) ·
 *          수복과 인계 = nothing is dropped: a refused CLI post prints the exact fix · a diverted post lands in a wake,
 *          a note or a fold ledger the receiver reads on its next turn.
 */

/** E — the closed set of canonical kinds a sender picks from. */
export const MSG_POST_KINDS = [
  'request', 'question', 'decision', 'alert', 'info', 'notice', 'status', 'report', 'announce', 'coord', 'ack', 'receipt', 'goal',
] as const;
export type MsgPostKind = typeof MSG_POST_KINDS[number];

/** Legacy kinds already written by seat tools — accepted and stored as written; their class is the canonical one. */
export const MSG_POST_KIND_ALIASES: Readonly<Record<string, MsgPostKind>> = {
  ask: 'question', incident: 'alert', 'stall-alert': 'alert', urgent: 'alert', interrupt: 'alert', supervisor: 'alert',
  'status-card': 'status', progress: 'status', bulletin: 'notice', review: 'report', receipts: 'receipt', retro: 'report',
  'retro-report': 'report', reply: 'status', 'seat-cap-resume': 'notice', pregate: 'request', 'pregate-receipt': 'request', task: 'request', 'work-order': 'request', assign: 'request', approval: 'decision',
};

/**
 * Canonical kinds the sender waits on by default (needsReply defaults to true · `--no-needs-reply` turns it off).
 * A request is work, not a question: it waits for its result (A217 deadline ⊕ done), not for a reply — so it opens the
 * receiver's turn only with `--needs-reply` (or a crown flag · ✋ refs), and a routine one rides the digest.
 */
const ASKING_KINDS: ReadonlySet<MsgPostKind> = new Set(['question', 'decision']);

/** Coach seats — their context injections are notes, not mail (F). */
export const COACH_SEATS: readonly string[] = ['CLAUDE-OP'];

/** HQ-level `reason:` refs (a ✋ HandRaise names one of these). */
const HAND_REASONS = ['HUMAN_DECISION', 'BUDGET', 'SECURITY', 'CROSS_SCOPE', 'PRIORITY_CONFLICT', 'CREDENTIAL'];

const lower = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const hasRef = (refs: readonly string[] | null | undefined, prefix: string): boolean => (refs ?? []).some((r) => r.startsWith(prefix));

/** The canonical class of a kind, or null when it is outside the closed set (aliases included). */
export function canonicalPostKind(kind: string | null | undefined): MsgPostKind | null {
  const k = lower(kind);
  if (!k) return null;
  if ((MSG_POST_KINDS as readonly string[]).includes(k)) return k as MsgPostKind;
  return MSG_POST_KIND_ALIASES[k] ?? null;
}

export interface PostShapeInput {
  readonly from: string;
  readonly to: string;
  readonly kind?: string | null;
  readonly needsReply?: boolean | null;
  readonly intent?: string | null;
  readonly replyTo?: number | null;
  readonly refs?: readonly string[] | null;
  readonly crownDirective?: string | null;
  readonly priority?: number | null;
  readonly origin?: { readonly kind?: string } | null;
  /** The sender sits above the recipient on the federation ladder (computed by the caller · undefined = unknown). */
  readonly senderAbove?: boolean;
  /** A217 request contract fields — a request that names due ⊕ done is waited on (needsReply defaults true). */
  readonly doneWhen?: string | null;
  readonly deadlineAt?: string | null;
  /**
   * RAIL30 ① — this post answers the receiver's own ask: `replyTo` is a mail the receiver sent, or a `result:`/`pr:`/
   * `receipt:` ref for a `cell:` the receiver owns or assigned (computed by the caller from the ledger · undefined = no).
   */
  readonly answersReceiverAsk?: boolean;
}

export type PostEntrance = 'cli' | 'tool' | 'legacy';
export type PostShapeRule = 'explicit' | 'intent' | 'crown' | 'hand' | 'reply' | 'refs' | 'order' | 'coach' | 'default' | 'legacy' | 'kindless';

export type PostShape =
  | { ok: true; kind: string; cls: MsgPostKind; needsReply: boolean; rule: PostShapeRule }
  | { ok: false; error: string };

/** One-line warning the CLI prints when a kind-less post is stored as passive info (the post is kept · exit 0). */
export function postKindlessWarning(): string {
  return `msg post warning (no --kind): stored as --kind info (passive · needsReply=false · no turn) — add --kind <${MSG_POST_KINDS.join('|')}> and --needs-reply when you wait for an answer`;
}

/** One-line fix the CLI prints for an unknown explicit kind (refused). */
export function postKindHint(given?: string | null): string {
  const what = given ? `unknown --kind ${JSON.stringify(given)}` : 'no --kind';
  return `msg post refused (${what}): add --kind <${MSG_POST_KINDS.join('|')}> and --needs-reply when you wait for an answer — e.g. eln msg post --kind info --to OP '<line>'`;
}

function intentKind(intent: string): MsgPostKind | null {
  return intent === 'request' || intent === 'decision' || intent === 'alert' || intent === 'info' ? intent : null;
}

/**
 * E — the kind ⊕ needsReply a post is stored with. Explicit kind wins (closed set · aliases allowed · an unknown explicit
 * kind is refused); a kind-less CLI post is stored as passive info with a warning (rule `kindless` · seat scripts keep
 * working · `msg.kindless` counts them), the tool path auto-tags, and any other caller is read as passive info.
 * The auto-tag reads structured fields only: crown · ✋ refs · intent · replyTo · refs (pr:/cell:/result) · sender role.
 */
export function resolvePostShape(input: PostShapeInput, entrance: PostEntrance): PostShape {
  const given = input.kind?.trim() ? input.kind.trim() : null;
  const pick = (kind: string, cls: MsgPostKind, rule: PostShapeRule, needsReply?: boolean): PostShape =>
    ({ ok: true, kind, cls, rule, needsReply: input.needsReply ?? needsReply ?? (ASKING_KINDS.has(cls) || (cls === 'request' && Boolean(input.doneWhen || input.deadlineAt))) });
  if (given !== null) {
    const cls = canonicalPostKind(given);
    if (cls === null) return entrance === 'legacy' ? pick(lower(given), 'info', 'legacy', false) : { ok: false, error: postKindHint(given) };
    return pick(lower(given), cls, 'explicit');
  }
  if (entrance === 'legacy') return pick('info', 'info', 'legacy', false);
  // Strong structured signals name the class on every entrance (crown · ✋ refs · explicit intent) — no prose read.
  const fromIntent = intentKind(lower(input.intent));
  if (input.crownDirective) return pick('request', 'request', 'crown', true);
  if (hasRef(input.refs, 'block:') && hasRef(input.refs, 'reason:')) return pick('alert', 'alert', 'hand', true);
  if (fromIntent) return pick(fromIntent, fromIntent, 'intent');
  // The CLI stores the rest as passive info (warned · logged); the tool path auto-tags from weak structure ⊕ sender role.
  if (entrance === 'cli') return pick('info', 'info', 'kindless', false);
  if (typeof input.replyTo === 'number') return pick('status', 'status', 'reply', false);
  if (hasRef(input.refs, 'pr:') || hasRef(input.refs, 'cell:') || hasRef(input.refs, 'result:')) return pick('status', 'status', 'refs', false);
  if (COACH_SEATS.includes(input.from.toUpperCase())) return pick('info', 'info', 'coach', false);
  if (input.senderAbove === true) return pick('request', 'request', 'order', false);
  return pick('info', 'info', 'default', false);
}

/**
 * G — mail that always passes back-pressure: ✋ · crown · a person · an order from above on the ladder · alert/P0 ·
 * question/decision or HQ-reason request that needs a reply · a result answering the receiver's own ask (RAIL30 ①).
 */
export function isUrgentPost(input: PostShapeInput & { cls?: MsgPostKind; needsReply?: boolean | null }): boolean {
  if (input.crownDirective) return true;
  // An order from a seat above the receiver opens a turn on arrival (seatMailRoute `order`) — it is never folded at post time.
  if (input.senderAbove === true) return true;
  // RAIL30 ① — a delegated result (a reply to the receiver's own ask) is what the receiver waits on: never folded.
  if (input.answersReceiverAsk === true) return true;
  // A person's own words (origin human · a Telegram relay) are never folded.
  if (lower(input.origin?.kind) === 'human' || hasRef(input.refs, 'telegram-message:')) return true;
  const hqReason = (input.refs ?? []).some((r) => r.startsWith('reason:') && HAND_REASONS.includes(r.slice(7).trim().toUpperCase()));
  // ✋ (block ⊕ HQ reason) · or an HQ-level request that waits on an answer (reason ref ⊕ needsReply).
  if (hqReason && (hasRef(input.refs, 'block:') || input.needsReply === true)) return true;
  if (typeof input.priority === 'number' && input.priority >= 1) return true;
  const cls = input.cls ?? canonicalPostKind(input.kind) ?? intentKind(lower(input.intent));
  if (cls === 'alert' || lower(input.intent) === 'alert') return true;
  if ((cls === 'question' || cls === 'decision' || lower(input.intent) === 'decision') && input.needsReply === true) return true;
  return false;
}

export type PostDestination = 'mailbox' | 'self-wake' | 'coach-note';

/**
 * F — where a post goes. A seat's mail to itself is a scheduled wake (a human's or a crown relay stays mail); a coach
 * mail is a coach note unless it needs a reply or carries a crown flag.
 */
export function postDestination(input: PostShapeInput & { needsReply?: boolean | null }): PostDestination {
  const from = input.from.toUpperCase();
  const to = input.to.toUpperCase();
  const keepsMail = Boolean(input.crownDirective) || lower(input.origin?.kind) === 'human' || hasRef(input.refs, 'telegram-message:');
  if (from === to && !keepsMail) return 'self-wake';
  if (COACH_SEATS.includes(from) && !keepsMail && input.needsReply !== true) return 'coach-note';
  return 'mailbox';
}

/** G defaults — N pending passive items · M turns per hour. */
export const BACKPRESSURE_DEFAULTS = { maxPendingPassive: 30, maxTurnsPerHour: 20 } as const;
export interface BackpressureConfig { maxPendingPassive: number; maxTurnsPerHour: number }

export interface BackpressureInput {
  readonly urgent: boolean;
  /** Receiver's unacked passive mail ⊕ unread folded entries. */
  readonly pendingPassive: number;
  /** Receiver's turns in the last hour (null = unknown → only the queue counts). */
  readonly turnsLastHour: number | null;
}

export type BackpressureVerdict = { fold: false; reason: 'urgent' | 'below' } | { fold: true; reason: 'queue' | 'turns' };

/** G — fold a non-urgent post when the receiver is saturated. */
export function backpressureVerdict(input: BackpressureInput, cfg: BackpressureConfig = BACKPRESSURE_DEFAULTS): BackpressureVerdict {
  if (input.urgent) return { fold: false, reason: 'urgent' };
  if (input.pendingPassive > cfg.maxPendingPassive) return { fold: true, reason: 'queue' };
  if (input.turnsLastHour !== null && input.turnsLastHour > cfg.maxTurnsPerHour) return { fold: true, reason: 'turns' };
  return { fold: false, reason: 'below' };
}

/** The one line a folded post's sender reads. */
export function foldedLine(to: string, reason: 'queue' | 'turns'): string {
  return `receiver saturated — recorded to ledger/digest (${to} · ${reason === 'queue' ? 'pending passive queue' : 'turns/h'} over the limit; ✋/crown/decision needsReply/P0 still pass)`;
}

/** Read a back-pressure config object (any missing/invalid field keeps the code default). */
export function backpressureConfigFrom(raw: unknown): BackpressureConfig {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return { maxPendingPassive: num(o.maxPendingPassive, BACKPRESSURE_DEFAULTS.maxPendingPassive), maxTurnsPerHour: num(o.maxTurnsPerHour, BACKPRESSURE_DEFAULTS.maxTurnsPerHour) };
}
