/**
 * TASK-AGENT 과제 넘기기 문 — `elanous task hand "<한 줄>"` (RFC-task-agent-any-task-to-completion §A9 표 1행 · R3).
 *
 * - 과제 카드를 실행부와 «같은» 상태 파일(`effectiveInstanceRoot()/task-agent-actions.json`)의 `tasks` 칸에 적는다.
 *   종전 칸(landingDay·landingsToday·failureCounts)은 그대로 두고 덧붙이기만 한다(하위 호환 — 실행부 쓰기는 `...disk` 로 보존).
 * - 첫 수는 «launch» = `harness say [--seat <자리>] --substrate pod --merge-by-host "<원문>"`.
 * - 기본은 SHADOW: 카드와 명령만 남기고 아무것도 띄우지 않는다. `--live` 일 때만 주입된 launcher 로 띄운다.
 * - 관측: `debug.log('task-agent', 'handed', {taskId, seat, checklistId, mode})`.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';

export const TASK_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export type TaskSeat = typeof TASK_SEATS[number];
/** 과제 카드 id 접두 — `task show <id>` 가 이 접두로 TOX 태스크와 갈린다. */
export const TASK_CARD_PREFIX = 'ta-';

export interface TaskCardEvent { at: string; event: string; detail?: string }
export interface TaskCardMove { kind: 'launch' | 'wait'; command?: string[]; reason: string }
export interface TaskCard {
  id: string;
  text: string;
  seat?: TaskSeat;
  checklistId?: string;
  createdAt: string;
  /** launch-failed = 발사기가 띄우기에 실패했다(사유는 history 마지막 칸) — 다음 수는 다시 발사. */
  status: 'handed' | 'launched' | 'launch-failed';
  history: TaskCardEvent[];
  /** 미션 카드만 — 조각 카드 id(순서대로) · 쪼갠 출처(`mission.ts` splitMission). */
  pieces?: string[];
  splitSource?: string;
  /** 조각 카드만 — 소속 미션 카드 id · 먼저 착지해야 하는 조각 id(선후). */
  mission?: string;
  after?: string[];
  /** 조각 카드만 — 착지 근거(② `tasks advance --pr|--goal`): 이 조각 런이 연 PR 번호 · 골 id(16자 · 런 원장 `pr-opened` 로 PR 을 찾는다). */
  pr?: number;
  goalId?: string;
  /** 조각 카드만 — ② 가 선행 착지 뒤 넘겼다(한 번만 · 같은 잠금 안에서 먼저 적는다). */
  handed?: { at: string; mode: 'shadow' | 'live'; claim?: string; error?: string };
  /** 미션 카드만 — 모든 조각 착지 → 칸 green «제안»(체크리스트는 손대지 않는다 · OP/주인이 뒤집는다). */
  greenProposal?: { at: string; checklistId: string | null; evidence: Record<string, string> };
}

interface TaskAgentStateFile { tasks?: Record<string, TaskCard>; [key: string]: unknown }

export function taskAgentStatePath(): string {
  return join(effectiveInstanceRoot(), 'task-agent-actions.json');
}

