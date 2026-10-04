import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { TRACK_AGENT_FORBIDDEN_ACTION_REGEX, universeLaunch } from '../autopilot/track-agent.js';
import { debug } from '../debug/log.js';
import { surfaceEventsDbPath } from '../domains/surface-events.js';
import { judgeNeighbor } from '../loops/neighbors.js';
import { addHarnessQueue, harnessQueueIdForKey, harnessQueueOutcome, listHarnessQueue } from '../harness/harness-queue.js';
import { isRescueAllowedAction } from '../steward/rescue.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../instance/resolve.js';
import { loopEvent } from '../loops/observe.js';
import { getUserConfig, type PersonaLoopConfig, type SeatLoopConfig, type UserConfig } from '../user-config.js';
import { checkSeatBudget, type RunningSeatPod } from '../org/seat-budget.js';
import { DEFAULT_STALL_PARENTS, findStalls } from '../org/stall-escalation.js';
import { openMsgStore, type MessageEnvelope } from '../msg/msg-store.js';
import { loadLayeredPersonaDirs, resolveRepositoryPersonaDir, resolveStatePersonaDir } from '../persona/global-registry.js';
import { orderedPersonaTodos, personaTodoPath, readPersonaTodos, type PersonaTodo } from '../persona/persona-todo.js';
import { PersonaRegistry } from '../persona/registry.js';
import { recordSeatAskShadow } from '../seat-dispatch/seat-ask.js';
import { answerCrossCheck, answerSeat, askCrossCheck, askSeat, crossCheckAnswer, deliveredSeatQuestion, hasSeatAnswer, isSeatId, seatCrossChecks, seatQuestions, type CrossCheckJudgment, type SeatId } from '../seat-dispatch/seat-questions.js';
import { queryRunningRuns } from '../self-implement/running-runs.js';
import { checklistHistory, listChecklist, type Checklist } from '../release-loop/checklist.js';
import { readSchedules, releasedVersion } from '../release-loop/feature-store.js';

// `kind`/`createdAt` are the V3 shadow-compare keys (내부 문서 `METHOD-v3-shadow-compare-2026-10-02` · MK 10-02 18:54).
export type SeatItem = { source: 'request' | 'checklist' | 'hook' | 'seat-question'; kind?: 'request' | 'cell' | 'hook-task' | 'seat-question'; id: string; title: string; text: string; evidence?: string; status?: string; version?: string; seat?: string; evidenceHash?: string; asOf?: string; queuedAt?: string; createdAt?: string; from?: SeatId };
export type SeatInputs = { requests: SeatItem[]; checklist: SeatItem[]; role: string };
// V3 ledger row: `ts` · `item.id` · `item.kind` · `item.createdAt` · `action` (door, wait or skipped-*) · `reason` (matched rule or forbidden word).
export type SeatAction = 'decision' | 'harness' | 'wait' | 'seat-question' | 'seat-answer' | 'skipped-budget' | 'skipped-empty';
export type SeatInquiry = { to: SeatId | 'CEO'; question: string };
export type SeatReply = { answer: string } | { to: 'CEO'; question: string };
export type OpCandidate =
  | { kind: 'release-readiness'; version: string | null; verdict: 'ready' | 'not-ready' | 'no-open-release'; cutAt?: string; landBy?: string | null; red: string[]; undecided: string[]; blocked: string[] }
  | { kind: 'unassigned-cell'; version: string | null; id: string | null; title?: string; status?: string; verdict: 'assign' | 'none' }
  | { kind: 'decision-delegation'; id: string | null; title?: string; category?: DecisionEntry['category']; dueAt?: string; verdict: 'review-delegation' | 'none' };
export type TcCandidate =
  | { kind: 'merged-pr-yellow-cell'; version: string; id: string; title: string; pr: number; mergedAt: string }
  | { kind: 'publication-pr-approval-wait'; pr: number; title: string; readyAt: string; approvalWaitAt: string; paths: string[] }
  | { kind: 'other-seat-cell-defect'; version: string; id: string; title: string; to: SeatId };
export type TcPullRequest = { number: number; title: string; body?: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean; createdAt: string; updatedAt?: string; mergedAt?: string | null; readyAt?: string; approvalWaitAt?: string; paths?: string[]; reviewDecision?: string };
export type SeatEntry = { seat: string; ts?: string; at: string; status: 'shadow' | 'attempting' | 'outcome-unknown' | 'queued' | 'refused' | 'launched' | 'hitl' | 'wait' | 'asked' | 'answered' | 'awaiting-answer' | 'awaiting-xcheck' | 'awaiting-resolution' | 'resolved-by-neighbor' | 'rejected-no-evidence' | 'skipped-budget' | 'skipped-empty'; item?: SeatItem; candidate?: OpCandidate | TcCandidate; action?: SeatAction; reason?: string; runId?: string; queueId?: string; inquiry?: SeatInquiry; answer?: string; escalated?: boolean; xcheckRequestedAt?: string; xcheckQuestionId?: number; xcheckNeighbor?: SeatId; xcheckNote?: string; xcheckJudgmentEvidence?: string; xcheckWaitMinutes?: number };
export type SeatLoopResult = SeatEntry | { seat: string; status: 'skipped-off' };
export type PersonaShadowEntry = { personaId: string; ts: string; status: 'shadow' | 'skipped-empty'; todo: PersonaTodo | null; action?: 'decision' | 'harness' | 'wait'; what?: string };
export type SeatDeps = {
  personaConfig?: PersonaLoopConfig;
  personaRegistry?: PersonaRegistry;
  personaDir?: string;
  appendPersona?: (path: string, entry: PersonaShadowEntry) => void;
  root?: string;
  repo?: string;
  config?: SeatLoopConfig;
  budgetConfig?: Pick<UserConfig, 'org'>;
  running?: () => readonly RunningSeatPod[];
  escalate?: (parent: string, line: string) => Promise<void>;
  now?: () => Date;
  read?: (path: string) => string;
  run?: (args: string[]) => Promise<string>;
  enqueue?: (seat: string, text: string, root: string, idempotencyKey: string) => Promise<{ id: string }>;
  queueOutcome?: (id: string, root: string) => ReturnType<typeof harnessQueueOutcome>;
  queueItems?: (root: string) => ReturnType<typeof listHarnessQueue>;
  queueIdForKey?: (key: string, root: string) => string | undefined;
  append?: (path: string, entry: SeatEntry) => void;
  versions?: () => string[];
  /** Release schedules (version · cutAt) — a version is open while its cut is still ahead. Default reads the release ledger; unreadable ⇒ no checklist candidates (fail closed). */
  schedules?: () => Array<{ version: string; cutAt: string; landBy?: string | null }>;
  /** Checklist items of one version — default reads the release ledger DB (checklist.json is only a legacy import source since REL5b). */
  checklistItems?: (version: string) => Array<{ id: string; title: string; status: string; owner?: string | null; disposition?: string; evidence?: string }>;
  /** Chronological release-ledger events for a checklist id; injected for isolated release fixtures. */
  checklistHistory?: (id: string) => ReturnType<typeof checklistHistory>;
  /** Full checklist snapshot including history, for stall detection. */
  stallChecklist?: (version: string) => Checklist;
  /** Inject a mailbox write for isolated failure tests; production uses the seat message store. */
  stallDelivery?: (message: MessageEnvelope, key: string, root: string) => boolean;
  /** Open cards from the decision ledger; injected only for isolated ledger tests. */
  pendingDecisions?: () => Array<Pick<DecisionEntry, 'id' | 'title' | 'category' | 'dueAt'>>;
  /** Read-only PR snapshot for TC judgment; defaults to GitHub CLI reads. */
  pullRequests?: () => Promise<TcPullRequest[]>;
  ledgerFiles?: (directory: string) => string[];
  lockContended?: () => void;
  /** Supply a question only when this seat lacks evidence for the selected work item. */
  inquire?: (seat: SeatId, item: SeatItem) => Promise<SeatInquiry | null> | SeatInquiry | null;
  /** Supply the receiving seat's answer; absent evidence must not invent a reply. */
  reply?: (seat: SeatId, question: string, from: SeatId) => Promise<SeatReply | null> | SeatReply | null;
  /** Judge a decision draft against the receiving seat's evidence; null leaves the request pending. */
  crossCheck?: (seat: SeatId, draft: string, from: SeatId) => Promise<CrossCheckJudgment | null> | CrossCheckJudgment | null;
  decisionsConfig?: UserConfig['decisions'];
};

const repoRoot = resolve(import.meta.dir, '../..');
const exec = promisify(execFile);
const defaultRead = (path: string): string => {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
};
const defaultRun = async (args: string[]): Promise<string> => {
  const { argv, env } = universeLaunch(args);
  const { stdout } = await exec('bun', argv, {
    cwd: repoRoot, env, encoding: 'utf8',
    timeout: args[0] === 'harness' && args[1] === 'say' ? 3_600_000 : 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};
const defaultAppend = (path: string, entry: SeatEntry): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
};
const observe = (event: string, data: Record<string, unknown>): void => {
  try { debug.log('seat.loop', event, data); } catch { /* logging cannot change execution */ }
};

// SQLite's OS lock survives the awaited external call and is released if the process exits.
async function withSeatLock<T>(directory: string, action: () => Promise<T>, contended?: () => void): Promise<T> {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, '.once.mutex.sqlite');
  const db = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    const deadline = Date.now() + 120_000;
    let signalled = false;
    while (true) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
        if (!signalled) { contended?.(); signalled = true; }
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    try { return await action(); }
    finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}

export function seatDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function seatLedgerPath(seat: string, root: string, now: Date): string {
  return join(root, 'seat-loop', seat, `${seatDay(now)}.jsonl`);
}

export function personaShadowLedgerPath(personaId: string, root: string, now: Date): string {
  // Use the todo module's ID guard for this second per-persona filesystem path too.
  personaTodoPath(root, personaId);
  return join(root, 'persona-loop', personaId, `${seatDay(now)}.jsonl`);
}

export async function runPersonaLoopOnce(name: string, deps: SeatDeps = {}): Promise<PersonaShadowEntry> {
  const entries = await pickPersonaShadows(deps, name);
  return entries[0]!;
}

export async function runPersonaShadowOnce(deps: SeatDeps = {}): Promise<PersonaShadowEntry[]> {
  if ((deps.personaConfig ?? getUserConfig().loops?.persona)?.enabled !== true) return [];
  return pickPersonaShadows(deps);
}

