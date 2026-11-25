// SPACE-ADVISOR (대표 11-25 23:0x «TC 밑에 어드바이저 — 행정관 같은 직속 도우미인데 LLM · 일 폭발을 막아라»).
//
// S: 11-25 evening TC received 55 ✋ in a few hours (writer/handover ≈30 · worktree path 10 · slot/isolation 8 · scope 5 ·
//    cap/criteria 2). Most had an answer TC had already given before; TC re-answered each by hand and the rest climbed to OP.
// C: the space steward resolver (deterministic) closes only computable causes. Everything else lands on the coordinator,
//    even when it is the 5th copy of a decision TC already made.
// Q: who answers «the same question again» without TC, and how does TC see only real judgment?
// A: one path, no exceptions:
//      ✋ → steward resolver (computable) → advisor
//        (a) routine cause ⊕ matching precedent → advisor resolves under the leader contract (owner ⊕ deadline ⊕ next step)
//        (b) otherwise → ONE recommendation card to the coordinator (options ⊕ recommended ⊕ evidence) → coordinator picks
//            · silent 10 min (or the ✋ one tick before its ladder timer) → routine class: apply the recommendation ·
//              judgment class: escalate one level (the receiver's own escalation → OP, where the OP steward beacon watches)
//    Every coordinator decision on a ✋ becomes a precedent {cause, keys, answer template} — matched by structured cause
//    ⊕ keys (refs), never by regex on prose. An optional judge port (model) may pick among same-cause candidates.
//
// 세 얼굴:
//   관측 = events.jsonl per advisor (resolved · recommended · picked · auto · escalated · steward) · advisor.* debug events ·
//          `eln msg hand advisor` board line · 30-min digest mail to the coordinator
//   인지 = causeOfReason (structured reason codes) · matchPrecedent (cause ⊕ keys ⊕ optional judge) · routine vs judgment class
//   수복과 인계 = resolve via applyHandOutcome (the ladder's own outcome row) · escalate via the ladder · precedent learning
//
// The advisor writes outcomes AS the coordinator (actor = receiver) — the ladder contract is unchanged; the outcome text and
// refs name the advisor, and its events ledger is the metric source.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import type { MsgStore } from '../../msg/msg-store.js';
import {
  applyHandOutcome, HAND_AUTO_ESCALATE_AFTER_MS, openHands, type HandLadderDeps, type OpenHand,
} from '../../msg/hand-raise-ladder.js';

export const ADVISOR_ROLE = 'advisor';
/** How long the coordinator may stay silent on a recommendation card. */
export const ADVISOR_PICK_WINDOW_MS = 10 * 60_000;
/** Act one tick (1 min) before the ladder would auto-escalate the ✋ itself. */
export const ADVISOR_LADDER_MARGIN_MS = 60_000;
export const ADVISOR_DIGEST_EVERY_MS = 30 * 60_000;
export const ADVISOR_DEFAULT_DEADLINE_MIN = 30;

// ── causes (structured) ───────────────────────────────────────────────────────────────────────

export const ADVISOR_CAUSES = ['writer-handover', 'worktree-path', 'slot-isolation', 'scope-decision', 'cap-criteria', 'other'] as const;
export type AdvisorCause = typeof ADVISOR_CAUSES[number];
/** Causes the advisor may close alone when a precedent matches. The rest always go to the coordinator. */
export const ROUTINE_CAUSES: readonly AdvisorCause[] = ['writer-handover', 'worktree-path', 'slot-isolation'];

