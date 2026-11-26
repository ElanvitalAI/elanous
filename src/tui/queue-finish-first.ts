/**
 * QUEUE-FINISH-FIRST (대표 11-24 12:4x · 12:5x) — the current work finishes before ordinary mail interrupts it.
 *
 * S: eln OP's work was chopped into ~40 s pieces: every idle boundary dequeued a seat-mail notice and opened a notice
 *    turn (every 30–60 s), so turns ended «partly done, will check later» and the goal continuation never ran
 *    (a queued item made the turn end `yield`, so the continuation was not even armed).
 * C: mail must not be lost or go unseen while the work runs, and the person / CEO / urgent / own-capsule failure must
 *    still start at once.
 * Q: which queued item may open a turn at an idle boundary while the seat's own work is in progress?
 * A: this leaf — classify each queued item by STRUCTURED fields only (kind · source · mail intent · origin · replyTo ·
 *    capsule failure; never the text), and decide at each idle boundary:
 *
 *    | class   | what                                                        | while work is in progress            |
 *    |---------|-------------------------------------------------------------|--------------------------------------|
 *    | P0      | person's line · CEO-origin (origin human / crown) · intent   | starts at the next idle boundary     |
 *    |         | alert · ceo-ingress · failed capsule the seat launched       | (mid-turn: the existing steer path)  |
 *    | related | reply (replyTo) to a mail the current work waits on ·        | joins the next continuation in FULL  |
 *    |         | own capsule/child result                                     |                                      |
 *    | P1      | request / decision mail to the seat · graph-node stall       | joins after 60 s (decision at once) at |
 *    |         |                                                             | the next step/idle boundary · ≤ 3 min |
 *    | P2      | info / report / coord mail · broadcasts · watch lines        | held · peeked in every continuation  |
 *
 *    P1 (QUEUE-P1-3MIN, 대표 13:1x) = hold-and-resume: it joins at the next step boundary (after the running tool batch,
 *    the person's steer path) once it waited 60 s, at once for a decision or when no work is open; the work pauses with
 *    a one-line checkpoint and one continuation resumes it after the P1 turn. Hard cap 3 min from arrival (a running
 *    tool is never cut — the P1 joins when it returns).
 *    Release of P2 (one digest turn): work not in progress (5 min coalescing between mail turns) · 3 continuations ran
 *    while holding (no progress) · P2 waited 20 min (starvation) · the continuation did not start.
 *
 * OP-INBOX-PULSE-BATCH (대표 11-26 «OP keeps getting interrupted, folds work again and again» · ~165 mails/h) — the OP
 * seat only ({@link createQueueFinishFirst} `opBatch`): P0 stays immediate (person · crown · origin human · intent alert ·
 * mail kind `release-stop`, all structured fields); every other mail (request · decision · report · info · coord ·
 * steward/✋ digests · leader replies · coach mail · graph-node stalls) is held and released as ONE batch right after
 * the next op-pulse turn opens ({@link QueueFinishFirst.notePulse}, the pulse inbox's origin-'pulse' turn) or at
 * {@link OP_BATCH_MAX_HOLD_MS} (pulse missing). Nothing is dropped.
 *
 * Three faces: observe = `tui.queue held` / `released` / `peeked` + the «✉ N held» chip; judge = {@link decideIdleQueue}
 * (pure); repair = the release rules above (no mail is ever dropped — held mail stays queued and is peeked).
 */

import type { NextTuiQueueItem } from './core/queue-contract.js';

export type QueueHoldClass = 'P0' | 'related' | 'P1' | 'P2';
export type SeatMailClass = 'P0' | 'P1' | 'P2';

/** QUEUE-P1-3MIN (대표 11-24 13:1x): a P1 never waits longer than this from arrival (hard cap; a running tool is never cut). */
export const QUEUE_HOLD_P1_MAX_MS = 3 * 60_000;
/** QUEUE-P1-3MIN: a P1 that has waited this long joins at the next step boundary (mid-turn steer) or idle boundary. */
export const QUEUE_P1_JOIN_AFTER_MS = 60_000;
/** QUEUE-P1-3MIN: the note a P1 joins with — the current work pauses with a checkpoint and resumes after. */
export { P1_PAUSE_NOTE } from '../chat/interjection.js';
/** QUEUE-P1-3MIN: the continuation that resumes the paused work after the P1 turn. */
export const RESUME_PAUSED_WORK_PROMPT = 'Resume the paused work from your one-line checkpoint (the requirement is still open) and carry it to its result.';
/** OP-INBOX-PULSE-BATCH: the OP batch is released after the next pulse turn, or at the latest this long after arrival. */
export const OP_BATCH_MAX_HOLD_MS = 30 * 60_000;
/**
 * OP-BATCH-IDLE-DUE (CEO 11-26 11:5x «eln OP does not receive mail» · footer «📩 103 held» idle > 1 h) — mail that needs
 * OP's action (request · decision · question · result; never a `notice` bulletin / waker) does not wait for the pulse
 * on an idle OP: it goes once it waited this long (seat idle, or the continuation already had its try).
 */
