/** Durable, fail-closed evidence written only from an observed warm-worker lease. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { debug } from '../../debug/log.js';
import type { WarmReuseEvidence, WarmReuseEvidenceByConsumer, WarmReuseConsumer } from './pod-warm-switch.js';

const SHA = /^[0-9a-f]{40}$/i;
const LOCK_HASH = /^[0-9a-f]{64}$/i;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 256;
export const WARM_REUSE_EVIDENCE_MAX_AGE_MS = 60 * 60_000;

export interface WarmReuseEvidenceRow {
  schema: 1;
  consumer: WarmReuseEvidenceConsumer;
  pr?: number;
  head: string;
  main: string;
  recordedAt: string;
  /** Actual warm provider lease identity. Omitted on cold/fallback/timeout. */
  leaseId?: string;
  workerId?: string;
  generation?: number;
  expectedLockHash?: string;
  workerLockHash?: string;
  leaseValid?: boolean;
  canaryPassed?: boolean;
  agree?: boolean;
  reason?: string;
}

export type WarmReuseEvidenceConsumer = 'gate-recheck' | 'land' | 'ta';

export interface ActualWarmLeaseEvidence {
  workerId: string;
  leaseId: string;
  generation: number;
  expectedLockHash: string;
  workerLockHash: string;
  leaseValid: boolean;
  canaryPassed: boolean;
  agree: boolean;
}

export function warmReuseEvidencePath(root = effectiveInstanceRoot()): string {
  return join(root, 'warm-reuse-evidence.jsonl');
}

function validRow(value: unknown): value is WarmReuseEvidenceRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<WarmReuseEvidenceRow>;
  return row.schema === 1 && ['gate-recheck', 'land', 'ta'].includes(row.consumer ?? '')
    && (row.pr === undefined || typeof row.pr === 'number' && Number.isSafeInteger(row.pr) && row.pr > 0)
    && typeof row.head === 'string' && SHA.test(row.head) && typeof row.main === 'string' && SHA.test(row.main)
    && typeof row.recordedAt === 'string' && Number.isFinite(Date.parse(row.recordedAt))
    && (row.leaseId === undefined || typeof row.leaseId === 'string' && row.leaseId.length > 0)
    && (row.workerId === undefined || typeof row.workerId === 'string' && row.workerId.length > 0)
    && (row.generation === undefined || typeof row.generation === 'number' && Number.isSafeInteger(row.generation) && row.generation > 0)
    && (row.expectedLockHash === undefined || typeof row.expectedLockHash === 'string' && LOCK_HASH.test(row.expectedLockHash))
    && (row.workerLockHash === undefined || typeof row.workerLockHash === 'string' && LOCK_HASH.test(row.workerLockHash))
    && (row.leaseValid === undefined || typeof row.leaseValid === 'boolean')
    && (row.canaryPassed === undefined || typeof row.canaryPassed === 'boolean')
    && (row.agree === undefined || typeof row.agree === 'boolean')
    && (row.reason === undefined || typeof row.reason === 'string');
}

/** Append a bounded JSONL observation. A missing/invalid warm lease is recorded as unmeasured, never green. */
export function recordWarmReuseEvidence(path: string, row: WarmReuseEvidenceRow): void {
  if (!validRow(row)) throw new Error('invalid warm reuse evidence row');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmdirSync(lock); continue; } } catch { continue; }
      if (Date.now() >= deadline) throw new Error('timed out locking warm reuse evidence');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    let rows: string[] = [];
    try {
      const contents = readFileSync(path, 'utf8');
      if (Buffer.byteLength(contents) <= MAX_BYTES) rows = contents.split(/\r?\n/).filter(Boolean).slice(-(MAX_ROWS - 1));
    } catch { /* first write */ }
    const safe = typeof row.leaseValid === 'boolean' && row.leaseId && row.workerId && row.generation && row.expectedLockHash
      && row.workerLockHash && row.canaryPassed !== undefined && row.agree !== undefined
      ? row
      : { schema: 1 as const, consumer: row.consumer, ...(row.pr ? { pr: row.pr } : {}), head: row.head, main: row.main,
          recordedAt: row.recordedAt, reason: row.reason ?? 'warm-lease-unmeasured' };
    const body = [...rows, JSON.stringify(safe)].join('\n') + '\n';
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(tempPath, body, { mode: 0o600, flag: 'wx' }); renameSync(tempPath, path); }
    catch (error) { rmSync(tempPath, { force: true }); throw error; }
  } finally { try { rmdirSync(lock); } catch { /* best-effort release */ } }
}

