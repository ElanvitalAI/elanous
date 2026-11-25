// ── OP-REQUIREMENT-LOOP (0.3.35 P0) — the host owns OP's open requirements until they close with evidence ──
//
// S: eln OP ends turns with «done» or «I asked X» while 대표 directives, its own P0 cells and delegated requests are
//    still open — nobody pushes it again until a person does.
// C: the model must not decide «done». The runtime keeps a structured ledger and, when the OP turn ends with
//    requirements open, injects ONE ordinary user-role continuation turn naming the requirement, its next step and
//    its close condition (codex continue_if_idle · grok «Goal NOT complete — next step» · openclaw promised-work).
// Q: how does it stop? Caps are structural, never wording: ≤8 continuations per requirement per hour; the same gap
//    fingerprint (requirement id ⊕ revision — nothing changed since the last continuation) seen twice stops that
//    requirement as BLOCKED with a bulletin line. A verified wait (armed waker, future deadline) is waiting, not a gap.
// A: this module = ledger store ⊕ closure gate ⊕ seed ⊕ turn-end decision. entry.ts only gathers inputs and opens
//    the turn through the existing internal-turn door (the session-stable prefix is untouched).
//
// Three faces: observe = debug.log('op.requirements', continue|blocked|close-rejected|closed) · recognize = open
// requirement with no verified wait and a fresh fingerprint · heal = one continuation turn, or BLOCKED ⊕ bulletin.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CONTINUATIONS_PER_HOUR = 8;
const HOUR_MS = 60 * 60_000;
/** One continuation names at most this many requirements — never the whole ledger (11-24: 392 open drowned the CEO line). */
export const CONTINUATION_ITEMS = 3;
/**
 * A wait past its deadline is escalated once; still open one interval later it expires.
 * Same length as the mail follow-up wait (src/msg/msg-follow-up.ts FOLLOW_UP_MS = 30 min).
 */
export const ESCALATION_INTERVAL_MS = 30 * 60_000;

export type RequirementSource =
  | { kind: 'ceo-directive'; turnId: string }
  | { kind: 'p0-cell'; version: string; cellId: string }
  | { kind: 'delegated-request'; msgId: string; commitmentId: string };

/** Closure evidence. Anything else — prose, «I asked X», a child finishing — is not closure. */
export type ClosureEvidence =
  | { kind: 'pr'; number: number }
  | { kind: 'checklist'; cellId: string; status: 'green' | 'done' }
  | { kind: 'measured'; metric: string; value: number; unit?: string }
  | { kind: 'commitment-done'; commitmentId: string; doneEvidence: string }
  /** SEAT-TURN-FOLLOWUPS R ⓐ — a person's line with no cell/PR/metric ref: the seat's reply turn that addresses it, or «done: <line>». */
  | { kind: 'answered'; replyTurnId?: string; done?: string };

export interface WaitFor { commitmentId: string; condition: string; deadlineAt: string }

export interface Requirement {
  id: string;
  source: RequirementSource;
  title: string;
  closeCondition: string;
  next: string;
  /** expired = an overdue wait escalated once and still open one interval later · superseded = a newer CEO item replaced it. */
  /** stale = BLOCKED with nothing actionable: OP self-closed it with a one-line note (REQ-BLOCK-ROUTE-TO-ASKEE (c)). */
  status: 'open' | 'blocked' | 'closed' | 'expired' | 'superseded' | 'stale';
  /** Bumped by every structured change (next · wait · evidence). The gap fingerprint is id ⊕ revision. */
  revision: number;
  waitFor?: WaitFor;
  evidence?: ClosureEvidence;
  blocked?: { code: 'SAME_GAP'; fingerprint: string; at: string };
  /** Set when the overdue wait was escalated (once). Cleared by a new wait. */
  escalatedAt?: string;
  expired?: { at: string; reason: string };
  supersededBy?: string;
  /** SEAT-TURN-FOLLOWUPS R ④ — why it was superseded without a newer item (`announcement`: a directive with no evidence refs). */
  supersededReason?: string;
  /** SEAT-TURN-FOLLOWUPS R ② — the structured refs (cell: · pr: · metric:) that make a CEO directive evidence-bearing. */
  refs?: string[];
  /** SEAT-TURN-FOLLOWUPS R ⓐ — `artifact` (PR · checklist · measured) or `answered` (a person's line with no artifact ref). */
  evidenceMode?: 'artifact' | 'answered';
  /** SEAT-TURN-FOLLOWUPS R ③ — the one exception card raised when it blocked (decision id). */
  exceptionCard?: string;
  /** Recipient seat of the delegated mail (from the mail store), for the escalation line. */
  peer?: string;
  /** P0 cell owner (checklist `owner`), for the blocked route to the owner's coordinator. */
  cellOwner?: string;
  /** REQ-BLOCK-ROUTE-TO-ASKEE — what the blocked route already did (one re-ask · one exception line). */
  blockRoute?: { reaskAt?: string; reaskTo?: string; reaskMsgId?: number; exceptionAt?: string; exceptionTo?: string };
  stale?: { at: string; note: string };
  createdAt: string;
  updatedAt: string;
}

