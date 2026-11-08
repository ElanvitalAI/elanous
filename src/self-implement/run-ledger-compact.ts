import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { debug } from '../debug/log.js';
import { isRunStatus } from './run-status-mapping.js';
import { hasTerminalRunStatus, loadRunLedgerWithMetadata, type RunLedgerEntry } from './run-ledger.js';
import { runLedgerDir, runLedgerPath } from './run-ledger-paths.js';
import type { RunLedgerSummary } from './run-ledger-archive.js';
import { archiveDir, archivedPathMarker, finishPendingRestores, indexPath, markerPath, pendingRestoreConflicts, pendingRestores, readRunLedgerSummaries, restoreArchivedRunLedger, withIndexLock, withRunLedgerLock } from './run-ledger-archive.js';
export { OWNERLESS_LOCK_STALE_MS, readRunLedgerSummaries, restoreArchivedRunLedger, withRunLedgerLock } from './run-ledger-archive.js';
export type { RunLedgerSummary } from './run-ledger-archive.js';

export interface LedgerCompactionPlan {
  move: Array<{ runId: string; from: string; to: string; summary: RunLedgerSummary }>;
  keep: Array<{ runId: string; reason: 'unfinished' | 'too-recent' | 'unreadable' | 'restore-conflict' }>;
}
export interface LedgerCompactionResult {
  moved: number;
  kept: number;
  bytesBefore: number;
  bytesAfter: number;
  failures: Array<{ runId: string; error: string }>;
}

const plannedDigests = new WeakMap<LedgerCompactionPlan['move'][number], string>();
const plannedDirectories = new WeakMap<LedgerCompactionPlan, string>();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function archiveEquals(path: string, bytes: Buffer): boolean {
  try { return gunzipSync(readFileSync(path)).equals(bytes); }
  catch { return false; }
}

function recordedString(entries: readonly RunLedgerEntry[], field: string): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (typeof entry.data[field] === 'string' && entry.data[field]) return entry.data[field] as string;
  }
  return undefined;
}

export function summarizeTerminalLedger(runId: string, entries: readonly RunLedgerEntry[]): RunLedgerSummary {
  const last = entries.at(-1)?.timestamp;
  if (!last || !Number.isFinite(Date.parse(last)) || !hasTerminalRunStatus(entries)) throw new Error('ledger changed since plan');
  const terminator = [...entries].reverse().find((entry) => entry.event === 'human-stop' || entry.event === 'terminal'
    || (entry.event === 'run-status' && isRunStatus(entry.data.runStatus)));
  return {
    runId, status: terminator?.event === 'run-status' ? String(terminator.data.runStatus) : terminator?.event ?? 'terminal', endedAt: last,
    ...(recordedString(entries, 'goalFile') ? { goalFile: recordedString(entries, 'goalFile') } : {}),
    ...(recordedString(entries, 'branch') ? { branch: recordedString(entries, 'branch') } : {}),
    ...(recordedString(entries, 'prUrl') ?? recordedString(entries, 'url') ? { prUrl: recordedString(entries, 'prUrl') ?? recordedString(entries, 'url') } : {}),
    ...(recordedString(entries, 'machine') ?? recordedString(entries, 'hostname') ? { machine: recordedString(entries, 'machine') ?? recordedString(entries, 'hostname') } : {}),
    ...(recordedString(entries, 'substrate') ? { substrate: recordedString(entries, 'substrate') } : {}),
  };
}

