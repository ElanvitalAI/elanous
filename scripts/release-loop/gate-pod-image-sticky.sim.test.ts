import { expect, test } from 'bun:test';
import { planStickyGateImages } from './gate-pod-image-sticky-plan.js';

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const digestC = `sha256:${'c'.repeat(64)}`;
const pools = [
  { id: 'node-b', available: true, imageDigest: digestA },
  { id: 'node-c', available: true, imageDigest: digestB },
  { id: 'minim5', available: true, imageDigest: digestC },
];
const shards = [
  { id: 'pod-0', files: ['src/a.test.ts'] },
  { id: 'pod-1', files: ['src/b.test.ts'] },
  { id: 'pod-2', files: ['src/c.test.ts'] },
];

test('GATE-POD-IMAGE-STICKY sim: a three-pool start pins one digest and excludes different-digest pools', () => {
  const plan = planStickyGateImages({ phase: 'start', pools, shards });

  expect(plan).toMatchObject({ mode: 'full', pinnedDigest: digestA, excludedPools: ['node-c', 'minim5'] });
  expect(plan.shards).toEqual(shards.map((shard) => ({
    shardId: shard.id, files: shard.files, kind: 'run', pool: 'node-b', imageDigest: digestA,
  })));
  expect(new Set(plan.shards.map((item) => item.imageDigest))).toEqual(new Set([digestA]));
});

test('GATE-POD-IMAGE-STICKY sim: resume reuses completed receipts and reruns only the stalled shard at the pinned digest', () => {
  const plan = planStickyGateImages({ phase: 'resume', pinnedDigest: digestA, pools, shards,
    receipts: [
      { shardId: 'pod-0', status: 'complete', pool: 'node-b', imageDigest: digestA },
      { shardId: 'pod-1', status: 'complete', pool: 'node-b', imageDigest: digestA },
      { shardId: 'pod-2', status: 'stalled', pool: 'node-b', imageDigest: digestA },
    ] });

  expect(plan).toMatchObject({ mode: 'partial', pinnedDigest: digestA, excludedPools: ['node-c', 'minim5'] });
  expect(plan.shards).toEqual([
    { shardId: 'pod-0', files: ['src/a.test.ts'], kind: 'reuse', pool: 'node-b', imageDigest: digestA },
    { shardId: 'pod-1', files: ['src/b.test.ts'], kind: 'reuse', pool: 'node-b', imageDigest: digestA },
    { shardId: 'pod-2', files: ['src/c.test.ts'], kind: 'run', pool: 'node-b', imageDigest: digestA },
  ]);
});

test('GATE-POD-IMAGE-STICKY sim: resume without a recorded run digest stays fail-closed', () => {
  const plan = planStickyGateImages({ phase: 'resume', pools, shards,
    receipts: [{ shardId: 'pod-0', status: 'complete', pool: 'node-b', imageDigest: digestA }] });

  expect(plan).toMatchObject({ mode: 'HOLD', pinnedDigest: null, reason: 'run image digest missing' });
  expect(plan.shards.every((item) => item.kind === 'unmeasured')).toBe(true);
});

test('GATE-POD-IMAGE-STICKY sim: uppercase hex digest receipts normalize to the pinned digest', () => {
  const upperDigestA = digestA.replace(/[a-f]/g, (hex) => hex.toUpperCase());
  const plan = planStickyGateImages({ phase: 'resume', pinnedDigest: digestA,
    pools: [{ id: 'node-b', available: true, imageDigest: upperDigestA }], shards,
    receipts: [{ shardId: 'pod-0', status: 'complete', pool: 'node-b', imageDigest: upperDigestA },
      { shardId: 'pod-1', status: 'stalled', pool: 'node-b', imageDigest: digestA }] });

  expect(plan).toMatchObject({ mode: 'partial', pinnedDigest: digestA });
  expect(plan.shards[0]).toMatchObject({ kind: 'reuse', imageDigest: digestA });
  expect(plan.shards.slice(1).every((item) => item.kind === 'run' && item.imageDigest === digestA)).toBe(true);
});

test('GATE-POD-IMAGE-STICKY sim: mixed completed receipt digests cannot be partially reused', () => {
  const plan = planStickyGateImages({ phase: 'resume', pinnedDigest: digestA, pools, shards,
    receipts: [
      { shardId: 'pod-0', status: 'complete', pool: 'node-b', imageDigest: digestA },
      { shardId: 'pod-1', status: 'complete', pool: 'node-c', imageDigest: digestB },
      { shardId: 'pod-2', status: 'stalled', pool: 'minim5', imageDigest: digestC },
    ] });

  expect(plan).toMatchObject({ mode: 'full', pinnedDigest: digestA,
    reason: 'completed receipts contain a different image digest' });
  expect(plan.shards.every((item) => item.kind === 'run' && item.imageDigest === digestA)).toBe(true);
  expect(plan.shards.some((item) => item.pool !== 'node-b')).toBe(false);
});

