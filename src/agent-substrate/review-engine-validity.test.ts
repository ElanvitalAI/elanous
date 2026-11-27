// REVIEW-NO-SILENT-GLM-FALLBACK (#38331 · #38365 Terra mustFix 1·2) — engine family and the requested ≠ responded verdict.
import { describe, expect, test } from 'bun:test';
import { assessReviewEngineValidity, reviewEngineFamily } from './review-engine-validity.js';

describe('reviewEngineFamily — structured token, not a keyword list', () => {
  test.each([
    ['acp:claude', 'claude'], ['acp:claude/opus', 'claude'], ['acp:claude-acp', 'claude'], ['claude-opus-4-5', 'claude'], ['opus', 'claude'],
    ['anthropic/claude-sonnet-4', 'claude'], ['openrouter/z-ai/glm-5.3', 'glm'], ['z-ai/glm-5.3', 'glm'], ['glm', 'glm'], ['glm-5.3', 'glm'],
    ['gpt-6.1-terra', 'gpt'], ['gpt-6-sol', 'gpt'], ['acp:codex', 'gpt'], ['o3', 'gpt'], ['grok-4.6', 'grok'], ['acp:gemini', 'gemini'],
    // Unregistered families are their own family — never folded into the route's.
    ['deepseek-v3', 'deepseek'], ['deepseek/deepseek-chat', 'deepseek'], ['qwen/qwen3-coder', 'qwen'], ['local:capture-test', 'capture'],
  ] as const)('%s → %s', (value, family) => {
    expect(reviewEngineFamily(value)).toBe(family);
  });

  test('a report that states no family stays unmeasured — never guessed', () => {
    for (const value of ['default', 'auto', '', '   ', '4.5', undefined, null]) expect(reviewEngineFamily(value)).toBeUndefined();
    // #38365 Terra r3 — a provider/backend path alone never names the family.
    for (const value of ['anthropic/default', 'acp:claude/default']) expect(reviewEngineFamily(value)).toBeUndefined();
  });
});

describe('assessReviewEngineValidity', () => {
  test('claude requested, GLM answered via the landing-gate route mismatch → invalid', () => {
    expect(assessReviewEngineValidity({ requested: 'acp:claude', respondedModel: 'z-ai/glm-5.3', landingGateState: 'mismatch' }))
      .toEqual({ invalid: true, invalidReason: 'responded-model-mismatch', requestedEngine: 'claude', respondedEngine: 'glm' });
  });

  test('GPT requested, DeepSeek responded on the matching route → invalid (mustFix 1)', () => {
    expect(assessReviewEngineValidity({ requested: 'gpt-6.1-terra', respondedModel: 'deepseek-v3', landingGateState: 'consistent' }))
      .toEqual({ invalid: true, invalidReason: 'responded-model-mismatch', requestedEngine: 'gpt', respondedEngine: 'deepseek' });
    expect(assessReviewEngineValidity({ requested: 'acp:claude', respondedModel: 'qwen3-coder', landingGateState: 'consistent' }))
      .toMatchObject({ invalid: true, invalidReason: 'responded-model-mismatch', respondedEngine: 'qwen' });
  });

  test('responder unknown → respondedEngine unmeasured (no route inference) and fail-closed when requested (mustFix 2)', () => {
    for (const respondedModel of [undefined, 'default']) {
      expect(assessReviewEngineValidity({ requested: 'acp:claude', respondedModel, landingGateState: 'consistent' }))
        .toEqual({ invalid: true, invalidReason: 'responded-model-unknown', requestedEngine: 'claude', respondedEngine: 'unmeasured' });
    }
  });

  test('genuine responders are valid', () => {
    expect(assessReviewEngineValidity({ requested: 'acp:claude', respondedModel: 'claude-opus-4-5', landingGateState: 'consistent' }))
      .toEqual({ invalid: false, requestedEngine: 'claude', respondedEngine: 'claude' });
    expect(assessReviewEngineValidity({ requested: 'gpt-6.1-terra', respondedModel: 'gpt-6.1-terra', landingGateState: 'consistent' }))
      .toEqual({ invalid: false, requestedEngine: 'gpt', respondedEngine: 'gpt' });
  });

  test('GLM cannot supply review evidence, even when explicitly requested or selected implicitly', () => {
    expect(assessReviewEngineValidity({ requested: 'z-ai/glm-5.3', respondedModel: 'z-ai/glm-5.3' }))
      .toEqual({ invalid: true, invalidReason: 'glm-review-forbidden', requestedEngine: 'glm', respondedEngine: 'glm' });
    expect(assessReviewEngineValidity({ respondedModel: 'z-ai/glm-5.3' }))
      .toEqual({ invalid: true, invalidReason: 'glm-review-forbidden', respondedEngine: 'glm' });
    expect(assessReviewEngineValidity({})).toEqual({ invalid: false, respondedEngine: 'unmeasured' });
  });
});
