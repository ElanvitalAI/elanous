// 골 grounding 정답 코퍼스 측정기 — 내부 문서 `MEASUREMENT-goal-grounding-answer-corpus-2026-07-29` 의 수치를 낸다.
// ⛔ 측정기·후보 상한을 바꾸면 **자가 바뀐 것**이라 옛 수치와 비교하면 안 된다.
// 실행: bun scripts/measure-goal-grounding-corpus.ts

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { installCorpusWorkerLiveness } from './corpus-worker-lifecycle.js';

/** 기본 worker는 이 파일 자신이다. 테스트는 deps.workerEntry seam으로 별도 가짜 worker를 공급한다. */
function defaultWorkerEntry(): string { return process.env.CORPUS_WORKER_ENTRY ?? process.argv[1]!; }
import { debug } from '../src/debug/log.js';
import { groundMissionInCodebase, type CodebaseGrounding, type SearchTermFn } from '../src/autopilot/mission-codebase-gate.js';
import { groundForGoalAuthor, type GoalAuthorGroundingPath } from '../src/self-implement/goal-author.js';
import { groundGoalInCodebase, GROUNDING_HEADER } from '../src/self-implement/ground-goal.js';
import { TUI_ENTRY_PATH } from '../test/helpers/dashboard-source.js';

type CorpusItem = { id: string; kind: string; ask: string; answers: readonly string[]; pr: number | null; searchTerms: readonly string[]; note?: string };

const CORPUS = [
  { id: 'B1', kind: 'B', ask: 'elanous logs 조회가 0건일 때 그 0이 무엇을 뜻하는지 함께 알려주도록 고쳐줘', answers: ['src/cli/logs-cli.ts'], pr: 5806, searchTerms: ['elanous', 'logs', '조회'] },
  { id: 'B2', kind: 'B', ask: '격리된 테스트 인스턴스가 살아있는 체크아웃을 조용히 편집하지 못하게 막아줘', answers: ['src/boot/tool-cwd.ts', 'src/boot/daemon-runtime.ts', 'src/nexus/index.ts'], pr: 5814, searchTerms: ['격리', '테스트', '체크아웃', '편집'] },
  { id: 'B3', kind: 'B', ask: '동시에 도는 턴들이 서로의 세션 식별자를 덮어쓰지 않게 해줘', answers: ['src/core-turn/run-core-turn.ts', 'src/debug/log.ts'], pr: 5809, searchTerms: ['동시에', '턴', '세션', '식별자'] },
  { id: 'B4', kind: 'B', ask: '인자 없이 부르면 격리 판정이 항상 운영으로 나오는 문제를 고쳐줘', answers: ['src/instance/current.ts', 'src/boot/tool-cwd.ts', 'src/cli/where-cli.ts', TUI_ENTRY_PATH, 'src/nexus/index.ts'], pr: 5820, searchTerms: ['인자', '격리', '판정', '운영'] },
  { id: 'B5', kind: 'B', ask: '팬아웃이 배달 0 을 냈을 때 그것이 어떤 종류의 0 인지 갈라서 알려줘', answers: ['src/session/session-fanout.ts'], pr: 5805, searchTerms: ['팬아웃', '배달', '종류'] },
  { id: 'A1', kind: 'A', ask: 'src/self-implement/goal-author.ts 가 근거를 모을 때 집계기를 쓰도록 바꿔줘', answers: ['src/self-implement/goal-author.ts'], pr: null, searchTerms: ['goal-author', '근거', '집계기'] },
  { id: 'A2', kind: 'A', ask: 'src/boot/tool-cwd.ts 의 죽은 타입을 살려서 경로 누출을 컴파일 에러로 만들어줘', answers: ['src/boot/tool-cwd.ts'], pr: 5815, searchTerms: ['tool-cwd', '타입', '경로'] },
  { id: 'A3', kind: 'A', ask: 'src/cli/logs-cli.ts 의 도움말 맨 앞에 사용 예시를 넣어줘', answers: ['src/index.ts'], pr: 5817, searchTerms: ['logs-cli', '도움말', '예시'], note: '⚠️ 명시 경로가 정답이 아니다 — 도움말 등록은 index.ts 에 있다' },
  { id: 'A4', kind: 'A', ask: 'src/session/session-fanout.ts 의 배달 결과에 계약 테스트를 세워줘', answers: ['src/session/session-fanout.ts'], pr: 5816, searchTerms: ['session-fanout', '배달', '계약'] },
] as const satisfies readonly CorpusItem[];

