import { describe, expect, test } from 'bun:test';
import { POD_CHILD_PROVIDERS, podChildProviderOf, podChildProviderRefusal, podLaunchProviderOptions } from './pod-child-providers.js';
import { podChildProviderFailureFact } from './pod-failure-reason.js';

describe('podChildProviderOf', () => {
  test('keeps the canonical ids and normalises the human alias', () => {
    expect(POD_CHILD_PROVIDERS).toEqual(['openai-codex', 'grok', 'openrouter', 'opengateway', 'anthropic', 'bedrock', 'glm']);
    expect(podChildProviderOf('openrouter')).toBe('openrouter');
    expect(podChildProviderOf('  glm ')).toBe('glm');
    expect(podChildProviderOf('codex')).toBe('openai-codex');
  });

  test('refuses names outside the one list and leaves empty names undecided', () => {
    expect(podChildProviderOf('openai')).toBeUndefined();
    expect(podChildProviderOf('')).toBeUndefined();
    expect(podChildProviderOf(undefined)).toBeUndefined();
  });
});

describe('podChildProviderRefusal', () => {
  test('names the closed list for an unknown provider and stays silent for a known one', () => {
    expect(podChildProviderRefusal('nope')).toBe('pod: Pod 자식 provider 는 openai-codex|grok|openrouter|opengateway|anthropic|bedrock|glm 만 — 받음 nope');
    expect(podChildProviderRefusal('codex')).toBeUndefined();
    expect(podChildProviderRefusal(undefined)).toBeUndefined();
  });
});

describe('podLaunchProviderOptions', () => {
  test('carries the launch provider so the pod never falls back to codex implicitly', () => {
    expect(podLaunchProviderOptions('anthropic', { grokApiKeyOptIn: false })).toEqual({ account: 'anthropic', provider: 'anthropic' });
    expect(podLaunchProviderOptions('bedrock', { grokApiKeyOptIn: false })).toEqual({ account: 'bedrock', provider: 'bedrock' });
  });

  test('only codex decides an account, and only grok carries the api-key opt-in', () => {
    expect(podLaunchProviderOptions('openai-codex', { grokApiKeyOptIn: false })).toEqual({ account: 'team', provider: 'openai-codex' });
    expect(podLaunchProviderOptions('openai-codex', { explicitPodAccount: 'acct-2', grokApiKeyOptIn: false }))
      .toEqual({ account: 'acct-2', provider: 'openai-codex' });
    expect(podLaunchProviderOptions('grok', { grokApiKeyOptIn: true })).toEqual({ account: 'grok', provider: 'grok', grokApiKeyOptIn: true });
  });
});

describe('podChildProviderFailureFact provider normalisation', () => {
  test('writes the canonical id for the alias line and the account-name hint', () => {
    expect(podChildProviderFailureFact('llm.codex credential error: token expired')).toEqual({ provider: 'openai-codex' });
    expect(podChildProviderFailureFact('LLM API 503 upstream unavailable', { providerHint: 'codex' }))
      .toEqual({ provider: 'openai-codex', httpStatusCode: 503 });
  });

  test('does not treat an account id as a provider', () => {
    expect(podChildProviderFailureFact('LLM API 401 {}, response state: 401', { providerHint: 'team' }))
      .toEqual({ httpStatusCode: 401 });
  });
});