/** Read only exact head/main rows. Invalid, oversized, or absent files produce no evidence. */
export function readWarmReuseEvidence(path: string, identity: { consumer: WarmReuseEvidenceConsumer; pr?: number; head: string; main: string }, limit = 32, now = Date.now()): WarmReuseEvidenceRow[] | undefined {
  if (!['gate-recheck', 'land', 'ta'].includes(identity.consumer) || (identity.pr !== undefined && (!Number.isSafeInteger(identity.pr) || identity.pr <= 0)) || !SHA.test(identity.head) || !SHA.test(identity.main)
    || !Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(now)) return undefined;
  try {
    if (!existsSync(path)) return undefined;
    const contents = readFileSync(path, 'utf8');
    if (Buffer.byteLength(contents) > MAX_BYTES) return undefined;
    const lines = contents.split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_ROWS) return undefined;
    const rows: WarmReuseEvidenceRow[] = [];
    for (const line of lines) {
      let row: unknown;
      try { row = JSON.parse(line); } catch { return undefined; }
      if (!validRow(row)) return undefined;
      if (row.consumer === identity.consumer && (identity.pr === undefined || row.pr === identity.pr)
        && row.head === identity.head && row.main === identity.main) {
        const recordedAt = Date.parse(row.recordedAt);
        if (recordedAt > now) return undefined;
        if (now - recordedAt <= WARM_REUSE_EVIDENCE_MAX_AGE_MS) rows.push(row);
      }
    }
    rows.splice(0, Math.max(0, rows.length - limit));
    return rows.length ? rows : undefined;
  } catch { return undefined; }
}

/** Read exact source-pair evidence for each consumer and summarize only observed rows. */
export function loadWarmReuseEvidenceByConsumer(
  identity: { head: string; main: string } | undefined, path = warmReuseEvidencePath(),
): WarmReuseEvidenceByConsumer | undefined {
  const result: WarmReuseEvidenceByConsumer = {};
  const consumers: readonly WarmReuseEvidenceConsumer[] = ['gate-recheck', 'land', 'ta'];
  const exactIdentity = identity && SHA.test(identity.head) && SHA.test(identity.main) ? identity : undefined;
  for (const consumer of consumers) {
    const rows = exactIdentity ? readWarmReuseEvidence(path, { consumer, ...exactIdentity }) : undefined;
    const latest = rows?.[rows.length - 1];
    if (!rows?.length || !latest) {
      try { debug.log('pod.warm', 'evidence-supplied', { consumer, measured: false }); } catch { /* observation only */ }
      continue;
    }
    const lock = latest.expectedLockHash ?? '';
    let consecutiveMatchSamples = 0;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]!;
      const identityComplete = !!row.leaseId && !!row.workerId && Number.isSafeInteger(row.generation)
        && !!row.expectedLockHash && !!row.workerLockHash;
      if (!identityComplete || row.workerId !== latest.workerId || row.expectedLockHash !== lock || row.workerLockHash !== lock
        || row.leaseValid !== true || row.canaryPassed !== true || row.agree !== true) break;
      consecutiveMatchSamples++;
    }
    const evidence: WarmReuseEvidence = {
      consecutiveMatchSamples,
      recentMismatchCount: rows.filter((row) => row.agree === false).length,
      ...(typeof latest.leaseValid === 'boolean'
        ? { leaseValid: latest.leaseValid && !!latest.leaseId && !!latest.workerId && Number.isSafeInteger(latest.generation) }
        : {}),
      ...(typeof latest.canaryPassed === 'boolean' ? { canaryPassed: latest.canaryPassed } : {}),
      expected: { head: exactIdentity!.head, main: exactIdentity!.main, lock },
      worker: { head: exactIdentity!.head, main: exactIdentity!.main, lock: latest.workerLockHash ?? '' },
    };
    result[consumer as WarmReuseConsumer] = evidence;
    const measured = typeof latest.leaseValid === 'boolean' && !!latest.leaseId && !!latest.workerId
      && Number.isSafeInteger(latest.generation) && typeof latest.canaryPassed === 'boolean'
      && !!latest.expectedLockHash && !!latest.workerLockHash && typeof latest.agree === 'boolean';
    try { debug.log('pod.warm', 'evidence-supplied', { consumer, measured }); } catch { /* observation only */ }
  }
  return Object.keys(result).length ? result : undefined;
}