export function planLedgerCompaction({ dir = runLedgerDir(), now = new Date(), minAgeHours = 24 }: {
  dir?: string; now?: Date; minAgeHours?: number;
} = {}): LedgerCompactionPlan {
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) throw new Error('minAgeHours must be non-negative and finite');
  if (!Number.isFinite(now.getTime())) throw new Error('invalid now');
  const conflicts = pendingRestoreConflicts(dir);
  const restoring = new Set(pendingRestores(dir));
  const plan: LedgerCompactionPlan = { move: [], keep: [] };
  plannedDirectories.set(plan, dir);
  let files: string[];
  try { files = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return plan;
    throw error;
  }
  for (const file of files.sort()) {
    if (!file.endsWith('.jsonl')) continue;
    const runId = basename(file, '.jsonl');
    try { runLedgerPath(runId, dir); } catch { continue; }
    if (conflicts.has(runId)) {
      debug.log('self-implement.run-ledger', 'restore-conflict', { runId });
      plan.keep.push({ runId, reason: 'restore-conflict' }); continue;
    }
    if (restoring.has(runId) && !existsSync(runLedgerPath(runId, dir))) continue;
    try {
      const ledger = loadRunLedgerWithMetadata(runId, dir);
      if (!ledger || ledger.skippedTrailingBytes || !ledger.entries.length) {
        plan.keep.push({ runId, reason: 'unreadable' }); continue;
      }
      if (!hasTerminalRunStatus(ledger.entries)) { plan.keep.push({ runId, reason: 'unfinished' }); continue; }
      const last = ledger.entries.at(-1)!.timestamp;
      const lastTime = last === undefined ? NaN : Date.parse(last);
      if (!Number.isFinite(lastTime)) { plan.keep.push({ runId, reason: 'unreadable' }); continue; }
      if (now.getTime() - lastTime < minAgeHours * 3_600_000) { plan.keep.push({ runId, reason: 'too-recent' }); continue; }
      const summary = summarizeTerminalLedger(runId, ledger.entries);
      if (restoring.has(runId)) { plan.keep.push({ runId, reason: 'too-recent' }); continue; }
      const item = { runId, from: runLedgerPath(runId, dir), to: join(archiveDir(dir), new Date(lastTime).toISOString().slice(0, 7), `${runId}.jsonl.gz`), summary };
      plannedDigests.set(item, digest(readFileSync(item.from)));
      plan.move.push(item);
    } catch { plan.keep.push({ runId, reason: 'unreadable' }); }
  }
  return plan;
}

