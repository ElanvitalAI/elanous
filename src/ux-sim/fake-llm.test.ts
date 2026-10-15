import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider, getProviderForConfig } from '../llm.js';
import type { UserConfig } from '../user-config.js';
import { _resetKeyCacheForTests } from '../config.js';
import * as grokCredential from '../grok/credential.js';
import { testFakeLlmEnabled, testFakeLlmProvider } from './fake-llm.js';

const names = [
  'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_TEST_FAKE_LLM_RESPONSE',
  'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'LOCAL_LLM_URL',
  'HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_KEY_CACHE_DIR',
] as const;
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const dirs: string[] = [];

afterEach(() => {
  spyOn(grokCredential, 'resolveGrokCredential').mockRestore();
  _resetKeyCacheForTests();
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function keyless(): void {
  for (const name of names) if (name.endsWith('_API_KEY') || name === 'LOCAL_LLM_URL') delete process.env[name];
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-'));
  dirs.push(dir);
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.CODEX_HOME = join(dir, 'codex');
  process.env.ELANOUS_KEY_CACHE_DIR = dir;
  _resetKeyCacheForTests();
  spyOn(grokCredential, 'resolveGrokCredential').mockImplementation((() => null) as typeof grokCredential.resolveGrokCredential);
}

test('test fake is opt-in and returns a fixed stream without network access', async () => {
  delete process.env.ELANOUS_TEST_FAKE_LLM;
  expect(testFakeLlmEnabled()).toBe(false);
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  expect(testFakeLlmProvider.available()).toBe(true);
  const messages = [{ role: 'user' as const, content: 'a secret prompt' }];
  const first = await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  const second = await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  expect(first).toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
  expect(second).toEqual(first);
  expect((await Array.fromAsync(testFakeLlmProvider.chat(messages))).join('')).toBe('[test-fake-llm] OK');
  process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = '{"ok":true}';
  expect(await Array.fromAsync(testFakeLlmProvider.chat(messages))).toEqual(['{"ok":true}']);
});

test('keyless auto routing selects fake only when test env is enabled', () => {
  keyless();
  const config = { llm: { provider: 'auto' } } as UserConfig;
  delete process.env.ELANOUS_TEST_FAKE_LLM;
  expect(() => getProviderForConfig(config)).toThrow('No LLM provider available');
  expect(() => getProvider()).toThrow('No LLM provider available');
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  expect(getProviderForConfig(config).name).toBe('test-fake-llm');
  expect(getProvider().name).toBe('test-fake-llm');
});

test('test env leaves real auto candidates and explicit providers ahead of fake', () => {
  keyless();
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env.OPENROUTER_API_KEY = 'test-only-key';
  const auto = { llm: { provider: 'auto' } } as UserConfig;
  expect(getProviderForConfig(auto).name).toBe('openrouter');
  delete process.env.OPENROUTER_API_KEY;
  _resetKeyCacheForTests();
  const explicit = { llm: { provider: 'openai', apiKey: 'test-only-key' } } as UserConfig;
  expect(getProviderForConfig(explicit).name).toBe('openai');
  const loopback = { llm: { provider: 'local', baseUrl: 'http://127.0.0.1:43210/v1' } } as UserConfig;
  expect(getProviderForConfig(loopback).name).toBe('local');
});
