// 0.3.33 ROUTER-OR-CODEX-MIX-CHOKEPOINT. The core makes one tier decision;
// this selector changes provider only after a fresh subscription observation.
import type { AccountSelector, AccountState, CoreDecisionInput } from './orchestration-core.js';
import { accountIdHash, pickWindowAccount } from './window-account-selector.js';

const CODEX = 'openai-codex';
const ROUTER = 'openrouter';

function active(input: CoreDecisionInput, reason: string): ReturnType<AccountSelector['select']> {
  return { provider: input.provider, account: input.accounts?.active?.account ?? null, reason };
}

export const ROUTER_MIX_ACCOUNT_SELECTOR: AccountSelector = {
  name: 'router-or-codex-mix',
  select({ input, tier, cell }) {
    const state = input.accounts;
    if (!state?.routerMix || (input.provider !== CODEX && input.provider !== ROUTER)) return active(input, 'unsupported-provider');
    if (state.routerMix.codexReadFailed) return active(input, 'codex-window-read-failed');
    if (state.explicit || state.routerMix.codex?.explicit) return active(input, 'explicit-account');
    const codex: AccountState | undefined = state.routerMix.codex;
    // The advisor runs in this process. Unlike a PTY child launch it cannot
    // atomically switch ELANOUS_CODEX_ACCOUNT per call, so only the current
    // Codex account is eligible at a checkpoint.
    const eligibleCodex = input.checkpoint && codex
      ? { ...codex, candidates: codex.candidates.filter(candidate => candidate.account === codex.active?.account) }
      : codex;
    // Only a strong checkpoint may consume subscription capacity. A stale or
    // missing window never becomes a made-up free Codex call.
    const pick = tier === 'strong' ? pickWindowAccount(eligibleCodex, CODEX, cell) : undefined;
    const selected = pick?.status === 'picked' && pick.candidate.billing === 'subscription'
      ? { provider: CODEX, account: pick.candidate.account, reason: `checkpoint:${accountIdHash(CODEX, pick.candidate.account)}:${pick.rule}` }
      : { provider: ROUTER, account: null, reason: tier === 'strong' ? `router:${pick?.status === 'refused' ? pick.reason : 'no-subscription'}` : `router:non-checkpoint:${tier}` };
    if (state.selection !== 'on') return active(input, `shadow:${selected.reason}`);
    return selected;
  },
};
