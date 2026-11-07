import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryGateShardResult, gateShardReceiptPath, inspectGateShardReceipts, markGateShardUnmeasured, readGateShardResult, saveGateShardResult } from './gate-shard-receipts.js';
import { gateShardRuntimeIdentityKey, type GateShardReceipt } from './gate-shard-dispatch.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const receipt = (): GateShardReceipt => {
  const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: 'd'.repeat(64), baseImageDigest: `sha256:${'b'.repeat(64)}` };
  const lockfileHash = '9'.repeat(64);
  const imageDigest = `sha256:${'c'.repeat(64)}`;
  return ({ version: '1.0.1', graphSha: 'e'.repeat(64), recipeSha: 'f'.repeat(64), graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000, id: 'pod-0', files: ['src/a.test.ts'], head40: 'a'.repeat(40), base40: 'b'.repeat(40),
  host: 'node-b', envKey: gateShardRuntimeIdentityKey(runtimeIdentity, lockfileHash)!, envFingerprint: 'd'.repeat(64), imageDigest, lockfileHash,
  runtimeIdentity, testedFileHashes: { 'src/a.test.ts': 'a'.repeat(64) }, executions: [{ branch: '', attemptId: 'attempt-1', host: 'node-b', imageDigest, runtimeIdentity }], status: 'complete', failureIds: [], errorIds: [], evidencePath: 'pending',
  evidenceSha256: '0'.repeat(64), measuredAt: '2026-10-27T00:00:00.000Z', attempt: 1 });
};

test('receipt reads require the exact recorded baseline; moved heads need radius planning', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-')); roots.push(root);
  const original = receipt();
  const saved = saveGateShardResult(root, { receipt: original,
    runs: [{ output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ['src/a.test.ts > pass'] }] });
  const expected = { shard: original, head40: original.head40, base40: original.base40, envKey: original.envKey };
  expect(readGateShardResult(root, expected)?.runs[0]?.ran).toBe(1);
  expect(readGateShardResult(root, { ...expected, head40: 'c'.repeat(40) })).toBeNull();
  expect(readGateShardResult(root, { ...expected, base40: 'c'.repeat(40) })).toBeNull();
  expect(readGateShardResult(root, { ...expected, shard: { id: original.id, files: ['src/b.test.ts'] } })).toBeNull();
  expect(readGateShardResult(root, { ...expected, envKey: 'other' })).toBeNull();
  const manifestPath = gateShardReceiptPath(root, original.id);
  const originalManifestText = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(originalManifestText) as Record<string, unknown>;
  delete manifest.recipeSha;
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  expect(readGateShardResult(root, expected)).toBeNull();
  writeFileSync(manifestPath, originalManifestText);
  writeFileSync(join(root, saved.evidencePath), readFileSync(join(root, saved.evidencePath), 'utf8') + 'tampered');
  expect(readGateShardResult(root, expected)).toBeNull();
});

test('a radius-proven unchanged shard is carried to the descendant head with its measured bytes intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-carry-')); roots.push(root);
  const original = receipt();
  const saved = saveGateShardResult(root, { receipt: original,
    runs: [{ output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ['src/a.test.ts > pass'] }] });
  const measured = readGateShardResult(root, { shard: original, head40: original.head40, base40: original.base40, envKey: original.envKey });
  expect(measured).not.toBeNull();
  const descendant = '9'.repeat(40);
  const carried = carryGateShardResult(root, measured!, descendant);
  expect(carried).toMatchObject({ head40: descendant, measuredAt: original.measuredAt, attempt: original.attempt, status: 'complete' });
  expect(carried.evidencePath).not.toBe(saved.evidencePath);
  expect(readGateShardResult(root, { shard: original, head40: descendant, base40: original.base40, envKey: original.envKey })?.runs[0]?.passedIds)
    .toEqual(['src/a.test.ts > pass']);
  expect(readFileSync(join(root, saved.evidencePath), 'utf8')).toContain('src/a.test.ts > pass');
});

