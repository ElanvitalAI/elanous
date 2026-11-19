import { expect, test } from 'bun:test';
import { resolveRoleProviderChain } from './role-provider-chain.js';
import { classifyReviewProviderFailure } from './review-provider-fallback.js';
const roles = ['review', 'judgement', 'recovery'] as const;
const terra = { model: 'gpt-6.1-terra', provider: 'openai-codex' };
const luna = { model: 'openrouter/openai/gpt-6-luna', provider: 'openrouter' };

test('pod roles use Codex first and explicit Luna fallback when the leased mirror is present', () => {
  for (const role of roles) {
    const result = resolveRoleProviderChain(role, { substrate: 'pod', isAvailable: () => true });
    expect(result.candidates).toEqual([terra, luna]);
  }
});
test('pod roles report a missing Codex mirror when falling back to Luna', () => {
  for (const role of roles) {
    const result = resolveRoleProviderChain(role, { substrate: 'pod', isAvailable: c => c.provider === 'openrouter' });
    expect(result.candidates).toEqual([luna]);
    expect(result.skipped).toContainEqual({ ...terra, why: 'codex-mirror-missing' });
  }
});
test('pod does not silently select another provider if neither lease nor Luna is available', () => {
  const result = resolveRoleProviderChain('review', { substrate: 'pod', isAvailable: () => false });
  expect(result.candidates).toEqual([]);
  expect(result.exhaustedReason).toContain('codex-mirror-missing');
});

test('quota-exhausted Codex is blocked and the fallback records the reason', () => {
  const result = resolveRoleProviderChain('judgement', { substrate: 'pod', podCodexBlocked: true,
    isAvailable: () => true });
  expect(result.candidates).toEqual([luna]);
  expect(result.skipped).toContainEqual({ ...terra, why: 'codex-quota-exhausted' });
});

test('HQ chains preserve existing configured provider order', () => {
  const result = resolveRoleProviderChain('review', { substrate: 'hq', isAvailable: () => true,
    grokQuota: () => 'usable', config: { llm: { roleProviderChains: { review: ['gpt-6.1-terra', 'grok-4.7', 'openrouter/openai/gpt-6-luna'] } } } });
  expect(result.candidates.map(c => c.model)).toEqual(['gpt-6.1-terra', 'grok-4.7', 'openrouter/openai/gpt-6-luna']);
});

test('Codex 429 or exhausted credits is classified for guarded fallback', () => {
  expect(classifyReviewProviderFailure('HTTP 429')).toBe('rate-limited');
  expect(classifyReviewProviderFailure('credits exhausted')).toBe('rate-limited');
  expect(classifyReviewProviderFailure('insufficient_quota')).toBe('rate-limited');
});
