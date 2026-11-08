// One append-only observation per gate shard transition. The live board is a projection, not evidence for reuse.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';

export interface GateShardLedgerRow {
  v: 1;
  /** Invocation identity used to prevent shard summaries from mixing repeated same-head gates. */
  invocationId?: string;
  version: string;
  phase: 'cut' | 'baseline';
  shardId: string;
  files: string[];
  host: string | null;
  executor: 'pod' | 'host';
  imageDigest: string | null;
  /** Image observed on the execution that produced this shard receipt. */
  measuredImageDigest?: string | null;
  /** Image digest expected by the current gate invocation. */
  currentImageDigest?: string | null;
  commit: string;
  envFingerprint: string;
  startedAt: string | null;
  endedAt: string | null;
  observedAt: string;
  state: 'pending' | 'running' | 'done' | 'retry' | 'timeout' | 'failed';
  rc: number | null;
  pass: number | null;
  fail: number | null;
  errors: number | null;
  ran: number | null;
  failureIds: string[] | null;
  errorIds: string[] | null;
  attribution: 'complete' | 'unmeasured';
  logPath: string | null;
  junitPath: string | null;
  stopReason: string | null;
  attemptId: string | null;
  reuseDecision?: 'reuse' | 'rerun' | 'candidate';
  reuseReason?: string;
  /** Shared identity for the completed remote shard result batch. */
  batchId?: string;
  /** Number of shard rows expected in this completed batch. */
  batchSize?: number;
  /** Files whose first attempt was not measured and therefore must be covered by a successful retry row. */
  unmeasuredFiles?: string[];
  /** Shared identity of the parent attempt and the retry rows that recover it. */
  retryGroupId?: string;
}

export interface GateShardLedgerBatchExpectation {
  batchId: string;
  version: string;
  commit: string;
  phase: 'cut' | 'baseline';
  observedAt: string;
  shardIds: readonly string[];
}

function retryRecoverableUnmeasuredRow(row: GateShardLedgerRow): boolean {
  return row.attribution === 'unmeasured' && !!row.retryGroupId && !!row.unmeasuredFiles?.length
    && new Set(row.unmeasuredFiles).size === row.unmeasuredFiles.length
    && row.unmeasuredFiles.every((file) => row.files.includes(file))
    && row.rc === 0 && row.pass !== null && row.fail === 0 && row.errors === 0 && row.ran !== null && row.ran >= row.pass
    && row.failureIds === null && row.errorIds === null;
}

/** Validate the persisted batch marker and the exact shard set expected by this gate invocation. */
export function gateShardLedgerBatchComplete(rows: readonly GateShardLedgerRow[], expected: GateShardLedgerBatchExpectation): boolean {
  if (!expected.shardIds.length || new Set(expected.shardIds).size !== expected.shardIds.length) return false;
  const batch = rows.filter((row) => row.batchId === expected.batchId);
  if (batch.length !== expected.shardIds.length || new Set(batch.map((row) => row.shardId)).size !== batch.length
    || !batch.every((row) => row.version === expected.version && row.commit === expected.commit && row.phase === expected.phase
      && row.observedAt === expected.observedAt && row.batchSize === expected.shardIds.length && row.state === 'done')
    || expected.shardIds.some((id) => !batch.some((row) => row.shardId === id))) return false;

  for (const parent of batch) {
    if (parent.attribution !== 'complete' && !retryRecoverableUnmeasuredRow(parent)) return false;
    const missing = parent.unmeasuredFiles ?? [];
    const parentStart = parent.startedAt ? Date.parse(parent.startedAt) : NaN;
    const parentEnd = parent.endedAt ? Date.parse(parent.endedAt) : NaN;
    const retryIds = parent.retryGroupId ? [...new Set(rows.map((row) => row.shardId).filter((shardId) =>
      shardId.startsWith(`${parent.shardId}-n`) && /^\d*$/.test(shardId.slice(parent.shardId.length + 2))))] : [];
    if (parent.attribution !== 'complete' && (!Number.isFinite(parentStart) || !Number.isFinite(parentEnd) || !retryIds.length)) return false;
    if (retryIds.length && (!Number.isFinite(parentStart) || !Number.isFinite(parentEnd) || parent.retryGroupId !== parent.attemptId)) return false;
    const covered = new Set(parent.files.filter((file) => !missing.includes(file)));
    const attempts = new Set<string>();
    for (const retryId of retryIds) {
      const groupHistory = rows.filter((row) => row.phase === parent.phase && row.shardId === retryId && row.retryGroupId === parent.retryGroupId);
      if (!groupHistory.length || groupHistory.some((row) => {
        const startedAt = row.startedAt === null ? null : row.startedAt ? Date.parse(row.startedAt) : NaN;
        const endedAt = row.endedAt === null ? null : row.endedAt ? Date.parse(row.endedAt) : NaN;
        if (startedAt === null ? row.state !== 'pending' : !Number.isFinite(startedAt) || startedAt < parentStart || startedAt > parentEnd) return true;
        if (endedAt === null) return row.state !== 'pending' && row.state !== 'running';
        return !Number.isFinite(endedAt) || startedAt === null || endedAt < startedAt || endedAt > parentEnd || endedAt < parentStart;
      })) return false;
      const history = groupHistory.filter((row) => row.version === parent.version && row.commit === parent.commit
        && row.envFingerprint === parent.envFingerprint && row.executor === parent.executor && row.imageDigest === parent.imageDigest
        && row.measuredImageDigest === parent.measuredImageDigest && row.currentImageDigest === parent.currentImageDigest);
      if (history.length !== groupHistory.length) return false;
      const attemptIds = new Set(history.map((row) => row.attemptId).filter((id): id is string => !!id));
      const completed = history.filter((row) => row.state === 'done' && row.attribution === 'complete');
      const retry = history.at(-1);
      if (attemptIds.size !== 1 || completed.length !== 1 || !retry || retry !== completed[0]
        || retry.state !== 'done' || retry.attribution !== 'complete'
        || retry.rc !== 0 || retry.fail !== 0 || retry.errors !== 0 || retry.pass === null || retry.ran === null || retry.ran < retry.pass
        || !retry.attemptId || attempts.has(retry.attemptId) || (parent.attemptId !== null && retry.attemptId === parent.attemptId)
        || retry.version !== parent.version || retry.commit !== parent.commit || retry.envFingerprint !== parent.envFingerprint
        || retry.executor !== parent.executor || retry.imageDigest !== parent.imageDigest
        || retry.measuredImageDigest !== parent.measuredImageDigest || retry.currentImageDigest !== parent.currentImageDigest
        || !retry.failureIds || retry.failureIds.length > 0 || !retry.errorIds || retry.errorIds.length > 0
        || !retry.files.length || retry.files.some((file) => !parent.files.includes(file))) return false;
      attempts.add(retry.attemptId);
      retry.files.forEach((file) => covered.add(file));
    }
    if (missing.some((file) => !parent.files.includes(file))
      || parent.files.some((file) => !covered.has(file))) return false;
  }
  return true;
}

