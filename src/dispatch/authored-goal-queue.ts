import { isNonEmptyString } from '../primitives/guards.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLockAsync, type AsyncLockHandle } from '../storage/file-lock.js';

import { debug } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { createRepositoryReferencedFileReader } from '../self-implement/goal-file-reader.js';
import type { AutoModeState } from '../auto-research/auto-mode/types.js';
import type { TerminationRule } from '../auto-research/termination-dsl.js';
import type { ContinuationOutcome } from './continuation-driver.js';
import { SCHEDULER_LOG_CATEGORY, type ActiveGoalRef } from './continuation-scheduler.js';

export interface AuthoredGoalQueueEntry {
  id: string;
  goalSlug: string;
  goalFile: string;
  terminationRule: TerminationRule;
}

export type EnqueueAuthoredGoal = Omit<AuthoredGoalQueueEntry, 'id'> & { id?: string };

interface AuthoredGoalQueueState {
  pending: AuthoredGoalQueueEntry[];
  completed: AuthoredGoalQueueEntry[];
}

interface QuarantinedQueueEntry {
  quarantinedAt: string;
  section: 'pending' | 'completed';
  index: number;
  reason: string;
  entry: unknown;
}

export class AuthoredGoalQueueLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`timed out waiting for authored goal queue lock: ${lockPath}`);
    this.name = 'AuthoredGoalQueueLockTimeoutError';
  }
}

/**
 * 잠금을 잡았는데 **쓰기 직전에 남의 것이 되어 있었다**(stale 오판 회수). 큐는 **바뀌지 않았고**
 * 호출자가 재시도하면 된다 — 조용히 덮어쓰는 것보다 낫다.
 */
export class AuthoredGoalQueueLockLostError extends Error {
  constructor(lockPath: string) {
    super(`authored goal queue lock was reclaimed by another holder: ${lockPath}`);
    this.name = 'AuthoredGoalQueueLockLostError';
  }
}

export class AuthoredGoalQueueDuplicateIdError extends Error {
  constructor(id: string) {
    super(`authored goal id already exists in the queue: ${id}`);
    this.name = 'AuthoredGoalQueueDuplicateIdError';
  }
}

// ⛔ stale 은 **정상 mutation 시간보다 압도적으로 커야** 한다 — 짧으면 살아 있는 잠금을 다른
// 프로세스가 탈취해 갱신이 유실된다(리뷰 must-fix). 큐 변경은 작은 JSON 의 read-modify-write 라
// 밀리초 이하이고, 30초를 넘기는 유일한 경우는 **보유자가 죽은 것**이다 — stale 회수의 본래 목적.
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_MIN_MS = 25;
const AUTHORED_GOAL_TERMINAL_OUTCOMES: ReadonlySet<ContinuationOutcome> = new Set([
  'complete',
  'budget',
  'max_turns',
  'andon-no-progress',
]);

export function isAuthoredGoalTerminalOutcome(outcome: ContinuationOutcome): boolean {
  return AUTHORED_GOAL_TERMINAL_OUTCOMES.has(outcome);
}

export function authoredGoalQueuePath(stateRoot = elanousStateRoot()): string {
  return join(stateRoot, 'dispatch', 'authored-goal-queue.json');
}

export function authoredGoalQueueLockPath(stateRoot = elanousStateRoot()): string {
  return `${authoredGoalQueuePath(stateRoot)}.lock`;
}

export function authoredGoalQueueQuarantinePath(stateRoot = elanousStateRoot()): string {
  return join(stateRoot, 'dispatch', 'authored-goal-queue.quarantine.jsonl');
}

/**
 * ⛔ `quarantine` 는 **변경 경로에서만** 켠다. 읽기만 하는 호출(매 틱 도는 것)이 격리 기록을 남기면
 * 같은 손상을 볼 때마다 레코드가 **무한히 쌓인다**(리뷰 should-fix) — 정제 결과를 저장하지도 않으므로.
 */
