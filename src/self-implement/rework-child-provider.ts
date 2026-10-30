import type { ChildLlmSelection } from '../agent/run-context.js';

export type ProviderAvailability = 'available' | 'unavailable' | 'unknown';
export type ReworkChildProviderDecision =
  | { action: 'keep'; selection: ChildLlmSelection; reason: 'not-grok' | 'quota-unknown' | 'quota-usable' | 'no-alternate' }
  | { action: 'reselect'; selection: ChildLlmSelection; previous: ChildLlmSelection; reason: 'grok-quota-exhausted' | 'grok-credential-missing' };

/** Re-evaluate Grok immediately before a supervisor rework relaunch; unknown quota is never treated as exhaustion. */
export function reselectChildForRework(input: {
  current: ChildLlmSelection;
  grokQuota: 'usable' | 'exhausted' | 'unknown';
  grokCredential: ProviderAvailability;
  alternate?: ChildLlmSelection;
  alternateCredential: ProviderAvailability;
  alternateQuotaExhausted?: boolean;
}): ReworkChildProviderDecision {
  if (input.current.provider !== 'grok') return { action: 'keep', selection: input.current, reason: 'not-grok' };
  const reason = input.grokQuota === 'exhausted' ? 'grok-quota-exhausted'
    : input.grokCredential === 'unavailable' ? 'grok-credential-missing' : undefined;
  if (!reason) return { action: 'keep', selection: input.current, reason: input.grokQuota === 'unknown' ? 'quota-unknown' : 'quota-usable' };
  if (!input.alternate || input.alternateCredential !== 'available' || input.alternateQuotaExhausted === true) {
    return { action: 'keep', selection: input.current, reason: 'no-alternate' };
  }
  return { action: 'reselect', selection: input.alternate, previous: input.current, reason };
}
