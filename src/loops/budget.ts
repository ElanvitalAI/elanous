import { ORCHESTRATOR_DEFAULTS, type OrchestratorSeat } from '../user-config.js';
import type { ChecklistItem } from '../release-loop/checklist.js';
import type { TrafficCell, TrafficProcess, TrafficResult, TrafficSeatRow } from './orchestrator/traffic.js';

const RESOURCE_SEATS: readonly OrchestratorSeat[] = ['OP', 'TC', 'MK', 'UX'];

type WorkCell = Pick<ChecklistItem, 'owner' | 'status'>;

/** Allocate whole base slots by remaining work; this calculation does not decide launches. */
export function calculateSeatBaseShares({ totalSlots, currentRound, nextRound, seatCaps }: {
  totalSlots: number;
  currentRound: readonly WorkCell[];
  nextRound: readonly WorkCell[];
  seatCaps: Readonly<Record<OrchestratorSeat, number>>;
}): Record<OrchestratorSeat, number> {
  if (!Number.isSafeInteger(totalSlots) || totalSlots < 0 ||
    RESOURCE_SEATS.some(seat => !Number.isSafeInteger(seatCaps[seat]) || seatCaps[seat] < 0)) {
    throw new RangeError('totalSlots and seatCaps must be nonnegative safe integers');
  }
  const shares: Record<OrchestratorSeat, number> = { OP: 0, TC: 0, MK: 0, UX: 0 };
  const weights: Record<OrchestratorSeat, number> = { OP: 0, TC: 0, MK: 0, UX: 0 };
  for (const [cells, weight] of [[currentRound, 2], [nextRound, 1]] as const) {
    for (const cell of cells) {
      if (cell.status !== 'yellow') continue;
      const seat = cell.owner?.split('/')[0];
      if (RESOURCE_SEATS.some(id => id === seat)) weights[seat as OrchestratorSeat] += weight;
    }
  }

  let available = Math.min(totalSlots, RESOURCE_SEATS.reduce((sum, seat) => sum + seatCaps[seat], 0));
  let eligible = RESOURCE_SEATS.filter(seat => weights[seat] > 0 && seatCaps[seat] > 0);
  while (available > 0 && eligible.length > 0) {
    const totalWeight = eligible.reduce((sum, seat) => sum + weights[seat], 0);
    const ideal = (seat: OrchestratorSeat) => available * weights[seat] / totalWeight;
    const capped = eligible.filter(seat => ideal(seat) >= seatCaps[seat]);
    if (capped.length > 0) {
      for (const seat of capped) {
        shares[seat] = seatCaps[seat];
        available -= seatCaps[seat];
      }
      eligible = eligible.filter(seat => !capped.includes(seat));
      continue;
    }
    const remainders = eligible.map(seat => ({ seat, exact: ideal(seat) }));
    for (const { seat, exact } of remainders) {
      shares[seat] = Math.floor(exact);
      available -= shares[seat];
    }
    remainders.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
    for (const { seat } of remainders) {
      if (available === 0) break;
      shares[seat]++;
      available--;
    }
    break;
  }
  return shares;
}

export interface SpawnBudgetInput {
  seat: OrchestratorSeat;
  /** Current running count for this seat; null/undefined means the ledger could not be measured. */
  running: number | null | undefined;
  /** Configured loops.orchestrator.seatCaps. Missing seats use the orchestrator defaults. */
  caps?: Partial<Record<OrchestratorSeat, number>>;
  /** Release-gate seat limits. Missing seats use the gate default of four. */
  gate?: Partial<Record<OrchestratorSeat, number>>;
  /** Optional queue-injected cap; it may lower, never replace, the configured limit. */
  injectedCap?: number;
}

export interface SpawnBudgetDecision {
  allow: boolean;
  reason: 'within-cap' | 'seat-cap' | 'unknown-running';
  cap: number;
}

export type SeatCapDetails = {
  cap: number;
  seatCaps: number | '?';
  releaseGate: number | '?';
  injectedCap?: number | '?';
  winners: ('releaseGate' | 'seatCaps' | 'injectedCap')[];
};

/** Keep the cap calculation and the names shown to operators on the same source of truth. */
export function seatCapDetails({ seat, caps, gate, injectedCap }: Pick<SpawnBudgetInput, 'seat' | 'caps' | 'gate' | 'injectedCap'>): SeatCapDetails {
  const configured = caps?.[seat] ?? ORCHESTRATOR_DEFAULTS.seatCaps[seat];
  const gated = gate?.[seat] ?? 4;
  const valid = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  const seatCaps = valid(configured) ? configured : '?';
  const releaseGate = valid(gated) ? gated : '?';
  const injected = injectedCap === undefined ? undefined : valid(injectedCap) ? injectedCap : '?';
  const cap = [seatCaps, releaseGate, injected].some((value) => value === '?') ? 0
    : Math.min(seatCaps as number, releaseGate as number, injected === undefined ? Infinity : injected as number);
  const winners: SeatCapDetails['winners'] = [];
  if (seatCaps !== '?' && releaseGate !== '?' && injected !== '?') {
    if (releaseGate === cap) winners.push('releaseGate');
    if (seatCaps === cap) winners.push('seatCaps');
    if (injected === cap) winners.push('injectedCap');
  }
  return { cap, seatCaps, releaseGate, ...(injected === undefined ? {} : { injectedCap: injected }), winners };
}

