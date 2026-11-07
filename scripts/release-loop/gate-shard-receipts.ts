import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { eligibleGateShardReceipt, gateShardRuntimeIdentityKey, type GateShardIdentity, type GateShardReceipt } from './gate-shard-dispatch.js';
import { runtimeIdentitiesMatch } from '../../src/runtime-identity.js';

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

const HISTORY_HEADS_PER_SHARD = 5;
function archivedReceiptPath(root: string, shardId: string, head40: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(shardId) || !/^[a-f0-9]{40}$/i.test(head40)) throw new Error('invalid gate receipt history key');
  return join(root, `${shardId}.receipt.${head40.toLowerCase()}.json`);
}

export function nextGateShardAttempt(root: string, shardId: string): number {
  try {
    const previous = JSON.parse(readFileSync(gateShardReceiptPath(root, shardId), 'utf8')) as { attempt?: unknown };
    return Number.isSafeInteger(previous.attempt) && (previous.attempt as number) > 0 ? (previous.attempt as number) + 1 : 1;
  } catch { return 1; }
}

/** Planning may inspect an unmeasured predecessor; only readGateShardResult authorizes reuse. */
function receiptRecordSha256(value: Omit<GateShardReceipt, 'recordSha256'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function validReceiptRecordIntegrity(value: GateShardReceipt): boolean {
  if (!value.recordSha256 || !/^[a-f0-9]{64}$/i.test(value.recordSha256)) return false;
  const { recordSha256: _checksum, ...record } = value;
  return receiptRecordSha256(record) === value.recordSha256;
}

export function readGateShardManifest(root: string, shardId: string): GateShardReceipt | null {
  try {
    const value = JSON.parse(readFileSync(gateShardReceiptPath(root, shardId), 'utf8')) as GateShardReceipt;
    return value && value.id === shardId && Array.isArray(value.files)
      && Array.isArray(value.failureIds) && value.failureIds.every((id) => typeof id === 'string')
      && Array.isArray(value.errorIds) && value.errorIds.every((id) => typeof id === 'string')
      && (value.status === 'complete' || value.status === 'unmeasured')
      && (value.status !== 'complete' || validReceiptRecordIntegrity(value)) ? value : null;
  } catch { return null; }
}

/** Read the current manifest plus a bounded set of older, independently keyed head manifests. */
export function readGateShardManifestHistory(root: string, shardId: string): GateShardReceipt[] {
  const current = readGateShardManifest(root, shardId);
  let names: string[];
  try { names = readdirSync(root).filter((name) => new RegExp(`^${shardId}\\.receipt\\.[a-f0-9]{40}\\.json$`, 'i').test(name)); }
  catch { return current ? [current] : []; }
  const archived = names.flatMap((name) => {
    try {
      const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as GateShardReceipt;
      return value?.id === shardId && Array.isArray(value.files) && Array.isArray(value.failureIds) && Array.isArray(value.errorIds)
        && (value.status === 'unmeasured' || (value.status === 'complete' && validReceiptRecordIntegrity(value))) ? [value] : [];
    } catch { return []; }
  });
  const rows = [...archived, ...(current ? [current] : [])];
  return [...new Map(rows.map((row) => [`${row.head40}:${row.attempt}`, row])).values()]
    .sort((a, b) => (a === current ? -1 : b === current ? 1 : Date.parse(b.measuredAt) - Date.parse(a.measuredAt)))
    .slice(0, HISTORY_HEADS_PER_SHARD);
}

function preservePreviousHead(root: string, shardId: string, nextHead40: string): void {
  const previous = readGateShardManifest(root, shardId);
  if (!previous || previous.status !== 'complete' || previous.head40 === nextHead40) return;
  atomicJson(archivedReceiptPath(root, shardId, previous.head40), previous);
  const pattern = new RegExp(`^${shardId}\\.receipt\\.([a-f0-9]{40})\\.json$`, 'i');
  const history = readdirSync(root).flatMap((name) => {
    const match = pattern.exec(name);
    if (!match) return [];
    const receipt = readGateShardManifestAt(root, name, shardId);
    return receipt ? [{ name, measuredAt: Date.parse(receipt.measuredAt), head: match[1]!.toLowerCase() }] : [];
  }).sort((a, b) => b.measuredAt - a.measuredAt);
  for (const stale of history.slice(HISTORY_HEADS_PER_SHARD)) rmSync(join(root, stale.name), { force: true });
}

function readGateShardManifestAt(root: string, name: string, shardId: string): GateShardReceipt | null {
  try {
    const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as GateShardReceipt;
    return value && value.id === shardId && Array.isArray(value.files) && Array.isArray(value.failureIds)
      && Array.isArray(value.errorIds) && (value.status === 'unmeasured' || value.status === 'complete')
      && (value.status !== 'complete' || validReceiptRecordIntegrity(value)) ? value : null;
  } catch { return null; }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  try { writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) rmSync(temp); }
}

