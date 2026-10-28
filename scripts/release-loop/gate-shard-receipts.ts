import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { eligibleGateShardReceipt, type GateShardIdentity, type GateShardReceipt } from './gate-shard-dispatch.js';

export interface GateShardSavedRun {
  output: string;
  rc: number;
  pass: number;
  fail: number;
  errors: number;
  ran: number;
  files: number;
  passedIds: string[];
}

export interface GateShardSavedResult {
  receipt: GateShardReceipt;
  runs: GateShardSavedRun[];
}

export function gateShardReceiptPath(root: string, shardId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(shardId)) throw new Error('invalid shard id');
  return join(root, `${shardId}.receipt.json`);
}

export function nextGateShardAttempt(root: string, shardId: string): number {
  try {
    const previous = JSON.parse(readFileSync(gateShardReceiptPath(root, shardId), 'utf8')) as { attempt?: unknown };
    return Number.isSafeInteger(previous.attempt) && (previous.attempt as number) > 0 ? (previous.attempt as number) + 1 : 1;
  } catch { return 1; }
}

/** Planning may inspect an unmeasured predecessor; only readGateShardResult authorizes reuse. */
export function readGateShardManifest(root: string, shardId: string): GateShardReceipt | null {
  try {
    const value = JSON.parse(readFileSync(gateShardReceiptPath(root, shardId), 'utf8')) as GateShardReceipt;
    return value && value.id === shardId && Array.isArray(value.files)
      && Array.isArray(value.failureIds) && value.failureIds.every((id) => typeof id === 'string')
      && Array.isArray(value.errorIds) && value.errorIds.every((id) => typeof id === 'string')
      && (value.status === 'complete' || value.status === 'unmeasured') ? value : null;
  } catch { return null; }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  try { writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) rmSync(temp); }
}

/** A new attempt invalidates an old success before host execution starts. */
export function markGateShardUnmeasured(root: string, receipt: GateShardReceipt): void {
  atomicJson(gateShardReceiptPath(root, receipt.id), { ...receipt, status: 'unmeasured' });
}

/** Save the actual measured bytes and bind their digest to the manifest. */
export function saveGateShardResult(root: string, result: GateShardSavedResult): GateShardReceipt {
  const { receipt, runs } = result;
  if (!eligibleGateShardReceipt(receipt, receipt, receipt.head40, receipt.base40) || !runs.length
    || runs.some((run) => !Number.isSafeInteger(run.ran) || run.ran < 0 || !Number.isSafeInteger(run.files) || run.files < 1))
    throw new Error('incomplete gate shard result');
  const payloadName = `${receipt.id}.attempt-${receipt.attempt}-${randomUUID()}.result.json`;
  const payloadBody = { runs, failureIds: receipt.failureIds, errorIds: receipt.errorIds };
  const payload = JSON.stringify(payloadBody) + '\n';
  const digest = createHash('sha256').update(payload).digest('hex');
  atomicJson(join(root, payloadName), payloadBody);
  const saved = { ...receipt, evidencePath: payloadName, evidenceSha256: digest };
  atomicJson(gateShardReceiptPath(root, receipt.id), saved);
  return saved;
}

/** No manifest, stale identity, missing bytes or digest mismatch can become a reused pass. */
export function readGateShardResult(root: string, expected: { shard: GateShardIdentity; head40: string; base40: string; envKey: string }): GateShardSavedResult | null {
  try {
    const receipt = JSON.parse(readFileSync(gateShardReceiptPath(root, expected.shard.id), 'utf8')) as GateShardReceipt;
    if (!eligibleGateShardReceipt(receipt, expected.shard, expected.head40, expected.base40) || receipt.envKey !== expected.envKey
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.result\.json$/.test(receipt.evidencePath)) return null;
    const payload = readFileSync(join(root, receipt.evidencePath), 'utf8');
    if (createHash('sha256').update(payload).digest('hex') !== receipt.evidenceSha256) return null;
    const parsed = JSON.parse(payload) as { runs?: GateShardSavedRun[]; failureIds?: string[]; errorIds?: string[] };
    if (!Array.isArray(parsed.runs) || parsed.runs.length === 0 || parsed.runs.some((run) =>
      typeof run.output !== 'string' || !Number.isSafeInteger(run.rc) || !Number.isSafeInteger(run.ran)
      || !Number.isSafeInteger(run.files) || !Array.isArray(run.passedIds))
      || JSON.stringify(parsed.failureIds) !== JSON.stringify(receipt.failureIds)
      || JSON.stringify(parsed.errorIds) !== JSON.stringify(receipt.errorIds)) return null;
    return { receipt, runs: parsed.runs };
  } catch { return null; }
}