export function seatCapReason(seat: OrchestratorSeat, active: number, details: SeatCapDetails): string {
  const keys = (['releaseGate', 'seatCaps', 'injectedCap'] as const).filter((name) => name !== 'injectedCap' || details.injectedCap !== undefined);
  const candidates = [...details.winners, ...keys.filter((name) => !details.winners.includes(name))];
  return `seat ${seat}: ${active}/${details.cap} (${candidates.map((name) => `${name}.${seat}=${details[name]}`).join(' · ')})`;
}

/** A release gate or injected queue cap can lower, but never raise, the configured per-seat cap. */
export function decideSpawn({ seat, running, caps, gate, injectedCap }: SpawnBudgetInput): SpawnBudgetDecision {
  const { cap } = seatCapDetails({ seat, caps, gate, injectedCap });
  if (!Number.isSafeInteger(running) || running === null || running === undefined || running < 0) {
    return { allow: false, reason: 'unknown-running', cap };
  }
  return running < cap
    ? { allow: true, reason: 'within-cap', cap }
    : { allow: false, reason: 'seat-cap', cap };
}

/** SEAT-CAP-STALE: why a run or a queue row is left out of a seat's running count (counting only — nothing is stopped). */
export type SeatCapExclusionReason = 'stale' | 'soft-stopped' | 'unknown-seat' | 'dead-row';
export const SEAT_CAP_STALE_RUN_MINUTES = 30;
export const SEAT_CAP_UNKNOWN_SEAT_CAP = 2;
/** A just-launched row has no process yet; it keeps its seat for this long. */
export const SEAT_CAP_LAUNCH_GRACE_MINUTES = 5;

export type SeatCapSubject =
  | { kind: 'run'; seat?: OrchestratorSeat; progressAt?: number; stopReason?: string }
  | { kind: 'row'; status: string; receipt: 'started' | 'finished' | 'not-started' | null; live: boolean; launchedAt?: number };

export type SeatCapExclusion = { reason: SeatCapExclusionReason; idleMin: number | null } | null;

/**
 * Pure judgement: null = the subject holds a seat. A run without a seat goes to the unknown-seat bucket; a run whose
 * supervisor already stopped (awaiting harvest) or whose last progress is older than staleRunMinutes is excluded; a
 * launched row with no live process past the launch grace is a dead row. A run with no progress signal still counts.
 */
export function seatCapExclusion(subject: SeatCapSubject, now: number,
  { staleRunMinutes = SEAT_CAP_STALE_RUN_MINUTES, launchGraceMinutes = SEAT_CAP_LAUNCH_GRACE_MINUTES }:
  { staleRunMinutes?: number; launchGraceMinutes?: number } = {}): SeatCapExclusion {
  const minutes = (at: number | undefined): number | null =>
    at !== undefined && Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : null;
  if (subject.kind === 'row') {
    if (subject.status !== 'launched' && subject.status !== 'launching') return null;
    if (subject.live || subject.receipt === 'finished' || subject.receipt === 'not-started') return null;
    const idle = minutes(subject.launchedAt);
    return idle !== null && now - subject.launchedAt! >= launchGraceMinutes * 60_000 ? { reason: 'dead-row', idleMin: idle } : null;
  }
  const idle = minutes(subject.progressAt);
  if (!subject.seat) return { reason: 'unknown-seat', idleMin: idle };
  if (subject.stopReason) return { reason: 'soft-stopped', idleMin: idle };
  if (idle !== null && now - subject.progressAt! >= staleRunMinutes * 60_000) return { reason: 'stale', idleMin: idle };
  return null;
}

/** Only harness ask/say launches occupy ORCH traffic seats. */
export const isTrafficLaunch = (command: string): boolean =>
  /(?:^|\s)(?:\S*\/)?elanous\.mjs\s+(?:(?:--test|--config-dir\s+\S+)\s+)?harness\s+(?:ask|say)(?=\s|$)/.test(command);

/** ORCH traffic supplies a physical cap, which can exceed the default spawn release gate. */
function decideTrafficLaunch(row: TrafficSeatRow): boolean {
  return decideSpawn({ seat: row.seat, running: row.running, caps: { [row.seat]: row.cap },
    gate: { [row.seat]: row.cap }, injectedCap: row.launchCap }).allow;
}