export function readAuthoredGoalQueue(stateRoot?: string, quarantine = false): AuthoredGoalQueueState {
  const path = authoredGoalQueuePath(stateRoot);
  if (!existsSync(path)) return emptyQueue();
  // ⛔ 못 읽는 파일을 **빈 큐로 간주하고 넘어가면**, 다음 mutation 이 원본을 덮어써 복구 가능한
  //   데이터가 사라진다(리뷰 should-fix) ⇒ 넘어가기 전에 **원문을 격리에 남긴다**.
  const raw = readFileSync(path, 'utf8');
  const abandon = (reason: string): AuthoredGoalQueueState => {
    debug.log(SCHEDULER_LOG_CATEGORY, 'queue-file-invalid', { path, reason });
    if (quarantine) quarantineQueueEntry({ quarantinedAt: new Date().toISOString(), section: 'pending', index: -1, reason: `unreadable queue file: ${reason}`, entry: raw }, stateRoot);
    return emptyQueue();
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return abandon(error instanceof Error ? error.message : String(error));
  }
  if (!value || typeof value !== 'object') {
    return abandon('queue root must be an object');
  }
  const candidate = value as { pending?: unknown; completed?: unknown };
  const state = {
    pending: parseQueueSection('pending', candidate.pending, stateRoot, quarantine),
    completed: parseQueueSection('completed', candidate.completed, stateRoot, quarantine),
  };
  // ⛔ 영속 파일이 **이미** 중복 id 를 갖고 있을 수 있다(손편집·부분 기록·옛 판). enqueue 의 검사는 새
  //   항목만 막는다. 중복이 남으면 같은 id 의 후속 항목이 선두로 오인돼 종료된 드라이버가 재사용되고
  //   큐가 영구 정지한다 ⇒ 읽는 자리에서 **뒤에 온 중복을 격리**한다(리뷰 must-fix).
  const seen = new Set<string>();
  for (const section of ['pending', 'completed'] as const) {
    state[section] = state[section].filter((entry, index) => {
      if (!seen.has(entry.id)) { seen.add(entry.id); return true; }
      if (quarantine) quarantineQueueEntry({ quarantinedAt: new Date().toISOString(), section, index, reason: 'duplicate id', entry }, stateRoot);
      return false;
    });
  }
  return state;
}

/**
 * `내부 문서 `GOAL-<name>`` → 큐 slug. ⛔ 큐의 slug 규칙은 `^[a-z0-9][a-z0-9_-]*$` 라 파일명을 그대로
 * 쓰면 `GOAL-` 접두의 대문자에서 깨진다 — 라이브로 확인했다(`invalid authored goal queue entry`).
 */
export function authoredGoalSlugFromFile(goalFile: string): string {
  return goalFile
    .replace(/^docs\/goals\/(?:GOAL-)?/, '')
    .replace(/\.md$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '');
}

/** Enqueue one explicitly selected authored goal; this never scans docs/goals. */
export async function enqueueAuthoredGoal(entry: EnqueueAuthoredGoal, opts: { stateRoot?: string; repositoryRoot: string }): Promise<AuthoredGoalQueueEntry> {
  const queued: AuthoredGoalQueueEntry = { ...entry, id: entry.id ?? randomUUID() };
  assertAuthoredGoal(queued, opts.repositoryRoot);
  await mutateQueue(opts.stateRoot, (state) => {
    // Uniqueness is checked under the lock against the just-read pending +
    // completed so a caller-supplied id can never collide with an entry
    // sameGoal/completeAuthoredGoal would then mistake for the same work.
    if (state.pending.some((e) => e.id === queued.id) || state.completed.some((e) => e.id === queued.id)) {
      throw new AuthoredGoalQueueDuplicateIdError(queued.id);
    }
    state.pending.push(queued);
    return queued;
  });
  debug.log(SCHEDULER_LOG_CATEGORY, 'queue-enqueued', { id: queued.id, goalSlug: queued.goalSlug, goalFile: queued.goalFile });
  return queued;
}

/**
 * Returns the persisted queue head after atomically quarantining and removing
 * unreadable heads. This never scans docs/goals: every candidate was explicitly
 * enqueued before it reached the state-root queue.
 */
