import { describe, expect, spyOn, test } from 'bun:test';
import { resolveRouteDecision, clearSurfaceRouteDecision, recordCurrentRouteDecision, currentRouteExecution, routeFallbackLabel } from './route-decision.js';
import { recordDashboardTurnExecution } from '../dashboard/acp-active-model.js';
import { statusModelActual } from '../status/status-provider-info.js';
import { debug } from '../debug/log.js';
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

describe('dashboard displayed model vs actual execution warning', () => {
  const planned = () => resolveRouteDecision({
    provider: 'openai-codex', text: 'hi', explicitModel: 'displayed-model',
  });

  test('a different actual model displays the fallback and emits exactly one warn with both models', () => {
    clearSurfaceRouteDecision('dashboard');
    const decision = planned();
    recordCurrentRouteDecision('dashboard', decision);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      recordDashboardTurnExecution({ model: 'actual-model', routeProvider: 'grok' }, { remote: false });

      expect(routeFallbackLabel('dashboard')).toBe('displayed-model → actual-model');
      expect(statusModelActual('dashboard')).toEqual({ model: 'actual-model', provider: 'grok', fallbackFrom: 'displayed-model' });
      expect(currentRouteExecution('dashboard')).toEqual({ model: 'actual-model', provider: 'grok' });
      expect(log.mock.calls.filter(([, , , options]) => options?.level === 'warn')).toEqual([
        ['llm.route-decision', 'dashboard-executed-fallback', {
          planned: { provider: decision.provider, model: 'displayed-model' },
          actual: { provider: 'grok', model: 'actual-model' },
        }, { level: 'warn' }],
      ]);
    } finally {
      log.mockRestore();
      clearSurfaceRouteDecision('dashboard');
    }
  });

  test('a matching actual model displays no fallback and emits zero warns', () => {
    clearSurfaceRouteDecision('dashboard');
    recordCurrentRouteDecision('dashboard', planned());
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      recordDashboardTurnExecution({ model: 'displayed-model', routeProvider: 'openai-codex' }, { remote: false });

      expect(routeFallbackLabel('dashboard')).toBeNull();
      expect(statusModelActual('dashboard')).toEqual({ model: 'displayed-model', provider: 'openai-codex' });
      expect(currentRouteExecution('dashboard')).toEqual({ model: 'displayed-model', provider: 'openai-codex' });
      expect(log.mock.calls.filter(([, , , options]) => options?.level === 'warn')).toHaveLength(0);
    } finally {
      log.mockRestore();
      clearSurfaceRouteDecision('dashboard');
    }
  });
});
