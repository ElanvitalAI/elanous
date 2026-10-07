import { ORCHESTRATOR_DEFAULTS, type OrchestratorSeat } from '../user-config.js';

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
