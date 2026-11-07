import { expect, test } from 'bun:test';
import { gateProgressTransitionKey, gateShardRuntimeIdentityKey, planGateReceiptRadius, planGateShardDispatch, summarizeGateProgress, type GateShardReceipt } from './gate-shard-dispatch.js';

test('gate progress preserves running → retry → running attempt transitions', () => {
  const observations = [
    { id: 'pod-0', state: 'running' as const, rawState: 'running', attemptId: 'attempt-1', failureCount: null },
    { id: 'pod-0', state: 'running' as const, rawState: 'retry', failureCount: null },
    { id: 'pod-0', state: 'running' as const, rawState: 'running', attemptId: 'attempt-2', failureCount: null },
  ];
  const keys = observations.map(gateProgressTransitionKey);
  expect(new Set(keys).size).toBe(3);
  expect(gateProgressTransitionKey(observations[2]!)).toBe(gateProgressTransitionKey(observations[2]!));
});
test('receipt baseline radius proof reaches dispatch and rejects mixed receipt heads', () => {
  const priorCommit = 'a'.repeat(40), currentCommit = 'b'.repeat(40), base40 = 'c'.repeat(40);
  const fingerprint = 'd'.repeat(64), imageDigest = `sha256:${'e'.repeat(64)}`;
  const lockfileHash = '9'.repeat(64);
  const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: fingerprint, baseImageDigest: 'sha256:' + 'a'.repeat(64) };
  const tests = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
  const receipts: GateShardReceipt[] = tests.map((file, index) => ({
    id: `pod-${index}`, files: [file], version: '1.0.1', head40: priorCommit, base40,
    graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64), graphEntry: 'gate-entry-v1',
    recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    host: 'aws2', envKey: gateShardRuntimeIdentityKey(runtimeIdentity, lockfileHash)!, envFingerprint: fingerprint, imageDigest, runtimeIdentity,
    lockfileHash, testedFileHashes: { [file]: String(index + 1).repeat(64) },
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
    recipeTimeoutMs: 14400000, environmentIdentity: { ...runtimeIdentity, imageDigest }, lockfileHash,
    testedFileHashesByShard: Object.fromEntries(tests.map((file, index) => [`pod-${index}`, { [file]: String(index + 1).repeat(64) }])),
  });
  expect(actions.map(({ shardId, kind }) => [shardId, kind])).toEqual([
    ['pod-0', 'run'], ['pod-1', 'reuse'], ['pod-2', 'reuse'],
  ]);
  expect(planGateReceiptRadius({ receipts: receipts.map((row, i) => i === 2 ? { ...row, head40: '9'.repeat(40) } : row),
    tests, selectedFiles: ['src/a.test.ts'], priorCommit })).toBeNull();
});

