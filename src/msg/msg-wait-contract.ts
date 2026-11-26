// MSG-WAIT-CONTRACT (대표 11-25 «상대방이 수신을 안 하면 끝까지 스턱되는 구조인가?») — a seat waiting on another seat never
// waits forever, and a reply never fails to count because it lacked a `replyTo` link.
//
// S: TC's screen sat on «⏳ Waiting for message OP의 #161967 …» while OP had already sent TC two mails (#161987 · #161996)
//    — both with an empty replyTo, so the wait for a reply to #161967 never matched. `msg wait-for` defaulted to the 4h
//    max horizon. UX ↔ TC-H-CX-1 deadlocked the same way 30 min earlier.
// C: the wait/reply contract cannot depend on a model remembering `--reply-to`, and an unanswered counterpart must end in
//    a retry and then a cancel — never a silent stall.
// Q: what counts as the reply, how long is the default wait, and what happens when it runs out?
// A: four rules, ledger-only and idempotent (provenance keys), so every entrance (msg post · MsgPost · msg ask · MsgAsk ·
//    msg wait-for · the TUI tick · msg wait-tick) gets the same answer:
//      1. Threading — a post from A to X while X has an unanswered answer-expected mail to A (question · ask · decision,
//         or a mail X waits on) gets replyTo = the newest such mail (`--no-reply-to` / noReplyTo opts out). A ✋ is NOT
//         auto-threaded: it closes only on an explicit outcome (HAND-RAISE-LADDER #40061).
//      2. Sender match — a wait for X's reply to #M is satisfied by ANY later mail from X to the asker (logged
//         `msg.wait matched-by-sender` when the replyTo link is missing).
//      3. Default horizon 10 min → one reminder to the counterpart (`msg.wait retry`) → 5 more min → the wait is
//         cancelled with «no reply in 15m — proceed with the part independent of the reply» (`msg.wait cancelled`) and
//         the asker's coordinator is told once (`msg.wait coordinator-notified`).
//      4. Receiver obligation — a received question/decision stays open until the receiver posts back; after 10 min it is
//         re-surfaced at the top of the receiver's queue (TUI, via the HAND-RAISE-REPLY-GATE machinery).
//    Cycles between seats (A waits on B waits on A) are WAIT-CYCLE-DETECTOR's board view — not here.
//
// 세 얼굴:
//   관측 = debug.log('msg.wait', 'matched-by-sender' | 'retry' | 'cancelled' | 'coordinator-notified' | 'auto-reply-to')
//          · debug.log('msg.question', 'open' | 'unanswered' | 'replied')
//   인지 = isAnswerExpectedMail (kind · intent · refs — never the body) · replyMatch (reply_to or sender) · wait-until ref
//   수복과 인계 = reminder at the horizon · cancel with a result at horizon + 5m · coordinator once · question re-surfaced

import { debug } from '../debug/log.js';
import { canonicalMessageAddress, type Message, type MessageEnvelope, type MsgStore } from './msg-store.js';

// ── constants (NUMGUARD — source noted) ───────────────────────────────────────────────────────

/** Default wait horizon for a reply — 대표 11-25 «일정 시간 이상 응답이 없으면 알아서 retry 하거나 cancel». */
export const MSG_WAIT_DEFAULT_WITHIN_MS = 10 * 60_000;
/** After the one reminder, how much longer the wait holds before it is cancelled — 대표 11-25 (10m + 5m = 15m). */
export const MSG_WAIT_RETRY_GRACE_MS = 5 * 60_000;
/** A received question/decision unanswered this long is re-surfaced at the top of the receiver's queue — 대표 11-25. */
export const MSG_QUESTION_RESURFACE_AFTER_MS = 10 * 60_000;
/** The stateless sweep looks this far back (same window as the ✋ ladder sweep · hand-raise-ladder.ts). */
export const MSG_WAIT_SWEEP_WINDOW_MS = 2 * 60 * 60_000;
/** How many of the counterpart's newest mails threading inspects. */
const THREAD_SCAN_LIMIT = 50;