export const OP_BATCH_ACTION_IDLE_MS = 60_000;
/** OP-BATCH-IDLE-DUE: actionable mail waits at most this long even while OP's own work runs (one continuation boundary). */
export const OP_BATCH_ACTION_MAX_MS = 3 * 60_000;
/** OP-BATCH-IDLE-DUE: the held batch is bounded — this many held items release as one digest without waiting. */
export const OP_BATCH_HELD_CAP = 50;
/** OP-INBOX-PULSE-BATCH: the structured mail kind (`--kind release-stop`) that stops a release — always immediate. */
export const RELEASE_STOP_MAIL_KIND = 'release-stop';
/** P2 waits at most this long while work is in progress. */
export const QUEUE_HOLD_P2_MAX_MS = 20 * 60_000;
/**
 * SEAT-TURN-FOLLOWUPS (66-run terra experiment: the #40092 idle flush doubled cost, arm E $0.36–0.53 vs $0.15–0.29 per run) —
 * an idle seat flushes held mail at most once per this window, and only when something held is not plain info.
 */
export const IDLE_FLUSH_MIN_GAP_MS = 10 * 60_000;
/** Mail intents that are worth an idle flush (anything else is info and waits for the digest / the 20-min starvation). */
const FLUSH_WORTHY_INTENTS: ReadonlySet<string> = new Set(['request', 'decision', 'question', 'result', 'alert']);
const flushWorthy = (item: QueueClassItem, cls: QueueHoldClass): boolean =>
  cls === 'P1' || item.passive !== true || FLUSH_WORTHY_INTENTS.has((item.mailIntent ?? '').toLowerCase());
/** Continuations run while holding before the held mail is released anyway (no progress). */
export const QUEUE_HOLD_CONTINUATION_CAP = 3;
/** A continuation that was opened but did not start within this window releases the held mail. */
export const QUEUE_HOLD_START_GRACE_MS = 15_000;
/** Minimum gap between two mail-triggered turns (P0 is exempt) — the 30–60 s chop ends here. */
export const QUEUE_MAIL_TURN_MIN_GAP_MS = 5 * 60_000;
/** Peek block: at most this many headline lines, then «+N more». */
export const QUEUE_PEEK_MAX_LINES = 8;

/** The structured fields of one seat mail that classification reads (never the body). */
export interface SeatMailClassInput {
  readonly intent?: string | null;
  readonly origin?: { readonly kind?: string; readonly delegatedByCrown?: boolean } | null;
  readonly crownDirective?: string | null;
  readonly fromKind?: string | null;
}

/**
 * One mail's class from its structured fields. P0 = CEO-origin (origin human · crown delegation · verified crown
 * directive) or intent `alert`; P1 = intent `request` / `decision`; P2 = everything else (info · report · coord ·
 * broadcast · no intent). The sender NAME grants nothing (b5c5c3b3: `--from` is not authenticated).
 */
export function classifySeatMail(m: SeatMailClassInput): SeatMailClass {
  if (m.origin?.kind === 'human' || m.origin?.delegatedByCrown === true || m.fromKind === 'human') return 'P0';
  if (typeof m.crownDirective === 'string' && m.crownDirective.trim() !== '') return 'P0';
  if (m.intent === 'alert') return 'P0';
  if (m.intent === 'request' || m.intent === 'decision') return 'P1';
  return 'P2';
}

/** The queue item fields this leaf reads (a queue item, or a drained notice entry — no `kind` there means a notice). */
export interface QueueClassItem {
  readonly id: string;
  readonly text: string;
  readonly kind?: NextTuiQueueItem['kind'];
  readonly source?: NextTuiQueueItem['source'];
  readonly msgId?: number;
  readonly urgent?: boolean;
  readonly passive?: boolean;
  readonly capsuleFailed?: number;
  readonly enqueuedAt?: number;
  readonly occurredAt?: number;
  readonly digest?: string;
  readonly mailClass?: SeatMailClass;
  readonly mailIntent?: string;
  /** The ledger `kind` of a seat mail (structured; `release-stop` is P0 in the OP batch). */
  readonly mailKind?: string;
  readonly replyTo?: number;
}

