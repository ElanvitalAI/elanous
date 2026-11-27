// HAND-RAISE-LADDER (대표 11-25 «구조가 문제다 — 반드시 위로 올리든지, 기각하든지, 해결하든지») — every ✋ NEED HUMAN mail
// ends in exactly one outcome by its receiver, and the system climbs the federation ladder when the receiver does not.
//
// S: six ✋ mails to sub-coordinator TC sat 15–30 min unanswered (11-25 11:57~) with zero escalation events: TC's turn was
//    inside a blocking wait, the turn end marked the mail `responded`, the next TUI had no working timer, and #40053's
//    only rule (20 min → CLAUDE-OP) skipped the hierarchy.
// C: a receiver may never be a dead end. The decision cannot depend on the receiver's model noticing anything.
// Q: what closes a ✋, who climbs when nobody does, and where does the ladder come from?
// A: three outcomes, all ledger rows (structured refs — never the body):
//      RESOLVE  = a reply to the blocked seat (reply_to = chain root) with `hand-outcome:resolve`
//      REJECT   = the same with `hand-outcome:reject` (the text is the reason)
//      ESCALATE = a new ✋ mail to the receiver's parent with `hand-escalated-from:<msgId>` (one line of context)
//    One outcome per chain: the resolve/reject row is written under provenance key `hand-outcome:<root>` and an escalation
//    under `hand-escalate:<msgId>` — a second writer gets the stored row back (atomic, no double posts across TUIs).
//    Timer: a ✋ open at its receiver for 10 min is auto-escalated one level (`needhuman.auto-escalated`) and the receiver
//    is told; at the HQ coordinator (OP) the next level is the CEO decision card (`decisions raise`) ⊕ a copy to CLAUDE-OP.
//    Parent = the federation map (els journal workspaces · federation.yaml spaces / hq) — hand → its space coordinator →
//    HQ coordinator → CEO. The sweep is stateless (ledger only), so any live TUI involved (the blocked seat, the receiver)
//    or `eln msg hand sweep` can run it and the result is the same.
//
// 세 얼굴:
//   관측 = needhuman.auto-escalated {from,to,msgId,waitedMin} · needhuman.resolved / .rejected / .escalated · needhuman.ceo-card
//          · needhuman.bulk · `eln msg hand board` / els status-board «✋ Open hands» line
//   인지 = isHandRaiseMail (refs block: ⊕ reason:) · handClosedOn (outcome / escalation / reply rows) · federation ladder
//   수복과 인계 = auto-escalation one level per 10 min up to the CEO card · bulk same-rule item · wait preemption

import { liveWipTakeoverRule } from '../seat/seat-assign-wip1.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { canonicalMessageAddress, type Message, type MessageEnvelope, type MsgStore } from './msg-store.js';
import { humanLeadAction, humanLeadOutcomeText } from '../seat/space-lead.js';

export const HAND_AUTO_ESCALATE_AFTER_MS = 10 * 60_000;
/** The receiver's own P0 reminder (before the system climbs for it). */
export const HAND_REMIND_AFTER_MS = 5 * 60_000;
/** Hands older than this are not swept (the ladder is three 10-minute steps; the CEO card persists on its own). */
export const HAND_SWEEP_WINDOW_MS = 2 * 60 * 60_000;
/** Same-shape hands at one receiver that become one «change the rule» item. */
export const HAND_BULK_MIN = 3;
export const HAND_CEO = 'CEO';
export const HAND_CEO_COPY_TO = 'CLAUDE-OP';

export type HandAction = 'resolve' | 'reject' | 'escalate';
export const HAND_ACTIONS: readonly HandAction[] = ['resolve', 'reject', 'escalate'];

/** A ✋ NEED HUMAN mail: NEED-HUMAN-PUSH (and every escalation) carries `block:<id>` and `reason:<code>` refs. */
export function isHandRaiseMail(m: { readonly refs?: readonly string[] | null }): boolean {
  const refs = m.refs ?? [];
  return refs.some((r) => r.startsWith('block:')) && refs.some((r) => r.startsWith('reason:'));
}

const refValue = (refs: readonly string[] | undefined, prefix: string): string | undefined =>
  refs?.find((r) => r.startsWith(prefix))?.slice(prefix.length);

// ── federation ladder ─────────────────────────────────────────────────────────────────────────

export interface FederationSpace { readonly coordinator?: string | null; readonly seats: readonly string[] }
export interface FederationLadder {
  readonly hq: string;
  /** hand → its space coordinator · coordinator → HQ · HQ → CEO · unknown seat → HQ. */
  parentOf(seat: string): string;
  /** 0 = CEO · 1 = HQ · 2 = space coordinator · 3 = hand (for ordering the board). */
  depthOf(seat: string): number;
}

const canon = (seat: string): string => { try { return canonicalMessageAddress(seat); } catch { return seat.trim().toUpperCase(); } };

/** Pure: the ladder from a declared HQ coordinator and the spaces (coordinator ⊕ member seats). */
export function buildFederationLadder(input: { readonly hq?: string | null; readonly spaces: readonly FederationSpace[] }): FederationLadder {
  const hq = canon(input.hq?.trim() ? input.hq : 'OP');
  const coordinators = new Set<string>();
  const memberOf = new Map<string, string>();
  for (const space of input.spaces) {
    const coordinator = space.coordinator?.trim() ? canon(space.coordinator) : null;
    if (!coordinator) continue;
    coordinators.add(coordinator);
    for (const raw of space.seats) {
      const seat = canon(raw);
      if (seat !== coordinator && !memberOf.has(seat)) memberOf.set(seat, coordinator);
    }
  }
  const parentOf = (raw: string): string => {
    const seat = canon(raw);
    if (seat === HAND_CEO) return HAND_CEO;
    if (seat === hq) return HAND_CEO;
    if (coordinators.has(seat)) return hq;
    return memberOf.get(seat) ?? hq;
  };
  const depthOf = (raw: string): number => {
    const seat = canon(raw);
    if (seat === HAND_CEO) return 0;
    if (seat === hq) return 1;
    return coordinators.has(seat) ? 2 : 3;
  };
  return { hq, parentOf, depthOf };
}

interface JournalLike {
  readonly hqCoordinatorSeat?: string;
  readonly workspaces?: readonly { readonly id?: string; readonly coordinatorSeat?: string }[];
  readonly tabs?: readonly { readonly id?: string; readonly workspaceId?: string }[];
  readonly panes?: readonly { readonly tabId?: string; readonly cwd?: string; readonly seatIdentity?: string }[];
}

const seatOfCwd = (cwd: string | undefined): string | null => {
  if (!cwd) return null;
  const i = cwd.lastIndexOf('/seats/');
  if (i < 0) return null;
  const seat = cwd.slice(i + '/seats/'.length).split('/')[0] ?? '';
  return seat.length > 0 ? seat : null;
};

/** Pure: the spaces of an els journal (workspace coordinator ⊕ the seats of its panes). */
export function spacesOfElsJournal(journal: JournalLike): { hq?: string; spaces: FederationSpace[] } {
  const wsOfTab = new Map<string, string>();
  for (const tab of journal.tabs ?? []) if (tab.id && tab.workspaceId) wsOfTab.set(tab.id, tab.workspaceId);
  const seatsOf = new Map<string, string[]>();
  for (const pane of journal.panes ?? []) {
    const ws = pane.tabId ? wsOfTab.get(pane.tabId) : undefined;
    const seat = pane.seatIdentity ?? seatOfCwd(pane.cwd);
    if (!ws || !seat) continue;
    const list = seatsOf.get(ws) ?? [];
    list.push(seat);
    seatsOf.set(ws, list);
  }
  const spaces = (journal.workspaces ?? []).filter((ws) => ws.coordinatorSeat)
    .map((ws) => ({ coordinator: ws.coordinatorSeat!, seats: seatsOf.get(ws.id ?? '') ?? [] }));
  return { ...(journal.hqCoordinatorSeat ? { hq: journal.hqCoordinatorSeat } : {}), spaces };
}

/**
 * The live ladder: the els journal (`<state>/els/journal.json` — the running federation) merged with the workspace
 * declaration (federation.yaml). Unreadable sources contribute nothing; with no declared HQ the root is OP.
 */
