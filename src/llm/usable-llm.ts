import { decideProviderForConfig, type ProviderDecision } from '../llm.js';
import { getUserConfig, type UserConfig } from '../user-config.js';

export interface UsableLlm {
  usable: boolean;
  provider?: string;
  via: 'login' | 'key' | 'local-server' | 'none';
  why: string;
}

export interface UsableLlmDeps {
  config?: UserConfig;
  /** The same selector used to construct a runtime LLM; injectable for isolated tests. */
  decide?: (config: UserConfig) => ProviderDecision;
}

/** Evaluate the selected route, not the union of discovered credentials or servers. */
export function resolveUsableLlm(deps: UsableLlmDeps = {}): UsableLlm {
  const decision = (deps.decide ?? decideProviderForConfig)(deps.config ?? getUserConfig());
  const provider = decision.provider.replace(/^auto:/, '');
  // Never echo an untrusted configured provider or a model/URL/credential into output.
  const known = ['openai-codex', 'openai', 'anthropic', 'grok', 'gemini', 'openrouter', 'local'];
  if (provider === 'auto' || decision.auth === 'none') {
    // An explicitly selected provider stays named so callers can offer that provider's fix,
    // not the Codex login (the auto route's default remedy).
    const explicit = !decision.provider.startsWith('auto') && known.includes(provider);
    return { usable: false, ...(explicit ? { provider } : {}), via: 'none', why: 'no usable LLM route selected' };
  }
  if (!known.includes(provider)) return { usable: false, via: 'none', why: 'no usable LLM route selected' };
  const via = decision.auth === 'oauth' ? 'login' : decision.auth === 'apikey' ? 'key' : 'local-server';
  return { usable: true, provider, via, why: `LLM via ${via} (${provider})` };
}