/** What the current work waits on — a mail replying to one of these ids joins the work. */
export interface WorkWaits {
  readonly replyTo: ReadonlySet<number>;
}

export const NO_WAITS: WorkWaits = { replyTo: new Set() };

export function classifyQueueItem(item: QueueClassItem, waits: WorkWaits = NO_WAITS): QueueHoldClass {
  if (item.kind === 'user') return 'P0';
  switch (item.source) {
    case 'ceo-ingress': return 'P0';
    case 'capsule-done': return (item.capsuleFailed ?? 0) > 0 ? 'P0' : 'related';
    case 'harness-child':
    case 'sidetab': return 'related';
    case 'graph-node': return 'P1';
    case 'event-watch':
    case 'seat-mail-guide': return 'P2';
    case 'seat-mail': {
      if (item.replyTo !== undefined && waits.replyTo.has(item.replyTo)) return 'related';
      if (item.mailClass) return item.mailClass;
      // A seat-mail notice without a ledger class (a plan item) is the seat's own work queue — it waits like a request.
      return item.passive === true ? 'P2' : 'P1';
    }
    default: return 'P1';
  }
}

/**
 * OP-INBOX-PULSE-BATCH — the OP seat's class: P0 stays P0 (plus mail kind `release-stop`); everything else that would
 * open a turn by itself (P1 mail · graph-node stall · related reply) becomes P2 and waits for the pulse batch.
 * Own capsule/child results and non-mail sources keep their class.
 */
export function classifyOpBatchItem(item: QueueClassItem, waits: WorkWaits = NO_WAITS): QueueHoldClass {
  if (item.source === 'seat-mail' && (item.mailKind ?? '').toLowerCase() === RELEASE_STOP_MAIL_KIND) return 'P0';
  const base = classifyQueueItem(item, waits);
  if (base === 'P0') return 'P0';
  // OP-WAKE-COMMIT-BATCH — a due self-wake (and the work-pull / late-wake inbox) rides the pulse digest too.
  if (item.source === 'seat-mail' || item.source === 'graph-node' || item.source === 'scheduled-wake' || item.source === 'work-pull') return 'P2';
  return base;
}

export const isHoldable = (c: QueueHoldClass): boolean => c === 'P1' || c === 'P2';

const arrivedAt = (item: QueueClassItem): number | undefined => item.enqueuedAt ?? item.occurredAt;

/**
 * QUEUE-P1-3MIN — is this P1 due to join now? A decision joins at once (SEAT-STEER-PREEMPT keeps its step-boundary
 * preemption); a request after {@link QUEUE_P1_JOIN_AFTER_MS}; any P1 at once when no work is in progress.
 */
export function p1Ready(item: QueueClassItem, workInProgress: boolean, now: number): boolean {
  if (!workInProgress || item.mailIntent === 'decision') return true;
  const at = arrivedAt(item);
  return at === undefined || now - at >= QUEUE_P1_JOIN_AFTER_MS;
}

/** QUEUE-P1-3MIN — ms until a request P1 is due (0 = due now). */
export function p1DueInMs(item: QueueClassItem, workInProgress: boolean, now: number): number {
  if (p1Ready(item, workInProgress, now)) return 0;
  return Math.max(0, QUEUE_P1_JOIN_AFTER_MS - (now - arrivedAt(item)!));
}

export type MidTurnMailAction = { readonly kind: 'steer-now' } | { readonly kind: 'steer-at'; readonly inMs: number } | { readonly kind: 'held' };

/**
 * QUEUE-P1-3MIN — a mail arriving during a running turn. Not holding → the ordinary steer path (unchanged). P2 → held
 * (peeked by the next continuation). P1 → steer now when due (decision · 60 s waited), else steer when it falls due —
 * the steer joins at the next step boundary (after the running tool batch; a tool is never cut).
 */
export function midTurnMailAction(item: QueueClassItem, cls: QueueHoldClass, holding: boolean, now: number): MidTurnMailAction {
  if (!holding || (cls !== 'P1' && cls !== 'P2')) return { kind: 'steer-now' };
  if (cls === 'P2') return { kind: 'held' };
  const inMs = p1DueInMs(item, true, now);
  return inMs === 0 ? { kind: 'steer-now' } : { kind: 'steer-at', inMs };
}

