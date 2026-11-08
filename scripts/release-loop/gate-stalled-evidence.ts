import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gateAssignableTestsAtCommit, gateEnvFingerprint } from './gate-baseline-receipt.js';
import { gateShardRuntimeIdentityKey } from './gate-shard-dispatch.js';
import { readGateShardManifest, readGateShardResult } from './gate-shard-receipts.js';

export type StalledGateEvidence = {
  stalledShards: Array<{ shard: number; files: string[]; reason: string }>;
  partialSummary: { pass: number; fail: number; errors: number; ran: number; files: number };
  partialFailures: { failures: string[]; errors: string[] };
  preservedShardCount: number;
};

/** Recover an interrupted Pod sweep only from complete, same-run receipts and a fully checked shard inventory. */
export function stalledGateEvidence(input: { version: string; commit: string; repo: string; roots: string[];
  gateOutput?: Record<string, unknown>; expectedBase40?: string; expectedTests?: (commit: string) => string[] | null;
  expectedRunId?: string; expectedImageDigest?: string; expectedLockfileHash?: string; allowComplete?: boolean }):
  { ok: true; evidence: StalledGateEvidence } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (input.gateOutput && (input.gateOutput.outcome !== 'error' || input.gateOutput.commit !== input.commit))
    return fail('saved gate result is not an error for the recorded cut');
  if (!/^[a-f0-9]{40}$/i.test(input.expectedBase40 ?? '')) return fail('saved cutoff baseline is absent or invalid');
  const fingerprint = gateEnvFingerprint(process.env);
  let receiptDir: string | undefined;
  for (const root of input.roots) {
    const candidate = join(root, 'release', input.version, 'gate-logs', 'cut', 'receipts');
    if (existsSync(candidate)) { receiptDir = candidate; break; }
  }
  if (!receiptDir) return fail('stalled gate receipts are absent');
  const names = readdirSync(receiptDir).filter((name) => /^pod-\d+\.receipt\.json$/.test(name)).sort((a, b) =>
    Number(/^pod-(\d+)/.exec(a)![1]) - Number(/^pod-(\d+)/.exec(b)![1]));
  if (!names.length || names.some((name, index) => Number(/^pod-(\d+)/.exec(name)![1]) !== index))
    return fail('stalled gate receipt shard set is incomplete');
  const allFiles: string[] = [], failures: string[] = [], errors: string[] = [];
  const stalledShards: StalledGateEvidence['stalledShards'] = [];
  const imageDigests = new Set<string>();
  let pass = 0, failCount = 0, errorCount = 0, ran = 0, files = 0, preservedShardCount = 0;
  let base40: string | undefined;
  for (const name of names) {
    const id = name.slice(0, -'.receipt.json'.length);
    const receipt = readGateShardManifest(receiptDir, id);
    if (!receipt || receipt.head40 !== input.commit || !/^[a-f0-9]{40}$/i.test(receipt.base40)
      || !receipt.files.length
      || receipt.files.some((file) => typeof file !== 'string'
        || !/^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file) || file.split('/').includes('..'))
      || typeof receipt.envKey !== 'string' || typeof receipt.host !== 'string')
      return fail(`stalled gate receipt identity or file list is invalid: ${id}`);
    if (receipt.base40 !== input.expectedBase40) return fail(`stalled gate receipt baseline differs from saved cutoff baseline: ${id}`);
    if (base40 && receipt.base40 !== base40) return fail(`stalled gate receipts disagree on baseline: ${id}`);
    base40 = receipt.base40;
    allFiles.push(...receipt.files);
    if (receipt.status === 'unmeasured') {
      stalledShards.push({ shard: Number(id.slice(4)), files: [...receipt.files], reason: 'incomplete' });
      continue;
    }
    if (input.expectedRunId && receipt.graphRunId !== input.expectedRunId)
      return fail(`completed shard receipt belongs to another graph run: ${id}`);
    const runtimeIdentity = receipt.runtimeIdentity, imageDigest = receipt.imageDigest;
    if (!runtimeIdentity || runtimeIdentity.envFingerprint !== fingerprint || receipt.envFingerprint !== fingerprint
      || typeof receipt.lockfileHash !== 'string' || !/^[a-f0-9]{64}$/i.test(receipt.lockfileHash)
      || gateShardRuntimeIdentityKey(runtimeIdentity, receipt.lockfileHash) !== receipt.envKey)
      return fail(`stalled gate receipt runtime/lock identity mismatch: ${id}`);
    if (input.expectedLockfileHash && receipt.lockfileHash !== input.expectedLockfileHash)
      return fail(`stalled gate receipt lockfile differs from the cut runtime: ${id}`);
    if (!/^sha256:[a-f0-9]{64}$/i.test(imageDigest ?? '')) return fail(`stalled gate receipt image identity is missing: ${id}`);
    if (input.expectedImageDigest && imageDigest!.toLowerCase() !== input.expectedImageDigest.toLowerCase())
      return fail(`stalled gate receipt image differs from this run pin: ${id}`);
    imageDigests.add(imageDigest!.toLowerCase());
    const result = readGateShardResult(receiptDir, { shard: { id, files: receipt.files }, head40: input.commit,
      base40: receipt.base40, envKey: receipt.envKey });
    if (!result) return fail(`stalled gate receipt payload is incomplete or corrupt: ${id}`);
    const totals = result.runs.reduce((sum, run) => ({ pass: sum.pass + run.pass, fail: sum.fail + run.fail,
      errors: sum.errors + run.errors, ran: sum.ran + run.ran, files: sum.files + run.files }),
    { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
    if (!Object.values(totals).every(Number.isSafeInteger) || receipt.failureIds.length !== totals.fail || receipt.errorIds.length !== totals.errors)
      return fail(`stalled gate receipt counts do not reconcile: ${id}`);
    pass += totals.pass; failCount += totals.fail; errorCount += totals.errors; ran += totals.ran; files += totals.files;
    failures.push(...receipt.failureIds); errors.push(...receipt.errorIds); preservedShardCount++;
  }
  if (!stalledShards.length && !input.allowComplete) return fail('no incomplete shard receipt identifies the interrupted work');
  if (new Set(allFiles).size !== allFiles.length) return fail('stalled gate receipt file assignments overlap');
  if (imageDigests.size !== 1) return fail('stalled gate completed shards do not share one executed image');
  const expected = (input.expectedTests ?? ((commit) => gateAssignableTestsAtCommit(input.repo, commit)))(input.commit);
  if (!expected || JSON.stringify([...expected].sort()) !== JSON.stringify([...allFiles].sort()))
    return fail('stalled gate receipts do not cover the pinned test selection');
  const partialSummary = { pass, fail: failCount, errors: errorCount, ran, files };
  const partialFailures = { failures: [...new Set(failures)].sort(), errors: [...new Set(errors)].sort() };
  const gate = input.gateOutput;
  if (gate) {
    const savedSummary = gate.partialSummary as Partial<StalledGateEvidence['partialSummary']> | undefined;
    if (savedSummary && JSON.stringify(savedSummary) !== JSON.stringify(partialSummary)) return fail('saved gate summary disagrees with shard receipts');
    const savedFailures = gate.partialFailures as Partial<StalledGateEvidence['partialFailures']> | undefined;
    if (savedFailures && (JSON.stringify([...((savedFailures.failures as string[] | undefined) ?? [])].sort()) !== JSON.stringify(partialFailures.failures)
      || JSON.stringify([...((savedFailures.errors as string[] | undefined) ?? [])].sort()) !== JSON.stringify(partialFailures.errors)))
      return fail('saved gate failures disagree with shard receipts');
    if (gate.preservedShardCount !== undefined && gate.preservedShardCount !== preservedShardCount)
      return fail('saved preserved shard count disagrees with shard receipts');
    if (Array.isArray(gate.stalledShards)) {
      const savedStalled = gate.stalledShards.flatMap((item) => item && typeof item === 'object'
        && Array.isArray((item as { files?: unknown }).files) ? (item as { files: string[] }).files : []).sort();
      if (JSON.stringify(savedStalled) !== JSON.stringify(stalledShards.flatMap((item) => item.files).sort()))
        return fail('saved stalled shard list disagrees with shard receipts');
    }
  }
  return { ok: true, evidence: { stalledShards, partialSummary, partialFailures, preservedShardCount } };
}
