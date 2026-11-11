import { listHarnessQueue, type QueueItem } from '../../harness/harness-queue.js';
import { readShardHostResources } from '../../self-dev/shard-run.js';

type HostReading = NonNullable<ReturnType<typeof readShardHostResources>>;
export type PressureAxis = { status: 'shortage' | 'sufficient' | 'unknown'; observed: number | null; source: string };
export interface LocalPressure {
  observedAt: string;
  cpu: PressureAxis; memory: PressureAxis; disk: PressureAxis; queue: PressureAxis;
  shortage: boolean;
}
export interface PressureLimits { maxLoadPerCore: number; minFreeMemoryGiB: number; minFreeTmpGiB: number; maxQueued: number }
export const DEFAULT_PRESSURE_LIMITS: PressureLimits = { maxLoadPerCore: 1, minFreeMemoryGiB: 4, minFreeTmpGiB: 8, maxQueued: 10 };

const axis = (value: number | undefined, shortage: (value: number) => boolean, source: string): PressureAxis =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? { status: shortage(value) ? 'shortage' : 'sufficient', observed: value, source }
    : { status: 'unknown', observed: null, source };

/** Pure projection of existing gate host reading and harness queue; no new probe or GCP call. */
export function pressureFromExisting(host: HostReading | undefined, queue: readonly Pick<QueueItem, 'status'>[] | undefined,
  at: Date, limits: PressureLimits = DEFAULT_PRESSURE_LIMITS): LocalPressure {
  const cpu = axis(host && host.cores > 0 && host.load1 !== undefined ? host.load1 / host.cores : undefined,
    value => value >= limits.maxLoadPerCore, 'self-dev/shard-run:load1/cores');
  const memory = axis(host?.freeMemoryGiB, value => value < limits.minFreeMemoryGiB, 'self-dev/shard-run:freeMemoryGiB');
  const disk = axis(host?.freeTmpGiB, value => value < limits.minFreeTmpGiB, 'self-dev/shard-run:freeTmpGiB');
  const queued = queue?.filter(row => row.status === 'queued').length;
  const queueAxis = axis(queued, value => value >= limits.maxQueued, 'harness/queue:queued');
  return { observedAt: at.toISOString(), cpu, memory, disk, queue: queueAxis,
    shortage: [cpu, memory, disk, queueAxis].some(item => item.status === 'shortage') };
}

/** Reuses the product's existing local readers; errors stay unknown. */
export function readLocalPressure(deps: {
  host?: () => HostReading | undefined; queue?: () => QueueItem[]; now?: () => Date; limits?: PressureLimits;
} = {}): LocalPressure {
  let host: HostReading | undefined;
  let queue: QueueItem[] | undefined;
  try { host = (deps.host ?? readShardHostResources)(); } catch { /* unknown */ }
  try { queue = (deps.queue ?? (() => listHarnessQueue()))(); } catch { /* unknown */ }
  return pressureFromExisting(host, queue, (deps.now ?? (() => new Date()))(), deps.limits);
}