/** reason code (the ✋ `reason:` ref, exact, case-insensitive) → cause. Unknown codes are `other` (judgment). */
const REASON_TO_CAUSE: Readonly<Record<string, AdvisorCause>> = {
  'writer': 'writer-handover', 'writer-conflict': 'writer-handover', 'existing-writer': 'writer-handover', 'handover': 'writer-handover',
  'duplicate-writer': 'writer-handover', 'writer-handover': 'writer-handover',
  // writer-resolver (#40173) block codes
  'owner_unknown': 'writer-handover', 'dependency_wait': 'writer-handover',
  'worktree': 'worktree-path', 'worktree-path': 'worktree-path', 'path': 'worktree-path',
  'slot': 'slot-isolation', 'isolation': 'slot-isolation', 'slot-isolation': 'slot-isolation', 'config-dir': 'slot-isolation',
  'scope': 'scope-decision', 'scope-decision': 'scope-decision', 'human_decision': 'scope-decision',
  'cap': 'cap-criteria', 'criteria': 'cap-criteria', 'cap-criteria': 'cap-criteria',
};
export function causeOfReason(reason: string): AdvisorCause {
  return REASON_TO_CAUSE[reason.trim().toLowerCase()] ?? 'other';
}

/** Context keys of a ✋ = its `ctx:<key>=<value>` refs (structured — the raiser fills them; never parsed from the body). */
export function handContextKeys(refs: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of refs ?? []) {
    if (!ref.startsWith('ctx:')) continue;
    const eq = ref.indexOf('=');
    if (eq > 4) out[ref.slice(4, eq)] = ref.slice(eq + 1);
  }
  return out;
}

// ── precedent ledger ──────────────────────────────────────────────────────────────────────────

export interface Precedent {
  readonly id: string;
  readonly cause: AdvisorCause;
  /** Every key must equal the ✋'s context key (an empty map = the cause's default answer). */
  readonly keys: Readonly<Record<string, string>>;
  /** The answer template — `{seat}` and `{key:<k>}` are filled from the ✋. */
  readonly answer: string;
  /** Who owns the next step (`{seat}` = the blocked seat). */
  readonly owner: string;
  readonly deadlineMin: number;
  readonly next: string;
  readonly source: 'coordinator-decision' | 'feedback-memory' | 'seed';
  readonly at: string;
}

/** The seeded precedents: the TC feedback memories (writer-check-2min-rule …) as precedent rows. */
export const SEED_PRECEDENTS: readonly Precedent[] = [
  { id: 'writer-check-2min-rule', cause: 'writer-handover', keys: {}, answer: '{seat}: check the cell writer once (eln work next shows it); if the writer was idle ≥2 min take the cell with a handover note, else pick the next cell', owner: '{seat}', deadlineMin: 15, next: 'eln work next', source: 'feedback-memory', at: '2026-11-25T00:00:00.000Z' },
  { id: 'worktree-under-claude-wt', cause: 'worktree-path', keys: {}, answer: '{seat}: use repo.git/.claude/wt/<branch> (git worktree add from origin/main) — never the seat dir', owner: '{seat}', deadlineMin: 15, next: 'continue the cell', source: 'feedback-memory', at: '2026-11-25T00:00:00.000Z' },
  { id: 'slot-config-dir', cause: 'slot-isolation', keys: {}, answer: '{seat}: run tests on node-b (pregate --light) with --config-dir <scratch>; local slot stays free', owner: '{seat}', deadlineMin: 20, next: 'pregate --light --host node-b', source: 'feedback-memory', at: '2026-11-25T00:00:00.000Z' },
];

/** First run: an absent ledger starts from the seed (the coordinator's feedback memories). */
export function ensureSeeded(path: string): void {
  if (existsSync(path)) return;
  for (const p of SEED_PRECEDENTS) appendPrecedent(path, p);
}

export function readPrecedents(path: string): Precedent[] {
  if (!existsSync(path)) return [];
  const out: Precedent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Precedent;
      if (p && typeof p.id === 'string' && (ADVISOR_CAUSES as readonly string[]).includes(p.cause) && typeof p.answer === 'string') out.push(p);
    } catch { /* a torn line is skipped */ }
  }
  return out;
}

