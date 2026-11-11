import { getUserConfig } from '../../user-config/reader.js';
import { readHqLease, type HqDeps } from '../../hq/hq.js';
import { measurePoolLease, measurePoolLeaseAsync, type PoolLeaseAsyncKubectl, type PoolLeaseMeasure, type PodLeaseMember } from '../../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, resolvePodPoolSpec, type PodPoolMember, type PoolKubectl } from '../../task-orchestrator/surfaces/pod-pool.js';
import type { GateReservation } from '../../ops/overview.js';
import { debug } from '../../debug/log.js';

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
  measureAsync?: (members: readonly PodPoolMember[]) => Promise<PoolLeaseMeasure>;
  kubectlAsync?: PoolLeaseAsyncKubectl;
}

export const GRID_POOL_CACHE_TTL_MS = 30_000;

export interface GridDataSource {
  read(): GridData;
}

export interface GridDataSourceOptions {
  readonly deps?: GridDeps;
  readonly ttlMs?: number;
  readonly now?: () => number;
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

function configuredPoolSpec(deps: GridDeps): string | null {
  return (deps.poolSpec ?? (() => resolvePodPoolSpec(undefined, process.env, () => {
    const config = getUserConfig();
    return config.harness?.podPool ?? config.pod?.pool;
  })))();
}

/** A memory-only snapshot source; collection and failure results are cached until the next 30-second cycle. */
export function createGridDataSource(options: GridDataSourceOptions = {}): GridDataSource {
  const deps = options.deps ?? {};
  const ttlMs = options.ttlMs ?? GRID_POOL_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let value: { measure: PoolLeaseMeasure | null; error?: string; at: number } | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): void => {
    if (inFlight) return;
    const started = now();
    inFlight = Promise.resolve().then(async () => {
      try {
        const spec = configuredPoolSpec(deps);
        let measured: PoolLeaseMeasure = { members: [] };
        if (spec) {
          const configured = parsePodPool(spec);
          measured = deps.measureAsync
            ? await deps.measureAsync(configured)
            : deps.measure
              ? deps.measure(configured)
              : await measurePoolLeaseAsync(configured, deps.kubectlAsync
                ? { kubectl: deps.kubectlAsync }
                : deps.kubectl ? { kubectl: async args => deps.kubectl!(args) } : {});
        }
        value = { measure: measured, at: now() };
        try {
          debug.log('nexus.grid', 'pool-measure', {
            ms: Math.max(0, now() - started),
            members: measured.members.length,
            unmeasured: measured.members.filter((member) => member.running === null || member.pending === null).length,
          });
        } catch { /* fail-soft */ }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        value = { measure: null, error: reason, at: now() };
        try {
          debug.log('nexus.grid', 'pool-measure', {
            ms: Math.max(0, now() - started), members: 0, unmeasured: 0,
          });
        } catch { /* fail-soft */ }
      } finally { inFlight = null; }
    });
  };

  return {
    read() {
      if (!value && deps.measure) {
        try {
          const spec = configuredPoolSpec(deps);
          value = { measure: spec ? deps.measure(parsePodPool(spec)) : { members: [] }, at: now() };
        } catch (error) {
          value = { measure: null, error: error instanceof Error ? error.message : String(error), at: now() };
        }
      }
      if (!value || now() - value.at >= ttlMs) refresh();
      return buildGridData({ ...deps, measure: () => {
        if (!value) return { members: [] };
        if (value.error) throw new Error(value.error);
        return value.measure ?? { members: [] };
      } });
    },
  };
}
