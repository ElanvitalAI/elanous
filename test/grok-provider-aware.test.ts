// ── Grok (now provider-agnostic) refactor smoke tests ──
//
// Confirms the former grok-only diff analyzer now routes through
// user-config. Doesn't hit the network — we verify the
// isAnalyzerAvailable() and anyProviderAvailable() gates only.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAnalyzerAvailable, isGrokAvailable } from '../src/grok';
import { anyProviderAvailable, decideProviderForConfig } from '../src/llm';
import { DEFAULT_FALLBACK_CHAIN, normalizeFallbackChain } from '../src/oauth/fallback-chain';
import { saveTokens } from '../src/oauth/store';
import { _resetKeyCacheForTests } from '../src/config';
import { saveUserConfig, buildUserConfig, resetUserConfig } from '../src/user-config';

const saved: Record<string, string | undefined> = {};
let root: string;
let cfgPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grok-provider-'));
  cfgPath = join(root, 'elanous', 'config.json');
  for (const k of [
    'XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
    'LOCAL_LLM_URL', 'ELANOUS_LLM_PROVIDER', 'ELANOUS_ESCALATE_PROVIDER',
    'XDG_CONFIG_HOME', 'CODEX_HOME', 'HOME', 'ELANOUS_KEY_CACHE_DIR',
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
  process.env.HOME = root;
  process.env.ELANOUS_KEY_CACHE_DIR = join(root, 'key-cache');
  _resetKeyCacheForTests();
  resetUserConfig();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
  _resetKeyCacheForTests();
  resetUserConfig();
});

describe('isAnalyzerAvailable — back-compat alias isGrokAvailable', () => {
  test('alias points at the same function', () => {
    expect(isGrokAvailable).toBe(isAnalyzerAvailable);
  });

  test('false when no providers configured', () => {
    expect(isAnalyzerAvailable()).toBe(false);
  });

  test('true when anthropic env var present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    expect(isAnalyzerAvailable()).toBe(true);
  });

  test('true when codex OAuth tokens on file (no env var)', () => {
    saveTokens('openai-codex', {
      accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    expect(isAnalyzerAvailable()).toBe(true);
    expect(decideProviderForConfig(buildUserConfig(cfgPath)).provider).toBe('auto:openai-codex');
  });
});

describe('anyProviderAvailable', () => {
  test('false with nothing configured', () => {
    expect(anyProviderAvailable()).toBe(false);
  });

  test('true when env provider is set even if config says provider=auto', () => {
    process.env.XAI_API_KEY = 'xai-env';
    expect(anyProviderAvailable()).toBe(true);
  });

  test('auto prefers codex OAuth over other available providers and keeps the configured fallback order', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    saveTokens('openai-codex', {
      accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.provider).toBe('auto');
    expect(normalizeFallbackChain(cfg.llm.fallbackChain).chain).toEqual(DEFAULT_FALLBACK_CHAIN);
    expect(DEFAULT_FALLBACK_CHAIN).toEqual(['codex-rotate', 'grok']);
    expect(decideProviderForConfig(cfg).provider).toBe('auto:openai-codex');
  });

  test('true when config.provider=openai-codex + OAuth tokens, no env', () => {
    const cfg = buildUserConfig(cfgPath);
    cfg.llm.provider = 'openai-codex';
    saveUserConfig(cfg, cfgPath);
    saveTokens('openai-codex', {
      accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    resetUserConfig();
    expect(anyProviderAvailable()).toBe(true);
  });

  test('false when config says local but no baseUrl', () => {
    const cfg = buildUserConfig(cfgPath);
    cfg.llm.provider = 'local';
    saveUserConfig(cfg, cfgPath);
    resetUserConfig();
    expect(anyProviderAvailable()).toBe(false);
  });

  test('true when local + baseUrl set', () => {
    const cfg = buildUserConfig(cfgPath);
    cfg.llm.provider = 'local';
    cfg.llm.baseUrl = 'http://localhost:11434/v1';
    saveUserConfig(cfg, cfgPath);
    resetUserConfig();
    expect(anyProviderAvailable()).toBe(true);
  });
});
