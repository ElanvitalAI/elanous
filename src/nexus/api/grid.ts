import { getUserConfig } from '../../user-config.js';
import { readHqLease, type HqDeps } from '../../hq/hq.js';
import { measurePoolLease, type PoolLeaseMeasure, type PodLeaseMember } from '../../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, resolvePodPoolSpec, type PodPoolMember, type PoolKubectl } from '../../task-orchestrator/surfaces/pod-pool.js';
import type { GateReservation } from '../../ops/overview.js';

export interface GridData {
  /** null means the arbiter could not be read, not that no lease exists. */
  hq: { record: ReturnType<typeof readHqLease>['record']; ageSeconds: number | null; expired: boolean | null; reason: string | null };
  /**
   * Configured member order; capacity comes from measurePoolLease when available. occupied is running + pending, or null on measurement failure.
   * `gate` is GATE-RESERVE-AUTO's reservation for this member — absent when the job/cpu reading failed (unmeasured, not «no gate»).
   */
  members: Array<{ context: string; capacity: number; running: number | null; pending: number | null; occupied: number | null; reason: string | null; gate?: GateReservation }>;
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

/**
 * GATE-RESERVE-AUTO 의 예약 몫을 자원 지도 축 꼴로 옮긴다. Job/CPU 읽기가 실패한 멤버는 undefined 다 —
 * «게이트 없음»이 아니라 «못 잼»이므로 구속 조건 후보에서 빠진다(0 으로도 무한으로도 읽지 않는다).
 * 게이트가 안 도는 멤버(jobs 0)는 값으로 남는다: 축은 «게이트 없음»이라고 말할 수 있어야 한다.
 */
function gateOf(row: PodLeaseMember | undefined): GateReservation | undefined {
  if (!row || typeof row.gateJobs !== 'number') return undefined;
  return {
    jobs: row.gateJobs,
    unbound: typeof row.gateUnboundJobs === 'number' ? row.gateUnboundJobs : Number.NaN,
    reservedMillicores: typeof row.gateCpuMillicores === 'number' ? row.gateCpuMillicores : Number.NaN,
    schedulableMillicores: typeof row.schedulableCpuMillicores === 'number' ? row.schedulableCpuMillicores : Number.NaN,
  };
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
          const gate = gateOf(row);
          return { context: member.context, capacity: row?.capacity ?? member.capacity, running, pending,
            occupied: running === null || pending === null ? null : running + pending,
            reason: row?.reason ?? (row ? null : '측정 불가'), ...(gate ? { gate } : {}) };
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
