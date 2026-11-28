// KIT mail-route · steward:mail SHADOW — the I/O half of steward-mail.ts: read a window of the recipient's mail from the
// mail ledger (read-only), score it, ask Jev for the unstructured ones (capped · promote only), append one jsonl row per
// new mail and rewrite the last report. Routes nothing (STEWARD-MAIL shadow stage).
//
// 세 얼굴: 관측 = <state>/steward/mail-shadow-<day>.jsonl ⊕ <state>/steward/mail-shadow.json ⊕ log `steward.mail.shadow` ·
// 판단 근거 = steward-mail.yaml ⊕ router route ⊕ OP reply · 수복과 인계 = shadow only; any read failure → outcome fail
// (the trigger cards its owner after two misses) and nothing else changes.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { debug } from '../../debug/log.js';
import {
  askStewardJev, classifyStewardMail, findDuplicates, readStewardMailPolicy, shadowReport, shadowRows, STEWARD_JEV_USAGE_SITE,
  type ShadowReport, type ShadowRow, type StewardDecide, type StewardMail, type StewardMailPolicy,
} from './steward-mail.js';

interface Row {
  id: number; sender: string; recipient: string; body: string; kind: string | null; reply_to: number | null; created_at: string;
  priority: number | null; from_kind: string | null; crown_directive: string | null; intent: string | null; refs_json: string | null;
  deadline_at: string | null; needs_ack: number | null; origin_delegated: number | null; done_when: string | null;
  correlation_id: string | null; result_json: string | null; reply_to_sender: string | null; answered_at: string | null;
}

function parseJson<T>(raw: string | null): T | null { if (!raw) return null; try { return JSON.parse(raw) as T; } catch { return null; } }