/** Process-to-seat resolution occurs at the boundary; this decision does no IO. */
export function budgetTrafficTick({ processes, now, caps, lastLaunchAt, idleSince, openCells, nextRound, totalSlots, idleMinutes = 30, retainQueuedCells = false }: {
  processes: readonly TrafficProcess[];
  now: Date;
  caps: Readonly<Record<OrchestratorSeat, number>>;
  lastLaunchAt?: Partial<Record<OrchestratorSeat, Date | null>>;
  idleSince?: Partial<Record<OrchestratorSeat, Date | null>>;
  openCells: readonly TrafficCell[];
  nextRound?: readonly TrafficCell[];
  totalSlots?: number;
  idleMinutes?: number;
  /** Observation only: expose queued work even when no launch has been observed yet. */
  retainQueuedCells?: boolean;
}): TrafficResult {
  const launches = processes.filter(process => isTrafficLaunch(process.command));
  const slotBudget = totalSlots ?? RESOURCE_SEATS.reduce((sum, seat) => sum + caps[seat], 0);
  // A missing next round is unknown, not an empty round with zero remaining work.
  const baseShares = nextRound === undefined ? null : calculateSeatBaseShares({
    totalSlots: slotBudget, currentRound: openCells, nextRound, seatCaps: caps,
  });
  const seats = RESOURCE_SEATS.map((seat): TrafficSeatRow => {
    const owned = launches.filter(process => process.seat === seat);
    const latest = owned.reduce<number | null>((current, process) => {
      if (!Number.isFinite(process.elapsedSeconds) || process.elapsedSeconds < 0) return current;
      const start = now.getTime() - process.elapsedSeconds * 1000;
      return current === null ? start : Math.max(current, start);
    }, null);
    const fallback = owned.length ? lastLaunchAt?.[seat]?.getTime() : undefined;
    const idleStart = idleSince?.[seat]?.getTime();
    const last = idleStart !== undefined && Number.isFinite(idleStart) ? idleStart
      : latest ?? (fallback !== undefined && Number.isFinite(fallback) ? fallback : null);
    const idleFor = last === null ? null : Math.max(0, Math.floor((now.getTime() - last) / 60_000));
    const nextCell = openCells.find(cell => cell.status !== 'done' && cell.owner?.split('/')[0] === seat) ?? null;
    const baseShare = baseShares?.[seat] ?? null;
    return { seat, running: owned.length, cap: caps[seat], baseShare, borrowed: 0, lent: 0,
      launchCap: baseShare === null ? caps[seat] : Math.max(owned.length, baseShare), idleFor,
      idle: decideSpawn({ seat, running: owned.length, caps: { [seat]: caps[seat] },
        gate: { [seat]: caps[seat] } }).allow && last !== null && now.getTime() - last > idleMinutes * 60_000, nextCell };
  });
  if (baseShares !== null) {
    // Account for outstanding loans before lending new capacity. A returning
    // lender cannot launch into a slot still occupied by the borrower's run.
    for (const borrower of seats) {
      let excess = Math.max(0, borrower.running - borrower.baseShare!);
      borrower.borrowed += excess;
      for (const lender of seats) {
        if (!excess) break;
        if (lender === borrower) continue;
        const amount = Math.min(excess, Math.max(0, lender.baseShare! - lender.running - lender.lent));
        lender.lent += amount;
        excess -= amount;
      }
    }
    for (const lender of seats) {
      if (lender.nextCell) continue;
      let available = Math.max(0, lender.baseShare! - lender.running - lender.lent);
      for (const borrower of seats) {
        if (!available) break;
        if (borrower === lender || !borrower.nextCell) continue;
        const needed = Math.max(0, Math.min(borrower.cap, borrower.running + 1) - borrower.launchCap);
        const amount = Math.min(available, needed);
        lender.lent += amount;
        borrower.borrowed += amount;
        borrower.launchCap += amount;
        available -= amount;
      }
    }
    for (const lender of seats) lender.launchCap = Math.max(lender.running, lender.launchCap - lender.lent);
  }
  // Reserve one available global slot per possible request, including unknown-seat
  // launches in the occupied count; returning a lent share does not end its old run.
  let freeSlots = Math.max(0, slotBudget - launches.length);
  for (const row of seats) {
    if (row.nextCell && row.idle && decideTrafficLaunch(row)) {
      if (freeSlots > 0) freeSlots--;
      else row.launchCap = row.running;
    }
    row.idle = row.idle && (row.nextCell === null || decideTrafficLaunch(row));
    if (!row.idle && !retainQueuedCells) row.nextCell = null;
  }
  return { seats, unassigned: launches.filter(process => process.seat === null).length, now, idleMinutes };
}
