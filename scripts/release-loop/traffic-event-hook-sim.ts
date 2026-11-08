import { evaluateReleaseTrafficHook, type ReleaseTrafficHookEvent, type ReleaseTrafficHookJudgment, type ReleaseTrafficHookState, type ReleaseTrafficHookChange } from './traffic-event-hook.js';

export interface ReleaseTrafficHookSimulationStep {
  event: ReleaseTrafficHookEvent;
  state: ReleaseTrafficHookState;
  changes: ReleaseTrafficHookChange[];
  judgment: ReleaseTrafficHookJudgment;
  ignored?: string;
}

export interface ReleaseTrafficHookSimulation {
  state: ReleaseTrafficHookState;
  steps: ReleaseTrafficHookSimulationStep[];
}

/** Run a deterministic event sequence against the production pure decision function. */
export function simulateReleaseTrafficHook(initial: ReleaseTrafficHookState, events: readonly ReleaseTrafficHookEvent[]): ReleaseTrafficHookSimulation {
  let state = initial;
  const steps: ReleaseTrafficHookSimulationStep[] = [];
  for (const event of events) {
    const result = evaluateReleaseTrafficHook(state, event);
    state = result.state;
    steps.push({ event, state, changes: result.changes, judgment: result.judgment, ...(result.ignored ? { ignored: result.ignored } : {}) });
  }
  return { state, steps };
}
