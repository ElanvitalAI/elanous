import {
  decideBurstWithinBudget,
  type BurstBudgetDecision,
  type BurstBudgetInput,
  type BurstPlanLedger,
} from './burst-auto-within-budget.js';
import { planBurstReadyLadder, type BurstReadyLadderPlan } from './burst-ready-ladder.js';

export interface BurstAutoWireResult<T> {
  readonly decision: BurstBudgetDecision;
  /** Validated plans for the preparation stage; this function never creates VMs. */
  readonly ladderPlans: readonly BurstReadyLadderPlan[];
  readonly prepared: readonly T[];
}

/** Apply budget, validate every ladder plan, then hand approved plans to the preparation adapter. */
export function prepareBudgetedBurstReadyLadders<T>(
  input: BurstBudgetInput,
  dependencies: { ledger?: BurstPlanLedger; prepare: (plan: BurstReadyLadderPlan) => T },
): BurstAutoWireResult<T> {
  const ladderPlans: BurstReadyLadderPlan[] = [];
  const decision = decideBurstWithinBudget(input, {
    ...(dependencies.ledger ? { ledger: dependencies.ledger } : {}),
    planLadder: (requests) => {
      const validated = requests.map((request) => planBurstReadyLadder(request));
      ladderPlans.push(...validated);
      return validated;
    },
  });
  // decideBurstWithinBudget validates the full batch before it records a decision. Only then
  // may the preparation adapter be called; a denial therefore cannot occupy a pool slot.
  const prepared = decision.status === 'planned' ? ladderPlans.map(dependencies.prepare) : [];
  return { decision, ladderPlans, prepared };
}
