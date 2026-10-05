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
