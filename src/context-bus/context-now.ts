import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { queryRunningRuns, type QueriedRunningRunsResult } from '../self-implement/running-runs.js';
import { loadRunLedger, resolveFederatedRunLedgerDirectories, runLedgerDir } from '../self-implement/run-ledger.js';
import { localLoopRows } from '../dashboard/slash-runtime/loops-table.js';
import { checkBrand } from '../../scripts/brand/check.js';
import { debug, redactSecretText } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { listChecklist, devVersion, type Checklist } from '../release-loop/checklist.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { setElanousConfigDir } from '../elanous-config-dir.js';
import { seatDay, seatLedgerPath, type SeatEntry } from '../seat-loop/seat-loop.js';
import { listCoordEvents, type CoordEvent } from './coord-events.js';
import { filterPublicDemoContext } from './context-now-public.js';

export type ContextFact =
  | { kind: 'version'; version: string; source: string }
  | { kind: 'cell'; version: string; id: string; title: string; status: string; owner: string | null; source: string; priority?: string | null }
  | { kind: 'decision'; id: string; title: string; status: string; dueAt: string | null; source: string }
  | { kind: 'seat'; seat: string; at: string; status: string; id: string | null; title: string | null; source: string }
  | { kind: 'run'; goal: string; phase: string; elapsed: string; source: string; unreadable?: string }
  | { kind: 'release'; version: string; node: string; status: string; source: string; unreadable?: string }
  | { kind: 'schedule-late'; count: number | null; names: string[]; source: string; unreadable?: string };
export type ContextEvent = { at: string; kind: string; summary: string; source: string };
export type ContextNowAnswer = { at: string; topic: string | null; facts: ContextFact[]; events: ContextEvent[]; guide: string[]; hiddenCount?: number };

export interface ContextNowDeps {
  now?: () => Date;
  version?: () => string;
  checklist?: (version: string) => Checklist;
  decisions?: () => DecisionEntry[];
  seatEntries?: (now: Date) => Array<{ entry: SeatEntry; source: string }>;
  events?: (since: string) => CoordEvent[];
  runningRuns?: (now: Date) => Extract<ContextFact, { kind: 'run' }>[];
  queryRuns?: () => QueriedRunningRunsResult;
  releaseRun?: () => Extract<ContextFact, { kind: 'release' }> | null;
  lateSchedules?: (now: Date) => Extract<ContextFact, { kind: 'schedule-late' }> | null;
  brandCheck?: typeof checkBrand;
}

function todaySeatEntries(now: Date): Array<{ entry: SeatEntry; source: string }> {
  const root = effectiveInstanceRoot();
  const day = seatDay(now);
  return ['OP', 'TC', 'MK', 'UX'].flatMap(seat => {
    const path = seatLedgerPath(seat, root, now);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').flatMap((line, index) => line.trim() ? [{
      entry: JSON.parse(line) as SeatEntry,
      source: `elanous://seat-loop/${seat}/${day}#${index + 1}`,
    }] : []);
  });
}

function seatFact({ entry, source }: { entry: SeatEntry; source: string }): Extract<ContextFact, { kind: 'seat' }> {
  return { kind: 'seat', seat: entry.seat, at: entry.at, status: entry.status,
    id: entry.item?.id ?? null, title: entry.item?.source === 'checklist'
      ? redactSecretText(entry.item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120) : null, source };
}

/** The TUI status line needs seat facts only; it must not scan release or run ledgers. */
export function seatStatusNow(now = new Date()): ContextNowAnswer {
  return { at: `${now.toISOString().slice(0, 16)}:00.000Z`, topic: null,
    facts: todaySeatEntries(now).map(seatFact), events: [], guide: [] };
}

const runSource = 'elanous://self-implement/running-runs';
const releaseSource = 'elanous://graph-runs/release-loop';
const scheduleSource = 'elanous://schedules';
const oneLine = (text: string) => redactSecretText(text.split(/\r?\n/, 1)[0] ?? '').slice(0, 120);