export function appendPrecedent(path: string, p: Precedent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(p)}\n`);
}

/** Optional model judgment: pick one candidate id (or null) with the ledger in context. Never required. */
export type PrecedentJudge = (hand: Pick<OpenHand, 'id' | 'reason' | 'refs' | 'body'>, candidates: readonly Precedent[]) => string | null;

/**
 * The precedent for ✋ `hand`: same cause, every precedent key equal to the hand's context key. Most specific wins, newest
 * on ties. With several equally specific candidates and a judge, the judge picks.
 */
export function matchPrecedent(hand: Pick<OpenHand, 'id' | 'reason' | 'refs' | 'body'>, ledger: readonly Precedent[], judge?: PrecedentJudge): Precedent | null {
  const cause = causeOfReason(hand.reason);
  const ctx = handContextKeys(hand.refs);
  const fits = ledger.filter((p) => p.cause === cause && Object.entries(p.keys).every(([k, v]) => ctx[k] === v));
  if (fits.length === 0) return null;
  const best = Math.max(...fits.map((p) => Object.keys(p.keys).length));
  const top = fits.filter((p) => Object.keys(p.keys).length === best).sort((a, b) => b.at.localeCompare(a.at));
  if (top.length > 1 && judge) {
    try { const id = judge(hand, top); const chosen = top.find((p) => p.id === id); if (chosen) return chosen; } catch { /* judge failure = deterministic pick */ }
  }
  return top[0]!;
}

export function fillTemplate(template: string, hand: Pick<OpenHand, 'blockedSeat' | 'refs'>): string {
  const ctx = handContextKeys(hand.refs);
  return template.replaceAll('{seat}', hand.blockedSeat).replace(/\{key:([a-z0-9_-]+)\}/gi, (_m, k: string) => ctx[k] ?? `<${k}>`);
}

// ── events (metrics source) ───────────────────────────────────────────────────────────────────

export const ADVISOR_EVENT_KINDS = ['steward', 'resolved', 'recommended', 'picked', 'auto', 'escalated'] as const;
export type AdvisorEventKind = typeof ADVISOR_EVENT_KINDS[number];
export interface AdvisorEvent { readonly at: number; readonly kind: AdvisorEventKind; readonly handId: number; readonly cause: AdvisorCause; readonly precedent?: string }

export function readAdvisorEvents(path: string): AdvisorEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as AdvisorEvent]; } catch { return []; } });
}

export interface AdvisorMetrics { resolved: number; recommended: number; picked: number; auto: number; escalated: number; steward: number; tcOpen: number }

export function advisorMetrics(events: readonly AdvisorEvent[], sinceMs: number, tcOpen: number): AdvisorMetrics {
  const m: AdvisorMetrics = { resolved: 0, recommended: 0, picked: 0, auto: 0, escalated: 0, steward: 0, tcOpen };
  for (const e of events) if (e.at >= sinceMs) m[e.kind] += 1;
  return m;
}

/** Status board / op-pulse line: `🧭 TC-ADV 30m — resolved 9 · recommended 4 · TC-picked 2 · auto 1 · escalated 1 · steward 20 · TC ✋ open 3`. */
export function advisorBoardLine(advisor: string, coordinator: string, m: AdvisorMetrics, windowLabel = '30m'): string {
  return `🧭 ${advisor} ${windowLabel} — resolved ${m.resolved} · recommended ${m.recommended} · ${coordinator}-picked ${m.picked} · auto ${m.auto} · escalated ${m.escalated} · steward ${m.steward} · ${coordinator} ✋ open ${m.tcOpen}`;
}

// ── the tick ──────────────────────────────────────────────────────────────────────────────────

/** The deterministic space steward resolver (fix/writer-resolver). Absent = resolves nothing. It writes its own outcome. */
export type StewardResolver = (hand: OpenHand) => { readonly resolved: boolean };

export interface AdvisorDeps extends HandLadderDeps {
  readonly advisor: string;
  readonly coordinator: string;
  readonly precedentsPath: string;
  readonly eventsPath: string;
  readonly steward?: StewardResolver;
  readonly judge?: PrecedentJudge;
  /** true = write outcomes and cards; false = shadow (decide and record «would», write nothing). */
  readonly live: boolean;
}

export type AdvisorStep =
  | { readonly kind: 'steward' | 'resolved' | 'recommended' | 'picked' | 'auto' | 'escalated'; readonly handId: number; readonly cause: AdvisorCause; readonly precedent?: string; readonly cardId?: number }
  | { readonly kind: 'waiting'; readonly handId: number; readonly cause: AdvisorCause };

const cardKey = (advisor: string, handId: number): string => `advisor-rec:${advisor}:${handId}`;

function record(deps: AdvisorDeps, e: AdvisorEvent): void {
  if (!deps.live) return;
  mkdirSync(dirname(deps.eventsPath), { recursive: true });
  appendFileSync(deps.eventsPath, `${JSON.stringify(e)}\n`);
}

function resolveWith(store: MsgStore, hand: OpenHand, p: Precedent, deps: AdvisorDeps, via: string): void {
  const owner = p.owner === '{seat}' ? hand.blockedSeat : p.owner;
  const deadline = new Date(deps.now() + p.deadlineMin * 60_000).toISOString();
  applyHandOutcome(store, {
    msgId: hand.id, action: 'resolve', owner, deadline,
    text: `${fillTemplate(p.answer, hand)} · next: ${fillTemplate(p.next, hand)} · (${via} · precedent ${p.id})`,
  }, deps);
}

/** The coordinator's pick on a card: a mail from the coordinator with ref `advisor-pick:<handId>:<option>` (option 1-based). */
function readPick(store: MsgStore, coordinator: string, handId: number, afterId: number): number | null {
  const row = store.db.query(`SELECT refs_json FROM msg_messages WHERE id > ? AND sender = ? AND refs_json LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(afterId, coordinator, `%"advisor-pick:${handId}:%`) as { refs_json: string } | null;
  if (!row) return null;
  try {
    const refs = JSON.parse(row.refs_json) as string[];
    const ref = refs.find((r) => r.startsWith(`advisor-pick:${handId}:`));
    const n = Number(ref?.split(':')[2]);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  } catch { return null; }
}

