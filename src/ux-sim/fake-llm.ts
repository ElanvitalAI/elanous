/**
 * Deterministic, network-free LLM for gate tests without provider credentials.
 * The opt-in is deliberately explicit; production never selects this provider.
 */
import type { LLMMessage, LLMOpts, LLMProvider, LLMStreamEvent } from '../llm.js';

export const TEST_FAKE_LLM_ENV = 'ELANOUS_TEST_FAKE_LLM';
export const TEST_FAKE_LLM_RESPONSE_ENV = 'ELANOUS_TEST_FAKE_LLM_RESPONSE';

export function testFakeLlmEnabled(): boolean {
  return process.env[TEST_FAKE_LLM_ENV] === '1';
}

export function testFakeLlmResponse(): string {
  return process.env[TEST_FAKE_LLM_RESPONSE_ENV] ?? '[test-fake-llm] OK';
}

/** Shares the real LLMProvider contract; only the external model call is replaced. */
export const testFakeLlmProvider: LLMProvider = {
  name: 'test-fake-llm',
  defaultModel: 'test-fake-llm',
  available: testFakeLlmEnabled,
  async *chat(_messages: LLMMessage[], _opts?: LLMOpts): AsyncGenerator<string, void, unknown> {
    yield testFakeLlmResponse();
  },
  async *streamChat(_messages: LLMMessage[], _opts?: LLMOpts): AsyncGenerator<LLMStreamEvent, void, unknown> {
    yield { type: 'text', delta: testFakeLlmResponse() };
  },
};