// src/dashboard/slash-runtime/dashboard-handlers.ts:buildDashboardSlashRegistry /now calls contextNowInWorker;
// contextNow → queryRunningRuns → queryFederatedUnfinishedRunLedgers → queryUnfinishedRunLedgers (persisted scan index).
function runningRunFacts(now: Date, queryRuns: () => QueriedRunningRunsResult = () => queryRunningRuns({
  includeTest: false,
  caller: 'context-now',
  noCache: false,
}, {
  ledgerDirectories: () => [...new Set([runLedgerDir(), ...resolveFederatedRunLedgerDirectories({ includeTest: false })])],
})): Extract<ContextFact, { kind: 'run' }>[] {
  const observed = queryRuns();
  const unreadable = observed.completeness === 'partial' || observed.pty.unreadable.length || !!observed.phases?.unreadableTargetCount;
  const facts = observed.entries.filter(entry => observed.countedStatuses.includes(entry.status)).slice(0, 8).flatMap(entry => {
    let ledgerReadFailure = false;
    const starts = entry.ledgerDirectories.flatMap(directory => {
      try { return loadRunLedger(entry.runId, directory)?.filter(record => record.event === 'start') ?? []; }
      catch { ledgerReadFailure = true; return []; }
    });
    const goalRecord = starts.find(record => typeof record.data.feature === 'string' && record.data.feature.trim());
    const goal = typeof goalRecord?.data.feature === 'string' ? goalRecord.data.feature : ledgerReadFailure ? '골 관측 불가' : '골 미기록';
    const started = starts.map(record => record.timestamp ? Date.parse(record.timestamp) : NaN).find(Number.isFinite) ?? NaN;
    const minutes = Number.isFinite(started)
      ? Math.max(0, Math.floor((now.getTime() - started) / 60_000)) : null;
    const fact = { kind: 'run' as const, goal: oneLine(goal),
      phase: entry.lastPhase ?? '단계 미관측', elapsed: minutes === null ? ledgerReadFailure ? '경과 관측 불가' : '경과 미관측' : `${minutes}분`,
      source: `${runSource}/${encodeURIComponent(entry.runId)}` };
    return ledgerReadFailure
      ? [
          ...(goalRecord || minutes !== null ? [fact] : []),
          { kind: 'run' as const, goal: '', phase: '', elapsed: '', source: fact.source, unreadable: '런 원장 일부 관측 불가' },
        ] : [fact];
  });
  return unreadable ? [...facts, { kind: 'run', goal: '', phase: '', elapsed: '', source: runSource, unreadable: '런 원장 또는 관측 대상 일부' }] : facts;
}

