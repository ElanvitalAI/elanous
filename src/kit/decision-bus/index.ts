// kit/decision-bus — CEO decisions reach the context bus without a hand relay (DECISION-TO-BUS-AUTO · 0.3.40 P0 · CEO 11-28 20:4x
// «구조화 시켜주세요»).
//
// S: a CEO decision reached eln OP's turn only when someone hand-posted `eln bus post --type decision`. On 11-28 evening several
//    decisions lived only in the decisions ledger, in docs/conductor change logs (AGENT-PLUGIN-GRAPH-WORKFLOW §8b) and in mail —
//    eln OP acted against them (infra handed to MK twice · release handed to TC).
// C: the decision's EFFECT stays in its canon (the decisions ledger · the doc on main) — a bus `decision` item is a POINTER
//    (AGENT-PLUGIN-GRAPH-WORKFLOW §1a #7) · raw CEO words already ride the bus as context (hook) · posts are idempotent (a rerun
//    adds nothing) · every number comes from the trigger YAML (graphs/triggers/decision-bus.yaml) · no per-agent TS.
// Q: how does every CEO decision recorded in a canon become one bus item eln OP's turn digest carries — and who notices when it
//    is not read?
// A: two sources, one pointer shape, one HQ space:
//    ① ledger — `decisionPointer(entry)` for every decided card (the ledger's decide path posts it at once; the sweep is the
//       backstop for any path that missed) · key `decision:<id>`
//    ② doc history — `changeLogRows(md)` reads the «변경 이력» / «Change log» tables (and bullet lists) of 내부 문서 `*`;
//       a row a main commit added (absent from its first parent) → `docRowPointer` · key `doc:<path>#<row hash>`
//    ③ delivery — the items sit in HQ (every coordinator's turn digest carries HQ · `eln bus digest --for OP --space HQ`); an item
//       still past OP's ack cursor after `unread_h` → ONE OP card (msg ledger · provenance key = the newest overdue id).
//
// 세 얼굴: 관측 = debug.log('decision-bus', …) ⊕ `<stateRoot>/decision-bus/last-sync.json` ⊕ `eln bus tail --space HQ` ·
//          인지 = crown/doc row → pointer (pure) · overdue = id past the reader's cursor and older than unread_h ·
//          수복과 인계 = a failed post is retried by the next sweep (same key) · an unreadable doc/commit is skipped and counted ·
//          unread → one OP card (never a second for the same set).
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ackCursor, busPost, readAcks, readBus, type BusItem, type BusPostInput, type BusPostResult } from '../../op-context-bus/bus.js';
import type { DecisionEntry } from '../../decisions/decision-ledger.js';
import type { GitRun } from '../../git-fs/smart-run.js';
import { directiveLine, forgetExpired, loadCrownDirectivePolicy, noteDirective, parseDirectiveLine, readDirectiveCards, seatDirFor, type DirectiveShape } from '../crown-directive/index.js';

/** The bus writer name of both sources (the digest shows `DECISIONS@ledger` · `DECISIONS@doc-history`). */
export const DECISION_BUS_FROM = 'DECISIONS';
/** The ledger actor source a CEO relay record carries (`eln decisions crown`). */
export const CROWN_RELAY_SOURCE = 'ceo-relay';
/** The `scqa.a` prefix that names a relay record's canonical path. */
const CANON_PREFIX = '정본 ';

/** Where the pointers go and who must read them — the trigger YAML node input (one place for every number). */
export interface DecisionBusPolicy {
  readonly space: string;
  readonly reader: string;
  /** Ledger decisions / main commits older than this are not swept (the first run never floods history). */
  readonly lookbackH: number;
  /** An item past the reader's cursor for longer than this → one card. */
  readonly unreadH: number;
  /** Posts per sweep (both sources together) — the rest waits for the next tick. */
  readonly maxPerTick: number;
  /** The main ref the doc source walks (first-parent). */
  readonly ref: string;
  /** The docs folder whose direct *.md children carry change logs. */
  readonly docs: string;
}

