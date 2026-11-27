// OP turn-end enforcement — the I/O half (see op-turn-enforce.ts for the SCQA and the three faces). Runs in its own
// `eln pulse enforce` process (the OP TUI spawns it detached), so a land tick or a release run never blocks the TUI.
import { readFacts, fedStatePath } from '../fed-state/ledger.js';
import { executeNextActions, planNextActions, type NextActuators } from './op-next-action.js';
import { liveNextActionState, liveNextActuators, type LiveRoots } from './op-next-action-live.js';
import { STATE_FACT_TYPES } from './op-turn-outcome.js';
import { appendEnforce, decideEnforce, enforcePaths, openingPlan, writeForced } from './op-turn-enforce.js';
import type { NextActionState } from './op-next-action.js';

export interface EnforceDeps {
  readonly state?: (roots: LiveRoots, now: Date) => Promise<NextActionState>;
  readonly actuators?: NextActuators;
  readonly factsPath?: string;
}

/** OP state facts (cell · work · land · slot · judge · green with seat OP) in [since, now). */
export function opStateChangesSince(factsPath: string, since: Date, now: Date): number {
  return readFacts({ since, until: new Date(now.getTime() + 1), path: factsPath }).facts
    .filter(f => STATE_FACT_TYPES.has(f.type) && (f.seat ?? '').toUpperCase() === 'OP').length;
}

export async function runTurnEnforce(roots: LiveRoots, input: { since: Date; origin: string; promise: boolean; tuiProgress: boolean; now: Date }, deps: EnforceDeps = {}): Promise<Record<string, unknown>> {
  const paths = enforcePaths(roots.stateRoot);
  const opening = openingPlan(paths.plans, input.since);
  const plan = planNextActions(await (deps.state ?? liveNextActionState)(roots, input.now));
  const opStateChanges = opStateChangesSince(deps.factsPath ?? fedStatePath(roots.stateRoot), input.since, input.now);
  const decision = decideEnforce({ opening, fresh: plan.actions, opStateChanges, tuiProgress: input.tuiProgress, promise: input.promise, now: input.now });
  const results = decision.execute.length
    ? await executeNextActions({ ...plan, actions: decision.execute }, deps.actuators ?? liveNextActuators(roots), 'live') : [];
  const did = results.filter(r => r.status === 'did').map(r => `(${r.action.rule}) ${r.action.what} (${r.evidence}) because OP turn changed nothing`);
  const failed = results.filter(r => r.status === 'failed').map(r => `(${r.action.rule}) ${r.action.what}: ${r.evidence}`);
  // The forced set is rewritten every enforced turn: a turn that acted clears it; a no-op turn carries the pending OP work.
  writeForced(paths.forced, decision.noop ? decision.forced : []);
  const row = { at: input.now.toISOString(), since: input.since.toISOString(), origin: input.origin, noop: decision.noop, promise: input.promise,
    opStateChanges, tuiProgress: input.tuiProgress, opening: opening ? opening.length : null, did, failed, forced: decision.forced.map(f => f.key) };
  appendEnforce(paths.ledger, row);
  return row;
}
