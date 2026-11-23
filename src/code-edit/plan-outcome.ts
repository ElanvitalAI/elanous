// Turn outcome from the PLAN STATE, not from sentences (RETHINK-TURN-OUTCOME-STRUCTURED-1117, DECISION-GATE v2).
// The model says what its turn amounted to by updating the plan; the harness only reads the state — so the verdict is the same in
// any language, any phrasing and any provider.
//
//   blocked   → someone outside the plan is needed: tell a person (reason is mandatory in the tool)
//   continue  → open work (in_progress or pending) and no blocker: open the next turn
//   waiting   → only waits remain (no open work): each has a wake condition; nothing to run now, never "stopped for no reason"
//   done      → every step completed: the caller may pick the next task
//   gap       → the model did not touch the plan this turn (or never wrote one): one structural nudge, then old behaviour
import type { PlanState, PlanStep, PlanWake } from './plan-tool.js';
import type { BlockReason } from '../agent-events/protocol.js';

export type PlanTurnOutcome =
  | { kind: 'blocked'; step: string; reason: string; code?: BlockReason }
  | { kind: 'continue'; step: string }
  | { kind: 'waiting'; step: string; wake: PlanWake }
  | { kind: 'done' }
  | { kind: 'gap'; why: 'no-plan' | 'plan-not-updated' };

export interface PlanOutcomeInput {
  /** The plan as it stands at turn end. */
  state: PlanState;
  /** Plan version when the turn started — an unchanged version means the model never updated the plan this turn. */
  versionAtTurnStart: number;
}

function firstOf(steps: readonly PlanStep[], status: PlanStep['status']): PlanStep | undefined {
  return steps.find((step) => step.status === status);
}

export function planTurnOutcome(input: PlanOutcomeInput): PlanTurnOutcome {
  const { state, versionAtTurnStart } = input;
  if (state.steps.length === 0) return { kind: 'gap', why: 'no-plan' };
  if (state.version === versionAtTurnStart) return { kind: 'gap', why: 'plan-not-updated' };
  const blocked = firstOf(state.steps, 'blocked');
  if (blocked) return { kind: 'blocked', step: blocked.step, reason: blocked.reason ?? '', ...(blocked.code ? { code: blocked.code } : {}) };
  const active = firstOf(state.steps, 'in_progress');
  if (active) return { kind: 'continue', step: active.step };
  // Open work beats a wait: a pending step still has something to run now, so the turn continues; only when nothing
  // is left to run does a wait (which always carries its wake) end the turn quietly.
  const pending = firstOf(state.steps, 'pending');
  if (pending) return { kind: 'continue', step: pending.step };
  const waiting = firstOf(state.steps, 'waiting');
  if (waiting?.wake) return { kind: 'waiting', step: waiting.step, wake: waiting.wake };
  return { kind: 'done' };
}