export type GateShardReceiptInspection =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; images: Array<{ imageDigest: string }>; receipts: GateShardReceipt[];
      invalidatedShardIds: string[]; invalidatedFiles: string[] };

/** The gate treats an empty formal receipt inventory as a full-sweep fallback reason. */
export function formalReceiptSetPresenceReason(receiptCount: number): 'formal-receipt-set-absent' | undefined {
  return receiptCount === 0 ? 'formal-receipt-set-absent' : undefined;
}

/** Validate the complete formal receipt set against independently recorded shard and test inventories. */
export function inspectGateShardReceipts(root: string, expected: {
  version: string; commit: string; base40: string; envFingerprint: string;
  runtimeIdentity: NonNullable<GateShardReceipt['runtimeIdentity']>; lockHash: string;
  graphPins: { graphSha: string; recipeSha: string }; graphEntry: string; recipeCommand: string; recipeTimeoutMs: number;
  shards: Array<{ id: string; files: string[] }>; tests: string[];
}): GateShardReceiptInspection {
  let names: string[];
  try { names = readdirSync(root).filter((name) => name.endsWith('.receipt.json')); }
  catch { return { kind: 'absent' }; }
  if (!names.length) return { kind: 'absent' };
  if (names.some((name) => !/^pod-\d+\.receipt\.json$/.test(name)))
    return { kind: 'invalid', reason: 'formal receipt directory contains an invalid shard filename' };
  const orderedNames = names.sort((a, b) => Number(/^pod-(\d+)/.exec(a)![1]) - Number(/^pod-(\d+)/.exec(b)![1]));
  const expectedShards = [...expected.shards].sort((a, b) => Number(/^pod-(\d+)/.exec(a.id)?.[1] ?? -1) - Number(/^pod-(\d+)/.exec(b.id)?.[1] ?? -1));
  if (!expectedShards.length || expectedShards.some((shard, index) => shard.id !== `pod-${index}`)
    || JSON.stringify(orderedNames) !== JSON.stringify(expectedShards.map((shard) => `${shard.id}.receipt.json`)))
    return { kind: 'invalid', reason: 'formal receipt shard set differs from the independent gate shard inventory' };
  const receipts: GateShardReceipt[] = [];
  const images: Array<{ imageDigest: string }> = [];
  const invalidatedShardIds: string[] = [];
  const invalidatedFiles: string[] = [];
  const expectedFiles = expectedShards.flatMap((shard) => shard.files);
  if (new Set(expectedFiles).size !== expectedFiles.length || JSON.stringify([...expectedFiles].sort()) !== JSON.stringify([...expected.tests].sort()))
    return { kind: 'invalid', reason: 'independent gate shard files do not cover the test inventory exactly' };
  let image: string | undefined;
  for (const shard of expectedShards) {
    const receipt = readGateShardManifest(root, shard.id);
    if (!receipt || receipt.status !== 'complete') return { kind: 'invalid', reason: `formal shard receipt is absent or incomplete: ${shard.id}` };
    if (receipt.version !== expected.version)
      return { kind: 'invalid', reason: `formal shard receipt version differs: ${shard.id}` };
    if (receipt.graphSha !== expected.graphPins.graphSha || receipt.recipeSha !== expected.graphPins.recipeSha)
      return { kind: 'invalid', reason: `formal shard receipt graph/source pins differ: ${shard.id}` };
    if (receipt.head40 !== expected.commit || receipt.base40 !== expected.base40)
      return { kind: 'invalid', reason: `formal shard receipt baseline commit/base differs: ${shard.id}` };
    if (!receipt.graphEntry || receipt.graphEntry !== expected.graphEntry)
      return { kind: 'invalid', reason: 'formal shard receipt graph entry differs: ' + shard.id };
    if (!receipt.recipeCommand || receipt.recipeCommand !== expected.recipeCommand || receipt.recipeTimeoutMs !== expected.recipeTimeoutMs)
      return { kind: 'invalid', reason: 'formal shard receipt recipe command differs: ' + shard.id };
    if (JSON.stringify(receipt.files) !== JSON.stringify(shard.files))
      return { kind: 'invalid', reason: `formal shard receipt file assignment differs: ${shard.id}` };
    if (!receipt.imageDigest || !/^sha256:[a-f0-9]{64}$/i.test(receipt.imageDigest))
      return { kind: 'invalid', reason: `formal shard receipt executed image digest is invalid: ${shard.id}` };
    if (!receipt.runtimeIdentity || receipt.envFingerprint !== receipt.runtimeIdentity.envFingerprint
      || receipt.envKey !== gateShardRuntimeIdentityKey(receipt.runtimeIdentity, receipt.lockfileHash)
      || receipt.envKey !== gateShardRuntimeIdentityKey(expected.runtimeIdentity, expected.lockHash)
      || !runtimeIdentitiesMatch({ baseImageDigest: receipt.runtimeIdentity.baseImageDigest ?? '', lockHash: receipt.lockfileHash ?? '',
        os: receipt.runtimeIdentity.platform, architecture: receipt.runtimeIdentity.architecture, bunVersion: receipt.runtimeIdentity.bunVersion },
      { baseImageDigest: expected.runtimeIdentity.baseImageDigest ?? '', lockHash: expected.lockHash,
        os: expected.runtimeIdentity.platform, architecture: expected.runtimeIdentity.architecture, bunVersion: expected.runtimeIdentity.bunVersion }))
      return { kind: 'invalid', reason: `formal shard receipt environment/runtime differs: ${shard.id}` };
    if (image && image !== receipt.imageDigest)
      return { kind: 'invalid', reason: `formal shard receipt image digest differs across shards: ${shard.id}` };
    image = receipt.imageDigest;
    images.push({ imageDigest: receipt.imageDigest });
    const result = readGateShardResult(root, { shard: { id: shard.id, files: shard.files }, head40: expected.commit,
      base40: expected.base40, envKey: gateShardRuntimeIdentityKey(receipt.runtimeIdentity, receipt.lockfileHash) ?? '' });
    if (!result) {
      invalidatedShardIds.push(shard.id);
      invalidatedFiles.push(...shard.files);
      continue;
    }
    if (result.runs.some((run) => run.passedIds.some((id) => !shard.files.includes(id.split(' > ', 1)[0]!))))
    {
      invalidatedShardIds.push(shard.id);
      invalidatedFiles.push(...shard.files);
      continue;
    }
    receipts.push(receipt);
  }
  if (!receipts.length) return { kind: 'invalid', reason: 'no intact formal shard payload remains reusable' };
  return { kind: 'valid', images, receipts, invalidatedShardIds, invalidatedFiles: [...new Set(invalidatedFiles)].sort() };
}