/** Parse the trigger node input (snake_case YAML) — a missing or bad number is a loud error, never a default. */
export function decisionBusPolicyOf(input: Record<string, unknown>): DecisionBusPolicy {
  const num = (k: string): number => { const v = input[k]; if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`decision-bus: node input ${k} must be a positive number`); return v; };
  const str = (k: string): string => { const v = input[k]; if (typeof v !== 'string' || !v.trim()) throw new Error(`decision-bus: node input ${k} must be a non-empty string`); return v.trim(); };
  return { space: str('space').toUpperCase(), reader: str('reader').toUpperCase(), lookbackH: num('lookback_h'), unreadH: num('unread_h'), maxPerTick: Math.floor(num('max_per_tick')), ref: str('ref'), docs: str('docs').replace(/\/+$/u, '') };
}

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const clip = (s: string, n: number): string => { const f = flat(s); return Array.from(f).length <= n ? f : `${Array.from(f).slice(0, n - 1).join('')}…`; };
const h12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** When the card was decided (or recorded) — the sweep window reads this. */
export function decisionTime(e: Pick<DecisionEntry, 'decidedAt' | 'importedAt' | 'raisedAt'>): string | null {
  return e.decidedAt ?? e.importedAt ?? e.raisedAt ?? null;
}

/** A relay record of CEO words (`eln decisions crown`) — the words are the note, the canon path is `scqa.a`. */
export function isCrownRelay(e: Pick<DecisionEntry, 'decidedBy'>): boolean {
  return e.decidedBy?.kind === 'imported' && e.decidedBy.source.startsWith(`${CROWN_RELAY_SOURCE}:`);
}

/** Pure: the bus pointer of one decided card, or null (open · withdrawn · an imported historical row that is not a relay).
 *  `reader` = the item's owner: the seat digest lists an addressed decision under «할 일» (5 lines) instead of «참고» (3). */
export function decisionPointer(e: DecisionEntry, reader: string): BusPostInput | null {
  if (e.status !== 'decided') return null;
  if (e.decidedBy?.kind === 'imported' && !isCrownRelay(e)) return null;
  const canonLine = e.scqa.a?.startsWith(CANON_PREFIX) ? e.scqa.a.slice(CANON_PREFIX.length).trim() : '';
  const canon = canonLine || `eln decisions show ${e.id}`;
  const by = e.decidedBy?.kind === 'human' ? `\u{1F451} 직접(${e.decidedBy.via ?? '?'})` : e.decidedBy?.kind === 'auto' ? `위임 ${e.decidedBy.agent}` : '\u{1F451} 원문 중계';
  const chosen = e.choice ? e.options.find((o) => o.key === e.choice) : undefined;
  const what = chosen ? `${e.title} → ${e.choice}: ${chosen.label}` : e.title;
  const quote = e.note ?? ''; // a relay record's note IS the CEO words · a decided card's note is the decider's reason
  const body = `\u{1F451} 결정 ${e.id} · ${clip(what, 200)} · ${by}${quote ? ` · «${clip(quote, 300)}»` : ''} · 정본 ${canon}`;
  return { type: 'decision', from: DECISION_BUS_FROM, body, refs: [`decision:${e.id}`], source: 'ledger', key: `decision:${e.id}`, owner: reader };
}

/** One row of a change-log table (or one bullet of a change-log list) as it stands in a doc. */
export interface ChangeLogRow {
  readonly doc: string;
  readonly heading: string;
  readonly header: readonly string[];
  readonly cells: readonly string[];
  /** Hash of doc ⊕ the row's normalized cells — the same row in two commits is the same row. */
  readonly hash: string;
}

const CHANGE_LOG_HEADING = /변경\s*이력|change\s*-?\s*log/iu;
const splitRow = (line: string): string[] => {
  const t = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return t.split(/(?<!\\)\|/u).map((c) => flat(c.replace(/\\\|/gu, '|')));
};
const isSeparator = (cells: readonly string[]): boolean => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/u.test(c));