async function pickPersonaShadows(deps: SeatDeps, name?: string): Promise<PersonaShadowEntry[]> {
  const root = deps.root ?? effectiveInstanceRoot();
  const dir = deps.personaDir ?? (deps.root ? join(root, 'personas') : resolveStatePersonaDir());
  const registry = deps.personaRegistry ?? new PersonaRegistry();
  if (!deps.personaRegistry) {
    const loaded = await loadLayeredPersonaDirs(registry, deps.root ? [dir] : [dir, resolveRepositoryPersonaDir()]);
    for (const error of loaded.errors) observe('persona-load-error', { error });
  }
  const now = (deps.now ?? (() => new Date()))();
  const entries: PersonaShadowEntry[] = [];
  const profiles = registry.list().sort((a, b) => a.personaId.localeCompare(b.personaId));
  const selected = name === undefined ? profiles : profiles.filter((profile) => profile.personaId.toLowerCase() === name.trim().toLowerCase()
    || profile.displayName.toLowerCase() === name.trim().toLowerCase());
  if (name !== undefined && selected.length !== 1) throw new Error(selected.length ? `ambiguous persona name: ${name}` : `persona not found: ${name}`);
  for (const profile of selected) {
    const personaId = profile.personaId;
    const todoFile = profile.todo ?? `${personaId}.todo.jsonl`;
    const { todos, errors } = readPersonaTodos(dir, todoFile.slice(0, -'.todo.jsonl'.length));
    for (const error of errors) observe('persona-todo-error', { personaId, error });
    const candidates = orderedPersonaTodos(todos);
    const picked = pickNext({ requests: candidates.map((candidate) => ({
      source: 'request', id: candidate.id, title: candidate.title, text: candidate.title, createdAt: candidate.createdAt,
    })), checklist: [], role: '' }, [], { shadow: true });
    const todo = picked ? candidates.find((candidate) => candidate.id === picked.id) ?? null : null;
    const planned = name !== undefined && todo && picked ? planAction(picked, profile.seat) : undefined;
    const entry: PersonaShadowEntry = { personaId, ts: now.toISOString(), status: todo ? 'shadow' : 'skipped-empty', todo,
      ...(planned ? { action: planned.kind, what: planned.text } : {}) };
    const path = personaShadowLedgerPath(personaId, root, now);
    if (deps.appendPersona) deps.appendPersona(path, entry);
    else {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
    try { debug.log('persona.loop', 'picked', { personaId, status: entry.status, todoId: todo?.id ?? null, title: todo?.title ?? null, action: entry.action ?? null }); }
    catch { /* observation cannot alter the shadow ledger */ }
    entries.push(entry);
  }
  return entries;
}

export async function runSeatLoopTurn(seat: string, deps: SeatDeps = {}): Promise<SeatLoopResult> {
  const result = await runSeatLoopOnce(seat, deps);
  try { await runPersonaShadowOnce(deps); }
  catch (error) { observe('persona-shadow-error', { error: String(error).slice(0, 200) }); }
  try {
    const config = deps.config ?? getUserConfig().loops?.seat ?? { mode: 'off' };
    const profile = result.status === 'skipped-off' ? 'off' : config.mode;
    const context = { runId: 'runId' in result && result.runId ? result.runId : `seat-turn-${randomUUID()}`,
      profile, sourceRef: `docs/roles/${seat}.md` };
    const loopId = `${seat.toLowerCase()}-seat`;
    loopEvent(loopId, 'tick', { ...context, outcome: result.status, reason: result.status });
    if ('inquiry' in result && result.inquiry && (result.status === 'asked' || result.status === 'hitl')) {
      loopEvent(loopId, 'exchange', { ...context, outcome: result.status, reason: 'delegation',
        from: seat, to: result.inquiry.to, itemId: result.item?.id });
    }
    if ('escalated' in result && result.escalated && result.status === 'skipped-budget') {
      loopEvent(loopId, 'exchange', { ...context, outcome: result.status, reason: 'delegation',
        from: seat, to: (config.stall?.parents ?? {})[seat] ?? DEFAULT_STALL_PARENTS[seat], itemId: result.item?.id });
    } else if (result.status === 'skipped-budget') {
      loopEvent(loopId, 'exchange', { ...context, outcome: result.status, reason: 'requeue',
        itemId: result.item?.id });
    }
  } catch { /* observation cannot change a completed seat turn */ }
  return result;
}

function rows(text: string): Record<string, unknown>[] {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function versionOrder(a: string, b: string): number {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  return (aa[0]! - bb[0]!) || (aa[1]! - bb[1]!) || (aa[2]! - bb[2]!);
}

function itemKey(item: SeatItem): string { return `${item.source}:${item.version ?? ''}:${item.id}`; }

function handledItemKey(item: SeatItem): string {
  return `${itemKey(item)}:${JSON.stringify([item.evidenceHash ?? null, itemSnapshot(item)])}`;
}

function queueKey(seat: string, item: SeatItem): string {
  return `seat-loop:${seat}:${createHash('sha256').update(handledItemKey(item)).digest('hex')}`;
}

/** A crash (or a failed write) between AUTOQ enqueue and the `queued` row leaves an `attempting`/`outcome-unknown` row with no queue id. Find its queue row by the
 *  seat-loop idempotency key so the outcome below (retry · launched · still queued) applies to it too (LOOP-LIVE1 review must-fix). */
function recoverAttemptingQueueIds(ledger: readonly SeatEntry[], root: string, deps: SeatDeps): SeatEntry[] {
  const unsettled = (entry: SeatEntry) => (entry.status === 'attempting' || entry.status === 'outcome-unknown') && entry.action === 'harness' && !entry.queueId && !!entry.item;
  const attempting = ledger.filter(unsettled);
  if (attempting.length === 0) return [...ledger];
  let rows: ReturnType<typeof listHarnessQueue>;
  try { rows = (deps.queueItems ?? ((stateRoot: string) => listHarnessQueue({ root: stateRoot })))(root); }
  catch (error) { observe('queue-recovery-unreadable', { error: String(error).slice(0, 200) }); return [...ledger]; }
  return ledger.map((entry, index) => {
    const item = entry.item;
    if (!unsettled(entry) || !item) return entry;
    const key = handledItemKey(item);
    // A later row for the same item already settled this attempt.
    if (ledger.slice(index + 1).some((later) => later.seat === entry.seat && later.item && handledItemKey(later.item) === key && later.status !== 'attempting' && later.status !== 'outcome-unknown')) return entry;
    const row = rows.find((candidate) => candidate.seat === entry.seat && candidate.idempotencyKey === queueKey(entry.seat, item)
      && candidate.input === seatTaskText(entry.seat, item));
    // The row may already have left the queue (finished · cancelled); its settled id is kept by key.
    const id = row?.id ?? (deps.queueIdForKey ?? ((key: string, stateRoot: string) => harnessQueueIdForKey(key, { root: stateRoot })))(queueKey(entry.seat, item), root);
    if (!id) return entry;
    observe('queue-recovered', { seat: entry.seat, item: item.id, queueId: id, from: row ? 'queue' : 'key-marker' });
    return { ...entry, status: 'queued' as const, queueId: id };
  });
}

function reconciledQueueLedger(recorded: readonly SeatEntry[], root: string, deps: SeatDeps): SeatEntry[] {
  const ledger = recoverAttemptingQueueIds(recorded, root, deps);
  const outcome = deps.queueOutcome ?? ((id: string, stateRoot: string) => harnessQueueOutcome(id, { root: stateRoot }));
  const retryable = new Set(ledger.filter((entry) => entry.status === 'queued' && entry.queueId
    && outcome(entry.queueId, root) === 'retryable' && entry.item).map((entry) => `${entry.seat}:${handledItemKey(entry.item!)}`));
  const pending = new Set(ledger.filter((entry) => entry.status === 'queued' && entry.queueId
    && ['pending', 'unknown'].includes(outcome(entry.queueId, root)) && entry.item).map((entry) => `${entry.seat}:${handledItemKey(entry.item!)}`));
  const succeeded = new Set(ledger.filter((entry) => entry.status === 'queued' && entry.queueId
    && outcome(entry.queueId, root) === 'succeeded' && entry.item).map((entry) => `${entry.seat}:${handledItemKey(entry.item!)}`));
  return ledger.map((entry) => {
    if (entry.status === 'attempting' && entry.item) {
      const key = `${entry.seat}:${handledItemKey(entry.item)}`;
      if (retryable.has(key) && !pending.has(key) && !succeeded.has(key)) return { ...entry, status: 'refused' as const };
    }
    if (entry.status !== 'queued' || !entry.queueId) return entry;
    const state = outcome(entry.queueId, root);
    if (state === 'retryable') {
      observe('queue-retryable', { seat: entry.seat, item: entry.item?.id, queueId: entry.queueId });
      return { ...entry, status: entry.item && (pending.has(`${entry.seat}:${handledItemKey(entry.item)}`) || succeeded.has(`${entry.seat}:${handledItemKey(entry.item)}`)) ? 'queued' as const : 'refused' as const,
        reason: 'AUTOQ failed or cancelled; eligible for retry' };
    }
    return { ...entry, status: state === 'succeeded' ? 'launched' as const : entry.status };
  });
}

function itemSnapshot(item: SeatItem): string {
  return JSON.stringify([item.title, item.text, item.evidence ?? null, item.status ?? null]);
}

function decisionRef(seat: string, item: SeatItem): string {
  return `seat-loop:${seat}:${encodeURIComponent(itemKey(item))}`;
}

function decisionReceipt(root: string, seat: string, item: SeatItem): DecisionEntry | undefined {
  const ref = decisionRef(seat, item);
  return new DecisionLedger({ stateDir: root }).list({ status: 'all' }).find((card) => card.refs?.includes(ref));
}

// RM3 (asked/answered · decision-card receipts for seat inquiries) ⊕ main (checklist cells re-picked by evidence, not by a shadow row).
function handledKeys(ledger: readonly SeatEntry[], shadow: boolean, root?: string, liveSafe = false): Set<string> {
  const inquiryRow = (entry: SeatEntry) => entry.action === 'seat-question' || entry.action === 'seat-answer' || !!entry.inquiry;
  return new Set(ledger.filter((entry, index) => entry.status === 'asked' || entry.status === 'answered'
    || entry.status === 'resolved-by-neighbor'
    // RM3a: only TC's other-seat defect ask-shadows are deduplicated here — an ordinary inquiry recorded in shadow must still be delivered once questions turn on.
    || (entry.status === 'shadow' && entry.candidate?.kind === 'other-seat-cell-defect')
    || (entry.status === 'hitl' && (!entry.inquiry || (!!root && !!entry.item && !!decisionReceipt(root, entry.seat, entry.item))))
    || (entry.inquiry?.to === 'CEO' && !!root && !!entry.item && !!decisionReceipt(root, entry.seat, entry.item))
    || (!inquiryRow(entry) && (entry.status === 'queued' || entry.status === 'outcome-unknown'))
    || (!inquiryRow(entry) && entry.status === 'attempting' && !(entry.item?.source === 'checklist' && ledger.slice(index + 1).some((later) =>
      later.seat === entry.seat && later.status === 'launched' && later.item?.source === 'checklist'
      && later.item.version === entry.item?.version && later.item.id === entry.item?.id
      && later.item.title === entry.item?.title && later.item.evidenceHash === entry.item?.evidenceHash)))
    || (shadow && entry.status === 'shadow' && entry.action !== 'wait' && entry.item?.source !== 'checklist')
    || (entry.status === 'launched' && entry.item?.source !== 'checklist'))
    .filter((entry): entry is SeatEntry & { item: SeatItem } => !!entry.item && !!entry.item.source && typeof entry.item.id === 'string')
    .map((entry) => !liveSafe || inquiryRow(entry) ? itemKey(entry.item) : handledItemKey(entry.item)));
}

function eligibleItem(item: SeatItem, ledger: readonly SeatEntry[], handled: ReadonlySet<string>, shadow: boolean): boolean {
  const key = itemKey(item);
  if (handled.has(key) || handled.has(handledItemKey(item))) return false;
  const rejected = [...ledger].reverse().find((entry) => entry.item && itemKey(entry.item) === key && entry.status === 'rejected-no-evidence');
  if (rejected?.item && itemSnapshot(rejected.item) === itemSnapshot(item)) return false;
  const lastWait = [...ledger].reverse().find((entry) => entry.item && itemKey(entry.item) === key
    && (entry.status === 'wait' || (shadow && entry.status === 'shadow' && entry.action === 'wait')));
  return !lastWait?.item || itemSnapshot(lastWait.item) !== itemSnapshot(item);
}

const CHECKLIST_HANDLED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Same-version snapshots are handled here; carried work requires an explicit release-ledger move.
export function alreadyHandled(item: SeatItem, ledger: readonly SeatEntry[]): boolean {
  if (item.source !== 'checklist' || !item.seat || !item.asOf || item.evidenceHash === undefined) return false;
  const now = Date.parse(item.asOf);
  if (!Number.isFinite(now)) return false;
  return ledger.some((entry) => {
    const at = Date.parse(entry.at || entry.ts || '');
    return entry.seat === item.seat && at >= now - CHECKLIST_HANDLED_WINDOW_MS && at <= now
      // A shadowed seat question was never delivered — it must be picked again once delivery is on (RM3 · TC merge 10-03).
      && (entry.status === 'launched' || entry.status === 'queued' || (entry.status === 'shadow' && !entry.inquiry))
      && entry.item?.source === 'checklist' && entry.item.id === item.id && entry.item.version === item.version
      && entry.item.title === item.title && entry.item.evidenceHash === item.evidenceHash;
  });
}

function readSeatLedger(seat: string, deps: SeatDeps, now: Date): SeatEntry[] {
  const directory = dirname(seatLedgerPath(seat, deps.root ?? effectiveInstanceRoot(), now));
  const files = deps.ledgerFiles?.(directory) ?? (existsSync(directory) ? readdirSync(directory) : []);
  return files.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name <= `${seatDay(now)}.jsonl`)
    .flatMap((name) => rows((deps.read ?? defaultRead)(join(directory, name))) as SeatEntry[]);
}

export async function gatherSeatInputs(seat: string, deps: SeatDeps = {}, ledger?: readonly SeatEntry[]): Promise<SeatInputs> {
  const read = deps.read ?? defaultRead;
  const root = deps.root ?? effectiveInstanceRoot();
  const activeLedger = ledger ?? readSeatLedger(seat, deps, (deps.now ?? (() => new Date()))());
  const mode = (deps.config ?? getUserConfig().loops?.seat)?.mode;
  const consumed = handledKeys(activeLedger, mode === 'shadow', root, mode === 'live-safe');
  const requests = new Map<string, Record<string, unknown>>();
  for (const row of rows(read(join(root, 'seat-requests', 'requests.jsonl')))) {
    if (typeof row.key === 'string') requests.set(row.key, row);
  }
  const pending: SeatItem[] = seatQuestions(root, seat as SeatId)
    .filter((message) => !hasSeatAnswer(root, message) && !consumed.has(`seat-question::${message.id}`))
    .map((message) => ({ source: 'seat-question', kind: 'seat-question', id: String(message.id), title: message.body, text: message.body,
      from: message.from as SeatId, queuedAt: message.createdAt, createdAt: message.createdAt }));
  const ordinary: SeatItem[] = [...requests.values()]
    .filter((row) => row.seat === seat && (row.status === 'pending' || row.status === 'queued') && typeof row.text === 'string')
    .map((row) => ({ source: 'request' as const, kind: 'request' as const, id: String(row.key), title: String(row.text), text: String(row.text), ...(typeof row.evidence === 'string' ? { evidence: row.evidence } : {}), queuedAt: String(row.queuedAt ?? ''), createdAt: String(row.queuedAt ?? '') }))
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
  const store = openMsgStore(join(root, 'msg', 'messages.db'));
  const hookMessages: ReturnType<typeof store.listByRecipient> = [];
  try {
    let cursor = 0;
    while (true) {
      const batch = store.listByRecipient(seat, cursor, 1000);
      hookMessages.push(...batch.filter(message => message.kind === 'hook-task'));
      if (batch.length < 1000) break;
      cursor = batch[batch.length - 1]!.id;
    }
  } finally { store.close(); }
  for (const message of hookMessages) {
    const item: SeatItem = { source: 'hook', kind: 'hook-task', id: String(message.id), title: message.body, text: message.body, queuedAt: message.createdAt, createdAt: message.createdAt };
    if (eligibleItem(item, activeLedger, consumed, (deps.config ?? getUserConfig().loops?.seat)?.mode === 'shadow')) ordinary.push(item);
  }
  ordinary.sort((a, b) => (a.queuedAt ?? '').localeCompare(b.queuedAt ?? '') || a.id.localeCompare(b.id));
  pending.push(...ordinary);
  const releaseRoot = deps.root ?? releaseLedgerRoot();
  const versions = deps.versions ?? (() => {
    const dir = join(releaseRoot, 'release');
    const fromDirs = existsSync(dir) ? readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)) : [];
    let fromSchedule: string[] = [];
    try { fromSchedule = readSchedules().map((row) => row.version); } catch { /* ledger unreadable — directories only */ }
    return [...new Set([...fromDirs, ...fromSchedule])].filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  });
  const itemsOf = deps.checklistItems ?? ((version: string) => listChecklist(version, releaseRoot).items);
  let shipped: string | undefined;
  try { shipped = releasedVersion(releaseRoot); }
  catch (error) {
    console.warn(`seat loop: cannot read published versions; retaining previous order (${String(error).slice(0, 200)})`);
  }
  // UX J2 criterion (10-03): only versions whose cut is still ahead are open; if the schedule can't be read, pick no cell.
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const nowMs = Date.parse(asOf);
  let open: Set<string> | null = null;
  try {
    const rows = (deps.schedules ?? (() => readSchedules()))();
    open = new Set(rows.filter((row) => Number.isFinite(Date.parse(row.cutAt)) && Date.parse(row.cutAt) > nowMs).map((row) => row.version));
  } catch (error) {
    console.warn(`seat loop: cannot read release schedules; no checklist cell is picked (${String(error).slice(0, 200)})`);
    debug.log('seat.loop', 'schedule-unreadable', { seat, error: String(error).slice(0, 200) });
  }
  const checklist: SeatItem[] = [];
  const closed: string[] = [];
  for (const version of open === null ? [] : versions().sort(versionOrder)) {
    if (!open!.has(version)) {
      closed.push(version);
      continue;
    }
    let items: ReturnType<typeof itemsOf>;
    try { items = itemsOf(version); } catch (error) {
      debug.log('seat.loop', 'checklist-unreadable', { seat, version, error: String(error).slice(0, 200) });
      continue;
    }
    if (shipped && versionOrder(version, shipped) <= 0) {
      const cells = items.filter((item) => item.owner === seat && (item.status === 'yellow' || item.status === 'red')).length;
      debug.log('seat.loop', 'skip-shipped-version', { version, cells });
      continue;
    }
    for (const item of items) {
      if (item.owner === seat && (item.status === 'yellow' || item.status === 'red')) {
        checklist.push({ source: 'checklist', kind: 'cell', version, seat, asOf, id: item.id, title: item.title, text: item.title, status: item.status,
          ...(item.evidence ? { evidence: item.evidence } : {}), evidenceHash: createHash('sha256').update(item.evidence ?? '').digest('hex') });
      }
    }
  }
  if (closed.length > 0) {
    debug.log('seat.loop', 'skip-closed-versions', { seat, count: closed.length, newest: closed.at(-1)!, oldest: closed[0]! });
  }
  checklist.sort((a, b) => versionOrder(a.version!, b.version!) || a.id.localeCompare(b.id));
  const ownedEvidence = checklist.filter((item) => item.evidence?.trim())
    .map((item) => `${item.id} · ${item.title}: ${item.evidence!.trim()}`).join('\n').slice(0, 8_000);
  for (const request of pending) {
    if (request.source === 'seat-question' && ownedEvidence) request.evidence = ownedEvidence;
  }
  return { requests: pending, checklist, role: read(join(deps.repo ?? repoRoot, 'docs', 'roles', `${seat}.md`)).slice(0, 4_000) };
}

