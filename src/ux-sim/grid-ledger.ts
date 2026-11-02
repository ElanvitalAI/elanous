import type { GridData } from '../nexus/api/grid.js';

export const GRID_LANES = ['train', 'express', 'gate', 'ta', 'parent', 'remote-gate', 'hand', 'amg', 'loop', 'dedicated'] as const;
export type GridLane = typeof GRID_LANES[number];

/** Resource lanes named by grid.v1. Other lease lanes are counted against their host's total capacity. */
export interface GridCaps {
  readonly trainShards: number;
  readonly gatePods: number;
  readonly taPods: number;
  readonly taParents: number;
  readonly remoteGateSlots: number;
}

export interface GridHostCapacity {
  readonly host: string;
  readonly capacity: number;
}

export interface GridSpec {
  readonly id: string;
  readonly hosts: readonly GridHostCapacity[];
  readonly caps: GridCaps;
}

export interface GridMission {
  readonly cell?: string;
  readonly pr?: number;
  readonly goalId?: string;
}

export interface GridLeaseInput {
  readonly fp: string;
  readonly grid: string;
  readonly host: string;
  readonly lane: GridLane;
  readonly mission: GridMission;
}

export interface GridLease extends GridLeaseInput {
  readonly since: string;
  readonly heartbeatAt: string;
  readonly endedAt?: string;
}

export type GridLeaseState = 'active' | 'expired' | 'ended';

export interface GridLedgerOptions {
  readonly now?: () => number;
  /** Heartbeat age beyond this duration is reported as expired, never silently deleted. */
  readonly heartbeatTtlMs?: number;
}

export interface GridWhoResult {
  readonly selector: { readonly host: string } | { readonly cell: string } | { readonly pr: number };
  readonly leases: ReadonlyArray<{ readonly state: GridLeaseState; readonly lease: GridLease }>;
}

export interface GridResourceHostSummary {
  readonly host: string;
  readonly ledgerLeases: number;
  readonly expiredLeases: number;
  readonly byLane: Readonly<Record<GridLane, number>>;
  readonly observedOccupied: number | null;
  readonly observedCapacity: number | null;
  readonly measurement: 'measured' | 'unmeasured';
  readonly difference: number | null;
  readonly reason: string | null;
}

export interface GridResourceSummary {
  readonly grid: string;
  readonly hosts: readonly GridResourceHostSummary[];
}

export interface GridChaosLossEvent {
  readonly affectedSessionIds: readonly string[];
  readonly targetGridId: string;
  readonly targetHostIds: readonly string[];
}

export interface GridChaosSessionMap {
  readonly grids: ReadonlyArray<{ readonly id: string; readonly hosts: ReadonlyArray<{ readonly id: string; readonly sessions: ReadonlyArray<{ readonly id: string; readonly leaseId: string }> }> }>;
}

const LANE_CAP: Partial<Record<GridLane, keyof GridCaps>> = {
  train: 'trainShards',
  gate: 'gatePods',
  ta: 'taPods',
  parent: 'taParents',
  'remote-gate': 'remoteGateSlots',
};
const GRID_CAP_KEYS = ['trainShards', 'gatePods', 'taPods', 'taParents', 'remoteGateSlots'] as const satisfies readonly (keyof GridCaps)[];