export function gateShardLedgerPath(version: string, root = releaseLedgerRoot()): string {
  if (!/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('invalid release version');
  return join(root, 'release', version, 'gate-logs', 'shard-ledger.jsonl');
}

function assertLedgerAppendable(path: string): void {
  if (!existsSync(path)) return;
  const prior = readFileSync(path, 'utf8');
  if (prior.length > 0 && !prior.endsWith('\n')) throw new Error('existing shard ledger has unterminated JSONL row');
}

/** Each newline is a complete event, so an observer can read while the gate is running. */
export function appendGateShardLedger(path: string, row: GateShardLedgerRow): void {
  if (!/^[a-f0-9]{40}$/i.test(row.commit) || !/^[a-f0-9]{64}$/i.test(row.envFingerprint)) throw new Error('invalid shard ledger identity');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.shardId) || row.files.some((file) => file.startsWith('/') || file.split('/').includes('..'))) throw new Error('invalid shard ledger path');
  mkdirSync(dirname(path), { recursive: true });
  assertLedgerAppendable(path);
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

/** Local gates keep their verdict when optional telemetry cannot be written; remote gates must stop. */
export function appendGateShardLedgerForGate(path: string, row: GateShardLedgerRow, required: boolean): string | null {
  try { appendGateShardLedger(path, row); return null; }
  catch (error) {
    if (required) throw error;
    return String(error);
  }
}

/** Persist the completed remote result set in one append after every shard promise has settled. */
export function appendGateShardLedgerBatch(path: string, rows: readonly GateShardLedgerRow[], required: boolean, batchId = randomUUID()): string | null {
  try {
    if (!rows.length) throw new Error('empty shard result batch');
    const shardIds = rows.map((row) => row.shardId);
    if (new Set(shardIds).size !== shardIds.length) throw new Error('duplicate shard id in result batch');
    for (const row of rows) {
      if (row.version !== rows[0]!.version || row.commit !== rows[0]!.commit || row.phase !== 'cut'
        || row.state !== 'done' || row.ran === null
        || (row.attribution !== 'complete' && !retryRecoverableUnmeasuredRow(row)))
        throw new Error('incomplete remote shard result batch');
      if (!/^[a-f0-9]{40}$/i.test(row.commit) || !/^[a-f0-9]{64}$/i.test(row.envFingerprint)) throw new Error('invalid shard ledger identity');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.shardId) || row.files.some((file) => file.startsWith('/') || file.split('/').includes('..'))) throw new Error('invalid shard ledger path');
    }
    mkdirSync(dirname(path), { recursive: true });
    assertLedgerAppendable(path);
    appendFileSync(path, rows.map((row) => `${JSON.stringify({ ...row, batchId, batchSize: rows.length })}\n`).join(''), { mode: 0o600 });
    return null;
  } catch (error) {
    if (required) throw error;
    return String(error);
  }
}

