import { expect, test } from 'bun:test';
import { capabilityRunEnv, probeElnCapabilities } from './capability-probe.js';
import type { UserConfig } from '../../user-config/types.js';

const KEY = 'sk-or-v1-probe-0000';
const config = (llm: Record<string, unknown>) => ({ llm }) as unknown as UserConfig;

test('probe: an auto config resolves the running provider; names only, no key value', async () => {
  const probe = await probeElnCapabilities({
    readConfig: () => config({ provider: 'auto', model: 'openrouter/z-ai/glm-5.3' }),
    resolveProviderName: async () => ({ name: 'openrouter', defaultModel: 'openrouter/z-ai/glm-5.3' }),
    providerHasKey: async () => true,
    listSecretNames: async () => ['OPENROUTER_API_KEY', 'TAVILY_API_KEY'],
    env: {}, which: () => null,
  });
  expect(probe.provider).toEqual({ name: 'openrouter', model: 'z-ai/glm-5.3', baseUrl: 'https://openrouter.ai/api/v1', hasKey: true, injectable: true });
  expect(probe.llmSecrets.map(entry => entry.name)).toEqual(['OPENROUTER_API_KEY']);
  expect(JSON.stringify(probe)).not.toContain('sk-');
});

test('probe: a subscription provider (openai-codex) is not injectable and is not asked for a key', async () => {
  let asked = false;
  const probe = await probeElnCapabilities({
    readConfig: () => config({ provider: 'openai-codex', model: 'gpt-6' }),
    providerHasKey: async () => { asked = true; return true; },
    listSecretNames: async () => [], env: { LOCAL_LLM_URL: 'http://localhost:11434/v1' }, which: tool => tool === 'say' ? '/usr/bin/say' : null,
  });
  expect(probe.provider).toMatchObject({ name: 'openai-codex', injectable: false, hasKey: false, subscription: true });
  expect(asked).toBe(false);
  expect(probe.local).toEqual({ llmUrl: 'http://localhost:11434/v1', tools: ['say'] });
});

test('run env: provider and secret keys go into ELN_LLM_API_KEY / the service env; a missing key falls back to mock', async () => {
  const provider = await capabilityRunEnv([{ capability: 'translation', env: { ELN_LLM_BASE_URL: 'u', ELN_LLM_MODEL: 'm' },
    key: { kind: 'provider', provider: 'openrouter' }, keyEnv: 'ELN_LLM_API_KEY' }], { providerApiKey: async () => KEY });
  expect(provider).toEqual({ env: { ELN_LLM_BASE_URL: 'u', ELN_LLM_MODEL: 'm', ELN_LLM_API_KEY: KEY }, missing: [] });
  const asked: string[] = [];
  const secret = await capabilityRunEnv([{ capability: 'search', env: {}, key: { kind: 'secret', name: 'TAVILY_API_KEY' }, keyEnv: 'TAVILY_API_KEY' }],
    { getSecret: async name => { asked.push(name); return 'tv-1'; } });
  expect(asked).toEqual(['TAVILY_API_KEY']);
  expect(secret.env).toEqual({ TAVILY_API_KEY: 'tv-1' });
  const missing = await capabilityRunEnv([{ capability: 'translation', env: { ELN_LLM_BASE_URL: 'u', ELN_LLM_MODEL: 'm' },
    key: { kind: 'secret', name: 'OPENROUTER_API_KEY' }, keyEnv: 'ELN_LLM_API_KEY' }], { getSecret: async () => undefined });
  expect(missing).toEqual({ env: { ELN_LLM_BASE_URL: 'u', ELN_LLM_MODEL: 'm', ELN_MOCK_TRANSLATION: '1' }, missing: ['translation'] });
});

test('probe: a config read failure drops only the provider step; secrets and local options still count', async () => {
  const probe = await probeElnCapabilities({
    readConfig: () => { throw new Error('config unreadable'); },
    listSecretNames: async () => ['OPENROUTER_API_KEY'], env: { LOCAL_LLM_URL: 'http://localhost:11434/v1' }, which: () => null,
  });
  expect(probe.provider).toBeUndefined();
  expect(probe.llmSecrets.map(entry => entry.name)).toEqual(['OPENROUTER_API_KEY']);
  expect(probe.local.llmUrl).toBe('http://localhost:11434/v1');
});

test('probe: a local provider is keyless and never asked for a key', async () => {
  let asked = false;
  const probe = await probeElnCapabilities({
    readConfig: () => config({ provider: 'local', model: 'llama3' }),
    providerHasKey: async () => { asked = true; return false; },
    listSecretNames: async () => [], env: { LOCAL_LLM_URL: 'http://localhost:11434/v1' }, which: () => null,
  });
  expect(probe.provider).toEqual({ name: 'local', model: 'llama3', baseUrl: 'http://localhost:11434/v1', hasKey: true, injectable: true, keyless: true });
  expect(asked).toBe(false);
});

test('run env is per capability: a mock TTS or a missing translation key never mocks the other capability', async () => {
  const mixed = await capabilityRunEnv([
    { capability: 'translation', env: { ELN_LLM_BASE_URL: 'u', ELN_LLM_MODEL: 'm' }, key: { kind: 'provider', provider: 'openrouter' }, keyEnv: 'ELN_LLM_API_KEY' },
    { capability: 'tts', env: { ELN_MOCK_TTS: '1' }, key: { kind: 'none' } },
  ], { providerApiKey: async () => KEY });
  expect(mixed).toEqual({ env: { ELN_LLM_BASE_URL: 'u', ELN_LLM_MODEL: 'm', ELN_LLM_API_KEY: KEY, ELN_MOCK_TTS: '1' }, missing: [] });
  expect(mixed.env.ELN_LLM_MOCK).toBeUndefined();
});
