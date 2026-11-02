import type { SimClock } from './fake-clock.js';
import { simPodDeath, type PodDeathObservation, type PodDeathScenario } from './fault-pod-death.js';

export type GridChaosAttack = 'monkey' | 'gorilla' | 'kong';
export type GridChaosScope = 'session' | 'host' | 'grid' | 'headquarters';

export interface GridChaosSession {
  id: string;
  leaseId: string;
  /** Required real fault-pod-death fixture; consumed through its production decision function. */
  podDeathScenario: PodDeathScenario;
}

export interface GridChaosHost {
  id: string;
  sessions: GridChaosSession[];
}

export interface GridChaosGrid {
  id: string;
  hosts: GridChaosHost[];
}

export interface GridChaosTopology {
  headquartersGridId: string;
  grids: GridChaosGrid[];
}

export interface GridChaosEvent {
  readonly seed: number;
  readonly sequence: number;
  readonly attack: GridChaosAttack;
  readonly scope: GridChaosScope;
  readonly atMs: number;
  readonly targetGridId: string;
  readonly targetHostIds: readonly string[];
  readonly affectedSessionIds: readonly string[];
  readonly podDeathObservations: readonly PodDeathObservation[];
}

/** Adapter boundary implemented by the grid ledger; the driver never terminates VMs or sessions. */
export interface GridChaosLedger {
  applyLoss(event: GridChaosEvent): readonly string[];
}

export interface GridChaosResultEvent extends GridChaosEvent {
  readonly affectedLeaseIds: readonly string[];
}

export interface GridChaosResult {
  readonly seed: number;
  readonly events: readonly GridChaosResultEvent[];
  readonly duplicateLeaseLosses: readonly string[];
}