/** Pure: every row under a «변경 이력» / «Change log» heading (until the next heading of the same or a higher level). */
export function changeLogRows(doc: string, markdown: string): ChangeLogRow[] {
  const out: ChangeLogRow[] = [];
  let level = 0; let heading = ''; let inLog = false; let header: string[] | null = null; let fence = false;
  for (const raw of markdown.split('\n')) {
    if (/^\s*(```|~~~)/u.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/u.exec(raw);
    if (h) {
      const lv = h[1]!.length;
      if (inLog && lv > level) continue; // a sub-heading inside the log keeps the log open
      inLog = CHANGE_LOG_HEADING.test(h[2]!); level = lv; heading = flat(h[2]!); header = null;
      continue;
    }
    if (!inLog) continue;
    const line = raw.trim();
    if (line.startsWith('|')) {
      const cells = splitRow(line);
      if (!header) { header = cells; continue; }
      if (isSeparator(cells)) continue;
      if (cells.every((c) => !c)) continue;
      out.push({ doc, heading, header, cells, hash: h12(`${doc}\n${cells.join('|')}`) });
      continue;
    }
    header = null;
    const bullet = /^[-*]\s+(.+)$/u.exec(raw); // top-level bullets only (an indented line belongs to the bullet above)
    if (bullet) { const cell = flat(bullet[1]!); out.push({ doc, heading, header: [], cells: [cell], hash: h12(`${doc}\n${cell}`) }); }
  }
  return out;
}

/** Pure: rows of `after` whose hash `before` does not hold (a reworded row counts as new — it is new information). */
export function newChangeLogRows(doc: string, before: string, after: string): ChangeLogRow[] {
  const had = new Set(changeLogRows(doc, before).map((r) => r.hash));
  const seen = new Set<string>();
  return changeLogRows(doc, after).filter((r) => !had.has(r.hash) && !seen.has(r.hash) && seen.add(r.hash));
}

const QUOTE_HEADER = /\u{1F451}|원문|why|왜/iu;

/** Pure: the bus pointer of one new change-log row (the CEO words = the «why/원문» column, else the first «…» of the row). */
export function docRowPointer(row: ChangeLogRow, commit: string, reader: string): BusPostInput {
  const qi = row.header.findIndex((c) => QUOTE_HEADER.test(c));
  const quoteCell = qi >= 0 ? (row.cells[qi] ?? '') : '';
  const inline = /«([^»]+)»/u.exec(row.cells.join(' '))?.[1] ?? '';
  const quote = flat(quoteCell.replace(/^«|»$/gu, '')) || flat(inline);
  const rest = row.cells.filter((_, i) => i !== qi).filter(Boolean).join(' · ');
  const body = `\u{1F451} 결정(문서 이력) · ${clip(rest, 320)}${quote ? ` · «${clip(quote, 240)}»` : ''} · 정본 ${row.doc} §${clip(row.heading, 60)} @${commit.slice(0, 12)}`;
  return { type: 'decision', from: DECISION_BUS_FROM, body, refs: [`doc-row:${row.doc}#${row.hash}`], source: 'doc-history', key: `doc:${row.doc}#${row.hash}`, owner: reader };
}

export interface DocRowHit { readonly row: ChangeLogRow; readonly commit: string }

/**
 * The rows main's first-parent commits since `sinceIso` added to `<docs>/*.md` change logs, oldest commit first. A commit or a
 * file git cannot show is counted in `skipped`, never a throw (the next tick tries again — the keys dedupe).
 */
export function docRowsSince(git: GitRun, policy: Pick<DecisionBusPolicy, 'ref' | 'docs'>, sinceIso: string): { hits: DocRowHit[]; commits: number; skipped: number } {
  const log = git(['log', '--first-parent', '--reverse', `--since=${sinceIso}`, '--format=%H', policy.ref, '--', policy.docs]);
  if (log.status !== 0) return { hits: [], commits: 0, skipped: 1 };
  const commits = log.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/u.test(l));
  const hits: DocRowHit[] = []; let skipped = 0;
  const direct = new RegExp(`^${policy.docs.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/[^/]+\\.md$`, 'u');
  for (const c of commits) {
    const parent = git(['rev-parse', '--verify', '-q', `${c}^1`]);
    const base = parent.status === 0 ? parent.stdout.trim() : null;
    const names = base ? git(['diff', '--name-only', base, c, '--', policy.docs]) : git(['show', '--name-only', '--format=', c, '--', policy.docs]);
    if (names.status !== 0) { skipped++; continue; }
    for (const file of names.stdout.split('\n').map((l) => l.trim()).filter((l) => direct.test(l))) {
      const after = git(['show', `${c}:${file}`]);
      if (after.status !== 0) continue; // deleted in this commit — no new rows
      const before = base ? git(['show', `${base}:${file}`]) : { status: 1, stdout: '' };
      for (const row of newChangeLogRows(file, before.status === 0 ? before.stdout : '', after.stdout)) hits.push({ row, commit: c });
    }
  }
  return { hits, commits: commits.length, skipped };
}

/** Post one pointer (idempotent by its key). The caller decides fail-open. */
export function postPointer(stateRoot: string, input: BusPostInput, space: string, nowMs?: number): BusPostResult {
  return busPost(stateRoot, input, { space, ...(nowMs !== undefined ? { now: nowMs } : {}) });
}

/**
 * The ledger's decide path calls this with the decided card: one HQ pointer at once (the sweep re-posts nothing — same key).
 * Fail-open: a bus write failure never fails the decision (the sweep is the retry).
 */
export function pointDecisionToBus(stateRoot: string, e: DecisionEntry, space: string, reader: string, nowMs?: number): BusPostResult | null {
  const input = decisionPointer(e, reader);
  if (!input) return null;
  // ELN-OP-CROWN-MEMORY — the same door writes the directive card (ledger ⊕ eln OP memory) before the pointer (fail-open).
  noteDirective(stateRoot, directiveInputOf(e), new Date(nowMs ?? Date.now()));
  try { const r = postPointer(stateRoot, input, space, nowMs); log('pointer', { id: e.id, result: r.kind }); return r; }
  catch (error) { log('pointer-failed', { id: e.id, error: String(error).slice(0, 160) }); return null; }
}

/** The directive card fields of one decided card: words = the note (relay) else the decision line · shape = `scqa.q` `지시 …`. */
export function directiveInputOf(e: DecisionEntry): { source: string; quote: string; scope: string; shape: DirectiveShape | null } {
  const chosen = e.choice ? e.options.find((o) => o.key === e.choice) : undefined;
  return { source: `decision:${e.id}`, quote: e.note ?? (chosen ? `${e.choice}: ${chosen.label}` : e.title), scope: e.title, shape: parseDirectiveLine(e.scqa.q) };
}

/** The card the reader gets when pointers sit unread past `unread_h` — null when nothing is overdue. */
export interface UnreadCard { readonly to: string; readonly body: string; readonly provenanceKey: string; readonly ids: readonly string[] }

/** Pure over the bus files: the overdue pointers (past the reader's ack cursor · older than unread_h) as ONE card. */
export function unreadDecisionCard(stateRoot: string, policy: Pick<DecisionBusPolicy, 'space' | 'reader' | 'unreadH'>, nowMs: number): UnreadCard | null {
  const cursor = ackCursor(readAcks(stateRoot, policy.space), policy.reader);
  const overdue = readBus(stateRoot, policy.space).filter((i: BusItem) => i.type === 'decision' && i.from === DECISION_BUS_FROM
    && (cursor === null || i.id > cursor) && nowMs - Date.parse(i.at) >= policy.unreadH * 3_600_000);
  if (overdue.length === 0) return null;
  const newest = overdue.at(-1)!;
  const lines = overdue.slice(-5).map((i) => `${i.id} ${clip(i.body, 120)}`);
  const body = `[결정 버스 · 미읽음 ${policy.unreadH}h] ${policy.space} 버스의 \u{1F451} 결정 포인터 ${overdue.length}건을 ${policy.reader} 가 ${policy.unreadH}시간 넘게 읽지 않았다 — `
    + `${lines.join(' | ')}${overdue.length > 5 ? ` | … ${overdue.length - 5}건 더` : ''} · 읽기: eln bus digest --for ${policy.reader} --space ${policy.space} 뒤 eln bus ack <id> --as ${policy.reader} --space ${policy.space}`;
  return { to: policy.reader, body, provenanceKey: `decision-bus-unread:${policy.space}:${newest.id}`, ids: overdue.map((i) => i.id) };
}

export interface DecisionBusSyncDeps {
  readonly stateRoot: string;
  readonly policy: DecisionBusPolicy;
  readonly now: Date;
  /** The decided cards (default: the ledger at stateRoot). */
  readonly decisions: () => readonly DecisionEntry[];
  /** git at the repo whose main carries docs (null = the doc source is off this tick, counted). */
  readonly git: GitRun | null;
  /** Card port (default: msg ledger appendWithProvenance) — returns the message id, null on failure. */
  readonly postCard?: (card: UnreadCard) => number | null;
  /** dry-run: judge and count, write nothing (shadow stage / manual preview). */
  readonly dryRun?: boolean;
}

export interface DecisionBusReport {
  readonly at: string;
  readonly dryRun: boolean;
  readonly ledger: { readonly candidates: number; readonly posted: number; readonly duplicate: number; readonly failed: number };
  readonly docs: { readonly commits: number; readonly rows: number; readonly posted: number; readonly duplicate: number; readonly failed: number; readonly skipped: number };
  readonly deferred: number;
  readonly card: { readonly overdue: number; readonly messageId: number | null; readonly key: string | null };
  readonly line: string;
}

/** One sweep: ledger ⊕ doc history → HQ pointers (≤ max_per_tick · keys dedupe) → unread check → at most one card. */
export function syncDecisionBus(deps: DecisionBusSyncDeps): DecisionBusReport {
  const { policy, stateRoot } = deps;
  const nowMs = deps.now.getTime();
  const since = new Date(nowMs - policy.lookbackH * 3_600_000).toISOString();
  const onBus = new Set(readBus(stateRoot, policy.space).map((i) => i.dedupeKey).filter((k): k is string => !!k));
  let budget = policy.maxPerTick; let deferred = 0;
  const post = (input: BusPostInput, tally: { posted: number; duplicate: number; failed: number }): void => {
    if (onBus.has(`k:${input.key}`)) { tally.duplicate++; return; }
    if (budget <= 0) { deferred++; return; }
    budget--;
    if (deps.dryRun) { tally.posted++; return; }
    try { const r = postPointer(stateRoot, input, policy.space, nowMs); if (r.kind === 'posted') tally.posted++; else tally.duplicate++; onBus.add(`k:${input.key}`); }
    catch (error) { tally.failed++; log('post-failed', { key: input.key, error: String(error).slice(0, 160) }); }
  };
  const led = { candidates: 0, posted: 0, duplicate: 0, failed: 0 };
  const decided = deps.decisions().filter((e) => { const t = decisionTime(e); return t !== null && t >= since; })
    .sort((a, b) => (decisionTime(a)! < decisionTime(b)! ? -1 : 1));
  for (const e of decided) {
    const p = decisionPointer(e, policy.reader); if (!p) continue; led.candidates++; post(p, led);
    if (!deps.dryRun) noteDirective(stateRoot, directiveInputOf(e), deps.now); // backstop: a card the decide door missed
  }
  const doc = { commits: 0, rows: 0, posted: 0, duplicate: 0, failed: 0, skipped: 0 };
  if (deps.git) {
    const found = docRowsSince(deps.git, policy, since);
    doc.commits = found.commits; doc.skipped = found.skipped; doc.rows = found.hits.length;
    for (const hit of found.hits) {
      const p = docRowPointer(hit.row, hit.commit, policy.reader); post(p, doc);
      // a doc row has no seats/cells: a memory-only card (the words reach eln OP's memory · no action check)
      if (!deps.dryRun) noteDirective(stateRoot, { source: p.key!, quote: p.body, scope: `${hit.row.doc} §${hit.row.heading}` }, deps.now);
    }
  } else doc.skipped = 1;
  if (!deps.dryRun) { try { const seat = loadCrownDirectivePolicy().memorySeat; forgetExpired(readDirectiveCards(stateRoot), seatDirFor(stateRoot, seat), seat, nowMs); } catch { /* next sweep */ } }
  const card = unreadDecisionCard(stateRoot, policy, nowMs);
  let messageId: number | null = null;
  if (card && !deps.dryRun) messageId = (deps.postCard ?? msgLedgerCard(stateRoot))(card);
  const line = `decision-bus: ledger +${led.posted} (=${led.duplicate}) · docs +${doc.posted} (=${doc.duplicate}) rows ${doc.rows} commits ${doc.commits}`
    + `${deferred ? ` · deferred ${deferred}` : ''}${led.failed + doc.failed ? ` · failed ${led.failed + doc.failed}` : ''} · unread ${card?.ids.length ?? 0}${card ? ` → card ${messageId ?? (deps.dryRun ? 'dry' : 'failed')}` : ''}`;
  const report: DecisionBusReport = { at: deps.now.toISOString(), dryRun: !!deps.dryRun, ledger: led, docs: doc, deferred,
    card: { overdue: card?.ids.length ?? 0, messageId, key: card?.provenanceKey ?? null }, line };
  log('sync', { ...report.ledger, docPosted: doc.posted, docRows: doc.rows, deferred, overdue: report.card.overdue, dryRun: report.dryRun });
  return report;
}

/** The default card port: one OP request over the msg ledger at stateRoot, idempotent by the card's provenance key. */
export function msgLedgerCard(stateRoot: string): (card: UnreadCard) => number | null {
  return (card) => {
    try {
      const { openMsgStore } = require('../../msg/msg-store.js') as typeof import('../../msg/msg-store.js');
      const store = openMsgStore(join(stateRoot, 'msg', 'messages.db'));
      try { return store.appendWithProvenance({ from: DECISION_BUS_FROM, to: card.to, kind: 'request', intent: 'request', priority: 1, refs: card.ids.map((id) => `bus:${id}`), body: card.body }, card.provenanceKey).id; }
      finally { store.close(); }
    } catch (error) { log('card-failed', { error: String(error).slice(0, 160) }); return null; }
  };
}

/** The sweep report file (the trigger's goal · rewritten every tick, dry-run included). */
export function writeDecisionBusReport(path: string, report: DecisionBusReport): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, path);
}

