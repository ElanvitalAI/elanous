import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import * as registry from './registry.js';
import { cronMatches } from '../domains/cron-match.js';
import { resolveTimeZone } from '../time/format.js';
import type { LoopEntry, LoopRun } from './registry.js';

type LoopState = 'off' | 'unregistered' | 'failing' | 'late' | 'unknown' | 'alive';
export type LoopScope = 'graph-only' | 'registry';
export interface CheckEntry {
  id: string;
  owner?: string;
  ownerSource?: 'header' | 'config' | 'seat' | 'seat-arg' | 'default';
  evidence?: 'log-mtime' | 'registry';
  mode?: string;
  expectEveryMinutes?: number;
  /** The scheduled fire before the latest one (cron loops). A run older than this missed two scheduled fires. */
  dueAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  recentStatuses?: string[];
  enabled: boolean;
  registered: boolean;
}
export interface CheckResult extends CheckEntry {
  state: LoopState;
  reason: string;
}
export const LOOP_STATES = ['alive', 'late', 'failing', 'off', 'unregistered', 'unknown'] as const;
export type LoopCounts = Record<LoopState, number>;

export function checkLoops(entries: CheckEntry[], now: Date, opts: { failureStatuses?: readonly string[] } = {}): CheckResult[] {
  const failures = opts.failureStatuses ?? ['failed'];
  return entries.map(entry => {
    let state: LoopState;
    let reason: string;
    const age = entry.lastRunAt ? now.getTime() - Date.parse(entry.lastRunAt) : NaN;
    if (!entry.enabled) { state = 'off'; reason = 'disabled'; }
    else if (!entry.registered) { state = 'unregistered'; reason = 'not registered'; }
    else if (entry.recentStatuses?.length && entry.recentStatuses.length >= 3
      && entry.recentStatuses.slice(0, 3).every(status => failures.includes(status))) {
      state = 'failing'; reason = 'last 3 runs failed';
    } else if (Number.isFinite(age) && entry.dueAt && Number.isFinite(Date.parse(entry.dueAt))) {
      // Judge against the real schedule, not a fixed interval: overnight or weekend gaps are not lateness.
      if (Date.parse(entry.lastRunAt!) < Date.parse(entry.dueAt)) { state = 'late'; reason = `missed the scheduled runs since ${entry.dueAt}`; }
      else { state = 'alive'; reason = 'ran at or after the previous scheduled fire'; }
    } else if (Number.isFinite(age) && entry.expectEveryMinutes !== undefined
      && entry.expectEveryMinutes > 0 && age > entry.expectEveryMinutes * 2 * 60_000) {
      state = 'late'; reason = `last run exceeds twice the expected ${entry.expectEveryMinutes}m interval`;
    } else if (!entry.lastRunAt || !Number.isFinite(age)) { state = 'unknown'; reason = 'no valid run recorded'; }
    else if (entry.expectEveryMinutes === undefined || !Number.isFinite(entry.expectEveryMinutes) || entry.expectEveryMinutes <= 0) {
      state = 'unknown'; reason = 'expected interval unknown';
    } else { state = 'alive'; reason = 'within expected interval'; }
    return { ...entry, state, reason };
  });
}

export function countLoopStates(results: CheckResult[]): LoopCounts {
  const counts: LoopCounts = { alive: 0, late: 0, failing: 0, off: 0, unregistered: 0, unknown: 0 };
  for (const result of results) counts[result.state]++;
  return counts;
}

/** Latest cron fire at or before `at` (minute resolution, scans back up to one year). */
export function previousLoopFire(cron: string, at: Date, timeZone: string = resolveTimeZone().timeZone): string | null {
  if (cron.trim().split(/\s+/).length !== 5) return null;
  let minute = Math.floor(at.getTime() / 60000) * 60000;
  for (let i = 0; i < 527040; i++, minute -= 60000) {
    if (cronMatches(cron, new Date(minute), { timeZone })) return new Date(minute).toISOString();
  }
  return null;
}

/** The fire before the latest scheduled fire — a run older than this has missed two scheduled fires. */
export function dueBefore(cron: string, now: Date, timeZone?: string): string | null {
  const latest = previousLoopFire(cron, now, timeZone);
  return latest ? previousLoopFire(cron, new Date(Date.parse(latest) - 60000), timeZone) : null;
}

export interface RegistryAdapterDeps {
  listLoops?: () => LoopEntry[];
  listAllLoops?: () => CheckEntry[];
  statusForLoop?: (id: string) => { recentRuns: Pick<LoopRun, 'status'>[] };
  now?: Date;
  timeZone?: string;
}