export interface LoopRun { continuedAt: string[]; lastFingerprint?: string }
export interface BulletinLine { at: string; requirementId: string; code: 'SAME_GAP'; line: string }

export interface RequirementStore {
  version: 1;
  requirements: Requirement[];
  runs: Record<string, LoopRun>;
  bulletin: BulletinLine[];
}

export const emptyStore = (): RequirementStore => ({ version: 1, requirements: [], runs: {}, bulletin: [] });

export function requirementStorePath(stateRoot: string, seat: string): string {
  return join(stateRoot, 'op-requirements', `${seat.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_')}.json`);
}

export function readStore(path: string): RequirementStore {
  if (!existsSync(path)) return emptyStore();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RequirementStore>;
  return { version: 1, requirements: parsed.requirements ?? [], runs: parsed.runs ?? {}, bulletin: parsed.bulletin ?? [] };
}

export function writeStore(path: string, store: RequirementStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, path);
}

const find = (store: RequirementStore, id: string): Requirement => {
  const r = store.requirements.find((x) => x.id === id);
  if (!r) throw new Error(`requirement not found: ${id}`);
  return r;
};

function touch(r: Requirement, at: string): void {
  r.revision += 1;
  r.updatedAt = at;
  if (r.status === 'blocked') { r.status = 'open'; delete r.blocked; }
  if (r.status === 'expired') { r.status = 'open'; delete r.expired; delete r.escalatedAt; }
}

const isFinal = (r: Requirement): boolean => r.status === 'closed' || r.status === 'superseded' || r.status === 'stale';

// ── closure gate ──────────────────────────────────────────────────────────────────────

/** Validates the evidence shape; an invalid or uncertain evidence is a rejection, never a close. */
export function validateEvidence(e: unknown): { ok: true; evidence: ClosureEvidence } | { ok: false; reason: string } {
  if (!e || typeof e !== 'object') return { ok: false, reason: 'no-evidence' };
  const v = e as Record<string, unknown>;
  if (v.uncertain === true) return { ok: false, reason: 'uncertain' };
  switch (v.kind) {
    case 'pr':
      return Number.isSafeInteger(v.number) && (v.number as number) > 0 ? { ok: true, evidence: { kind: 'pr', number: v.number as number } } : { ok: false, reason: 'pr-number-required' };
    case 'checklist':
      if (typeof v.cellId !== 'string' || !v.cellId.trim()) return { ok: false, reason: 'cell-id-required' };
      return v.status === 'green' || v.status === 'done' ? { ok: true, evidence: { kind: 'checklist', cellId: v.cellId, status: v.status } } : { ok: false, reason: 'checklist-not-green' };
    case 'measured':
      if (typeof v.metric !== 'string' || !v.metric.trim()) return { ok: false, reason: 'metric-required' };
      return typeof v.value === 'number' && Number.isFinite(v.value)
        ? { ok: true, evidence: { kind: 'measured', metric: v.metric, value: v.value, ...(typeof v.unit === 'string' && v.unit ? { unit: v.unit } : {}) } }
        : { ok: false, reason: 'measured-value-required' };
    case 'answered': {
      const reply = typeof v.replyTurnId === 'string' && v.replyTurnId.trim() ? v.replyTurnId.trim() : undefined;
      const done = typeof v.done === 'string' && v.done.trim() ? v.done.trim().slice(0, 300) : undefined;
      return reply || done ? { ok: true, evidence: { kind: 'answered', ...(reply ? { replyTurnId: reply } : {}), ...(done ? { done } : {}) } } : { ok: false, reason: 'answer-required' };
    }
    case 'commitment-done':
      return typeof v.commitmentId === 'string' && typeof v.doneEvidence === 'string' && v.doneEvidence.trim()
        ? { ok: true, evidence: { kind: 'commitment-done', commitmentId: v.commitmentId, doneEvidence: v.doneEvidence } } : { ok: false, reason: 'commitment-evidence-required' };
    default:
      return { ok: false, reason: 'unknown-evidence-kind' };
  }
}

