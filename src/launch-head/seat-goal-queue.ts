import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { QueueSeat } from '../harness/harness-queue.js';

export type SeatGoalStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired';
export type SeatGoal = {
  id: string;
  seat: QueueSeat;
  goal: string;
  prerequisites: string[];
  notBefore?: string;
  endAt?: string;
  queuedAt: string;
  status: SeatGoalStatus;
  startedAt?: string;
  finishedAt?: string;
};
export type SeatGoalInput = {
  id?: string;
  seat: QueueSeat;
  goal: string;
  prerequisites?: string[];
  notBefore?: string;
  endAt?: string;
};
export type SeatGoalQueueOptions = { root?: string; now?: () => Date };
export type SeatGoalScheduleOptions = SeatGoalQueueOptions & {
  maxConcurrent: number;
  seatCaps: Partial<Record<QueueSeat, number>>;
  launch: (goal: SeatGoal) => Promise<void> | void;
};
export type SeatGoalScheduleResult = { outcome: 'started' | 'waiting' | 'empty'; goal?: SeatGoal; reason: string };

const SEATS = new Set(['OP', 'TC', 'MK', 'UX']);
const TERMINAL = new Set<SeatGoalStatus>(['succeeded', 'failed', 'expired']);

export function seatGoalQueuePath(root = effectiveInstanceRoot()): string {
  return join(root, 'launch-head', 'seat-goals.sqlite');
}