/** A new attempt invalidates an old success before host execution starts. */
export function markGateShardUnmeasured(root: string, receipt: GateShardReceipt): void {
  preservePreviousHead(root, receipt.id, receipt.head40);
  atomicJson(gateShardReceiptPath(root, receipt.id), { ...receipt, status: 'unmeasured' });
}

/** Save the actual measured bytes and bind their digest to the manifest. */
export function saveGateShardResult(root: string, result: GateShardSavedResult): GateShardReceipt {
  const { receipt, runs } = result;
  if (!eligibleGateShardReceipt(receipt, receipt, receipt.head40, receipt.base40))
    throw new Error('incomplete gate shard receipt metadata');
  if (!runs.length) throw new Error('gate shard result has no measured runs');
  const invalidRun = runs.find((run) => !Number.isSafeInteger(run.ran) || run.ran < 0
    || !Number.isSafeInteger(run.files) || run.files < 1);
  if (invalidRun) throw new Error(`gate shard result has invalid run counts: ran=${invalidRun.ran} files=${invalidRun.files}`);
  preservePreviousHead(root, receipt.id, receipt.head40);
  const payloadName = `${receipt.id}.attempt-${receipt.attempt}-${randomUUID()}.result.json`;
  const payloadBody = { runs, failureIds: receipt.failureIds, errorIds: receipt.errorIds };
  const payload = JSON.stringify(payloadBody) + '\n';
  const digest = createHash('sha256').update(payload).digest('hex');
  atomicJson(join(root, payloadName), payloadBody);
  const record = { ...receipt, evidencePath: payloadName, evidenceSha256: digest };
  const saved = { ...record, recordSha256: receiptRecordSha256(record) };
  atomicJson(gateShardReceiptPath(root, receipt.id), saved);
  return saved;
}