export function closeRequirement(store: RequirementStore, id: string, evidence: unknown, at: string): { closed: boolean; reason?: string } {
  const r = find(store, id);
  if (r.status === 'closed') return { closed: true };
  const checked = validateEvidence(evidence);
  if (!checked.ok) return { closed: false, reason: checked.reason };
  // R ⓐ — «answered» closes only a person's line that named no artifact; artifact requirements keep artifact evidence.
  if (checked.evidence.kind === 'answered' && r.evidenceMode !== 'answered') return { closed: false, reason: 'artifact-evidence-required' };
  // A P0 cell closes on its own cell's status, not on another cell's.
  if (r.source.kind === 'p0-cell' && checked.evidence.kind === 'checklist' && checked.evidence.cellId !== r.source.cellId) return { closed: false, reason: 'other-cell' };
  touch(r, at);
  r.status = 'closed';
  r.evidence = checked.evidence;
  return { closed: true };
}

/**
 * A CEO directive replaced by a newer CEO item closes as `superseded`. Structured only: the model (or a person) names
 * the newer item id — there is no topic matching.
 */
export function supersedeRequirement(store: RequirementStore, id: string, byId: string, at: string): Requirement {
  const r = find(store, id);
  const by = find(store, byId);
  if (id === byId) throw new Error('a requirement cannot supersede itself');
  if (r.source.kind !== 'ceo-directive' || by.source.kind !== 'ceo-directive') throw new Error('only a CEO directive supersedes a CEO directive');
  if (by.createdAt < r.createdAt) throw new Error(`${byId} is older than ${id}`);
  if (r.status === 'closed') return r;
  r.revision += 1;
  r.updatedAt = at;
  r.status = 'superseded';
  r.supersededBy = byId;
  delete r.blocked;
  return r;
}

export function setNext(store: RequirementStore, id: string, next: string, at: string): Requirement {
  const r = find(store, id);
  if (isFinal(r)) throw new Error(`requirement ${r.status}: ${id}`);
  if (!next.trim()) throw new Error('next step must be nonempty');
  r.next = next.trim();
  touch(r, at);
  return r;
}

/** «I asked X» is not closure: it attaches a verified wait and the requirement stays open. */
export function attachWait(store: RequirementStore, id: string, wait: WaitFor, at: string): Requirement {
  const r = find(store, id);
  if (isFinal(r)) throw new Error(`requirement ${r.status}: ${id}`);
  if (!wait.commitmentId || !wait.condition || !Number.isFinite(Date.parse(wait.deadlineAt))) throw new Error('wait needs commitment, condition and deadline');
  r.waitFor = { ...wait };
  delete r.escalatedAt;
  touch(r, at);
  return r;
}

// ── seed ───────────────────────────────────────────────────────────────────────────────

export interface SeedInput {
  /** User turns whose structured source is a person (`from.kind === 'human'`) in the OP session. */
  directives?: ReadonlyArray<{ turnId: string; text: string; refs?: readonly string[]; kind?: string | null; announce?: boolean;
    /** R ⓐ — the line's structured source is a person in the seat (typed · Telegram TG-OP); false = a crown-flagged relayed mail. */
    human?: boolean }>;
  /** Current release cells already filtered to priority P0 ∧ owner OP. */
  p0Cells?: ReadonlyArray<{ version: string; id: string; title: string; status: string; owner?: string }>;
  /** OP's open follow-up commitments bound to a waker (MsgPost request/decision follow-up). */
  delegated?: ReadonlyArray<{ commitmentId: string; msgId: string; text: string; status: string; doneEvidence?: string; wait?: WaitFor; peer?: string }>;
}

