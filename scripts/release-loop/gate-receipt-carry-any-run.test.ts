import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReleaseSimGateReceiptSeam } from '../../src/ux-sim/release-sim-rig.js';
import { gateShardRuntimeIdentityKey, type GateShardReceipt } from './gate-shard-dispatch.js';
import { readGateShardResult, saveGateShardResult } from './gate-shard-receipts.js';
import { gateShardReceiptInputFingerprint } from './gate-shard-receipt-carry.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function measured(runId: string, image = `sha256:${'c'.repeat(64)}`, testHash = '2'.repeat(64)): GateShardReceipt {
  const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64',
    envFingerprint: 'd'.repeat(64), baseImageDigest: `sha256:${'b'.repeat(64)}` };
  const lockfileHash = '9'.repeat(64);
  return {
    id: 'pod-0', files: ['test/a.test.ts'], version: '0.3.7', graphRunId: runId,
    graphSha: 'e'.repeat(64), recipeSha: 'f'.repeat(64), graphEntry: 'gate-entry-v1',
    recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    head40: 'a'.repeat(40), base40: 'b'.repeat(40), host: runId === 'cut' ? 'aws1' : 'minim5',
    envKey: gateShardRuntimeIdentityKey(runtimeIdentity, lockfileHash)!, envFingerprint: runtimeIdentity.envFingerprint,
    imageDigest: image, runtimeIdentity, runtimeSourceFingerprint: '1'.repeat(64), lockfileHash,
    testedFileHashes: { 'test/a.test.ts': testHash },
    executions: [{ branch: 'release/0.3.7', attemptId: runId, host: runId === 'cut' ? 'aws1' : 'minim5', imageDigest: image, runtimeIdentity }],
    status: 'complete', failureIds: [], errorIds: [], evidencePath: 'pending', evidenceSha256: '0'.repeat(64),
    measuredAt: '2026-11-07T00:00:00.000Z', attempt: 1,
  };
}

function saved(receipt: GateShardReceipt) {
  return { receipt, runs: [{ output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0,
    pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ['test/a.test.ts > passes'] }] };
}

test('GATE-RECEIPT-CARRY-ANY-RUN: same-input side pass joins the cut receipt; changed input stays separate', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-any-run-')); roots.push(root);
  const rolling = saved(measured('rolling-run'));
  const selfGate = saved(measured('self-gate-run'));
  expect(gateShardReceiptInputFingerprint(rolling.receipt)).toBe(gateShardReceiptInputFingerprint(selfGate.receipt));

  saveGateShardResult(root, rolling);
  const savedNeighbor = saveGateShardResult(root, selfGate);
  const merged = readGateShardResult(root, { shard: savedNeighbor, head40: savedNeighbor.head40,
    base40: savedNeighbor.base40, envKey: savedNeighbor.envKey })!;
  expect(merged.receipt.graphRunId).toBe('self-gate-run');
  expect((merged.receipt as GateShardReceipt & { sourceRunIds?: string[] }).sourceRunIds).toEqual(['rolling-run', 'self-gate-run']);
  expect(merged.receipt.executions?.map((execution) => execution.attemptId).sort()).toEqual(['rolling-run', 'self-gate-run']);
  const sourceEvidence = (merged.receipt as GateShardReceipt & { sourceEvidence?: Array<{ runId: string; evidencePath: string; evidenceSha256: string }> }).sourceEvidence!;
  expect(sourceEvidence.map((evidence) => evidence.runId).sort()).toEqual(['rolling-run', 'self-gate-run']);
  expect(sourceEvidence.every((evidence) => existsSync(join(root, evidence.evidencePath))
    && readFileSync(join(root, evidence.evidencePath), 'utf8').length > 0)).toBe(true);
  expect(merged.runs).toHaveLength(1);

  const stage = runReleaseSimGateReceiptSeam({ tests: ['test/a.test.ts'], receipts: [merged.receipt],
    priorCommit: merged.receipt.head40, commit: merged.receipt.head40, selectedFiles: [], stage: 'cut-after-side-pass' });
  expect(stage).toMatchObject({ aggregate: 'complete', gateOutcome: 'pass', publishDecision: 'eligible',
    plan: { carriedShardIds: ['pod-0'], rerunShardIds: [], fullSweep: false } });

  const changed = saved(measured('image-drift', `sha256:${'d'.repeat(64)}`));
  expect(gateShardReceiptInputFingerprint(changed.receipt)).not.toBe(gateShardReceiptInputFingerprint(selfGate.receipt));
  const replaced = saveGateShardResult(root, changed);
  expect((replaced as GateShardReceipt & { sourceRunIds?: string[] }).sourceRunIds).toEqual(['image-drift']);
  expect(replaced.executions?.map((execution) => execution.attemptId)).toEqual(['image-drift']);
  expect((replaced as GateShardReceipt & { sourceEvidence?: Array<{ runId: string }> }).sourceEvidence?.map((row) => row.runId))
    .toEqual(['image-drift']);
  expect(readGateShardResult(root, { shard: replaced, head40: replaced.head40,
    base40: replaced.base40, envKey: replaced.envKey })?.receipt.imageDigest).toBe(changed.receipt.imageDigest);

  const testDriftRoot = mkdtempSync(join(tmpdir(), 'gate-receipt-test-drift-')); roots.push(testDriftRoot);
  saveGateShardResult(testDriftRoot, selfGate);
  const changedTest = saved(measured('test-source-drift', `sha256:${'c'.repeat(64)}`, '3'.repeat(64)));
  expect(gateShardReceiptInputFingerprint(changedTest.receipt)).not.toBe(gateShardReceiptInputFingerprint(selfGate.receipt));
  const sourceReplaced = saveGateShardResult(testDriftRoot, changedTest);
  expect((sourceReplaced as GateShardReceipt & { sourceRunIds?: string[] }).sourceRunIds).toEqual(['test-source-drift']);
  expect(sourceReplaced.testedFileHashes).toEqual(changedTest.receipt.testedFileHashes);
});