export type IdleQueueDecision =
  /** Nothing to hold — the ordinary dispatch runs unchanged. */
  | { readonly kind: 'pass' }
  /** Ordinary dispatch, but only the non-held items leave (a P0 or related item starts / a person's line). */
  | { readonly kind: 'pass-unheld'; readonly heldIds: readonly string[] }
  /** Work is in progress: open the continuation first; the listed items stay queued. */
  | { readonly kind: 'continue'; readonly heldIds: readonly string[] }
  /** Keep holding: the continuation was opened and has not started yet, or the mail-turn gap is still open. */
  | { readonly kind: 'hold'; readonly heldIds: readonly string[]; readonly reason: 'continuation-starting' | 'coalescing' | 'flush-limit' | 'info-only' | 'pulse-batch' }
  /** QUEUE-P1-3MIN: these P1 items go now (P2 stays held); `paused` = the open work pauses and resumes after. */
  | { readonly kind: 'deliver-p1'; readonly ids: readonly string[]; readonly paused: boolean; readonly heldIds: readonly string[] }
  /** Held mail goes now — one digest turn, P1 first. */
  | { readonly kind: 'release'; readonly reason: 'work-done' | 'no-progress' | 'starvation' | 'continuation-not-started' | 'idle-stall' | 'pulse' | 'action-due' | 'overflow' };

export interface IdleQueueInput {
  readonly items: readonly QueueClassItem[];
  readonly waits: WorkWaits;
  readonly workInProgress: boolean;
  /** Continuations opened while mail was held (reset when the held mail is released or the work ends). */
  readonly continuationsWhileHolding: number;
  /** When the last continuation was opened and has not started yet; null = none pending. */
  readonly awaitingStartSince: number | null;
  /** The continuation for this turn end was already tried (one try per turn end). */
  readonly continuationTried: boolean;
  /** When the last mail-triggered (notice) turn was dispatched; null = none yet. */
  readonly lastMailTurnAt?: number | null;
  /** PASSIVE-HOLD-WHILE-BUSY — a seat holds mail only while busy: idle with no open work = release now (no coalescing gap). */
  readonly holdOnlyWhileBusy?: boolean;
  /** OP-INBOX-PULSE-BATCH: this is the OP seat — hold everything but P0 until the pulse (or 30 min). */
  readonly opBatch?: boolean;
  /** OP-INBOX-PULSE-BATCH: a pulse turn opened since the last release — the batch goes now. */
  readonly pulseDue?: boolean;
  readonly now: number;
}

/**
 * 판정식 — pure. In order:
 *   1. nothing holdable queued → pass (ordinary dispatch, unchanged);
 *   2. a P1 is due (no work open · decision · waited ≥ 60 s · ≥ 3 min cap) → deliver-p1 (only the due P1s; P2 stays held;
 *      open work pauses with a checkpoint and resumes after — QUEUE-P1-3MIN);
 *   3. work in progress ∧ continuations-while-holding ≥ 3 → release(no-progress);
 *   4. some held P2 waited ≥ 20 min → release(starvation);
 *   5. no work in progress: the last mail turn < 5 min ago → hold(coalescing) (P2 only; a P0 still passes alone), else release(work-done);
 *   6. a P0 (person · CEO · alert · failed capsule) queued → pass-unheld (it starts; held mail stays queued);
 *   7. continuation opened, not started: < 15 s → hold(continuation-starting), else release(continuation-not-started);
 *   8. continuation already tried this turn end → release(continuation-not-started);
 *   9. else → continue (open the continuation first; held mail waits and is peeked).
 */
