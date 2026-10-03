import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { TRACK_AGENT_FORBIDDEN_ACTION_REGEX, universeLaunch } from '../autopilot/track-agent.js';
import { debug } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../instance/resolve.js';
import { getUserConfig, type PersonaLoopConfig, type SeatLoopConfig, type UserConfig } from '../user-config.js';
import { checkSeatBudget, type RunningSeatPod } from '../org/seat-budget.js';
import { DEFAULT_STALL_PARENTS, findStalls } from '../org/stall-escalation.js';
import { openMsgStore, type MessageEnvelope } from '../msg/msg-store.js';
import { loadLayeredPersonaDirs, resolveRepositoryPersonaDir, resolveStatePersonaDir } from '../persona/global-registry.js';
import { nextPersonaTodo, personaTodoPath, readPersonaTodos, type PersonaTodo } from '../persona/persona-todo.js';
import { PersonaRegistry } from '../persona/registry.js';
import { answerSeat, askSeat, deliveredSeatQuestion, hasSeatAnswer, isSeatId, seatQuestions, type SeatId } from '../seat-dispatch/seat-questions.js';
import { queryRunningRuns } from '../self-implement/running-runs.js';
import { listChecklist, type Checklist } from '../release-loop/checklist.js';
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
export type SeatEntry = { seat: string; ts?: string; at: string; status: 'shadow' | 'attempting' | 'outcome-unknown' | 'launched' | 'hitl' | 'wait' | 'asked' | 'answered' | 'awaiting-answer' | 'skipped-budget' | 'skipped-empty'; item?: SeatItem; candidate?: OpCandidate; action?: SeatAction; reason?: string; runId?: string; inquiry?: SeatInquiry; answer?: string; escalated?: boolean };
export type SeatLoopResult = SeatEntry | { seat: string; status: 'skipped-off' };
export type PersonaShadowEntry = { personaId: string; ts: string; status: 'shadow' | 'skipped-empty'; todo: PersonaTodo | null };
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
  append?: (path: string, entry: SeatEntry) => void;
  versions?: () => string[];
  /** Release schedules (version · cutAt) — a version is open while its cut is still ahead. Default reads the release ledger; unreadable ⇒ no checklist candidates (fail closed). */
  schedules?: () => Array<{ version: string; cutAt: string; landBy?: string | null }>;
  /** Checklist items of one version — default reads the release ledger DB (checklist.json is only a legacy import source since REL5b). */
  checklistItems?: (version: string) => Array<{ id: string; title: string; status: string; owner?: string | null; disposition?: string; evidence?: string }>;
  /** Full checklist snapshot including history, for stall detection. */
  stallChecklist?: (version: string) => Checklist;
  /** Inject a mailbox write for isolated failure tests; production uses the seat message store. */
  stallDelivery?: (message: MessageEnvelope, key: string, root: string) => boolean;
  /** Open cards from the decision ledger; injected only for isolated ledger tests. */
  pendingDecisions?: () => Array<Pick<DecisionEntry, 'id' | 'title' | 'category' | 'dueAt'>>;
  ledgerFiles?: (directory: string) => string[];
  lockContended?: () => void;
  /** Supply a question only when this seat lacks evidence for the selected work item. */
  inquire?: (seat: SeatId, item: SeatItem) => Promise<SeatInquiry | null> | SeatInquiry | null;
  /** Supply the receiving seat's answer; absent evidence must not invent a reply. */
  reply?: (seat: SeatId, question: string, from: SeatId) => Promise<SeatReply | null> | SeatReply | null;
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

