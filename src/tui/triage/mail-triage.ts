/**
 * MAIL-TRIAGE-TASKQUEUE (0.3.36 P0 · owner: «메시지 도착을 보고 taskqueue 에 바로 트리아지 · 쏟아지는 메시지를 우아하게»).
 *
 * S: every seat mail became its own notice and, most of the time, its own turn — status deltas and repeats included.
 * C: a burst of mail should land as a short list of tasks, one per subject (PR · cell · thread), each closed by a result.
 * Q: how do we sort arrivals without an LLM call and without reading the prose?
 * A: from STRUCTURED fields only (kind · intent · crownDirective · origin · refs · replyTo · supersedes · result ·
 *    doneWhen · deadlineAt). Only a mail with none of them goes to the (injected) cheap model classifier.
 *
 * Classes:
 *   A answer-needed  — someone waits for this seat's answer: a ✋ HandRaise (`block:` ref) or what MSG-WAIT-CONTRACT
 *                      calls answer-expected (question · ask · decision kind · decision intent). Hook point only: the
 *                      ✋ ladder / question gate own its closing rule, not this module.
 *   B action-needed  — a request · alert · work order · a mail with a done-condition or deadline.
 *   C info/announce  — explicit info kinds (notice included) and announces, and every mail with no structured signal:
 *                      batched into one digest every 10 min (announce still needs its «적용:» reply — the digest says so).
 *   D duplicate/delta — supersedes · a result-carrying reply · a status kind for a subject that is already open · a repeat
 *                      from the same sender on the same subject (or with the same body) inside 10 min, kind-less included.
 *                      Merged into the open task; never costs a turn.
 *   E CEO-level      — a crown directive or crown delegation.
 *
 * 세 얼굴:
 *   관측 = `mail.triage {msgId, class, key, merged, signal}` per arrival · `mail.triage-digest {items}` per digest ·
 *          `mail.triage-close {key, event}` per close.
 *   인지 = classify → key → merge by key; a task closes only on a result event (never on `seen`).
 *   수복과 인계 = an unknown mail is never dropped: it waits passive in the digest (SEAT-MAIL-PASSIVE-DEFAULT — whether a
 *          mail opens a turn is seat-mail-turn-policy.ts's call); a wired model may promote it to a turn, never demote.
 *
 * Pure module: no queue, no ledger, no timers — the clock and the log sink are injected.
 */

import { createHash } from 'node:crypto';
import { seatMailRoute, type SeatMailRoute, type SeatMailRouteReason } from '../seat-mail-turn-policy.js';

export type MailTriageClass = 'A' | 'B' | 'C' | 'D' | 'E';
/** Where the class came from: structured fields · the cheap model · the provisional default (model pending/absent). */
export type MailTriageSignal = 'structured' | 'model' | 'default';

/** One arrival as the triage reads it — structured ledger fields only (the body is carried, never parsed). */
export interface MailTriageInput {
  readonly msgId: number;
  readonly from: string;
  readonly kind?: string | null;
  readonly intent?: string | null;
  readonly crownDirective?: string | null;
  readonly origin?: { readonly kind?: string; readonly delegatedByCrown?: boolean } | null;
  readonly replyTo?: number | null;
  readonly refs?: readonly string[] | null;
  readonly correlationId?: string | null;
  readonly supersedes?: number | null;
  /** The ELS-ORCH result envelope state when the mail carries one. */
  readonly resultState?: 'done' | 'failed' | null;
  readonly doneWhen?: string | null;
  readonly deadlineAt?: string | null;
  readonly body?: string;
  /** SEAT-MAIL-PASSIVE-DEFAULT — router inputs: needs-reply flag · ledger priority · sender above the recipient on the ladder. */
  readonly needsAck?: boolean | null;
  readonly priority?: number | null;
  readonly senderAbove?: boolean | null;
  /** SEAT-TURN-FOLLOWUPS ② — replyTo is our mail · a cell ref names a cell this seat owns/assigned. */
  readonly replyToOwn?: boolean | null;
  readonly cellDelegated?: boolean | null;
}