test('GATE-RECEIPT-CARRY-ANY-RUN: concurrent same-shard saves retain every passing source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-concurrent-')); roots.push(root);
  const worker = `
    import { saveGateShardResult } from './scripts/release-loop/gate-shard-receipts.ts';
    const { root, result } = JSON.parse(process.env.GATE_RECEIPT_WRITE!);
    saveGateShardResult(root, result);
  `;
  const writes = ['parallel-a', 'parallel-b', 'parallel-c', 'parallel-d'].map((runId) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker], { cwd: process.cwd(),
      env: { ...process.env, GATE_RECEIPT_WRITE: JSON.stringify({ root, result: saved(measured(runId)) }) },
      stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`receipt worker failed (${code}): ${stderr}`)));
  }));
  await Promise.all(writes);
  const manifest = JSON.parse(readFileSync(join(root, 'pod-0.receipt.json'), 'utf8')) as GateShardReceipt & {
    sourceRunIds?: string[];
    sourceEvidence?: Array<{ runId: string }>;
  };
  expect(manifest.sourceRunIds).toEqual(['parallel-a', 'parallel-b', 'parallel-c', 'parallel-d']);
  expect(manifest.sourceEvidence?.map((row) => row.runId).sort()).toEqual(['parallel-a', 'parallel-b', 'parallel-c', 'parallel-d']);
  expect(manifest.executions?.map((row) => row.attemptId).sort()).toEqual(['parallel-a', 'parallel-b', 'parallel-c', 'parallel-d']);
});

test('GATE-RECEIPT-CARRY-ANY-RUN: process exit releases the kernel receipt lock for the next save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-lock-exit-')); roots.push(root);
  const lockPath = join(root, 'pod-0.receipt.json.flock');
  const worker = `
    import { constants, openSync } from 'node:fs';
    import { dlopen, FFIType } from 'bun:ffi';
    const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const fd = openSync(process.env.GATE_RECEIPT_LOCK!, constants.O_CREAT | constants.O_RDWR, 0o600);
    libc.symbols.flock(fd, 2);
    console.log('lock-held');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', worker], { cwd: process.cwd(), env: { ...process.env, GATE_RECEIPT_LOCK: lockPath },
    stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  await new Promise<void>((resolve, reject) => {
    const until = Date.now() + 5_000;
    const poll = () => {
      if (stdout.includes('lock-held')) { resolve(); return; }
      if (Date.now() >= until) { child.kill('SIGKILL'); reject(new Error('receipt lock worker did not acquire flock')); return; }
      setTimeout(poll, 10);
    };
    child.once('error', reject);
    poll();
  });
  child.kill('SIGKILL');
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  expect(saveGateShardResult(root, saved(measured('after-process-exit'))).graphRunId).toBe('after-process-exit');
});

test('GATE-RECEIPT-CARRY-ANY-RUN: stale legacy lock names are recovered under the kernel guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-legacy-locks-')); roots.push(root);
  const stale = new Date(Date.now() - 120_000);
  const oldFileLock = join(root, 'pod-0.receipt.json.lock');
  writeFileSync(oldFileLock, '2147483647\nlegacy\n');
  utimesSync(oldFileLock, stale, stale);
  const oldDirectoryLock = join(root, 'pod-0.receipt.json.lock.d');
  mkdirSync(oldDirectoryLock);
  writeFileSync(join(oldDirectoryLock, 'pid'), '2147483647\n');
  utimesSync(oldDirectoryLock, stale, stale);

  expect(saveGateShardResult(root, saved(measured('after-legacy-locks'))).graphRunId).toBe('after-legacy-locks');
  expect(existsSync(oldFileLock)).toBe(false);
  expect(existsSync(oldDirectoryLock)).toBe(false);
});

test('GATE-RECEIPT-CARRY-ANY-RUN: a live legacy writer lease makes a passing receipt unmeasured', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-live-legacy-lock-')); roots.push(root);
  const receipt = saveGateShardResult(root, saved(measured('saved-before-legacy')));
  const legacyLock = join(root, 'pod-0.receipt.json.lock.d');
  mkdirSync(legacyLock);
  writeFileSync(join(legacyLock, 'pid'), `${process.pid}\n`);
  expect(readGateShardResult(root, { shard: receipt, head40: receipt.head40, base40: receipt.base40, envKey: receipt.envKey })).toBeNull();
});
