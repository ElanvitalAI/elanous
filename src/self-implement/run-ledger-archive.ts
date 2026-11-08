import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { debug } from '../debug/log.js';
import { runLedgerDir, runLedgerPath } from './run-ledger-paths.js';

export interface RunLedgerSummary {
  runId: string;
  status: string;
  endedAt: string;
  goalFile?: string;
  branch?: string;
  prUrl?: string;
  machine?: string;
  substrate?: string;
}

export const archiveDir = (dir: string) => join(dir, 'archive');
export const indexPath = (dir: string) => join(archiveDir(dir), 'index.jsonl');
export const markerPath = (dir: string, runId: string) => join(archiveDir(dir), `.restoring-${runId}`);
export const archivedPathMarker = (dir: string, runId: string) => join(archiveDir(dir), `.archived-${runId}`);
const pause = new Int32Array(new SharedArrayBuffer(4));
function reclaimDeadLock(path: string, pidText: string): void {
  const reap = `${path}.reaping`;
  try { mkdirSync(reap); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') { clearStaleReaping(reap, Date.now()); return; }
    throw error;
  }
  try {
    // Only one waiter may inspect and remove a dead owner. Check the directory
    // identity as well as its pid: another waiter may already have reclaimed it.
    const identity = statSync(path);
    if (readFileSync(join(path, 'pid'), 'utf8').trim() !== pidText) return;
    const pid = Number(pidText);
    try { process.kill(pid, 0); return; }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    const current = statSync(path);
    if (current.dev !== identity.dev || current.ino !== identity.ino
      || readFileSync(join(path, 'pid'), 'utf8').trim() !== pidText) return;
    unlinkSync(join(path, 'pid'));
    rmdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    rmdirSync(reap);
  }
}

/** A lock (or reaping mutex) with no pid for this long was left by a process that died between mkdir and
 *  the pid write, or between the pid unlink and rmdir. Acquisition itself takes milliseconds. */
export const OWNERLESS_LOCK_STALE_MS = 60_000;

/** Remove a reaping mutex that a crashed reaper left behind. */
function clearStaleReaping(reap: string, now: number): void {
  try { if (now - statSync(reap).mtimeMs > OWNERLESS_LOCK_STALE_MS) rmdirSync(reap); } catch { /* raced or gone */ }
}

function reclaimOwnerlessLock(path: string, now: number): boolean {
  const reap = `${path}.reaping`;
  try { mkdirSync(reap); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A reaping mutex left by a crashed reaper would block every later reclaim.
    clearStaleReaping(reap, now);
    return false;
  }
  try {
    const current = statSync(path);
    if (existsSync(join(path, 'pid')) || now - current.mtimeMs <= OWNERLESS_LOCK_STALE_MS) return false;
    rmdirSync(path);
    debug.log('self-implement.run-ledger', 'ownerless-lock-reclaimed', { lock: path.split('/').pop() });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    rmdirSync(reap);
  }
}

/** A directory lock is shared by the writer, compactor and restore path. An ownerless lock is still being
 *  acquired — unless it has stayed ownerless past OWNERLESS_LOCK_STALE_MS. */