/** 상태 파일을 읽을 수 없거나(ENOENT 제외) 해석할 수 없다 — 덮어쓰기 전에 멈춘다. */
export class TaskAgentStateError extends Error {
  constructor(path: string, cause: unknown) {
    super(`task-agent 상태 파일을 읽을 수 없다 — 덮어쓰지 않고 멈춘다: ${path} (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = 'TaskAgentStateError';
  }
}

/**
 * 실행부·과제 넘기기 문이 함께 쓰는 상태 파일(`task-agent-actions.json`)의 엄격한 읽기.
 * 파일이 «없음»(ENOENT)만 빈 상태다. 그 밖의 읽기·해석 오류(손상된 JSON · 객체 아님 · 권한)는
 * 던진다 — 빈 상태로 읽고 다시 쓰면 failureCounts·착지 기록·과제 카드가 지워진다.
 */
export function readTaskAgentState<T extends object = TaskAgentStateFile>(path: string): T {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {} as T;
    return stateError(path, error);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { return stateError(path, error); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return stateError(path, new Error('최상위가 객체가 아니다'));
  return parsed as T;
}

function stateError(path: string, cause: unknown): never {
  const error = new TaskAgentStateError(path, cause);
  try { debug.log('task-agent', 'state-unreadable', { path, reason: error.message }); } catch { /* fail-soft */ }
  throw error;
}

function readState(path: string): TaskAgentStateFile {
  return readTaskAgentState<TaskAgentStateFile>(path);
}

/** 카드 여럿을 한 잠금 안에서 적는다(미션 ⊕ 조각) — 종전 칸은 `...disk` 로 보존. */
export function writeTaskCards(path: string, cards: readonly TaskCard[]): void {
  withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    mkdirSync(dirname(path), { recursive: true });
    const tasks = { ...(disk.tasks ?? {}) };
    for (const card of cards) tasks[card.id] = card;
    writeFileSync(path, JSON.stringify({ ...disk, tasks }));
  });
}

/** 카드 하나를 잠금 안에서 읽고 고쳐 쓴다 — `update` 가 undefined 를 돌려주면 쓰지 않는다. 쓴(또는 그대로인) 카드를 돌려준다. */
export function updateTaskCard(path: string, id: string, update: (card: TaskCard | undefined, tasks: Readonly<Record<string, TaskCard>>) => TaskCard | undefined): TaskCard | undefined {
  return withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    const current = disk.tasks?.[id];
    const next = update(current, disk.tasks ?? {});
    if (!next) return current;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...disk, tasks: { ...(disk.tasks ?? {}), [id]: next } }));
    return next;
  });
}

export function readTaskCard(id: string, path = taskAgentStatePath()): TaskCard | undefined {
  return readState(path).tasks?.[id];
}

/** 첫 수의 elanous 인자(진입점·--config-dir 앞붙임은 launcher 몫). */
export function launchArgs(card: Pick<TaskCard, 'text' | 'seat'>): string[] {
  return ['harness', 'say', ...(card.seat ? ['--seat', card.seat] : []), '--substrate', 'pod', '--merge-by-host', card.text];
}

/**
 * `landed` = 착지한 조각 id(② 감지가 채운다). 안 주면 «모른다» — 선행은 미착지로 보고(fail-closed)
 * 이유에 «착지 미확인»을 단다(착지했다/안 했다를 단정하지 않는다).
 * 미션 카드는 스스로 발사하지 않는다 · 아직 안 뜬 조각의 선행이 덜 착지했으면 `wait after <id>`.
 */
export function nextMoveFor(card: TaskCard, landed?: ReadonlySet<string>): TaskCardMove {
  if (card.pieces) return { kind: 'wait', reason: `미션 — 조각 ${card.pieces.length}장이 선후대로 발사된다` };
  const unmet = (card.after ?? []).filter((id) => !landed?.has(id));
  if (card.status !== 'launched' && unmet.length > 0) return { kind: 'wait', reason: `after ${unmet.join(', ')}${landed ? '' : ' · 착지 미확인'}` };
  if (card.status === 'handed') return { kind: 'launch', command: launchArgs(card), reason: '넘겨받은 과제 — 첫 발사' };
  if (card.status === 'launch-failed') return { kind: 'launch', command: launchArgs(card), reason: '직전 발사 실패 — 다시 발사' };
  return { kind: 'wait', reason: '발사됨 — 런 멈춤을 슈퍼바이저 그림자 판단(task-agent.shadow-move)이 받는다' };
}

export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export type TaskLauncher = (args: string[]) => void | Promise<void>;

export interface HandTaskOptions {
  text: string;
  seat?: TaskSeat;
  checklistId?: string;
  live?: boolean;
  statePath?: string;
  /** `--live` 일 때만 불린다. */
  launcher?: TaskLauncher;
  now?: () => Date;
  id?: string;
  /** 미션 조각으로 넘길 때 — 카드에 소속 미션·선후를 싣는다. */
  mission?: string;
  after?: string[];
  /** 착지한 조각 id — `after` 가 모두 여기 있어야 발사한다(② 의 자리). */
  landed?: ReadonlySet<string>;
  /** 카드에 그대로 싣는 칸(② 의 넘김 표지·착지 근거) — handTask 가 카드를 새로 적을 때 지워지지 않게. */
  cardFields?: Pick<TaskCard, 'pr' | 'goalId' | 'handed'>;
  /**
   * 있으면 카드 쓰기마다 잠금 안에서 디스크 카드를 보고 참일 때만 쓴다(② 의 claim 소유 확인).
   * 거짓이면 쓰지 않고 `TaskCardSupersededError` — 다른 넘김이 그 카드를 가져갔다(발사 전이면 발사하지 않는다).
   */
  writeGuard?: (current: TaskCard | undefined) => boolean;
}

/** `writeGuard` 가 거짓 — 다른 넘김이 카드를 가져갔다. 카드는 건드리지 않았다. */
export class TaskCardSupersededError extends Error {
  constructor(id: string) {
    super(`과제 카드를 다른 넘김이 가져갔다 — 쓰지 않았다: ${id}`);
    this.name = 'TaskCardSupersededError';
  }
}

/** `--live` 발사가 실패했다 — 카드는 launch-failed 로 남았다. */
export class TaskLaunchError extends Error {
  constructor(card: TaskCard, reason: string) {
    super(`발사 실패 (${card.id} → launch-failed): ${reason}`);
    this.name = 'TaskLaunchError';
  }
}

export interface HandTaskResult { card: TaskCard; move: TaskCardMove; mode: 'shadow' | 'live'; launched: boolean }

export async function handTask(opts: HandTaskOptions): Promise<HandTaskResult> {
  const text = opts.text.trim();
  if (!text) throw new Error('과제 한 줄이 비어 있다');
  if (opts.seat !== undefined && !TASK_SEATS.includes(opts.seat)) throw new Error(`자리는 ${TASK_SEATS.join('|')} 중 하나다: ${opts.seat}`);
  const now = (opts.now ?? (() => new Date()))();
  const id = opts.id ?? `${TASK_CARD_PREFIX}${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
  const mode = opts.live ? 'live' : 'shadow';
  const path = opts.statePath ?? taskAgentStatePath();
  const card: TaskCard = {
    id, text,
    ...(opts.seat ? { seat: opts.seat } : {}),
    ...(opts.checklistId ? { checklistId: opts.checklistId } : {}),
    createdAt: now.toISOString(),
    status: 'handed',
    history: [],
    ...(opts.mission ? { mission: opts.mission, after: [...(opts.after ?? [])] } : {}),
    ...(opts.cardFields ?? {}),
  };
  const move = nextMoveFor(card, opts.landed);
  if (move.kind !== 'launch') throw new Error(`발사할 수 없는 과제다 — ${move.reason}`);
  const guard = opts.writeGuard;
  const writeCard = (target: string, next: TaskCard): void => {
    if (!guard) { writeTaskCards(target, [next]); return; }
    const owned = { ok: false };
    // 착지 근거(pr·goalId)는 `recordPieceRef` 소유 — claim 뒤에 적힌 최신 근거를 디스크에서 이어 받는다.
    updateTaskCard(target, next.id, (current) => {
      if (!guard(current)) return undefined;
      owned.ok = true;
      // next 의 옛 근거는 버리고 디스크의 근거로 «교체»한다 — 정정된 근거 옆에 옛 근거가 되살아나지 않게.
      const { pr: _stalePr, goalId: _staleGoal, ...base } = next;
      return { ...base, ...(current?.pr !== undefined ? { pr: current.pr } : {}), ...(current?.goalId !== undefined ? { goalId: current.goalId } : {}) };
    });
    if (!owned.ok) throw new TaskCardSupersededError(next.id);
  };
  writeCard(path, card);
  try { debug.log('task-agent', 'handed', { taskId: id, seat: card.seat ?? null, checklistId: card.checklistId ?? null, mode }); } catch { /* fail-soft */ }
  if (mode === 'shadow') return { card, move, mode, launched: false };
  if (!opts.launcher) throw new Error('--live 인데 launcher 가 없다');
  try {
    await opts.launcher(move.command!);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed: TaskCard = { ...card, status: 'launch-failed', history: [{ at: (opts.now ?? (() => new Date()))().toISOString(), event: 'launch-failed', detail: reason }] };
    writeCard(path, failed);
    try { debug.log('task-agent', 'launch-failed', { taskId: id, seat: card.seat ?? null, reason }); } catch { /* fail-soft */ }
    throw new TaskLaunchError(failed, reason);
  }
  const launched: TaskCard = { ...card, status: 'launched', history: [{ at: (opts.now ?? (() => new Date()))().toISOString(), event: 'launch', detail: move.command!.join(' ') }] };
  writeCard(path, launched);
  try { debug.log('task-agent', 'launched', { taskId: id, seat: card.seat ?? null }); } catch { /* fail-soft */ }
  return { card: launched, move, mode, launched: true };
}
