// KIT mail-route · 우정 행정관 steward:mail — SHADOW (STEWARD-MAIL · FEDERATION-STEWARDS §5b · 0.3.39 P0)
//
// S 11-27 eln OP: 52–127 mails/h (24h 1,982 rows). The TUI router (seat-mail-turn-policy.ts) opened a turn for 1,192 of
//   1,808 triaged OP mails; 793 of those were «delegated-result» — a status/report reply to OP's own mail.
// C A turn per status reply is the «please reply» loop: OP asks, the hand answers, the answer wakes OP. Most of those
//   facts already sit in a ledger (board · PR · receipt) and a condition watch (COND-WATCH) carries the rest.
// Q Which mail must open a turn now, which can ride a 10-min digest, and which is only a record — without regex?
// A One verdict per mail from steward-mail.yaml: wake-now (✋ · 대표 · P0 · decision) · digest · record-only. Structured
//   fields first; Jev (Typesafe System One) only for mail whose fields cannot say «act now», and Jev only promotes.
//   SHADOW: nothing is routed by this module. It records «would have woken / would not» next to what the router did and
//   what OP did (answered within 30 min), and reports shadow agreement % and would-be OP wakes/h.
//
// 세 얼굴:
//   관측 = <state>/steward/mail-shadow.jsonl (one row per mail) ⊕ mail-shadow.json (last report) ⊕ `steward.mail.shadow`
//          log line per tick ⊕ `eln msg steward-shadow` (replay any window)
//   판단 근거 = steward-mail.yaml (verdict · reason · signal structured|jev) ⊕ the router's route ⊕ OP's reply
//   수복과 인계 = shadow only — a broken policy file is the built-in one; a Jev failure keeps the structured verdict.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import type { JevAnswer, JevQuestion, JevRequest, JevResponse } from '../../decide/jev.js';
import { seatMailRoute, type SeatMailRoute, type SeatMailRouteReason } from '../../tui/seat-mail-turn-policy.js';
import { isProxyLaneMail } from '../../msg/proxy-lane.js';

// ── policy ─────────────────────────────────────────────────────────────────────────────

export type StewardVerdict = 'wake-now' | 'digest' | 'record-only';
export type StewardReason =
  | 'crown' | 'hand' | 'p0' | 'decision' | 'hq-reason'
  | 'self' | 'duplicate' | 'ack' | 'ledger-fact'
  | 'status-reply' | 'routine-request' | 'info' | 'no-kind'
  | 'jev-wake';
export type StewardSignal = 'structured' | 'jev';

export interface StewardMailPolicy {
  readonly recipients: ReadonlySet<string>;
  readonly digestMs: number;
  readonly duplicateWindowMs: number;
  readonly answeredWithinMs: number;
  readonly wake: {
    readonly crown: boolean; readonly hand: boolean; readonly priorityAtLeast: number;
    readonly p0Kinds: ReadonlySet<string>; readonly decisionKinds: ReadonlySet<string>; readonly decisionIntents: ReadonlySet<string>;
    readonly hqReasons: ReadonlySet<string>;
  };
  readonly record: { readonly selfMail: boolean; readonly kinds: ReadonlySet<string>; readonly ledgerSenders: ReadonlySet<string>; readonly duplicates: boolean };
  readonly jev: { readonly askKinds: ReadonlySet<string>; readonly minProbability: number; readonly timeoutMs: number; readonly maxCallsPerTick: number; readonly choices: Readonly<Record<'wake' | 'digest' | 'record', string>> };
  readonly source: readonly string[];
  readonly problems: readonly string[];
}

const BUILTIN = join(import.meta.dir, 'steward-mail.yaml');
const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const upper = (v: unknown): string => (typeof v === 'string' ? v.trim().toUpperCase() : '');