export const MSG_WAIT_LOG_CATEGORY = 'msg.wait';
export const MSG_WAIT_EVENTS = {
  matchedBySender: 'matched-by-sender',
  retry: 'retry',
  cancelled: 'cancelled',
  coordinatorNotified: 'coordinator-notified',
  autoReplyTo: 'auto-reply-to',
} as const;
/** The ref an asking mail carries: when its reply is due (ISO). The sweep reads it — never the body. */
export const WAIT_UNTIL_REF = 'wait-until:';
/** The reminder's kind — not answer-expected itself, so threading keeps pointing at the original question. */
export const WAIT_REMINDER_KIND = 'reminder';
/** Where a coordinator-level notice goes when the asker is the HQ coordinator (same copy seat as the ✋ ladder). */
export const WAIT_HQ_COPY_TO = 'CLAUDE-OP';

export type WaitLog = (event: string, data: Record<string, unknown>) => void;
const defaultLog: WaitLog = (event, data) => { try { debug.log(MSG_WAIT_LOG_CATEGORY, event, data); } catch { /* fail-open */ } };
const safe = (log: WaitLog | undefined, event: string, data: Record<string, unknown>): void => { try { (log ?? defaultLog)(event, data); } catch { /* fail-open */ } };
const canon = (seat: string): string => { try { return canonicalMessageAddress(seat); } catch { return seat.trim().toUpperCase(); } };
const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000));

// ── classification (structured fields only) ──────────────────────────────────────────────────

type Classifiable = { readonly kind?: string | null; readonly intent?: string | null; readonly refs?: readonly string[] | null };

/** A ✋ NEED HUMAN mail (refs `block:` ⊕ `reason:`) — owned by the HAND-RAISE-LADDER, never auto-threaded here. */
export function isHandMail(m: Classifiable): boolean {
  const refs = m.refs ?? [];
  return refs.some((r) => r.startsWith('block:')) && refs.some((r) => r.startsWith('reason:'));
}

/** A question or decision that expects an answer from its receiver (not a ✋ — those have their own ladder). */
export function isAnswerExpectedMail(m: Classifiable): boolean {
  if (isHandMail(m)) return false;
  const kind = (m.kind ?? '').toLowerCase();
  return kind === 'question' || kind === 'ask' || kind === 'decision' || m.intent === 'decision';
}