test('receipt payload rejects incomplete passed IDs and inconsistent execution counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-')); roots.push(root);
  const incompletePass = receipt();
  saveGateShardResult(root, { receipt: incompletePass,
    runs: [{ output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: [] }] });
  expect(readGateShardResult(root, { shard: incompletePass, head40: incompletePass.head40, base40: incompletePass.base40, envKey: incompletePass.envKey })).toBeNull();
  const inconsistent = { ...receipt(), id: 'pod-1', files: ['src/b.test.ts'], testedFileHashes: { 'src/b.test.ts': 'b'.repeat(64) } };
  saveGateShardResult(root, { receipt: inconsistent,
    runs: [{ output: '1 pass\n0 fail\nRan 2 tests across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 2, files: 1, passedIds: ['src/b.test.ts > pass'] }] });
  expect(readGateShardResult(root, { shard: inconsistent, head40: inconsistent.head40, base40: inconsistent.base40, envKey: inconsistent.envKey })).toBeNull();
});

test('GATE-SHARD-RECEIPT-PAYLOAD-CORRUPT: a replacement attempt gets a fresh payload path', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-attempt-')); roots.push(root);
  const first = receipt();
  const firstSaved = saveGateShardResult(root, { receipt: first,
    runs: [{ output: '1 pass', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ['src/a.test.ts > first'] }] });
  const secondSaved = saveGateShardResult(root, { receipt: { ...first, attempt: 2 },
    runs: [{ output: '1 pass', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ['src/a.test.ts > second'] }] });
  expect(secondSaved.evidencePath).not.toBe(firstSaved.evidencePath);
  expect(readGateShardResult(root, { shard: first, head40: first.head40, base40: first.base40, envKey: first.envKey })?.runs[0]?.passedIds)
    .toEqual(['src/a.test.ts > second']);
  expect(readFileSync(join(root, firstSaved.evidencePath), 'utf8')).toContain('first');
});

test("formal receipt inspection rejects version and graph pin mismatches", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-receipt-inspection-")); roots.push(root);
  const original = receipt();
  saveGateShardResult(root, { receipt: original,
    runs: [{ output: "1 pass\n0 fail\nRan 1 test across 1 file.\n", rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ["src/a.test.ts > pass"] }] });
  const otherHostFingerprint = { ...original, id: 'pod-1', files: ['src/b.test.ts'], envFingerprint: 'e'.repeat(64),
    runtimeIdentity: { ...original.runtimeIdentity!, envFingerprint: 'e'.repeat(64) },
    testedFileHashes: { 'src/b.test.ts': 'b'.repeat(64) },
    executions: original.executions!.map((execution) => ({ ...execution, runtimeIdentity: { ...execution.runtimeIdentity, envFingerprint: 'e'.repeat(64) } })) };
  saveGateShardResult(root, { receipt: otherHostFingerprint,
    runs: [{ output: "1 pass\n0 fail\nRan 1 test across 1 file.\n", rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ["src/b.test.ts > pass"] }] });
  const expected = { version: original.version, commit: original.head40, base40: original.base40, envFingerprint: original.envFingerprint!,
    runtimeIdentity: { envFingerprint: original.runtimeIdentity!.envFingerprint, baseImageDigest: original.runtimeIdentity!.baseImageDigest!, platform: original.runtimeIdentity!.platform,
      architecture: original.runtimeIdentity!.architecture, bunVersion: original.runtimeIdentity!.bunVersion }, lockHash: original.lockfileHash!,
    graphPins: { graphSha: original.graphSha!, recipeSha: original.recipeSha! }, graphEntry: original.graphEntry!,
    recipeCommand: original.recipeCommand!, recipeTimeoutMs: original.recipeTimeoutMs!,
    shards: [{ id: original.id, files: original.files }, { id: otherHostFingerprint.id, files: otherHostFingerprint.files }], tests: [...original.files, ...otherHostFingerprint.files] };
  expect(inspectGateShardReceipts(root, expected).kind).toBe("valid");
  const mismatches = [
    inspectGateShardReceipts(root, { ...expected, version: "9.9.9" }),
    inspectGateShardReceipts(root, { ...expected, graphPins: { ...expected.graphPins, graphSha: "0".repeat(64) } }),
    inspectGateShardReceipts(root, { ...expected, graphPins: { ...expected.graphPins, recipeSha: "0".repeat(64) } }),
    inspectGateShardReceipts(root, { ...expected, runtimeIdentity: { ...expected.runtimeIdentity, baseImageDigest: `sha256:${'9'.repeat(64)}` } }),
    inspectGateShardReceipts(root, { ...expected, runtimeIdentity: { ...expected.runtimeIdentity, bunVersion: '1.4.3' } }),
    inspectGateShardReceipts(root, { ...expected, lockHash: '8'.repeat(64) }),
  ];
  expect(mismatches.map((result) => result.kind)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid", "invalid"]);
});

test('a replacement attempt blocks reuse of its predecessor before execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-')); roots.push(root);
  const old = receipt();
  saveGateShardResult(root, { receipt: old,
    runs: [{ output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ['src/a.test.ts > pass'] }] });
  markGateShardUnmeasured(root, { ...old, attempt: 2 });
  expect(JSON.parse(readFileSync(gateShardReceiptPath(root, old.id), 'utf8')).status).toBe('unmeasured');
  expect(readGateShardResult(root, { shard: old, head40: old.head40, base40: old.base40, envKey: old.envKey })).toBeNull();
});