test('GATE-POD-IMAGE-STICKY sim: a completed receipt without pool identity forces a full sweep with an accurate reason', () => {
  const incompleteReceipts = [
    { shardId: 'pod-0', status: 'complete' as const, pool: ' ', imageDigest: digestA },
    { shardId: 'pod-0', status: 'complete' as const, pool: null, imageDigest: digestA },
    { shardId: 'pod-0', status: 'complete' as const, imageDigest: digestA },
  ];

  for (const receipt of incompleteReceipts) {
    const plan = planStickyGateImages({ phase: 'resume', pinnedDigest: digestA, pools, shards,
      receipts: [receipt, { shardId: 'pod-1', status: 'stalled', pool: 'node-b', imageDigest: digestA }] });
    expect(plan).toMatchObject({ mode: 'full', pinnedDigest: digestA,
      reason: 'completed receipt is missing pool identity' });
    expect(plan.shards.every((item) => item.kind === 'run' && item.imageDigest === digestA)).toBe(true);
  }
});

test('GATE-POD-IMAGE-STICKY sim: if no pool has the pinned digest, the resume plan never falls back to another image', () => {
  const plan = planStickyGateImages({ phase: 'resume', pinnedDigest: digestA,
    pools: pools.map((pool) => ({ ...pool, available: pool.id !== 'node-b' })), shards,
    receipts: [{ shardId: 'pod-0', status: 'complete', pool: 'node-b', imageDigest: digestA },
      { shardId: 'pod-1', status: 'stalled', pool: 'node-b', imageDigest: digestA }] });

  expect(plan).toMatchObject({ mode: 'HOLD', pinnedDigest: digestA, reason: 'no available pool has the pinned digest' });
  expect(plan.shards.some((item) => item.kind === 'run' && item.imageDigest !== digestA)).toBe(false);
  expect(plan.excludedPools).toContain('node-b');
});

test('GATE-POD-IMAGE-STICKY sim: malformed inventories, receipts, or start digests stay HOLD and unmeasured', () => {
  const duplicateShards = planStickyGateImages({ phase: 'start', pools, shards: [shards[0]!, shards[0]!] });
  const mismatchedReceipts = planStickyGateImages({ phase: 'resume', pinnedDigest: digestA, pools, shards,
    receipts: [{ shardId: 'unknown', status: 'complete', pool: 'node-b', imageDigest: digestA }] });
  const noDigestPool = planStickyGateImages({ phase: 'start', pools: [{ id: 'empty', available: true, imageDigest: null }], shards });
  const invalidPinnedDigest = planStickyGateImages({ phase: 'start', pinnedDigest: 'sha256:invalid', pools, shards });
  const missingPoolId = planStickyGateImages({ phase: 'start', pools: [{ available: true, imageDigest: digestA }], shards });
  const nullPoolId = planStickyGateImages({ phase: 'start', pools: [{ id: null, available: true, imageDigest: digestA }], shards });
  const missingShardId = planStickyGateImages({ phase: 'start', pools, shards: [{ files: ['src/a.test.ts'] }] });
  const nullShardId = planStickyGateImages({ phase: 'start', pools, shards: [{ id: null, files: ['src/a.test.ts'] }] });
  const nullShardFiles = planStickyGateImages({ phase: 'start', pools, shards: [{ id: 'pod-null-files', files: null }] });

  const invalidPlans = [duplicateShards, mismatchedReceipts, noDigestPool, invalidPinnedDigest,
    missingPoolId, nullPoolId, missingShardId, nullShardId, nullShardFiles];
  for (const plan of invalidPlans) {
    expect(plan.mode).toBe('HOLD');
    expect(plan.shards.every((item) => item.kind === 'unmeasured')).toBe(true);
  }
  expect(duplicateShards.reason).toBe('invalid pool or shard identity');
  expect(mismatchedReceipts.reason).toBe('receipt inventory does not match the shard plan');
  expect(noDigestPool.reason).toBe('no available pool has a valid image digest');
  expect(invalidPinnedDigest.reason).toBe('invalid pinned image digest');
  for (const plan of invalidPlans.slice(4)) expect(plan.reason).toBe('invalid pool or shard identity');
});
