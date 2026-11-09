import { describe, expect, test } from 'bun:test';
import { budgetModel } from '../../src/llm/model-defaults.js';
import { lookupLlmTierSpec } from '../../src/model-tier/index.js';
import type { LLMProviderName } from '../../src/user-config/types.js';

describe('budgetModel', () => {
  test('resolves each explicit provider through its budget tier', () => {
    for (const provider of ['anthropic', 'openai', 'openai-codex', 'gemini', 'grok', 'local'] as LLMProviderName[]) {
      expect(budgetModel(provider)).toBe(lookupLlmTierSpec(provider, 'budget').model);
    }
  });
});