/** No manifest, stale identity, missing bytes or digest mismatch can become a reused pass. */
export function readGateShardResult(root: string, expected: { shard: GateShardIdentity; head40: string; base40: string; envKey: string; receipt?: GateShardReceipt }): GateShardSavedResult | null {
  try {
    const receipt = expected.receipt ?? readGateShardManifest(root, expected.shard.id);
    if (!receipt) return null;
    if (!eligibleGateShardReceipt(receipt, expected.shard, expected.head40, expected.base40) || receipt.envKey !== expected.envKey
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.result\.json$/.test(receipt.evidencePath)) return null;
    const payload = readFileSync(join(root, receipt.evidencePath), 'utf8');
    if (createHash('sha256').update(payload).digest('hex') !== receipt.evidenceSha256) return null;
    const parsed = JSON.parse(payload) as { runs?: GateShardSavedRun[]; failureIds?: string[]; errorIds?: string[] };
    if (!Array.isArray(parsed.runs) || parsed.runs.length === 0 || parsed.runs.some((run) =>
      typeof run.output !== 'string' || !Number.isSafeInteger(run.rc) || !Number.isSafeInteger(run.ran)
      || !Number.isSafeInteger(run.files) || !Array.isArray(run.passedIds) || !Number.isSafeInteger(run.pass)
      || run.pass < 0 || run.passedIds.length !== run.pass || run.pass + run.fail + run.errors !== run.ran || new Set(run.passedIds).size !== run.passedIds.length || run.passedIds.some((id) => typeof id !== 'string' || !id.trim()))
      || JSON.stringify(parsed.failureIds) !== JSON.stringify(receipt.failureIds)
      || JSON.stringify(parsed.errorIds) !== JSON.stringify(receipt.errorIds)) return null;
    return { receipt, runs: parsed.runs };
  } catch { return null; }
}

/** Carry a verified unchanged shard to a descendant commit without claiming it was remeasured. */
export function carryGateShardResult(root: string, expected: GateShardSavedResult, head40: string): GateShardReceipt {
  if (!/^[a-f0-9]{40}$/i.test(head40)) throw new Error('invalid carried gate shard head');
  const { recordSha256: _previousRecordSha256, ...receipt } = expected.receipt;
  return saveGateShardResult(root, { receipt: { ...receipt, head40 }, runs: expected.runs });
}