/** `eln decisions crown` — the ledger fields of one relayed CEO decision (pure · the CLI hands this to importRecorded). */
export function crownRecordInput(o: { summary: string; quote: string; at: string; doc?: string; seat: string; category?: DecisionEntry['category']; directive?: DirectiveShape | null }): {
  input: Parameters<import('../../decisions/decision-ledger.js').DecisionLedger['importRecorded']>[0]; ref: string; note: string; source: string;
} {
  const summary = flat(o.summary); const quote = flat(o.quote);
  if (!summary) throw new Error('crown: a one-line summary is required');
  if (!quote) throw new Error('crown: --quote <\u{1F451} 원문> is required (the words are the record)');
  // SCQA fields hold ≤ 2 sentences · 240 chars: sentence stops are dropped there (the full words stay in the note).
  const scqa = (s: string): string => clip(s.replace(/[.!?。！？]+(?=[\s»]|$)/gu, ''), 240);
  const ref = `crown:${h12(quote)}`; // the same CEO words recorded twice = one record (a rerun without --at stays idempotent)
  return {
    ref, note: quote, source: `${CROWN_RELAY_SOURCE}:${o.seat}`,
    input: { title: clip(summary, 200), category: o.category ?? 'other', scqa: { s: scqa(summary), c: scqa(`\u{1F451} 원문 «${quote}»`), ...(o.directive ? { q: directiveLine(o.directive) } : {}), ...(o.doc ? { a: `${CANON_PREFIX}${o.doc.trim()}` } : {}) },
      options: [], recommendation: { skipped: true, reason: '\u{1F451} 결정 기록(중계) — 고를 선택지 없음' }, raisedBy: { agent: o.seat }, refs: [ref], raisedAt: o.at },
  };
}

function log(event: string, data: Record<string, unknown>): void {
  try { (require('../../debug/log.js') as typeof import('../../debug/log.js')).debug.log('decision-bus', event, data); } catch { /* fail-open */ }
}