function list(raw: unknown, map: (s: string) => string, where: string, problems: string[]): Set<string> {
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw)) { problems.push(`${where}: not a list`); return new Set(); }
  return new Set(raw.filter((v): v is string => typeof v === 'string').map(map));
}
function minutes(raw: unknown, fallback: number, where: string, problems: string[]): number {
  if (raw === undefined) return fallback * 60_000;
  if (typeof raw !== 'number' || !(raw > 0) || raw > 24 * 60) { problems.push(`${where}: minutes must be in (0, 1440]`); return fallback * 60_000; }
  return raw * 60_000;
}

/** Build the policy from one parsed document (built-in ⊕ override already merged). Pure. */
export function stewardMailPolicyFrom(doc: Record<string, unknown>, source: readonly string[] = []): StewardMailPolicy {
  const problems: string[] = [];
  const wake = (doc.wakeNow ?? {}) as Record<string, unknown>;
  const rec = (doc.recordOnly ?? {}) as Record<string, unknown>;
  const jev = (doc.jev ?? {}) as Record<string, unknown>;
  const choices = (jev.choices ?? {}) as Record<string, unknown>;
  const text = (k: 'wake' | 'digest' | 'record'): string => {
    const v = choices[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    problems.push(`jev.choices.${k}: missing`);
    return k;
  };
  const p = typeof jev.minProbability === 'number' && jev.minProbability > 0 && jev.minProbability <= 1 ? jev.minProbability : 0.7;
  return {
    recipients: list(doc.recipients ?? ['OP'], upper, 'recipients', problems),
    digestMs: minutes(doc.digestMinutes, 10, 'digestMinutes', problems),
    duplicateWindowMs: minutes(doc.duplicateWindowMinutes, 30, 'duplicateWindowMinutes', problems),
    answeredWithinMs: minutes(doc.answeredWithinMinutes, 30, 'answeredWithinMinutes', problems),
    wake: {
      crown: wake.crown !== false, hand: wake.hand !== false,
      priorityAtLeast: typeof wake.priorityAtLeast === 'number' ? wake.priorityAtLeast : 1,
      p0Kinds: list(wake.p0Kinds, lower, 'wakeNow.p0Kinds', problems),
      decisionKinds: list(wake.decisionKinds, lower, 'wakeNow.decisionKinds', problems),
      decisionIntents: list(wake.decisionIntents, lower, 'wakeNow.decisionIntents', problems),
      hqReasons: list(wake.hqReasons, upper, 'wakeNow.hqReasons', problems),
    },
    record: {
      selfMail: rec.selfMail === true,
      kinds: list(rec.kinds, lower, 'recordOnly.kinds', problems),
      ledgerSenders: list(rec.ledgerSenders, upper, 'recordOnly.ledgerSenders', problems),
      duplicates: rec.duplicates === true,
    },
    jev: {
      askKinds: list(jev.askKinds, lower, 'jev.askKinds', problems),
      minProbability: p,
      timeoutMs: typeof jev.timeoutSeconds === 'number' && jev.timeoutSeconds > 0 ? jev.timeoutSeconds * 1000 : 8_000,
      maxCallsPerTick: typeof jev.maxCallsPerTick === 'number' && jev.maxCallsPerTick >= 0 ? Math.floor(jev.maxCallsPerTick) : 30,
      choices: { wake: text('wake'), digest: text('digest'), record: text('record') },
    },
    source, problems,
  };
}

let cached: { key: string; policy: StewardMailPolicy } | null = null;

/** Built-in steward-mail.yaml ⊕ `<state>/msg/steward-mail.yaml` (top-level keys replace). Re-read when a file changes. */
export function readStewardMailPolicy(opts: { builtin?: string; override?: string } = {}): StewardMailPolicy {
  const builtin = opts.builtin ?? BUILTIN;
  const override = opts.override ?? join(elanousStateRoot(), 'msg', 'steward-mail.yaml');
  const stamp = (path: string): string => { try { return String(statSync(path).mtimeMs); } catch { return '-'; } };
  const key = `${builtin}@${stamp(builtin)}|${override}@${stamp(override)}`;
  if (cached?.key === key) return cached.policy;
  const read = (path: string): Record<string, unknown> | null => {
    try { const v = parseYaml(readFileSync(path, 'utf8')) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; }
    catch { return null; }
  };
  const base = read(builtin) ?? {};
  const over = read(override);
  const policy = stewardMailPolicyFrom({ ...base, ...(over ?? {}) }, over ? [builtin, override] : [builtin]);
  cached = { key, policy };
  return policy;
}

// ── one mail ───────────────────────────────────────────────────────────────────────────

/** A mail as the steward reads it — ledger fields only; the body is read by Jev and for repeat identity, never parsed. */
export interface StewardMail {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly createdAt: string;
  readonly kind?: string | null;
  readonly intent?: string | null;
  readonly needsAck?: boolean | null;
  readonly priority?: number | null;
  readonly crownDirective?: string | null;
  readonly originDelegated?: boolean | null;
  readonly fromKind?: string | null;
  readonly refs?: readonly string[] | null;
  readonly replyTo?: number | null;
  readonly correlationId?: string | null;
  readonly doneWhen?: string | null;
  readonly deadlineAt?: string | null;
  readonly resultState?: 'done' | 'failed' | null;
  readonly body: string;
  /** Sender of the mail this one replies to (from the ledger). */
  readonly replyToSender?: string | null;
  /** When the recipient replied to this mail (null = no reply). */
  readonly answeredAt?: string | null;
}

export interface StewardContext {
  /** The earlier mail this one repeats (same sender · kind · subject, or same body, inside the window). */
  readonly duplicateOf?: number | null;
}

export interface StewardDecision {
  readonly verdict: StewardVerdict;
  readonly reason: StewardReason;
  readonly signal: StewardSignal;
  /** True when the structured fields carry no «act now» signal and Jev may promote it. */
  readonly askJev: boolean;
}

const hasRef = (refs: readonly string[] | null | undefined, prefix: string): boolean => (refs ?? []).some(r => r.startsWith(prefix));
const refValues = (refs: readonly string[] | null | undefined, prefix: string): string[] =>
  (refs ?? []).filter(r => r.startsWith(prefix)).map(r => r.slice(prefix.length).trim().toUpperCase());

/**
 * The structured verdict. Pure. Order: crown · ✋ · self · P0 · decision · HQ reason · repeat · receipts · ledger echo · digest.
 * A repeat folds only news (digest/record), never a wake: a re-asked decision or P0 still wakes (11-28 replay: OP answered
 * the GUARDIAN re-asks, not the first ask).
 */
export function classifyStewardMail(mail: StewardMail, ctx: StewardContext, policy: StewardMailPolicy): StewardDecision {
  const kind = lower(mail.kind);
  const intent = lower(mail.intent);
  const from = upper(mail.from);
  const to = upper(mail.to);
  const d = (verdict: StewardVerdict, reason: StewardReason, askJev = false): StewardDecision => ({ verdict, reason, signal: 'structured', askJev });
  if (policy.wake.crown && (mail.crownDirective || mail.originDelegated || lower(mail.fromKind) === 'human' || isProxyLaneMail({ fromSeat: mail.from, refs: mail.refs ?? [] }))) return d('wake-now', 'crown');
  if (policy.wake.hand && hasRef(mail.refs, 'block:') && hasRef(mail.refs, 'reason:')) return d('wake-now', 'hand');
  if (policy.record.selfMail && from === to) return d('record-only', 'self');
  if ((typeof mail.priority === 'number' && mail.priority >= policy.wake.priorityAtLeast) || policy.wake.p0Kinds.has(kind)) return d('wake-now', 'p0');
  if (policy.wake.decisionIntents.has(intent) || policy.wake.decisionKinds.has(kind)) return d('wake-now', 'decision');
  if (refValues(mail.refs, 'reason:').some(r => policy.wake.hqReasons.has(r))) return d('wake-now', 'hq-reason');
  if (policy.record.duplicates && typeof ctx.duplicateOf === 'number') return d('record-only', 'duplicate');
  if (policy.record.kinds.has(kind)) return d('record-only', 'ack');
  if (policy.record.ledgerSenders.has(from)) return d('record-only', 'ledger-fact');
  const ask = policy.jev.askKinds.has(kind);
  if (typeof mail.replyTo === 'number' && mail.replyTo > 0 && upper(mail.replyToSender) === to) return d('digest', 'status-reply', ask);
  if (intent === 'request' || kind === 'request' || mail.needsAck === true || mail.doneWhen || mail.deadlineAt) return d('digest', 'routine-request', ask);
  return d('digest', kind === '' ? 'no-kind' : 'info', ask);
}

/**
 * The subject a repeat is measured on — structured and stable only: pr · cell · block · correlation · a bare topic tag ref
 * (`board-steward`). A thread or a valued ref (`steward:OP` · `run:<id>`) is NOT a subject: two replies in one thread, or
 * two exception cards from one steward, are different news (11-28 replay: 24 answered mails were folded by those keys).
 * No subject → only an identical body counts as a repeat.
 */
export function stewardSubject(mail: StewardMail): string | null {
  for (const prefix of ['pr:', 'cell:', 'block:']) {
    const v = (mail.refs ?? []).find(r => r.startsWith(prefix));
    if (v) return v.toLowerCase();
  }
  if (mail.correlationId) return `corr:${mail.correlationId}`;
  const tag = (mail.refs ?? []).find(r => !r.includes(':') && r.trim() !== '');
  return tag ? `tag:${tag.trim().toLowerCase()}` : null;
}

const bodyKey = (body: string): string => createHash('sha256').update(body.replace(/\s+/gu, ' ').trim()).digest('hex').slice(0, 16);

/** Repeat finder over mails in id order: returns, per mail id, the earlier mail it repeats (inside the window). */
export function findDuplicates(mails: readonly StewardMail[], windowMs: number): Map<number, number> {
  const out = new Map<number, number>();
  const seen = new Map<string, { id: number; at: number }>();
  for (const m of mails) {
    const at = Date.parse(m.createdAt);
    const subject = stewardSubject(m);
    const keys = [`body|${upper(m.from)}|${bodyKey(m.body)}`, ...(subject ? [`subj|${upper(m.from)}|${lower(m.kind)}|${subject}`] : [])];
    for (const k of keys) {
      const prev = seen.get(k);
      if (prev && at - prev.at <= windowMs && !out.has(m.id)) out.set(m.id, prev.id);
    }
    // the window slides from the first of a run, so a steady repeat every 10 min stays one wake per window
    for (const k of keys) { const prev = seen.get(k); if (!prev || at - prev.at > windowMs) seen.set(k, { id: m.id, at }); }
  }
  return out;
}

// ── Jev (unstructured only · promote only) ─────────────────────────────────────────────

export type StewardDecide = (req: JevRequest, signal: AbortSignal) => Promise<JevResponse>;
export const STEWARD_JEV_USAGE_SITE = 'mail-route.steward-mail';

export function stewardJevQuestion(policy: StewardMailPolicy): JevQuestion {
  return {
    type: 'choice',
    instructions: 'A coordinator seat received the mail in state. Does the coordinator have to act on it now, can it wait for a 10-minute digest, or is it only a record? Pick the description that fits.',
    criteria: { ...policy.jev.choices },
  };
}

/** Top word ⊕ probability → a promotion to wake-now (only `wake` at ≥ minProbability). */
export function jevPromotes(answer: JevAnswer | undefined, policy: StewardMailPolicy): { promote: boolean; word: string | null; p: number } {
  const probs = answer?.probabilities ?? (answer?.choice ? { [answer.choice]: 1 } : {});
  let word: string | null = null; let p = 0;
  for (const [w, v] of Object.entries(probs)) if (typeof v === 'number' && Number.isFinite(v) && v > p) { word = w.trim().toLowerCase(); p = v; }
  return { promote: word === 'wake' && p >= policy.jev.minProbability, word, p };
}

/** Ask Jev about one mail. Never throws: null = no answer (the structured verdict stands). */
export async function askStewardJev(mail: StewardMail, policy: StewardMailPolicy, decide: StewardDecide): Promise<{ promote: boolean; word: string | null; p: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.jev.timeoutMs);
  try {
    const state = { from: mail.from, kind: mail.kind ?? '', intent: mail.intent ?? '', refs: mail.refs ?? [], body: mail.body.replace(/\s+/gu, ' ').trim().slice(0, 700) };
    const response = await Promise.race([
      decide({ state, questions: { act: stewardJevQuestion(policy) } }, controller.signal),
      new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }); }),
    ]);
    return jevPromotes(response.answers?.act, policy);
  } catch { return null; } finally { clearTimeout(timer); }
}