export async function runPersonaShadowOnce(deps: SeatDeps = {}): Promise<PersonaShadowEntry[]> {
  if ((deps.personaConfig ?? getUserConfig().loops?.persona)?.enabled !== true) return [];
  const root = deps.root ?? effectiveInstanceRoot();
  const dir = deps.personaDir ?? (deps.root ? join(root, 'personas') : resolveStatePersonaDir());
  const registry = deps.personaRegistry ?? new PersonaRegistry();
  if (!deps.personaRegistry) {
    const loaded = await loadLayeredPersonaDirs(registry, deps.root ? [dir] : [dir, resolveRepositoryPersonaDir()]);
    for (const error of loaded.errors) observe('persona-load-error', { error });
  }
  const now = (deps.now ?? (() => new Date()))();
  const entries: PersonaShadowEntry[] = [];
  for (const profile of registry.list().sort((a, b) => a.personaId.localeCompare(b.personaId))) {
    const personaId = profile.personaId;
    const { todos, errors } = readPersonaTodos(dir, personaId);
    for (const error of errors) observe('persona-todo-error', { personaId, error });
    const todo = nextPersonaTodo(todos);
    const entry: PersonaShadowEntry = { personaId, ts: now.toISOString(), status: todo ? 'shadow' : 'skipped-empty', todo };
    const path = personaShadowLedgerPath(personaId, root, now);
    if (deps.appendPersona) deps.appendPersona(path, entry);
    else {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
    observe('persona-shadow', { personaId, status: entry.status, todoId: todo?.id ?? null });
    entries.push(entry);
  }
  return entries;
}

export async function runSeatLoopTurn(seat: string, deps: SeatDeps = {}): Promise<SeatLoopResult> {
  const result = await runSeatLoopOnce(seat, deps);
  try { await runPersonaShadowOnce(deps); }
  catch (error) { observe('persona-shadow-error', { error: String(error).slice(0, 200) }); }
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
function handledKeys(ledger: readonly SeatEntry[], shadow: boolean, root?: string): Set<string> {
  const inquiryRow = (entry: SeatEntry) => entry.action === 'seat-question' || entry.action === 'seat-answer' || !!entry.inquiry;
  return new Set(ledger.filter((entry, index) => entry.status === 'asked' || entry.status === 'answered'
    || (entry.status === 'hitl' && (!entry.inquiry || (!!root && !!entry.item && !!decisionReceipt(root, entry.seat, entry.item))))
    || (entry.inquiry?.to === 'CEO' && !!root && !!entry.item && !!decisionReceipt(root, entry.seat, entry.item))
    || (!inquiryRow(entry) && entry.status === 'outcome-unknown')
    || (!inquiryRow(entry) && entry.status === 'attempting' && !(entry.item?.source === 'checklist' && ledger.slice(index + 1).some((later) =>
      later.seat === entry.seat && later.status === 'launched' && later.item?.source === 'checklist'
      && later.item.version === entry.item?.version && later.item.id === entry.item?.id
      && later.item.title === entry.item?.title && later.item.evidenceHash === entry.item?.evidenceHash)))
    || (shadow && entry.status === 'shadow' && entry.action !== 'wait' && entry.item?.source !== 'checklist')
    || (entry.status === 'launched' && entry.item?.source !== 'checklist'))
    .filter((entry): entry is SeatEntry & { item: SeatItem } => !!entry.item && !!entry.item.source && typeof entry.item.id === 'string')
    .map((entry) => itemKey(entry.item)));
}

function eligibleItem(item: SeatItem, ledger: readonly SeatEntry[], handled: ReadonlySet<string>, shadow: boolean): boolean {
  const key = itemKey(item);
  if (handled.has(key)) return false;
  const lastWait = [...ledger].reverse().find((entry) => entry.item && itemKey(entry.item) === key
    && (entry.status === 'wait' || (shadow && entry.status === 'shadow' && entry.action === 'wait')));
  return !lastWait?.item || itemSnapshot(lastWait.item) !== itemSnapshot(item);
}

// Compare checklist snapshots without consulting release history or treating a version move as new work.
export function alreadyHandled(item: SeatItem, ledger: readonly SeatEntry[]): boolean {
  if (item.source !== 'checklist' || !item.seat || !item.asOf || item.evidenceHash === undefined) return false;
  const now = Date.parse(item.asOf);
  if (!Number.isFinite(now)) return false;
  return ledger.some((entry) => {
    const at = Date.parse(entry.at || entry.ts || '');
    return entry.seat === item.seat && at >= now - 7 * 24 * 60 * 60 * 1000 && at <= now
      // A shadowed seat question was never delivered — it must be picked again once delivery is on (RM3 · TC merge 10-03).
      && (entry.status === 'launched' || (entry.status === 'shadow' && !entry.inquiry))
      && entry.item?.source === 'checklist' && entry.item.id === item.id
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
  const consumed = handledKeys(activeLedger, (deps.config ?? getUserConfig().loops?.seat)?.mode === 'shadow', root);
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
  const itemsOf = deps.checklistItems ?? ((version: string) => listChecklist(version).items);
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
  for (const version of open === null ? [] : versions().sort(versionOrder)) {
    if (!open!.has(version)) {
      debug.log('seat.loop', 'skip-closed-version', { seat, version });
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
  checklist.sort((a, b) => versionOrder(a.version!, b.version!) || a.id.localeCompare(b.id));
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
export function pickNext(inputs: SeatInputs, ledger: readonly SeatEntry[], opts: { shadow?: boolean; root?: string } = {}): SeatItem | null {
  const handled = handledKeys(ledger, opts.shadow === true, opts.root);
  return [...inputs.requests, ...inputs.checklist].find((item) => {
    if (alreadyHandled(item, ledger)) {
      debug.log('seat.loop', 'skip-handled', { id: item.id });
      return false;
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

export async function runSeatLoopOnce(seat: string, deps: SeatDeps = {}): Promise<SeatLoopResult> {
  if (!/^(?:MK|OP|TC|UX)$/.test(seat)) throw new Error(`unknown seat: ${seat}`);
  const config = deps.config ?? getUserConfig().loops?.seat ?? { mode: 'off' };
  if (config.mode === 'off' || !(config.seats ?? ['MK']).includes(seat)) {
    observe('skipped-off', { seat });
    return { seat, status: 'skipped-off' };
  }
  const now = (deps.now ?? (() => new Date()))();
  const path = seatLedgerPath(seat, deps.root ?? effectiveInstanceRoot(), now);
  const directory = dirname(path);
  return withSeatLock(directory, async () => {
  const ledger = readSeatLedger(seat, deps, now);
  const stateRoot = deps.root ?? effectiveInstanceRoot();
  let turnError: unknown;
  try {
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
  const pendingQuestion = inputs.requests.find((candidate) => candidate.source === 'seat-question' && !questionHandled.has(itemKey(candidate)));
  const ordinary = pickNext({ ...inputs, requests: inputs.requests.filter((candidate) => candidate.source !== 'seat-question') }, ledger, { shadow: config.mode === 'shadow', root: stateRoot });
  const item = pendingQuestion ?? ordinary;
  const append = deps.append ?? defaultAppend;
  // RM3 review must-fix: `questions` now has a default, so it can't be the trigger — a shadow seat loop never calls the model on its own.
  if (item && (item.source === 'seat-question' || deps.inquire || (config.mode === 'on' && config.questions !== undefined))) {
    const root = deps.root ?? effectiveInstanceRoot();
    const unfinished = [...ledger].reverse().find((row) => row.item && itemKey(row.item) === itemKey(item)
      && (row.status === 'attempting' || row.status === 'outcome-unknown') && (row.action === 'seat-question' || row.action === 'seat-answer'));
    const inquiry = item.source === 'seat-question' ? null : unfinished?.inquiry ?? await (deps.inquire ?? (async (asking: SeatId, work: SeatItem) => { try {
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
        `${candidate.id} · ${candidate.title} (판 ${candidate.version}, ${candidate.kind})`).join('\n').slice(0, 8_000);
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
        append(path, entry);
        observe('question-shadow', { seat, item, inquiry: entry.inquiry, answered: !!entry.answer });
        return entry;
      }
      if (item.source === 'seat-question' && !reply) {
        entry.status = 'awaiting-answer';
        append(path, entry);
        return entry;
      }
      append(path, { ...entry, status: 'attempting' });
      try {
        if (item.source === 'seat-question' && reply && 'answer' in reply) {
          const question = { id: Number(item.id), from: item.from!, to: seat, body: item.text, kind: 'seat-question', createdAt: item.createdAt ?? '' };
          if (!hasSeatAnswer(root, question)) answerSeat(root, question, reply.answer);
          entry.status = 'answered';
        } else {
          const ask = entry.inquiry!;
          if (!ask.question.trim()) throw new Error('empty seat question');
          if (ask.to === 'CEO') {
            const prior = decisionReceipt(root, seat, item);
            if (!prior) {
              const run = deps.run ?? defaultRun;
              await run(['decisions', 'raise', '--title', `${seat}: ${ask.question}`, '--category', 'other',
                '--s', `${seat} 질문 · ${item.title}`, '--c', '판단 근거 부족 — 사람의 결정이 필요하다',
                '--option', 'a=승인:사람 판단으로 진행', '--option', 'b=보류:진행하지 않음',
                '--skip-recommend', '근거가 부족하다', '--agent', 'seat-loop', '--ref', decisionRef(seat, item), '--json']);
            }
            if (!decisionReceipt(root, seat, item)) throw new Error('decisions raise did not deliver a matching card');
            entry.status = 'hitl';
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
      if (parent && parent !== seat && !ledger.some((prior) => prior.status === 'skipped-budget' && prior.escalated === true && prior.reason === budget.reason
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
        '--skip-recommend', '금지 문면은 자동으로 권고하지 않는다', '--agent', 'seat-loop', '--json']);
      const decision: unknown = JSON.parse(raised.trim());
      if (!decision || typeof decision !== 'object' || typeof (decision as { id?: unknown }).id !== 'string') {
        throw new Error('decisions raise returned no decision id');
      }
      entry.status = 'hitl';
      append(path, entry);
      observe('hitl', { seat, item });
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
    try { escalateStalls(seat, deps, config, (deps.now ?? (() => new Date()))()); }
    catch (error) {
      debug.log('org.stall', 'escalate-error', { seat, error: String(error).slice(0, 200) }, { level: 'warn' });
      if (turnError !== undefined) throw new AggregateError([turnError, error], `seat turn failed (${String(turnError)}); stall escalation failed (${String(error)}) for ${seat}`);
      throw error;
    }
  }
  }, deps.lockContended);
}
