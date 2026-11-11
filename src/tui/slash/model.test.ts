import { afterEach, describe, expect, test } from 'bun:test';
import { clearSessionTierOverride, getSessionTierOverride } from '../../model-tier/session-override.js';
import { resolveLlmTier } from '../../model-tier/tier-resolver.js';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../core/registry.js';
import { applyNextTuiModelTier, parseNextTuiModelCommand } from './model.js';

const sessionId = 'next-tui-model-command-session';

afterEach(() => clearSessionTierOverride(sessionId));

describe('NEXT-TUI-SLASH-MODEL', () => {
  test('the registry routes /model and /provider to the same CORE command', () => {
    expect(resolveNextTuiRoute('/model fast', NEXT_TUI_INPUT_CONTEXT)?.id).toBe('model');
    expect(resolveNextTuiRoute('/provider deep', NEXT_TUI_INPUT_CONTEXT)?.id).toBe('model');
  });

  test('fast, normal, and deep map to the shared model-tier ladder', () => {
    expect(parseNextTuiModelCommand('/model fast')).toMatchObject({ kind: 'tier', choice: 'fast', tier: 'budget', label: '빠름' });
    expect(parseNextTuiModelCommand('/model normal')).toMatchObject({ kind: 'tier', choice: 'normal', tier: 'balanced', label: '보통' });
    expect(parseNextTuiModelCommand('/model deep')).toMatchObject({ kind: 'tier', choice: 'deep', tier: 'best', label: '깊음' });
    expect(parseNextTuiModelCommand('/provider 보통')).toMatchObject({ kind: 'tier', choice: 'normal', tier: 'balanced' });
  });

  test('a tier choice changes the active session override consumed by CORE turns', () => {
    const parsed = parseNextTuiModelCommand('/model deep');
    expect(parsed.kind).toBe('tier');
    if (parsed.kind !== 'tier') throw new Error('expected a tier command');
    applyNextTuiModelTier(sessionId, parsed.tier, parsed.choice);
    expect(getSessionTierOverride(sessionId)).toMatchObject({ llm: 'best', rationale: 'next TUI /model deep' });
    expect(resolveLlmTier(undefined, 'openai-codex', { sessionId })).toMatchObject({ tier: 'best', source: 'session-override' });
  });

  test('invalid model names fail with usage and legacy provider actions remain available', () => {
    expect(parseNextTuiModelCommand('/model weird')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('/model <fast|normal|deep>') });
    expect(parseNextTuiModelCommand('/model constructor').kind).toBe('invalid');
    expect(parseNextTuiModelCommand('/model __proto__').kind).toBe('invalid');
    expect(parseNextTuiModelCommand('/provider models openai-codex')).toEqual({ kind: 'provider', providerCommand: 'models openai-codex' });
    expect(parseNextTuiModelCommand('/provider use grok')).toEqual({ kind: 'provider', providerCommand: 'use grok' });
  });
});