export async function readNextAuthoredGoal(stateRoot?: string, repositoryRoot = process.cwd()): Promise<AuthoredGoalQueueEntry | null> {
  return mutateQueue(stateRoot, (state) => {
    while (state.pending.length > 0) {
      const entry = state.pending[0]!;
      try {
        assertAuthoredGoal(entry, repositoryRoot);
        return entry;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // ⛔⭐ **두 실패를 같은 운명으로 묶지 않는다**(라이브 폐루프가 잡았다 · 2026-08-01).
        //   ⓐ **환경적**(파일이 아직 없다·못 읽는다) — 저장소 루트가 어긋났거나 체크아웃이 덜 됐을 수
        //      있다. **버리면 골이 영영 사라진다.** ⇒ 큐에 **그대로 두고** 매 틱 관측에 남긴다.
        //      멈춘 큐는 로그에 보이고 되살릴 수 있지만, 지워진 골은 둘 다 아니다.
        //   ⓑ **구조적**(항목 모양이 틀렸다·경로가 저장소를 벗어난다) — 기다려도 유효해지지 않는다.
        //      ⇒ 종전대로 격리하고 버린다.
        if (isUnreadableGoalFileReason(reason)) {
          debug.log(SCHEDULER_LOG_CATEGORY, 'queue-entry-unreadable', {
            id: entry.id, goalSlug: entry.goalSlug, goalFile: entry.goalFile, repositoryRoot, reason,
          });
          return null;   // 선두를 남긴 채 이번 틱은 골 없음 — 다음 틱이 다시 본다
        }
        state.pending.shift();
        quarantineQueueEntry({
          quarantinedAt: new Date().toISOString(),
          section: 'pending',
          index: 0,
          reason,
          entry,
        }, stateRoot);
        debug.log(SCHEDULER_LOG_CATEGORY, 'queue-entry-skipped', {
          id: entry.id,
          goalSlug: entry.goalSlug,
          goalFile: entry.goalFile,
          reason,
        });
      }
    }
    return null;
  });
}

/** `readAuthoredGoalDocument` 가 파일을 못 읽었을 때의 문면인가 — 구조 결함과 가르는 기준. */
function isUnreadableGoalFileReason(reason: string): boolean {
  return reason.startsWith('authored goal file is not readable:');
}

/** Auto-mode takes priority; otherwise expose exactly the persisted queue head to the scheduler. */
/**
 * ⛔ 큐는 **thunk 으로** 받는다. 인자로 받으면 auto-mode 가 활성일 때도 호출부에서 **평가되어** 큐를
 * 읽고(격리 파일까지 쓸 수 있다) *"auto-mode 우선 시 큐를 안 건드린다"* 는 계약이 깨진다(리뷰 must-fix).
 */
export async function getActiveGoalFromSources(
  autoMode: AutoModeState,
  readQueued: () => AuthoredGoalQueueEntry | null | Promise<AuthoredGoalQueueEntry | null>,
): Promise<ActiveGoalRef | null> {
  if (autoMode.active && autoMode.goalSlug && autoMode.terminationRule) {
    return { goalSlug: autoMode.goalSlug, source: 'auto-mode' };
  }
  const queued = await readQueued();
  return queued ? { goalSlug: queued.goalSlug, id: queued.id, source: 'file-queue' } : null;
}

/**
 * 스케줄러가 매 틱 부르는 **생산 경로의 `getActiveGoal` 그대로**다.
 *
 * ⛔ nexus 클로저에 인라인으로 두면 *"auto-mode 활성 시 큐 무접촉"* 을 **테스트가 볼 수 없다** —
 *   7차 리뷰가 정확히 그것을 잡았다(helper 만 검증해 실제 위반을 놓쳤다). 그래서 팩토리로 뺀다.
 * ⛔ 자기수복 드레인(`completeAuthoredGoal` = **잠금 아래 mutation**)은 반드시 **thunk 안**에 있어야
 *   한다. 밖에 두면 auto-mode 가 활성이어도 큐를 잠그고 바꾼다 — thunk 지연 평가의 의미가 사라진다.
 */
export function createActiveGoalReader(deps: {
  getAutoModeState: () => AutoModeState;
  readNextAuthoredGoal: () => AuthoredGoalQueueEntry | null | Promise<AuthoredGoalQueueEntry | null>;
  completeAuthoredGoal: (id: string) => Promise<boolean>;
  pendingCompletions: Set<string>;
  onError: (error: unknown) => void;
}): () => Promise<ActiveGoalRef | null> {
  return async () => {
    try {
      return await getActiveGoalFromSources(deps.getAutoModeState(), async () => {
        // ⭐ 자기수복 — 실패해 남은 완료를 먼저 흘려보낸다. 성공하면 큐가 다시 나아간다.
        for (const id of [...deps.pendingCompletions]) {
          if (await deps.completeAuthoredGoal(id)) deps.pendingCompletions.delete(id);
        }
        return deps.readNextAuthoredGoal();
      });
    } catch (error) {
      deps.onError(error);
      return null;
    }
  };
}