function answerPathSearchTermLeaks(item: CorpusItem): string[] {
  return item.answers.flatMap((answer) => {
    const basename = answer.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? '';
    return basename && item.searchTerms.some((term) => term.includes(basename)) && !item.ask.includes(basename) ? [basename] : [];
  });
}

export function assertCorpusHasNoAnswerPathSearchTermLeaks(corpus: readonly CorpusItem[] = CORPUS): void {
  const leaks = corpus.flatMap((item) => answerPathSearchTermLeaks(item).map((basename) => `${item.id}: ${basename}`));
  if (leaks.length) throw new Error(`Answer-path search-term leak: ${leaks.join(', ')}`);
}

export function assertCorpusSearchTermsComeFromAsk(corpus: readonly CorpusItem[] = CORPUS): void {
  const ungroundedTerms = corpus.flatMap((item) => item.searchTerms.filter((term) => !item.ask.includes(term)).map((term) => `${item.id}: ${term}`));
  if (ungroundedTerms.length) throw new Error(`Search term absent from ask: ${ungroundedTerms.join(', ')}`);
}

type MeasurementRole = 'authoring-selected' | 'authoring-free' | 'code-only baseline';
type CorpusMeasurementPath = GoalAuthorGroundingPath | 'groundGoalInCodebase';
type TrialStatus = 'ok' | 'timeout';
type CorpusPathResult = { 측정역할: MeasurementRole; 경로: CorpusMeasurementPath; 시행: number; 요청시행: number; 타임아웃수: number; 시행상태: TrialStatus[]; 후보수분포: number[]; 원소별: Array<{ path: string; 시행: number; 요청시행: number; 포함: number; 포함률: number | null; 순위들: Array<number | null>; 최선순위: number | null }> };

type WorkerKind = 'authoring' | 'authoring-free' | 'fallback';
type WorkerResult = { files: string[]; path?: GoalAuthorGroundingPath };
export interface CorpusMeasurementDeps {
  groundMission?: (ask: string, options: { cwd: string; searchTerms?: SearchTermFn }) => Promise<CodebaseGrounding>;
  groundGoal?: (ask: string, options: { cwd: string; searchTerms?: SearchTermFn }) => Promise<string>;
  fixedSearchTerms?: Readonly<Record<string, readonly string[]>>;
  /** Worker executable seam: tests provide corpus-fake-worker.ts without a production test mode. */
  workerEntry?: () => string;
  /** Environment supplied to an injected worker entry; production leaves it unset. */
  workerEnv?: Readonly<Record<string, string>>;
  /** Normal corpus calls took 57–94 seconds; 120 seconds exposes hangs without masking them. */
  timeoutMs?: number;
  /** Concurrent item/repeat jobs; default is deliberately conservative for a shared harness machine. */
  maxWorkers?: number;
  onTrial?: (rows: Array<Record<string, unknown>>) => void;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  cwd?: () => string;
}

export const CORPUS_CALL_TIMEOUT_MS = 120_000;
/**
 * We have not benchmarked CPU saturation in this repository. Two is a conservative cap: it halves
 * the prior one-at-a-time repeat cost without allowing one measurement to monopolize a shared harness host.
 */
export const CORPUS_MAX_WORKERS = 2;
/** Normal calls take 57–94s and time out at 120s; allow 10s for parent teardown before an orphan self-exits. */
export const CORPUS_WORKER_LIFETIME_GRACE_MS = 10_000;
export const CORPUS_RUNNER_LOCK = join(tmpdir(), 'elanous-measure-goal-grounding-corpus.lock');

type CorpusLog = NonNullable<CorpusMeasurementDeps['log']>;
const liveWorkers = new Set<ChildProcess>();
let cleanupHooksInstalled = false;

/** Lifecycle observability for the runner: zero after every completed measurement. */
export function corpusLiveWorkerCount(): number { return liveWorkers.size; }

