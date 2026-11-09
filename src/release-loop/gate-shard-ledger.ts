// One append-only observation per gate shard transition. The live board is a projection, not evidence for reuse.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';

export interface GateShardLedgerRow {
  v: 1;
  /** Release graph invocation that owns this observation; lets the HQ ledger be queried by one run. */
  runId?: string;
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
  state: 'pending' | 'running' | 'stop-requested' | 'done' | 'retry' | 'timeout' | 'failed';
  rc: number | null;
  pass: number | null;
  fail: number | null;
  errors: number | null;
  skipped?: number | null;
  ran: number | null;
  failureIds: string[] | null;
  errorIds: string[] | null;
  attribution: 'complete' | 'unmeasured';
  logPath: string | null;
  junitPath: string | null;
  stopReason: string | null;
  attemptId: string | null;
  reuseDecision?: 'reuse' | 'rerun' | 'candidate' | undefined;
  reuseReason?: string | undefined;
  /** Shared identity for the completed remote shard result batch. */
  batchId?: string;
  /** Number of shard rows expected in this completed batch. */
  batchSize?: number;
  /** Files whose first attempt was not measured and therefore must be covered by a successful retry row. */
  unmeasuredFiles?: string[] | undefined;
  /** Shared identity of the parent attempt and the retry rows that recover it. */
  retryGroupId?: string | undefined;
}

export interface GateShardLedgerBatchExpectation {
  batchId: string;
  version: string;
  commit: string;
  phase: 'cut' | 'baseline';
  observedAt: string;
  shardIds: readonly string[];
}

/** A recovered parent is complete only when its successful child runs cover its exact original file set. */
export function gateShardFilesCovered(expected: readonly string[], measured: readonly string[]): boolean {
  const actual = new Set(measured);
  return expected.length > 0 && actual.size === expected.length && actual.size === measured.length
    && expected.every((file) => actual.has(file));
}

/** Validate the persisted batch marker and the exact shard set expected by this gate invocation. */
export function gateShardLedgerBatchComplete(rows: readonly GateShardLedgerRow[], expected: GateShardLedgerBatchExpectation): boolean {
  if (!expected.shardIds.length || new Set(expected.shardIds).size !== expected.shardIds.length) return false;
  const batch = rows.filter((row) => row.batchId === expected.batchId);
  if (batch.length !== expected.shardIds.length || new Set(batch.map((row) => row.shardId)).size !== batch.length
    || !batch.every((row) => row.version === expected.version && row.commit === expected.commit && row.phase === expected.phase
      && row.observedAt === expected.observedAt && row.batchSize === expected.shardIds.length && row.state === 'done')
    || expected.shardIds.some((id) => !batch.some((row) => row.shardId === id))) return false;

  // Batch completeness is a persistence contract, not a reuse verdict. Keep a complete record of every
  // completed shard, including measured-but-unattributed results; receipt reuse applies the stricter
  // attribution/runtime checks in reusableGateShardLedgerBatch.
  if (batch.some((row) => !Number.isSafeInteger(row.ran) || row.ran! < 0
    || (row.attribution !== 'complete' && row.attribution !== 'unmeasured')
    || (row.skipped !== undefined && row.skipped !== null && (!Number.isSafeInteger(row.skipped) || row.skipped < 0))
    || (row.attribution === 'complete' && (row.pass === null || row.fail === null || row.errors === null
      || !row.failureIds || !row.errorIds || row.fail !== row.failureIds.length || row.errors !== row.errorIds.length)))) return false;
  return true;
}

/** A structurally complete batch is reusable only when every shard has complete attribution and no retry gap. */
export function gateShardLedgerBatchReusable(rows: readonly GateShardLedgerRow[], expected: GateShardLedgerBatchExpectation): boolean {
  if (!gateShardLedgerBatchComplete(rows, expected)) return false;
  const batch = rows.filter((row) => row.batchId === expected.batchId);
  return batch.every((row) => row.attribution === 'complete' && !row.retryGroupId && !row.unmeasuredFiles?.length
    && row.pass !== null && row.fail !== null && row.errors !== null && row.ran !== null
    && !!row.failureIds && !!row.errorIds && row.fail === row.failureIds.length && row.errors === row.errorIds.length
    && row.rc === (row.fail + row.errors > 0 ? 1 : 0));
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
        || row.state !== 'done' || !Number.isSafeInteger(row.ran) || row.ran! < 0
        || (row.attribution !== 'complete' && row.attribution !== 'unmeasured')
        || (row.attribution === 'complete' && (row.pass === null || row.fail === null || row.errors === null
          || !row.failureIds || !row.errorIds || row.fail !== row.failureIds.length || row.errors !== row.errorIds.length)))
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
        || (row.attribution !== 'complete' && row.attribution !== 'unmeasured')
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

/** Latest ledger rows for the exact attempts currently represented by a gate board. */
export function latestGateShardLedgerAttempts(rows: readonly GateShardLedgerRow[], attemptIds: ReadonlyMap<string, string>): Map<string, GateShardLedgerRow> {
  const latest = new Map<string, GateShardLedgerRow>();
  for (const row of rows) if (attemptIds.get(row.shardId) === row.attemptId) latest.set(row.shardId, row);
  return latest;
}

/** Append a stop/reconciliation lifecycle event using the measured shard identity already in the ledger. */
export function appendGateShardLifecycleState(path: string, shardIds: readonly string[], state: GateShardLedgerRow['state'], observedAt = new Date().toISOString(), endedAt: string | null = null,
  attemptIds: ReadonlyMap<string, string> = new Map()): string[] {
  const ledger = readGateShardLedger(path);
  if (!ledger) return [...shardIds];
  const latest = latestGateShardLedgerAttempts(ledger.rows, attemptIds);
  const errors: string[] = [];
  for (const shardId of shardIds) {
    if (!attemptIds.has(shardId)) { errors.push(`${shardId}: missing attempt identity`); continue; }
    const previous = latest.get(shardId);
    if (!previous) { errors.push(`${shardId}: no prior ledger event for attempt ${attemptIds.get(shardId)}`); continue; }
    if (previous.state === state) continue;
    try {
      appendGateShardLedger(path, { ...previous, observedAt, state, endedAt,
        ...(state === 'stop-requested' ? { attribution: 'unmeasured', stopReason: 'graph-run-stop-requested', rc: null } : {}) });
    } catch (error) { errors.push(`${shardId}: ${String(error)}`); }
  }
  return errors;
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
    if (!gateShardLedgerBatchReusable(ledger.rows, { batchId, version: input.version, commit: input.commit,
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