/** Loads an explicitly queued goal document through the repository-safe reader. */
export function readAuthoredGoalDocument(entry: AuthoredGoalQueueEntry, repositoryRoot: string): string {
  assertGoalFile(entry.goalFile);
  const read = createRepositoryReferencedFileReader(repositoryRoot)(entry.goalFile);
  if (read.kind !== 'ok') throw new Error(`authored goal file is not readable: ${entry.goalFile} (${read.kind})`);
  return read.contents;
}

/** Moves only the matching queue head to completed after that exact queued driver's terminal result. */
export async function completeAuthoredGoal(id: string, stateRoot?: string): Promise<boolean> {
  const completed = await mutateQueue(stateRoot, (state) => {
    const entry = state.pending[0];
    if (!entry || entry.id !== id) return null;
    state.pending.shift();
    state.completed.push(entry);
    return entry;
  });
  if (!completed) {
    debug.log(SCHEDULER_LOG_CATEGORY, 'queue-completion-rejected', { id });
    return false;
  }
  debug.log(SCHEDULER_LOG_CATEGORY, 'queue-completed', { id, goalSlug: completed.goalSlug, goalFile: completed.goalFile });
  return true;
}

async function mutateQueue<T>(stateRoot: string | undefined, mutate: (state: AuthoredGoalQueueState) => T): Promise<T> {
  const path = authoredGoalQueuePath(stateRoot);
  const lockPath = authoredGoalQueueLockPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  const lock = await acquireQueueLock(lockPath);
  try {
    // ⭐ 변경 경로에서만 격리를 켠다 — 여기서는 정제 결과가 곧바로 저장되므로 레코드가 누적되지 않는다.
    const state = readAuthoredGoalQueue(stateRoot, true);
    const result = mutate(state);
    // ⛔⭐ **쓰기 직전에 소유를 재확인한다.** mtime 기반 stale 회수는 *"멈췄다가 되살아난 정상 보유자"*
    //   를 원리적으로 완전히는 가려낼 수 없다(리뷰 must-fix · 세 라운드 연속). ⇒ 오판을 0 으로 만들려
    //   하지 말고 **오판의 결과를 무해하게** 만든다 — 탈취당했으면 여기서 멈춘다(fail-closed).
    //   ⚠️ 읽기와 mutate 는 이미 했지만 **디스크에 쓰지 않았으므로** 큐는 그대로다. 호출자가 재시도한다.
    if (!lock.stillHeld()) {
      debug.log(SCHEDULER_LOG_CATEGORY, 'queue-lock-lost', { lockPath });
      throw new AuthoredGoalQueueLockLostError(lockPath);
    }
    writeQueue(state, path);
    return result;
  } finally {
    lock.release();
  }
}

async function acquireQueueLock(lockPath: string): Promise<AsyncLockHandle> {
  // ⛔ 잠금 전에 큐 파일을 만들거나 쓰지 않는다. 사전 `writeQueue(emptyQueue())` 는 느린 초기화가
  //   이미 잠근 다른 프로세스의 변경을 덮어쓰게 한다(리뷰 must-fix). 파일이 없으면 잠금을 잡은 **뒤**
  //   빈 큐로 읽으므로(readAuthoredGoalQueue → emptyQueue) 없는 자원에 대한 권고 리스로 충분하다.
  // ⭐ 잠금은 **저장소에 이미 있는** `acquireLockAsync` 를 쓴다 — 새 의존성을 들이지 않는다(리뷰 must-fix).
  //   같은 권고 리스 의미론이다: stale 회수 · 재시도 · inode 확인 해제.
  try {
    return await acquireLockAsync(lockPath, { staleMs: LOCK_STALE_MS, retryBusyMs: LOCK_RETRY_MIN_MS, maxTries: LOCK_RETRY_COUNT });
  } catch (error) {
    debug.log(SCHEDULER_LOG_CATEGORY, 'queue-lock-timeout', { lockPath, reason: error instanceof Error ? error.message : String(error) });
    throw new AuthoredGoalQueueLockTimeoutError(lockPath);
  }
}

function writeQueue(state: AuthoredGoalQueueState, path: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temporary, path);
}

function assertAuthoredGoal(entry: AuthoredGoalQueueEntry, repositoryRoot: string): void {
  if (!isQueueEntry(entry)) throw new Error('invalid authored goal queue entry');
  assertGoalFile(entry.goalFile);
  readAuthoredGoalDocument(entry, repositoryRoot);
}