function opCandidates(deps: SeatDeps, now: Date): OpCandidate[] {
  const releaseRoot = deps.root ?? releaseLedgerRoot();
  const shipped = releasedVersion(releaseRoot);
  let schedules: ReturnType<NonNullable<SeatDeps['schedules']>>;
  try { schedules = (deps.schedules ?? (() => readSchedules(releaseRoot)))(); }
  catch (error) {
    observe('schedule-unreadable', { seat: 'OP', error: String(error).slice(0, 200) });
    throw error;
  }
  const open = schedules.filter((row) => /^\d+\.\d+\.\d+$/.test(row.version)
    && Number.isFinite(Date.parse(row.cutAt)) && Date.parse(row.cutAt) > now.getTime()
    && (!shipped || versionOrder(row.version, shipped) > 0)).sort((a, b) => versionOrder(a.version, b.version));
  const itemsOf = deps.checklistItems ?? ((version: string) => listChecklist(version).items);
  const releases = open.map((schedule) => ({ schedule, items: itemsOf(schedule.version).sort((a, b) => a.id.localeCompare(b.id)) }));
  const first = releases[0];
  const red = first?.items.filter((item) => item.status === 'red').map((item) => item.id) ?? [];
  const undecided = first?.items.filter((item) => item.status === 'yellow' && !item.disposition).map((item) => item.id) ?? [];
  const blocked = first?.items.filter((item) => item.status === 'yellow' && item.disposition === 'block').map((item) => item.id) ?? [];
  const ready = first !== undefined && first.items.length > 0 && first.items.every((item) =>
    item.status === 'green' || item.status === 'done'
    || (item.status === 'yellow' && (item.disposition === 'move' || item.disposition === 'known-issue')));
  const unassigned = releases.flatMap(({ schedule, items }) => items
    .filter((item) => !item.owner && (item.status === 'yellow' || item.status === 'red'))
    .map((item): OpCandidate => ({ kind: 'unassigned-cell', version: schedule.version, id: item.id,
      title: item.title, status: item.status, verdict: 'assign' })));
  const pending = (deps.pendingDecisions ?? (() => new DecisionLedger({ stateDir: deps.root }).list({ status: 'open' })))()
    .sort((a, b) => (a.dueAt ?? '\uffff').localeCompare(b.dueAt ?? '\uffff') || a.id.localeCompare(b.id))[0];
  return [
    { kind: 'release-readiness', version: first?.schedule.version ?? null,
      verdict: !first ? 'no-open-release' : ready ? 'ready' : 'not-ready',
      ...(first ? { cutAt: first.schedule.cutAt, landBy: first.schedule.landBy ?? null } : {}), red, undecided, blocked },
    ...(unassigned.length ? unassigned : [{ kind: 'unassigned-cell' as const, version: null, id: null, verdict: 'none' as const }]),
    { kind: 'decision-delegation', id: pending?.id ?? null,
      ...(pending ? { title: pending.title, category: pending.category, ...(pending.dueAt ? { dueAt: pending.dueAt } : {}) } : {}),
      verdict: pending ? 'review-delegation' : 'none' },
  ];
}

const TC_APPROVAL_WAIT_MS = 2 * 60 * 60 * 1000;

function readTcChecklist(root: string): Array<{ version: string; id: string; title: string; status: string; owner: string | null }> {
  const path = join(root, 'release', 'features.sqlite');
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, strict: true });
  try {
    return db.query(`SELECT a.version, f.id, COALESCE(a.title_override, f.title) AS title, a.status, a.owner
      FROM assignments a JOIN features f ON f.id = a.feature_id WHERE a.status IN ('yellow', 'red') AND a.owner IN ('OP', 'TC', 'MK', 'UX')
      ORDER BY a.version, f.id`).all() as Array<{ version: string; id: string; title: string; status: string; owner: string | null }>;
  } finally { db.close(); }
}

type TcTimelineEvent = { event: string; created_at: string };

export function tcApprovalWaitAt(pr: TcPullRequest, timeline: readonly TcTimelineEvent[]): { readyAt: string; approvalWaitAt: string } | undefined {
  if (pr.state !== 'OPEN' || pr.isDraft || pr.reviewDecision !== 'REVIEW_REQUIRED') return undefined;
  const events = timeline.filter((event) => typeof event.created_at === 'string' && Number.isFinite(Date.parse(event.created_at)))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let readyAt: string | undefined = pr.createdAt;
  let waitAt: string | undefined = pr.createdAt;
  for (const event of events) {
    if (event.event === 'converted_to_draft') { readyAt = undefined; waitAt = undefined; }
    if (event.event === 'ready_for_review') { readyAt = event.created_at; waitAt = event.created_at; }
    if (event.event === 'review_requested' && readyAt && Date.parse(event.created_at) >= Date.parse(readyAt)) waitAt = event.created_at;
  }
  return readyAt && waitAt && Number.isFinite(Date.parse(readyAt)) && Date.parse(waitAt) >= Date.parse(readyAt)
    ? { readyAt, approvalWaitAt: waitAt } : undefined;
}

