import { expect, test } from 'bun:test';
import { planGateReceiptRadius, planGateShardDispatch, summarizeGateProgress, type GateShardReceipt } from './gate-shard-dispatch.js';

test('receipt baseline radius proof reaches dispatch and rejects mixed receipt heads', () => {
  const priorCommit = 'a'.repeat(40), currentCommit = 'b'.repeat(40), base40 = 'c'.repeat(40);
  const fingerprint = 'd'.repeat(64), imageDigest = `sha256:${'e'.repeat(64)}`;
  const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: fingerprint, baseImageDigest: 'sha256:' + 'a'.repeat(64) };
  const tests = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
  const receipts: GateShardReceipt[] = tests.map((file, index) => ({
    id: `pod-${index}`, files: [file], version: '1.0.1', head40: priorCommit, base40,
    graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64), graphEntry: 'gate-entry-v1',
    recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    host: 'aws2', envKey: `${fingerprint}:${imageDigest}`, envFingerprint: fingerprint, imageDigest, runtimeIdentity,
    executions: [{ branch: '', attemptId: `attempt-${index}`, host: 'aws2', imageDigest, runtimeIdentity }],
    status: 'complete', failureIds: [], errorIds: [], evidencePath: `pod-${index}.result.json`,
    evidenceSha256: 'f'.repeat(64), measuredAt: '2026-11-02T00:00:00.000Z', attempt: 1,
  }));
  const radius = planGateReceiptRadius({ receipts, tests, selectedFiles: ['src/a.test.ts'], priorCommit });
  expect(radius).toMatchObject({ invalidatedShardIds: ['pod-0'], unchangedShardIds: ['pod-1', 'pod-2'] });
  expect(planGateReceiptRadius({ receipts, tests, selectedFiles: [], priorCommit })).toMatchObject({
    invalidatedShardIds: [], unchangedShardIds: ['pod-0', 'pod-1', 'pod-2'],
  });
  const proof = radius!;
  const actions = planGateShardDispatch({
    head40: currentCommit, base40, shards: proof.shards, receipts,
    invalidatedShardIds: proof.invalidatedShardIds, radiusUnchangedShardIds: proof.unchangedShardIds,
    hosts: [{ id: 'node-b', platform: 'linux', available: true, reserved: false }],
    graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json',
    recipeTimeoutMs: 14400000, environmentIdentity: { ...runtimeIdentity, imageDigest },
  });
  expect(actions.map(({ shardId, kind }) => [shardId, kind])).toEqual([
    ['pod-0', 'run'], ['pod-1', 'reuse'], ['pod-2', 'reuse'],
  ]);
  expect(planGateReceiptRadius({ receipts: receipts.map((row, i) => i === 2 ? { ...row, head40: '9'.repeat(40) } : row),
    tests, selectedFiles: ['src/a.test.ts'], priorCommit })).toBeNull();
});

test('dispatch reruns an unchanged-radius shard when its receipt image differs from current environment image', () => {
  const head40 = 'a'.repeat(40), base40 = 'b'.repeat(40), fingerprint = 'c'.repeat(64);
  const priorImage = 'sha256:' + 'd'.repeat(64), currentImage = 'sha256:' + 'e'.repeat(64);
  const runtime = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: fingerprint, baseImageDigest: 'sha256:' + 'f'.repeat(64) };
  const receipt: GateShardReceipt = { id: 'pod-0', files: ['src/a.test.ts'], version: '1.0.1', head40: '9'.repeat(40), base40,
    graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64), graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    host: 'node-c', envKey: fingerprint + ':' + priorImage, envFingerprint: fingerprint, imageDigest: priorImage, runtimeIdentity: runtime,
    status: 'complete', failureIds: [], errorIds: [], evidencePath: 'pod-0.json', evidenceSha256: 'a'.repeat(64), measuredAt: '2026-11-03T00:00:00.000Z', attempt: 1 };
  const actions = planGateShardDispatch({ head40, base40, shards: [{ id: 'pod-0', files: ['src/a.test.ts'] }], receipts: [receipt],
    radiusUnchangedShardIds: ['pod-0'], hosts: [{ id: 'node-c', platform: 'linux', available: true, reserved: false }],
    graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    environmentIdentity: { ...runtime, imageDigest: currentImage } });
  expect(actions).toMatchObject([{ kind: 'run', reason: 'environment-imageDigest-mismatch' }]);
  const unmeasuredImage = planGateShardDispatch({ head40, base40, shards: [{ id: 'pod-0', files: ['src/a.test.ts'] }], receipts: [receipt],
    radiusUnchangedShardIds: ['pod-0'], hosts: [{ id: 'node-c', platform: 'linux', available: true, reserved: false }],
    graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000, environmentIdentity: runtime });
  expect(unmeasuredImage).toMatchObject([{ kind: 'run', reason: 'environment-imageDigest-mismatch' }]);
});

test('gate progress summary counts settled serial groups and records the active host group duration', () => {
  expect(summarizeGateProgress({ executor: 'host', nowMs: 65_000, groups: [
    { id: 'src-cli', state: 'done', host: 'node-c', startedAtMs: 10_000, endedAtMs: 30_000 },
    { id: 'src-rest', state: 'running', host: 'node-c', startedAtMs: 40_000 },
    { id: 'test', state: 'pending', host: 'node-c' },
  ] })).toEqual({
    executor: 'host', host: 'node-c', completed: 1, total: 3, failed: 0,
    groups: [
      { id: 'src-cli', state: 'done', host: 'node-c', elapsedMs: 20_000 },
      { id: 'src-rest', state: 'running', host: 'node-c', elapsedMs: 25_000 },
      { id: 'test', state: 'pending', host: 'node-c', elapsedMs: null },
    ],
  });
});

test('gate progress summary reports multi-host Pod shards and terminal failures without changing the gate verdict', () => {
  expect(summarizeGateProgress({ executor: 'pod', nowMs: 90_000, groups: [
    { id: 'pod-0', state: 'done', host: 'pool-a', startedAtMs: 0, endedAtMs: 80_000 },
    { id: 'pod-1', state: 'timeout', host: 'pool-b', startedAtMs: 10_000 },
    { id: 'pod-2', state: 'pending' },
  ] })).toEqual({
    executor: 'pod', host: 'pool-a,pool-b', completed: 2, total: 3, failed: 1,
    groups: [
      { id: 'pod-0', state: 'done', host: 'pool-a', elapsedMs: 80_000 },
      { id: 'pod-1', state: 'timeout', host: 'pool-b', elapsedMs: 80_000 },
      { id: 'pod-2', state: 'pending', host: null, elapsedMs: null },
    ],
  });
});