export interface RecommendationOption { readonly label: string; readonly precedent?: Precedent }

/** Options for a card: the matched precedent (if any) first, then hold-with-owner, then escalate. */
export function recommendationOptions(hand: OpenHand, match: Precedent | null): RecommendationOption[] {
  const opts: RecommendationOption[] = [];
  if (match) opts.push({ label: `apply precedent ${match.id}: ${fillTemplate(match.answer, hand)}`, precedent: match });
  opts.push({ label: `hold — ${hand.blockedSeat} keeps the cell, ${ADVISOR_DEFAULT_DEADLINE_MIN}m deadline, TC names the next step` });
  opts.push({ label: 'escalate to OP (cross-space / budget / policy)' });
  return opts;
}

export function adviseTick(store: MsgStore, deps: AdvisorDeps): AdvisorStep[] {
  const steps: AdvisorStep[] = [];
  const ledger = readPrecedents(deps.precedentsPath);
  const now = deps.now();
  const hands = openHands(store, { now, ladder: deps.ladder, involving: deps.coordinator }).filter((h) => h.receiver === deps.coordinator);
  for (const hand of hands) {
    const cause = causeOfReason(hand.reason);
    const routine = ROUTINE_CAUSES.includes(cause);
    try {
      const card = store.findByProvenanceKey(cardKey(deps.advisor, hand.id));
      if (card) {
        const pick = readPick(store, deps.coordinator, hand.id, card.id);
        const options = recommendationOptions(hand, matchPrecedent(hand, ledger, deps.judge));
        if (pick !== null && options[pick - 1]) {
          const chosen = options[pick - 1]!;
          if (deps.live) {
            if (chosen.precedent) resolveWith(store, hand, chosen.precedent, deps, `${deps.coordinator} picked`);
            else if (chosen.label.startsWith('escalate')) applyHandOutcome(store, { msgId: hand.id, action: 'escalate', text: `${deps.coordinator} chose escalate (advisor card #${card.id})` }, deps);
            else applyHandOutcome(store, { msgId: hand.id, action: 'resolve', owner: hand.blockedSeat, deadline: new Date(now + ADVISOR_DEFAULT_DEADLINE_MIN * 60_000).toISOString(), text: `hold — ${chosen.label} (${deps.coordinator} picked)` }, deps);
          }
          record(deps, { at: now, kind: 'picked', handId: hand.id, cause, ...(chosen.precedent ? { precedent: chosen.precedent.id } : {}) });
          steps.push({ kind: 'picked', handId: hand.id, cause });
          continue;
        }
        const silent = now - Date.parse(card.createdAt) >= ADVISOR_PICK_WINDOW_MS
          || hand.waitedMs >= HAND_AUTO_ESCALATE_AFTER_MS - ADVISOR_LADDER_MARGIN_MS;
        if (!silent) { steps.push({ kind: 'waiting', handId: hand.id, cause }); continue; }
        const recommended = options[0]!;
        if (routine && recommended.precedent) {
          if (deps.live) resolveWith(store, hand, recommended.precedent, deps, `${deps.advisor} auto-applied after ${deps.coordinator} silence`);
          record(deps, { at: now, kind: 'auto', handId: hand.id, cause, precedent: recommended.precedent.id });
          steps.push({ kind: 'auto', handId: hand.id, cause, precedent: recommended.precedent.id });
        } else {
          if (deps.live) applyHandOutcome(store, { msgId: hand.id, action: 'escalate', text: `${deps.coordinator} silent on advisor card #${card.id} (${cause}) — judgment needed` }, deps);
          record(deps, { at: now, kind: 'escalated', handId: hand.id, cause });
          steps.push({ kind: 'escalated', handId: hand.id, cause });
        }
        continue;
      }
      if (deps.steward) {
        let done = false;
        try { done = deps.steward(hand).resolved; } catch { done = false; }
        if (done) { record(deps, { at: now, kind: 'steward', handId: hand.id, cause }); steps.push({ kind: 'steward', handId: hand.id, cause }); continue; }
      }
      const match = matchPrecedent(hand, ledger, deps.judge);
      if (routine && match) {
        if (deps.live) resolveWith(store, hand, match, deps, deps.advisor);
        record(deps, { at: now, kind: 'resolved', handId: hand.id, cause, precedent: match.id });
        steps.push({ kind: 'resolved', handId: hand.id, cause, precedent: match.id });
        continue;
      }
      const options = recommendationOptions(hand, match);
      let cardId: number | undefined;
      if (deps.live) {
        const mail = store.appendWithProvenance({
          from: deps.advisor, to: deps.coordinator, kind: 'request', intent: 'decision', replyTo: hand.id,
          refs: [cardKey(deps.advisor, hand.id), `advisor-card:${hand.id}`, `advisor-class:${routine && match ? "routine" : "judgment"}`],
          body: `[🧭 ${deps.advisor} · recommendation · ✋ #${hand.id} ${hand.blockedSeat} · ${cause}] `
            + options.map((o, i) => `${i + 1}) ${o.label}${i === 0 ? ' ← recommended' : ''}`).join(' · ')
            + ` · evidence: reason ${hand.reason}${match ? ` · precedent ${match.id} (${match.source})` : ' · no precedent'} · waited ${Math.floor(hand.waitedMs / 60_000)}m`
            + ` · pick: eln msg post --from ${deps.coordinator} --to ${deps.advisor} --ref advisor-pick:${hand.id}:<n> --body "<n>"`
            + ` · silent ${ADVISOR_PICK_WINDOW_MS / 60_000}m → ${routine && match ? 'option 1 applies' : 'escalates to OP'}`,
        }, cardKey(deps.advisor, hand.id));
        cardId = mail.id;
      }
      record(deps, { at: now, kind: 'recommended', handId: hand.id, cause, ...(match ? { precedent: match.id } : {}) });
      steps.push({ kind: 'recommended', handId: hand.id, cause, ...(match ? { precedent: match.id } : {}), ...(cardId ? { cardId } : {}) });
    } catch (error) {
      try { deps.log?.('advisor.step-failed', { handId: hand.id, error: String(error).slice(0, 200) }); } catch { /* fail-open */ }
    }
  }
  return steps;
}

