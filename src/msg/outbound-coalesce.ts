// OUTBOUND-COALESCE (H6 · OP 11-25 «긴 턴 OP 발신 46→92/h · G 는 위에서 내려온 지시를 접지 않는다(#40087)»)
//
// S: with long turns OP's outbound roughly doubled (sim 46→92/h · live 89–128 / 30 min). The receiver gate G never folds
//    it: OP is above every receiver, and an order from above always passes (#40087) — so N mails = N wakes.
// C: structured fields only · never fold what must interrupt (crown · alert · P0/urgent · ✋/question/decision · goal ·
//    retraction · a reply the sender waits on) · never merge into a mail the receiver already took into a turn.
// Q: how do N small orders from above become one?
// A: sender-side: a mail from above to the same receiver within {@link COALESCE_WINDOW_MS} whose earlier mail is still
//    unread and undelivered is appended to that mail (one row · one wake). Plus an outbound metric
//    `msg.outbound {seat, per30m}` and a soft budget: over {@link OUTBOUND_SOFT_BUDGET} / 30 min the seat's own inbox
//    snapshot says «you sent N mails in 30 min — bundle».
//
// 세 얼굴: 관측 = debug.log('msg.post', 'coalesced') · debug.log('msg.outbound', {seat, per30m}) · 판단 근거 =
// {@link coalesceEligible} · 수복과 인계 = the original row carries the appended lines; nothing is dropped.

export const COALESCE_WINDOW_MS = 10 * 60_000;
export const OUTBOUND_WINDOW_MS = 30 * 60_000;
export const OUTBOUND_SOFT_BUDGET = 30;

/** Only these explicit kinds fold (status-like orders); a kind-less post, a request, a reply thread or TA mail never does. */
const FOLD_KINDS: ReadonlySet<string> = new Set(['info', 'notice', 'status', 'coord']);

export interface CoalesceInput {
  readonly senderAbove: boolean;
  readonly kind?: string | null;
  readonly intent?: string | null;
  readonly priority?: number | null;
  readonly crownDirective?: string | null;
  readonly goal?: string | null;
  readonly supersedes?: number | null;
  readonly needsReply?: boolean;
  readonly originKey?: boolean;
  readonly replyTo?: number | null;
  readonly to?: string;
}

/** May this post be appended to the sender's recent mail to the same receiver? */
export function coalesceEligible(m: CoalesceInput): boolean {
  if (!m.senderAbove || m.originKey || typeof m.replyTo === 'number' || (m.to ?? '').toUpperCase() === 'TA') return false;
  if (typeof m.crownDirective === 'string' && m.crownDirective.trim()) return false;
  if (typeof m.goal === 'string' && m.goal.trim()) return false;
  if (typeof m.supersedes === 'number') return false;
  if ((m.priority ?? 0) >= 1) return false;
  if (m.needsReply === true) return false;
  const intent = (m.intent ?? '').trim().toLowerCase();
  if (intent === 'alert' || intent === 'decision') return false;
  return FOLD_KINDS.has((m.kind ?? '').trim().toLowerCase());
}

/** The appended block: a separator stamped with the local HH:MM, then the new body. */
export function appendedBody(previous: string, next: string, at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${previous}\n— +${hh}:${mm}\n${next}`;
}

/** The soft-budget line for the sender's own snapshot, or null under budget. */
export function outboundBudgetLine(sent: number): string | null {
  return sent > OUTBOUND_SOFT_BUDGET ? `you sent ${sent} mails in 30 min — bundle (one mail per receiver per step)` : null;
}
