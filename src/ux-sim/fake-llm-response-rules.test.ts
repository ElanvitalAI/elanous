import { afterEach, expect, test } from 'bun:test';
import type { LLMMessage } from '../llm.js';
import { TEST_FAKE_LLM_RESPONSE_ENV, TEST_FAKE_LLM_RESPONSE_RULES_ENV, testFakeLlmResponse } from './fake-llm.js';

const saved = { rules: process.env[TEST_FAKE_LLM_RESPONSE_RULES_ENV], response: process.env[TEST_FAKE_LLM_RESPONSE_ENV] };
afterEach(() => {
  for (const [env, value] of [[TEST_FAKE_LLM_RESPONSE_RULES_ENV, saved.rules], [TEST_FAKE_LLM_RESPONSE_ENV, saved.response]] as const) {
    if (value === undefined) delete process.env[env]; else process.env[env] = value;
  }
});

const user = (content: string): LLMMessage => ({ role: 'user', content });

test('RESPONSE_RULES: the newest user message with a marker picks the reply; no marker falls back to RESPONSE', () => {
  process.env[TEST_FAKE_LLM_RESPONSE_ENV] = 'fallback';
  process.env[TEST_FAKE_LLM_RESPONSE_RULES_ENV] = JSON.stringify([
    { when: '[골 이어가기]', text: 'continued' }, { when: 'SP1', text: 'pledge' }, { when: 'SP2', text: 'waiting' }]);
  expect(testFakeLlmResponse([user('SP1 plan')])).toBe('pledge');
  // An internal continuation turn carries its own marker and wins over the older person's turn.
  expect(testFakeLlmResponse([user('SP1 plan'), { role: 'assistant', content: 'x' }, user('[골 이어가기] 방금 답이 …')])).toBe('continued');
  // A tool result after the turn's prompt keeps the turn's reply (typed tool_result blocks and plain-text results alike).
  expect(testFakeLlmResponse([user('SP2 wait'), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } as LLMMessage])).toBe('waiting');
  expect(testFakeLlmResponse([user('SP2 wait'), user('{"ok":true}')])).toBe('waiting');
  expect(testFakeLlmResponse([user('hello')])).toBe('fallback');
});

test('RESPONSE_RULES: malformed or empty rules never break the fallback', () => {
  process.env[TEST_FAKE_LLM_RESPONSE_ENV] = 'fallback';
  for (const raw of ['not json', '{}', '[{"when":"","text":"x"}]', '[{"when":"SP1"}]']) {
    process.env[TEST_FAKE_LLM_RESPONSE_RULES_ENV] = raw;
    expect(testFakeLlmResponse([user('SP1 plan')])).toBe('fallback');
  }
});
