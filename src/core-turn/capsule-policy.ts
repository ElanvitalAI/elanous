import { emitTurnLife } from '../debug/turn-life.js';
import {
  CAPSULE_SYNC_CAP_MS,
  type CapsuleDecision, type CapsuleDecisionInput, type CapsulePolicy,
} from '../turn-capsule/contract.js';

export interface CapsulePolicyOptions {
  /** The raw `turn` config section (for `syncCapMs`); read failures are undefined. */
  readonly turnConfig: () => unknown;
  /** Correlation supplied by the caller for this turn or capsule. */
  correlation?: { turnId?: string; capsuleId?: string; eventId?: string };
  /** Optional observer; failures must not affect the decision. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * The capsule policy (A1) — the one switchless decision every capsule tool asks before it blocks the turn: Bash and RunShell
 * (A2) detach past `syncCapMs`. There is no on/off (CAPSULE-FLAGS-REMOVE-DEFAULT · the way back is a revert PR); `turn.syncCapMs`
 * only tunes the cap, and 0 means «never detach by policy». The caller supplies the kind from its own dispatch registry;
 * unknown tools stay synchronous.
 */
export function createCapsulePolicy(options: CapsulePolicyOptions): CapsulePolicy {
  return {
    decide(input: CapsuleDecisionInput): CapsuleDecision {
      let turn: unknown;
      try { turn = options.turnConfig(); } catch { turn = undefined; }
      const configured = typeof turn === 'object' && turn !== null
        ? (turn as { syncCapMs?: unknown }).syncCapMs : undefined;
      const cap = typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
        ? configured : CAPSULE_SYNC_CAP_MS;
      let decision: CapsuleDecision;
      if (cap === 0) {
        // syncCapMs 0 = never detach by policy (an explicit background request still detaches).
        decision = input.requestedBackground === true
          ? { mode: 'detach', syncCapMs: 0, reason: 'requested-background' }
          : { mode: 'sync', syncCapMs: Number.POSITIVE_INFINITY, reason: 'sync-cap-zero' };
      } else if (input.requestedBackground === true) {
        decision = { mode: 'detach', syncCapMs: 0, reason: 'requested-background' };
      } else if (input.kind === null) {
        decision = { mode: 'sync', syncCapMs: Infinity, reason: 'not-a-capsule' };
      } else {
        decision = { mode: 'sync', syncCapMs: cap, reason: 'capsule-sync-cap' };
      }
      try {
        (options.log ?? emitTurnLife)('turn-life:capsule-policy', {
          ...options.correlation, tool: input.tool, kind: input.kind, mode: decision.mode,
          syncCapMs: Number.isFinite(decision.syncCapMs) ? decision.syncCapMs : null, reason: decision.reason,
        });
      } catch { /* Observability must not change the policy. */ }
      return decision;
    },
  };
}