export function loadFederationLadder(deps: { journalPath?: string; cwd?: string; home?: string } = {}): FederationLadder {
  const spaces: FederationSpace[] = [];
  let hq: string | undefined;
  try {
    let path = deps.journalPath;
    if (!path) {
      const { elsJournalPath } = require('../els/journal.js') as typeof import('../els/journal.js');
      path = elsJournalPath();
    }
    if (existsSync(path)) {
      const fromJournal = spacesOfElsJournal(JSON.parse(readFileSync(path, 'utf8')) as JournalLike);
      spaces.push(...fromJournal.spaces);
      hq = fromJournal.hq;
    }
  } catch { /* an unreadable journal declares nothing */ }
  try {
    const { readWorkspaceFile } = require('../els/workspace-config.js') as typeof import('../els/workspace-config.js');
    const decl = readWorkspaceFile(deps.cwd ?? process.cwd(), deps.home ?? homedir());
    if (decl.path && decl.config) {
      hq ??= decl.config.hq?.coordinator;
      for (const space of Object.values(decl.config.spaces)) spaces.push({ coordinator: space.coordinator, seats: space.seats });
    }
  } catch { /* an unreadable declaration declares nothing */ }
  try {
    // Org map (src/org/org-map.ts): an explicitly declared escalation-parent wins; declared advisors/stewards hang under
    // their space leader. Undeclared org = today's ladder unchanged.
    const orgMod = require('../org/org-map.js') as typeof import('../org/org-map.js');
    const orgDeps = { cwd: deps.cwd ?? process.cwd(), home: deps.home ?? homedir() };
    const declaredHq = orgMod.orgDutyDeclared('escalation-parent', orgDeps);
    if (declaredHq) hq = declaredHq;
    const loaded = orgMod.loadOrgMap(orgDeps);
    if (loaded.declared) for (const sp of Object.values(loaded.org.spaces)) {
      const under = [sp.advisor, sp.steward].filter((s): s is string => Boolean(s));
      if (under.length) spaces.push({ coordinator: sp.leader, seats: under });
    }
  } catch { /* an unreadable org map changes nothing */ }
  return buildFederationLadder({ ...(hq ? { hq } : {}), spaces });
}

/** seat → its federation.yaml `role` (upper-case seat ids). Unreadable declaration = {} (prefix rules still apply). */
export function loadDeclaredSeatRoles(deps: { cwd?: string; home?: string } = {}): Record<string, string> {
  try {
    const { readWorkspaceFile } = require('../els/workspace-config.js') as typeof import('../els/workspace-config.js');
    const decl = readWorkspaceFile(deps.cwd ?? process.cwd(), deps.home ?? homedir());
    const out: Record<string, string> = {};
    for (const seat of Object.values(decl.config?.seats ?? {}) as { id: string; role?: string }[]) if (seat.role) out[seat.id.toUpperCase()] = seat.role;
    return out;
  } catch { return {}; }
}

// ── ledger reads ──────────────────────────────────────────────────────────────────────────────

export interface HandMail {
  readonly id: number;
  /** Who raised (or forwarded) this ✋. */
  readonly sender: string;
  /** Who must give the outcome. */
  readonly receiver: string;
  /** The first ✋ of the chain (the blocked seat's own mail). */
  readonly rootId: number;
  /** The blocked seat (refs `seat:`, else the root sender). */
  readonly blockedSeat: string;
  readonly blockId: string;
  readonly reason: string;
  readonly correlationId?: string;
  readonly createdAtMs: number;
  readonly body: string;
  readonly refs?: readonly string[];
}

export type HandClosedBy = 'resolved' | 'rejected' | 'escalated' | 'replied';

interface Row { id: number; sender: string; recipient: string; body: string; reply_to: number | null; created_at: string; refs_json: string | null; correlation_id?: string | null }

const hasColumn = (store: Pick<MsgStore, 'db'>, name: string): boolean =>
  (store.db.query("SELECT COUNT(*) AS n FROM pragma_table_info('msg_messages') WHERE name = ?").get(name) as { n: number }).n > 0;

const parseRefs = (json: string | null): string[] => {
  if (!json) return [];
  try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

function handOfRow(row: Row): HandMail | null {
  const refs = parseRefs(row.refs_json);
  if (!isHandRaiseMail({ refs })) return null;
  const root = Number(refValue(refs, 'hand-of:'));
  return {
    id: row.id, sender: row.sender, receiver: row.recipient,
    rootId: Number.isSafeInteger(root) && root > 0 ? root : row.id,
    blockedSeat: refValue(refs, 'seat:') ?? row.sender,
    blockId: refValue(refs, 'block:') ?? '', reason: refValue(refs, 'reason:') ?? '',
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    createdAtMs: Date.parse(row.created_at), body: row.body, refs,
  };
}

const ROW_COLUMNS = (store: Pick<MsgStore, 'db'>): string =>
  `id, sender, recipient, body, reply_to, created_at, refs_json${hasColumn(store, 'correlation_id') ? ', correlation_id' : ''}`;

/** One ✋ mail by id (null when the row is missing or is not a ✋). */
export function readHandMail(store: Pick<MsgStore, 'db'>, msgId: number): HandMail | null {
  if (!hasColumn(store, 'refs_json')) return null;
  const row = store.db.query(`SELECT ${ROW_COLUMNS(store)} FROM msg_messages WHERE id = ?`).get(msgId) as Row | null;
  return row ? handOfRow(row) : null;
}

/** Every ✋ mail created at/after `sinceMs` (oldest first). */
export function readHandMailsSince(store: Pick<MsgStore, 'db'>, sinceMs: number): HandMail[] {
  if (!hasColumn(store, 'refs_json')) return [];
  const rows = store.db.query(`SELECT ${ROW_COLUMNS(store)} FROM msg_messages
    WHERE created_at >= ? AND refs_json LIKE '%"block:%' AND refs_json LIKE '%"reason:%' ORDER BY id ASC`)
    .all(new Date(sinceMs).toISOString()) as Row[];
  return rows.map(handOfRow).filter((h): h is HandMail => h !== null);
}

const like = (ref: string): string => `%${JSON.stringify(ref)}%`;

/**
 * How ✋ #id was closed, or null while it is open:
 *   resolved / rejected = an outcome row on its chain · escalated = a forward from it (or the same block already at the
 *   receiver's parent — the blocked seat's own 5-min push) · replied = the receiver (or CLAUDE-OP) replied to its sender.
 */
export function handClosedOn(store: Pick<MsgStore, 'db'>, hand: HandMail, ladder?: Pick<FederationLadder, 'parentOf'>): HandClosedBy | null {
  // BEACON-LADDER ②: a «resolve» that keeps the hand waiting (HOLD/유지/wait) without owner ⊕ deadline is no outcome.
  const outcomes = store.db.query(`SELECT body, refs_json FROM msg_messages WHERE id > ? AND refs_json LIKE ?
    AND (refs_json LIKE ? OR refs_json LIKE ?) ORDER BY id ASC`)
    .all(hand.rootId, like(`hand-of:${hand.rootId}`), like('hand-outcome:resolve'), like('hand-outcome:reject')) as { body: string; refs_json: string }[];
  for (const outcome of outcomes) {
    const refs = parseRefs(outcome.refs_json);
    if (refs.includes('hand-outcome:reject')) return 'rejected';
    if (!keepsWaiting(outcome.body, refs)) return 'resolved';
  }
  if (store.db.query('SELECT 1 FROM msg_messages WHERE id > ? AND refs_json LIKE ? LIMIT 1').get(hand.id, like(`hand-escalated-from:${hand.id}`))) return 'escalated';
  if (ladder && hand.blockId) {
    const parent = ladder.parentOf(hand.receiver);
    if (parent !== HAND_CEO && store.db.query(`SELECT 1 FROM msg_messages WHERE id > ? AND recipient = ? AND refs_json LIKE ? AND refs_json LIKE '%"reason:%' LIMIT 1`)
      .get(hand.id, canon(parent), like(`block:${hand.blockId}`))) return 'escalated';
  }
  const responders = [canon(hand.receiver), HAND_CEO_COPY_TO];
  const correlation = hand.correlationId && hasColumn(store, 'correlation_id') ? ' OR correlation_id = ?' : '';
  const replies = store.db.query(`SELECT body, refs_json FROM msg_messages WHERE id > ? AND sender IN (?, ?) AND recipient = ?
    AND (reply_to = ?${correlation}) AND (refs_json IS NULL OR refs_json NOT LIKE '%"reason:%')
    AND (refs_json IS NULL OR refs_json NOT LIKE '%"hand-outcome:%') ORDER BY id ASC`)
    .all(...[hand.id, ...responders, canon(hand.sender), hand.id, ...(correlation ? [hand.correlationId!] : [])]) as { body: string; refs_json: string | null }[];
  return replies.some((r) => !keepsWaiting(r.body, parseRefs(r.refs_json))) ? 'replied' : null;
}

/**
 * BEACON-LADDER ② — a leader reply that keeps the hand waiting is not an outcome unless it names an owner ⊕ deadline
 * (refs `hand-owner:<seat>` ⊕ `hand-deadline:<iso>` — `eln msg hand <id> resolve "<text>" --owner <seat> --deadline <iso>`).
 */
export const HAND_HOLD_MARK = /\b(?:hold|wait|waiting|on hold)\b|유지|대기|보류|기다/i;
export function keepsWaiting(body: string, refs: readonly string[]): boolean {
  if (refs.some((r) => r.startsWith('hand-owner:')) && refs.some((r) => r.startsWith('hand-deadline:'))) return false;
  return HAND_HOLD_MARK.test(body.replace(/^\[✋[^\]]*\]/, ''));
}