/** Transport kinds that only inform (the seat-mail digest's info kinds plus announce/coordination reports). */
export const TRIAGE_INFO_KINDS: readonly string[] = ['info', 'ack', 'receipt', 'receipts', 'retro', 'retro-report', 'announce', 'coord', 'fyi', 'status', 'report', 'progress', 'heartbeat', 'notice'];
/** Kinds that are a status delta when their subject is already an open task. */
export const TRIAGE_STATUS_KINDS: readonly string[] = ['status', 'progress', 'heartbeat', 'receipt', 'receipts', 'ack'];
/** Kinds that ask for work. */
export const TRIAGE_ACTION_KINDS: readonly string[] = ['request', 'task', 'work-order', 'interrupt', 'alert', 'approval', 'urgent'];
/** Kinds that ask a question someone waits on. */
export const TRIAGE_QUESTION_KINDS: readonly string[] = ['question', 'ask', 'decision'];

/** C items are folded into one digest item at most this often (SEAT-MAIL-PASSIVE-DEFAULT: 10 min, the queue's passive window). */
export const MAIL_TRIAGE_DIGEST_MS = 10 * 60_000;
/** A repeat from the same sender on the same subject (or with the same body) inside this window merges as D. */
export const MAIL_TRIAGE_DUP_WINDOW_MS = 10 * 60_000;

const lower = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');
/** Body identity for the duplicate merge (equality only — the body is never parsed). */
const bodyHash = (body: string): string => createHash('sha256').update(body.replace(/\s+/gu, ' ').trim()).digest('hex').slice(0, 16);

/** The first ref with this prefix (`pr:40036` → `40036`), case-insensitive on the prefix. */
function refValue(refs: readonly string[] | null | undefined, prefixes: readonly string[]): string | null {
  for (const ref of refs ?? []) {
    const text = ref.trim();
    for (const prefix of prefixes) {
      if (text.toLowerCase().startsWith(prefix) && text.length > prefix.length) return text.slice(prefix.length).trim();
    }
  }
  return null;
}

/**
 * The subject key, from structured fields in this order: PR (`pr:<n>` · `pr#<n>`) · cell (`cell:<ID>`) · needs-human
 * block (`block:<id>`) · announce (`announce:<id>`) · correlation id · the replied-to mail's key (when known) or
 * `thread:<replyTo>` · otherwise the mail itself (`msg:<id>`).
 */