/** The recipient's mail created at or after `sinceIso` (id order), with the replied-to sender and the recipient's first reply. */
export function loadStewardMails(db: Database, recipient: string, sinceIso: string, untilIso?: string): StewardMail[] {
  const rows = db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, m.reply_to, m.created_at, m.priority, m.from_kind, m.crown_directive,
      m.intent, m.refs_json, m.deadline_at, m.needs_ack, m.origin_delegated, m.done_when, m.correlation_id, m.result_json,
      p.sender AS reply_to_sender,
      (SELECT MIN(r.created_at) FROM msg_messages r WHERE r.reply_to = m.id AND r.sender = m.recipient) AS answered_at
    FROM msg_messages m LEFT JOIN msg_messages p ON p.id = m.reply_to
    WHERE m.recipient = ? AND m.created_at >= ?${untilIso ? ' AND m.created_at < ?' : ''} ORDER BY m.id`)
    .all(...(untilIso ? [recipient, sinceIso, untilIso] : [recipient, sinceIso])) as Row[];
  return rows.map((r) => {
    const refs = parseJson<unknown>(r.refs_json);
    const result = parseJson<{ state?: unknown }>(r.result_json);
    return {
      id: r.id, from: r.sender, to: r.recipient, createdAt: r.created_at, body: r.body,
      kind: r.kind, intent: r.intent, needsAck: r.needs_ack === null ? null : r.needs_ack === 1, priority: r.priority,
      crownDirective: r.crown_directive, originDelegated: r.origin_delegated === 1, fromKind: r.from_kind,
      refs: Array.isArray(refs) ? refs.filter((x): x is string => typeof x === 'string') : [],
      replyTo: r.reply_to, correlationId: r.correlation_id, doneWhen: r.done_when, deadlineAt: r.deadline_at,
      resultState: result?.state === 'done' || result?.state === 'failed' ? result.state : null,
      replyToSender: r.reply_to_sender, answeredAt: r.answered_at,
    };
  });
}

/** The federation ladder as the router reads it; null when unavailable (then a request reads as «ladder unknown»). */
export async function ladderRelation(): Promise<((from: string, to: string) => boolean | undefined) | undefined> {
  try {
    const { loadFederationLadder } = await import('../../msg/hand-raise-ladder.js');
    const { senderAboveOnLadder } = await import('../../tui/seat-mail-turn-policy.js');
    const ladder = loadFederationLadder();
    return (from, to) => senderAboveOnLadder(ladder, from, to);
  } catch { return undefined; }
}

/** Live Jev for the steward (shared access/usage path with the ✋ classifier). No live call under bun test. */
export async function defaultStewardDecide(): Promise<StewardDecide | null> {
  if (process.env.BUN_TEST !== undefined || process.env.NODE_ENV === 'test') return null;
  const { makeJevDecide } = await import('./hand-classifier.js');
  return makeJevDecide(STEWARD_JEV_USAGE_SITE);
}

/** Ask Jev for the mails the structured fields could not decide (digest ∧ askJev), at most `max`, `parallel` at a time. */
export async function askJevFor(mails: readonly StewardMail[], policy: StewardMailPolicy, decide: StewardDecide, max: number, parallel = 4):
  Promise<Map<number, { promote: boolean; word: string | null; p: number }>> {
  const dups = findDuplicates(mails, policy.duplicateWindowMs);
  const eligible = mails.filter((m) => {
    const d = classifyStewardMail(m, { duplicateOf: dups.get(m.id) ?? null }, policy);
    return d.askJev && d.verdict === 'digest';
  }).slice(0, Math.max(0, max));
  const out = new Map<number, { promote: boolean; word: string | null; p: number }>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= eligible.length) return;
      const m = eligible[i]!;
      const a = await askStewardJev(m, policy, decide);
      if (a) out.set(m.id, a);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, eligible.length) }, worker));
  return out;
}

const dayOf = (iso: string): string => iso.slice(0, 10);

function readRows(path: string): ShadowRow[] {
  if (!existsSync(path)) return [];
  const out: ShadowRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ShadowRow); } catch { /* a torn last line reads next tick */ }
  }
  return out;
}

export interface ShadowTickDeps {
  readonly db: Database;
  readonly stateRoot: string;
  readonly now?: () => Date;
  readonly policy?: StewardMailPolicy;
  readonly decide?: StewardDecide | null;
  readonly senderAbove?: (from: string, to: string) => boolean | undefined;
  readonly windowMs?: number;
  readonly emit?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * One shadow tick (the steward-mail trigger · every 10 min): the last hour per recipient → new rows appended (Jev asked
 * for new unstructured mail, capped) → report rewritten. Returns the report per recipient.
 */
export async function stewardMailShadowTick(deps: ShadowTickDeps): Promise<Record<string, ShadowReport>> {
  const now = (deps.now ?? (() => new Date()))();
  const policy = deps.policy ?? readStewardMailPolicy();
  const windowMs = deps.windowMs ?? 60 * 60_000;
  const since = new Date(now.getTime() - windowMs).toISOString();
  const dir = join(deps.stateRoot, 'steward');
  mkdirSync(dir, { recursive: true });
  const today = join(dir, `mail-shadow-${dayOf(now.toISOString())}.jsonl`);
  const yesterday = join(dir, `mail-shadow-${dayOf(since)}.jsonl`);
  const recorded = new Map<number, ShadowRow>();
  for (const r of [...(yesterday !== today ? readRows(yesterday) : []), ...readRows(today)]) recorded.set(r.msgId, r);
  const reports: Record<string, ShadowReport> = {};
  let jevBudget = policy.jev.maxCallsPerTick;
  for (const recipient of policy.recipients) {
    const mails = loadStewardMails(deps.db, recipient, since);
    const fresh = mails.filter(m => !recorded.has(m.id));
    const known = new Map<number, { promote: boolean; word: string | null; p: number }>();
    for (const r of recorded.values()) if (r.jev) known.set(r.msgId, { promote: r.reason === 'jev-wake', word: r.jev.word, p: r.jev.p });
    if (deps.decide && jevBudget > 0 && fresh.length > 0) {
      const asked = await askJevFor(mails.filter(m => !recorded.has(m.id)), policy, deps.decide, jevBudget);
      jevBudget -= asked.size;
      for (const [id, a] of asked) known.set(id, a);
    }
    const rows = shadowRows(mails, { policy, ...(deps.senderAbove ? { senderAbove: deps.senderAbove } : {}), jevKnown: known });
    const freshIds = new Set(fresh.map(m => m.id));
    const lines = rows.filter(r => freshIds.has(r.msgId)).map(r => `${JSON.stringify({ to: recipient, ...r })}\n`).join('');
    if (lines) appendFileSync(today, lines);
    const report = shadowReport(rows, windowMs / 3_600_000, policy);
    reports[recipient] = report;
    (deps.emit ?? ((e, d) => debug.log('steward', e, d)))('steward.mail.shadow', {
      recipient, mails: report.mails, wakeNow: report.wakeNow, digestBatches: report.digestBatches, recordOnly: report.recordOnly,
      wouldWakesPerHour: report.wouldWakesPerHour, actualTurnsPerHour: report.actualTurnsPerHour, shadowAgreement: report.shadowAgreement,
      routerAgreement: report.routerAgreement, silencedAnswered: report.silencedAnswered, fresh: fresh.length,
    });
  }
  const out = join(dir, 'mail-shadow.json');
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ at: now.toISOString(), stage: 'shadow', policy: policy.source, reports }, null, 2)}\n`);
  renameSync(tmp, out);
  return reports;
}

/** The trigger node (graphs/triggers/steward-mail.yaml · recipe trigger-steward-mail-shadow). One JSON line out. */
async function main(): Promise<void> {
  try {
    const { openMsgStoreReadOnly } = await import('../../msg/msg-store.js');
    const { elanousStateRoot } = await import('../../autopilot/state-paths.js');
    const ctxPath = process.env.ELANOUS_GRAPH_CONTEXT;
    const ctx = ctxPath && existsSync(ctxPath) ? JSON.parse(readFileSync(ctxPath, 'utf8')) as { input?: { vars?: { stateRoot?: string } } } : {};
    const stateRoot = ctx.input?.vars?.stateRoot ?? process.env.ELANOUS_STATE_DIR ?? elanousStateRoot();
    const store = openMsgStoreReadOnly();
    try {
      const senderAbove = await ladderRelation();
      const reports = await stewardMailShadowTick({ db: store.db, stateRoot, decide: await defaultStewardDecide(), ...(senderAbove ? { senderAbove } : {}) });
      console.log(JSON.stringify({ outcome: 'ok', lines: Object.values(reports).map(r => r.line) }));
    } finally { store.close(); }
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'fail', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