/** The leader's last reply to the blocked seat on this chain (null = silent). */
export function lastLeaderReply(store: Pick<MsgStore, 'db'>, hand: Pick<HandMail, 'id' | 'receiver' | 'sender' | 'rootId'>): string | null {
  const row = store.db.query(`SELECT body FROM msg_messages WHERE id > ? AND sender = ? AND recipient = ? AND (reply_to IN (?, ?) OR refs_json LIKE ?) ORDER BY id DESC LIMIT 1`)
    .get(hand.rootId, canon(hand.receiver), canon(hand.sender), hand.id, hand.rootId, like(`hand-of:${hand.rootId}`)) as { body: string } | null;
  return row ? row.body : null;
}

export interface OpenHand extends HandMail { readonly waitedMs: number }

/** The ✋ mails still open (no outcome), newest window only. `involving` limits to hands this seat sent, holds or raised. */
export function openHands(store: Pick<MsgStore, 'db'>, input: { now: number; ladder?: Pick<FederationLadder, 'parentOf'>; involving?: string; windowMs?: number }): OpenHand[] {
  const who = input.involving ? canon(input.involving) : null;
  return readHandMailsSince(store, input.now - Math.max(HAND_SWEEP_WINDOW_MS, input.windowMs ?? 0))
    .filter((h) => !who || h.receiver === who || h.sender === who || canon(h.blockedSeat) === who)
    .filter((h) => handClosedOn(store, h, input.ladder) === null)
    .map((h) => ({ ...h, waitedMs: Math.max(0, input.now - h.createdAtMs) }));
}

// ── outcomes ──────────────────────────────────────────────────────────────────────────────────

export interface CeoCard { readonly title: string; readonly seat: string; readonly reason: string; readonly blockId: string; readonly summary: string; readonly msgId: number }

export interface HandLadderDeps {
  readonly ladder: FederationLadder;
  readonly now: () => number;
  /** The CEO rung — an `elanous decisions raise` card. */
  readonly raiseDecision: (card: CeoCard) => void;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** SPACE-LEAD-HUMAN — spaces led by a person (src/seat/space-lead.ts). Absent or empty = every lead is a tab. */
  readonly humanLead?: HumanLeadPort;
}

export interface HumanLeadOfSpace { readonly coordinator: string; readonly who: string; readonly escalateAfterMs: number }
export interface DecidedLeadCard { readonly decisionId: string; readonly msgId: number; readonly choice?: string; readonly note?: string; readonly via?: string }
/**
 * The human lead's channel: the decision ledger. `raiseCard` writes one card per ✋ (idempotent by ref `hand-lead:<msgId>` —
 * the existing Telegram / PWA card path delivers it with resolve / reject / escalate buttons); `decided` lists the cards the
 * person has answered, which the sweep executes as the ✋'s outcome.
 */
export interface HumanLeadPort {
  readonly leads: ReadonlyMap<string, HumanLeadOfSpace>;
  raiseCard(hand: OpenHand, lead: HumanLeadOfSpace): { readonly decisionId: string; readonly fresh: boolean };
  decided(): readonly DecidedLeadCard[];
}

export interface HandOutcomeResult {
  readonly action: HandAction;
  readonly msgId: number;
  /** The seat (or CEO) the outcome went to. */
  readonly to: string;
  readonly mailId: number | null;
  readonly output: string;
  /** The seat that gave the outcome (FED-FACT-OP-ACTIONS: the decision fact's by). */
  readonly by?: string;
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));
const oneLine = (text: string, max = 200): string => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
const safeLog = (deps: Pick<HandLadderDeps, 'log'>, event: string, data: Record<string, unknown>): void => { try { deps.log?.(event, data); } catch { /* observation never breaks the ladder */ } };

function rootOf(store: MsgStore, hand: HandMail): { id: number; sender: string; body: string } {
  if (hand.rootId === hand.id) return { id: hand.id, sender: hand.blockedSeat, body: hand.body };
  const root = store.getMessage(hand.rootId);
  return root ? { id: root.id, sender: refValue(root.refs, 'seat:') ?? root.from, body: root.body } : { id: hand.rootId, sender: hand.blockedSeat, body: hand.body };
}

/** The escalation envelope one level up: itself a ✋ mail (block:/reason: kept) so the parent's gate holds it the same way. */
function escalationEnvelope(store: MsgStore, hand: HandMail, to: string, text: string, auto: boolean, waitedMs: number): MessageEnvelope {
  const root = rootOf(store, hand);
  const head = auto ? `[✋ ESCALATED · ${hand.receiver} → ${to} · no outcome in ${minutes(waitedMs)}m]` : `[✋ ESCALATED · ${hand.receiver} → ${to}]`;
  return {
    from: hand.receiver, to, kind: 'request', intent: 'decision',
    ...(hand.correlationId ? { correlationId: hand.correlationId } : {}),
    refs: [`block:${hand.blockId}`, `seat:${root.sender}`, `reason:${hand.reason}`, `hand-of:${root.id}`, `hand-escalated-from:${hand.id}`, `hand-escalation:${auto ? 'auto' : 'manual'}`, ...(hand.refs?.filter((r) => r.startsWith('cause:')) ?? [])],
    body: `${head} ${oneLine(text)} · from ${root.sender} #${root.id}: ${oneLine(root.body, 240)} · `
      + `Close it with one outcome: HandRaise(action=resolve|reject|escalate, msgId=<this mail>) or eln msg hand <this mail> resolve|reject|escalate "<text>"`,
  };
}

/** Write `envelope` under provenance `key` unless that key exists — one IMMEDIATE transaction, so exactly one writer is fresh. */
export function appendOnce(store: MsgStore, key: string, envelope: () => MessageEnvelope): { mail: Message; fresh: boolean } {
  return store.db.transaction(() => {
    const before = store.findByProvenanceKey(key);
    if (before) return { mail: before, fresh: false };
    return { mail: store.appendWithProvenance(envelope(), key), fresh: true };
  }).immediate();
}

