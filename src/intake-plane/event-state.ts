import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { getToxRuntimeDeps } from '../task-orchestrator/runtime-deps.js';
import type { TaskStore } from '../task-orchestrator/store.js';
import type { TaskStatus } from '../task-orchestrator/types.js';
import { canonicalUrl, intakeLedgerDir } from './core.js';

export type IntakeEventTaskProbe = (id: string) => TaskStatus | { status: TaskStatus; updatedAt?: number } | undefined;

export function eventTaskStatus(taskId: string): { status: TaskStatus; updatedAt?: number } | undefined {
  const deps = getToxRuntimeDeps();
  const graphTask = deps.getGraph()?.getTask(taskId) ?? (deps.getStore?.() as TaskStore | null | undefined)?.getTask(taskId);
  return graphTask ? { status: graphTask.status, updatedAt: graphTask.updatedAt } : undefined;
}

function probeStatus(probe: IntakeEventTaskProbe, id: string): { status?: TaskStatus; updatedAt?: number } {
  const value = probe(id);
  return typeof value === 'string' ? { status: value } : value ?? {};
}

export type EventClaim = { status: string; task_id: string | null; claimed_at: string | null; day: string };
const INTAKE_EVENT_LEASE_MS = 23 * 3600_000;
const INTAKE_EVENT_TASK_STALE_MS = 2 * 3600_000;

export function activeEventClaim(row: EventClaim, now: string, taskStatus: IntakeEventTaskProbe): boolean {
  if (row.status !== 'scheduled' && row.status !== 'pending') return false;
  const { status, updatedAt } = row.task_id ? probeStatus(taskStatus, row.task_id) : {};
  if (status === 'done') return true;
  if (status === 'failed' || status === 'cancelled' || status === 'superseded') return false;
  const claimedAt = Date.parse(row.claimed_at ?? `${row.day}T00:00:00.000+09:00`);
  const withinLease = Number.isFinite(claimedAt) && Date.parse(now) - claimedAt < INTAKE_EVENT_LEASE_MS;
  if (!status) return withinLease;
  if (updatedAt !== undefined && Number.isFinite(updatedAt)) return Date.parse(now) - updatedAt < INTAKE_EVENT_TASK_STALE_MS;
  return withinLease;
}

/** Only an active task or a fresh claim excludes a URL from the daily queue. */
export function wasIntakeEventScheduled(root: string, url: string, now = new Date().toISOString(), taskStatus: IntakeEventTaskProbe = eventTaskStatus): boolean {
  const file = join(intakeLedgerDir(root), 'events.sqlite');
  if (!existsSync(file)) return false;
  const normalized = canonicalUrl(url);
  if (!normalized) return false;
  const db = new Database(file);
  try {
    const row = db.query('SELECT status, task_id, claimed_at, day FROM intake_events WHERE url = ?').get(normalized) as EventClaim | null;
    if (!row || (row.status !== 'scheduled' && row.status !== 'pending')) return row?.status === 'completed';
    if (activeEventClaim(row, now, taskStatus)) {
      if (row.task_id && probeStatus(taskStatus, row.task_id).status === 'done') {
        db.query("UPDATE intake_events SET status = 'completed' WHERE url = ?").run(normalized);
      }
      return true;
    }
    const status = row.task_id ? probeStatus(taskStatus, row.task_id).status : undefined;
    db.query("UPDATE intake_events SET status = ? WHERE url = ? AND status IN ('pending', 'scheduled')")
      .run(status === 'failed' || status === 'cancelled' || status === 'superseded' ? 'failed' : 'expired', normalized);
    return false;
  } finally {
    db.close();
  }
}
