import { describe, expect, test, mock } from 'bun:test';
import { acquirePodPoolSlot, createPodPoolDistributorAdapter, TASK_HAND_POD_DISTRIBUTOR_ENTRY } from './pod-distributor.js';
import type { PodPoolMember, PodPoolScheduler } from './pod-pool.js';

const member: PodPoolMember = { context: 'pool-a', capacity: 2, k3dCluster: 'pool-a' };

function poolStub(tryAcquire: ReturnType<typeof mock>) {
  return { tryAcquire } as unknown as PodPoolScheduler;
}

describe('Pod distributor legacy adapter', () => {
  test('delegates admission to PodPoolScheduler and preserves a granted member', async () => {
    const tryAcquire = mock(async () => member);
    const pool = poolStub(tryAcquire);
    const skip = new Set(['pool-b']);
    const onEmpty = () => {};
    const mode = { kind: null };
    const request = { requestId: 'run-1:slot:1', idempotencyKey: 'run-1:slot:1', owner: { runId: 'run-1' },
      lane: 'ta' as const, workload: { memoryLimit: '16Gi', kind: 'standard' }, skip, onEmpty, mode };

    await expect(createPodPoolDistributorAdapter(pool).acquire(request)).resolves.toBe(member);
    expect(tryAcquire).toHaveBeenCalledWith(skip, onEmpty, mode);
  });

  test('uses the injected adapter only for tasks-hand; other entries retain direct pool admission', async () => {
    const tryAcquire = mock(async () => member);
    const pool = poolStub(tryAcquire);
    const acquire = mock(async () => null);
    const adapter = { acquire };
    const request = { requestId: 'run-1:slot:1', idempotencyKey: 'run-1:slot:1', owner: { runId: 'run-1', cardId: 'ta-1' },
      lane: 'ta' as const, workload: { memoryLimit: '16Gi', kind: 'standard' }, mode: { kind: null } };

    await expect(acquirePodPoolSlot({ entry: TASK_HAND_POD_DISTRIBUTOR_ENTRY, pool, adapter, request })).resolves.toBeNull();
    expect(acquire).toHaveBeenCalledWith(request);
    expect(tryAcquire).not.toHaveBeenCalled();

    await expect(acquirePodPoolSlot({ entry: 'dispatcher', pool, adapter, request })).resolves.toBe(member);
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