export function entriesFromRegistry(deps: RegistryAdapterDeps = {}): { entries: CheckEntry[]; scope: LoopScope } {
  // An explicitly injected graph inventory remains the checker test/adapter fallback.
  const all = deps.listAllLoops ?? (deps.listLoops ? undefined : registry.listAllLoops);
  if (typeof all === 'function') return { entries: all(), scope: 'registry' };
  const now = deps.now ?? new Date();
  return { scope: 'graph-only', entries: (deps.listLoops ?? registry.listLoops)().map(loop => {
    const first = loop.trigger.cron ? registry.nextLoopFire(loop.trigger.cron, now) : null;
    const second = first && loop.trigger.cron ? registry.nextLoopFire(loop.trigger.cron, new Date(first)) : null;
    const interval = first && second ? (Date.parse(second) - Date.parse(first)) / 60_000 : undefined;
    const statuses = loop.lastRun
      ? deps.statusForLoop ? deps.statusForLoop(loop.id).recentRuns.map(run => run.status)
        : deps.listLoops ? [loop.lastRun.status]
          : registry.loopStatus(loop.id).recentRuns.map(run => run.status)
      : [];
    const dueAt = loop.trigger.cron ? dueBefore(loop.trigger.cron, now, deps.timeZone) : null;
    return { id: loop.id, owner: loop.owner ?? undefined, ownerSource: loop.ownerSource, enabled: loop.enabled, registered: true,
      ...(interval !== undefined ? { expectEveryMinutes: interval } : {}),
      ...(dueAt ? { dueAt } : {}),
      ...(loop.lastRun ? { lastRunAt: loop.lastRun.at, lastStatus: loop.lastRun.status } : {}),
      recentStatuses: statuses };
  }) };
}

export interface CheckerDeps {
  root?: string;
  now?: Date;
}

/** Appends only new daily keys to the seat request journal; never rewrites existing lines. */
export function notifyOwners(results: CheckResult[], deps: CheckerDeps = {}): number {
  const eligible = results.filter(result => result.owner && (result.state === 'late' || result.state === 'failing'));
  if (!eligible.length) return 0;
  const now = deps.now ?? new Date();
  const path = join(deps.root ?? effectiveInstanceRoot(), 'seat-requests', 'requests.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  // SQLite's OS locks are released when a process dies, including after SIGKILL.
  // The journal itself remains append-only; this database only serializes check + append.
  const lock = new Database(`${path}.loop-checker.lock.sqlite`);
  try {
    lock.exec('PRAGMA busy_timeout = 10000');
    lock.exec('BEGIN EXCLUSIVE');
    try {
      const existing = new Set<string>();
      if (existsSync(path)) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (line.trim()) {
            const row = JSON.parse(line) as { key?: string };
            if (row.key) existing.add(row.key);
          }
        }
      }
      let added = 0;
      for (const result of eligible) {
        const key = `loopcheck:${result.id}:${now.toISOString().slice(0, 10)}:${result.state}`;
        if (existing.has(key)) continue;
        const row = { key, receiptId: key, seat: result.owner, text: `${result.id} ${result.state} — 마지막 ${result.lastRunAt ?? '없음'} · ${result.reason}`,
          status: 'queued', queuedAt: now.toISOString(), source: 'loop-checker' };
        appendFileSync(path, JSON.stringify(row) + '\n');
        existing.add(key);
        added++;
      }
      lock.exec('COMMIT');
      return added;
    } catch (error) {
      lock.exec('ROLLBACK');
      throw error;
    }
  } finally { lock.close(); }
}

/** Persist the previous comparison only for explicit all-status checks. Notification is separate. */
export function observeLoopCheck(results: CheckResult[], scope: LoopScope, deps: CheckerDeps = {}): LoopCounts {
  const path = join(deps.root ?? effectiveInstanceRoot(), 'loop', 'checker', 'last.json');
  let previous: Record<string, LoopState> = {};
  try { previous = JSON.parse(readFileSync(path, 'utf8')) as Record<string, LoopState>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const current: Record<string, LoopState> = {};
  for (const { id, state } of results) {
    current[id] = state;
    if (previous[id] && previous[id] !== state) debug.log('loop.checker', 'state-change', { id, from: previous[id], to: state });
  }
  const counts = countLoopStates(results);
  debug.log('loop.checker', 'checked', { counts, scope });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(current)); renameSync(tmp, path); }
  catch (error) { if (existsSync(tmp)) unlinkSync(tmp); throw error; }
  return counts;
}
