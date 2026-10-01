// Assembles the codex credit plan from disk for `provider codex status` and `usage` — policy file, the last
// measured per-account balances and the balance history. No network.
import { codexCreditPlan, readCreditHistory, type CodexCreditPlan } from '../budget/codex-credit-plan.js';
import { quotaSignalDir } from '../budget/codex-reset-credit-state.js';
import { inspectCodexRotation } from '../oauth/codex-account-store.js';
import { loadLlmPolicy } from '../policy/llm-policy.js';

export function codexCreditPlanFromDisk(now: number = Date.now()): CodexCreditPlan {
  const s = inspectCodexRotation(process.env, { now });
  const seen = new Set<string>();
  const balances: Array<{ name: string; balance?: number }> = [];
  const push = (key: string, name: string, balance: number | undefined) => {
    if (seen.has(key)) return;
    seen.add(key);
    balances.push({ name, ...(balance === undefined ? {} : { balance }) });
  };
  push(s.current.storeKey, s.current.name, s.currentCreditBalance);
  for (const c of s.candidates) push(c.storeKey, c.name, c.creditBalance);
  return codexCreditPlan({
    now,
    balances,
    credits: loadLlmPolicy({ now: new Date(now) }).policy.credits,
    history: readCreditHistory(quotaSignalDir()),
  });
}
