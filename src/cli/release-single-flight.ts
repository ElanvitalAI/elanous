import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { graphRunAlive, type GraphRunState } from '../graph-runner/runner.js';
import { psProcessStartMs, START_TOLERANCE_MS } from '../harness/harness-stop.js';

export interface ActiveReleaseRun {
  runId: string;
  pid: number;
  startedAt: string;
}

export class ReleaseRunClaimConflict extends Error {
  readonly code = 'EEXIST';
  constructor() { super('release run claim already exists'); }
}

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

/** The saved graph run is the authority for an active release, not a process-name match. */
export function findActiveReleaseRun(version: string, ledgerRoot: string): ActiveReleaseRun | undefined {
  const dir = join(ledgerRoot, 'graph-runs', 'release-loop');
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const runs: ActiveReleaseRun[] = [];
  for (const name of names) {
    try {
      const state = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        graphId?: unknown; runId?: unknown; status?: unknown; pid?: unknown; pidStartedAt?: unknown; startedAt?: unknown;
        input?: { version?: unknown };
      };
      if (state.graphId !== 'release-loop' || state.status !== 'running' || state.input?.version !== version
        || typeof state.runId !== 'string' || typeof state.startedAt !== 'string'
        || typeof state.pid !== 'number' || !Number.isSafeInteger(state.pid) || state.pid <= 0
        || graphRunAlive(state as GraphRunState) !== true) continue;
      runs.push({ runId: state.runId, pid: state.pid, startedAt: state.startedAt });
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function readReleaseRunLock(version: string, ledgerRoot: string): { pid?: number; startedAt?: string; pidStartedAt?: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(ledgerRoot, 'release', version, 'run.lock'), 'utf8')) as { pid?: unknown; startedAt?: unknown; pidStartedAt?: unknown };
    return { pid: typeof value.pid === 'number' ? value.pid : undefined,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : undefined,
      pidStartedAt: typeof value.pidStartedAt === 'string' ? value.pidStartedAt : undefined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/** A live PID belongs to this lock only if its process birth still matches. */
export function releaseRunLockOwnerAlive(version: string, ledgerRoot: string, pid: number): boolean {
  const owner = readReleaseRunLock(version, ledgerRoot);
  if (!owner || owner.pid !== pid || !isPidAlive(pid)) return false;
  const actual = psProcessStartMs(pid);
  // A failed birth probe must not let a second launch reclaim a live PID's lock.
  if (actual === null) return true;
  const recorded = Date.parse(owner.pidStartedAt ?? '');
  if (Number.isFinite(recorded)) return Math.abs(actual - recorded) <= START_TOLERANCE_MS;
  // Older locks have only their claim time. A process born after that claim reused the PID.
  const claimedAt = Date.parse(owner.startedAt ?? '');
  return Number.isFinite(claimedAt) && actual <= claimedAt + START_TOLERANCE_MS;
}

function claimDb(ledgerRoot: string): Database {
  mkdirSync(join(ledgerRoot, 'release'), { recursive: true });
  const db = new Database(join(ledgerRoot, 'release', 'run-lock-claim.sqlite'), { create: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS force_starts (token TEXT PRIMARY KEY, version TEXT NOT NULL, pid INTEGER NOT NULL, pid_started_at TEXT NOT NULL, started_at TEXT NOT NULL)');
  return db;
}

type ForceStart = { token: string; version: string; pid: number; pid_started_at: string; started_at: string };
function forceStartAlive(row: ForceStart): boolean {
  if (!isPidAlive(row.pid)) return false;
  const actual = psProcessStartMs(row.pid);
  return actual === null || Math.abs(actual - Date.parse(row.pid_started_at)) <= START_TOLERANCE_MS;
}

function liveForceStart(db: Database, version: string): ForceStart | undefined {
  const rows = db.query('SELECT token, version, pid, pid_started_at, started_at FROM force_starts WHERE version = ?').all(version) as ForceStart[];
  for (const row of rows) {
    if (forceStartAlive(row)) return row;
    db.query('DELETE FROM force_starts WHERE token = ?').run(row.token);
  }
  return undefined;
}

export function readActiveForceReleaseRun(version: string, ledgerRoot: string): ActiveReleaseRun | undefined {
  const db = claimDb(ledgerRoot);
  try {
    const row = liveForceStart(db, version);
    return row && { runId: 'pending', pid: row.pid, startedAt: row.started_at };
  } finally { db.close(); }
}

/** Force runs bypass refusal but publish a claim before launching so later normal runs refuse. */
export async function withForceReleaseRunMarker<T>(version: string, ledgerRoot: string, run: () => Promise<T>): Promise<T> {
  const db = claimDb(ledgerRoot);
  const token = randomUUID();
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const pidStartedAt = psProcessStartMs(process.pid) ?? Date.now() - process.uptime() * 1000;
      db.query('INSERT INTO force_starts (token, version, pid, pid_started_at, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(token, version, process.pid, new Date(pidStartedAt).toISOString(), new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return await run();
  } finally {
    db.query('DELETE FROM force_starts WHERE token = ?').run(token);
    db.close();
  }
}

/**
 * Atomic claim closes the gap before the graph's first saved state. SQLite serializes
 * stale-lock reclamation among direct entrants; a scheduled entrant only uses O_EXCL,
 * so it either wins after removal or sees the direct entrant's new file.
 */
export async function withDirectReleaseRunLock<T>(version: string, ledgerRoot: string, run: () => Promise<T>,
  owner: { pid?: number; now?: () => Date } = {}): Promise<T> {
  const dir = join(ledgerRoot, 'release', version);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'run.lock');
  const db = claimDb(ledgerRoot);
  const token = randomUUID();
  let fd: number | undefined;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (liveForceStart(db, version)) {
        throw new ReleaseRunClaimConflict();
      }
      const existing = readReleaseRunLock(version, ledgerRoot);
      if (existing?.pid && !releaseRunLockOwnerAlive(version, ledgerRoot, existing.pid)) rmSync(lock, { force: true });
      fd = openSync(lock, 'wx', 0o600);
      const pid = owner.pid ?? process.pid;
      const pidStartedAt = psProcessStartMs(pid) ?? Date.now() - process.uptime() * 1000;
      writeFileSync(fd, `${JSON.stringify({ pid, pidStartedAt: new Date(pidStartedAt).toISOString(), startedAt: (owner.now ?? (() => new Date()))().toISOString(), token })}\n`);
      db.exec('COMMIT');
    } catch (error) {
      if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); fd = undefined; }
      db.exec('ROLLBACK');
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ReleaseRunClaimConflict();
      throw error;
    }
  } finally { db.close(); }
  try { return await run(); }
  finally {
    if (fd !== undefined) closeSync(fd);
    try {
      const current = JSON.parse(readFileSync(lock, 'utf8')) as { token?: unknown };
      if (current.token === token) rmSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
