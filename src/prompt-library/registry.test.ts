import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModelFamily } from '../models/prompts.js';
import { ANTHROPIC_CHAT_VARIANT } from './providers/anthropic.js';
import { CODEX_CHAT_VARIANT } from './providers/codex.js';
import { GEMINI_CHAT_VARIANT } from './providers/gemini.js';
import { GPT_CHAT_VARIANT } from './providers/gpt.js';
import { GROK_CHAT_VARIANT } from './providers/grok.js';
import { LOCAL_CHAT_VARIANT } from './providers/local.js';
import { SOLAR_CHAT_VARIANT } from './providers/solar.js';
import { resolveBuiltinChatVariant, resolveChatSystemPrompt } from './registry.js';

const DEFAULT_CONFIG = { taskVariant: 'default' } as const;

test('Solar Pro 4 selects its own prompt for app and wire ids', () => {
  for (const model of ['openrouter/upstage/solar-pro4', 'upstage/solar-pro4']) {
    expect(resolveChatSystemPrompt({ model, config: DEFAULT_CONFIG })).toMatchObject({
      source: 'builtin', variant: 'solar', text: SOLAR_CHAT_VARIANT,
    });
  }
  expect(resolveBuiltinChatVariant('openrouter/z-ai/glm-5.3')).toBe(GPT_CHAT_VARIANT);
});

describe('resolveBuiltinChatVariant — grok family', () => {
  test('grok-4.6 is already classified as grok and must stay that way', () => {
    expect(getModelFamily('grok-4.6')).toBe('grok');
  });

  test('grok-4.6 selects the dedicated grok variant, not the GPT default', () => {
    const text = resolveBuiltinChatVariant('grok-4.6');
    expect(text).toBe(GROK_CHAT_VARIANT);
    expect(text).not.toBe(GPT_CHAT_VARIANT);
    expect(text).toContain('Provider variant: grok');
  });
});

describe('resolveBuiltinChatVariant — gemini family', () => {
  test('gemini-3-pro is already classified as gemini and must stay that way', () => {
    expect(getModelFamily('gemini-3-pro')).toBe('gemini');
  });

  test('gemini-3-pro selects the dedicated gemini variant, not the GPT default', () => {
    const text = resolveBuiltinChatVariant('gemini-3-pro');
    expect(text).toBe(GEMINI_CHAT_VARIANT);
    expect(text).not.toBe(GPT_CHAT_VARIANT);
    expect(text).toContain('Provider variant: gemini');
  });
});

describe('resolveChatSystemPrompt — family selection is unchanged for existing families', () => {
  test('claude keeps the anthropic variant', () => {
    const r = resolveChatSystemPrompt({
      model: 'claude-opus-4-1',
      config: DEFAULT_CONFIG,
    });
    expect(r.variant).toBe('claude');
    expect(r.source).toBe('builtin');
    expect(r.text).toBe(ANTHROPIC_CHAT_VARIANT);
  });

  test('gpt keeps the gpt variant', () => {
    const r = resolveChatSystemPrompt({
      model: 'gpt-4.1',
      config: DEFAULT_CONFIG,
    });
    expect(r.variant).toBe('gpt');
    expect(r.text).toBe(GPT_CHAT_VARIANT);
  });

  test('codex keeps the codex variant', () => {
    const r = resolveChatSystemPrompt({
      model: 'gpt-5.4',
      config: DEFAULT_CONFIG,
    });
    expect(r.variant).toBe('codex');
    expect(r.text).toBe(CODEX_CHAT_VARIANT);
  });

  test('local keeps the local variant', () => {
    const r = resolveChatSystemPrompt({
      model: 'local:qwen',
      config: DEFAULT_CONFIG,
    });
    expect(r.variant).toBe('local');
    expect(r.text).toBe(LOCAL_CHAT_VARIANT);
  });

  test('unhandled families still fall through to the GPT default', () => {
    const unknown = resolveBuiltinChatVariant('mystery-model');
    expect(getModelFamily('mystery-model')).toBe('other');
    expect(unknown).toBe(GPT_CHAT_VARIANT);
  });

  test('grok-4.6 resolves to the grok builtin variant', () => {
    const r = resolveChatSystemPrompt({
      model: 'grok-4.6',
      config: DEFAULT_CONFIG,
    });
    expect(r.source).toBe('builtin');
    expect(r.variant).toBe('grok');
    expect(r.text).toBe(GROK_CHAT_VARIANT);
    expect(r.text).not.toBe(GPT_CHAT_VARIANT);
  });

  test('gemini-3-pro resolves to the gemini builtin variant', () => {
    const r = resolveChatSystemPrompt({
      model: 'gemini-3-pro',
      config: DEFAULT_CONFIG,
    });
    expect(r.source).toBe('builtin');
    expect(r.variant).toBe('gemini');
    expect(r.text).toBe(GEMINI_CHAT_VARIANT);
    expect(r.text).not.toBe(GPT_CHAT_VARIANT);
  });
});

describe('resolveChatSystemPrompt — override and forced builtin still beat family selection', () => {
  test('overridePath wins over the grok family branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompt-override-grok-'));
    try {
      const path = join(root, 'override.md');
      writeFileSync(path, 'OVERRIDE PROMPT\n');
      const r = resolveChatSystemPrompt({
        model: 'grok-4.6',
        config: { overridePath: path, taskVariant: 'default' },
      });
      expect(r.source).toBe('override');
      expect(r.variant).toBe('override');
      expect(r.text).toBe('OVERRIDE PROMPT\n');
      expect(r.text).not.toContain('Provider variant: grok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('forceBuiltinVariant wins over the grok family branch', () => {
    const r = resolveChatSystemPrompt({
      model: 'grok-4.6',
      config: { taskVariant: 'default', forceBuiltinVariant: 'gpt' },
    });
    expect(r.source).toBe('builtin');
    expect(r.variant).toBe('gpt');
    expect(r.text).toBe(GPT_CHAT_VARIANT);
    expect(r.text).not.toContain('Provider variant: grok');
  });

  test('overridePath wins over the gemini family branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompt-override-gemini-'));
    try {
      const path = join(root, 'override.md');
      writeFileSync(path, 'OVERRIDE PROMPT\n');
      const r = resolveChatSystemPrompt({
        model: 'gemini-3-pro',
        config: { overridePath: path, taskVariant: 'default' },
      });
      expect(r.source).toBe('override');
      expect(r.variant).toBe('override');
      expect(r.text).toBe('OVERRIDE PROMPT\n');
      expect(r.text).not.toContain('Provider variant: gemini');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('forceBuiltinVariant wins over the gemini family branch', () => {
    const r = resolveChatSystemPrompt({
      model: 'gemini-3-pro',
      config: { taskVariant: 'default', forceBuiltinVariant: 'gpt' },
    });
    expect(r.source).toBe('builtin');
    expect(r.variant).toBe('gpt');
    expect(r.text).toBe(GPT_CHAT_VARIANT);
    expect(r.text).not.toContain('Provider variant: gemini');
  });
});
