import { planScheduledGraph } from './scheduled-graph-plan.js';
import { claimScheduledGraphAction } from './scheduled-graph-claim.js';
import type { ReleaseClock } from './release-graph-exec.js';

/** Dependency-injected coordinator. No live runner or mail transport is wired here. */
export async function dispatchScheduledGraph(input: {
  mode: 'live' | 'shadow'; version?: string; now: Date; hasRun: boolean;
  schedule?: { version: string; rehearsalAt?: unknown; cutAt?: unknown; publishAt?: unknown } | null;
  claimPath: string;
  red: (version: string, reason: string) => Promise<void>;
  create: (version: string, clock: ReleaseClock) => Promise<void>;
}): Promise<'none' | 'red' | 'done' | 'already-claimed'> {
  const plan = planScheduledGraph(input);
  if (plan.kind === 'none') return 'none';
  if (plan.kind === 'red') { await input.red(plan.version, plan.reason); return 'red'; }
  return claimScheduledGraphAction({ path: input.claimPath, version: plan.version, cutAt: plan.clock.cutAt, phase: 'create', run: () => input.create(plan.version, plan.clock) });
}