export function waitUntilOf(m: { readonly refs?: readonly string[] | null }): number | null {
  const raw = m.refs?.find((r) => r.startsWith(WAIT_UNTIL_REF))?.slice(WAIT_UNTIL_REF.length);
  const at = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

export const waitUntilRef = (atMs: number): string => `${WAIT_UNTIL_REF}${new Date(atMs).toISOString()}`;

// ── reply matching ───────────────────────────────────────────────────────────────────────────

/** The first mail from `from` to `to` after id `after` (any kind — a self notice never qualifies since from ≠ to). */
export function laterMailFrom(store: MsgStore, input: { after: number; from: string; to: string }): Message | null {
  const from = canon(input.from);
  const to = canon(input.to);
  if (from === to) return null;
  const row = store.db.query('SELECT id FROM msg_messages WHERE id > ? AND sender = ? AND recipient = ? ORDER BY id ASC LIMIT 1')
    .get(input.after, from, to) as { id: number } | null;
  return row ? store.getMessage(row.id) : null;
}

export interface ReplyMatch { readonly reply: Message; readonly by: 'reply-to' | 'sender' }

/**
 * The reply to `question` (asked by question.from of question.to): a linked reply (replyTo = question.id) from the
 * counterpart first, else ANY later mail from the counterpart to the asker (the sender-match fallback).
 */
export function replyMatch(store: MsgStore, question: { readonly id: number; readonly from: string; readonly to: string }): ReplyMatch | null {
  const asker = canon(question.from);
  const counterpart = canon(question.to);
  const linked = store.listReplies(question.id, 100).find((m) => canon(m.from) === counterpart && canon(m.to) === asker);
  if (linked) return { reply: linked, by: 'reply-to' };
  const later = laterMailFrom(store, { after: question.id, from: counterpart, to: asker });
  return later ? { reply: later, by: 'sender' } : null;
}

/** replyMatch ⊕ the `msg.wait matched-by-sender` line when the link was missing. */
export function replyMatchLogged(store: MsgStore, question: { readonly id: number; readonly from: string; readonly to: string }, log?: WaitLog): ReplyMatch | null {
  const match = replyMatch(store, question);
  if (match?.by === 'sender') safe(log, MSG_WAIT_EVENTS.matchedBySender, { question: question.id, asker: canon(question.from), counterpart: canon(question.to), reply: match.reply.id });
  return match;
}

// ── 1. threading ─────────────────────────────────────────────────────────────────────────────

export interface ThreadingDeps {
  /** Mail ids `seat` is waiting on (its armed `mail-reply:<id>` wakers). Default: none. */
  readonly waitedOn?: (seat: string) => readonly number[];
}

/**
 * The replyTo a post from `from` to `to` should carry, or null: the newest mail from `to` to `from` that expects an answer
 * (or that `to` waits on) and that `from` has not answered yet — i.e. newer than `from`'s last mail to `to`.
 */
export function inferReplyTo(store: MsgStore, input: { from: string; to: string }, deps: ThreadingDeps = {}): number | null {
  const from = canon(input.from);
  const to = canon(input.to);
  if (from === to || to === 'ALL' || to.startsWith('GROUP:') || to.toLowerCase().startsWith('group:')) return null;
  const lastMine = (store.db.query('SELECT COALESCE(MAX(id), 0) AS id FROM msg_messages WHERE sender = ? AND recipient = ?').get(from, to) as { id: number }).id;
  const rows = store.db.query('SELECT id FROM msg_messages WHERE sender = ? AND recipient = ? AND id > ? ORDER BY id DESC LIMIT ?')
    .all(to, from, lastMine, THREAD_SCAN_LIMIT) as { id: number }[];
  if (rows.length === 0) return null;
  let waited: ReadonlySet<number> = new Set();
  try { waited = new Set(deps.waitedOn?.(to) ?? []); } catch { /* an unreadable waker file waits on nothing */ }
  for (const { id } of rows) {
    const m = store.getMessage(id);
    if (!m || isHandMail(m)) continue;
    if (isAnswerExpectedMail(m) || waited.has(id)) return id;
  }
  return null;
}

/** Production `waitedOn`: the seat's armed `mail-reply:<id>` wakers (self-timer store). */
export function wakerWaitedOn(listWakers: (seat: string) => readonly { status: string; condition: string }[]): (seat: string) => number[] {
  return (seat) => listWakers(seat)
    .filter((w) => w.status === 'armed' && w.condition.startsWith('mail-reply:'))
    .map((w) => Number(w.condition.slice('mail-reply:'.length)))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

/**
 * The envelope with replyTo filled by threading (unchanged when it already has one, when `optOut`, or when nothing is
 * unanswered). Logged `msg.wait auto-reply-to`. Never throws — threading is a convenience, the post must still land.
 */
export function withAutoReplyTo<E extends MessageEnvelope>(store: MsgStore, envelope: E, input: { optOut?: boolean; log?: WaitLog } & ThreadingDeps = {}): E {
  if (input.optOut || envelope.replyTo !== undefined) return envelope;
  try {
    const replyTo = inferReplyTo(store, { from: envelope.from, to: envelope.to }, input);
    if (replyTo === null) return envelope;
    safe(input.log, MSG_WAIT_EVENTS.autoReplyTo, { from: canon(envelope.from), to: canon(envelope.to), replyTo });
    return { ...envelope, replyTo };
  } catch { return envelope; }
}

// ── 3. retry → cancel ────────────────────────────────────────────────────────────────────────

export interface WaitPair { readonly messageId: number; readonly asker: string; readonly counterpart: string }

/** Write under provenance `key` unless it exists (one IMMEDIATE transaction — exactly one writer is fresh). */
function appendOnce(store: MsgStore, key: string, envelope: () => MessageEnvelope): { mail: Message; fresh: boolean } {
  return store.db.transaction(() => {
    const before = store.findByProvenanceKey(key);
    if (before) return { mail: before, fresh: false };
    return { mail: store.appendWithProvenance(envelope(), key), fresh: true };
  }).immediate();
}

export const waitReminderLine = (p: WaitPair, waitedMs: number): string =>
  `[⏳ reminder] ${p.asker} is still waiting for your reply to #${p.messageId} (${minutes(waitedMs)}m) — reply with: `
  + `eln msg post --from ${p.counterpart} --to ${p.asker} --reply-to ${p.messageId} "<answer>"`;

export const waitCancelledResult = (waitedMs: number): string =>
  `no reply in ${minutes(waitedMs)}m — proceed with the part independent of the reply`;

export const waitCancelledLine = (p: WaitPair, waitedMs: number): string =>
  `[⏳ wait cancelled] ${waitCancelledResult(waitedMs)} · #${p.messageId} to ${p.counterpart}`;

export const waitCoordinatorLine = (p: WaitPair, waitedMs: number): string =>
  `[⏳ wait cancelled · ${p.asker} ↔ ${p.counterpart}] ${p.asker} got no reply to #${p.messageId} from ${p.counterpart} in ${minutes(waitedMs)}m `
  + `(one reminder sent) — the wait was cancelled; nudge ${p.counterpart} or reassign the question.`;

/** The one reminder to the counterpart (provenance `msg-wait-retry:<id>`). `fresh` = this call wrote it. */
export function postWaitRetry(store: MsgStore, pair: WaitPair, waitedMs: number, log?: WaitLog): { mail: Message; fresh: boolean } {
  const p = { ...pair, asker: canon(pair.asker), counterpart: canon(pair.counterpart) };
  const written = appendOnce(store, `msg-wait-retry:${p.messageId}`, () => ({
    from: p.asker, to: p.counterpart, kind: WAIT_REMINDER_KIND, intent: 'request',
    refs: [`wait-retry-of:${p.messageId}`], body: waitReminderLine(p, waitedMs),
  }));
  if (written.fresh) safe(log, MSG_WAIT_EVENTS.retry, { question: p.messageId, asker: p.asker, counterpart: p.counterpart, waitedMin: minutes(waitedMs), mailId: written.mail.id });
  return written;
}

export interface WaitCancelResult { readonly result: string; readonly noticeId: number; readonly coordinator: string | null; readonly coordinatorMailId: number | null; readonly fresh: boolean }

/**
 * Cancel the wait: a notice to the asker carrying the result (provenance `msg-wait-cancel:<id>`) and — once — a notice to
 * the asker's coordinator naming the pair and the original id (`msg-wait-cancel-coord:<id>`).
 */
export function postWaitCancel(store: MsgStore, pair: WaitPair, waitedMs: number, deps: { parentOf?: (seat: string) => string; log?: WaitLog } = {}): WaitCancelResult {
  const p = { ...pair, asker: canon(pair.asker), counterpart: canon(pair.counterpart) };
  const result = waitCancelledResult(waitedMs);
  const notice = appendOnce(store, `msg-wait-cancel:${p.messageId}`, () => ({
    from: p.asker, to: p.asker, kind: 'notice', intent: 'alert',
    refs: [`wait-cancelled-of:${p.messageId}`, `wait-counterpart:${p.counterpart}`], body: waitCancelledLine(p, waitedMs),
  }));
  if (notice.fresh) safe(deps.log, MSG_WAIT_EVENTS.cancelled, { question: p.messageId, asker: p.asker, counterpart: p.counterpart, waitedMin: minutes(waitedMs), noticeId: notice.mail.id });
  let coordinator: string | null = null;
  let coordinatorMailId: number | null = null;
  try {
    const parent = deps.parentOf ? canon(deps.parentOf(p.asker)) : null;
    coordinator = parent === null || parent === p.asker ? null : parent === 'CEO' ? WAIT_HQ_COPY_TO : parent;
    if (coordinator !== null && coordinator !== p.asker) {
      const to = coordinator;
      const told = appendOnce(store, `msg-wait-cancel-coord:${p.messageId}`, () => ({
        from: p.asker, to, kind: 'notice', intent: 'alert',
        refs: [`wait-cancelled-of:${p.messageId}`, `wait-pair:${p.asker}:${p.counterpart}`], body: waitCoordinatorLine(p, waitedMs),
      }));
      coordinatorMailId = told.mail.id;
      if (told.fresh) safe(deps.log, MSG_WAIT_EVENTS.coordinatorNotified, { question: p.messageId, asker: p.asker, counterpart: p.counterpart, coordinator: to, mailId: told.mail.id });
    } else coordinator = null;
  } catch (error) { safe(deps.log, 'coordinator-notify-failed', { question: p.messageId, error: String(error).slice(0, 200) }); }
  return { result, noticeId: notice.mail.id, coordinator, coordinatorMailId, fresh: notice.fresh };
}

export type WaitStep =
  | { readonly state: 'answered'; readonly match: ReplyMatch }
  | { readonly state: 'pending' }
  | { readonly state: 'retried'; readonly mailId: number }
  | { readonly state: 'cancelled'; readonly cancel: WaitCancelResult };

/**
 * One step of a reply wait on the ledger (idempotent): answered → stop · before the horizon → pending · at the horizon →
 * the one reminder · at horizon + 5m → cancelled (asker notice ⊕ coordinator once). Any number of callers may run it.
 */
export function advanceWait(store: MsgStore, input: WaitPair & { startedAtMs: number; withinMs: number; now: number; parentOf?: (seat: string) => string; log?: WaitLog; logMatch?: boolean }): WaitStep {
  const question = { id: input.messageId, from: input.asker, to: input.counterpart };
  const match = input.logMatch ? replyMatchLogged(store, question, input.log) : replyMatch(store, question);
  if (match) return { state: 'answered', match };
  const waited = input.now - input.startedAtMs;
  if (waited < input.withinMs) return { state: 'pending' };
  if (waited < input.withinMs + MSG_WAIT_RETRY_GRACE_MS) {
    const { mail, fresh } = postWaitRetry(store, input, waited, input.log);
    return fresh ? { state: 'retried', mailId: mail.id } : { state: 'pending' };
  }
  // A reminder is always sent before a cancel (a sweep that slept through the grace window still sends it first).
  postWaitRetry(store, input, waited, input.log);
  return { state: 'cancelled', cancel: postWaitCancel(store, input, waited, { ...(input.parentOf ? { parentOf: input.parentOf } : {}), ...(input.log ? { log: input.log } : {}) }) };
}

export interface WaitSweepAction { readonly messageId: number; readonly asker: string; readonly counterpart: string; readonly state: 'retried' | 'cancelled' }

/**
 * The stateless sweep over asking mails that carry a `wait-until:` ref (msg ask · MsgAsk): answered ones are left alone,
 * overdue ones get the reminder, then the cancel. `involving` limits it to waits this seat asked or is asked.
 */
export function sweepWaitContracts(store: MsgStore, input: { now: number; involving?: string; parentOf?: (seat: string) => string; log?: WaitLog }): WaitSweepAction[] {
  const hasRefs = (store.db.query("SELECT COUNT(*) AS n FROM pragma_table_info('msg_messages') WHERE name = 'refs_json'").get() as { n: number }).n > 0;
  if (!hasRefs) return [];
  const who = input.involving ? canon(input.involving) : null;
  const rows = store.db.query(`SELECT id FROM msg_messages WHERE created_at >= ? AND refs_json LIKE ?${who ? ' AND (sender = ? OR recipient = ?)' : ''} ORDER BY id ASC`)
    .all(...[new Date(input.now - MSG_WAIT_SWEEP_WINDOW_MS).toISOString(), `%"${WAIT_UNTIL_REF}%`, ...(who ? [who, who] : [])]) as { id: number }[];
  const done: WaitSweepAction[] = [];
  for (const { id } of rows) {
    try {
      if (store.findByProvenanceKey(`msg-wait-cancel:${id}`)) continue;
      const m = store.getMessage(id);
      const until = m ? waitUntilOf(m) : null;
      if (!m || until === null || input.now < until) continue;
      const startedAtMs = Date.parse(m.createdAt);
      const step = advanceWait(store, { messageId: id, asker: m.from, counterpart: m.to, startedAtMs, withinMs: Math.max(0, until - startedAtMs), now: input.now,
        ...(input.parentOf ? { parentOf: input.parentOf } : {}), ...(input.log ? { log: input.log } : {}), logMatch: true });
      if (step.state === 'retried' || (step.state === 'cancelled' && step.cancel.fresh)) done.push({ messageId: id, asker: canon(m.from), counterpart: canon(m.to), state: step.state });
    } catch (error) { safe(input.log, 'sweep-failed', { question: id, error: String(error).slice(0, 200) }); }
  }
  return done;
}

// ── 4. receiver obligation ───────────────────────────────────────────────────────────────────

// MSG-PENDING-QUESTION-STALE (OP 11-26 · #178447 banner stayed after #178703 answered it without --reply-to): a pending
// question closes on ANY of — (a) a later mail seat→asker whose replyTo or a ref names the id · (b) any later mail
// seat→asker · (c) the question acked/cleared at the seat · an operator dismiss (audit row) — and the TUI retracts its line.
// (d) /new drops the open items (gate.dropAll) and keeps one digest line.

export type QuestionClosedBy = 'reply-to' | 'ref' | 'sender' | 'acked' | 'dismissed';
export const QUESTION_DISMISS_KEY = (id: number): string => `msg-question-dismiss:${id}`;
export const QUESTION_DISMISSED_REF = 'question-dismissed:';

const refNamesId = (ref: string, id: number): boolean => {
  const n = String(id);
  return ref === n || ref.endsWith(`:${n}`) || ref.endsWith(`#${n}`);
};

/** Why question #msgId (sender → seat) is closed, or null while it is still open. */
export function questionClosedBy(store: MsgStore, q: { readonly msgId: number; readonly seat: string; readonly sender: string }): QuestionClosedBy | null {
  const seat = canon(q.seat);
  const asker = canon(q.sender);
  if (store.findByProvenanceKey(QUESTION_DISMISS_KEY(q.msgId))) return 'dismissed';
  const rows = store.db.query('SELECT id FROM msg_messages WHERE id > ? AND sender = ? AND recipient = ? ORDER BY id ASC LIMIT ?')
    .all(q.msgId, seat, asker, THREAD_SCAN_LIMIT) as { id: number }[];
  let first: QuestionClosedBy | null = null;
  for (const { id } of rows) {
    const m = store.getMessage(id);
    if (!m) continue;
    if (m.replyTo === q.msgId) return 'reply-to';
    if ((m.refs ?? []).some((r) => refNamesId(r, q.msgId))) return 'ref';
    first ??= 'sender';
  }
  if (first) return first;
  const acked = store.db.query('SELECT 1 AS one FROM msg_message_acks WHERE message_id = ? AND recipient = ? LIMIT 1').get(q.msgId, seat);
  return acked ? 'acked' : null;
}

/** Did `seat` close question #msgId from `sender` (reply · ref · any later mail · ack/clear · dismiss)? The gate's `closed` dep. */
export function questionAnsweredOn(store: MsgStore, q: { readonly msgId: number; readonly seat: string; readonly sender: string }): boolean {
  return questionClosedBy(store, q) !== null;
}

export interface QuestionDismissResult { readonly auditId: number; readonly fresh: boolean; readonly seat: string; readonly asker: string }

/**
 * Operator dismiss of a pending-question banner: one audit row on the ledger (provenance `msg-question-dismiss:<id>`,
 * notice by → seat, refs `question-dismissed:<id>` · `dismissed-by:<seat>`) ⊕ the question acked at its receiver.
 * Idempotent. Throws when the id is not a question/decision.
 */
export function dismissQuestion(store: MsgStore, input: { id: number; by: string; reason?: string; log?: WaitLog }): QuestionDismissResult {
  const m = store.getMessage(input.id);
  if (!m) throw new Error(`message #${input.id} not found`);
  if (!isAnswerExpectedMail(m)) throw new Error(`#${input.id} is not a question/decision (kind ${m.kind ?? '-'})`);
  const seat = canon(m.to);
  const asker = canon(m.from);
  const by = canon(input.by);
  const written = appendOnce(store, QUESTION_DISMISS_KEY(input.id), () => ({
    from: by, to: seat, kind: 'notice', intent: 'info',
    refs: [`${QUESTION_DISMISSED_REF}${input.id}`, `dismissed-by:${by}`],
    body: `[❓ dismissed] question #${input.id} from ${asker} dismissed by ${by}${input.reason ? ` — ${input.reason}` : ''}`,
  }));
  try { store.ackMessage(seat, input.id); } catch { /* the audit row alone closes it */ }
  if (written.fresh) { try { (input.log ?? ((e, d) => { try { debug.log('msg.question', e, d); } catch { /* fail-open */ } }))('dismissed', { question: input.id, seat, asker, by, auditId: written.mail.id }); } catch { /* fail-open */ } }
  return { auditId: written.mail.id, fresh: written.fresh, seat, asker };
}

/** /new — the one digest line for the dropped pending questions (English UI text). */
export const questionDigestLine = (opens: readonly { readonly sender: string; readonly msgId: number }[]): string =>
  `❓ ${opens.length} pending question${opens.length === 1 ? '' : 's'} from the last session dropped: ${opens.map((o) => `${o.sender} #${o.msgId}`).join(', ')} — reopen with: eln msg thread <id>`;

/** The P0 line for an unanswered question (English UI text). */
export const questionResurfaceLine = (sender: string, waitedMs: number, msgId: number): string =>
  `❓ ${sender} asked #${msgId} ${minutes(waitedMs)}m ago and is waiting for your reply — answer: eln msg post --to ${sender} --reply-to ${msgId} "<answer>"`;
