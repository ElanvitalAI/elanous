// ── Provider summary tests ──

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectActiveProvider, oneLineProvider, renderProviderStatus } from '../src/provider-summary';
import * as grokCredential from '../src/grok/credential';
import * as config from '../src/config';
import { saveTokens } from '../src/oauth/store';
import { CODEX_DEFAULT_MODEL } from '../src/llm';
import type { UserConfig } from '../src/user-config';

function baseConfig(): UserConfig {
  return {
    skillRouter: {
      autoRoute: false, autoRouteCountdownMs: 1000, llmFallback: false,
      keywordScoreThreshold: 2, llmConfidenceThreshold: 0.5,
      autoRouteMinScore: 1, autoRouteRequireAutoTrigger: true,
    },
    llm: { provider: 'auto' },
    skills: { activeSet: 'opencode', dirs: [] },
    obsidian: { vault: '/tmp/v' },
    telegram: { enabled: false, allowedUsers: [] },
    onboarding: { completed: true, version: 1 },
    raw: {},
  };
}

const savedEnv: Record<string, string | undefined> = {};
const resolveGrokCredential = grokCredential.resolveGrokCredential;
const isolatedEnv = ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL', 'HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME'] as const;
let root: string;

function writeGrokSubscriptionCredential(): void {
  mkdirSync(join(root, '.grok'), { recursive: true });
  writeFileSync(join(root, '.grok', 'auth.json'), JSON.stringify({
    'https://auth.x.ai::test': { key: 'subscription-token', expires_at: '2099-01-01T00:00:00.000Z' },
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'provider-summary-'));
  for (const k of isolatedEnv) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
  spyOn(grokCredential, 'resolveGrokCredential').mockImplementation(((opts = {}) => (
    resolveGrokCredential({ ...opts, home: root })
  )) as typeof resolveGrokCredential);
  spyOn(config, 'getGrokApiKey').mockImplementation(() => (
    process.env.XAI_API_KEY || process.env.GROK_API_KEY
  ));
  spyOn(config, 'getAnthropicApiKey').mockImplementation(() => process.env.ANTHROPIC_API_KEY);
  spyOn(config, 'getOpenAIApiKey').mockImplementation(() => process.env.OPENAI_API_KEY);
  spyOn(config, 'getGeminiApiKey').mockImplementation(() => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  spyOn(config, 'getLocalLLMUrl').mockImplementation(() => process.env.LOCAL_LLM_URL);
});
afterEach(() => {
  spyOn(grokCredential, 'resolveGrokCredential').mockRestore();
  spyOn(config, 'getGrokApiKey').mockRestore();
  spyOn(config, 'getAnthropicApiKey').mockRestore();
  spyOn(config, 'getOpenAIApiKey').mockRestore();
  spyOn(config, 'getGeminiApiKey').mockRestore();
  spyOn(config, 'getLocalLLMUrl').mockRestore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('inspectActiveProvider', () => {
  test('uses the configured model until a backend confirms a runtime model', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'openai-codex', model: 'gpt-5.5' };
    expect(inspectActiveProvider(cfg).model).toBe('gpt-5.5');
  });

  test('prefers an explicit session-confirmed runtime model over the configured alias', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'openai-codex', model: 'gpt-5.5' };
    expect(inspectActiveProvider(cfg, 'gpt-5.6-terra').model).toBe('gpt-5.6-terra');
  });

  test('codex + OAuth tokens → auth=oauth', () => {
    saveTokens('openai-codex', {
      accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    const cfg = baseConfig();
    cfg.llm = { provider: 'openai-codex', model: 'gpt-5.4-mini' };
    const info = inspectActiveProvider(cfg);
    expect(info.provider).toBe('openai-codex');
    expect(info.auth).toBe('oauth');
    expect(info.authDetail).toMatch(/OAuth/);
    expect(info.note).toMatch(/GPT-5\.4 Mini/);
  });

  test('codex + apiKey (no tokens) → auth=apikey', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'openai-codex', apiKey: 'sk-x', model: 'gpt-5.4' };
    const info = inspectActiveProvider(cfg);
    expect(info.auth).toBe('apikey');
    expect(info.authDetail).toMatch(/API key/);
  });

  test('codex with no tokens and no apiKey → auth=none', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'openai-codex' };
    const info = inspectActiveProvider(cfg);
    expect(info.auth).toBe('none');
    expect(info.authDetail).toMatch(/elanous login openai-codex|elanous codex setup/);
  });

  test('grok subscription takes precedence over config apiKey', () => {
    writeGrokSubscriptionCredential();
    const cfg = baseConfig();
    cfg.llm = { provider: 'grok', apiKey: 'xai-x', model: 'grok-4' };
    const info = inspectActiveProvider(cfg);
    expect(info.provider).toBe('grok');
    expect(info.model).toBe('grok-4');
    expect(info.auth).toBe('oauth');
    expect(info.authDetail).toBe('구독 OAuth (~/.grok/auth.json · `grok login`)');
  });

  test('grok env API key takes precedence over config apiKey when no subscription exists', () => {
    process.env.GROK_CODE_XAI_API_KEY = 'env-xai';
    const cfg = baseConfig();
    cfg.llm = { provider: 'grok', apiKey: 'xai-x' };
    const info = inspectActiveProvider(cfg);
    expect(info.auth).toBe('apikey');
    expect(info.authDetail).toBe('API key (env GROK_CODE_XAI_API_KEY)');
  });

  test('grok config apiKey alone is reported as the active request credential', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'grok', apiKey: 'xai-x' };
    const runtimeCredential = grokCredential.resolveGrokCredential({ home: root });
    const info = inspectActiveProvider(cfg);
    expect(runtimeCredential).toBeNull();
    expect(info.auth).toBe('apikey');
    expect(info.authDetail).toBe('API key (config)');
  });

  test('auto with nothing configured → auth=none', () => {
    const cfg = baseConfig();
    const info = inspectActiveProvider(cfg);
    expect(info.provider).toBe('auto');
    expect(info.auth).toBe('none');
  });

  test('auto subscription-first → codex OAuth summary before env keys', () => {
    saveTokens('openai-codex', {
      accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    process.env.XAI_API_KEY = 'env-xai';
    const cfg = baseConfig();
    const info = inspectActiveProvider(cfg);
    expect(info.provider).toBe('auto:openai-codex');
    expect(info.model).toBe(CODEX_DEFAULT_MODEL);   // ⛔ 이름을 박지 않는다 — 모델 이관 때마다 늙었다(09-23 GPT-6)
    expect(info.auth).toBe('oauth');
    expect(info.authDetail).toBe('OAuth — auto subscription-first (openai-codex)');
  });

  test('auto fallthrough → grok from env when no subscription exists', () => {
    process.env.XAI_API_KEY = 'env-xai';
    const cfg = baseConfig();
    const info = inspectActiveProvider(cfg);
    expect(info.provider).toBe('auto:grok');
    expect(info.auth).toBe('apikey');
  });

  test('local provider with baseUrl', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3' };
    const info = inspectActiveProvider(cfg);
    expect(info.provider).toBe('local');
    expect(info.auth).toBe('local');
    expect(info.authDetail).toMatch(/localhost:11434/);
  });
});

describe('oneLineProvider', () => {
  test('format: provider: X / Y · auth detail', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'grok', apiKey: 'k', model: 'grok-4' };
    const line = oneLineProvider(inspectActiveProvider(cfg));
    expect(line).toMatch(/^provider: grok \/ grok-4 ·/);
  });
});

describe('renderProviderStatus', () => {
  test('includes provider / model / auth lines', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'openai-codex', apiKey: 'sk', model: 'gpt-5.4' };
    const out = renderProviderStatus(inspectActiveProvider(cfg));
    expect(out).toContain('provider : openai-codex');
    expect(out).toContain('model    : gpt-5.4');
    expect(out).toContain('auth     :');
  });

  test('auth=none renders fix-it hint', () => {
    const cfg = baseConfig();
    cfg.llm = { provider: 'openai-codex' };
    const out = renderProviderStatus(inspectActiveProvider(cfg));
    expect(out).toMatch(/elanous setup|elanous codex setup/);
  });
});