export function decideIdleQueue(input: IdleQueueInput): IdleQueueDecision {
  if (input.opBatch) return decideOpBatch(input);
  const classed = input.items.map((item) => ({ item, cls: classifyQueueItem(item, input.waits) }));
  const held = classed.filter((c) => isHoldable(c.cls));
  if (held.length === 0) return { kind: 'pass' };
  const heldIds = held.map((c) => c.item.id);
  const dueP1 = held.filter((c) => c.cls === 'P1' && p1Ready(c.item, input.workInProgress, input.now)).map((c) => c.item.id);
  if (dueP1.length > 0) {
    return { kind: 'deliver-p1', ids: dueP1, paused: input.workInProgress, heldIds: heldIds.filter((id) => !dueP1.includes(id)) };
  }
  if (input.workInProgress && input.continuationsWhileHolding >= QUEUE_HOLD_CONTINUATION_CAP) return { kind: 'release', reason: 'no-progress' };
  const starved = held.some(({ item, cls }) => {
    const at = arrivedAt(item);
    return at !== undefined && input.now - at >= (cls === 'P1' ? QUEUE_HOLD_P1_MAX_MS : QUEUE_HOLD_P2_MAX_MS);
  });
  if (starved) return { kind: 'release', reason: 'starvation' };
  const p0 = classed.some((c) => c.cls === 'P0');
  if (!input.workInProgress) {
    const last = input.lastMailTurnAt ?? null;
    if (input.holdOnlyWhileBusy) {
      // Idle flush: rate-limited and only for something that is not plain info (starvation above still releases at 20 min).
      if (!p0 && !held.some(({ item, cls }) => flushWorthy(item, cls))) return { kind: 'hold', heldIds, reason: 'info-only' };
      if (!p0 && last !== null && input.now - last < IDLE_FLUSH_MIN_GAP_MS) return { kind: 'hold', heldIds, reason: 'flush-limit' };
    }
    if (!input.holdOnlyWhileBusy && last !== null && input.now - last < QUEUE_MAIL_TURN_MIN_GAP_MS) return p0 ? { kind: 'pass-unheld', heldIds } : { kind: 'hold', heldIds, reason: 'coalescing' };
    return { kind: 'release', reason: 'work-done' };
  }
  if (p0) return { kind: 'pass-unheld', heldIds };
  if (input.awaitingStartSince !== null) {
    return input.now - input.awaitingStartSince >= QUEUE_HOLD_START_GRACE_MS
      ? { kind: 'release', reason: 'continuation-not-started' }
      : { kind: 'hold', heldIds, reason: 'continuation-starting' };
  }
  if (input.continuationTried) return { kind: 'release', reason: 'continuation-not-started' };
  return { kind: 'continue', heldIds };
}

/**
 * OP-INBOX-PULSE-BATCH 판정식 — pure. nothing held → pass · pulse opened → release(pulse) · some held mail waited ≥ 30 min →
 * release(starvation) · ≥ {@link OP_BATCH_HELD_CAP} held → release(overflow) · a P0 queued → pass-unheld · actionable mail
 * waited ≥ 60 s with no open-work turn due, or ≥ 3 min → release(action-due) · open work, continuation not tried →
 * continue (peek) · else hold.
 */
function decideOpBatch(input: IdleQueueInput): IdleQueueDecision {
  const classed = input.items.map((item) => ({ item, cls: classifyOpBatchItem(item, input.waits) }));
  const held = classed.filter((c) => isHoldable(c.cls));
  if (held.length === 0) return { kind: 'pass' };
  const heldIds = held.map((c) => c.item.id);
  if (input.pulseDue) return { kind: 'release', reason: 'pulse' };
  const waited = (item: QueueClassItem): number => { const at = arrivedAt(item); return at === undefined ? 0 : input.now - at; };
  if (held.some(({ item }) => waited(item) >= OP_BATCH_MAX_HOLD_MS)) return { kind: 'release', reason: 'starvation' };
  // OP-BATCH-IDLE-DUE — bounded: a flood never piles up past the cap waiting for a pulse that may not come.
  if (held.length >= OP_BATCH_HELD_CAP) return { kind: 'release', reason: 'overflow' };
  if (classed.some((c) => c.cls === 'P0')) return { kind: 'pass-unheld', heldIds };
  const actionWait = held.filter(({ item }) => opBatchActionable(item, input.waits)).reduce((max, { item }) => Math.max(max, waited(item)), -1);
  const openWorkHasTurn = input.workInProgress && input.awaitingStartSince === null && !input.continuationTried;
  // Actionable mail: 60 s on an idle OP (no open work, or the continuation had its try); 3 min cap even with open work.
  if (actionWait >= OP_BATCH_ACTION_MAX_MS || (actionWait >= OP_BATCH_ACTION_IDLE_MS && !openWorkHasTurn)) return { kind: 'release', reason: 'action-due' };
  if (openWorkHasTurn) return { kind: 'continue', heldIds };
  return { kind: 'hold', heldIds, reason: 'pulse-batch' };
}

/**
 * OP-BATCH-IDLE-DUE — held mail that needs OP's action, from structured fields only: a seat mail whose base class is P1
 * (request · decision) or whose intent is flush-worthy (question · result), and whose ledger kind is not `notice`
 * (bulletins and waker lines ride the pulse). Scheduled wakes, work-pull and graph-node stalls keep riding the pulse.
 */