function withDirectoryLock<T>(path: string, action: () => T): T {
  const deadline = Date.now() + 30_000;
  for (;;) {
    let acquired = false;
    try { mkdirSync(path); acquired = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (acquired) {
      try {
        writeFileSync(join(path, 'pid'), String(process.pid), { flag: 'wx' });
        return action();
      } finally {
        if (existsSync(join(path, 'pid'))) unlinkSync(join(path, 'pid'));
        rmdirSync(path);
      }
    }
    try {
      const pidText = readFileSync(join(path, 'pid'), 'utf8').trim();
      const pid = Number(pidText);
      if (/^[1-9]\d*$/.test(pidText) && Number.isSafeInteger(pid)) {
        try { process.kill(pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            reclaimDeadLock(path, pidText);
            continue;
          }
        }
      }
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
      if (reclaimOwnerlessLock(path, Date.now())) continue;
    }
    if (Date.now() >= deadline) throw new Error(`run ledger lock timed out: ${path}`);
    Atomics.wait(pause, 0, 0, 20);
  }
}

export function withRunLedgerLock<T>(dir: string, runId: string, action: () => T): T {
  runLedgerPath(runId, dir);
  mkdirSync(dir, { recursive: true });
  return withDirectoryLock(join(dir, `.${runId}.lock`), action);
}

export function withIndexLock<T>(dir: string, action: () => T): T {
  mkdirSync(archiveDir(dir), { recursive: true });
  return withDirectoryLock(join(archiveDir(dir), '.index.lock'), action);
}

export function readRunLedgerSummaries(dir = runLedgerDir()): RunLedgerSummary[] {
  let text: string;
  try { text = readFileSync(indexPath(dir), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunLedgerSummary);
}

function replaceIndex(dir: string, summaries: readonly RunLedgerSummary[]): void {
  const path = indexPath(dir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, summaries.map((summary) => JSON.stringify(summary) + '\n').join(''), { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Returns true when the pending entry was included in the restored live file. Caller holds the run lock. */
export function restoreArchivedRunLedger(
  dir: string, runId: string, pendingLine?: string,
  options: { __testCrashAfter?: 'live-written' | 'index-replaced' } = {},
): boolean {
  const marker = markerPath(dir, runId);
  const live = runLedgerPath(runId, dir);
  const archived = archivedPathMarker(dir, runId);
  // The marker check is the only additional probe for live runs; a missing
  // live file checks the per-run archive hint rather than reading the index.
  const marked = existsSync(marker);
  if (!marked && existsSync(live)) return false;
  if (!marked && !existsSync(archived)) return false;
  const to = readFileSync(marked ? marker : archived, 'utf8');
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(basename(dirname(to)))
    || to !== join(archiveDir(dir), basename(dirname(to)), `${runId}.jsonl.gz`)) {
    throw new Error(`invalid restore archive path: ${runId}`);
  }
  if (marked && existsSync(live) && !existsSync(to)) {
    // A previous restore removed gzip only after it had published the live file.
    withIndexLock(dir, () => {
      const rows = readRunLedgerSummaries(dir);
      if (rows.some((row) => row.runId === runId)) replaceIndex(dir, rows.filter((row) => row.runId !== runId));
    });
    if (existsSync(archived)) unlinkSync(archived);
    unlinkSync(marker);
    return false;
  }
  if (!marked) writeFileSync(marker, to, { flag: 'wx' });
  if (existsSync(to)) {
    const original = gunzipSync(readFileSync(to));
    if (existsSync(live)) {
      const current = readFileSync(live);
      if (!current.subarray(0, original.length).equals(original)) {
        debug.log('self-implement.run-ledger', 'restore-conflict', { runId });
        throw new Error(`restore-conflict: ${runId}`);
      }
      if (pendingLine) appendFileSync(live, pendingLine);
    } else {
      const temp = `${live}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, pendingLine ? Buffer.concat([original, Buffer.from(pendingLine)]) : original, { flag: 'wx' });
        renameSync(temp, live);
      } finally { if (existsSync(temp)) unlinkSync(temp); }
    }
    if (options.__testCrashAfter === 'live-written') throw new Error('test crash after live-written');
  } else if (!existsSync(live)) {
    throw new Error(`missing archived and live run ledger: ${runId}`);
  } else if (pendingLine) {
    appendFileSync(live, pendingLine);
  }
  withIndexLock(dir, () => {
    const rows = readRunLedgerSummaries(dir);
    if (rows.some((row) => row.runId === runId)) replaceIndex(dir, rows.filter((row) => row.runId !== runId));
  });
  if (options.__testCrashAfter === 'index-replaced') throw new Error('test crash after index-replaced');
  if (existsSync(to)) unlinkSync(to);
  if (existsSync(archived)) unlinkSync(archived);
  unlinkSync(marker);
  return Boolean(pendingLine);
}

export function pendingRestores(dir: string): string[] {
  let files: string[];
  try { files = readdirSync(archiveDir(dir)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return files.filter((file) => file.startsWith('.restoring-'))
    .map((file) => file.slice('.restoring-'.length))
    .filter((runId) => { try { runLedgerPath(runId, dir); return true; } catch { return false; } });
}

export function pendingRestoreConflicts(dir: string): Set<string> {
  const conflicts = new Set<string>();
  for (const runId of pendingRestores(dir)) {
    try {
      const to = readFileSync(markerPath(dir, runId), 'utf8');
      if (!existsSync(to)) continue;
      const original = gunzipSync(readFileSync(to));
      const live = runLedgerPath(runId, dir);
      if (existsSync(live) && !readFileSync(live).subarray(0, original.length).equals(original)) conflicts.add(runId);
    } catch {
      conflicts.add(runId);
    }
  }
  return conflicts;
}

export function finishPendingRestores(dir: string): Map<string, string> {
  const failures = new Map<string, string>();
  for (const runId of pendingRestores(dir)) {
    try { withRunLedgerLock(dir, runId, () => restoreArchivedRunLedger(dir, runId)); }
    catch (error) {
      failures.set(runId, error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}