// ── learning: coordinator decisions → precedents ──────────────────────────────────────────────

/**
 * Every resolve the coordinator wrote itself (not via the advisor — those carry «precedent <id>») on a ✋ becomes a
 * precedent: {cause of the ✋, its ctx keys, the decision text as the template}. Idempotent by outcome mail id.
 */
export function learnFromCoordinator(store: MsgStore, deps: Pick<AdvisorDeps, 'coordinator' | 'precedentsPath' | 'now'>, sinceMs: number): Precedent[] {
  const known = new Set(readPrecedents(deps.precedentsPath).map((p) => p.id));
  const rows = store.db.query(`SELECT id, body, refs_json, created_at FROM msg_messages WHERE sender = ? AND created_at >= ? AND refs_json LIKE '%"hand-outcome:resolve"%' ORDER BY id ASC`)
    .all(deps.coordinator, new Date(sinceMs).toISOString()) as { id: number; body: string; refs_json: string; created_at: string }[];
  const learned: Precedent[] = [];
  for (const row of rows) {
    const id = `tc-${row.id}`;
    if (known.has(id)) continue;
    let refs: string[] = [];
    try { refs = JSON.parse(row.refs_json) as string[]; } catch { continue; }
    if (refs.some((r) => r.startsWith('advisor-precedent:'))) continue;
    const handId = Number(refs.find((r) => r.startsWith('hand-msg:'))?.slice('hand-msg:'.length));
    if (!Number.isSafeInteger(handId)) continue;
    const handRow = store.db.query('SELECT refs_json FROM msg_messages WHERE id = ?').get(handId) as { refs_json: string } | null;
    if (!handRow) continue;
    let handRefs: string[] = [];
    try { handRefs = JSON.parse(handRow.refs_json) as string[]; } catch { continue; }
    const reason = handRefs.find((r) => r.startsWith('reason:'))?.slice('reason:'.length) ?? '';
    const text = row.body.replace(/^\[✋[^\]]*\]\s*/, '');
    if (text.includes('precedent ')) continue; // the advisor's own resolves (written as the coordinator) are not new precedents
    const p: Precedent = {
      id, cause: causeOfReason(reason), keys: handContextKeys(handRefs), answer: text, owner: '{seat}',
      deadlineMin: ADVISOR_DEFAULT_DEADLINE_MIN, next: '{seat} continues', source: 'coordinator-decision', at: row.created_at,
    };
    appendPrecedent(deps.precedentsPath, p);
    learned.push(p);
  }
  return learned;
}