// ── shadow rows and the report ─────────────────────────────────────────────────────────

export interface ShadowRow {
  readonly msgId: number;
  readonly at: string;
  readonly from: string;
  readonly kind: string;
  readonly verdict: StewardVerdict;
  readonly reason: StewardReason;
  readonly signal: StewardSignal;
  readonly duplicateOf?: number;
  /** What the TUI router did with it (seat-mail-turn-policy.ts) — «actually happened». */
  readonly actual: SeatMailRoute;
  readonly actualReason: SeatMailRouteReason;
  /** Did the recipient reply inside answeredWithinMs? */
  readonly answered: boolean;
  readonly jev?: { word: string | null; p: number };
}

export interface ShadowOptions {
  readonly policy: StewardMailPolicy;
  /** Ladder relation sender → recipient (undefined = unknown); the router reads it. */
  readonly senderAbove?: (from: string, to: string) => boolean | undefined;
  /** Jev answers already known per mail id (live ticks reuse the jsonl). */
  readonly jevKnown?: ReadonlyMap<number, { promote: boolean; word: string | null; p: number }>;
}

/** Structured shadow rows for a window of mails (id order). Pure. */
export function shadowRows(mails: readonly StewardMail[], opts: ShadowOptions): ShadowRow[] {
  const sorted = [...mails].sort((a, b) => a.id - b.id);
  const dups = findDuplicates(sorted, opts.policy.duplicateWindowMs);
  return sorted.map((m) => {
    const duplicateOf = dups.get(m.id);
    let decision = classifyStewardMail(m, { duplicateOf: duplicateOf ?? null }, opts.policy);
    const known = opts.jevKnown?.get(m.id);
    if (decision.askJev && decision.verdict === 'digest' && known?.promote) decision = { verdict: 'wake-now', reason: 'jev-wake', signal: 'jev', askJev: false };
    const above = opts.senderAbove?.(m.from, m.to);
    const route = seatMailRoute({
      kind: m.kind ?? null, intent: m.intent ?? null, crownDirective: m.crownDirective ?? null,
      origin: m.originDelegated ? { delegatedByCrown: true } : null, fromKind: m.fromKind ?? null, refs: m.refs ?? [],
      replyTo: m.replyTo ?? null, resultState: m.resultState ?? null, needsAck: m.needsAck ?? null, priority: m.priority ?? null,
      doneWhen: m.doneWhen ?? null, deadlineAt: m.deadlineAt ?? null, senderAbove: above ?? null, body: m.body,
      replyToOwn: typeof m.replyTo === 'number' && upper(m.replyToSender) === upper(m.to), cellDelegated: false, fromSeat: m.from,
    });
    const answered = typeof m.answeredAt === 'string' && Date.parse(m.answeredAt) - Date.parse(m.createdAt) <= opts.policy.answeredWithinMs;
    return {
      msgId: m.id, at: m.createdAt, from: m.from, kind: m.kind ?? '', verdict: decision.verdict, reason: decision.reason, signal: decision.signal,
      ...(duplicateOf !== undefined ? { duplicateOf } : {}), actual: route.route, actualReason: route.reason, answered,
      ...(known ? { jev: { word: known.word, p: Number(known.p.toFixed(3)) } } : {}),
    };
  });
}