export async function readTcPullRequests(query: (args: string[]) => Promise<string> = async (args) => {
  const { stdout } = await exec('gh', args, { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}): Promise<TcPullRequest[]> {
  const pages: unknown = JSON.parse(await query(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/pulls?state=all&per_page=100']));
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) throw new Error('PR list is not an array of pages');
  const prs = pages.flatMap((page: unknown[]) => page).filter((pr) => pr && typeof pr === 'object'
    && ((pr as Record<string, unknown>).state === 'open' || typeof (pr as Record<string, unknown>).merged_at === 'string'));
  const results: TcPullRequest[] = [];
  for (let offset = 0; offset < prs.length; offset += 10) {
    results.push(...await Promise.all(prs.slice(offset, offset + 10).map(async (pr): Promise<TcPullRequest> => {
    const listing = pr as Record<string, unknown>;
    if (typeof listing.number !== 'number' || typeof listing.title !== 'string' || typeof listing.created_at !== 'string'
      || typeof listing.draft !== 'boolean' || (listing.state !== 'open' && listing.state !== 'closed')) {
      throw new Error('incomplete PR record');
    }
    const details: unknown = listing.state === 'open'
      ? JSON.parse(await query(['pr', 'view', String(listing.number), '--json', 'number,title,body,state,isDraft,createdAt,mergedAt,files,reviewDecision']))
      : { number: listing.number, title: listing.title, body: listing.body, state: 'MERGED', isDraft: listing.draft,
        createdAt: listing.created_at, mergedAt: listing.merged_at, files: [] };
    if (!details || typeof details !== 'object' || Array.isArray(details)) throw new Error('invalid PR record');
    const row = details as Record<string, unknown>;
    if (typeof row.number !== 'number' || typeof row.title !== 'string' || typeof row.createdAt !== 'string'
      || typeof row.isDraft !== 'boolean' || (row.state !== 'OPEN' && row.state !== 'MERGED' && row.state !== 'CLOSED')) {
      throw new Error('incomplete PR record');
    }
    const paths = Array.isArray(row.files) ? row.files.flatMap((file: unknown) =>
      file && typeof file === 'object' && typeof (file as { path?: unknown }).path === 'string' ? [(file as { path: string }).path] : []) : [];
    const result: TcPullRequest = { number: row.number, title: row.title, body: typeof row.body === 'string' ? row.body : '',
      state: row.state, isDraft: row.isDraft, createdAt: row.createdAt,
      mergedAt: typeof row.mergedAt === 'string' ? row.mergedAt : null, paths,
      reviewDecision: typeof row.reviewDecision === 'string' ? row.reviewDecision : undefined };
    if (result.state === 'OPEN' && !result.isDraft && result.reviewDecision === 'REVIEW_REQUIRED'
      && paths.some((path) => path.startsWith('release/public/') || path.startsWith('scripts/public-export') || path.startsWith('src/market/'))) {
      try {
        const pages: unknown = JSON.parse(await query(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${result.number}/timeline`]));
        if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) throw new Error('PR timeline is not an array of pages');
        const timeline: unknown[] = pages.flatMap((page: unknown[]) => page);
        const transitions = timeline.filter((event): event is Record<string, unknown> => event !== null && typeof event === 'object'
          && ['converted_to_draft', 'ready_for_review', 'review_requested'].includes((event as Record<string, unknown>).event as string));
        if (!transitions.every((event) => typeof event.created_at === 'string' && Number.isFinite(Date.parse(event.created_at)))) {
          throw new Error('invalid PR timeline transition date');
        }
        Object.assign(result, tcApprovalWaitAt(result, transitions as TcTimelineEvent[]));
      } catch (error) { observe('tc-pr-timeline-unreadable', { pr: result.number, error: String(error).slice(0, 200) }); }
    }
    return result;
    })));
  }
  return results;
}

async function tcCandidates(deps: SeatDeps, now: Date): Promise<TcCandidate[]> {
  let prs: TcPullRequest[];
  // An injected instance root must not fetch unrelated live GitHub state.
  try { prs = await (deps.pullRequests ?? (deps.root ? async () => [] : readTcPullRequests))(); }
  catch (error) {
    observe('tc-pr-unreadable', { seat: 'TC', error: String(error).slice(0, 200) });
    return [];
  }
  const merged = prs.filter((pr) => pr.state === 'MERGED' && pr.mergedAt && Number.isFinite(Date.parse(pr.mergedAt)) && Date.parse(pr.mergedAt) <= now.getTime());
  const candidates: TcCandidate[] = [];
  const releaseRoot = deps.root ?? releaseLedgerRoot();
  try {
    const cells = deps.checklistItems && deps.schedules
      ? deps.schedules().flatMap(({ version }) => deps.checklistItems!(version).map((cell) => ({ ...cell, version })))
      : readTcChecklist(releaseRoot);
    let shipped: string | undefined;
    try { shipped = releasedVersion(releaseRoot); }
    catch (error) { observe('tc-release-unreadable', { seat: 'TC', error: String(error).slice(0, 200) }); }
    const openVersions = deps.schedules ? new Set(deps.schedules().filter(({ cutAt }) => Number.isFinite(Date.parse(cutAt))
      && Date.parse(cutAt) > now.getTime()).map(({ version }) => version)) : null;
    for (const cell of cells) {
      if (cell.owner !== 'TC' && ((shipped && versionOrder(cell.version, shipped) <= 0) || (openVersions && !openVersions.has(cell.version)))) continue;
      if (cell.status !== 'yellow' && cell.status !== 'red') continue;
      if (!cell.owner || !isSeatId(cell.owner)) continue;
      if (cell.owner !== 'TC') {
        if (cell.status === 'red') candidates.push({ kind: 'other-seat-cell-defect', version: cell.version, id: cell.id, title: cell.title, to: cell.owner });
        continue;
      }
      for (const pr of merged) {
        const id = cell.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const reference = new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`);
        if (reference.test(pr.title) || reference.test(pr.body ?? '')) {
          if (cell.owner === 'TC' && cell.status === 'yellow') candidates.push({ kind: 'merged-pr-yellow-cell', version: cell.version, id: cell.id, title: cell.title, pr: pr.number, mergedAt: pr.mergedAt! });
        }
      }
    }
  } catch (error) { observe('tc-checklist-unreadable', { seat: 'TC', error: String(error).slice(0, 200) }); }
  for (const pr of prs) {
    if (pr.state !== 'OPEN' || pr.isDraft || pr.reviewDecision !== 'REVIEW_REQUIRED'
      || !pr.paths?.some((path) => path.startsWith('release/public/') || path.startsWith('scripts/public-export') || path.startsWith('src/market/'))) continue;
    const readyAt = pr.readyAt;
    const age = now.getTime() - Date.parse(pr.approvalWaitAt ?? '');
    if (!readyAt || !Number.isFinite(Date.parse(readyAt)) || Date.parse(readyAt) > now.getTime()
      || !Number.isFinite(age) || age < TC_APPROVAL_WAIT_MS) continue;
    candidates.push({ kind: 'publication-pr-approval-wait', pr: pr.number, title: pr.title, readyAt, approvalWaitAt: pr.approvalWaitAt!, paths: pr.paths });
  }
  return candidates;
}

function deliverStall(message: MessageEnvelope, key: string, root: string): boolean {
  const store = openMsgStore(join(root, 'msg', 'messages.db'));
  try {
    // Persist the exact stall identity alongside its message, atomically across processes.
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db.exec('CREATE TABLE IF NOT EXISTS seat_stall_deliveries (key TEXT PRIMARY KEY)');
      const inserted = store.db.query('INSERT OR IGNORE INTO seat_stall_deliveries (key) VALUES (?)').run(key);
      if (inserted.changes === 0) { store.db.exec('COMMIT'); return false; }
      store.append(message);
      store.db.exec('COMMIT');
      return true;
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  } finally { store.close(); }
}

function escalateStalls(seat: string, deps: SeatDeps, config: SeatLoopConfig, now: Date): void {
  const root = deps.root ?? releaseLedgerRoot();
  const schedules = (deps.schedules ?? (() => readSchedules(root)))();
  const shipped = releasedVersion(root);
  const failures: Error[] = [];
  for (const schedule of schedules) {
    if (!/^\d+\.\d+\.\d+$/.test(schedule.version)
      || !Number.isFinite(Date.parse(schedule.cutAt)) || Date.parse(schedule.cutAt) <= now.getTime()
      || (shipped && versionOrder(schedule.version, shipped) <= 0)) continue;
    try {
      // Same ledger root as the schedules and shipped version above (TC harvest · review round 3).
      const checklist = (deps.stallChecklist ?? ((version: string) => listChecklist(version, deps.root)))(schedule.version);
      for (const stall of findStalls(checklist, config, now)) {
        if (stall.from !== seat) continue;
        const { item, from, to, stalledMin, startedAt, reason } = stall;
        const data = { item: item.id, from, to, stalledMin, version: schedule.version, reason };
        if (config.mode === 'shadow') {
          debug.log('org.stall', 'escalate', { ...data, mode: 'shadow' });
          continue;
        }
        if (config.mode === 'live-safe' && !isRescueAllowedAction('alert')) {
          observe('refused', { seat, item: item.id, action: 'alert', reason: 'policy denied internal stall alert' });
          continue;
        }
        const key = JSON.stringify([schedule.version, item.id, from, to, reason, startedAt]);
        const message: MessageEnvelope = { from, to, kind: 'stall-escalation',
          body: `[stall:${key}] ${schedule.version} 체크리스트 ${item.id} · ${item.title} · ${reason} · ${stalledMin}분 정체 (${from} → ${to})` };
        try {
          const sent = (deps.stallDelivery ?? deliverStall)(message, key, deps.root ?? effectiveInstanceRoot());
          if (sent) debug.log('org.stall', 'escalate', data);
        } catch (error) {
          failures.push(new Error(`stall escalation ${schedule.version}/${item.id}: ${String(error)}`, { cause: error }));
        }
      }
    } catch (error) {
      failures.push(new Error(`stall checklist ${schedule.version}: ${String(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, `stall escalation failed for ${seat}: ${failures.map((error) => error.message).join('; ')}`);
}

// In shadow mode a shadowed item counts as handled, so a rehearsal day walks the queue like the seat would.
export function pickNext(inputs: SeatInputs, ledger: readonly SeatEntry[], opts: { shadow?: boolean; liveSafe?: boolean; root?: string; history?: SeatDeps['checklistHistory'] } = {}): SeatItem | null {
  const handled = handledKeys(ledger, opts.shadow === true, opts.root, opts.liveSafe === true);
  return [...inputs.requests, ...inputs.checklist].find((item) => {
    if (alreadyHandled(item, ledger)) {
      debug.log('seat.loop', 'skip-handled', { id: item.id });
      return false;
    }
    if (item.source === 'checklist' && item.version && item.seat && item.asOf && item.evidenceHash !== undefined && opts.history
      && ledger.some((entry) => entry.seat === item.seat && entry.status === 'shadow'
        && entry.item?.source === 'checklist' && entry.item.id === item.id && entry.item.version !== item.version)) {
      // Only an actual move into this version identifies a carried cell; unrelated releases may reuse an id.
      const moves = opts.history(item.id).filter((event) => event.field === 'move'
        && typeof event.from === 'string' && typeof event.to === 'string' && Date.parse(event.at) <= Date.parse(item.asOf!));
      const latest = moves.at(-1);
      if (latest?.to === item.version) {
        const processed = [...ledger].reverse().find((entry) => entry.seat === item.seat
          && entry.status === 'shadow' && !entry.inquiry && entry.action !== 'wait'
          && entry.item?.source === 'checklist' && entry.item.id === item.id);
        if (processed && processed.item && processed.item.version === latest.from && processed.item.title === item.title
          && processed.item.evidenceHash === item.evidenceHash
          && Date.parse(processed.at || processed.ts || '') >= Date.parse(item.asOf) - CHECKLIST_HANDLED_WINDOW_MS
          && Date.parse(processed.at || processed.ts || '') <= Date.parse(item.asOf)
          && Date.parse(processed.at || processed.ts || '') <= Date.parse(latest.at)) {
          debug.log('seat.loop', 'skip-carried', { id: item.id, from: latest.from, version: item.version });
          return false;
        }
      }
    }
    return eligibleItem(item, ledger, handled, opts.shadow === true);
  }) ?? null;
}

const SEAT_ACTION_RULES: ReadonlyArray<{ kind: 'wait' | 'harness' | 'decision'; signal: RegExp; source: 'content' | 'task'; resolvedBy?: RegExp }> = [
  { kind: 'wait', signal: /실측\s*대기|(?:사람|실제)\s*기기(?!\s*(?:(?:실측|측정|확인)\s*)?완료)(?:\s*(?:실측|측정|확인|대기))?|실물\s*측정(?!\s*완료)/iu, source: 'content', resolvedBy: /(?:실측|측정|(?:사람|실제)\s*기기|실물\s*측정)\s*완료/iu },
  { kind: 'wait', signal: /\u{1F451}\s*확인\s*대기/iu, source: 'content', resolvedBy: /\u{1F451}\s*확인\s*완료/iu },
  { kind: 'decision', signal: TRACK_AGENT_FORBIDDEN_ACTION_REGEX, source: 'task' },
  { kind: 'decision', signal: /(?:마켓|레지스트리)(?:에|로)?\s*(?:게시|등록|발행)|사이트\s*운영\s*반영|SNS(?:에|로)?\s*(?:게시|발행|업로드)|공개\s*발행/iu, source: 'content' },
  { kind: 'harness', signal: /(?:마켓|레지스트리|사이트|SNS|공개)?(?:에|로)?\s*(?:게시|발행|배포|등록|운영\s*반영)(?:를?\s*위한)?\s*(?:준비|초안|원고|자료|구현|점검|테스트)|(?:마켓|레지스트리|사이트|SNS|공개)?(?:에|로)?\s*(?:게시|발행|배포|등록)(?:용|를?\s*위한)\s*(?:초안|원고|자료|코드|기능)/iu, source: 'task' },
];

export function planAction(item: SeatItem, seat?: string): { kind: 'decision' | 'harness' | 'wait'; text: string; reason?: string } {
  const task = `${item.id}\n${item.title}\n${item.text}`;
  const content = `${task}\n${item.evidence ?? ''}`;
  const preparation = SEAT_ACTION_RULES.find(({ kind }) => kind === 'harness')!;
  const prepared = [...content.matchAll(new RegExp(preparation.signal.source, `${preparation.signal.flags.replace('g', '')}g`))];
  const rule = SEAT_ACTION_RULES.map(({ kind, signal, source, resolvedBy }) => {
    const text = source === 'content' ? content : task;
    if (resolvedBy?.test(item.evidence ?? '')) return null;
    const hits = [...text.matchAll(new RegExp(signal.source, `${signal.flags.replace('g', '')}g`))];
    const hit = kind === 'decision' ? hits.find((match) => !prepared.some((prep) =>
      match.index! >= prep.index! && match.index! + match[0].length <= prep.index! + prep[0].length)) : hits[0];
    return hit ? { kind, reason: hit[0] } : null;
  }).find((hit) => hit !== null);
  const kind = rule?.kind ?? 'harness';
  const reason = rule?.reason;
  observe('plan', { kind, reason: reason ?? '' });
  return { kind, text: seat && kind === 'harness' ? seatTaskText(seat, item) : `${item.id} ${item.title}`, ...(reason ? { reason } : {}) };
}

// The launched sentence names the seat, the source and the release so same-named items stay distinct.
export function seatTaskText(seat: string, item: SeatItem): string {
  const where = item.source === 'checklist' ? `${item.version ?? '?'} 체크리스트 칸 ${item.id}` : item.source === 'hook' ? `웹훅 작업 카드 ${item.id}` : `자리 요청 ${item.id}`;
  return `[${seat} 자리 · ${where} · 역할 docs/roles/${seat}.md] ${item.title.replace(/[\r\n]+/g, ' ')}`;
}

function xcheckEvent(event: string, seat: string, neighbor: string, item: string, outcome: string): void {
  try { debug.log('decisions.xcheck', event, { seat, neighbor, item, outcome }); }
  catch { /* Observation does not alter delivery. */ }
}

function neighborLastSeen(root: string, isolated: boolean, now: Date, wanted: ReadonlySet<string>): Map<string, string> {
  const path = isolated ? join(root, 'surface_events.db') : surfaceEventsDbPath();
  const last = new Map<string, string>();
  if (!existsSync(path)) return last;
  const db = new Database(path, { readonly: true });
  try {
    // Same outbound seat events and refs.seat as context day; unlike its 24h display window,
    // look back across the whole journal so a genuinely old ACK can be judged absent.
    // Newest first and stop once every wanted seat has an ACK, so a long journal is not read and sorted in full each turn.
    const statement = db.prepare(`SELECT ts, refs FROM events
      WHERE surface IN ('coord:channel', 'context:session') AND direction='outbound' AND ts<=? ORDER BY ts DESC`);
    try {
      const events = statement.iterate(now.toISOString()) as Iterable<{ ts: string; refs: string | null }>;
      for (const event of events) {
        let seat: unknown;
        try { seat = (JSON.parse(event.refs ?? '{}') as { seat?: unknown }).seat; } catch { continue; }
        if (typeof seat === 'string' && wanted.has(seat) && !last.has(seat)
          && Number.isFinite(Date.parse(event.ts)) && Date.parse(event.ts) <= now.getTime()) last.set(seat, event.ts);
        if (last.size >= wanted.size) break;
      }
    } finally { statement.finalize(); }
    return last;
  } finally { db.close(); }
}

function neighborSeat(id: string): string | null {
  const match = /^(op|tc|mk|ux)-seat$/i.exec(id);
  return match ? match[1]!.toUpperCase() : null;
}

function judgeSeatNeighbors(seat: string, config: SeatLoopConfig, deps: SeatDeps, root: string, now: Date): void {
  const neighbors = config.neighbors?.[seat as keyof NonNullable<SeatLoopConfig['neighbors']>] ?? [];
  if (!neighbors.length) return;
  let seen = new Map<string, string>();
  let unreadable = false;
  const wanted = new Set(neighbors.flatMap((neighbor) => { const source = neighborSeat(neighbor.id); return source ? [source] : []; }));
  try { seen = wanted.size ? neighborLastSeen(root, !!deps.root, now, wanted) : seen; }
  catch (error) { unreadable = true; observe('neighbor-source-unreadable', { seat, error: String(error).slice(0, 200) }); }
  for (const neighbor of neighbors) {
    try {
      const source = neighborSeat(neighbor.id);
      const lastSeenAt = source ? seen.get(source) : undefined;
      const judgment = judgeNeighbor({ neighbor, lastSeenAt: unreadable ? null : lastSeenAt, now });
      // action = what this turn actually did; plannedAction = what onAbsent asks for (shadow only records it).
      let action: string | null = null;
      const plannedAction = judgment.state === 'absent' ? judgment.action?.action ?? null : null;
      if (judgment.state === 'absent') {
        if (config.mode === 'live-safe' && judgment.action?.action === 'escalate' && isRescueAllowedAction('decision-card')) {
          const ref = `seat-loop:neighbor:${seat}:${neighbor.id}:${lastSeenAt}`;
          new DecisionLedger({ stateDir: root, now: () => now }).raiseOnce({ title: `${seat}: 이웃 ${neighbor.id} 결측`, category: 'other',
            scqa: { s: `${seat} 이웃 ${neighbor.id}의 마지막 맥락 버스 사건: ${lastSeenAt}.`,
              c: `설정한 heartbeat ${neighbor.heartbeat.everyMinutes}분 × ${neighbor.heartbeat.missedTicks}회 동안 새 사건이 없다.`,
              q: '결측 이웃의 업무를 어떻게 처리할까?' },
            options: [{ key: 'a', label: '사람 판단 후 별도 조치', consequence: '자리 루프는 대행하지 않는다' },
              { key: 'b', label: '현상 유지', consequence: '결측 상태를 계속 관측한다' }],
            recommendation: { skipped: true, reason: '결측만으로 대행이나 보류를 자동 결정하지 않는다' },
            raisedBy: { agent: 'seat-loop' }, refs: [ref], raisedAt: now.toISOString(),
            crossCheckSkipped: '이웃 결측으로 교차 확인 불가' }, ref);
          action = 'decision-card';
        }
      }
      try { debug.log('loop.neighbors', 'tick', { seat, neighbor: neighbor.id, state: judgment.state, action, plannedAction, mode: config.mode }); }
      catch { /* Observation cannot change the judgment. */ }
    } catch (error) {
      observe('neighbor-judgment-failed', { seat, neighbor: neighbor.id, error: String(error).slice(0, 200) });
      try { debug.log('loop.neighbors', 'tick', { seat, neighbor: neighbor.id, state: 'unknown', action: null, mode: config.mode }); }
      catch { /* Observation cannot change the turn. */ }
    }
  }
}

export async function runSeatLoopOnce(seat: string, deps: SeatDeps = {}): Promise<SeatLoopResult> {
  if (!/^(?:MK|OP|TC|UX)$/.test(seat)) throw new Error(`unknown seat: ${seat}`);
  const config = deps.config ?? getUserConfig().loops?.seat ?? { mode: 'shadow' };
  if (config.mode === 'off' || !(config.seats ?? ['MK']).includes(seat)) {
    observe('skipped-off', { seat });
    return { seat, status: 'skipped-off' };
  }
  const now = (deps.now ?? (() => new Date()))();
  const path = seatLedgerPath(seat, deps.root ?? effectiveInstanceRoot(), now);
  const directory = dirname(path);
  return withSeatLock(directory, async () => {
  const stateRoot = deps.root ?? effectiveInstanceRoot();
  const recorded = readSeatLedger(seat, deps, now);
  const ledger = config.mode === 'live-safe' ? reconciledQueueLedger(recorded, stateRoot, deps) : recorded;
  let turnError: unknown;
  try {
  if (config.mode === 'on' && config.questions === 'on') {
    const proposals = ledger.filter((row) => row.status === 'awaiting-resolution' && row.xcheckQuestionId !== undefined
      && ((row.item?.source === 'checklist' && row.item.version) || row.item?.source === 'seat-question'));
    for (const proposal of proposals) {
      if (ledger.some((row) => row.status === 'resolved-by-neighbor' && row.xcheckQuestionId === proposal.xcheckQuestionId)) continue;
      // Review round 3 ②: a seat question has no checklist cell — it is settled when this seat answers it later
      // (new evidence) and otherwise follows the same deadline escalation below.
      const isQuestion = proposal.item!.source === 'seat-question';
      if (isQuestion && ledger.some((row) => row.item && itemKey(row.item) === itemKey(proposal.item!)
        && (row.status === 'answered' || row.status === 'hitl') && Date.parse(row.at) > Date.parse(proposal.at))) continue;
      let cell: { status: string } | undefined;
      if (!isQuestion) try {
        cell = (deps.checklistItems ?? ((version: string) => listChecklist(version, stateRoot).items))(proposal.item!.version!)
          .find((candidate) => candidate.id === proposal.item!.id && candidate.owner === seat);
      } catch (error) {
        observe('xcheck-resolution-verification-failed', { seat, neighbor: proposal.xcheckNeighbor, item: itemKey(proposal.item!), error: String(error).slice(0, 200) });
      }
      if (cell?.status === 'green' || cell?.status === 'done') {
        const entry: SeatEntry = { ...proposal, ts: now.toISOString(), at: now.toISOString(), status: 'resolved-by-neighbor' };
        (deps.append ?? defaultAppend)(path, entry);
        xcheckEvent('resolved-by-neighbor', seat, proposal.xcheckNeighbor ?? '', itemKey(proposal.item!), cell.status);
        return entry;
      }
      // Review round 3 ①: a neighbor's «I can resolve it» has a deadline — if the cell is still open after the
      // cross-check wait, escalate to a CEO card instead of excluding the item forever.
      const waited = proposal.xcheckWaitMinutes ?? 120;
      const proposedAt = Date.parse(proposal.at);
      if ((cell || isQuestion) && Number.isFinite(proposedAt) && now.getTime() - proposedAt >= waited * 60_000) {
        const neighbor = proposal.xcheckNeighbor ?? '';
        const question = proposal.inquiry?.question ?? proposal.item!.title;
        const note = `${proposal.xcheckNote ?? ''} — 해결 가능하다고 했으나 ${waited}분 안 해소 안 됨`.trim();
        if (!decisionReceipt(stateRoot, seat, proposal.item!)) {
          await (deps.run ?? defaultRun)(['decisions', 'raise', '--title', `${seat}: ${question}`, '--category', 'other',
            '--s', `${seat} 질문 · ${proposal.item!.title}`, '--c', '이웃 자리 해결 제안이 기한 안에 해소되지 않았다',
            '--option', 'a=승인:사람 판단으로 진행', '--option', 'b=보류:진행하지 않음',
            '--skip-recommend', '근거가 부족하다', '--xcheck', `${neighbor}:${note}`,
            '--agent', 'seat-loop', '--ref', decisionRef(seat, proposal.item!), '--json']);
        }
        const entry: SeatEntry = { ...proposal, ts: now.toISOString(), at: now.toISOString(), status: 'hitl' };
        (deps.append ?? defaultAppend)(path, entry);
        xcheckEvent('raised', seat, neighbor, itemKey(proposal.item!), 'resolution-timed-out');
        return entry;
      }
    }
    const received = seatCrossChecks(stateRoot, seat as SeatId).filter((question) => !crossCheckAnswer(stateRoot, question));
    const receivedInputs = received.length ? await gatherSeatInputs(seat, deps, ledger) : null;
    const judgmentEvidence = receivedInputs?.checklist.filter((item) => item.evidence?.trim())
      .map((item) => `${item.id} · ${item.title}: ${item.evidence!.trim()}`).join('\n').slice(0, 8_000) ?? '';
    const pending = received.find((question) => {
      const senderRows = readSeatLedger(question.from, { root: stateRoot }, now).filter((row) => row.xcheckQuestionId === question.id);
      const latest = senderRows.at(-1);
      if (latest?.status === 'hitl' || latest?.status === 'resolved-by-neighbor' || latest?.status === 'awaiting-resolution') return false;
      const request = senderRows.find((row) => row.status === 'awaiting-xcheck' && row.xcheckRequestedAt);
      const waitMinutes = request?.xcheckWaitMinutes ?? 120;
      if (request?.xcheckRequestedAt && now.getTime() - Date.parse(request.xcheckRequestedAt) >= waitMinutes * 60_000) return false;
      return !ledger.some((row) => row.xcheckQuestionId === question.id && row.status === 'awaiting-xcheck'
        && row.xcheckJudgmentEvidence === judgmentEvidence);
    });
    if (pending) {
      const append = deps.append ?? defaultAppend;
      const entry: SeatEntry = { seat, ts: now.toISOString(), at: now.toISOString(), status: 'awaiting-xcheck',
        action: 'seat-answer', xcheckQuestionId: pending.id, xcheckNeighbor: pending.from as SeatId,
        xcheckJudgmentEvidence: judgmentEvidence };
      try {
        const judge = deps.crossCheck ?? (async (receiver: SeatId, draft: string, from: SeatId): Promise<CrossCheckJudgment | null> => {
          const inputs = receivedInputs!;
          const evidence = judgmentEvidence;
          if (!evidence) throw new Error('cross-check judgment requires receiving-seat evidence');
          const output = JSON.parse((await (deps.run ?? defaultRun)(['agent', '--json', '--no-tools',
            `[${receiver} 자리 · 역할 docs/roles/${receiver}.md] ${from} 자리의 결정 초안을 교차 확인한다. 아래 실제 근거만 사용하고 모르는 사실은 지어내지 마라. JSON 하나만 반환: {"agree":boolean,"note":"근거를 포함한 메모","resolves":boolean}. 이웃 자리에서 직접 해결할 수 있을 때만 resolves=true. 초안: ${draft}\n역할: ${inputs.role}\n${receiver} 체크리스트 근거:\n${evidence || '(없음)'}`])).trim()) as { reply?: unknown };
          const value: unknown = typeof output.reply === 'string' ? JSON.parse(output.reply) : output;
          return value as CrossCheckJudgment;
        });
        const answer = await judge(seat as SeatId, pending.body, pending.from as SeatId);
        if (!answer || typeof answer.agree !== 'boolean' || typeof answer.resolves !== 'boolean'
          || typeof answer.note !== 'string' || !answer.note.trim()) throw new Error('invalid cross-check judgment');
        answerCrossCheck(stateRoot, pending, answer);
        entry.status = 'answered';
        entry.xcheckNote = answer.note.trim();
        append(path, entry);
        xcheckEvent('answered', seat, pending.from, String(pending.id), answer.resolves ? 'resolves' : answer.agree ? 'agree' : 'dissent');
      } catch (error) {
        append(path, entry);
        xcheckEvent('answered', seat, pending.from, String(pending.id), `judgment-failed: ${String(error).slice(0, 200)}`);
      }
      return entry;
    }
  }
  if (seat === 'TC') {
    const candidates = await tcCandidates(deps, now);
    for (const candidate of candidates) {
      if (candidate.kind === 'other-seat-cell-defect') {
        const question = `${candidate.version} 체크리스트 ${candidate.id} · ${candidate.title}: ${candidate.to} 칸 결함을 확인해 주세요.`;
        const recorded = recordSeatAskShadow(stateRoot, { from: 'TC', to: candidate.to, itemId: candidate.id, version: candidate.version, question }, now.getTime());
        const inLedger = ledger.some((row) => row.status === 'shadow' && row.candidate?.kind === 'other-seat-cell-defect'
          && row.candidate.version === candidate.version && row.candidate.id === candidate.id && row.candidate.to === candidate.to);
        if (!inLedger) {
          const entry: SeatEntry = { seat, ts: now.toISOString(), at: now.toISOString(), status: 'shadow', candidate,
            item: { source: 'checklist', kind: 'cell', id: candidate.id, title: candidate.title, text: candidate.title, version: candidate.version, seat: candidate.to },
            action: 'seat-question', inquiry: { to: candidate.to, question } };
          (deps.append ?? defaultAppend)(path, entry);
        }
        if (!inLedger || recorded) observe('ask-shadow', { from: seat, to: candidate.to, itemId: candidate.id });
        continue;
      }
      if (ledger.some((row) => row.status === 'shadow' && JSON.stringify(row.candidate) === JSON.stringify(candidate))) continue;
      const entry: SeatEntry = { seat, ts: now.toISOString(), at: now.toISOString(), status: 'shadow', candidate };
      (deps.append ?? defaultAppend)(path, entry);
      observe('tc-shadow-candidate', { seat, candidate });
    }
  }
  if (seat === 'OP' && !seatQuestions(stateRoot, 'OP').some((question) =>
    !hasSeatAnswer(stateRoot, question)
    && !handledKeys(ledger, config.mode !== 'on' || (config.questions ?? 'shadow') !== 'on', stateRoot).has(`seat-question::${question.id}`))) {
    const append = deps.append ?? defaultAppend;
    const candidates = opCandidates(deps, now);
    const assigned = candidates.filter((candidate): candidate is Extract<OpCandidate, { kind: 'unassigned-cell' }> => candidate.kind === 'unassigned-cell' && candidate.verdict === 'assign');
    if (assigned.length) {
      const previous = new Map<string, Extract<OpCandidate, { kind: 'unassigned-cell' }>>();
      for (const row of ledger) {
        const candidate = row.candidate;
        if (candidate?.kind !== 'unassigned-cell') continue;
        if (candidate.verdict === 'none' && !candidate.id) previous.clear();
        else if (candidate.id) previous.set(JSON.stringify([candidate.version, candidate.id]), candidate);
      }
      const active = new Set(assigned.map((candidate) => JSON.stringify([candidate.version, candidate.id])));
      for (const [key, candidate] of previous) {
        if (candidate.verdict === 'assign' && !active.has(key)) candidates.push({ kind: 'unassigned-cell', version: candidate.version, id: candidate.id, verdict: 'none' });
      }
    }
    const previousDecisions = new Set<string>();
    for (const row of ledger) {
      const candidate = row.candidate;
      if (candidate?.kind !== 'decision-delegation') continue;
      if (candidate.verdict === 'none' && !candidate.id) previousDecisions.clear();
      else if (candidate.id) {
        if (candidate.verdict === 'none') previousDecisions.delete(candidate.id);
        else previousDecisions.add(candidate.id);
      }
    }
    const currentDecision = candidates.find((candidate): candidate is Extract<OpCandidate, { kind: 'decision-delegation' }> =>
      candidate.kind === 'decision-delegation' && candidate.verdict === 'review-delegation');
    if (currentDecision) {
      for (const id of previousDecisions) {
        if (id !== currentDecision.id) candidates.push({ kind: 'decision-delegation', id, verdict: 'none' });
      }
    }
    const entries = candidates.map((candidate): SeatEntry => ({ seat, ts: now.toISOString(), at: now.toISOString(), status: 'shadow', candidate }));
    for (const entry of entries) {
      const candidate = entry.candidate!;
      const previous = [...ledger].reverse().find((row) => row.candidate?.kind === candidate.kind &&
        (candidate.kind === 'release-readiness' || row.candidate?.kind === candidate.kind && (
          candidate.kind === 'unassigned-cell' && row.candidate.kind === 'unassigned-cell'
            ? (candidate.verdict === 'none' && !candidate.id && row.candidate.verdict === 'none' && !row.candidate.id)
              || row.candidate.version === candidate.version && row.candidate.id === candidate.id
            : candidate.kind === 'decision-delegation' && row.candidate.kind === 'decision-delegation'
              && row.candidate.id === candidate.id)));
      if (previous && JSON.stringify(previous.candidate) === JSON.stringify(candidate)) continue;
      append(path, entry);
      observe('op-judgment-shadow', { seat, candidate: entry.candidate, status: entry.status });
    }
    return entries[0]!;
  }
  const inputs = await gatherSeatInputs(seat, deps, ledger);
  const questionsMode = config.mode === 'on' ? config.questions ?? 'shadow' : 'shadow';
  const questionHandled = handledKeys(ledger, questionsMode !== 'on', stateRoot);
  const pendingQuestion = inputs.requests.find((candidate) => candidate.source === 'seat-question'
    && eligibleItem(candidate, ledger, questionHandled, questionsMode !== 'on')
    && !ledger.some((row) => row.status === 'awaiting-resolution' && row.item
      && itemKey(row.item) === itemKey(candidate) && itemSnapshot(row.item) === itemSnapshot(candidate)));
  const ordinary = pickNext({ ...inputs, requests: inputs.requests.filter((candidate) => candidate.source !== 'seat-question'),
    checklist: inputs.checklist.filter((candidate) => !ledger.some((row) => row.status === 'awaiting-resolution'
      && row.item && itemKey(row.item) === itemKey(candidate) && itemSnapshot(row.item) === itemSnapshot(candidate))) }, ledger,
    { shadow: config.mode === 'shadow', liveSafe: config.mode === 'live-safe', root: stateRoot, history: deps.checklistHistory ?? checklistHistory });
  const item = pendingQuestion ?? ordinary;
  const append = deps.append ?? defaultAppend;
  const revisedProposal = item?.source === 'checklist' && ledger.some((row) => row.status === 'awaiting-resolution'
    && row.item && itemKey(row.item) === itemKey(item) && itemSnapshot(row.item) !== itemSnapshot(item));
  if (config.mode === 'live-safe' && !pendingQuestion) {
    const pendingRows = (deps.queueItems ?? ((root: string) => listHarnessQueue({ root })))(stateRoot);
    for (const candidate of [...inputs.requests, ...inputs.checklist].filter((row) => row.source !== 'seat-question')) {
      const pending = pendingRows.find((row) => row.seat === seat && row.kind === 'say'
        && row.idempotencyKey === queueKey(seat, candidate) && row.input === seatTaskText(seat, candidate)
        && ['queued', 'launching', 'launched'].includes(row.status)
        && ['pending', 'unknown'].includes((deps.queueOutcome ?? ((id: string, root: string) => harnessQueueOutcome(id, { root })))(row.id, stateRoot)));
      if (!pending) continue;
      if (ledger.some((row) => row.queueId === pending.id && row.status === 'queued')) continue;
      const entry: SeatEntry = { seat, ts: now.toISOString(), at: now.toISOString(), status: 'queued', item: candidate, action: 'harness', queueId: pending.id };
      append(path, entry);
      observe('queued', { seat, item: candidate, queueId: pending.id, deduplicated: true });
      return entry;
    }
  }
  // RM3 review must-fix: `questions` now has a default, so it can't be the trigger — a shadow seat loop never calls the model on its own.
  if (item && (!revisedProposal || planAction(item, seat).kind === 'decision')
    && (item.source === 'seat-question' || (config.mode !== 'live-safe' && (deps.inquire || (config.mode === 'on' && config.questions !== undefined))))) {
    const root = deps.root ?? effectiveInstanceRoot();
      const unfinished = [...ledger].reverse().find((row) => row.item && itemKey(row.item) === itemKey(item)
        && !(item.source === 'seat-question' && ledger.some((prior) => prior.status === 'awaiting-resolution'
          && prior.item && itemKey(prior.item) === itemKey(item) && itemSnapshot(prior.item) !== itemSnapshot(item)))
        && (row.status === 'attempting' || row.status === 'outcome-unknown' || row.status === 'awaiting-xcheck')
        && (row.action === 'seat-question' || row.action === 'seat-answer' || row.inquiry?.to === 'CEO'));
    const inquiry = item.source === 'seat-question' ? null : revisedProposal && item.source === 'checklist'
      ? ledger.find((row) => row.status === 'awaiting-resolution' && row.item && itemKey(row.item) === itemKey(item))?.inquiry ?? null
      : unfinished?.inquiry ?? await (deps.inquire ?? (async (asking: SeatId, work: SeatItem) => { try {
      const output = JSON.parse((await (deps.run ?? defaultRun)(['agent', '--json', '--no-tools',
        `[${asking} 자리 · 역할 docs/roles/${asking}.md] 이 항목을 판단할 근거가 부족한 경우에만 다른 자리 또는 사람에게 질문한다. 근거가 충분하면 null. JSON 객체 하나만 반환: null 또는 {"to":"OP|TC|MK|UX|CEO","question":"필요한 근거를 묻는 질문"}. 항목: ${work.id} ${work.title}\n내용: ${work.text}\n역할: ${(deps.read ?? defaultRead)(join(deps.repo ?? repoRoot, 'docs', 'roles', `${asking}.md`)).slice(0, 4_000)}`])).trim()) as { reply?: unknown };
      const value: unknown = typeof output?.reply === 'string' ? JSON.parse(output.reply) : output;
      if (value === null) return null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid seat inquiry');
      const record = value as Record<string, unknown>;
      if ((record.to === 'CEO' || (typeof record.to === 'string' && isSeatId(record.to) && record.to !== asking))
        && typeof record.question === 'string' && record.question.trim()) return { to: record.to as SeatId | 'CEO', question: record.question };
      throw new Error('invalid seat inquiry');
      } catch (error) {
        // A failed judgment call must not break the record-only path — no question this turn.
        observe('inquire-failed', { seat: asking, item: work.id, error: String(error).slice(0, 200) });
        return null;
      }
    }))(seat as SeatId, item);
    const reply = item.source === 'seat-question' && item.from && (questionsMode === 'on' || deps.reply || config.questions !== undefined)
      ? unfinished?.answer ? { answer: unfinished.answer } : unfinished?.inquiry ? unfinished.inquiry : await (deps.reply ?? (async (receiver: SeatId, question: string, from: SeatId) => {
      const evidence = inputs.checklist.map((candidate) =>
        `${candidate.id} · ${candidate.title} (판 ${candidate.version}, ${candidate.kind})${candidate.evidence?.trim() ? ` · 근거: ${candidate.evidence.trim()}` : ''}`).join('\n').slice(0, 8_000);
      const output = JSON.parse((await (deps.run ?? defaultRun)(['agent', '--json', '--no-tools',
        `[${receiver} 자리 · 역할 docs/roles/${receiver}.md] ${from} 자리의 질문에 근거를 갖고 답하라. 아래 ${receiver} 자리의 실제 체크리스트 근거에 없는 사실은 지어내지 마라. 모르면 사람 결정이 필요한 질문을 작성하라. JSON 하나만 반환: {"answer":"근거를 포함한 답"} 또는 {"to":"CEO","question":"결정할 질문"}. 질문: ${question}\n역할: ${inputs.role}\n${receiver} 체크리스트 근거:\n${evidence || '(없음)'}`])).trim()) as { reply?: unknown };
      const value: unknown = typeof output.reply === 'string' ? JSON.parse(output.reply) : output;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid seat reply');
      const record = value as Record<string, unknown>;
      if (typeof record.answer === 'string' && record.answer.trim()) return { answer: record.answer };
      if (record.to === 'CEO' && typeof record.question === 'string' && record.question.trim()) return { to: 'CEO' as const, question: record.question };
      throw new Error('invalid seat reply');
    }))(seat as SeatId, item.text, item.from) : null;
    if (item.source === 'seat-question' && reply && 'to' in reply && reply.to !== 'CEO') {
      throw new Error('seat reply may only answer or escalate to CEO');
    }
    if (item.source === 'seat-question' || inquiry) {
      const entry: SeatEntry = { seat, ts: now.toISOString(), at: now.toISOString(), item, status: 'shadow',
        action: item.source === 'seat-question' ? 'seat-answer' : inquiry?.to === 'CEO' ? 'decision' : 'seat-question',
        ...(inquiry ? { inquiry } : {}), ...(reply && 'answer' in reply ? { answer: reply.answer } : {}) };
      if (item.source === 'seat-question' && reply && 'to' in reply) {
        entry.inquiry = reply;
        entry.action = 'decision';
      }
      if (questionsMode !== 'on') {
        if (config.mode === 'live-safe' && !isRescueAllowedAction('seat-question')) {
          observe('refused', { seat, item: item.id, action: 'seat-question', reason: 'question delivery is shadow-only' });
        }
        append(path, entry);
        observe('question-shadow', { seat, item, inquiry: entry.inquiry, answered: !!entry.answer });
        return entry;
      }
      if (item.source === 'seat-question' && !reply) {
        entry.status = 'awaiting-answer';
        append(path, entry);
        return entry;
      }
      if (entry.inquiry?.to === 'CEO' && !item.evidence?.trim() && !decisionReceipt(root, seat, item)
        && !ledger.some((row) => row.item && itemKey(row.item) === itemKey(item) && row.status === 'awaiting-xcheck')
        && !deliveredSeatQuestion(root, `xcheck:${seat}:${itemKey(item)}`)) {
        entry.status = 'rejected-no-evidence';
        append(path, entry);
        xcheckEvent('rejected-no-evidence', seat, (deps.decisionsConfig ?? getUserConfig().decisions)?.crossCheckNeighbor?.[seat as SeatId] ?? 'OP', itemKey(item), 'no-evidence');
        return entry;
      }
      if (!revisedProposal && (entry.inquiry?.to !== 'CEO' || (unfinished?.status !== 'awaiting-xcheck' && !ledger.some((row) =>
        row.item && itemKey(row.item) === itemKey(item) && row.status === 'awaiting-xcheck')))) {
        append(path, { ...entry, status: 'attempting' });
      }
      try {
        if (item.source === 'seat-question' && reply && 'answer' in reply) {
          const question = { id: Number(item.id), from: item.from!, to: seat, body: item.text, kind: 'seat-question', createdAt: item.createdAt ?? '' };
          if (!hasSeatAnswer(root, question)) answerSeat(root, question, reply.answer);
          entry.status = 'answered';
        } else {
          const ask = entry.inquiry!;
          if (!ask.question.trim()) throw new Error('empty seat question');
          if (ask.to === 'CEO') {
            const settings = deps.decisionsConfig ?? getUserConfig().decisions!;
            const neighbor = settings.crossCheckNeighbor?.[seat as SeatId] ?? ({ OP: 'TC', TC: 'OP', MK: 'OP', UX: 'OP' } as const)[seat as SeatId];
            const waitMinutes = settings.crossCheckWaitMinutes ?? 120;
            const previous = [...ledger].reverse().find((row) => row.item && itemKey(row.item) === itemKey(item)
              && row.status === 'awaiting-xcheck' && row.xcheckQuestionId !== undefined);
            const prior = decisionReceipt(root, seat, item);
            if (prior) {
              entry.status = 'hitl';
            } else {
              const key = `xcheck:${seat}:${itemKey(item)}`;
              const delivered = deliveredSeatQuestion(root, key);
              if (delivered && (delivered.kind !== 'seat-xcheck' || delivered.from !== seat || !isSeatId(delivered.to))) {
                throw new Error('cross-check retry has an invalid recorded recipient');
              }
              const requestedNeighbor = delivered ? delivered.to as SeatId : neighbor;
              if (!delivered && !item.evidence?.trim()) {
                entry.status = 'rejected-no-evidence';
                xcheckEvent('rejected-no-evidence', seat, neighbor, itemKey(item), 'no-evidence');
              } else {
                const question = delivered ?? askCrossCheck(root, seat as SeatId, neighbor,
                  `제목: ${seat}: ${ask.question}\nS: ${seat} 질문 · ${item.title}\nC: 판단 근거 부족 — 사람의 결정이 필요하다\n질문: ${ask.question}\n근거: ${item.evidence!.trim()}`, key);
                const requestedAt = previous?.xcheckRequestedAt ?? (delivered ? delivered.createdAt : now.toISOString());
                entry.xcheckQuestionId = question.id;
                entry.xcheckRequestedAt = requestedAt;
                entry.xcheckNeighbor = requestedNeighbor;
                entry.xcheckWaitMinutes = previous?.xcheckWaitMinutes ?? waitMinutes;
                if (!delivered) xcheckEvent('requested', seat, requestedNeighbor, itemKey(item), 'awaiting-xcheck');
                const answer = delivered ? crossCheckAnswer(root, question) : null;
                if (!delivered || (!answer && now.getTime() - Date.parse(requestedAt) < entry.xcheckWaitMinutes * 60_000)) {
                  entry.status = 'awaiting-xcheck';
                } else if (answer?.resolves) {
                  entry.status = 'awaiting-resolution';
                  entry.xcheckNote = answer.note;
                  if (!revisedProposal) xcheckEvent('answered', seat, requestedNeighbor, itemKey(item), 'resolution-proposed');
                } else {
                  if (!answer) xcheckEvent('timed-out', seat, requestedNeighbor, itemKey(item), `unanswered ${entry.xcheckWaitMinutes}m`);
                  const check = answer ? ['--xcheck', `${requestedNeighbor}:${answer.note}`,
                    ...(answer.agree ? [] : ['--dissent', `${requestedNeighbor}: ${answer.note}`])]
                    : ['--no-xcheck', `이웃 ${requestedNeighbor} 무응답 ${entry.xcheckWaitMinutes}분`];
                  await (deps.run ?? defaultRun)(['decisions', 'raise', '--title', `${seat}: ${ask.question}`, '--category', 'other',
                    '--s', `${seat} 질문 · ${item.title}`, '--c', '판단 근거 부족 — 사람의 결정이 필요하다',
                    '--option', 'a=승인:사람 판단으로 진행', '--option', 'b=보류:진행하지 않음',
                    '--skip-recommend', '근거가 부족하다', ...check, '--agent', 'seat-loop', '--ref', decisionRef(seat, item), '--json']);
                  if (!decisionReceipt(root, seat, item)) throw new Error('decisions raise did not deliver a matching card');
                  entry.status = 'hitl';
                  xcheckEvent('raised', seat, requestedNeighbor, itemKey(item), answer ? answer.agree ? 'agree' : 'dissent' : 'timed-out');
                }
              }
            }
          } else {
            if (!isSeatId(ask.to) || ask.to === seat) throw new Error('invalid recipient seat');
            const key = `ask:${seat}:${itemKey(item)}`;
            const delivered = deliveredSeatQuestion(root, key);
            if (delivered && (delivered.from !== seat || delivered.to !== ask.to || delivered.body !== ask.question.trim())) {
              throw new Error('seat delivery retry changed its recorded question');
            }
            askSeat(root, seat as SeatId, ask.to, ask.question, key);
            entry.status = 'asked';
          }
        }
        append(path, entry);
        observe('question-outcome', { seat, item, status: entry.status });
        return entry;
      } catch (error) {
        append(path, { ...entry, status: 'outcome-unknown' });
        throw error;
      }
    }
  }
  if (item) observe('picked', { seat, item, date: seatDay(now) });
  const planned = item ? planAction(item, seat) : undefined;
  if (item && config.mode === 'live-safe' && deps.inquire && !isRescueAllowedAction('seat-question')) {
    observe('refused', { seat, item: item.id, action: 'seat-question', reason: 'outbound inquiry not in rescue policy' });
  }
  const entry: SeatEntry = { seat, ts: now.toISOString(), at: now.toISOString(), status: item ? 'shadow' : 'skipped-empty',
    ...(item ? { item, action: planned!.kind, ...(planned!.reason ? { reason: planned!.reason } : {}) } : { action: 'skipped-empty' as const }) };
  if (config.mode === 'shadow' || !item) {
    append(path, entry);
    if (config.mode === 'shadow') observe('shadow', { seat, item, status: entry.status });
    return entry;
  }
  if (planned!.kind === 'wait') {
    entry.status = 'wait';
    append(path, entry);
    return entry;
  }
  if (config.mode === 'live-safe') {
    const requested = planned!.kind === 'harness' ? 'launch' : 'decision-card';
    if (planned!.kind === 'decision' && !isRescueAllowedAction(planned!.kind)) {
      observe('refused', { seat, item: item.id, action: planned!.reason ?? 'decision', reason: 'execution forbidden; decision card only' });
    }
    if (!isRescueAllowedAction(requested)) {
      entry.status = 'refused';
      entry.reason = `action not permitted: ${requested}`;
      append(path, entry);
      observe('refused', { seat, item: item.id, action: requested, reason: entry.reason });
      return entry;
    }
  }
  const run = deps.run ?? defaultRun;
  let outcome: string | undefined;
  try { outcome = (JSON.parse(await run(['harness', 'budget', '--json'])) as { outcome?: string }).outcome; }
  catch { /* failed budget observation is never permission to launch */ }
  if (outcome !== 'proceed' && outcome !== 'next-provider') {
    entry.status = 'skipped-budget';
    entry.action = 'skipped-budget';
    delete entry.reason;
    append(path, entry);
    observe('skipped-budget', { seat, item, outcome: outcome ?? 'unavailable' });
    return entry;
  }
  const action = planned!;
  if (action.kind === 'harness') {
    const launchedRunIds = new Set(ledger.flatMap((row) => row.seat === seat && row.status === 'launched' && row.runId ? [row.runId] : []));
    let running: readonly RunningSeatPod[] = [];
    let observationUnavailable = false;
    try {
      if (deps.running) running = deps.running();
      else if (launchedRunIds.size > 0) {
        const observed = queryRunningRuns({ runIds: [...launchedRunIds], caller: 'seat-loop' });
        if (observed.completeness !== 'complete' || observed.pty.unreadable.length > 0) observationUnavailable = true;
        running = observed.entries
          .filter((row) => launchedRunIds.has(row.runId) && (row.status === 'running' || row.status === 'probable-running' || row.status === 'unknown'))
          // Seat launches always use `--substrate pod` (see the harness say call), so the substrate is known from the launch;
          // only liveness can be uncertain — probable-running/unknown stay «unknown», never counted as confirmed Pods.
          .map((row) => ({ seat, substrate: 'pod', status: row.status === 'running' ? 'running' : 'unknown' }));
      }
    } catch { observationUnavailable = true; }
    const budget = observationUnavailable
      ? { allowed: false as const, reason: `${seat} concurrent Pods budget cannot be verified (running observation unavailable)` }
      : checkSeatBudget({ seat, now, ledger, running, ...(deps.budgetConfig ? { config: deps.budgetConfig } : {}) });
    if (!budget.allowed) {
      entry.status = 'skipped-budget';
      entry.action = 'skipped-budget';
      entry.reason = budget.reason;
      observe('skipped-budget', { seat, item, reason: budget.reason });
      const parent = (config.stall?.parents ?? {})[seat] ?? DEFAULT_STALL_PARENTS[seat];
      // Dedupe only on a DELIVERED escalation, so a failed send is retried on the next turn (TC harvest · review round 1).
      if (parent && parent !== seat && config.mode === 'live-safe' && !isRescueAllowedAction('alert')) {
        observe('refused', { seat, item: item.id, action: 'alert', reason: 'policy denied budget alert' });
      } else if (parent && parent !== seat && !ledger.some((prior) => prior.status === 'skipped-budget' && prior.escalated === true && prior.reason === budget.reason
        && prior.item && itemKey(prior.item) === itemKey(item) && seatDay(new Date(prior.ts ?? prior.at)) === seatDay(now))) {
        const line = `[${seat} → ${parent}] ${item.id}: ${budget.reason}`;
        try {
          if (deps.escalate) await deps.escalate(parent, line);
          else {
            const store = openMsgStore(join(deps.root ?? effectiveInstanceRoot(), 'msg', 'messages.db'));
            try { store.append({ from: seat, to: parent, body: line, kind: 'seat-budget-escalation' }); }
            finally { store.close(); }
          }
          entry.escalated = true;
        } catch (error) {
          entry.escalated = false;
          observe('budget-escalation-failed', { seat, parent, item: item.id, error: String(error).slice(0, 200) });
        }
      }
      append(path, entry);
      return entry;
    }
  }
  // Persist the intent before crossing the process boundary: an unreturned call may already have acted.
  append(path, { ...entry, status: 'attempting' });
  try {
    if (action.kind === 'decision') {
      const title = `${seat}: ${action.text.replace(/[\r\n]+/g, ' ')}`;
      const raised = await run(['decisions', 'raise', '--title', title, '--category', 'other',
        '--s', `${seat} 배정 항목: ${action.text.replace(/[\r\n]+/g, ' ')}\n역할: ${inputs.role}`, '--c', '자동 실행 금지 문면에 해당하여 사람 결정이 필요하다',
        '--option', 'a=사람 승인:승인 후 별도로 집행', '--option', 'b=보류:집행하지 않음',
        '--skip-recommend', '금지 문면은 자동으로 권고하지 않는다', '--no-xcheck', '자리 루프 · 이웃 교환은 DEC-XCHECK ②', '--agent', 'seat-loop', '--json']);
      const decision: unknown = JSON.parse(raised.trim());
      if (!decision || typeof decision !== 'object' || typeof (decision as { id?: unknown }).id !== 'string') {
        throw new Error('decisions raise returned no decision id');
      }
      entry.status = 'hitl';
      append(path, entry);
      observe('hitl', { seat, item });
      return entry;
    }
    if (config.mode === 'live-safe') {
      let queued: { id: string };
      try {
        queued = await (deps.enqueue ?? ((assigned, text, root, idempotencyKey) => addHarnessQueue({ seat: assigned, say: text, idempotencyKey }, { root })))(seat, action.text, stateRoot, queueKey(seat, item));
      } catch (error) {
        // Same key, different task body: never adopt the other work. Refuse this turn; the key frees once that item finishes.
        if (!/idempotency key collision/.test(String(error))) throw error;
        entry.status = 'refused';
        entry.reason = 'AUTOQ idempotency key collision: a queued item with this key carries a different task';
        append(path, entry);
        observe('refused', { seat, item: item.id, action: 'launch', reason: entry.reason });
        return entry;
      }
      if (!queued || typeof queued.id !== 'string' || !/^hq-[0-9a-f-]{36}$/i.test(queued.id)) throw new Error('AUTOQ returned no queue id');
      entry.status = 'queued';
      entry.queueId = queued.id;
      append(path, entry);
      observe('queued', { seat, item, queueId: queued.id });
      return entry;
    }
    const output = await run(['harness', 'say', action.text, '--substrate', 'pod', '--pod-pool', config.podPool ?? 'pool-node-b@node-b:8', '--base', 'main', '--json']);
    const results: unknown = JSON.parse(output.trim());
    if (!Array.isArray(results) || results.length === 0 || results.some((result) =>
      !result || typeof result !== 'object' || (result as { status?: unknown }).status !== 'done')) {
      throw new Error('harness say did not complete successfully');
    }
    const runId = (results[0] as { runId?: unknown }).runId;
    if (typeof runId !== 'string' || !/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
      throw new Error('harness say output has no runId');
    }
    entry.status = 'launched';
    entry.runId = runId;
    append(path, entry);
    observe('launched', { seat, item, runId });
    return entry;
  } catch (error) {
    append(path, { ...entry, status: 'outcome-unknown' });
    throw error;
  }
  } catch (error) {
    turnError = error;
    throw error;
  } finally {
    // A turn ends even when there is no picked item or a launch fails.
    try { judgeSeatNeighbors(seat, config, deps, stateRoot, (deps.now ?? (() => new Date()))()); }
    catch (error) {
      observe('neighbor-judgment-failed', { seat, error: String(error).slice(0, 200) });
      const neighbors = config.neighbors?.[seat as keyof NonNullable<SeatLoopConfig['neighbors']>] ?? [];
      for (const neighbor of neighbors) {
        try { debug.log('loop.neighbors', 'tick', { seat, neighbor: neighbor.id, state: 'unknown', action: null, mode: config.mode }); }
        catch { /* Observation cannot change the turn. */ }
      }
    }
    try { escalateStalls(seat, deps, config, (deps.now ?? (() => new Date()))()); }
    catch (error) {
      debug.log('org.stall', 'escalate-error', { seat, error: String(error).slice(0, 200) }, { level: 'warn' });
      if (turnError !== undefined) throw new AggregateError([turnError, error], `seat turn failed (${String(turnError)}); stall escalation failed (${String(error)}) for ${seat}`);
      throw error;
    }
  }
  }, deps.lockContended);
}