const DIRECTIVE_CLOSE = 'evidence that the directive is done: a PR number, a checklist status green/done, or a measured number';

/** SEAT-TURN-FOLLOWUPS R ② — refs that name something a PR / checklist / measured number can close. */
export const DIRECTIVE_EVIDENCE_REF_PREFIXES: readonly string[] = ['cell:', 'pr:', 'metric:'];
/** Mail kinds that are never requirements (ack closes them). */
export const NON_REQUIREMENT_KINDS: readonly string[] = ['announce', 'info', 'notice', 'status', 'coord', 'bulletin'];

const hasEvidenceRef = (refs: readonly string[] | undefined): boolean =>
  (refs ?? []).some((ref) => DIRECTIVE_EVIDENCE_REF_PREFIXES.some((prefix) => ref.startsWith(prefix)));

/**
 * SEAT-TURN-FOLLOWUPS R — is this CEO line a requirement, and how does it close? (structured fields only)
 *   ⓐ a person's own line in the seat (typed · TG-OP) → always; artifact evidence when it names cell/PR/metric, else «answered»
 *   ⓑ a crown-flagged relayed mail that is an announcement or info/notice → never (ack closes it)
 *   ⓒ a crown-flagged request with cell/PR/metric refs → artifact evidence; without refs → not a requirement
 * Live: crown-flagged bulletins and «keep going» nudges became `ceo:<turn>` requirements nothing could close → «🚨 BLOCKED».
 */
export function directiveMode(d: { refs?: readonly string[]; kind?: string | null; announce?: boolean; human?: boolean }): 'artifact' | 'answered' | null {
  const nonRequirement = d.announce === true || (d.kind ? NON_REQUIREMENT_KINDS.includes(d.kind.trim().toLowerCase()) : false);
  if (d.human === true) return hasEvidenceRef(d.refs) ? 'artifact' : 'answered';
  if (nonRequirement) return null;
  return hasEvidenceRef(d.refs) ? 'artifact' : null;
}
/** Back-compat name: true when the line is an artifact-evidence requirement. */
export function isEvidenceDirective(d: { refs?: readonly string[]; kind?: string | null; announce?: boolean; human?: boolean }): boolean {
  return directiveMode(d) === 'artifact';
}

/**
 * SEAT-TURN-FOLLOWUPS R ④ (coordinator decision 11-25) — on load, a CEO requirement stored before this build (it carries no
 * `evidenceMode`, which every requirement seeded by this build has) with no evidence refs closes as
 * «superseded: pre-unify migration»: those were mostly relayed bulletins/nudges and would otherwise reopen and nag.
 * Returns the ids closed (the caller writes ONE digest line with the count).
 */
export function migrateUnreferencedDirectives(store: RequirementStore, at: string): string[] {
  const closed: string[] = [];
  for (const r of store.requirements) {
    if (r.source.kind !== 'ceo-directive' || r.evidenceMode || (r.status !== 'open' && r.status !== 'blocked')) continue;
    if (hasEvidenceRef(r.refs)) { r.evidenceMode = 'artifact'; continue; }
    r.status = 'superseded';
    r.supersededReason = 'pre-unify migration';
    delete r.blocked;
    r.updatedAt = at;
    closed.push(r.id);
  }
  return closed;
}

const ANSWERED_CLOSE = 'answered: the seat\'s reply that addresses it (reply turn id) or «done: <one line>» (eln msg req close <id> --answered-by <turn> | --done "<line>")';

function upsert(store: RequirementStore, r: Omit<Requirement, 'status' | 'revision' | 'createdAt' | 'updatedAt'>, at: string): Requirement {
  const existing = store.requirements.find((x) => x.id === r.id);
  if (existing) return existing;
  const created: Requirement = { ...r, status: 'open', revision: 1, createdAt: at, updatedAt: at };
  store.requirements.push(created);
  return created;
}