export interface ShadowReport {
  readonly hours: number;
  readonly mails: number;
  readonly wakeNow: number;
  readonly digest: number;
  readonly digestBatches: number;
  readonly recordOnly: number;
  /** wake-now ⊕ one turn per digest window that has any digest mail. */
  readonly wouldWakes: number;
  readonly wouldWakesPerHour: number;
  readonly actualTurns: number;
  readonly actualTurnsPerHour: number;
  /** wake-now ⇔ router turn (digest/record ⇔ passive). */
  readonly routerAgreement: number;
  /** Outcome-consistent: an answered mail was not record-only, an unanswered one did not wake. */
  readonly shadowAgreement: number;
  /** record-only mails the recipient answered — the miss that matters. */
  readonly silencedAnswered: number;
  readonly answered: number;
  readonly byReason: Readonly<Record<string, number>>;
  readonly line: string;
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

/** Summarise shadow rows. `hours` = the window length (wakes/h denominators). */
export function shadowReport(rows: readonly ShadowRow[], hours: number, policy: StewardMailPolicy): ShadowReport {
  const count = (f: (r: ShadowRow) => boolean) => rows.filter(f).length;
  const wakeNow = count(r => r.verdict === 'wake-now');
  const digest = count(r => r.verdict === 'digest');
  const recordOnly = count(r => r.verdict === 'record-only');
  const windows = new Set(rows.filter(r => r.verdict === 'digest').map(r => Math.floor(Date.parse(r.at) / policy.digestMs)));
  const wouldWakes = wakeNow + windows.size;
  const actualTurns = count(r => r.actual === 'turn');
  const routerAgree = count(r => (r.verdict === 'wake-now') === (r.actual === 'turn'));
  const consistent = count(r => (r.answered ? r.verdict !== 'record-only' : r.verdict !== 'wake-now'));
  const silencedAnswered = count(r => r.answered && r.verdict === 'record-only');
  const byReason: Record<string, number> = {};
  for (const r of rows) byReason[`${r.verdict}:${r.reason}`] = (byReason[`${r.verdict}:${r.reason}`] ?? 0) + 1;
  const h = hours > 0 ? hours : 1;
  const per = (n: number) => Math.round((n / h) * 10) / 10;
  const report = {
    hours, mails: rows.length, wakeNow, digest, digestBatches: windows.size, recordOnly, wouldWakes, wouldWakesPerHour: per(wouldWakes),
    actualTurns, actualTurnsPerHour: per(actualTurns), routerAgreement: pct(routerAgree, rows.length), shadowAgreement: pct(consistent, rows.length),
    silencedAnswered, answered: count(r => r.answered), byReason,
  };
  return { ...report, line: shadowLine(report) };
}

export function shadowLine(r: Omit<ShadowReport, 'line' | 'byReason'>): string {
  return `📮 steward:mail shadow · ${r.hours}h · mails ${r.mails} · would wake ${r.wouldWakesPerHour}/h (now ${r.wakeNow} ⊕ digest turns ${r.digestBatches})`
    + ` vs router ${r.actualTurnsPerHour}/h · record-only ${r.recordOnly} · digest ${r.digest} · agreement ${r.shadowAgreement}% (router ${r.routerAgreement}%)`
    + ` · silenced-but-answered ${r.silencedAnswered}/${r.answered}`;
}
