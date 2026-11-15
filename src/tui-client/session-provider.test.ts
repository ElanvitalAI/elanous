import { expect, test } from 'bun:test';
import { getUserConfig } from '../user-config.js';
import { clearSessionProvider, configForSessionProviderTurn, getSessionProvider, parseSessionProvider, setSessionProvider } from './session-provider.js';

test('two sessions select separate providers without changing global config or storing keys', async () => {
  const cfg = structuredClone(getUserConfig());
  cfg.llm = {
    ...cfg.llm, provider: 'openai-codex', model: 'gpt-6.1-terra', apiKey: 'old-provider-key',
    baseUrl: 'https://old.example.invalid/v1',
    rotation: [{ provider: 'grok', model: 'grok-4.7', apiKey: 'grok-fixture-key', baseUrl: 'https://grok.example.invalid/v1' }],
  };
  setSessionProvider('codex-session', parseSessionProvider('openai-codex'));
  setSessionProvider('grok-session', parseSessionProvider('grok'));
  try {
    const codex = await configForSessionProviderTurn(cfg, getSessionProvider('codex-session'));
    const grok = await configForSessionProviderTurn(cfg, getSessionProvider('grok-session'));
    expect(codex.llm).toMatchObject({ provider: 'openai-codex', model: 'gpt-6.1-terra', apiKey: 'old-provider-key' });
    expect(grok.llm).toMatchObject({ provider: 'grok', model: 'grok-4.7', apiKey: 'grok-fixture-key', baseUrl: 'https://grok.example.invalid/v1' });
    expect(getSessionProvider('grok-session')).toEqual({ provider: 'grok' });
    expect(getSessionProvider('codex-session')).toEqual({ provider: 'openai-codex' });
    expect(cfg.llm).toMatchObject({ provider: 'openai-codex', model: 'gpt-6.1-terra', apiKey: 'old-provider-key' });
  } finally {
    clearSessionProvider('codex-session');
    clearSessionProvider('grok-session');
  }
});

test('switching provider never forwards the old provider key or endpoint', async () => {
  const cfg = structuredClone(getUserConfig());
  cfg.llm = { ...cfg.llm, provider: 'openai-codex', apiKey: 'old-provider-key', baseUrl: 'https://old.example.invalid/v1', rotation: [] };
  const grok = await configForSessionProviderTurn(cfg, parseSessionProvider('grok'));
  expect(grok.llm.provider).toBe('grok');
  expect(grok.llm.apiKey).not.toBe('old-provider-key');
  expect(grok.llm.baseUrl).toBeUndefined();
});