export function opBatchActionable(item: QueueClassItem, waits: WorkWaits = NO_WAITS): boolean {
  if (item.source !== 'seat-mail' || (item.mailKind ?? '').toLowerCase() === 'notice') return false;
  return classifyQueueItem(item, waits) === 'P1' || FLUSH_WORTHY_INTENTS.has((item.mailIntent ?? '').toLowerCase());
}

/**
 * IDLE-WITH-QUEUE (대표 11-25 16:0x «Queue 20 · 📩 14 held» with the pane idle) — the «typeahead» the internal-turn gate
 * yields to is a PERSON's queued line only. Counting every queued item (seat-mail notices held by this leaf included)
 * refused every self wake / goal continuation as HumanTyping while the held mail waited for that continuation: a deadlock
 * that only a person's keystroke broke. Notices never count — the idle door dispatches them.
 */
export function personQueuedCount(items: readonly Pick<QueueClassItem, 'kind'>[]): number {
  return items.filter((item) => item.kind === 'user').length;
}

/** Delivery order of a released digest: P1 before P2, arrival order kept inside a class. */
export function orderReleased<T extends QueueClassItem>(items: readonly T[], waits: WorkWaits = NO_WAITS, opBatch = false): T[] {
  const classOf = opBatch ? classifyOpBatchItem : classifyQueueItem;
  const rank = (c: QueueHoldClass): number => (c === 'P0' ? 0 : c === 'related' ? 1 : c === 'P1' ? 2 : 3);
  return items.map((item, index) => ({ item, index, r: rank(classOf(item, waits)) }))
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .map((x) => x.item);
}

/** One headline: `✉ #id from · intent · first 80 chars` — read from the digest line the producer built. */
export function peekLine(item: QueueClassItem): string {
  // digest = `#id · from · kind · body…` (seat-mail-digest.ts) — the structured line built at enqueue, not parsed meaning.
  const flat = (item.digest ?? `${item.source ?? 'notice'} · ${item.text}`).replace(/\s+/gu, ' ').trim();
  const parts = flat.split(' · ');
  const head = item.digest && parts.length >= 4 ? parts.slice(0, 3).join(' · ') : null;
  const body = head === null ? flat : parts.slice(3).join(' · ');
  const short = body.length <= 80 ? body : `${body.slice(0, 80)}…`;
  return `📩 ${head === null ? short : `${head} · ${short}`}`;
}

/**
 * The peek block a continuation carries while mail is held: every held mail is SEEN within one turn (headline only;
 * bodies stay deferred). Mail not peeked before is always listed (the «seen within one turn» guarantee); already
 * peeked mail fills up to {@link QUEUE_PEEK_MAX_LINES} lines, the rest is «+N more». Null when nothing is held.
 */
export function heldPeekBlock(held: readonly QueueClassItem[], alreadyPeeked: ReadonlySet<string> = new Set()): string | null {
  if (held.length === 0) return null;
  const fresh = held.filter((item) => !alreadyPeeked.has(item.id));
  const old = held.filter((item) => alreadyPeeked.has(item.id));
  const picked = [...fresh, ...old.slice(0, Math.max(0, QUEUE_PEEK_MAX_LINES - fresh.length))];
  const shown = picked.map(peekLine);
  const more = held.length > picked.length ? [`+${held.length - picked.length} more`] : [];
  return [`[held mail · ${held.length} waiting until this work finishes — headlines only; switch only if one changes the current work]`, ...shown, ...more].join('\n');
}

/** Full bodies of related mail joined to the continuation. Null when none. */
export function relatedJoinBlock(related: readonly QueueClassItem[]): string | null {
  if (related.length === 0) return null;
  return [`[joined to current work · ${related.length} related]`, ...related.map((item) => item.text)].join('\n\n');
}

/** Status chip while mail is held. Empty when nothing is held. */
export function heldChip(count: number): string {
  return count > 0 ? `📩 ${count} held` : '';
}

export interface QueueFinishFirstLog {
  (category: string, event: string, data: Record<string, unknown>): void;
}

/**
 * The per-TUI state around {@link decideIdleQueue}: work-in-progress from the last turn end, continuation accounting,
 * the waits of the current work, and once-per-item `held` logs.
 */
