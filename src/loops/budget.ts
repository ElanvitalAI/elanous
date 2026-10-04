import { ORCHESTRATOR_DEFAULTS, type OrchestratorSeat } from '../user-config.js';

export interface SpawnBudgetInput {
  seat: OrchestratorSeat;
  /** Current running count for this seat; null/undefined means the ledger could not be measured. */
  running: number | null | undefined;
  /** Configured loops.orchestrator.seatCaps. Missing seats use the orchestrator defaults. */
  caps?: Partial<Record<OrchestratorSeat, number>>;
  /** Release-gate seat limits. Missing seats use the gate default of four. */
  gate?: Partial<Record<OrchestratorSeat, number>>;
}

export interface SpawnBudgetDecision {
  allow: boolean;
  reason: 'within-cap' | 'seat-cap' | 'unknown-running';
  cap: number;
}

/** A release gate can lower, but never raise, the configured per-seat cap. */
export function decideSpawn({ seat, running, caps, gate }: SpawnBudgetInput): SpawnBudgetDecision {
  const configured = caps?.[seat] ?? ORCHESTRATOR_DEFAULTS.seatCaps[seat];
  const gated = gate?.[seat] ?? 4;
  const cap = Number.isSafeInteger(configured) && configured >= 0 && Number.isSafeInteger(gated) && gated >= 0
    ? Math.min(configured, gated)
    : 0;
  if (!Number.isSafeInteger(running) || running === null || running === undefined || running < 0) {
    return { allow: false, reason: 'unknown-running', cap };
  }
  return running < cap
    ? { allow: true, reason: 'within-cap', cap }
    : { allow: false, reason: 'seat-cap', cap };
}
