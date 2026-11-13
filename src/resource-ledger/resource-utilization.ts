import { projectHostReadiness } from './host-readiness.js';
import { activeResourceLeases, resourceMatrix, RESOURCE_LANES, type ResourceLane, type ResourceLedgerEvent } from './resource-ledger.js';

export interface ResourceUtilizationHost {
  host: string;
  /** Capacity is a count of concurrent leases in each lane, not CPU cores. */
  capacity?: Partial<Record<ResourceLane, number>>;
}

// Source: RESOURCE-UTILIZATION-VIEW completion contract: idle = lease count 0 and L15 < 10.
const IDLE_LOAD15_PERCENT = 10;

/** Read-only Nexus-ledger projection; never expires leases or allocates idle hosts.
 * Unknown capacity/load is null. An expired lease remains counted until the ledger
 * records its end/reap, so a failed heartbeat cannot make a busy host look idle. */
export function resourceUtilizationView(input: {
  hosts: readonly ResourceUtilizationHost[];
  events: readonly ResourceLedgerEvent[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const leases = activeResourceLeases(input.events);
  const readiness = projectHostReadiness([...input.events], now);
  const inventory = new Map(input.hosts.map(host => [host.host, host]));
  const observed = new Map(readiness.map(host => [host.host, host]));
  // A missing inventory row must not hide either an active consumer or a measured host.
  const names = new Set([...inventory.keys(), ...leases.map(lease => lease.host), ...observed.keys()]);
  const hosts = [...names].map(host => {
    const capacity = inventory.get(host)?.capacity;
    return { host, capacity: Object.fromEntries(RESOURCE_LANES.flatMap(lane => {
      const value = capacity?.[lane];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[lane, value]] : [];
    })) as Partial<Record<ResourceLane, number>> };
  });
  const lanes = resourceMatrix({ hosts, leases, measurements: [] }).map(row => ({
    ...row,
    utilizationRatio: row.capacity !== null && row.capacity > 0 ? row.leases / row.capacity : null,
  }));
  const totals = hosts.map(({ host }) => {
    const rows = lanes.filter(row => row.host === host);
    const leaseCount = rows.reduce((sum, row) => sum + row.leases, 0);
    // Undeclared unknown-lane capacity is irrelevant only while that lane has no consumers.
    const capacityRows = rows.filter(row => row.lane !== 'unknown' || row.leases > 0 || row.capacity !== null);
    const capacity = capacityRows.every(row => row.capacity !== null)
      ? capacityRows.reduce((sum, row) => sum + row.capacity!, 0) : null;
    const state = observed.get(host);
    const sample = state?.sample;
    const load15Percent = state?.freshness === 'fresh' && state.verdict !== 'UNMEASURED'
      && sample && Number.isFinite(sample.load15Percent) && sample.load15Percent >= 0
      ? sample.load15Percent : null;
    return {
      host, leases: leaseCount, capacity,
      utilizationRatio: capacity !== null && capacity > 0 ? leaseCount / capacity : null,
      load15Percent,
      idle: leaseCount > 0 ? false : load15Percent === null ? null : load15Percent < IDLE_LOAD15_PERCENT,
    };
  });
  return { observedAt: now.toISOString(), lanes, hosts: totals, idleHosts: totals.filter(host => host.idle === true).map(host => host.host) };
}