/** Idempotent by stable source ids. A closed requirement is never reopened by seeding. */
export function seedRequirements(store: RequirementStore, input: SeedInput, at: string): void {
  for (const d of input.directives ?? []) {
    if (!d.turnId || !d.text.trim()) continue;
    const mode = directiveMode(d);
    if (mode === null) continue; // R ⓑⓒ — a relayed announcement / info / unreferenced crown mail is not a requirement (ack closes it)
    upsert(store, { id: `ceo:${d.turnId}`, source: { kind: 'ceo-directive', turnId: d.turnId }, title: d.text.trim().slice(0, 200),
      closeCondition: mode === 'artifact' ? DIRECTIVE_CLOSE : ANSWERED_CLOSE,
      next: mode === 'artifact' ? 'Carry out the directive with tools, then close it with evidence' : 'Address the line in this turn, then close it as answered',
      refs: [...(d.refs ?? [])], evidenceMode: mode }, at);
  }
  for (const c of input.p0Cells ?? []) {
    const r = upsert(store, { id: `p0:${c.version}:${c.id}`, source: { kind: 'p0-cell', version: c.version, cellId: c.id }, title: c.title.slice(0, 200),
      closeCondition: `checklist ${c.id} status green or done`, next: `Find who is moving ${c.id} (PR · pregate · owner) and drive the next missing step` }, at);
    if (c.owner && !r.cellOwner) r.cellOwner = c.owner;
    if (r.status !== 'closed' && (c.status === 'green' || c.status === 'done')) closeRequirement(store, r.id, { kind: 'checklist', cellId: c.id, status: c.status }, at);
  }
  for (const d of input.delegated ?? []) {
    const id = `req:msg:${d.msgId}`;
    const known = store.requirements.find((x) => x.id === id);
    if (!known && d.status !== 'open') continue;
    const r = upsert(store, { id, source: { kind: 'delegated-request', msgId: d.msgId, commitmentId: d.commitmentId }, title: d.text.slice(0, 200),
      closeCondition: 'the delegated result verified by OP (PR merged · checklist green · measured number) — a child finishing is not closure',
      next: `Read the reply to message #${d.msgId}, verify the result, then close with evidence or re-delegate with a new wait`, ...(d.wait ? { waitFor: d.wait } : {}) }, at);
    if (isFinal(r)) continue;
    if (d.peer && !r.peer) r.peer = d.peer;
    // An expired requirement comes back only with a new, future wait (re-delegated); the same stale waker keeps it expired.
    const newWait = d.wait && (r.waitFor?.condition !== d.wait.condition || r.waitFor?.deadlineAt !== d.wait.deadlineAt);
    if (d.wait && newWait && (r.status !== 'expired' || Date.parse(d.wait.deadlineAt) > Date.parse(at))) attachWait(store, r.id, d.wait, at);
    if (d.status === 'done' && d.doneEvidence) closeRequirement(store, r.id, { kind: 'commitment-done', commitmentId: d.commitmentId, doneEvidence: d.doneEvidence }, at);
  }
}

// ── turn end ───────────────────────────────────────────────────────────────────────────

export type WaitState = 'armed' | 'fired' | 'expired' | 'none';

export interface ContinuationItem { requirementId: string; fingerprint: string }
export interface TurnEndDecision {
  /** At most one continuation per turn end, naming at most CONTINUATION_ITEMS requirements (`requirementId` = the first). */
  continuation: { requirementId: string; fingerprint: string; items: ContinuationItem[]; text: string } | null;
  /** Overdue waits escalated this turn end (each exactly once). */
  escalated: string[];
  /** Escalated waits still open one interval later — closed as expired this turn end. */
  expired: Array<{ requirementId: string; line: string }>;
  /** Requirements stopped this turn end (same gap twice) — each already has a bulletin line. */
  blocked: Array<{ requirementId: string; line: string }>;
  /** Requirements skipped because their hourly cap is spent. */
  capped: string[];
  waiting: string[];
}

const SOURCE_RANK: Record<RequirementSource['kind'], number> = { 'ceo-directive': 0, 'p0-cell': 1, 'delegated-request': 2 };

export const fingerprintOf = (r: Requirement): string => `${r.id}#r${r.revision}`;

