import { getUserConfig } from '../../user-config.js';
import { readHqLease, type HqDeps } from '../../hq/hq.js';
import { measurePoolLease, type PoolLeaseMeasure } from '../../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, resolvePodPoolSpec, type PodPoolMember, type PoolKubectl } from '../../task-orchestrator/surfaces/pod-pool.js';

export interface GridData {
  /** null means the arbiter could not be read, not that no lease exists. */
  hq: { record: ReturnType<typeof readHqLease>['record']; ageSeconds: number | null; expired: boolean | null; reason: string | null };
  /** Configured member order; capacity comes from measurePoolLease when available. occupied is running + pending, or null on measurement failure. */
  members: Array<{ context: string; capacity: number; running: number | null; pending: number | null; occupied: number | null; reason: string | null }>;
  poolReason: string | null;
}

export interface GridDeps {
  hq?: HqDeps;
  readHq?: () => ReturnType<typeof readHqLease>;
  poolSpec?: () => string | null;
  /** Optional read-only kubectl seam; never use a probe that creates Pods. */
  kubectl?: PoolKubectl;
  measure?: (members: readonly PodPoolMember[]) => PoolLeaseMeasure;
}

/** Independent, fail-soft read snapshots. No lease status/heartbeat, DNS probe Pod, host reservation or writes. */
export function buildGridData(deps: GridDeps = {}): GridData {
  let hq: GridData['hq'];
  try {
    hq = { ...(deps.readHq ?? (() => readHqLease(deps.hq)))(), reason: null };
  } catch (error) {
    hq = { record: null, ageSeconds: null, expired: null, reason: String(error) };
  }

  let members: GridData['members'] = [];
  let poolReason: string | null = null;
  try {
    const spec = (deps.poolSpec ?? (() => resolvePodPoolSpec(undefined, process.env, () => {
      const config = getUserConfig();
      return config.harness?.podPool ?? config.pod?.pool;
    })))();
    if (spec) {
      const configured = parsePodPool(spec);
      try {
        const measured = (deps.measure ?? ((pool) => measurePoolLease(pool, { skipDnsProbe: true, ...(deps.kubectl ? { kubectl: deps.kubectl } : {}) })))(configured);
        const byContext = new Map(measured.members.map((m) => [m.context, m]));
        members = configured.map((member) => {
          const row = byContext.get(member.context);
          const running = row?.running ?? null;
          const pending = row?.pending ?? null;
          return { context: member.context, capacity: row?.capacity ?? member.capacity, running, pending,
            occupied: running === null || pending === null ? null : running + pending,
            reason: row?.reason ?? (row ? null : '측정 불가') };
        });
      } catch (error) {
        poolReason = String(error);
        members = configured.map(({ context, capacity }) => ({ context, capacity, running: null, pending: null, occupied: null, reason: poolReason }));
      }
    } else poolReason = 'pool not configured';
  } catch (error) {
    poolReason = String(error);
  }
  return { hq, members, poolReason };
}
