import type { PodPoolMember, PodPoolScheduler } from './pod-pool.js';
export { POD_DISTRIBUTOR_ENTRY_ENV, TASK_HAND_POD_DISTRIBUTOR_ENTRY } from '../../task-agent/pod-distributor-entry.js';
import { TASK_HAND_POD_DISTRIBUTOR_ENTRY } from '../../task-agent/pod-distributor-entry.js';

/** Origin marker carried only by `tasks hand` Pod launches. */
export type PodPoolAcquireMode = NonNullable<Parameters<PodPoolScheduler['tryAcquire']>[2]>;

/** Admission context that the later resource-core adapter can map to its request contract. */
export interface PodDistributorAdmission {
  requestId: string;
  idempotencyKey: string;
  owner: { runId: string; cardId?: string; seat?: string };
  lane: 'ta';
  workload: { memoryLimit: string; kind: string };
  skip?: ReadonlySet<string>;
  onEmpty?: (reason: string) => void;
  mode?: PodPoolAcquireMode;
}

/**
 * Small seam between a Pod launch surface and its admission backend.
 * The current adapter delegates to PodPoolScheduler, which owns the existing HostPoolLease accounting.
 * CORE can replace this adapter with resource admission without changing the tasks-hand call site.
 */
export interface PodDistributorAdapter {
  acquire(request: PodDistributorAdmission): Promise<PodPoolMember | null>;
}

export function createPodPoolDistributorAdapter(pool: PodPoolScheduler): PodDistributorAdapter {
  // The legacy pool has no consumer for identity/workload fields; preserve them at this seam for CORE.
  return {
    acquire: ({ skip, onEmpty, mode }) => pool.tryAcquire(skip, onEmpty, mode),
  };
}

/** Only the tasks-hand entry uses the adapter in this first wire slice; other launchers keep the established path. */
export function acquirePodPoolSlot(input: {
  entry: string | undefined;
  pool: PodPoolScheduler;
  adapter?: PodDistributorAdapter;
  request: PodDistributorAdmission;
}): Promise<PodPoolMember | null> {
  const { entry, pool, adapter, request } = input;
  if (entry === TASK_HAND_POD_DISTRIBUTOR_ENTRY) {
    return (adapter ?? createPodPoolDistributorAdapter(pool)).acquire(request);
  }
  return pool.tryAcquire(request.skip, request.onEmpty, request.mode);
}