function assertGoalFile(goalFile: string): void {
  const normalized = normalize(goalFile);
  if (normalized !== goalFile || !/^docs\/goals\/GOAL-[^/]+\.md$/.test(goalFile) || basename(goalFile) !== goalFile.slice('docs/goals/'.length)) {
    throw new Error(`authored goal file must be a direct docs/goals/GOAL-*.md path: ${goalFile}`);
  }
}

function emptyQueue(): AuthoredGoalQueueState {
  return { pending: [], completed: [] };
}

function parseQueueSection(section: 'pending' | 'completed', value: unknown, stateRoot: string | undefined, quarantine: boolean): AuthoredGoalQueueEntry[] {
  if (!Array.isArray(value)) {
    // ⛔ 배열이 아니면 원문을 **격리에 남기고** 빈 배열로 간다 — 안 남기면 다음 mutation 이 덮어써
    //   복구 가능한 큐 데이터가 사라진다(리뷰 must-fix · 못 읽는 파일 처리와 같은 규칙).
    debug.log(SCHEDULER_LOG_CATEGORY, 'queue-section-invalid', { section, reason: 'section must be an array' });
    if (quarantine) quarantineQueueEntry({ quarantinedAt: new Date().toISOString(), section, index: -1, reason: 'section must be an array', entry: value }, stateRoot);
    return [];
  }
  const valid: AuthoredGoalQueueEntry[] = [];
  value.forEach((entry, index) => {
    if (isQueueEntry(entry)) {
      valid.push(entry);
      return;
    }
    // ⛔ 항목별 격리도 **변경 경로에서만** 켠다. 비-배열 경로(위)만 조건부로 두었더니 읽기 전용
    //   호출(매 틱)이 같은 손상 항목을 볼 때마다 JSONL 을 무한히 늘렸다(7차 리뷰 must-fix).
    //   정제 결과를 저장하지 않는 읽기에서 격리만 쌓는 것은 잠금 없는 부작용이다.
    debug.log(SCHEDULER_LOG_CATEGORY, 'queue-entry-invalid', { section, index, reason: explainInvalidQueueEntry(entry) });
    if (quarantine) {
      quarantineQueueEntry({
        quarantinedAt: new Date().toISOString(),
        section,
        index,
        reason: explainInvalidQueueEntry(entry),
        entry,
      }, stateRoot);
    }
  });
  return valid;
}

function quarantineQueueEntry(record: QuarantinedQueueEntry, stateRoot?: string): void {
  const path = authoredGoalQueueQuarantinePath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  debug.log(SCHEDULER_LOG_CATEGORY, 'queue-entry-quarantined', {
    quarantinePath: path,
    section: record.section,
    index: record.index,
    reason: record.reason,
  });
}

function explainInvalidQueueEntry(value: unknown): string {
  if (!value || typeof value !== 'object') return 'entry must be an object';
  const candidate = value as Partial<AuthoredGoalQueueEntry>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return 'id must be a non-empty string';
  if (typeof candidate.goalSlug !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(candidate.goalSlug)) return 'goalSlug is invalid';
  if (typeof candidate.goalFile !== 'string') return 'goalFile must be a string';
  if (!isTerminationRule(candidate.terminationRule)) return 'terminationRule is invalid';
  return 'entry is invalid';
}

function isQueueEntry(value: unknown): value is AuthoredGoalQueueEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthoredGoalQueueEntry>;
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.goalSlug === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(candidate.goalSlug)
    && typeof candidate.goalFile === 'string' && isTerminationRule(candidate.terminationRule);
}

function isTerminationRule(value: unknown): value is TerminationRule {
  if (!value || typeof value !== 'object' || !('kind' in value) || typeof value.kind !== 'string') return false;
  const rule = value as Record<string, unknown>;
  switch (rule.kind) {
    case 'all_questions_answered': return isNonEmptyString(rule.queuePath);
    case 'min_sources': return isPositiveInteger(rule.n) && isNonEmptyString(rule.sourcesPath);
    case 'summary_written': return isNonEmptyString(rule.path) && (rule.minChars === undefined || isNonNegativeInteger(rule.minChars));
    case 'budget_remaining_min': return typeof rule.ratio === 'number' && Number.isFinite(rule.ratio) && rule.ratio >= 0 && rule.ratio <= 1;
    case 'and':
    case 'or': return Array.isArray(rule.rules) && rule.rules.length > 0 && rule.rules.every(isTerminationRule);
    case 'custom': return isNonEmptyString(rule.command) && (rule.timeoutMs === undefined || isPositiveInteger(rule.timeoutMs));
    default: return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