function sourceLine(s: RequirementSource): string {
  if (s.kind === 'ceo-directive') return `CEO directive (turn ${s.turnId})`;
  if (s.kind === 'p0-cell') return `P0 cell ${s.cellId} (${s.version})`;
  return `delegated request #${s.msgId} (commitment ${s.commitmentId})`;
}

/** The search ladder runs before any «unknown/미확인». Commands only — the model fills in the key. */
export function searchLadder(key: string, version?: string): string[] {
  return [
    `checklist evidence: eln release checklist list${version ? ` --version ${version}` : ''} --json (read the cell's evidence)`,
    `git log origin/main --oneline --grep '${key}'`,
    `gh pr list --search '${key}' --state all`,
    `elanous logs --grep '${key}' --since 24h`,
    `eln msg list --to OP --all | grep '${key}' · eln directives search`,
    'seat-state ledgers (~/elanous-hq/seat-state/INDEX.md first)',
  ];
}

const overdue = (r: Requirement, nowMs: number): boolean => Boolean(r.waitFor) && Date.parse(r.waitFor!.deadlineAt) <= nowMs;

function escalationStep(r: Requirement): string {
  const msgId = r.source.kind === 'delegated-request' ? r.source.msgId : '?';
  const expiresAt = new Date(Date.parse(r.escalatedAt!) + ESCALATION_INTERVAL_MS).toISOString();
  return `no reply from ${r.peer ?? 'the recipient seat'} to #${msgId} — read that seat's screen (ElsControl read), nudge it, or do it yourself; then close with evidence or attach a new wait (it expires at ${expiresAt})`;
}

function itemBlock(r: Requirement): string {
  return [
    `Requirement ${r.id} is still open · ${sourceLine(r.source)} · ${r.title}`,
    `Next step: ${r.escalatedAt ? escalationStep(r) : r.next}`,
    `Close condition: ${r.closeCondition}`,
  ].join('\n');
}

export function continuationText(r: Requirement | readonly Requirement[], openCount: number): string {
  const items = Array.isArray(r) ? r as readonly Requirement[] : [r as Requirement];
  const first = items[0]!;
  const key = first.source.kind === 'p0-cell' ? first.source.cellId : first.source.kind === 'delegated-request' ? `#${first.source.msgId}` : first.title.slice(0, 40);
  const ladder = searchLadder(key, first.source.kind === 'p0-cell' ? first.source.version : undefined).map((step, i) => `${i + 1}) ${step}`).join(' · ');
  const head = items.length > 1
    ? `[requirement-loop] ${items.length} of ${openCount} open requirements, newest CEO items first:\n${items.map((item, i) => `(${i + 1}) ${itemBlock(item)}`).join('\n')}`
    : `[requirement-loop] ${itemBlock(first)}`;
  return [
    head,
    `Open requirements: ${openCount}. You do not decide «done»; the ledger closes only with evidence: eln msg req close <id> --pr <N> | --checklist <CELL>:green | --measured <metric>=<number>. A CEO item replaced by a newer CEO line: eln msg req close <old-id> --superseded-by <new-id>.`,
    `Before writing «unknown/미확인», run this ladder and report each result: ${ladder}.`,
    `«I asked X» is not closure: attach the wait (eln msg req wait <id> --commitment <id> --condition <cond> --deadline <iso>) and continue with the next independent step. Record a new next step with eln msg req next <id> "<step>".`,
  ].join('\n');
}

/**
 * Called once per OP turn end.
 * 1. Overdue waits: escalate once (revision bump, so it is a fresh gap); escalated and still open one interval later → expired.
 * 2. Picks at most CONTINUATION_ITEMS open requirements: newest CEO items, then overdue escalations, then P0 cells,
 *    then other delegated gaps. A requirement whose fingerprint was already continued (nothing changed since)
 *    stops as BLOCKED with a bulletin line.
 * The continuation is not counted here — call `noteContinuationOpened` only after the door opened it.
 */