// ── 30-min digest ─────────────────────────────────────────────────────────────────────────────

export function advisorDigest(store: MsgStore, deps: Pick<AdvisorDeps, 'advisor' | 'coordinator' | 'eventsPath' | 'now' | 'ladder' | 'live'>): { body: string; mailId: number | null } {
  const now = deps.now();
  const slot = Math.floor(now / ADVISOR_DIGEST_EVERY_MS);
  const open = openHands(store, { now, ladder: deps.ladder, involving: deps.coordinator }).filter((h) => h.receiver === deps.coordinator);
  const byCause = new Map<string, number>();
  for (const h of open) byCause.set(causeOfReason(h.reason), (byCause.get(causeOfReason(h.reason)) ?? 0) + 1);
  const events = readAdvisorEvents(deps.eventsPath);
  const m = advisorMetrics(events, now - ADVISOR_DIGEST_EVERY_MS, open.length);
  const waiting = open.filter((h) => store.findByProvenanceKey(cardKey(deps.advisor, h.id))).map((h) => `#${h.id}`);
  const body = `[🧭 ${deps.advisor} · 30m digest] open ✋ by cause: ${[...byCause].map(([c, n]) => `${c} ${n}`).join(' · ') || 'none'}`
    + ` · ${advisorBoardLine(deps.advisor, deps.coordinator, m)} · waits for ${deps.coordinator}: ${waiting.join(' ') || 'none'}`;
  if (!deps.live) return { body, mailId: null };
  const key = `advisor-digest:${deps.advisor}:${slot}`;
  const before = store.findByProvenanceKey(key);
  if (before) return { body: before.body, mailId: before.id };
  const mail = store.appendWithProvenance({ from: deps.advisor, to: deps.coordinator, kind: 'info', intent: 'info', refs: [key], body }, key);
  return { body, mailId: mail.id };
}

