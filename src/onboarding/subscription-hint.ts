// Onboarding step 1 — turn detected subscription logins into «Found» lines and a default provider (OB1 · 10-01).
// A fresh user with a ChatGPT/Codex or Grok login was shown «Auto-detect (env vars)» preselected and nothing found.
import type { DetectedProvider } from '../llm/provider-detect.js';

export interface SubscriptionHint {
  found: Array<{ provider: 'openai-codex' | 'grok'; line: string }>;
  /** Provider to preselect when the user has not chosen one yet. */
  preferred: 'openai-codex' | 'grok';
}

const SOURCE_LABEL: Record<string, string> = {
  'codex-auth': '~/.codex/auth.json',
  'elanous-auth': 'elanous login',
  'grok-auth': '~/.grok/auth.json',
};

/** Subscriptions first: codex, then grok. With none found, codex is still the default (most users have ChatGPT). */
export function subscriptionHint(detected: readonly DetectedProvider[]): SubscriptionHint {
  const found: SubscriptionHint['found'] = [];
  for (const provider of ['openai-codex', 'grok'] as const) {
    const hit = detected.find(d => d.provider === provider && d.auth === 'oauth');
    if (!hit) continue;
    const name = provider === 'openai-codex' ? 'ChatGPT / Codex subscription' : 'Grok subscription';
    found.push({ provider, line: `  Found ${name} (${SOURCE_LABEL[hit.source] ?? hit.source})` });
  }
  return { found, preferred: found[0]?.provider ?? 'openai-codex' };
}