/** Forward ✋ `hand` to `to` exactly once (provenance `hand-escalate:<id>`). Returns the forward and whether this call wrote it. */
export function forwardOnce(store: MsgStore, hand: HandMail, to: string, text: string, auto: boolean, waitedMs: number, deps: HandLadderDeps, members?: readonly HandMail[], extraRefs: readonly string[] = []): { mail: Message; fresh: boolean } {
  const key = `hand-escalate:${hand.id}`;
  const also = [...(members ?? []).filter((m) => m.id !== hand.id).map((m) => `hand-escalated-from:${m.id}`), ...extraRefs];
  if (to !== HAND_CEO) return appendOnce(store, key, () => { const env = escalationEnvelope(store, hand, to, text, auto, waitedMs); return { ...env, refs: [...(env.refs ?? []), ...also] }; });
  const root = rootOf(store, hand);
  const written = appendOnce(store, key, () => ({
    from: hand.receiver, to: HAND_CEO_COPY_TO, kind: 'request', intent: 'alert',
    refs: [`needhuman:${hand.id}`, `hand-of:${root.id}`, `hand-escalated-from:${hand.id}`, ...also, 'hand-ceo', `block:${hand.blockId}`, `seat:${root.sender}`],
    body: `[✋ → CEO decision card · copy] ${hand.receiver} gave no outcome on ${root.sender}'s ✋ #${root.id}${auto ? ` in ${minutes(waitedMs)}m` : ''} — ${oneLine(text)} · ${oneLine(root.body, 240)}`,
  }));
  if (written.fresh) {
    try {
      deps.raiseDecision({ title: `[✋ NEED HUMAN · ${root.sender}] ${oneLine(root.body, 120)}`, seat: root.sender, reason: hand.reason, blockId: hand.blockId, msgId: hand.id,
        summary: `${root.sender} is blocked and ${hand.receiver} gave no outcome${auto ? ` in ${minutes(waitedMs)}m` : ''}: ${oneLine(text, 160)}. Choices: resume / stop / another way.` });
      safeLog(deps, 'needhuman.ceo-card', { msgId: hand.id, from: hand.receiver, seat: root.sender, copyMailId: written.mail.id });
    } catch (error) { safeLog(deps, 'needhuman.ceo-card-failed', { msgId: hand.id, error: String(error).slice(0, 200) }); }
  }
  return written;
}

/** The receiver gives its one outcome on ✋ #msgId. Throws (English message) when the mail is not an open ✋ of that receiver. */
export function applyHandOutcome(store: MsgStore, input: { msgId: number; action: HandAction; text: string; actor?: string; owner?: string; deadline?: string; via?: string }, deps: HandLadderDeps): HandOutcomeResult {
  if (!HAND_ACTIONS.includes(input.action)) throw new Error(`action must be resolve, reject or escalate (got ${String(input.action)})`);
  const text = (input.text ?? '').trim();
  if (!text) throw new Error(input.action === 'reject' ? 'reject needs a reason' : input.action === 'resolve' ? 'resolve needs the decision text' : 'escalate needs one line of context');
  const hand = readHandMail(store, input.msgId);
  if (!hand) throw new Error(`#${input.msgId} is not a ✋ NEED HUMAN mail`);
  // The receiver gives the outcome. A seat above it on the ladder (or CLAUDE-OP) may step in to resolve / reject;
  // escalation is the receiver's own move (the system escalates for it at 10 min).
  const by = input.actor ? canon(input.actor) : hand.receiver;
  if (by !== hand.receiver) {
    const above: string[] = [];
    for (let seat = deps.ladder.parentOf(hand.receiver); seat !== HAND_CEO && !above.includes(seat); seat = deps.ladder.parentOf(seat)) above.push(seat);
    const mayStepIn = input.action !== 'escalate' && (above.includes(by) || by === HAND_CEO_COPY_TO);
    if (!mayStepIn) throw new Error(`#${input.msgId} is ${hand.receiver}'s ✋ — ${by} cannot ${input.action} it`);
  }
  const closed = handClosedOn(store, hand);
  if (closed === 'resolved' || closed === 'rejected') throw new Error(`#${input.msgId} is already ${closed}`);
  if (input.action === 'escalate') {
    if (closed === 'escalated') throw new Error(`#${input.msgId} is already escalated`);
    const to = deps.ladder.parentOf(hand.receiver);
    const { mail } = forwardOnce(store, hand, to, text, false, deps.now() - hand.createdAtMs, deps);
    safeLog(deps, 'needhuman.escalated', { msgId: hand.id, from: hand.receiver, to, mailId: mail.id, auto: false });
    return { action: 'escalate', msgId: hand.id, to, mailId: mail.id, by,
      output: to === HAND_CEO ? `✋ #${hand.id} escalated to the CEO (decision card) · copy #${mail.id} to ${HAND_CEO_COPY_TO}` : `✋ #${hand.id} escalated to ${to} as #${mail.id}` };
  }
  const root = rootOf(store, hand);
  const label = input.action === 'resolve' ? 'RESOLVED' : 'REJECTED';
  const priorHolds = (store.db.query('SELECT COUNT(*) AS n FROM msg_messages WHERE id > ? AND refs_json LIKE ? AND refs_json LIKE ?')
    .get(root.id, like(`hand-of:${root.id}`), like('hand-outcome:resolve')) as { n: number }).n;
  const owner = input.owner?.trim() ? canon(input.owner) : '';
  const deadline = input.deadline?.trim() ?? '';
  if ((owner && !deadline) || (!owner && deadline)) throw new Error('a hold needs both --owner and --deadline');
  // LEADER-HAND-CONTRACT ① — a resolve that keeps the hand waiting without owner ⊕ deadline is refused at the door.
  if (input.action === 'resolve' && !owner && keepsWaiting(text, [])) {
    recordHoldReject(store, { msgId: hand.id, actor: by, via: input.via ?? 'tool', now: deps.now() });
    safeLog(deps, 'needhuman.hold-rejected', { msgId: hand.id, actor: by, via: input.via ?? 'tool' });
    throw new Error(holdRejectMessage(hand.id));
  }
  const written = appendOnce(store, priorHolds ? `hand-outcome:${root.id}:${priorHolds}` : `hand-outcome:${root.id}`, () => ({
    from: by, to: root.sender, kind: 'reply', intent: 'decision', replyTo: root.id,
    ...(hand.correlationId ? { correlationId: hand.correlationId } : {}),
    refs: [`hand-outcome:${input.action}`, `hand-of:${root.id}`, `hand-msg:${hand.id}`, ...(owner ? [`hand-owner:${owner}`, `hand-deadline:${deadline}`] : [])],
    body: `[✋ ${label} · ${by}]${owner ? ` owner ${owner} · by ${deadline} ·` : ''} ${input.action === 'reject' ? 'reason: ' : ''}${text}`,
  }));
  if (!written.fresh) throw new Error(`#${input.msgId} already has an outcome (#${written.mail.id})`);
  const mail = written.mail;
  // A forwarded ✋: the seat that forwarded it learns the outcome too.
  if (hand.sender !== root.sender && hand.sender !== by) {
    try {
      store.appendWithProvenance({ from: by, to: hand.sender, kind: 'info', intent: 'info', refs: [`hand-of:${root.id}`, `hand-msg:${hand.id}`],
        body: `[✋ ${label} · ${by}] ${root.sender}'s ✋ #${root.id} (you forwarded #${hand.id}): ${oneLine(text)}` }, `hand-outcome-copy:${hand.id}`);
    } catch { /* the outcome row is the fact; the copy is a courtesy */ }
  }
  safeLog(deps, input.action === 'resolve' ? 'needhuman.resolved' : 'needhuman.rejected', { msgId: hand.id, rootId: root.id, seat: by, to: root.sender, mailId: mail.id });
  return { action: input.action, msgId: hand.id, to: root.sender, mailId: mail.id, by, output: `✋ #${hand.id} ${input.action === 'resolve' ? 'resolved' : 'rejected'} → ${root.sender} #${mail.id}` };
}

// ── the timer (stateless sweep) ───────────────────────────────────────────────────────────────

export interface HandSweepAction { readonly msgId: number; readonly from: string; readonly to: string; readonly waitedMin: number; readonly mailId: number | null }

/**
 * Auto-escalate every open ✋ older than 10 min one level (exactly once per ✋), tell its receiver, log
 * `needhuman.auto-escalated`. Ledger-only and idempotent: any number of TUIs / `msg hand sweep` may run it.
 */
