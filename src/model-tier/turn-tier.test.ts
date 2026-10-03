import { afterEach, describe, expect, test } from 'bun:test';
import { lookupLlmTierSpec } from './llm-tier-map.js';
import { clearSessionTierOverride, setSessionTierOverride } from './session-override.js';
import { explicitTurnTier } from './turn-tier.js';

const sessionId = 'turn-tier-test';
const cfg = (modelTier?: object) => ({ llm: { provider: 'openai-codex' }, modelTier }) as never;

afterEach(() => clearSessionTierOverride(sessionId));

describe('explicitTurnTier', () => {
  test('session LLM override takes precedence over the configured surface tier', () => {
    setSessionTierOverride(sessionId, { llm: 'best', rationale: 'user choice' });
    expect(explicitTurnTier(cfg({ llm: 'budget' }), sessionId)).toEqual({
      model: lookupLlmTierSpec('openai-codex', 'best').model,
      tier: 'best', source: 'session-override', reasoningEffort: 'high',
    });
  });

  test('configured LLM surface tier is used without a session override', () => {
    expect(explicitTurnTier(cfg({ llm: 'budget' }), sessionId)).toEqual({
      model: lookupLlmTierSpec('openai-codex', 'budget').model,
      tier: 'budget', source: 'user-config-surface', reasoningEffort: 'minimal',
    });
    setSessionTierOverride(sessionId, { stt: 'best', rationale: 'voice only' });
    expect(explicitTurnTier(cfg({ llm: 'budget' }), sessionId)?.source).toBe('user-config-surface');
  });

  test('preset, profile and default do not change the existing turn model', () => {
    for (const tier of [undefined, { preset: 'some-preset' }, { profile: 'power' }]) {
      expect(explicitTurnTier(cfg(tier), sessionId)).toBeUndefined();
    }
  });

  test('codex tiers that share one model differ by reasoning effort', () => {
    const efforts = (['balanced', 'better', 'best'] as const).map(llm => explicitTurnTier(cfg({ llm }), sessionId));
    expect(new Set(efforts.map(t => t?.model)).size).toBe(1);
    expect(efforts.map(t => t?.reasoningEffort)).toEqual(['low', 'medium', 'high']);
  });

  test('failed resolution is soft', () => {
    expect(explicitTurnTier({ modelTier: { llm: 'best' } } as never, sessionId)).toBeUndefined();
  });
});