test('GATE-G runtime and tested blobs key same-cut repair reuse and changed-key reruns', () => {
  const priorCommit = 'a'.repeat(40), repairCommit = 'b'.repeat(40), base40 = 'c'.repeat(40);
  const fingerprint = 'd'.repeat(64), imageDigest = `sha256:${'e'.repeat(64)}`;
  const lockfileHash = 'f'.repeat(64);
  const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: fingerprint,
    baseImageDigest: `sha256:${'a'.repeat(64)}` };
  const graphEntry = 'gate-entry-v1', recipeCommand = 'bun scripts/release-loop/gate-node.ts --json';
  const shards = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'].map((file, index) => ({ id: `pod-${index}`, files: [file] }));
  const hashes = Object.fromEntries(shards.map((shard, index) => [shard.id, { [shard.files[0]!]: String(index + 1).repeat(64) }]));
  const receipts: GateShardReceipt[] = shards.map((shard, index) => ({
    ...shard, version: '1.0.1', head40: priorCommit, base40,
    graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64), graphEntry,
    recipeCommand, recipeTimeoutMs: 14400000, host: 'pool-old', envKey: gateShardRuntimeIdentityKey(runtimeIdentity, lockfileHash)!,
    envFingerprint: fingerprint, imageDigest, runtimeIdentity, lockfileHash, testedFileHashes: hashes[shard.id],
    executions: [{ branch: '', attemptId: `attempt-${index}`, host: 'pool-old', imageDigest, runtimeIdentity }],
    status: 'complete', failureIds: index === 1 ? ['src/b.test.ts > failed before repair'] : [], errorIds: [],
    evidencePath: `${shard.id}.result.json`, evidenceSha256: 'f'.repeat(64), measuredAt: '2026-11-07T00:00:00.000Z', attempt: 1,
  }));
  const hosts = [{ id: 'pool-new', platform: 'linux' as const, available: true, reserved: false }];
  const common = { base40, shards, receipts, hosts, graphEntry, recipeCommand, recipeTimeoutMs: 14400000,
    environmentIdentity: { ...runtimeIdentity, imageDigest }, lockfileHash, testedFileHashesByShard: hashes };

  // Same-cut fail → repair → regate: the failed shard is replaced while two passing shard results are reused (N=2).
  const repairedCut = planGateShardDispatch({ ...common, head40: repairCommit,
    radiusUnchangedShardIds: ['pod-0', 'pod-2'], invalidatedShardIds: ['pod-1'] });
  expect(repairedCut.map((action) => [action.shardId, action.kind])).toEqual([
    ['pod-0', 'reuse'], ['pod-1', 'run'], ['pod-2', 'reuse'],
  ]);
  expect(repairedCut.filter((action) => action.kind === 'reuse')).toHaveLength(2);

  // A repair commit changes the SHA; matching runtime and tested blobs still reuse passing shards.
  const imageRotation = planGateShardDispatch({ ...common, head40: repairCommit, radiusUnchangedShardIds: shards.map((shard) => shard.id),
    environmentIdentity: { ...runtimeIdentity, imageDigest: `sha256:${'9'.repeat(64)}` } });
  expect(imageRotation.map((action) => action.kind)).toEqual(['reuse', 'run', 'reuse']);
  const changedBlobMap = { ...hashes, 'pod-1': { 'src/b.test.ts': '9'.repeat(64) } };
  const changedBlob = planGateShardDispatch({ ...common, head40: repairCommit, radiusUnchangedShardIds: shards.map((shard) => shard.id),
    testedFileHashesByShard: changedBlobMap });
  expect(changedBlob.map((action) => action.kind)).toEqual(['reuse', 'run', 'reuse']);
  for (const field of ['bunVersion', 'platform', 'architecture', 'baseImageDigest'] as const) {
    const changedRuntime = planGateShardDispatch({ ...common, head40: repairCommit, radiusUnchangedShardIds: shards.map((shard) => shard.id),
      environmentIdentity: { ...runtimeIdentity, imageDigest,
        [field]: field === 'baseImageDigest' ? `sha256:${'8'.repeat(64)}` : 'changed' } });
    expect(changedRuntime.every((action) => action.kind === 'run')).toBe(true);
  }
  const changedHostFingerprint = planGateShardDispatch({ ...common, head40: repairCommit, radiusUnchangedShardIds: shards.map((shard) => shard.id),
    environmentIdentity: { ...runtimeIdentity, envFingerprint: '8'.repeat(64), imageDigest } });
  expect(changedHostFingerprint.map((action) => action.kind)).toEqual(['reuse', 'run', 'reuse']);
  const changedLockfile = planGateShardDispatch({ ...common, head40: repairCommit, radiusUnchangedShardIds: shards.map((shard) => shard.id),
    lockfileHash: '8'.repeat(64) });
  expect(changedLockfile.every((action) => action.kind === 'run')).toBe(true);
  const missingLockfile = planGateShardDispatch({ ...common, head40: repairCommit, radiusUnchangedShardIds: shards.map((shard) => shard.id), lockfileHash: undefined });
  expect(missingLockfile.every((action) => action.kind === 'run')).toBe(true);
  expect(missingLockfile[0]?.reason).toBe('runtime-lockfile-unmeasured');
  const missingFileHashes = planGateShardDispatch({ ...common, head40: repairCommit, radiusUnchangedShardIds: shards.map((shard) => shard.id), testedFileHashesByShard: {} });
  expect(missingFileHashes.every((action) => action.kind === 'run')).toBe(true);
  expect(missingFileHashes[0]?.reason).toBe('tested-file-identity-unmeasured');
  const failedReceipt = receipts.map((receipt) => receipt.id === 'pod-0' ? { ...receipt, failureIds: ['src/a.test.ts > fail'] } : receipt);
  const failedReceiptPlan = planGateShardDispatch({ ...common, head40: priorCommit, receipts: failedReceipt });
  expect(failedReceiptPlan.map((action) => action.kind)).toEqual(['run', 'run', 'reuse']);
  expect(failedReceiptPlan[0]?.reason).toBe('receipt-unavailable');
});

