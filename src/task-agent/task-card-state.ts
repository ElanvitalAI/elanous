import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';
import type { TaskCard } from './task-hand.js';

export const TASK_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export interface TaskAgentStateFile {
  tasks?: Record<string, TaskCard>;
  [key: string]: unknown;
}

export function taskAgentStatePath(): string {
  return join(effectiveInstanceRoot(), 'task-agent-actions.json');
}

export class TaskAgentStateError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `task-agent 상태 파일을 읽을 수 없다 — 덮어쓰지 않고 멈춘다: ${path} (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = 'TaskAgentStateError';
  }
}

export function readTaskAgentState<T extends object = TaskAgentStateFile>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {} as T;
    return stateError(path, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return stateError(path, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return stateError(path, new Error('최상위가 객체가 아니다'));
  return parsed as T;
}

function stateError(path: string, cause: unknown): never {
  const error = new TaskAgentStateError(path, cause);
  try {
    debug.log('task-agent', 'state-unreadable', {
      path,
      reason: error.message,
    });
  } catch {
    /* fail-soft */
  }
  throw error;
}

function readState(path: string): TaskAgentStateFile {
  return readTaskAgentState<TaskAgentStateFile>(path);
}

export function writeTaskCards(path: string, cards: readonly TaskCard[]): void {
  withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    mkdirSync(dirname(path), { recursive: true });
    const tasks = { ...(disk.tasks ?? {}) };
    for (const card of cards) tasks[card.id] = card;
    writeFileSync(path, JSON.stringify({ ...disk, tasks }));
  });
}

export function updateTaskCardsAtomically(
  path: string,
  update: (tasks: Readonly<Record<string, TaskCard>>) => readonly TaskCard[] | undefined,
): TaskCard[] | undefined {
  return withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    const current = disk.tasks ?? {};
    const replacements = update(current);
    if (!replacements) return undefined;
    if (!replacements.length || replacements.some((card) => !card.id)) throw new Error('카드 원자 갱신은 id가 있는 카드가 필요하다');
    const tasks = { ...current };
    for (const card of replacements) tasks[card.id] = card;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...disk, tasks }));
    return [...replacements];
  });
}

export function updateTaskCard(
  path: string,
  id: string,
  update: (card: TaskCard | undefined, tasks: Readonly<Record<string, TaskCard>>) => TaskCard | undefined,
  options: { doctorLedgerDir?: string } = {},
): TaskCard | undefined {
  let needsOwner: { runId: string; at: string; reason: string; transitionIndex: number } | undefined;
  const result = withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    const current = disk.tasks?.[id];
    const next = update(current, disk.tasks ?? {});
    if (!next) return current;
    const transitionIndex = next.history.length - 1;
    const last = next.history[transitionIndex];
    if (
      current?.status === 'launched' &&
      next.status === 'failed' &&
      next.runId &&
      next.history.length > (current?.history.length ?? 0) &&
      last?.event === 'failed' &&
      last.detail?.startsWith('failed/needs-owner')
    ) {
      needsOwner = {
        runId: next.runId,
        at: last.at,
        reason: last.detail,
        transitionIndex,
      };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...disk, tasks: { ...(disk.tasks ?? {}), [id]: next } }));
    return next;
  });
  if (needsOwner) {
    try {
      const { recordTaskAgentNeedsOwnerVisit } =
        require('../self-implement/doctor-visit.js') as typeof import('../self-implement/doctor-visit.js');
      const visit = recordTaskAgentNeedsOwnerVisit({
        ...needsOwner,
        cardId: id,
        dir: options.doctorLedgerDir,
      });
      debug.log('task-agent', 'doctor-visit', {
        card: id,
        runId: needsOwner.runId,
        status: visit.status,
      });
    } catch (error) {
      debug.log('task-agent', 'doctor-visit-failed', {
        card: id,
        runId: needsOwner.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export function readTaskCard(id: string, path = taskAgentStatePath()): TaskCard | undefined {
  return readState(path).tasks?.[id];
}

export function cardPrNumber(card: Pick<TaskCard, 'pr'>): number | undefined {
  return typeof card.pr === 'number' ? card.pr : card.pr?.number;
}

export class TaskCardSupersededError extends Error {
  constructor(id: string) {
    super(`과제 카드를 다른 넘김이 가져갔다 — 쓰지 않았다: ${id}`);
    this.name = 'TaskCardSupersededError';
  }
}