export function applyLedgerCompaction(plan: LedgerCompactionPlan, options: {
  __testWriteGzip?: (path: string, bytes: Buffer) => void;
  __testWhileLocked?: (runId: string) => void;
  __testCrashAfterIndex?: boolean;
} = {}): LedgerCompactionResult {
  const result: LedgerCompactionResult = { moved: 0, kept: plan.keep.length, bytesBefore: 0, bytesAfter: 0, failures: [] };
  const directories = new Set([...(plannedDirectories.has(plan) ? [plannedDirectories.get(plan)!] : []), ...plan.move.map((item) => dirname(item.from))]);
  const restoreFailures = new Map<string, string>();
  for (const dir of directories) {
    for (const [runId, error] of finishPendingRestores(dir)) restoreFailures.set(`${dir}\0${runId}`, error);
  }
  const plannedKeys = new Set(plan.move.map((item) => `${dirname(item.from)}\0${item.runId}`));
  for (const [key, error] of restoreFailures) {
    // A planned run's restore conflict is reported once in the move loop below;
    // every other run's failure (conflicts included) is reported here so the CLI cannot exit clean.
    if (error.startsWith('restore-conflict:') && plannedKeys.has(key)) continue;
    const runId = key.slice(key.indexOf('\0') + 1);
    result.failures.push({ runId, error });
  }
  for (const item of plan.move) {
    const dir = dirname(item.from);
    if (restoreFailures.has(`${dir}\0${item.runId}`)) {
      const error = restoreFailures.get(`${dir}\0${item.runId}`)!;
      if (error.startsWith('restore-conflict:')) result.failures.push({ runId: item.runId, error });
      result.kept += 1;
      continue;
    }
    try {
      withRunLedgerLock(dir, item.runId, () => {
        options.__testWhileLocked?.(item.runId);
        if (item.from !== runLedgerPath(item.runId, dir)) throw new Error('invalid ledger source path');
        const endedAtMs = Date.parse(item.summary.endedAt);
        if (!Number.isFinite(endedAtMs)) throw new Error('invalid archive end time');
        const expectedTo = join(archiveDir(dir), new Date(endedAtMs).toISOString().slice(0, 7), `${item.runId}.jsonl.gz`);
        if (item.to !== expectedTo) throw new Error('invalid archive destination path');
        const original = readFileSync(item.from);
        const ledger = loadRunLedgerWithMetadata(item.runId, dir, () => original);
        if (!ledger || ledger.skippedTrailingBytes || !ledger.entries.length
          || JSON.stringify(summarizeTerminalLedger(item.runId, ledger.entries)) !== JSON.stringify(item.summary)
          || plannedDigests.get(item) !== digest(original)) throw new Error('ledger changed since plan');
        const sizeBefore = original.length;
        mkdirSync(dirname(item.to), { recursive: true });
        // A gzip left at the destination by a process that died after the rename but before the marker/index
        // was never published: the live ledger is authoritative. Remove it and write it again.
        if (existsSync(item.to) && !existsSync(markerPath(dir, item.runId))
          && !readRunLedgerSummaries(dir).some((row) => row.runId === item.runId)
          && !archiveEquals(item.to, original)) {
          unlinkSync(item.to);
          debug.log('self-implement.run-ledger', 'unpublished-archive-replaced', { runId: item.runId });
        }
        if (!existsSync(item.to)) {
          const compressed = gzipSync(original);
          const temp = `${item.to}.${process.pid}.${crypto.randomUUID()}.tmp`;
          try {
            (options.__testWriteGzip ?? ((path, bytes) => writeFileSync(path, bytes, { flag: 'wx' })))(temp, compressed);
            if (!gunzipSync(readFileSync(temp)).equals(original)) throw new Error('gzip round-trip differs');
            renameSync(temp, item.to);
          } finally { if (existsSync(temp)) unlinkSync(temp); }
        }
        if (!gunzipSync(readFileSync(item.to)).equals(original)) throw new Error('archive round-trip differs');
        writeFileSync(markerPath(dir, item.runId), item.to, { flag: 'wx' });
        const hint = archivedPathMarker(dir, item.runId);
        // Publish the archive location before unlinking the source; waiting writers find it after lock release.
        if (existsSync(hint)) {
          if (readFileSync(hint, 'utf8') !== item.to) throw new Error('archive hint conflicts with destination');
        } else writeFileSync(hint, item.to, { flag: 'wx' });
        withIndexLock(dir, () => {
          const summaries = readRunLedgerSummaries(dir);
          if (!summaries.some((row) => row.runId === item.runId)) {
            appendFileSync(indexPath(dir), `${JSON.stringify(item.summary)}\n`);
          }
        });
        if (options.__testCrashAfterIndex) throw new Error('test crash after index append');
        if (!gunzipSync(readFileSync(item.to)).equals(readFileSync(item.from))) throw new Error('source changed before removal');
        unlinkSync(item.from);
        unlinkSync(markerPath(dir, item.runId));
        // Count sizes only for a ledger that actually moved.
        result.bytesBefore += sizeBefore;
        result.bytesAfter += statSync(item.to).size;
        result.moved += 1;
      });
    } catch (error) {
      try {
        const marker = markerPath(dir, item.runId);
        if (existsSync(marker) && existsSync(item.from) && !existsSync(item.to)) {
          const hint = archivedPathMarker(dir, item.runId);
          if (existsSync(hint)) unlinkSync(hint);
          unlinkSync(marker);
        }
      } catch { /* retain the marker for the next recovery attempt */ }
      result.failures.push({ runId: item.runId, error: error instanceof Error ? error.message : String(error) });
      result.kept += 1;
    }
  }
  debug.log('self-implement.run-ledger', 'compacted', { moved: result.moved, kept: result.kept, bytesBefore: result.bytesBefore, bytesAfter: result.bytesAfter, failures: result.failures });
  return result;
}