function copyLease(lease: GridLease): GridLease {
  return { ...lease, mission: { ...lease.mission } };
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateGrid(grid: GridSpec): void {
  if (!grid.id.trim()) throw new Error('invalid-grid-id');
  if (grid.hosts.length === 0) throw new Error('grid-needs-host');
  if (new Set(grid.hosts.map(({ host }) => host)).size !== grid.hosts.length) throw new Error('duplicate-grid-host');
  if (grid.hosts.some(({ host, capacity }) => !host.trim() || !nonNegativeInteger(capacity))) throw new Error('invalid-grid-host-capacity');
  const capKeys = Object.keys(grid.caps);
  if (capKeys.length !== GRID_CAP_KEYS.length || !GRID_CAP_KEYS.every((key) => Object.hasOwn(grid.caps, key))) {
    throw new Error('invalid-grid-cap-shape');
  }
  for (const cap of Object.values(grid.caps)) if (!nonNegativeInteger(cap)) throw new Error('invalid-grid-cap');
}

function validateMission(mission: GridMission): void {
  if (mission.cell !== undefined && !mission.cell.trim()) throw new Error('invalid-mission-cell');
  if (mission.goalId !== undefined && !mission.goalId.trim()) throw new Error('invalid-mission-goal');
  if (mission.pr !== undefined && (!Number.isSafeInteger(mission.pr) || mission.pr < 1)) throw new Error('invalid-mission-pr');
}

/** In-memory grid.v1/lease.v1 model for deterministic SIM-UNIVERSE tests. It never persists or writes operations state. */
export function createGridLedger(options: GridLedgerOptions = {}) {
  const now = options.now ?? Date.now;
  const heartbeatTtlMs = options.heartbeatTtlMs ?? 60_000;
  if (!nonNegativeInteger(heartbeatTtlMs)) throw new Error('invalid-heartbeat-ttl');
  const grids = new Map<string, GridSpec>();
  const leases = new Map<string, GridLease>();

  // Expired leases keep reserving capacity until explicitly ended; heartbeat can reactivate them.
  const openLeases = (gridId: string, host?: string): GridLease[] => [...leases.values()].filter((lease) =>
    lease.grid === gridId && lease.endedAt === undefined && (host === undefined || lease.host === host));

  const stateOf = (lease: GridLease, at = now()): GridLeaseState => {
    if (lease.endedAt !== undefined) return 'ended';
    const heartbeat = Date.parse(lease.heartbeatAt);
    return Number.isFinite(heartbeat) && at - heartbeat > heartbeatTtlMs ? 'expired' : 'active';
  };

  return {
    registerGrid(grid: GridSpec): GridSpec {
      validateGrid(grid);
      if (grids.has(grid.id)) throw new Error('duplicate-grid');
      const saved = { ...grid, hosts: grid.hosts.map((host) => ({ ...host })), caps: { ...grid.caps } };
      grids.set(saved.id, saved);
      return { ...saved, hosts: saved.hosts.map((host) => ({ ...host })), caps: { ...saved.caps } };
    },

    createLease(input: GridLeaseInput): GridLease {
      if (!input.fp.trim()) throw new Error('invalid-fingerprint');
      if (!GRID_LANES.includes(input.lane)) throw new Error('invalid-lane');
      validateMission(input.mission);
      if (leases.has(input.fp)) throw new Error('duplicate-fingerprint');
      const grid = grids.get(input.grid);
      if (!grid) throw new Error('unknown-grid');
      const host = grid.hosts.find((row) => row.host === input.host);
      if (!host) throw new Error('unknown-grid-host');
      if (openLeases(grid.id, host.host).length >= host.capacity) throw new Error('host-capacity-exceeded');
      const capKey = LANE_CAP[input.lane];
      if (capKey && openLeases(grid.id).filter((lease) => lease.lane === input.lane).length >= grid.caps[capKey]) {
        throw new Error(`grid-capacity-exceeded:${capKey}`);
      }
      const timestamp = new Date(now()).toISOString();
      // Whitelist the public lease input so untyped terminal fields cannot bypass active capacity accounting.
      const lease: GridLease = { fp: input.fp, grid: input.grid, host: input.host, lane: input.lane,
        mission: { ...input.mission }, since: timestamp, heartbeatAt: timestamp };
      leases.set(lease.fp, lease);
      return copyLease(lease);
    },

    heartbeat(fp: string): GridLease {
      const lease = leases.get(fp);
      if (!lease) throw new Error('unknown-fingerprint');
      if (lease.endedAt !== undefined) throw new Error('lease-ended');
      const timestamp = Math.max(now(), Date.parse(lease.heartbeatAt));
      const updated: GridLease = { ...lease, heartbeatAt: new Date(timestamp).toISOString() };
      leases.set(fp, updated);
      return copyLease(updated);
    },

    endLease(fp: string): boolean {
      const lease = leases.get(fp);
      if (!lease) throw new Error('unknown-fingerprint');
      if (lease.endedAt !== undefined) return false;
      const timestamp = Math.max(now(), Date.parse(lease.heartbeatAt));
      leases.set(fp, { ...lease, endedAt: new Date(timestamp).toISOString() });
      return true;
    },

    hasLease(fp: string): boolean {
      return leases.has(fp);
    },

    getLease(fp: string): GridLease | undefined {
      const lease = leases.get(fp);
      return lease ? copyLease(lease) : undefined;
    },

    who(selector: { readonly host: string } | { readonly cell: string } | { readonly pr: number }): GridWhoResult {
      const entries = [...leases.values()].filter((lease) => {
        if ('host' in selector) return lease.host === selector.host;
        if ('cell' in selector) return lease.mission.cell === selector.cell;
        return lease.mission.pr === selector.pr;
      }).map((lease) => ({ state: stateOf(lease), lease: copyLease(lease) }));
      return { selector: { ...selector }, leases: entries.sort((a, b) => a.lease.fp.localeCompare(b.lease.fp)) };
    },

    resourceSummary(gridId: string, data: GridData): GridResourceSummary {
      const grid = grids.get(gridId);
      if (!grid) throw new Error('unknown-grid');
      const hosts = grid.hosts.map(({ host }) => {
        const leasesHere = openLeases(gridId, host);
        const byLane = Object.fromEntries(GRID_LANES.map((lane) => [lane, leasesHere.filter((lease) => lease.lane === lane).length])) as Record<GridLane, number>;
        const row = data.members.find((member) => member.context === host);
        const measured = row?.occupied !== null && row?.occupied !== undefined;
        return {
          host,
          ledgerLeases: leasesHere.length,
          expiredLeases: leasesHere.filter((lease) => stateOf(lease) === 'expired').length,
          byLane,
          observedOccupied: measured ? row!.occupied : null,
          observedCapacity: row?.capacity ?? null,
          measurement: measured ? 'measured' as const : 'unmeasured' as const,
          difference: measured ? row!.occupied! - leasesHere.length : null,
          reason: measured ? null : row?.reason ?? data.poolReason ?? 'resource occupancy unmeasured',
        };
      });
      return { grid: gridId, hosts };
    },
  };
}

/** Adapts the seeded chaos driver's session-level loss events to this ledger's lease lifecycle. */
export function createGridChaosLedgerAdapter(
  ledger: Pick<ReturnType<typeof createGridLedger>, 'endLease' | 'hasLease' | 'getLease'>,
  topology: GridChaosSessionMap,
) {
  const locationBySession = new Map<string, { leaseId: string; gridId: string; hostId: string }>();
  for (const grid of topology.grids) for (const host of grid.hosts) for (const session of host.sessions) {
    if (locationBySession.has(session.id)) throw new Error(`duplicate chaos session id: ${session.id}`);
    locationBySession.set(session.id, { leaseId: session.leaseId, gridId: grid.id, hostId: host.id });
  }
  return {
    applyLoss(event: GridChaosLossEvent): readonly string[] {
      const leaseIds = event.affectedSessionIds.map((sessionId) => {
        const target = locationBySession.get(sessionId);
        if (!target) throw new Error(`unknown chaos session: ${sessionId}`);
        if (!ledger.hasLease(target.leaseId)) throw new Error(`unknown chaos lease: ${target.leaseId}`);
        const actual = ledger.getLease(target.leaseId)!;
        if (actual.grid !== target.gridId || actual.host !== target.hostId
          || event.targetGridId !== target.gridId || !event.targetHostIds.includes(target.hostId)) {
          throw new Error(`chaos lease location mismatch: ${target.leaseId}`);
        }
        return target.leaseId;
      });
      const affected = leaseIds.filter((leaseId) => ledger.endLease(leaseId));
      return affected;
    },
  };
}