export function sweepHandRaises(store: MsgStore, deps: HandLadderDeps & { readonly involving?: string }): HandSweepAction[] {
  const now = deps.now();
  const done: HandSweepAction[] = [];
  applyHumanLeadDecisions(store, deps);
  const leads = deps.humanLead?.leads;
  const longest = leads?.size ? Math.max(...[...leads.values()].map((l) => l.escalateAfterMs)) + HAND_SWEEP_WINDOW_MS / 2 : 0;
  // BEACON-FLOOD (11-25 21:4x · 180 mails): one forward per cause (receiver · blocked seat · reason), never per ✋.
  const groups = dedupeHands(openHands(store, { now, ladder: deps.ladder, windowMs: longest, ...(deps.involving ? { involving: deps.involving } : {}) }));
  const membersOf = new Map(groups.map((g) => [g.lead.id, g.members] as const));
  for (const group of groups) {
    const hand = group.lead;
    const lead = leads?.get(canon(hand.receiver));
    if (lead) {
      try {
        const card = deps.humanLead!.raiseCard(hand, lead);
        if (card.fresh) safeLog(deps, 'needhuman.human-lead-card', { msgId: hand.id, space: lead.coordinator, who: lead.who, decisionId: card.decisionId, seat: hand.blockedSeat });
      } catch (error) { safeLog(deps, 'needhuman.human-lead-failed', { msgId: hand.id, step: 'card', error: String(error).slice(0, 200) }); }
    }
    if (hand.waitedMs < (lead ? lead.escalateAfterMs : HAND_AUTO_ESCALATE_AFTER_MS)) continue;
    if (canon(hand.receiver) === HAND_CEO_COPY_TO) continue; // the coach rung is the last tab rung
    const parent = deps.ladder.parentOf(hand.receiver);
    // BEACON-LADDER ③: past HQ the CEO card is only for CEO-only categories; everything else goes to the Claude OP coach.
    const to = parent === HAND_CEO && !isCeoOnlyHand(hand) ? HAND_CEO_COPY_TO : parent;
    if (to === hand.receiver) continue;
    // Escalation to HQ (OP) happens ONLY through the steward beacon card (one card per cause) — the timer never mails OP.
    if (canon(to) === canon(deps.ladder.hq)) continue;
    try {
      const { mail, fresh } = forwardOnce(store, hand, to, `${hand.receiver} gave no outcome (resolve / reject / escalate) in ${minutes(hand.waitedMs)}m${group.repeat > 1 ? ` · ×${group.repeat} same cause` : ''}`, true, hand.waitedMs, deps, membersOf.get(hand.id));
      if (!fresh) continue;
      const waitedMin = minutes(hand.waitedMs);
      safeLog(deps, 'needhuman.auto-escalated', { from: hand.receiver, to, msgId: hand.id, waitedMin, mailId: mail.id });
      try {
        store.appendWithProvenance({ from: hand.receiver, to: hand.receiver, kind: 'info', intent: 'info', refs: [`hand-told:${hand.id}`, `hand-of:${hand.rootId}`],
          body: `[✋ auto-escalated] ${hand.sender}'s ✋ #${hand.id} had no outcome from you in ${waitedMin}m — it went to ${to}${to === HAND_CEO ? ' (CEO decision card)' : ''}. You can still resolve or reject it: eln msg hand ${hand.id} resolve|reject "<text>"` }, `hand-told:${hand.id}`);
      } catch (error) { safeLog(deps, 'needhuman.tell-failed', { msgId: hand.id, error: String(error).slice(0, 200) }); }
      done.push({ msgId: hand.id, from: hand.receiver, to, waitedMin, mailId: mail.id });
    } catch (error) {
      safeLog(deps, 'needhuman.sweep-failed', { msgId: hand.id, error: String(error).slice(0, 200) });
    }
  }
  return done;
}

/**
 * Execute the human lead's answers: each decided `hand-lead:<msgId>` card becomes that ✋'s outcome, given in the name of the
 * space coordinator that held it (resolve / reject reach the blocked seat; escalate climbs one level). Already-closed ✋ are
 * skipped, so any number of sweeps may run this — the ladder's provenance keys keep it exactly once.
 */
export function applyHumanLeadDecisions(store: MsgStore, deps: HandLadderDeps): HandOutcomeResult[] {
  if (!deps.humanLead) return [];
  let cards: readonly DecidedLeadCard[] = [];
  try { cards = deps.humanLead.decided(); } catch (error) { safeLog(deps, 'needhuman.human-lead-failed', { step: 'read', error: String(error).slice(0, 200) }); return []; }
  const applied: HandOutcomeResult[] = [];
  for (const card of cards) {
    const action = humanLeadAction(card.choice);
    const hand = readHandMail(store, card.msgId);
    if (!action || !hand) continue;
    const closed = handClosedOn(store, hand);
    if (closed === 'resolved' || closed === 'rejected' || (action === 'escalate' && closed === 'escalated')) continue;
    const who = deps.humanLead.leads.get(canon(hand.receiver))?.who ?? HAND_CEO;
    try {
      const result = applyHandOutcome(store, { msgId: hand.id, action, actor: hand.receiver,
        text: humanLeadOutcomeText({ who, action, decisionId: card.decisionId, ...(card.note ? { note: card.note } : {}), ...(card.via ? { via: card.via } : {}) }) }, deps);
      safeLog(deps, 'needhuman.human-lead-applied', { msgId: hand.id, action, decisionId: card.decisionId, who, to: result.to, mailId: result.mailId });
      applied.push(result);
    } catch (error) {
      safeLog(deps, 'needhuman.human-lead-failed', { msgId: hand.id, step: 'apply', decisionId: card.decisionId, error: String(error).slice(0, 200) });
    }
  }
  return applied;
}

// ── bulk and board ────────────────────────────────────────────────────────────────────────────

export interface HandBulkGroup { readonly receiver: string; readonly reason: string; readonly hands: readonly OpenHand[] }

/** ≥3 open ✋ of the same shape (same reason code) at one receiver → one group. */
export function bulkHandGroups(opens: readonly OpenHand[], min = HAND_BULK_MIN): HandBulkGroup[] {
  const groups = new Map<string, OpenHand[]>();
  for (const hand of opens) {
    const key = `${hand.receiver}\u0000${hand.reason}`;
    const list = groups.get(key) ?? [];
    list.push(hand);
    groups.set(key, list);
  }
  return [...groups.values()].filter((list) => list.length >= min)
    .map((list) => ({ receiver: list[0]!.receiver, reason: list[0]!.reason, hands: list }));
}

/** The one P0 line for a same-shape group (English UI text). */
export const handBulkLine = (group: HandBulkGroup): string =>
  `✋ ${group.hands.length} hands blocked on the same rule — change the rule (reason ${group.reason} · ${group.hands.map((h) => `${h.blockedSeat} #${h.id}`).join(', ')})`;

/** The receiver's own P0 reminder for one ✋ (English UI text). */
export const handRemindLine = (hand: Pick<OpenHand, 'blockedSeat' | 'id' | 'waitedMs'>): string =>
  `✋ ${hand.blockedSeat} waiting ${minutes(hand.waitedMs)}m — give one outcome before it auto-escalates at 10m: eln msg hand ${hand.id} resolve|reject|escalate "<text>"`;

export interface HandBoardLevel { readonly level: string; readonly count: number; readonly oldestMs: number }

/** Open ✋ per level (receiver seat · CEO = chains whose card is up and still without outcome), deepest first. */
export function handBoardLevels(store: Pick<MsgStore, 'db'>, input: { now: number; ladder: FederationLadder }): HandBoardLevel[] {
  const levels = new Map<string, { count: number; oldestMs: number }>();
  const bump = (level: string, waited: number): void => {
    const cur = levels.get(level) ?? { count: 0, oldestMs: 0 };
    levels.set(level, { count: cur.count + 1, oldestMs: Math.max(cur.oldestMs, waited) });
  };
  for (const hand of openHands(store, { now: input.now, ladder: input.ladder })) bump(hand.receiver, hand.waitedMs);
  if (hasColumn(store, 'refs_json')) {
    const cards = store.db.query(`SELECT id, created_at, refs_json FROM msg_messages WHERE created_at >= ? AND refs_json LIKE ?`)
      .all(new Date(input.now - HAND_SWEEP_WINDOW_MS).toISOString(), like('hand-ceo')) as { id: number; created_at: string; refs_json: string }[];
    for (const card of cards) {
      const root = Number(refValue(parseRefs(card.refs_json), 'hand-of:'));
      if (!Number.isSafeInteger(root)) continue;
      const outcome = store.db.query('SELECT 1 FROM msg_messages WHERE id > ? AND refs_json LIKE ? AND (refs_json LIKE ? OR refs_json LIKE ?) LIMIT 1')
        .get(root, like(`hand-of:${root}`), like('hand-outcome:resolve'), like('hand-outcome:reject'));
      if (!outcome) bump(HAND_CEO, Math.max(0, input.now - Date.parse(card.created_at)));
    }
  }
  for (const always of [input.ladder.hq, HAND_CEO]) if (!levels.has(always)) levels.set(always, { count: 0, oldestMs: 0 });
  return [...levels.entries()].map(([level, v]) => ({ level, ...v }))
    .sort((a, b) => input.ladder.depthOf(b.level) - input.ladder.depthOf(a.level) || b.oldestMs - a.oldestMs || a.level.localeCompare(b.level));
}