test('receipt radius carries untouched shards across an appended test file and schedules the addition', () => {
  const priorCommit = 'a'.repeat(40), base40 = 'c'.repeat(40);
  const fingerprint = 'd'.repeat(64), imageDigest = `sha256:${'e'.repeat(64)}`;
  const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: fingerprint, baseImageDigest: 'sha256:' + 'a'.repeat(64) };
  const priorTests = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
  const receipts: GateShardReceipt[] = priorTests.map((file, index) => ({
    id: `pod-${index}`, files: [file], version: '1.0.1', head40: priorCommit, base40,
    graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64), graphEntry: 'gate-entry-v1',
    recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    host: 'pool-old', envKey: gateShardRuntimeIdentityKey(runtimeIdentity, '9'.repeat(64))!, envFingerprint: fingerprint, imageDigest, runtimeIdentity,
    lockfileHash: '9'.repeat(64),
    executions: [{ branch: '', attemptId: `attempt-${index}`, host: 'pool-old', imageDigest, runtimeIdentity }],
    status: 'complete', failureIds: [], errorIds: [], evidencePath: `pod-${index}.result.json`,
    evidenceSha256: 'f'.repeat(64), measuredAt: '2026-11-06T00:00:00.000Z', attempt: 1,
  }));
  const appended = planGateReceiptRadius({ receipts, tests: [...priorTests, 'src/d.test.ts'], selectedFiles: ['src/d.test.ts'], priorCommit });
  expect(appended).toMatchObject({
    shards: [
      { id: 'pod-0', files: ['src/a.test.ts'] }, { id: 'pod-1', files: ['src/b.test.ts'] },
      { id: 'pod-2', files: ['src/c.test.ts'] }, { id: 'pod-3', files: ['src/d.test.ts'] },
    ],
    invalidatedShardIds: ['pod-3'], unchangedShardIds: ['pod-0', 'pod-1', 'pod-2'],
  });
  expect(planGateReceiptRadius({ receipts, tests: ['src/b.test.ts', 'src/c.test.ts'], selectedFiles: [], priorCommit })).toBeNull();
});

test('dispatch reuses when runtime tuple and tested files match despite image digest rotation', () => {
  const head40 = 'a'.repeat(40), base40 = 'b'.repeat(40), fingerprint = 'c'.repeat(64);
  const priorImage = 'sha256:' + 'd'.repeat(64), currentImage = 'sha256:' + 'e'.repeat(64);
  const lockfileHash = '9'.repeat(64), testedFileHashes = { 'src/a.test.ts': 'a'.repeat(64) };
  const runtime = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: fingerprint, baseImageDigest: 'sha256:' + 'f'.repeat(64) };
  const receipt: GateShardReceipt = { id: 'pod-0', files: ['src/a.test.ts'], version: '1.0.1', head40: '9'.repeat(40), base40,
    graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64), graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    host: 'node-c', envKey: gateShardRuntimeIdentityKey(runtime, lockfileHash)!, envFingerprint: fingerprint, imageDigest: priorImage, runtimeIdentity: runtime,
    lockfileHash, testedFileHashes,
    executions: [{ branch: '', attemptId: 'attempt-0', host: 'node-c', imageDigest: priorImage, runtimeIdentity: runtime }],
    status: 'complete', failureIds: [], errorIds: [], evidencePath: 'pod-0.json', evidenceSha256: 'a'.repeat(64), measuredAt: '2026-11-03T00:00:00.000Z', attempt: 1 };
  const actions = planGateShardDispatch({ head40, base40, shards: [{ id: 'pod-0', files: ['src/a.test.ts'] }], receipts: [receipt],
    radiusUnchangedShardIds: ['pod-0'], hosts: [{ id: 'node-c', platform: 'linux', available: true, reserved: false }],
    graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    lockfileHash, testedFileHashesByShard: { 'pod-0': testedFileHashes },
    environmentIdentity: { ...runtime, imageDigest: currentImage } });
  expect(actions).toMatchObject([{ kind: 'reuse', reason: expect.stringContaining('unchanged-radius') }]);
  const unmeasuredImage = planGateShardDispatch({ head40, base40, shards: [{ id: 'pod-0', files: ['src/a.test.ts'] }], receipts: [receipt],
    radiusUnchangedShardIds: ['pod-0'], hosts: [{ id: 'node-c', platform: 'linux', available: true, reserved: false }],
    graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
    environmentIdentity: runtime, lockfileHash, testedFileHashesByShard: { 'pod-0': testedFileHashes } });
  expect(unmeasuredImage).toMatchObject([{ kind: 'run' }]);
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
