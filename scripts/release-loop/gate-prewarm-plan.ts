/**
 * Decide whether the release gate may prepare a warm worker before the cut.
 * This module makes no Pod or Git calls; the caller must recheck the same inputs
 * immediately before starting anything, because pool occupancy can change.
 */

export const GATE_PREWARM_WINDOW_MS = 30 * 60_000;
export const GATE_PREWARM_OBSERVATION_MAX_AGE_MS = 30_000;

export interface GatePrewarmInput {
  nowMs: number;
  cutAtMs: number;
  cutSha: string;
  lockHash: string;
  /** Observed current source; it must still be the candidate the cut planner named. */
  sourceSha: string | null;
  sourceLockHash: string | null;
  /** null means absent in a measured mirror; undefined means mirror status could not be measured. */
  mirrorCommitSha: string | null | undefined;
  /** One snapshot time for source, mirror, occupancy and demand. */
  observedAtMs: number | null;
  /** Current Pod count includes any existing warm workers. */
  occupiedPods: number | null;
  capacity: number;
  /** Pending higher-priority requests, including ones not yet represented by a Pod. */
  gateDemand: number | null;
  taskDemand: number | null;
}

export type GatePrewarmPlan =
  | { action: 'defer'; reason: 'invalid-input' | 'outside-window' | 'unmeasured' | 'stale-observation' | 'identity' | 'higher-priority' | 'no-slot' }
  | { action: 'prepare-mirror'; cutSha: string; lockHash: string }
  | { action: 'start-worker'; cutSha: string; lockHash: string; slotAfter: number };

const count = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value >= 0;

/** Gate > task > prewarm. Missing capacity or demand evidence never grants a worker slot. */
export function planGatePrewarm(input: GatePrewarmInput): GatePrewarmPlan {
  const { nowMs, cutAtMs, cutSha, lockHash, sourceSha, sourceLockHash, mirrorCommitSha,
    observedAtMs, occupiedPods, capacity, gateDemand, taskDemand } = input;
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(cutAtMs) || !/^[a-f0-9]{40}$/.test(cutSha)
    || !/^[a-f0-9]{64}$/.test(lockHash) || !Number.isSafeInteger(capacity) || capacity < 1) {
    return { action: 'defer', reason: 'invalid-input' };
  }
  const untilCut = cutAtMs - nowMs;
  if (untilCut <= 0 || untilCut > GATE_PREWARM_WINDOW_MS) return { action: 'defer', reason: 'outside-window' };
  if (mirrorCommitSha === undefined || typeof sourceSha !== 'string' || typeof sourceLockHash !== 'string'
    || typeof observedAtMs !== 'number' || !count(occupiedPods) || !count(gateDemand) || !count(taskDemand)) {
    return { action: 'defer', reason: 'unmeasured' };
  }
  if (mirrorCommitSha !== null && (typeof mirrorCommitSha !== 'string' || !/^[a-f0-9]{40}$/.test(mirrorCommitSha))) {
    return { action: 'defer', reason: 'invalid-input' };
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs > nowMs
    || nowMs - observedAtMs > GATE_PREWARM_OBSERVATION_MAX_AGE_MS) {
    return { action: 'defer', reason: 'stale-observation' };
  }
  if (sourceSha !== cutSha || sourceLockHash !== lockHash) return { action: 'defer', reason: 'identity' };
  // A mirror request uses no Pod slot but must not run during higher-priority traffic.
  if (gateDemand > 0 || taskDemand > 0) return { action: 'defer', reason: 'higher-priority' };
  // A measured mirror can be absent or hold an older commit; both require the same targeted fetch.
  if (mirrorCommitSha !== cutSha) return { action: 'prepare-mirror', cutSha, lockHash };
  if (occupiedPods >= capacity) return { action: 'defer', reason: 'no-slot' };
  return { action: 'start-worker', cutSha, lockHash, slotAfter: capacity - occupiedPods - 1 };
}