/** Federation Board line: `✋ Open hands — TC 3 (oldest 27m) · OP 0 · CEO 0`. */
export function handBoardLine(levels: readonly HandBoardLevel[]): string {
  return `✋ Open hands — ${levels.map((l) => l.count > 0 ? `${l.level} ${l.count} (oldest ${minutes(l.oldestMs)}m)` : `${l.level} 0`).join(' · ')}`;
}

/** First ✋ mail to `seat` after message id `afterId` (wait preemption), or null. */
export function handArrivedAfter(store: Pick<MsgStore, 'db'>, seat: string, afterId: number): HandMail | null {
  if (!hasColumn(store, 'refs_json')) return null;
  const row = store.db.query(`SELECT ${ROW_COLUMNS(store)} FROM msg_messages WHERE recipient = ? AND id > ?
    AND refs_json LIKE '%"block:%' AND refs_json LIKE '%"reason:%' ORDER BY id ASC LIMIT 1`).get(canon(seat), afterId) as Row | null;
  return row ? handOfRow(row) : null;
}

/** The line a preempted wait returns (English UI text). */
export const handPreemptLine = (hand: Pick<HandMail, 'id' | 'sender' | 'body'>): string =>
  `✋ arrived: #${hand.id} from ${hand.sender} — ${oneLine(hand.body, 160)} · give it one outcome first: eln msg hand ${hand.id} resolve|reject|escalate "<text>"`;

/** Production CEO rung: `elanous decisions raise` (detached; the log line is the record). */
export function spawnHandDecision(card: CeoCard): void {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const args = ['decisions', 'raise', '--title', card.title, '--category', 'scope', '--s', card.summary, '--c', `blockId ${card.blockId} · ✋ #${card.msgId}`,
    '--pending-question', `Why: ${card.seat} is blocked waiting for a person (${card.reason}) and the federation ladder gave no outcome\nWhat changes: resume lets ${card.seat} continue\nDefault: it stays blocked`,
    '--option', 'resume=Resume:the seat continues', '--option', 'stop=Stop:the seat stops this work', '--option', 'other=Another way:the CEO directs',
    '--skip-recommend', 'needs a person', '--no-xcheck', 'seat self-report', '--agent', card.seat];
  const child = spawn('elanous', args, { stdio: 'ignore', detached: true });
  child.on('error', () => { /* needhuman.ceo-card is the record */ });
  child.unref();
}

// ── BEACON-LADDER (대표 11-25 21:0x «봉화가 고장났다») ─────────────────────────────────────────────────
// S: tonight 4 ✋ (#167163·#167176·#167193 same cause ×3 · #167172) waited at TC on RES approvals while RES was dormant;
//    TC answered «HOLD 유지» as a resolve, so the ladder counted ✋ 0 and nothing climbed.
// C: a ✋ whose answer can never come (dormant awaited seat) or that keeps repeating must reach OP at once, not in 10 min.
// Q: who watches? A: the HQ (OP) steward tick — beaconHands below — no new loop.
//   rules: open ✋ grouped by (leader · blocked seat · reason) → repeat count; a group fires ONE «[✋ BEACON]» exception
//   card to HQ when age ≥10 m OR repeat ≥2 OR the awaited seat is dormant/down. The card is itself a ✋ (block/reason
//   kept, `hand-escalated-from:` every member) so the members close as escalated and OP's 10-min rung applies to it.
//   A dormant awaited seat also gets the blocked seat one auto-answer: «<SEAT> absorbed — use the policy path».

/** CEO-only categories (money · security · irreversible · policy): ref `category:<c>`, or reason HUMAN_DECISION / TOOL_DENIED. */
export const HAND_CEO_CATEGORIES = ['money', 'security', 'irreversible', 'policy'] as const;
export function isCeoOnlyHand(hand: Pick<HandMail, 'reason' | 'refs'>): boolean {
  if (refValue(hand.refs, 'urgency:') === 'security') return true;
  const category = refValue(hand.refs, 'category:');
  if (category) return (HAND_CEO_CATEGORIES as readonly string[]).includes(category.toLowerCase());
  return hand.reason === 'HUMAN_DECISION' || hand.reason === 'TOOL_DENIED';
}

export interface HandGroup { readonly lead: OpenHand; readonly members: readonly OpenHand[]; readonly repeat: number }

