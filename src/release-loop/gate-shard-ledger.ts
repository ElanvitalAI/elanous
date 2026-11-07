// One append-only observation per gate shard transition. The live board is a projection, not evidence for reuse.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';

export interface GateShardLedgerRow {
  v: 1;
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
}

export interface GateShardLedgerBatchExpectation {
  batchId: string;
  version: string;
  commit: string;
  phase: 'cut' | 'baseline';
  observedAt: string;
  shardIds: readonly string[];
}

/** Validate the persisted batch marker and the exact shard set expected by this gate invocation. */
export function gateShardLedgerBatchComplete(rows: readonly GateShardLedgerRow[], expected: GateShardLedgerBatchExpectation): boolean {
  if (!expected.shardIds.length || new Set(expected.shardIds).size !== expected.shardIds.length) return false;
  const batch = rows.filter((row) => row.batchId === expected.batchId);
  if (!batch.length) return false;
  const actualIds = batch.map((row) => row.shardId);
  return batch.length === expected.shardIds.length
    && batch.every((row) => row.version === expected.version && row.commit === expected.commit && row.phase === expected.phase
      && row.observedAt === expected.observedAt && row.batchSize === expected.shardIds.length && row.state === 'done' && row.attribution === 'complete')
    && new Set(actualIds).size === actualIds.length
    && expected.shardIds.every((id) => actualIds.includes(id));
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
        || row.state !== 'done' || row.ran === null || row.attribution !== 'complete')
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
  const incompleteBatches = [...batches].filter(([, batch]) => {
    const size = batch[0]?.batchSize;
    return !batch.every((row) => row.batchSize === undefined) && (!Number.isSafeInteger(size) || size! < 1 || batch.length !== size
      || batch.some((row) => row.batchSize !== size || row.state !== 'done' || row.attribution !== 'complete'
        || row.version !== batch[0]!.version || row.commit !== batch[0]!.commit || row.phase !== batch[0]!.phase)
      || new Set(batch.map((row) => row.shardId)).size !== batch.length);
  }).map(([batchId]) => batchId);
  return { rows, malformed, incompleteBatches, sizeUnknownBatches, trailingPartial };
}

/** The newest event for each phase/shard. Preserve every attempt in the underlying ledger. */
export function latestGateShardLedger(rows: readonly GateShardLedgerRow[]): GateShardLedgerRow[] {
  const latest = new Map<string, GateShardLedgerRow>();
  for (const row of rows) latest.set(`${row.phase}:${row.shardId}`, row);
  return [...latest.values()].sort((a, b) => a.phase.localeCompare(b.phase) || a.shardId.localeCompare(b.shardId, undefined, { numeric: true }));
}