function compareId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validateTopology(topology: GridChaosTopology): void {
  if (!topology || !Array.isArray(topology.grids) || topology.grids.length < 3)
    throw new Error('grid chaos requires an HQ grid and at least two worker grids');
  const gridIds = new Set<string>();
  const hostIds = new Set<string>();
  const sessionIds = new Set<string>();
  const leaseIds = new Set<string>();
  for (const grid of topology.grids) {
    if (!grid.id || gridIds.has(grid.id)) throw new Error(`grid chaos duplicate or empty grid id: ${grid.id}`);
    gridIds.add(grid.id);
    if (!Array.isArray(grid.hosts) || grid.hosts.length === 0) throw new Error(`grid chaos grid has no hosts: ${grid.id}`);
    for (const host of grid.hosts) {
      if (!host.id || hostIds.has(host.id)) throw new Error(`grid chaos duplicate or empty host id: ${host.id}`);
      hostIds.add(host.id);
      if (!Array.isArray(host.sessions) || host.sessions.length === 0) throw new Error(`grid chaos host has no sessions: ${host.id}`);
      for (const session of host.sessions) {
        if (!session.id || sessionIds.has(session.id)) throw new Error(`grid chaos duplicate or empty session id: ${session.id}`);
        if (!session.leaseId || leaseIds.has(session.leaseId)) throw new Error(`grid chaos duplicate or empty lease id: ${session.leaseId}`);
        sessionIds.add(session.id);
        leaseIds.add(session.leaseId);
        if (!session.podDeathScenario) throw new Error(`grid chaos session requires a pod-death fixture: ${session.id}`);
      }
    }
  }
  if (!gridIds.has(topology.headquartersGridId)) throw new Error(`grid chaos HQ grid is missing: ${topology.headquartersGridId}`);
  if (topology.grids.filter((grid) => grid.id !== topology.headquartersGridId).length < 2)
    throw new Error('grid chaos requires at least two worker grids');
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function choose<T>(rows: readonly T[], random: () => number): T {
  return rows[Math.floor(random() * rows.length)]!;
}

function shuffledAttacks(random: () => number): GridChaosAttack[] {
  const attacks: GridChaosAttack[] = ['monkey', 'gorilla', 'kong'];
  for (let index = attacks.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [attacks[index], attacks[other]] = [attacks[other]!, attacks[index]!];
  }
  return attacks;
}

function eventTargets(input: {
  attack: GridChaosAttack;
  seed: number;
  atMs: number;
  topology: GridChaosTopology;
  monkeyGrid: GridChaosGrid;
  monkeyHost: GridChaosHost;
  monkeyScope: 'host' | 'session';
  monkeySession: GridChaosSession;
  gorillaGrid: GridChaosGrid;
}): Omit<GridChaosEvent, 'sequence'> {
  const { attack, topology, monkeyGrid, monkeyHost, monkeyScope, monkeySession, gorillaGrid } = input;
  let scope: GridChaosScope;
  let grid: GridChaosGrid;
  let hosts: GridChaosHost[];
  let sessions: GridChaosSession[];
  if (attack === 'monkey') {
    scope = monkeyScope;
    grid = monkeyGrid;
    hosts = [monkeyHost];
    sessions = monkeyScope === 'host' ? [...monkeyHost.sessions].sort(compareId) : [monkeySession];
  } else if (attack === 'gorilla') {
    scope = 'grid';
    grid = gorillaGrid;
    hosts = [...gorillaGrid.hosts].sort(compareId);
    sessions = hosts.flatMap((host) => host.sessions).sort(compareId);
  } else {
    scope = 'headquarters';
    grid = topology.grids.find((row) => row.id === topology.headquartersGridId)!;
    hosts = [...grid.hosts].sort(compareId);
    sessions = hosts.flatMap((host) => host.sessions).sort(compareId);
  }
  return {
    seed: input.seed,
    attack,
    scope,
    atMs: input.atMs,
    targetGridId: grid.id,
    targetHostIds: hosts.map((host) => host.id),
    affectedSessionIds: sessions.map((session) => session.id),
    podDeathObservations: sessions.map((session) => simPodDeath(session.podDeathScenario!)),
  };
}

/** Deterministically inject one monkey, gorilla, and kong loss through the grid-ledger adapter. */
export function simulateGridChaos(input: {
  seed: number;
  topology: GridChaosTopology;
  ledger: GridChaosLedger;
  clock: Pick<SimClock, 'now' | 'tick'>;
}): GridChaosResult {
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff)
    throw new Error('seed must be an unsigned 32-bit integer');
  validateTopology(input.topology);
  if (!input.ledger || typeof input.ledger.applyLoss !== 'function') throw new Error('grid chaos requires a ledger applyLoss seam');
  if (!input.clock || typeof input.clock.now !== 'function' || typeof input.clock.tick !== 'function')
    throw new Error('grid chaos requires the existing fake-clock');

  const random = seededRandom(input.seed);
  const workerGrids = input.topology.grids.filter((grid) => grid.id !== input.topology.headquartersGridId).sort(compareId);
  const monkeyGrid = choose(workerGrids, random);
  const gorillaGrid = choose(workerGrids.filter((grid) => grid.id !== monkeyGrid.id), random);
  const monkeyHost = choose([...monkeyGrid.hosts].sort(compareId), random);
  const monkeyScope = random() < 0.5 ? 'session' : 'host';
  const monkeySession = choose([...monkeyHost.sessions].sort(compareId), random);
  const attacks = shuffledAttacks(random);
  const events: GridChaosResultEvent[] = [];
  const seenLeases = new Set<string>();
  const duplicateLeaseLosses = new Set<string>();

  for (let sequence = 0; sequence < attacks.length; sequence++) {
    const attack = attacks[sequence]!;
    const raw = eventTargets({ attack, seed: input.seed, atMs: input.clock.now(), topology: input.topology,
      monkeyGrid, monkeyHost, monkeyScope, monkeySession, gorillaGrid });
    const event: GridChaosEvent = { ...raw, sequence };
    const affectedLeaseIds = [...input.ledger.applyLoss(event)];
    for (const leaseId of affectedLeaseIds) {
      if (seenLeases.has(leaseId)) duplicateLeaseLosses.add(leaseId);
      seenLeases.add(leaseId);
    }
    events.push({ ...event, affectedLeaseIds });
    input.clock.tick(1);
  }

  return { seed: input.seed, events, duplicateLeaseLosses: [...duplicateLeaseLosses].sort() };
}
