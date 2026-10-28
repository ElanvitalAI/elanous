// One append-only observation per gate shard transition. The live board is a projection, not evidence for reuse.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
}

export function gateShardLedgerPath(version: string, root = releaseLedgerRoot()): string {
  if (!/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('invalid release version');
  return join(root, 'release', version, 'gate-logs', 'shard-ledger.jsonl');
}

/** Each newline is a complete event, so an observer can read while the gate is running. */
export function appendGateShardLedger(path: string, row: GateShardLedgerRow): void {
  if (!/^[a-f0-9]{40}$/i.test(row.commit) || !/^[a-f0-9]{64}$/i.test(row.envFingerprint)) throw new Error('invalid shard ledger identity');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.shardId) || row.files.some((file) => file.startsWith('/') || file.split('/').includes('..'))) throw new Error('invalid shard ledger path');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export function readGateShardLedger(path: string): { rows: GateShardLedgerRow[]; malformed: number } | null {
  if (!existsSync(path)) return null;
  const rows: GateShardLedgerRow[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as GateShardLedgerRow;
      if (row.v !== 1 || typeof row.shardId !== 'string' || !Array.isArray(row.files) || typeof row.observedAt !== 'string') throw new Error('invalid row');
      rows.push(row);
    } catch { malformed++; }
  }
  return { rows, malformed };
}

/** The newest event for each phase/shard. Preserve every attempt in the underlying ledger. */
export function latestGateShardLedger(rows: readonly GateShardLedgerRow[]): GateShardLedgerRow[] {
  const latest = new Map<string, GateShardLedgerRow>();
  for (const row of rows) latest.set(`${row.phase}:${row.shardId}`, row);
  return [...latest.values()].sort((a, b) => a.phase.localeCompare(b.phase) || a.shardId.localeCompare(b.shardId, undefined, { numeric: true }));
}