/** ✋ flood dedupe: same leader · blocked seat · reason = one ✋ with a repeat count (oldest leads). */
export function dedupeHands(opens: readonly OpenHand[]): HandGroup[] {
  const groups = new Map<string, OpenHand[]>();
  for (const h of opens) {
    const key = `${canon(h.receiver)}\u0000${canon(h.blockedSeat)}\u0000${h.reason}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) => a.id - b.id);
    return { lead: sorted[0]!, members: sorted, repeat: sorted.length };
  });
}

/** The seat a ✋ waits on: ref `awaits:<seat>`, else a dormant seat named as a word in its body. */
export function awaitedDormantSeat(hand: Pick<HandMail, 'refs' | 'body'>, dormant: readonly string[]): string | null {
  const awaits = refValue(hand.refs, 'awaits:');
  if (awaits) return dormant.map(canon).includes(canon(awaits)) ? canon(awaits) : null;
  for (const seat of dormant) {
    const re = new RegExp(`(^|[^A-Za-z0-9-])${seat.replace(/[^A-Za-z0-9-]/g, '')}(?![A-Za-z0-9-])`);
    if (re.test(hand.body)) return canon(seat);
  }
  return null;
}

/** ✋ urgency values that climb to OP on the next steward tick regardless of the leader's state. */
export const HAND_URGENT = ['urgent', 'security', 'crown-conflict'] as const;

export const HAND_POLICY_PATH = 'eln res policy · eln res capsule "<question>" · docs/handbook/LOOP-AGENTS.md §1a';

export interface BeaconFire { readonly leadId: number; readonly leader: string; readonly seat: string; readonly repeat: number; readonly why: string; readonly cardId: number; readonly dormant: string | null }
export interface BeaconReport { readonly open: number; readonly oldestMin: number; readonly escalated: number; readonly fired: readonly BeaconFire[]; readonly sla?: LeaderHandSla }

/**
 * One tick of the beacon watch (pure over the ledger · idempotent by provenance `hand-beacon:<leadId>`).
 * `live=false` (shadow) computes the same fires without writing.
 */
/** ✋ open at least this long fold into one backlog card per leader (never one card / mail each). */
export const HAND_BACKLOG_AGE_MS = 60 * 60_000;
/** At most this many beacon cards to HQ per window; the overflow stays open and is folded into a later card. */
export const HAND_BEACON_CAP = 3;
export const HAND_BEACON_CAP_WINDOW_MS = 10 * 60_000;

export function beaconHands(store: MsgStore, deps: HandLadderDeps & { readonly dormantSeats: readonly string[]; readonly live?: boolean; readonly maxCardsPerWindow?: number }): BeaconReport {
  const now = deps.now();
  // OP absent (down) → the card goes straight to the Claude OP coach.
  const hq = deps.dormantSeats.map(canon).includes(deps.ladder.hq) ? HAND_CEO_COPY_TO : deps.ladder.hq;
  const opens = openHands(store, { now, ladder: deps.ladder });
  const fired: BeaconFire[] = [];
  const cap = deps.maxCardsPerWindow ?? HAND_BEACON_CAP;
  const sentRecently = (): number => (store.db.query(`SELECT COUNT(*) AS n FROM msg_messages WHERE created_at >= ? AND recipient = ? AND refs_json LIKE ?`)
    .get(new Date(now - HAND_BEACON_CAP_WINDOW_MS).toISOString(), canon(hq), like('hand-beacon')) as { n: number }).n;
  let budget = Math.max(0, cap - sentRecently());
  // BEACON-FLOOD ②: ✋ older than the backlog age (reopened by the HOLD rule, or simply stale) fold into ONE summary card per leader.
  const isBacklog = (h: OpenHand): boolean => h.waitedMs >= HAND_BACKLOG_AGE_MS;
  const backlogByLeader = new Map<string, OpenHand[]>();
  for (const h of opens) {
    const leader = canon(h.receiver);
    if (!isBacklog(h) || leader === deps.ladder.hq || leader === hq || leader === HAND_CEO || leader === HAND_CEO_COPY_TO) continue;
    backlogByLeader.set(leader, [...(backlogByLeader.get(leader) ?? []), h]);
  }
  for (const [leader, list] of backlogByLeader) {
    if (budget <= 0) break;
    const groups = dedupeHands(list).sort((a, b) => b.repeat - a.repeat);
    const lead = [...list].sort((a, b) => a.id - b.id)[0]!;
    const top = groups.slice(0, 3).map((g) => `${g.lead.blockedSeat}/${g.lead.reason} ×${g.repeat}: ${oneLine(g.lead.body, 80)}`).join(' | ');
    const body = `[✋ BEACON · backlog · ${leader} → ${hq}] ${list.length} old ✋ (≥${minutes(HAND_BACKLOG_AGE_MS)}m, ${groups.length} causes) still open at ${leader} — top causes: ${top} · `
      + `close the causes, not each ✋: eln msg hand <this mail> resolve|reject "<text>"`;
    const why = `backlog ${list.length} ✋`;
    if (deps.live === false) { fired.push({ leadId: lead.id, leader, seat: lead.blockedSeat, repeat: list.length, why, cardId: 0, dormant: null }); budget -= 1; continue; }
    const { mail, fresh } = appendOnce(store, `hand-beacon-backlog:${leader}:${lead.id}`, () => ({
      from: leader, to: hq, kind: 'request', intent: 'decision',
      refs: [`block:${lead.blockId}`, `seat:${lead.blockedSeat}`, `reason:${lead.reason}`, `hand-of:${lead.rootId}`,
        ...list.map((m) => `hand-escalated-from:${m.id}`), 'hand-beacon', 'hand-beacon-backlog', `hand-repeat:${list.length}`],
      body,
    }));
    if (!fresh) continue;
    budget -= 1;
    safeLog(deps, 'needhuman.beacon-backlog', { leader, to: hq, count: list.length, causes: groups.length, cardId: mail.id });
    fired.push({ leadId: lead.id, leader, seat: lead.blockedSeat, repeat: list.length, why, cardId: mail.id, dormant: null });
  }
  for (const group of dedupeHands(opens.filter((h) => !isBacklog(h)))) {
    if (budget <= 0) { safeLog(deps, 'needhuman.beacon-capped', { cap, to: hq }); break; } // overflow stays open → folded into the next tick's card
    const { lead } = group;
    const leader = canon(lead.receiver);
    if (leader === deps.ladder.hq || leader === hq || leader === HAND_CEO || leader === HAND_CEO_COPY_TO) continue; // HQ's own rung is the 10-min sweep
    const dormant = awaitedDormantSeat(lead, deps.dormantSeats);
    const oldest = Math.max(...group.members.map((m) => m.waitedMs));
    const urgency = group.members.map((m) => refValue(m.refs, 'urgency:')).find((u) => u && (HAND_URGENT as readonly string[]).includes(u));
    const why = urgency ? `urgency ${urgency}` : dormant ? `awaited seat ${dormant} is dormant` : group.repeat >= 2 ? `repeat ×${group.repeat}` : oldest >= HAND_AUTO_ESCALATE_AFTER_MS ? `open ${minutes(oldest)}m at ${leader}` : '';
    if (!why) continue;
    const last = lastLeaderReply(store, lead);
    const body = `[✋ BEACON · ${leader} → ${hq}] ${lead.blockedSeat} blocked (${lead.reason}${group.repeat > 1 ? ` · ×${group.repeat}` : ''}) — ${why} · `
      + `cause: ${oneLine(lead.body, 200)} · ${leader} last reply: ${last ? oneLine(last, 200) : '(none)'} · `
      + `✋ ${group.members.map((m) => `#${m.id}`).join(' ')} · close it: eln msg hand <this mail> resolve|reject|escalate "<text>"`;
    if (deps.live === false) { fired.push({ leadId: lead.id, leader, seat: lead.blockedSeat, repeat: group.repeat, why, cardId: 0, dormant }); budget -= 1; continue; }
    const { mail, fresh } = appendOnce(store, `hand-beacon:${lead.id}`, () => ({
      from: leader, to: hq, kind: 'request', intent: 'decision',
      ...(lead.correlationId ? { correlationId: lead.correlationId } : {}),
      refs: [`block:${lead.blockId}`, `seat:${lead.blockedSeat}`, `reason:${lead.reason}`, `hand-of:${lead.rootId}`,
        ...group.members.map((m) => `hand-escalated-from:${m.id}`), 'hand-beacon', `hand-repeat:${group.repeat}`,
        ...(dormant ? [`awaits:${dormant}`] : []), ...(lead.refs?.filter((r) => r.startsWith('category:') || r.startsWith('urgency:')) ?? [])],
      body,
    }));
    if (!fresh) continue;
    budget -= 1;
    safeLog(deps, 'needhuman.beacon', { leadId: lead.id, leader, to: hq, repeat: group.repeat, why, cardId: mail.id });
    if (dormant) {
      try {
        store.appendWithProvenance({ from: hq, to: lead.blockedSeat, kind: 'info', intent: 'info', refs: [`hand-of:${lead.rootId}`, 'hand-auto-answer', `awaits:${dormant}`],
          body: `[✋ auto-answer · ${hq}] ${dormant} absorbed — no approval will come from that tab. Use the policy path: ${HAND_POLICY_PATH}. OP holds your ✋ as #${mail.id}.` },
          `hand-dormant-answer:${lead.id}`);
        safeLog(deps, 'needhuman.dormant-answer', { leadId: lead.id, seat: lead.blockedSeat, dormant });
      } catch (error) { safeLog(deps, 'needhuman.dormant-answer-failed', { leadId: lead.id, error: String(error).slice(0, 200) }); }
    }
    fired.push({ leadId: lead.id, leader, seat: lead.blockedSeat, repeat: group.repeat, why, cardId: mail.id, dormant });
  }
  const after = deps.live === false ? opens : openHands(store, { now, ladder: deps.ladder });
  const escalated = (store.db.query(`SELECT COUNT(*) AS n FROM msg_messages WHERE created_at >= ? AND refs_json LIKE ?`)
    .get(new Date(now - HAND_SWEEP_WINDOW_MS).toISOString(), like('hand-beacon')) as { n: number }).n;
  return { open: dedupeHands(after).length, oldestMin: minutes(Math.max(0, ...after.map((h) => h.waitedMs))), escalated, fired, sla: leaderHandSla(store, { now }) };
}

/** Status / op-pulse line: «✋ open n · oldest m · escalated k». */
export const beaconLine = (r: Pick<BeaconReport, 'open' | 'oldestMin' | 'escalated'> & { readonly sla?: LeaderHandSla }): string =>
  `✋ open ${r.open} · oldest ${r.oldestMin}m · escalated ${r.escalated}${r.sla ? ` · ${leaderSlaLine(r.sla)}` : ''}`;

// ── LEADER-HAND-CONTRACT (대표 11-25 22:5x «sub-coordinator 도 고쳐라») ──────────────────────────────────────
// S: TC got 55 ✋ in 30 min and answered «… 보류» / «기존 결정 유지» — #40151 stopped those closing a ✋, but the leader
//    kept writing them (its seat memory writer-check-2min-rule.md was never in the turn).
// C: the leader's door must refuse a waiting answer, the turn must carry the rule, and the rollup must show the leader SLA.
// A: ① applyHandOutcome refuses resolve+HOLD without owner ⊕ deadline (row in hand_hold_rejects) · msg post warns on a
//    free-text HOLD reply to a ✋ · ② leaderHandCard (open ✋ table ⊕ 4 standard answers ⊕ seat ✋ memories) rides every
//    ✋ notice · ③ leaderHandSla → beaconLine (steward rollup · status board · op-pulse).
// 세 얼굴: 관측 = needhuman.hold-rejected · hand_hold_rejects · beaconLine «leader SLA» · 판단 근거 = keepsWaiting ·
//          수복과 인계 = the rejection message names the 4 answers; the beacon still climbs to OP.

