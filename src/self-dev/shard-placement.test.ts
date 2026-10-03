import { expect, test } from 'bun:test';
import type { PoolLeaseMeasure, PodLeaseMember } from '../task-orchestrator/surfaces/pod-lease.js';
import type { GateTestShard } from './shard-plan.js';
import { assignGateShardsToPool } from './shard-placement.js';

const GiB = 1024 ** 3;
const shard = (i: number): GateTestShard => ({ id: `shard-${i}`, files: [`test/${i}.test.ts`], plannedRssMb: 1024, plannedSeconds: 1 });
const member = (context: string, freeGiB: number, capacity = 5): PodLeaseMember => ({
  context, capacity, running: 0, pending: 0, unleasedRunning: 0, memoryLimitBytes: 0, allocatableMemoryBytes: freeGiB * GiB,
  allocatableCpuMillicores: 1000, availableMemoryByNodeBytes: [freeGiB * GiB], reason: null,
});
const pool: PoolLeaseMeasure = { members: [member('pool-node-b', 32), member('pool-node-c', 16)] };
const shards = Array.from({ length: 5 }, (_, i) => shard(i + 1));

test('five bundles distribute 3:2 across two fake Pod lease members by remaining memory', () => {
  const placement = assignGateShardsToPool(shards, pool);
  expect(placement).toEqual([
    { shardId: 'shard-1', context: 'pool-node-b' },
    { shardId: 'shard-2', context: 'pool-node-c' },
    { shardId: 'shard-3', context: 'pool-node-b' },
    { shardId: 'shard-4', context: 'pool-node-b' },
    { shardId: 'shard-5', context: 'pool-node-c' },
  ]);
  expect(assignGateShardsToPool(shards, { members: [...pool.members].reverse() })).toEqual(placement);
});

test('dead member moves only its shards and leaves surviving shard placements unchanged', () => {
  const initial = assignGateShardsToPool(shards, pool);
  const recovered = assignGateShardsToPool(shards, pool, initial, 'pool-node-c');
  expect(recovered.filter((entry) => entry.context === 'pool-node-b')).toHaveLength(5);
  expect(recovered.filter((entry) => initial.find((old) => old.shardId === entry.shardId)?.context === 'pool-node-b'))
    .toEqual(initial.filter((entry) => entry.context === 'pool-node-b'));
  expect(initial).toEqual(assignGateShardsToPool(shards, pool));
});

test('unmeasured or insufficient lease fails closed rather than fabricating a machine', () => {
  expect(() => assignGateShardsToPool(shards, { members: [member('pool-node-b', 8), member('pool-node-c', 8)] }))
    .toThrow('no pool lease memory for shard');
  expect(() => assignGateShardsToPool([shard(1)], { members: [{ ...member('pool-node-b', 8), availableMemoryByNodeBytes: null }] }))
    .toThrow('no pool lease memory for shard');
  expect(() => assignGateShardsToPool(shards, { members: [member('pool-node-b', 8), member('pool-node-c', 8)] },
    assignGateShardsToPool(shards, pool), 'pool-node-c')).toThrow('placed shard exceeds pool lease');
});
