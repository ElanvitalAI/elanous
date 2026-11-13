import type { BudgetGate } from '../task-orchestrator/feedback-loop.js';

/** Explicit zero-spend TOX admission for an isolated Nexus using the fake LLM. */
export function isolatedFakeToxBudget(
  instanceKind: string,
  env: NodeJS.ProcessEnv,
  observe: (allowed: boolean) => void,
): BudgetGate | undefined {
  if (instanceKind !== 'test' || env.ELANOUS_LLM_MODE !== 'fake'
    || env.ELANOUS_TEST_TOX_ZERO_SPEND !== '1'
    || env.ELANOUS_TEST_FAKE_LLM !== '1' || env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER !== '1') return undefined;
  return async (_goalSlug, estimateUsd) => {
    const allowed = estimateUsd === undefined || estimateUsd === 0;
    observe(allowed);
    return { canAfford: allowed, tripped: allowed ? [] : ['test-estimate-nonzero'] };
  };
}