function latestReleaseRun(): Extract<ContextFact, { kind: 'release' }> | null {
  const dir = join(effectiveInstanceRoot(), 'graph-runs', 'release-loop');
  let filenames: string[];
  try { filenames = readdirSync(dir).filter(name => /^[A-Za-z0-9-]+\.json$/.test(name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const runs = filenames.flatMap(filename => {
    const path = join(dir, filename);
    let run: { startedAt?: unknown; status?: unknown; input?: { version?: unknown }; path?: unknown; nodes?: unknown };
    try {
      if (!lstatSync(path).isFile()) return [];
      run = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }
    if (typeof run.startedAt !== 'string' || typeof run.status !== 'string' || !Array.isArray(run.path) || !Array.isArray(run.nodes)) return [];
    const steps = run.path.filter((step): step is string => typeof step === 'string');
    const nodes = run.nodes.filter((node): node is { nodeId: string } => !!node && typeof node.nodeId === 'string');
    const version = typeof run.input?.version === 'string' && /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(run.input.version) ? run.input.version : '판 미기록';
    const index = Math.min(steps.length, nodes.length + (run.status === 'running' || run.status === 'awaiting-approval' ? 1 : 0));
    return [{ startedAt: run.startedAt, fact: { kind: 'release' as const, version, node: `${index}/${steps.length}${steps[index - 1] ? ` ${oneLine(steps[index - 1]!)}` : ''}`,
      status: oneLine(run.status), source: `${releaseSource}/${encodeURIComponent(filename.slice(0, -5))}` } }];
  });
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.fact ?? null;
}

function lateScheduleFact(now: Date): Extract<ContextFact, { kind: 'schedule-late' }> {
  const names = localLoopRows(now).filter(row => row.verdict === 'late').map(row => oneLine(row.name));
  return { kind: 'schedule-late', count: names.length, names, source: scheduleSource };
}

function unreadableReason(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error)) || '원천 조회 실패';
}

/** Read a bounded, source-labelled view of current ledgers, never a transcript or decision body. */
export function contextNow(options: { topic?: string; limit?: number; audience?: 'operator' | 'user' | 'public-demo' } = {}, deps: ContextNowDeps = {}): ContextNowAnswer {
  const now = (deps.now ?? (() => new Date()))();
  const at = `${now.toISOString().slice(0, 16)}:00.000Z`;
  const topic = options.topic?.trim() || null;
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit))) : 20;
  const version = (deps.version ?? devVersion)().replace(/-.*$/, '');
  const next = version.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_, major: string, minor: string, patch: string) => `${major}.${minor}.${Number(patch) + 1}`);
  const facts: ContextFact[] = [];
  for (const v of [...new Set([version, next])]) {
    const checklist = (deps.checklist ?? listChecklist)(v);
    if (v === version) facts.push({ kind: 'version', version: v, source: `elanous://release/${v}/checklist` });
    for (const item of checklist.items) {
      if (item.status === 'done') continue;
      facts.push({ kind: 'cell', version: v, id: item.id, title: redactSecretText(item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
        status: item.status, owner: item.owner ?? null, priority: item.priority ?? null,
        source: `elanous://release/${v}/checklist#${encodeURIComponent(item.id)}` });
    }
  }
  for (const item of (deps.decisions ?? (() => new DecisionLedger().list({ status: 'open' })))()) {
    if (item.status !== 'open') continue;
    facts.push({ kind: 'decision', id: item.id, title: redactSecretText(item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
      status: item.status, dueAt: item.dueAt ?? null, source: `elanous://decisions/${encodeURIComponent(item.id)}` });
  }
  facts.push(...(deps.seatEntries ?? todaySeatEntries)(now).map(seatFact));
  const rawEvents = (deps.events ?? (since => listCoordEvents({ since })))(new Date(now.getTime() - 7 * 86_400_000).toISOString());
  const chronologicalEvents = rawEvents.slice().sort((a, b) => a.at.localeCompare(b.at));
  const matches = (text: string) => !topic || text.toLocaleLowerCase().includes(topic.toLocaleLowerCase());
  const operational: ContextFact[] = [];
  if (options.audience !== 'public-demo') {
    try { operational.push(...(deps.runningRuns ?? (date => runningRunFacts(date, deps.queryRuns)))(now)); }
    catch (error) { operational.push({ kind: 'run', goal: '', phase: '', elapsed: '', source: runSource, unreadable: unreadableReason(error) }); }
    try {
      const release = (deps.releaseRun ?? latestReleaseRun)();
      if (release) operational.push(release);
    } catch (error) { operational.push({ kind: 'release', version: '', node: '', status: '', source: releaseSource, unreadable: unreadableReason(error) }); }
    try { const schedules = (deps.lateSchedules ?? lateScheduleFact)(now); if (schedules) operational.push(schedules); }
    catch (error) { operational.push({ kind: 'schedule-late', count: null, names: [], source: scheduleSource, unreadable: unreadableReason(error) }); }
  }
  const selectedOperational = operational.filter(f => !topic || ('unreadable' in f && !!f.unreadable) || (f.kind === 'run' && matches(`${f.goal} ${f.phase}`))
    || (f.kind === 'release' && matches(`${f.version} ${f.node} ${f.status}`))
    || (f.kind === 'schedule-late' && matches(f.names.join(' '))));
  const selectedFacts = facts.filter(f => !topic || (f.kind === 'cell' && matches(`${f.id} ${f.title}`))
    || (f.kind === 'seat' && matches(`${f.id ?? ''} ${f.title ?? ''}`)));
  const groups = (['version', 'cell', 'decision', 'seat'] as const).map(kind => selectedFacts.filter(f => f.kind === kind));
  groups[3]!.sort((a, b) => (a.kind === 'seat' && b.kind === 'seat' ? b.at.localeCompare(a.at) : 0));
  const nonEmpty = groups.filter(group => group.length > 0);
  const perKind = Math.floor(limit / nonEmpty.length);
  const chosen = groups.map(group => group.splice(0, perKind));
  let remaining = limit - chosen.reduce((total, group) => total + group.length, 0);
  for (const index of [2, 3, 0, 1]) {
    if (remaining <= 0) break;
    if (chosen[index]!.length === 0 && groups[index]!.length > 0) {
      chosen[index]!.push(...groups[index]!.splice(0, 1));
      remaining--;
    }
  }
  for (const index of [1, 2, 3, 0]) {
    if (remaining <= 0) break;
    const extra = groups[index]!.splice(0, remaining);
    chosen[index]!.push(...extra);
    remaining -= extra.length;
  }
  const boundedFacts = [...selectedOperational.slice(0, limit), ...chosen.flat()];
  const summaries = chronologicalEvents.map(event => ({
    at: event.at, kind: event.kind, summary: redactSecretText(event.summary.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
    source: event.refs.source ?? event.refs.url ?? `elanous://context/event/${encodeURIComponent(event.id)}`,
  }));
  const selectedEvents = summaries.filter(event => matches(event.summary)).reverse().slice(0, limit);
  const guide = summaries.filter(event => event.kind === 'guide-changed' || event.kind === 'guidance-changed' || event.summary.startsWith('📌안내'))
    .filter(event => matches(event.summary)).reverse().slice(0, limit)
    .map(event => `📌 ${event.summary} — ${event.source}`);
  const answer = { at, topic, facts: boundedFacts, events: selectedEvents, guide };
  debug.log('context.now', 'answer', { topic, facts: answer.facts, events: answer.events });
  return options.audience === 'public-demo' ? filterPublicDemoContext(answer, deps.brandCheck) : answer;
}

export type AskOpContextTopic = 'release' | 'required' | 'train' | 'incident' | 'decision' | 'general';
export type AskOpContextBundle = {
  queriedAt: string;
  topic: AskOpContextTopic;
  facts: Array<{ kind: string; summary: string; source: string; observedAt: string }>;
  gaps: Array<{ kind: string; reason: string }>;
};

function askOpTopic(question: string): AskOpContextTopic {
  const text = question.toLocaleLowerCase();
  if (/열차|착지|병합|merge|train|pull request|\bpr\b/.test(text)) return 'train';
  if (/사고|장애|incident|failure|실패|에러|오류/.test(text)) return 'incident';
  if (/결정|승인|decision|approval/.test(text)) return 'decision';
  if (/필수|p0|must|required|우선순위/.test(text)) return 'required';
  if (/발행|출시|릴리스|release|컷|cut|게이트|gate|이번 판|다음 판|판 진도|\b\d+\.\d+\.\d+\b/.test(text)) return 'release';
  return 'general';
}

/** A small evidence packet for an OP answer. A missing source stays a gap, never an inferred fact. */
export function buildAskOpContextBundle(
  question: string,
  snapshot: ContextNowAnswer,
  options: { audience?: 'operator' | 'public-demo'; limit?: number } = {},
): AskOpContextBundle {
  const answer = options.audience === 'public-demo' ? filterPublicDemoContext(snapshot) : snapshot;
  const topic = askOpTopic(question);
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(20, Math.floor(options.limit))) : 8;
  const facts: AskOpContextBundle['facts'] = [];
  const gaps: AskOpContextBundle['gaps'] = [];
  const pushFact = (kind: string, summary: string, source: string, observedAt: string) => {
    if (facts.length < limit) facts.push({ kind, summary: oneLine(summary), source, observedAt });
  };
  const relevant = (kind: ContextFact['kind']) => topic === 'general'
    || (topic === 'release' && (kind === 'release' || kind === 'version'))
    || (topic === 'required' && kind === 'cell')
    || (topic === 'decision' && kind === 'decision')
    || (topic === 'incident' && kind === 'run');
  for (const fact of answer.facts) {
    if (!relevant(fact.kind)) continue;
    if ('unreadable' in fact && fact.unreadable) {
      gaps.push({ kind: fact.kind, reason: fact.unreadable });
      continue;
    }
    if (topic === 'required' && fact.kind === 'cell' && fact.priority !== 'P0') continue;
    if (topic === 'incident' && fact.kind === 'run' && !/fail|error|timeout|실패|오류|정지|중단/i.test(`${fact.phase} ${fact.goal}`)) continue;
    if (topic === 'train') continue;
    const summary = fact.kind === 'version' ? `판 ${fact.version}`
      : fact.kind === 'cell' ? `${fact.id} ${fact.status} ${fact.title}`
      : fact.kind === 'decision' ? `${fact.id} ${fact.status} ${fact.title}`
      : fact.kind === 'seat' ? `${fact.seat} ${fact.status} ${fact.id ?? ''}`
      : fact.kind === 'run' ? `${fact.goal} ${fact.phase} ${fact.elapsed}`
      : fact.kind === 'release' ? `${fact.version} ${fact.node} ${fact.status}`
      : `${fact.count ?? '미관측'}건 ${fact.names.join(', ')}`;
    pushFact(fact.kind, summary, fact.source, fact.kind === 'seat' ? fact.at : answer.at);
  }
  const eventMatches = (kind: string, summary: string) => topic === 'general'
    || (topic === 'train' && /train|열차|착지|병합|merge|\bpr\b/i.test(`${kind} ${summary}`))
    || (topic === 'incident' && /incident|사고|장애|failure|실패|에러|오류|timeout/i.test(`${kind} ${summary}`));
  for (const event of answer.events) {
    if (eventMatches(event.kind, event.summary)) pushFact(event.kind, event.summary, event.source, event.at);
  }
  if (topic === 'required' && !facts.length) {
    const cells = answer.facts.filter(fact => fact.kind === 'cell');
    if (cells.some(fact => fact.priority == null)) gaps.push({ kind: 'cell', reason: '우선순위 미관측' });
    else if (cells.length) gaps.push({ kind: 'cell', reason: '조회 범위에서 일치하는 P0 없음' });
  }
  if (!facts.length && !gaps.length) gaps.push({ kind: topic, reason: '미관측' });
  if (topic === 'release' && !answer.facts.some(fact => fact.kind === 'release' && !('unreadable' in fact && fact.unreadable))
    && !gaps.some(gap => gap.kind === 'release')) gaps.push({ kind: 'release', reason: '미관측' });
  return { queriedAt: answer.at, topic, facts, gaps: gaps.slice(0, 3) };
}

/** Worker scan keeps ledger IO away from the OP inbox turn; the packet itself is bounded. */
export async function askOpContextBundle(
  question: string,
  options: { audience?: 'operator' | 'public-demo'; limit?: number } = {},
  readSnapshot: () => Promise<ContextNowAnswer> = () => contextNowInWorker({ audience: 'operator', limit: 100 }),
): Promise<AskOpContextBundle> {
  try { return buildAskOpContextBundle(question, await readSnapshot(), { ...options, audience: options.audience ?? 'public-demo' }); }
  catch { return { queriedAt: new Date().toISOString(), topic: askOpTopic(question), facts: [], gaps: [{ kind: 'context', reason: '조회 실패' }] }; }
}

const workerAnswers = new Map<string, { promise: Promise<ContextNowAnswer>; expiresAt: number }>();
const WORKER_ANSWER_TTL_MS = 5_000;
const WORKER_SCAN_TIMEOUT_MS = 60_000;
let workerScanTail: Promise<void> = Promise.resolve();

/** Keep the ledger scan off the TUI event loop. Repeated identical reads share one scan. */
export function contextNowInWorker(options: Parameters<typeof contextNow>[0] = {}): Promise<ContextNowAnswer> {
  const stateRoot = process.env.ELANOUS_STATE_DIR;
  const selectedRoot = effectiveInstanceRoot();
  const key = JSON.stringify([selectedRoot, stateRoot ?? null, options.topic ?? null, options.limit ?? null, options.audience ?? null]);
  const now = Date.now();
  for (const [cachedKey, cached] of workerAnswers) {
    if (cached.expiresAt < now) workerAnswers.delete(cachedKey);
  }
  const cached = workerAnswers.get(key);
  if (cached) return cached.promise;
  // Distinct topics queue behind the active scan instead of multiplying the same costly ledger walk.
  const promise = workerScanTail.then(() => scanContextNowInWorker(options, stateRoot, selectedRoot));
  workerScanTail = promise.then(() => undefined, () => undefined);
  const entry = { promise, expiresAt: Infinity };
  workerAnswers.set(key, entry);
  void promise.then(() => { entry.expiresAt = Date.now() + WORKER_ANSWER_TTL_MS; }, () => { workerAnswers.delete(key); });
  return promise;
}

export function scanContextNowInWorker(options: Parameters<typeof contextNow>[0], stateRoot: string | undefined, selectedRoot: string,
  createWorker: () => Worker = () => new Worker(new URL(import.meta.url), { workerData: { kind: 'context-now' } }),
  timeoutMs = WORKER_SCAN_TIMEOUT_MS): Promise<ContextNowAnswer> {
  const worker = createWorker();
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      debug.log('context.now', 'worker-timeout', { timeoutMs, topic: options?.topic ?? null, selectedRoot });
      finish(new Error(`context_now worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error?: Error, answer?: ContextNowAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // 첫 호출 지연은 색인과 무관하게 «따로» 재야 판정선과 비교할 수 있다 — 스캔 자체의 ms 를 남긴다.
      debug.log('context.now', 'worker-answer', { topic: options?.topic ?? null, ok: !error, ms: Date.now() - startedAt });
      void worker.terminate();
      if (error) reject(error);
      else resolve(answer!);
    };
    worker.on('message', (message: { answer?: ContextNowAnswer; error?: string }) => {
      if (message.error) finish(new Error(message.error));
      else if (message.answer) finish(undefined, message.answer);
    });
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => { if (!settled) finish(new Error(`context_now worker exited before answering: ${code}`)); });
    // Preserve both caller roots: a programmatic config override is not inherited by workers.
    worker.postMessage({ options, stateRoot, selectedRoot });
  });
}

const contextWorkerPort = parentPort;
if (!isMainThread && contextWorkerPort && workerData?.kind === 'context-now') {
  contextWorkerPort.on('message', ({ options, stateRoot, selectedRoot }: { options: Parameters<typeof contextNow>[0]; stateRoot?: string; selectedRoot: string }) => {
    try {
      if (stateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = stateRoot;
      setElanousConfigDir(selectedRoot);
      contextWorkerPort.postMessage({ answer: contextNow(options) });
    }
    catch (error) { contextWorkerPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