/** The four standard unblocking answers (the rejection message and the leader card both name them). */
export const HAND_STANDARD_ANSWERS: readonly string[] = [
  'continue on top of PR #<n> (owner = the blocked seat · deadline = now+30m)',
  'coordinate: send ONE mail to the current writer, then proceed in 30 min whatever the answer',
  // WIP1-ASSIGN-GUARD (OP 11-27): was «keep the uncommitted files, do not touch them» — TC sent 45 of those, overriding the
  // OPS-RULES takeover rule. Now the answer states the takeover rule (values: graphs/policies/seat-assign.yaml).
  `uncommitted WIP in the way: ${liveWipTakeoverRule()}`,
  'policy: auto — RES/REL are absorbed (eln res policy), never wait for them',
];

export const HAND_LEADER_RULE = 'Never HOLD without owner ⊕ deadline. RES/REL are absorbed — never wait for them. A writer check older than 2 min is stale: proceed.';

export function holdRejectMessage(msgId: number): string {
  return `✋ #${msgId}: a resolve that keeps the hand waiting (HOLD / 유지 / 보류 / wait) is refused — give a concrete unblocking answer with `
    + `owner ⊕ deadline ⊕ next step. Pick one of the 4 standard answers: ${HAND_STANDARD_ANSWERS.map((a, i) => `(${i + 1}) ${a}`).join(' · ')}. `
    + `To truly hold, pass owner and deadline (HandRaise owner=<seat> deadline=<iso>); or escalate.`;
}

function ensureRejectTable(store: Pick<MsgStore, 'db'>): void {
  store.db.run('CREATE TABLE IF NOT EXISTS hand_hold_rejects (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, msg_id INTEGER NOT NULL, actor TEXT NOT NULL, via TEXT NOT NULL)');
}

/** One refused HOLD attempt (tool / cli / post). Fail-open: a write error never hides the refusal. */
export function recordHoldReject(store: Pick<MsgStore, 'db'>, r: { msgId: number; actor: string; via: string; now: number }): void {
  try { ensureRejectTable(store); store.db.run('INSERT INTO hand_hold_rejects (at_ms, msg_id, actor, via) VALUES (?, ?, ?, ?)', [r.now, r.msgId, canon(r.actor), r.via]); } catch { /* fail-open */ }
}

export function countHoldRejects(store: Pick<MsgStore, 'db'>, sinceMs: number, actor?: string): number {
  try {
    ensureRejectTable(store);
    const row = actor
      ? store.db.query('SELECT COUNT(*) AS n FROM hand_hold_rejects WHERE at_ms >= ? AND actor = ?').get(sinceMs, canon(actor))
      : store.db.query('SELECT COUNT(*) AS n FROM hand_hold_rejects WHERE at_ms >= ?').get(sinceMs);
    return (row as { n: number }).n;
  } catch { return 0; }
}

/**
 * msg post path — a free-text reply to a ✋ that keeps it waiting (no owner ⊕ deadline refs): the post still goes out,
 * but it does not close the ✋ (handClosedOn) and the sender is told why. Returns the warning, or null.
 */
export function holdReplyWarning(store: MsgStore, input: { from: string; replyTo?: number | null; body: string; refs?: readonly string[] | null; now: number }): string | null {
  if (!input.replyTo) return null;
  const hand = readHandMail(store, input.replyTo);
  if (!hand) return null;
  const refs = input.refs ?? [];
  if (refs.some((r) => r.startsWith('hand-outcome:'))) return null;
  if (!keepsWaiting(input.body, refs)) return null;
  recordHoldReject(store, { msgId: hand.id, actor: input.from, via: 'post', now: input.now });
  return `warning: ${holdRejectMessage(hand.id)} This reply was sent but does NOT close the ✋.`;
}

export interface LeaderHandSla { readonly resolved: number; readonly withOwner: number; readonly medianMin: number | null; readonly holdRejected: number }

/** Leader ✋ SLA over the sweep window: median time-to-resolution · resolved-with-owner · HOLD attempts refused. */
export function leaderHandSla(store: MsgStore, input: { now: number; windowMs?: number }): LeaderHandSla {
  const since = input.now - (input.windowMs ?? HAND_SWEEP_WINDOW_MS);
  if (!hasColumn(store, 'refs_json')) return { resolved: 0, withOwner: 0, medianMin: null, holdRejected: countHoldRejects(store, since) };
  // A legacy «resolve» that kept the hand waiting closed nothing — it is not a resolution.
  const rows = (store.db.query(`SELECT created_at, body, refs_json FROM msg_messages WHERE created_at >= ? AND refs_json LIKE ? ORDER BY id ASC`)
    .all(new Date(since).toISOString(), like('hand-outcome:resolve')) as { created_at: string; body: string; refs_json: string }[])
    .filter((row) => !keepsWaiting(row.body, parseRefs(row.refs_json)));
  const durations: number[] = [];
  let withOwner = 0;
  for (const row of rows) {
    const refs = parseRefs(row.refs_json);
    const root = Number(refValue(refs, 'hand-of:'));
    const rootRow = Number.isSafeInteger(root) ? store.db.query('SELECT created_at FROM msg_messages WHERE id = ?').get(root) as { created_at: string } | null : null;
    if (rootRow) durations.push(Math.max(0, Date.parse(row.created_at) - Date.parse(rootRow.created_at)));
    if (refs.some((r) => r.startsWith('hand-owner:'))) withOwner += 1;
  }
  durations.sort((a, b) => a - b);
  const mid = durations.length ? (durations.length % 2 ? durations[(durations.length - 1) / 2]! : (durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2) : null;
  return { resolved: rows.length, withOwner, medianMin: mid === null ? null : Math.round(mid / 60_000), holdRejected: countHoldRejects(store, since) };
}

export const leaderSlaLine = (s: LeaderHandSla): string =>
  `leader SLA: median ${s.medianMin === null ? '–' : `${s.medianMin}m`} · with-owner ${s.resolved ? Math.round((s.withOwner / s.resolved) * 100) : 0}% (${s.withOwner}/${s.resolved}) · HOLD refused ${s.holdRejected}`;

/** Seat memory files that carry the ✋ rule — loaded by name (deterministic), never by recall. */
export const LEADER_HAND_MEMORY_FILES: readonly string[] = ['writer-check-2min-rule.md', 'absorb-res-rel-1125.md', 'beacon-one-path-1125.md'];

/** The leader turn card for a ✋ turn: open ✋ table (cause · age · repeat) ⊕ 4 standard answers ⊕ rule ⊕ seat ✋ memories. */
export function leaderHandCard(input: { seat: string; opens: readonly OpenHand[]; memories?: readonly { name: string; body: string }[] }): string {
  const mine = input.opens.filter((h) => canon(h.receiver) === canon(input.seat));
  const lines = ['', `── ✋ leader card (${canon(input.seat)}) ──`];
  if (mine.length) {
    lines.push('open ✋ | cause | age | repeat');
    for (const g of dedupeHands(mine).slice(0, 12)) {
      lines.push(`#${g.lead.id} ${g.lead.blockedSeat} | ${g.lead.reason}: ${oneLine(g.lead.body.replace(/^\[✋[^\]]*\]/, ''), 90)} | ${minutes(Math.max(...g.members.map((m) => m.waitedMs)))}m | ×${g.repeat}`);
    }
  } else lines.push('open ✋: none besides this mail');
  lines.push('answer with HandRaise(action=resolve, msgId, text, owner, deadline) — one of:');
  HAND_STANDARD_ANSWERS.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  lines.push(`rule: ${HAND_LEADER_RULE}`);
  for (const m of input.memories ?? []) lines.push(`seat memory ${m.name}: ${oneLine(m.body, 400)}`);
  return lines.join('\n');
}

/** Live: read this seat's ✋ memories by file name (fail-open: missing = skipped). */
export function readLeaderHandMemories(seatDir: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const name of LEADER_HAND_MEMORY_FILES) {
    try {
      const path = `${seatDir}/${name}`;
      if (!existsSync(path)) continue;
      out.push({ name, body: readFileSync(path, 'utf8').replace(/^---[\s\S]*?---\s*/, '') });
    } catch { /* skip */ }
  }
  return out;
}