export function mailTriageKey(input: MailTriageInput, keyOfMsg?: (msgId: number) => string | undefined): string {
  const pr = refValue(input.refs, ['pr:', 'pr#']);
  if (pr && /^\d+$/u.test(pr.replace(/^#/u, ''))) return `pr:${pr.replace(/^#/u, '')}`;
  const cell = refValue(input.refs, ['cell:']);
  if (cell) return `cell:${cell.toUpperCase()}`;
  const block = refValue(input.refs, ['block:']);
  if (block) return `block:${block}`;
  const announce = refValue(input.refs, ['announce:']);
  if (announce) return `announce:${announce}`;
  if (input.correlationId && input.correlationId.trim()) return `corr:${input.correlationId.trim()}`;
  if (typeof input.replyTo === 'number' && input.replyTo > 0) return keyOfMsg?.(input.replyTo) ?? `thread:${input.replyTo}`;
  return `msg:${input.msgId}`;
}

/**
 * Deterministic class from structured fields. `null` = no structured signal (the model decides). `subjectOpen` says
 * whether the mail's key is already an open task (a status kind for an open subject is a delta, not news).
 */
export function classifyMailStructured(input: MailTriageInput, subjectOpen = false): MailTriageClass | null {
  const kind = lower(input.kind);
  const intent = lower(input.intent);
  if (input.crownDirective || input.origin?.delegatedByCrown) return 'E';
  if (typeof input.supersedes === 'number' && input.supersedes > 0) return 'D';
  if (input.resultState) return 'D';
  if (refValue(input.refs, ['block:']) !== null || intent === 'decision' || TRIAGE_QUESTION_KINDS.includes(kind)) return 'A';
  if (intent === 'request' || intent === 'alert' || TRIAGE_ACTION_KINDS.includes(kind) || input.doneWhen || input.deadlineAt) return 'B';
  if (subjectOpen && TRIAGE_STATUS_KINDS.includes(kind)) return 'D';
  // A kind-less mail reads as intent info by ledger default — that default is not a signal (it must not silence an ask).
  if (TRIAGE_INFO_KINDS.includes(kind)) return 'C';
  return null;
}

/** Result events — the only things that close a task. `seen` is deliberately not one of them. */
export type MailTriageResultEvent =
  | { type: 'reply-sent'; msgId?: number }
  | { type: 'pr-landed'; pr?: number }
  | { type: 'decision-recorded'; decisionId?: string }
  | { type: 'capsule-result'; taskId: string; status: 'done' | 'failed' | 'ttl-killed' | 'token-cap' }
  | { type: 'result-mail'; msgId: number; state: 'done' | 'failed' };
export type MailTriageResultType = MailTriageResultEvent['type'];
const RESULT_TYPES: ReadonlySet<string> = new Set<MailTriageResultType>(['reply-sent', 'pr-landed', 'decision-recorded', 'capsule-result', 'result-mail']);

export interface MailTriageTask {
  readonly key: string;
  cls: MailTriageClass;
  signal: MailTriageSignal;
  status: 'open' | 'closed';
  readonly msgIds: number[];
  readonly firstAt: number;
  lastAt: number;
  /** How many arrivals were merged into this task after the first. */
  merged: number;
  /** The sender of the last arrival (duplicate merge: same subject ⊕ same sender inside the window). */
  lastFrom?: string;
  closedBy?: MailTriageResultEvent;
  /** The short-lane capsule working this task, if one was dispatched. */
  capsuleTaskId?: string;
}

export interface MailTriageVerdict {
  readonly msgId: number;
  readonly cls: MailTriageClass;
  readonly key: string;
  readonly merged: boolean;
  readonly signal: MailTriageSignal;
  /** False = this arrival must not open a turn of its own (D merged into an open task · passive mail waiting for the digest). */
  readonly costsTurn: boolean;
  /** SEAT-MAIL-PASSIVE-DEFAULT — the router's decision for this arrival before merging (seat-mail-turn-policy.ts). */
  readonly route: SeatMailRoute;
  readonly routeReason: SeatMailRouteReason;
  readonly task: MailTriageTask;
}

export interface MailTriageDigest {
  readonly key: string;
  readonly msgIds: readonly number[];
  readonly text: string;
}

/** The cheap model classifier for mail with no structured signal. Its answer replaces the provisional B. */
export type MailTriageModel = (input: MailTriageInput) => Promise<MailTriageClass | null>;

export interface MailTriageLedgerOptions {
  readonly now?: () => number;
  readonly log?: (event: 'mail.triage' | 'mail.triage-digest' | 'mail.triage-close' | 'mail.triage-reclass', data: Record<string, unknown>) => void;
  /**
   * The cheap classifier for mail with no structured signal. It runs BEFORE any turn: such mail is passive by default (it
   * waits for the digest), and the model can only promote it — `onPromote` fires when it answers A/B/E so the caller can
   * open the turn. No model = rule-based only (the passive default stands).
   */
  readonly model?: MailTriageModel;
  readonly onPromote?: (task: MailTriageTask, input: MailTriageInput) => void;
  /** Called for every A verdict — the NEED-HUMAN reply gate attaches here (this module never closes A by itself). */
  readonly onAnswerNeeded?: (verdict: MailTriageVerdict) => void;
  readonly digestMs?: number;
}

export interface MailTriageLedger {
  ingest(input: MailTriageInput): MailTriageVerdict;
  /** Close the task for `key` on a result event. Returns false (and closes nothing) for anything else, `seen` included. */
  close(key: string, event: MailTriageResultEvent | { type: string }): boolean;
  /** Close by a mail id that belongs to a task (a reply to one of its mails). */
  keyOfMsg(msgId: number): string | undefined;
  task(key: string): MailTriageTask | undefined;
  open(): readonly MailTriageTask[];
  /** The digest item when C mail has waited for the digest window; null otherwise (or when nothing waits). */
  takeDigest(force?: boolean): MailTriageDigest | null;
  attachCapsule(key: string, taskId: string): void;
  /** Resolves when every pending model classification settled (tests · shutdown). */
  settled(): Promise<void>;
}

const CLASS_LABEL: Record<MailTriageClass, string> = { A: 'answer needed', B: 'action needed', C: 'info', D: 'update', E: 'CEO-level' };
export function mailTriageClassLabel(cls: MailTriageClass): string { return CLASS_LABEL[cls]; }

export function createMailTriageLedger(options: MailTriageLedgerOptions = {}): MailTriageLedger {
  const now = options.now ?? Date.now;
  const digestMs = options.digestMs ?? MAIL_TRIAGE_DIGEST_MS;
  const tasks = new Map<string, MailTriageTask>();
  const msgKey = new Map<number, string>();
  const digestWaiting: Array<{ msgId: number; from: string; kind: string; key: string; body: string }> = [];
  let digestSince: number | null = null;
  let digestSerial = 0;
  const pending = new Set<Promise<void>>();
  const bodySeen = new Map<string, { key: string; at: number }>();
  const log = (event: Parameters<NonNullable<MailTriageLedgerOptions['log']>>[0], data: Record<string, unknown>): void => {
    try { options.log?.(event, data); } catch { /* observation never breaks triage */ }
  };

  const keyOfMsg = (msgId: number): string | undefined => msgKey.get(msgId);

  const reclassify = (task: MailTriageTask, input: MailTriageInput): void => {
    const model = options.model;
    if (!model) return;
    const run = model(input).then((cls) => {
      if (!cls || task.status === 'closed' || task.signal !== 'default') return;
      const before = task.cls;
      task.cls = cls;
      task.signal = 'model';
      log('mail.triage-reclass', { msgId: input.msgId, key: task.key, before, class: cls });
      if (cls === 'A' || cls === 'B' || cls === 'E') { try { options.onPromote?.(task, input); } catch { /* the hook never breaks triage */ } }
    }, () => { /* model failure keeps the provisional class */ });
    const tracked = run.finally(() => { pending.delete(tracked); });
    pending.add(tracked);
  };

  return {
    ingest(input) {
      const at = now();
      let key = mailTriageKey(input, keyOfMsg);
      // Duplicate without a subject key: the same sender with the same body inside the window joins the first one's task.
      const dupKey = `${input.from.trim().toUpperCase()}|${bodyHash(input.body ?? '')}`;
      const seenBody = input.body ? bodySeen.get(dupKey) : undefined;
      if (key === `msg:${input.msgId}` && seenBody && at - seenBody.at <= MAIL_TRIAGE_DUP_WINDOW_MS && tasks.get(seenBody.key)?.status === 'open') key = seenBody.key;
      const existing = tasks.get(key);
      const open = existing?.status === 'open';
      // Same subject ⊕ same sender inside the window = a repeat (any kind, kind-less included).
      const repeat = open && existing!.lastFrom === input.from && at - existing!.lastAt <= MAIL_TRIAGE_DUP_WINDOW_MS;
      const structuredRaw = classifyMailStructured(input, open);
      const structured: MailTriageClass | null = repeat && (structuredRaw === null || structuredRaw === 'C') ? 'D' : structuredRaw;
      const signal: MailTriageSignal = structured === null ? 'default' : 'structured';
      // No structured signal = passive (C) until the model (if any) promotes it — never a provisional turn.
      const cls: MailTriageClass = structured ?? 'C';
      const routed = seatMailRoute({ kind: input.kind ?? null, intent: input.intent ?? null, crownDirective: input.crownDirective ?? null,
        origin: input.origin ?? null, refs: input.refs ?? null, replyTo: input.replyTo ?? null, resultState: input.resultState ?? null,
        needsAck: input.needsAck ?? null, priority: input.priority ?? null, doneWhen: input.doneWhen ?? null, deadlineAt: input.deadlineAt ?? null,
        senderAbove: input.senderAbove ?? null, replyToOwn: input.replyToOwn ?? null, cellDelegated: input.cellDelegated ?? null,
        ...(input.body === undefined ? {} : { body: input.body }) });
      let task: MailTriageTask;
      let merged = false;
      if (existing && open) {
        task = existing;
        merged = true;
        task.msgIds.push(input.msgId);
        task.lastAt = at;
        task.lastFrom = input.from;
        task.merged += 1;
        if (cls === 'E' || cls === 'A') task.cls = cls; // escalation wins
        else if (cls !== 'D' && task.cls === 'C') task.cls = cls; // info subject that now asks for work
      } else {
        task = { key, cls, signal, status: 'open', msgIds: [input.msgId], firstAt: at, lastAt: at, merged: 0, lastFrom: input.from };
        tasks.set(key, task);
      }
      msgKey.set(input.msgId, key);
      if (input.body) {
        if (bodySeen.size > 512) for (const [k, v] of bodySeen) if (at - v.at > MAIL_TRIAGE_DUP_WINDOW_MS) bodySeen.delete(k);
        bodySeen.set(dupKey, { key, at });
      }
      // A result-carrying mail is itself a result event for its subject.
      if (input.resultState) {
        closeTask(task, { type: 'result-mail', msgId: input.msgId, state: input.resultState });
      }
      // D merged into an open subject is absorbed — except a failed result, which the seat must see.
      // A person's mail is never absorbed: their text always reaches a turn whole (TUI-LONG-PASTE-SPIN boundary).
      const absorbed = cls === 'D' && merged && input.resultState !== 'failed' && input.origin?.kind !== 'human' && routed.route === 'passive';
      if (cls === 'C' || (routed.route === 'passive' && !absorbed)) {
        if (digestSince === null) digestSince = at;
        digestWaiting.push({ msgId: input.msgId, from: input.from, kind: lower(input.kind) || '-', key, body: (input.body ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120) });
      }
      const costsTurn = !absorbed && routed.route === 'turn';
      const verdict: MailTriageVerdict = { msgId: input.msgId, cls, key, merged, signal, costsTurn, route: routed.route, routeReason: routed.reason, task };
      log('mail.triage', { msgId: input.msgId, class: cls, key, merged, signal, route: routed.route, reason: routed.reason, absorbed });
      if (signal === 'default' && !merged) reclassify(task, input);
      if (cls === 'A') { try { options.onAnswerNeeded?.(verdict); } catch { /* the hook never breaks triage */ } }
      return verdict;
    },
    close(key, event) {
      const task = tasks.get(key);
      if (!task || task.status === 'closed') return false;
      if (!RESULT_TYPES.has(event.type)) return false;
      closeTask(task, event as MailTriageResultEvent);
      return true;
    },
    keyOfMsg,
    task: (key) => tasks.get(key),
    open: () => [...tasks.values()].filter((task) => task.status === 'open'),
    takeDigest(force = false) {
      if (digestWaiting.length === 0 || digestSince === null) return null;
      if (!force && now() - digestSince < digestMs) return null;
      const items = digestWaiting.splice(0, digestWaiting.length);
      digestSince = null;
      digestSerial += 1;
      const announces = items.filter((item) => item.kind === 'announce');
      const lines = items.map((item) => `#${item.msgId} · ${item.from} · ${item.kind} · ${item.body}`);
      const text = [
        `[mail digest] ${items.length} info item${items.length === 1 ? '' : 's'} (batched every ${Math.round(digestMs / 60_000)} min)`,
        ...lines,
        ...(announces.length > 0 ? [`Announce: reply to each with one «적용:» line (${announces.map((item) => `#${item.msgId}`).join(' ')}).`] : []),
      ].join('\n');
      const digest: MailTriageDigest = { key: `digest:${digestSerial}`, msgIds: items.map((item) => item.msgId), text };
      log('mail.triage-digest', { key: digest.key, items: digest.msgIds.length, msgIds: digest.msgIds, announces: announces.length });
      return digest;
    },
    attachCapsule(key, taskId) {
      const task = tasks.get(key);
      if (task) task.capsuleTaskId = taskId;
    },
    async settled() { while (pending.size > 0) await Promise.all([...pending]); },
  };

  function closeTask(task: MailTriageTask, event: MailTriageResultEvent): void {
    task.status = 'closed';
    task.closedBy = event;
    log('mail.triage-close', { key: task.key, event: event.type, msgIds: task.msgIds });
  }
}

/** A ledger row → triage input (structured fields only). */
export function mailTriageInputOf(message: {
  id: number; from: string; body?: string; kind?: string | null; intent?: string | null; crownDirective?: string | null;
  origin?: { kind?: string; delegatedByCrown?: boolean } | null; replyTo?: number | null; refs?: readonly string[] | null;
  correlationId?: string | null; supersedes?: number | null; result?: { state: 'done' | 'failed' } | null;
  doneWhen?: string | null; deadlineAt?: string | null;
}): MailTriageInput {
  return {
    msgId: message.id, from: message.from,
    ...(message.body === undefined ? {} : { body: message.body }),
    kind: message.kind ?? null, intent: message.intent ?? null, crownDirective: message.crownDirective ?? null,
    origin: message.origin ?? null, replyTo: message.replyTo ?? null, refs: message.refs ?? null,
    correlationId: message.correlationId ?? null, supersedes: message.supersedes ?? null,
    resultState: message.result?.state ?? null, doneWhen: message.doneWhen ?? null, deadlineAt: message.deadlineAt ?? null,
  };
}