function terminateWorkerGroup(child: ChildProcess, reason: string, log: CorpusLog = (category, event, data) => debug.log(category, event, data)): void {
  if (!child.pid) return;
  log('goal-grounding.corpus', 'worker-cleanup', { pid: child.pid, reason });
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
}

function cleanupLiveWorkers(reason: string): void {
  for (const child of liveWorkers) terminateWorkerGroup(child, reason);
}

function installCorpusRunnerCleanupHooks(): void {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;
  process.once('exit', () => cleanupLiveWorkers('exit'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      cleanupLiveWorkers(signal);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  process.once('uncaughtException', (error) => {
    cleanupLiveWorkers('uncaughtException');
    throw error;
  });
}

function isLiveProcess(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export function acquireCorpusRunnerLock(lockPath = CORPUS_RUNNER_LOCK): () => void {
  let descriptor: number;
  try { descriptor = openSync(lockPath, 'wx'); } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (Number.isInteger(pid) && isLiveProcess(pid)) throw new Error(`Corpus runner already running (pid ${pid})`);
    unlinkSync(lockPath); descriptor = openSync(lockPath, 'wx');
  }
  writeSync(descriptor, String(process.pid)); closeSync(descriptor);
  return () => { if (existsSync(lockPath)) unlinkSync(lockPath); };
}

function parseGroundGoalFiles(block: string): string[] {
  const prefix = `${GROUNDING_HEADER}\n`;
  if (!block.startsWith(prefix)) return [];
  return block.slice(prefix.length).split('\n').flatMap((line) => /^- (.+?)(?:: .+)?$/.exec(line)?.[1] ? [/^- (.+?)(?:: .+)?$/.exec(line)![1]!] : []);
}

function summarize(item: CorpusItem, trials: string[][], statuses: TrialStatus[], repeats: number, role: MeasurementRole, path: CorpusMeasurementPath): CorpusPathResult {
  // ⛔⭐ **타임아웃 시행은 품질 집계에서 뺀다**(리뷰 must-fix). 종전엔 타임아웃 시행이 `후보수분포`
  //    에 `0` 으로, `포함` 에 미포함으로 들어가 **"안 돌았다" 와 "못 찾았다" 가 같은 점수**가 됐다.
  //    ⇒ 자가 자기 고장을 **능력 저하로 보고**한다. 분모는 **완주한 시행 수**다.
  const completed = trials.filter((_files, index) => statuses[index] !== 'timeout');
  const timeouts = statuses.filter((status) => status === 'timeout').length;
  const denom = completed.length;
  const perAnswer = item.answers.map((answer) => {
    const ranks = completed.map((files) => { const index = files.indexOf(answer); return index < 0 ? null : index + 1; });
    const hits = ranks.filter((rank): rank is number => rank !== null);
    return {
      path: answer,
      // ⭐ `시행` 은 이제 **완주 시행**이다. 요청 시행 수는 `요청시행` 으로 따로 보인다
      //    (부재와 미지를 같은 값으로 두지 않는다).
      시행: denom, 요청시행: repeats, 포함: hits.length,
      포함률: denom > 0 ? +(hits.length / denom).toFixed(2) : null,
      순위들: ranks, 최선순위: hits.length ? Math.min(...hits) : null,
    };
  });
  return {
    측정역할: role, 경로: path, 시행: denom, 요청시행: repeats, 타임아웃수: timeouts,
    시행상태: statuses, 후보수분포: completed.map((files) => files.length), 원소별: perAnswer,
  };
}

function reportMeasurement(log: NonNullable<CorpusMeasurementDeps['log']>, item: CorpusItem, role: MeasurementRole, path: CorpusMeasurementPath, files: string[]): void {
  log('goal-grounding.corpus', 'measured', { id: item.id, role, path, candidates: files.length, included: item.answers.some((answer) => files.includes(answer)) });
}

export function corpusRepeats(value = process.env.CORPUS_REPEATS): number { return Number(value ?? 5); }

async function runWorker(kind: WorkerKind, item: CorpusItem, attempt: number, cwd: string, terms: readonly string[], timeoutMs: number, entry: () => string, workerEnv: Readonly<Record<string, string>> | undefined): Promise<WorkerResult> {
  installCorpusRunnerCleanupHooks();
  return await new Promise<WorkerResult>((resolve, reject) => {
    const child = spawn(process.execPath, [entry(), '--worker'], {
      detached: true,
      env: {
        ...process.env,
        ...workerEnv,
        CORPUS_WORKER_KIND: kind,
        CORPUS_WORKER_ASK: item.ask,
        CORPUS_WORKER_CWD: cwd,
        CORPUS_WORKER_TERMS: JSON.stringify(terms),
        CORPUS_WORKER_ITEM: item.id,
        CORPUS_WORKER_ATTEMPT: String(attempt),
        CORPUS_WORKER_PARENT_PID: String(process.pid),
        CORPUS_WORKER_MAX_LIFETIME_MS: String(timeoutMs + CORPUS_WORKER_LIFETIME_GRACE_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    liveWorkers.add(child);
    debug.log('goal-grounding.corpus', 'worker-spawned', { pid: child.pid, item: item.id, kind, timeoutMs });
    let stdout = ''; let stderr = ''; let settled = false; let timedOut = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateWorkerGroup(child, 'timeout');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => {
      liveWorkers.delete(child);
      debug.log('goal-grounding.corpus', 'worker-closed', { pid: child.pid, item: item.id, kind, code, timedOut });
      finish(() => {
        if (timedOut) reject(new Error('Corpus grounding call timed out'));
        else if (code !== 0) reject(new Error(`Corpus worker failed (${code}): ${stderr.trim()}`));
        else { try { resolve(JSON.parse(stdout) as WorkerResult); } catch { reject(new Error(`Corpus worker emitted invalid JSON: ${stdout}`)); } }
      });
    });
  });
}

async function runInjected<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation(), new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Corpus grounding call timed out')), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function callGrounding(kind: WorkerKind, item: CorpusItem, attempt: number, cwd: string, terms: readonly string[], timeoutMs: number, deps: CorpusMeasurementDeps): Promise<WorkerResult> {
  if (!deps.groundMission && !deps.groundGoal) return runWorker(kind, item, attempt, cwd, terms, timeoutMs, deps.workerEntry ?? defaultWorkerEntry, deps.workerEnv);
  const searchTerms: SearchTermFn = async () => [...terms];
  if (kind === 'authoring' || kind === 'authoring-free') {
    const mission = deps.groundMission ?? ((ask: string, options: { cwd: string; searchTerms?: SearchTermFn }) => groundMissionInCodebase(ask, options));
    const selected = await runInjected(
      () => groundForGoalAuthor(item.ask, cwd, {
        groundMission: (ask, options) => mission(ask, kind === 'authoring' ? { ...options, searchTerms } : options),
      }),
      timeoutMs,
    );
    return { files: selected.facts.files, path: selected.path };
  }
  const goal = deps.groundGoal ?? groundGoalInCodebase;
  return { files: parseGroundGoalFiles(await runInjected(() => goal(item.ask, { cwd, searchTerms }), timeoutMs)) };
}

type Trial = {
  operational: WorkerResult;
  operationalStatus: TrialStatus;
  authoringFree: WorkerResult;
  authoringFreeStatus: TrialStatus;
  fallback: WorkerResult;
  fallbackStatus: TrialStatus;
};

function lastAuthoringPath(trials: readonly Trial[], requestedCwd: string, result: (trial: Trial) => WorkerResult): CorpusMeasurementPath {
  if (requestedCwd !== process.cwd()) return 'groundGoalInCodebase';
  // The sequential measurement retained the final successful trial's path. Input-indexed trials make
  // that choice independent of worker completion order while preserving the established aggregate.
  for (let index = trials.length - 1; index >= 0; index -= 1) {
    const path = result(trials[index]!).path;
    if (path) return path;
  }
  return 'groundMissionInCodebase';
}

function lastOperationalPath(trials: readonly Trial[], requestedCwd: string): CorpusMeasurementPath {
  return lastAuthoringPath(trials, requestedCwd, (trial) => trial.operational);
}

function lastAuthoringFreePath(trials: readonly Trial[], requestedCwd: string): CorpusMeasurementPath {
  return lastAuthoringPath(trials, requestedCwd, (trial) => trial.authoringFree);
}

async function runWithConcurrency<T>(jobs: readonly (() => Promise<T>)[], maxWorkers: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  let firstFailure: unknown;
  const worker = async () => {
    while (firstFailure === undefined) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      try { results[index] = await jobs[index]!(); }
      catch (error) { firstFailure ??= error; }
    }
  };
  // Do not reject until every already-started worker settles. The runner lock therefore remains held
  // until no worker from this runner can outlive it; after the first failure no new job is assigned.
  await Promise.all(Array.from({ length: Math.min(maxWorkers, jobs.length) }, worker));
  if (firstFailure !== undefined) throw firstFailure;
  return results;
}

async function measureTrial(item: CorpusItem, attempt: number, requestedCwd: string, timeoutMs: number, deps: CorpusMeasurementDeps, log: CorpusLog): Promise<Trial> {
  const terms = deps.fixedSearchTerms?.[item.id] ?? item.searchTerms;
  const timed = (error: unknown): boolean => error instanceof Error && error.message === 'Corpus grounding call timed out';
  let operational: WorkerResult = { files: [] };
  let operationalStatus: TrialStatus = 'ok';
  if (requestedCwd === process.cwd()) {
    try { operational = await callGrounding('authoring', item, attempt, requestedCwd, terms, timeoutMs, deps); reportMeasurement(log, item, 'authoring-selected', operational.path ?? 'groundMissionInCodebase', operational.files); }
    catch (error) { if (!timed(error)) throw error; operationalStatus = 'timeout'; reportMeasurement(log, item, 'authoring-selected', 'groundMissionInCodebase', []); }
  }
  let authoringFree: WorkerResult = { files: [] };
  let authoringFreeStatus: TrialStatus = 'ok';
  if (requestedCwd === process.cwd()) {
    try { authoringFree = await callGrounding('authoring-free', item, attempt, requestedCwd, terms, timeoutMs, deps); reportMeasurement(log, item, 'authoring-free', authoringFree.path ?? 'groundMissionInCodebase', authoringFree.files); }
    catch (error) { if (!timed(error)) throw error; authoringFreeStatus = 'timeout'; reportMeasurement(log, item, 'authoring-free', 'groundMissionInCodebase', []); }
  }
  let fallback: WorkerResult = { files: [] };
  let fallbackStatus: TrialStatus = 'ok';
  try { fallback = await callGrounding('fallback', item, attempt, requestedCwd, terms, timeoutMs, deps); reportMeasurement(log, item, 'code-only baseline', 'groundGoalInCodebase', fallback.files); }
  catch (error) { if (!timed(error)) throw error; fallbackStatus = 'timeout'; reportMeasurement(log, item, 'code-only baseline', 'groundGoalInCodebase', []); }
  if (requestedCwd !== process.cwd()) {
    operational = fallback;
    operationalStatus = fallbackStatus;
    authoringFree = fallback;
    authoringFreeStatus = fallbackStatus;
    // The non-current-CWD authoring results are intentionally the baseline result, but retained so
    // all established and added measurement records remain observable.
    reportMeasurement(log, item, 'authoring-selected', 'groundGoalInCodebase', operational.files);
    reportMeasurement(log, item, 'authoring-free', 'groundGoalInCodebase', authoringFree.files);
  }
  return { operational, operationalStatus, authoringFree, authoringFreeStatus, fallback, fallbackStatus };
}

export async function measureGoalGroundingCorpus(repeats = corpusRepeats(), deps: CorpusMeasurementDeps = {}): Promise<Array<Record<string, unknown>>> {
  assertCorpusSearchTermsComeFromAsk(); assertCorpusHasNoAnswerPathSearchTermLeaks();
  const requestedCwd = (deps.cwd ?? process.cwd)();
  const timeoutMs = deps.timeoutMs ?? Number(process.env.CORPUS_CALL_TIMEOUT_MS ?? CORPUS_CALL_TIMEOUT_MS);
  const requestedWorkers = deps.maxWorkers ?? CORPUS_MAX_WORKERS;
  if (!Number.isInteger(requestedWorkers) || requestedWorkers < 1) throw new Error(`Invalid corpus worker concurrency: ${requestedWorkers}`);
  // `maxWorkers` can lower the pool for deterministic tests, but cannot raise the unbenchmarked
  // shared-host ceiling. This keeps one runner from starving concurrent harness runs.
  const maxWorkers = Math.min(requestedWorkers, CORPUS_MAX_WORKERS);
  const log = deps.log ?? ((category, event, data) => debug.log(category, event, data));
  const completed = new Map<number, Trial[]>();
  let nextTrialToEmit = 0;
  const rowsForTrials = (item: CorpusItem, itemTrials: readonly Trial[], count: number): Array<Record<string, unknown>> => {
    const currentTrials = itemTrials.slice(0, count);
    return [
      summarize(item, currentTrials.map((trial) => trial.operational.files), currentTrials.map((trial) => trial.operationalStatus), count, 'authoring-selected', lastOperationalPath(currentTrials, requestedCwd)),
      summarize(item, currentTrials.map((trial) => trial.fallback.files), currentTrials.map((trial) => trial.fallbackStatus), count, 'code-only baseline', 'groundGoalInCodebase'),
      summarize(item, currentTrials.map((trial) => trial.authoringFree.files), currentTrials.map((trial) => trial.authoringFreeStatus), count, 'authoring-free', lastAuthoringFreePath(currentTrials, requestedCwd)),
    ].map((result) => ({ id: item.id, kind: item.kind, pr: item.pr, ask: item.ask, answers: item.answers, ...result, ...(item.note ? { note: item.note } : {}) }));
  };
  const emitCompletedTrialsInInputOrder = (): void => {
    // Workers finish out of order. Buffer by global item/repeat index, then restore input order so
    // CLI JSONL keeps its repeat-level recovery contract without waiting for an entire item to finish.
    while (nextTrialToEmit < CORPUS.length * repeats) {
      const itemIndex = Math.floor(nextTrialToEmit / repeats);
      const attempt = nextTrialToEmit % repeats;
      const itemTrials = completed.get(itemIndex);
      const trial = itemTrials?.[attempt];
      if (!trial) return;
      deps.onTrial?.(rowsForTrials(CORPUS[itemIndex]!, itemTrials.slice(0, attempt + 1) as Trial[], attempt + 1));
      nextTrialToEmit += 1;
    }
  };
  const jobs = CORPUS.flatMap((item, itemIndex) => Array.from({ length: repeats }, (_unused, attempt) => async () => {
    const trial = await measureTrial(item, attempt, requestedCwd, timeoutMs, deps, log);
    const itemTrials = completed.get(itemIndex) ?? [];
    itemTrials[attempt] = trial;
    completed.set(itemIndex, itemTrials);
    emitCompletedTrialsInInputOrder();
    return trial;
  }));
  const trials = await runWithConcurrency(jobs, maxWorkers);
  const out: Array<Record<string, unknown>> = [];
  for (let itemIndex = 0; itemIndex < CORPUS.length; itemIndex += 1) {
    const item: CorpusItem = CORPUS[itemIndex]!;
    const itemTrials = trials.slice(itemIndex * repeats, (itemIndex + 1) * repeats);
    const operationalTrials = itemTrials.map((trial) => trial.operational.files);
    const fallbackTrials = itemTrials.map((trial) => trial.fallback.files);
    const authoringFreeTrials = itemTrials.map((trial) => trial.authoringFree.files);
    const operationalStatuses = itemTrials.map((trial) => trial.operationalStatus);
    const fallbackStatuses = itemTrials.map((trial) => trial.fallbackStatus);
    const authoringFreeStatuses = itemTrials.map((trial) => trial.authoringFreeStatus);
    const operationalPath = lastOperationalPath(itemTrials, requestedCwd);
    const authoringFreePath = lastAuthoringFreePath(itemTrials, requestedCwd);
    const rows = (count: number) => [
      summarize(item, operationalTrials.slice(0, count), operationalStatuses.slice(0, count), count, 'authoring-selected', operationalPath),
      summarize(item, fallbackTrials.slice(0, count), fallbackStatuses.slice(0, count), count, 'code-only baseline', 'groundGoalInCodebase'),
      summarize(item, authoringFreeTrials.slice(0, count), authoringFreeStatuses.slice(0, count), count, 'authoring-free', authoringFreePath),
    ].map((result) => ({ id: item.id, kind: item.kind, pr: item.pr, ask: item.ask, answers: item.answers, ...result, ...(item.note ? { note: item.note } : {}) }));
    out.push(...rows(repeats));
  }
  return out;
}

export async function runCorpusRunner(
  repeats = corpusRepeats(),
  deps: CorpusMeasurementDeps = {},
  acquireLock: () => () => void = () => acquireCorpusRunnerLock(process.env.CORPUS_RUNNER_LOCK_PATH ?? CORPUS_RUNNER_LOCK),
): Promise<Array<Record<string, unknown>>> {
  const release = acquireLock();
  try { return await measureGoalGroundingCorpus(repeats, deps); }
  finally { release(); }
}

async function workerMain(): Promise<void> {
  installCorpusWorkerLiveness();
  const kind = process.env.CORPUS_WORKER_KIND as WorkerKind; const ask = process.env.CORPUS_WORKER_ASK!; const cwd = process.env.CORPUS_WORKER_CWD!; const terms = JSON.parse(process.env.CORPUS_WORKER_TERMS ?? '[]') as string[];
  // ⛔⛔ **테스트 백도어를 두지 않는다**(리뷰 must-fix). 종전엔 `CORPUS_TEST_WORKER_MODE` 가 있으면
  //    모든 worker 가 `files: []` 를 내서 **환경변수 하나로 자가 전부 0건을 보고**했다.
  //    자에 그런 스위치가 있으면 그 자의 어떤 수치도 신뢰할 수 없다. 타임아웃·스트리밍 검증은
  //    **가짜 worker 스크립트를 스폰해서** 한다(프로덕션 경로를 건드리지 않는다).
  const searchTerms: SearchTermFn = async () => terms;
  if (kind === 'authoring' || kind === 'authoring-free') {
    const selected = await groundForGoalAuthor(ask, cwd, {
      groundMission: (goal, options) => groundMissionInCodebase(goal, kind === 'authoring' ? { ...options, searchTerms } : options),
    });
    process.stdout.write(JSON.stringify({ files: selected.facts.files, path: selected.path }));
    return;
  }
  process.stdout.write(JSON.stringify({ files: parseGroundGoalFiles(await groundGoalInCodebase(ask, { cwd })) }));
}

/** ⛔ `debug.log` 만으로는 **logs.db 에 닿지 않는다** — standalone 스크립트는 싱크가 없다.
 *  ⇒ `elanous logs --category goal-grounding.corpus` 가 **0건**이었다(2026-07-30 실측 · 실측 중인
 *    러너에서 `worker-spawned`·`orphan-detected` 가 하나도 조회되지 않았다).
 *  ⚠️ 이것은 **골 결함**이었다: 수용 기준이 *"`debug.log(...)` 로 남긴다"* 였고 자식은 그것을
 *    문자 그대로 충족했다. 그러나 **관측 가능성**(조회에 뜨는 것)은 요구하지 않았다.
 *    ⇒ ***검사할 수 없는 것을 계약에 넣으면 충족과 무용이 같은 값이 된다.***
 *  ⭐ fail-open: 싱크 등록이 실패해도 측정은 계속한다(측정이 관측 배선에 인질이 되지 않게). */
async function installCorpusLogSink(): Promise<void> {
  try {
    const { registerStandaloneLogSink } = await import('../src/domains/standalone-log-sink.js');
    await registerStandaloneLogSink('harness:goal-grounding-corpus');
  } catch { /* fail-open — 관측 배선 실패가 측정을 막지 않는다 */ }
}

if (process.argv.includes('--worker')) { await installCorpusLogSink(); await workerMain(); }
else if (import.meta.main) {
  await installCorpusLogSink();
  const result = await runCorpusRunner(corpusRepeats(), {
    onTrial: (rows) => rows.forEach((row) => process.stdout.write(`${JSON.stringify(row)}\n`)),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