/** Live paths: `<instance root>/advisor/<SEAT>/{precedents,events}.jsonl` (the universe's instance root — test universe stays apart). */
export function advisorPaths(advisor: string, base = defaultAdvisorBase()): { precedentsPath: string; eventsPath: string } {
  const dir = join(base, 'advisor', advisor.toUpperCase());
  return { precedentsPath: join(dir, 'precedents.jsonl'), eventsPath: join(dir, 'events.jsonl') };
}

function defaultAdvisorBase(): string {
  try { return effectiveInstanceRoot(); } catch { return elanousStateRoot(); }
}

/**
 * Board lines for every declared advisor (federation.yaml role `advisor` ⊕ parent) that has an events ledger.
 * One line per advisor; null when none. Read-only (the msg ledger is opened read-only).
 */
export function liveAdvisorBoardLines(now: number): string | null {
  const { loadDeclaredSeatRoles, loadFederationLadder, openHands: open } = require('../../msg/hand-raise-ladder.js') as typeof import('../../msg/hand-raise-ladder.js');
  const roles = loadDeclaredSeatRoles();
  const advisors = Object.entries(roles).filter(([, r]) => r === ADVISOR_ROLE).map(([id]) => id);
  if (advisors.length === 0) return null;
  const { readWorkspaceFile } = require('../../els/workspace-config.js') as typeof import('../../els/workspace-config.js');
  const decl = readWorkspaceFile(process.cwd(), homedir());
  const { defaultMsgStorePath, openMsgStoreReadOnly } = require('../../msg/msg-store.js') as typeof import('../../msg/msg-store.js');
  const store = openMsgStoreReadOnly(defaultMsgStorePath());
  try {
    const ladder = loadFederationLadder();
    const lines: string[] = [];
    for (const advisor of advisors) {
      const seats = (decl.config?.seats ?? {}) as Record<string, import('../../els/workspace-config.js').SeatConfig>;
      const seat = Object.values(seats).find((s) => s.id.toUpperCase() === advisor);
      const coordinator = (seat?.parent ?? advisor.replace(/-ADV$/, '')).toUpperCase();
      const paths = advisorPaths(advisor);
      if (!existsSync(paths.eventsPath)) continue;
      const openCount = open(store, { now, ladder, involving: coordinator }).filter((h) => h.receiver === coordinator).length;
      lines.push(advisorBoardLine(advisor, coordinator, advisorMetrics(readAdvisorEvents(paths.eventsPath), now - ADVISOR_DIGEST_EVERY_MS, openCount)));
    }
    return lines.length ? lines.join('\n') : null;
  } finally { store.close(); }
}