function openQueue(root: string): Database {
  const path = seatGoalQueuePath(root);
  mkdirSync(join(root, 'launch-head'), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(`CREATE TABLE IF NOT EXISTS seat_goals (
    id TEXT PRIMARY KEY, seat TEXT NOT NULL, goal TEXT NOT NULL, prerequisites TEXT NOT NULL,
    not_before TEXT, end_at TEXT, queued_at TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT, finished_at TEXT
  )`);
  return db;
}

type GoalRow = {
  id: string; seat: QueueSeat; goal: string; prerequisites: string;
  not_before: string | null; end_at: string | null; queued_at: string;
  status: SeatGoalStatus; started_at: string | null; finished_at: string | null;
};

function toGoal(row: GoalRow): SeatGoal {
  return {
    id: row.id, seat: row.seat, goal: row.goal, prerequisites: JSON.parse(row.prerequisites) as string[],
    queuedAt: row.queued_at, status: row.status,
    ...(row.not_before ? { notBefore: row.not_before } : {}),
    ...(row.end_at ? { endAt: row.end_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function rows(db: Database): SeatGoal[] {
  return (db.query('SELECT * FROM seat_goals ORDER BY queued_at, rowid').all() as GoalRow[]).map(toGoal);
}

function instant(value: string, field: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error(`seat goal queue: invalid ${field}`);
  return time;
}

function clock(now?: () => Date): Date {
  const date = now?.() ?? new Date();
  if (!Number.isFinite(date.getTime())) throw new Error('seat goal queue: invalid clock');
  return date;
}

function cap(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`seat goal queue: invalid ${field}`);
  return value;
}

/** The launcher owns this store; producers enqueue only, never start a goal. */
export function enqueueSeatGoal(input: SeatGoalInput, options: SeatGoalQueueOptions = {}): SeatGoal {
  if (!SEATS.has(input.seat)) throw new Error('seat goal queue: invalid seat');
  if (!input.goal?.trim()) throw new Error('seat goal queue: empty goal');
  const id = input.id ?? `sg-${randomUUID()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) throw new Error('seat goal queue: invalid id');
  const prerequisites = input.prerequisites ?? [];
  if (!Array.isArray(prerequisites) || prerequisites.some((key) => typeof key !== 'string' || !key.trim())
    || new Set(prerequisites).size !== prerequisites.length || prerequisites.includes(id)) {
    throw new Error('seat goal queue: invalid prerequisites');
  }
  const start = input.notBefore === undefined ? undefined : instant(input.notBefore, 'notBefore');
  const end = input.endAt === undefined ? undefined : instant(input.endAt, 'endAt');
  if (start !== undefined && end !== undefined && end <= start) throw new Error('seat goal queue: endAt must follow notBefore');
  const queuedAt = clock(options.now).toISOString();
  if (end !== undefined && end <= Date.parse(queuedAt)) throw new Error('seat goal queue: endAt has passed');
  const db = openQueue(options.root ?? effectiveInstanceRoot());
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const all = rows(db);
      if (all.some((row) => row.id === id)) throw new Error(`seat goal queue: duplicate id ${id}`);
      for (const key of prerequisites) {
        if (!all.some((row) => row.id === key)) throw new Error(`seat goal queue: missing prerequisite ${key}`);
      }
      db.query(`INSERT INTO seat_goals (id, seat, goal, prerequisites, not_before, end_at, queued_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`).run(id, input.seat, input.goal, JSON.stringify(prerequisites),
        input.notBefore ?? null, input.endAt ?? null, queuedAt);
      db.exec('COMMIT');
      return { id, seat: input.seat, goal: input.goal, prerequisites: [...prerequisites], queuedAt, status: 'queued',
        ...(input.notBefore ? { notBefore: input.notBefore } : {}), ...(input.endAt ? { endAt: input.endAt } : {}) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function listSeatGoals(options: SeatGoalQueueOptions = {}): SeatGoal[] {
  const db = openQueue(options.root ?? effectiveInstanceRoot());
  try { return rows(db); } finally { db.close(); }
}

/** Completion is an explicit launcher receipt: an uncertain or crashed launch keeps its slot reserved. */
export function finishSeatGoal(id: string, status: 'succeeded' | 'failed', options: SeatGoalQueueOptions = {}): SeatGoal {
  const db = openQueue(options.root ?? effectiveInstanceRoot());
  try {
    const finishedAt = clock(options.now).toISOString();
    const result = db.query("UPDATE seat_goals SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .run(status, finishedAt, id);
    if (result.changes !== 1) throw new Error(`seat goal queue: goal is not running: ${id}`);
    return toGoal(db.query('SELECT * FROM seat_goals WHERE id = ?').get(id) as GoalRow);
  } finally { db.close(); }
}

/** One tick claims at most one eligible goal atomically across launcher processes. */
export async function scheduleSeatGoals(options: SeatGoalScheduleOptions): Promise<SeatGoalScheduleResult> {
  const totalLimit = cap(options.maxConcurrent, 'maxConcurrent');
  for (const [seat, value] of Object.entries(options.seatCaps)) {
    if (!SEATS.has(seat) || value === undefined) throw new Error('seat goal queue: invalid seatCaps');
    cap(value, `seatCaps.${seat}`);
  }
  const db = openQueue(options.root ?? effectiveInstanceRoot());
  let selected: SeatGoal | undefined;
  let reason = 'empty';
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const at = clock(options.now);
      const all = rows(db);
      const byId = new Map(all.map((goal) => [goal.id, goal]));
      for (const goal of all) {
        if (goal.status !== 'queued') continue;
        const failed = goal.prerequisites.some((id) => {
          const prerequisite = byId.get(id);
          return !prerequisite || (TERMINAL.has(prerequisite.status) && prerequisite.status !== 'succeeded');
        });
        if (failed || (goal.endAt && Date.parse(goal.endAt) <= at.getTime())) {
          db.query("UPDATE seat_goals SET status = 'expired', finished_at = ? WHERE id = ? AND status = 'queued'")
            .run(at.toISOString(), goal.id);
          goal.status = 'expired';
          goal.finishedAt = at.toISOString();
        }
      }
      const running = all.filter((goal) => goal.status === 'running');
      for (const goal of all) {
        if (goal.status !== 'queued') continue;
        if (goal.notBefore && Date.parse(goal.notBefore) > at.getTime()) { reason = 'not-before'; continue; }
        if (goal.prerequisites.some((id) => byId.get(id)?.status !== 'succeeded')) { reason = 'prerequisites'; continue; }
        if (running.length >= totalLimit) { reason = 'global-cap'; continue; }
        if (running.filter((row) => row.seat === goal.seat).length >= (options.seatCaps[goal.seat] ?? totalLimit)) {
          reason = 'seat-cap'; continue;
        }
        const startedAt = at.toISOString();
        selected = { ...goal, status: 'running', startedAt };
        db.query("UPDATE seat_goals SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
          .run(startedAt, goal.id);
        break;
      }
      db.exec('COMMIT');
      if (!selected) return { outcome: all.some((goal) => goal.status === 'queued') ? 'waiting' : 'empty', reason };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
  // Keep the claim on an uncertain launch. Only a positive completion receipt can release it.
  await options.launch(selected);
  return { outcome: 'started', goal: selected, reason: 'launched' };
}