export function decideTurnEnd(store: RequirementStore, input: { now: Date; waitState: (r: Requirement) => WaitState }): TurnEndDecision {
  const at = input.now.toISOString();
  const nowMs = input.now.getTime();
  const out: TurnEndDecision = { continuation: null, escalated: [], expired: [], blocked: [], capped: [], waiting: [] };
  for (const r of store.requirements) {
    if ((r.status !== 'open' && r.status !== 'blocked') || !overdue(r, nowMs)) continue;
    if (!r.escalatedAt) {
      touch(r, at);
      r.escalatedAt = at;
      out.escalated.push(r.id);
    } else if (nowMs - Date.parse(r.escalatedAt) >= ESCALATION_INTERVAL_MS) {
      r.status = 'expired';
      r.updatedAt = at;
      delete r.blocked;
      const reason = `wait ${r.waitFor!.condition} overdue since ${r.waitFor!.deadlineAt}, escalated ${r.escalatedAt}, no close`;
      r.expired = { at, reason };
      out.expired.push({ requirementId: r.id, line: `⌛ EXPIRED ${r.id} · ${reason}` });
    }
  }
  const open = store.requirements.filter((r) => r.status === 'open');
  const tier = (r: Requirement): number => r.source.kind === 'ceo-directive' ? 0 : r.escalatedAt ? 1 : SOURCE_RANK[r.source.kind] + 1;
  const ordered = [...open].sort((a, b) => tier(a) - tier(b)
    // CEO items and escalations: newest first · the rest: oldest first (as before).
    || (tier(a) <= 1 ? b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id, undefined, { numeric: true })
      : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
  const chosen: Requirement[] = [];
  for (const r of ordered) {
    if (r.waitFor && !overdue(r, nowMs) && input.waitState(r) === 'armed') { out.waiting.push(r.id); continue; }
    const run = store.runs[r.id] ?? (store.runs[r.id] = { continuedAt: [] });
    run.continuedAt = run.continuedAt.filter((t) => nowMs - Date.parse(t) < HOUR_MS);
    const fp = fingerprintOf(r);
    if (run.lastFingerprint === fp) {
      r.status = 'blocked';
      r.blocked = { code: 'SAME_GAP', fingerprint: fp, at };
      const line = `🚨 BLOCKED ${r.id} · same gap twice (${fp}) · next was: ${r.next} · close condition: ${r.closeCondition}`;
      store.bulletin.push({ at, requirementId: r.id, code: 'SAME_GAP', line });
      out.blocked.push({ requirementId: r.id, line });
      continue;
    }
    if (run.continuedAt.length >= CONTINUATIONS_PER_HOUR) { out.capped.push(r.id); continue; }
    if (chosen.length < CONTINUATION_ITEMS) chosen.push(r);
  }
  if (chosen.length) {
    const items = chosen.map((r) => ({ requirementId: r.id, fingerprint: fingerprintOf(r) }));
    out.continuation = { ...items[0]!, items, text: continuationText(chosen, open.length) };
  }
  return out;
}

export function noteContinuationOpened(store: RequirementStore, c: { requirementId: string; fingerprint: string; items?: readonly ContinuationItem[] }, now: Date): void {
  for (const item of c.items ?? [c]) {
    const run = store.runs[item.requirementId] ?? (store.runs[item.requirementId] = { continuedAt: [] });
    run.continuedAt.push(now.toISOString());
    run.lastFingerprint = item.fingerprint;
  }
}

/** Counts by state, for `eln msg req list`. */
export function countByState(store: RequirementStore): Record<Requirement['status'], number> {
  const counts: Record<Requirement['status'], number> = { open: 0, blocked: 0, closed: 0, expired: 0, superseded: 0, stale: 0 };
  for (const r of store.requirements) counts[r.status] += 1;
  return counts;
}

// ── REQ-BLOCK-ROUTE-TO-ASKEE — a BLOCKED requirement goes to whoever is blocking it, never to the CEO by default ──────

/** A re-asked seat gets this long before the exception line (same as the mail follow-up wait). */
export const REASK_BACKOFF_MS = ESCALATION_INTERVAL_MS;
/** The only gaps a CEO card may carry (CEO 11-25 19:2x). Declared on a CEO requirement as a `gap:<category>` ref. */
export const CEO_ONLY_GAPS: readonly string[] = ['money', 'security', 'irreversible', 'policy'];
/** Seats whose silence goes back to CLAUDE-OP once, not to a coordinator (the coach seat and its aliases). */
const COACH_SEAT = /^(CLAUDE-OP|COACH)(\b|$)/i;

export function ceoGap(r: Requirement): string | undefined {
  if (r.source.kind !== 'ceo-directive') return undefined;
  for (const ref of r.refs ?? []) {
    const m = /^gap:([a-z]+)$/.exec(ref.trim().toLowerCase());
    if (m && CEO_ONLY_GAPS.includes(m[1]!)) return m[1];
  }
  return undefined;
}

export type BlockedRoute =
  | { kind: 'ceo-card'; gap: string }
  | { kind: 'reask'; to: string; body: string }
  | { kind: 'exception'; to: string; body: string }
  | { kind: 'hold'; reason: string }
  | { kind: 'stale'; note: string };

/**
 * Pure: what a BLOCKED requirement does next. (a) waiting on a delegated mail → one re-ask to the recipient, then (after
 * the backoff) one exception line to the recipient's coordinator (a coach seat → CLAUDE-OP) · (b) a P0 cell → one
 * exception line to the cell owner's coordinator · (c) nothing actionable (no recipient · the route lands on the seat
 * itself · a CEO line without a CEO-only gap) → stale. A CEO card only for a CEO line with a CEO-only gap.
 */
export function routeBlocked(r: Requirement, input: { seat: string; now: Date; coordinatorOf: (seat: string) => string | undefined }): BlockedRoute {
  const self = input.seat.toUpperCase();
  const route = r.blockRoute ?? {};
  const nowMs = input.now.getTime();
  const gap = ceoGap(r);
  if (gap) return { kind: 'ceo-card', gap };
  const exceptionTarget = (seat: string): string | undefined => {
    if (COACH_SEAT.test(seat)) return 'CLAUDE-OP';
    const coord = input.coordinatorOf(seat)?.toUpperCase();
    return coord && coord !== self ? coord : undefined;
  };
  if (r.source.kind === 'delegated-request') {
    const peer = r.peer?.toUpperCase();
    if (!peer || peer === self) return { kind: 'stale', note: `blocked on #${r.source.msgId} with no recipient seat to ask` };
    if (!route.reaskAt) {
      return { kind: 'reask', to: peer, body: `[OP · re-ask · ${r.id}] No reply yet to #${r.source.msgId}: ${r.title.slice(0, 160)} — reply to #${r.source.msgId} with the result, or say what blocks it.` };
    }
    if (nowMs - Date.parse(route.reaskAt) < REASK_BACKOFF_MS) return { kind: 'hold', reason: `re-asked ${peer} at ${route.reaskAt}` };
    if (route.exceptionAt) return { kind: 'hold', reason: `exception sent to ${route.exceptionTo} at ${route.exceptionAt}` };
    const to = exceptionTarget(peer);
    if (!to) return { kind: 'stale', note: `${peer} silent after a re-ask on #${r.source.msgId} and no coordinator above it` };
    return { kind: 'exception', to, body: `[OP · exception · ${r.id}] ${peer} has not answered #${r.source.msgId} (re-asked ${route.reaskAt}): ${r.title.slice(0, 160)}` };
  }
  if (r.source.kind === 'p0-cell') {
    if (route.exceptionAt) return { kind: 'hold', reason: `exception sent to ${route.exceptionTo} at ${route.exceptionAt}` };
    const owner = r.cellOwner?.split(/[\s/,·]+/).find((x) => x.trim() && x.toUpperCase() !== self);
    const to = owner ? exceptionTarget(owner) : undefined;
    if (!to) return { kind: 'stale', note: `P0 cell ${r.source.cellId} blocked and its owner has no coordinator other than ${self}` };
    return { kind: 'exception', to, body: `[OP · exception · ${r.id}] P0 cell ${r.source.cellId} (owner ${r.cellOwner}) is stuck: ${r.title.slice(0, 160)} — close condition: ${r.closeCondition}` };
  }
  return { kind: 'stale', note: `CEO line ${r.source.turnId} blocked with no CEO-only gap (money · security · irreversible · policy)` };
}

/** Marks a blocked requirement stale (final): OP closed it itself with a one-line note. */
export function markStale(r: Requirement, note: string, at: string): void {
  r.status = 'stale';
  r.stale = { at, note };
  r.updatedAt = at;
  delete r.blocked;
}