export function createQueueFinishFirst(deps: { now?: () => number; log?: QueueFinishFirstLog; holdOnlyWhileBusy?: boolean; opBatch?: boolean } = {}) {
  const opBatch = deps.opBatch === true;
  const classOf = (item: QueueClassItem, w: WorkWaits): QueueHoldClass => (opBatch ? classifyOpBatchItem(item, w) : classifyQueueItem(item, w));
  let pulseDue = false;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let workInProgress = false;
  let continuationsWhileHolding = 0;
  let awaitingStartSince: number | null = null;
  let continuationTried = false;
  let waits: WorkWaits = NO_WAITS;
  const loggedHeld = new Set<string>();
  let heldNow = 0;
  /** Held items that would open a turn by themselves (not passive info) — the stall watchdog does not count them. */
  let heldActionable = 0;
  let lastMailTurnAt: number | null = null;
  const peekedIds = new Set<string>();
  /** QUEUE-P1-3MIN: the open work a P1 paused — resumed by one continuation after the P1 turn. */
  let paused: { at: number } | null = null;
  let resumeDue = false;
  /** 11-25 OP deaf: the idle-stall watchdog saw the seat idle with held mail — the next decide releases it. */
  let forcedRelease = false;
  const input = (items: readonly QueueClassItem[]): IdleQueueInput =>
    ({ items, waits, workInProgress, continuationsWhileHolding, awaitingStartSince, continuationTried, lastMailTurnAt,
      ...(deps.holdOnlyWhileBusy ? { holdOnlyWhileBusy: true } : {}), ...(opBatch ? { opBatch: true, pulseDue } : {}), now: now() });

  const markHeld = (items: readonly QueueClassItem[], ids: readonly string[], reason: string): void => {
    heldNow = ids.length;
    const byId = new Map(items.map((item) => [item.id, item]));
    heldActionable = ids.filter((id) => byId.get(id)?.passive !== true).length;
    for (const id of ids) {
      if (loggedHeld.has(id)) continue;
      loggedHeld.add(id);
      const item = byId.get(id);
      if (!item) continue;
      const at = arrivedAt(item);
      log('tui.queue', 'held', { class: classOf(item, waits), waitedMs: at === undefined ? null : Math.max(0, now() - at),
        reason, itemId: id, ...(item.msgId === undefined ? {} : { msgId: item.msgId }) });
    }
  };

  return {
    /** Turn end: is the seat's own work still open (goal armed · requirement continuation due)? */
    noteTurnEnd(input: { workInProgress: boolean; waitingReplyTo?: readonly number[] }): void {
      // QUEUE-P1-3MIN — the P1 turn ended without its own open work: the paused work resumes (front of the line).
      if (paused !== null && !input.workInProgress) { resumeDue = true; }
      workInProgress = input.workInProgress || resumeDue;
      continuationTried = false;
      waits = { replyTo: new Set(input.waitingReplyTo ?? []) };
      if (!workInProgress) continuationsWhileHolding = 0;
    },
    /** A continuation turn was opened at an idle boundary (counted only while mail is held). */
    noteContinuationOpened(): void {
      continuationTried = true;
      awaitingStartSince = now();
      if (heldNow > 0) continuationsWhileHolding += 1;
    },
    /** The continuation attempt opened nothing. */
    noteContinuationTried(): void { continuationTried = true; },
    /** Any turn started — a pending continuation is no longer awaited. */
    noteTurnStarted(): void { awaitingStartSince = null; },
    /** A person's own turn: the work is theirs now; accounting restarts. */
    noteHumanTurn(): void { continuationsWhileHolding = 0; },
    decide(items: readonly QueueClassItem[]): IdleQueueDecision {
      const forced = forcedRelease && items.some((item) => isHoldable(classOf(item, waits)));
      forcedRelease = false;
      const decision: IdleQueueDecision = forced ? { kind: 'release', reason: 'idle-stall' } : decideIdleQueue(input(items));
      if (decision.kind === 'deliver-p1') {
        const byId = new Map(items.map((item) => [item.id, item]));
        for (const id of decision.ids) {
          const item = byId.get(id);
          const at = item ? arrivedAt(item) : undefined;
          log('tui.queue', 'p1-joined', { waitedMs: at === undefined ? null : Math.max(0, now() - at), boundary: 'idle', paused: decision.paused,
            itemId: id, ...(item?.msgId === undefined ? {} : { msgId: item.msgId }) });
          loggedHeld.delete(id);
        }
        if (decision.paused) paused ??= { at: now() };
        markHeld(items, decision.heldIds, 'work-in-progress');
      } else if (decision.kind === 'hold') markHeld(items, decision.heldIds, decision.reason === 'continuation-starting' ? 'work-in-progress' : decision.reason === 'pulse-batch' ? 'pulse-batch' : 'coalescing');
      else if (decision.kind === 'continue' || decision.kind === 'pass-unheld') markHeld(items, decision.heldIds, workInProgress ? 'work-in-progress' : 'coalescing');
      else if (decision.kind === 'release') {
        const count = heldNow || items.filter((item) => isHoldable(classOf(item, waits))).length;
        pulseDue = false;
        log('tui.queue', 'released', { reason: decision.reason, count, continuations: continuationsWhileHolding });
        heldNow = 0;
        heldActionable = 0;
        loggedHeld.clear();
        peekedIds.clear();
        continuationsWhileHolding = 0;
        workInProgress = false;
        awaitingStartSince = null;
      } else { heldNow = 0; heldActionable = 0; }
      return decision;
    },
    /**
     * 11-25 OP deaf — the seat sat idle past the stall window with mail held: the next {@link decide} releases every
     * held item as one digest turn (reason `idle-stall`). Returns false when nothing is held (no-op).
     */
    forceRelease(): boolean {
      // OP-INBOX-PULSE-BATCH: an idle OP is not a stall — the batch waits for the pulse (30-min cap still releases).
      if (heldNow === 0 || opBatch) return false;
      forcedRelease = true;
      log('tui.queue', 'idle-stall-release', { held: heldNow });
      return true;
    },
    /** Is mail held right now (mid-turn steer gate)? */
    holding(): boolean { return workInProgress || opBatch; },
    /** OP-INBOX-PULSE-BATCH: the op-pulse turn opened — the next idle boundary releases the held batch as one turn. */
    notePulse(): void {
      if (!opBatch) return;
      pulseDue = true;
      log('tui.queue', 'pulse-batch-due', { held: heldNow });
    },
    opBatch(): boolean { return opBatch; },
    heldCount(): number { return heldNow; },
    heldActionableCount(): number { return heldActionable; },
    waits(): WorkWaits { return waits; },
    classify(item: QueueClassItem): QueueHoldClass { return classOf(item, waits); },
    /** A mail-triggered (notice) turn was dispatched — the coalescing gap starts. */
    noteMailTurn(): void { lastMailTurnAt = now(); },
    /** The idle timer asks: would the door do something other than keep holding (release · starvation · gap closed)? */
    releaseDue(items: readonly QueueClassItem[]): boolean {
      if (heldNow === 0) return false;
      return decideIdleQueue(input(items)).kind !== 'hold';
    },
    /** Extras for a continuation prompt: related full bodies + held peek. */
    continuationExtras(items: readonly QueueClassItem[]): { suffix: string; relatedIds: string[]; peeked: number; heldIds: string[] } {
      const related = items.filter((item) => item.kind === 'notice' && classOf(item, waits) === 'related');
      const held = items.filter((item) => isHoldable(classOf(item, waits)));
      const blocks = [relatedJoinBlock(related), heldPeekBlock(orderReleased(held, waits, opBatch), peekedIds)].filter((b): b is string => b !== null);
      return { suffix: blocks.length ? `\n\n${blocks.join('\n\n')}` : '', relatedIds: related.map((item) => item.id), peeked: held.length,
        heldIds: held.map((item) => item.id) };
    },
    /** QUEUE-P1-3MIN: a P1 joined the running turn at a step boundary (steer) — observed with its wait. */
    noteP1Steered(item: QueueClassItem): void {
      const at = arrivedAt(item);
      log('tui.queue', 'p1-joined', { waitedMs: at === undefined ? null : Math.max(0, now() - at), boundary: 'step',
        itemId: item.id, ...(item.msgId === undefined ? {} : { msgId: item.msgId }) });
    },
    /** QUEUE-P1-3MIN: the paused work is due to resume (the P1 turn ended without open work of its own). */
    resumePending(): boolean { return resumeDue && paused !== null; },
    /** QUEUE-P1-3MIN: the resume continuation opened — the pause is over. */
    noteResumed(turnId?: string): void {
      if (paused === null) return;
      log('tui.queue', 'resumed', { checkpoint: 'model-recorded', pausedMs: Math.max(0, now() - paused.at), ...(turnId ? { turnId } : {}) });
      resumeDue = false;
      paused = null;
    },
    /** The continuation carrying a peek opened — those ids count as seen (they are listed only as «old» next time). */
    notePeeked(ids: readonly string[]): void { for (const id of ids) peekedIds.add(id); },
  };
}

export type QueueFinishFirst = ReturnType<typeof createQueueFinishFirst>;