export function readGateShardLedger(path: string): { rows: GateShardLedgerRow[]; malformed: number; incompleteBatches: string[]; sizeUnknownBatches: string[]; trailingPartial: boolean } | null {
  if (!existsSync(path)) return null;
  const contents = readFileSync(path, 'utf8');
  const trailingPartial = contents.length > 0 && !contents.endsWith('\n');
  const rows: GateShardLedgerRow[] = [];
  let malformed = 0;
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as GateShardLedgerRow;
      if (row.v !== 1 || typeof row.shardId !== 'string' || !Array.isArray(row.files) || typeof row.observedAt !== 'string') throw new Error('invalid row');
      rows.push(row);
    } catch { malformed++; }
  }
  const batches = new Map<string, GateShardLedgerRow[]>();
  for (const row of rows) if (row.batchId) batches.set(row.batchId, [...(batches.get(row.batchId) ?? []), row]);
  const sizeUnknownBatches = [...batches].filter(([, batch]) => batch.every((row) => row.batchSize === undefined)).map(([batchId]) => batchId);
  const incompleteBatches = [...batches].filter(([batchId, batch]) => {
    const size = batch[0]?.batchSize;
    if (batch.every((row) => row.batchSize === undefined)) return false;
    if (!Number.isSafeInteger(size) || size! < 1 || batch.length !== size
      || batch.some((row) => row.batchSize !== size || row.state !== 'done'
        || (row.attribution !== 'complete' && !retryRecoverableUnmeasuredRow(row))
        || row.version !== batch[0]!.version || row.commit !== batch[0]!.commit || row.phase !== batch[0]!.phase)
      || new Set(batch.map((row) => row.shardId)).size !== batch.length) return true;
    const first = batch[0]!;
    return !gateShardLedgerBatchComplete(rows, { batchId, version: first.version, commit: first.commit, phase: first.phase,
      observedAt: first.observedAt, shardIds: batch.map((row) => row.shardId) });
  }).map(([batchId]) => batchId);
  return { rows, malformed, incompleteBatches, sizeUnknownBatches, trailingPartial };
}

/** The newest event for each phase/shard. Preserve every attempt in the underlying ledger. */
export function latestGateShardLedger(rows: readonly GateShardLedgerRow[]): GateShardLedgerRow[] {
  const latest = new Map<string, GateShardLedgerRow>();
  for (const row of rows) latest.set(`${row.phase}:${row.shardId}`, row);
  return [...latest.values()].sort((a, b) => a.phase.localeCompare(b.phase) || a.shardId.localeCompare(b.shardId, undefined, { numeric: true }));
}

/** Return a completed cut batch only when HQ has the exact current shard plan and execution identity. */
export function reusableGateShardLedgerBatch(input: {
  path: string;
  version: string;
  commit: string;
  envFingerprint: string;
  imageDigest: string | null;
  shards: readonly { shardId: string; files: readonly string[] }[];
}): Map<string, GateShardLedgerRow> | undefined {
  if (!input.shards.length || !input.envFingerprint || !input.imageDigest) return undefined;
  const ledger = readGateShardLedger(input.path);
  if (!ledger || ledger.trailingPartial || ledger.malformed > 0) return undefined;
  const expected = new Map(input.shards.map((shard) => [shard.shardId, [...shard.files]]));
  if (expected.size !== input.shards.length) return undefined;
  const batches = new Map<string, GateShardLedgerRow[]>();
  for (const row of ledger.rows) if (row.batchId) batches.set(row.batchId, [...(batches.get(row.batchId) ?? []), row]);
  const candidates = [...batches.entries()].reverse();
  for (const [batchId, rows] of candidates) {
    if (rows.length !== expected.size) continue;
    const first = rows[0]!;
    if (!gateShardLedgerBatchComplete(ledger.rows, { batchId, version: input.version, commit: input.commit,
      phase: 'cut', observedAt: first.observedAt, shardIds: [...expected.keys()] })) continue;
    const matches = rows.every((row) => {
      const files = expected.get(row.shardId);
      return !!files && row.files.length === files.length && row.files.every((file, index) => file === files[index])
        && row.envFingerprint === input.envFingerprint && row.executor === 'pod'
        && row.currentImageDigest === input.imageDigest && row.measuredImageDigest === input.imageDigest
        && row.imageDigest === input.imageDigest && (row.rc === 0 || row.rc === 1) && row.pass !== null && row.fail !== null
        && row.errors !== null && row.ran !== null && row.failureIds !== null && row.errorIds !== null
        && row.fail === row.failureIds.length && row.errors === row.errorIds.length
        && row.rc === (row.fail + row.errors > 0 ? 1 : 0) && row.attribution === 'complete';
    });
    if (matches) return new Map(rows.map((row) => [row.shardId, row]));
  }
  return undefined;
}
