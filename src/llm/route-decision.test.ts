import { describe, expect, test } from 'bun:test';
import { resolveRouteDecision } from './route-decision.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';

describe('resolveRouteDecision', () => {
  test('quick route without policy uses the configured model and records its source', () => {
    const decision = resolveRouteDecision({
      provider: 'openai-codex',
      configuredModel: 'gpt-6-luna',
      text: 'hi',
    });

    expect(decision.mission).toBe('quick');
    expect(decision.model).toBe('gpt-6-luna');
    expect(decision.source).toBe('active-provider-default');
    expect(decision.source).not.toBe('legacy-default');
  });

  test('quick route without a configured model preserves the legacy default', () => {
    const decision = resolveRouteDecision({
      provider: 'openai-codex',
      text: 'hi',
    });

    expect(decision.mission).toBe('quick');
    expect(decision.model).toBe(lookupLlmTierSpec('openai-codex', 'better').model);
    expect(decision.source).toBe('legacy-default');
  });

  test('Telegram quick keeps the coding tier while TUI quick keeps the configured model', () => {
    const input = { provider: 'openai-codex' as const, configuredModel: 'gpt-6-luna', text: 'hi' };
    expect(resolveRouteDecision({ ...input, surface: 'telegram' }).model)
      .toBe(lookupLlmTierSpec('openai-codex', 'better').model);
    expect(resolveRouteDecision({ ...input, surface: 'tui' }).model).toBe('gpt-6-luna');
  });

  test('explicit Codex route policy continues to select the tier model', () => {
    const decision = resolveRouteDecision({
      provider: 'openai-codex',
      configuredModel: 'gpt-6-luna',
      text: 'hi',
      routePolicy: { mode: 'codex-first' },
    });

    expect(decision.model).toBe(lookupLlmTierSpec('openai-codex', 'better').model);
    expect(decision.source).toBe('codex-tier-policy');
  });
});
