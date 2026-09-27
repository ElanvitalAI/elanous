// ── Provider selection from user-config (Phase 2, session 13) ──
//
// Verifies that getProviderForConfig:
//   - Delegates to env-var getProvider when llm.provider === 'auto'.
//   - Honors explicit provider + apiKey + model + baseUrl overrides.
//   - Exposes the new 'openai-codex' provider.
//
// Does NOT make real HTTP calls — we only inspect .name, .defaultModel,
// and .available(). Streaming behavior is covered by the integration
// tests that run against stubbed fetch.

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProviderForConfig, noProviderAvailableMessage, CODEX_DEFAULT_MODEL, PROVIDERS, isLoopbackBaseUrl, decideProviderForConfig, finalizeProviderModelCompatibility, resolveDefaultProvider, streamLLM, type ProviderDecision } from '../src/llm';
import { inspectActiveProvider } from '../src/provider-summary';
import { resolveActiveProvider, setUserConfigOverlay, type UserConfig } from '../src/user-config';
import { saveTokens, loadTokens } from '../src/oauth/store';
import * as grokCredential from '../src/grok/credential';
import * as config from '../src/config';
import { debug } from '../src/debug/log';

function baseUserConfig(): UserConfig {
  return {
    skillRouter: {
      autoRoute: false,
      autoRouteCountdownMs: 1000,
      llmFallback: false,
      keywordScoreThreshold: 2,
      llmConfidenceThreshold: 0.5,
      autoRouteMinScore: 1.0,
      autoRouteRequireAutoTrigger: true,
    },
    llm: { provider: 'auto' },
    skills: { activeSet: 'opencode', dirs: [] },
    obsidian: { vault: '/tmp/v' },
    telegram: { enabled: false, allowedUsers: [] },
    onboarding: { completed: false, version: 0 },
    raw: {},
  };
}

const savedEnv: Record<string, string | undefined> = {};
const resolveGrokCredential = grokCredential.resolveGrokCredential;
const originalFetch = globalThis.fetch;
let tmpXdg: string | null = null;

function writeGrokSubscriptionCredential(): void {
  if (!tmpXdg) throw new Error('tmpXdg not initialized');
  mkdirSync(join(tmpXdg, '.grok'), { recursive: true });
  writeFileSync(join(tmpXdg, '.grok', 'auth.json'), JSON.stringify({
    'https://auth.x.ai::test': { key: 'subscription-token', expires_at: '2099-01-01T00:00:00.000Z' },
  }));
}

beforeEach(() => {
  for (const k of ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Redirect the OAuth store to a tmp dir so tests can't leak into
  // (or read from) the user's real ~/.config/elanous/auth.json.
  tmpXdg = mkdtempSync(join(tmpdir(), 'llm-cfg-'));
  savedEnv.HOME = process.env.HOME;
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  savedEnv.CODEX_HOME = process.env.CODEX_HOME;
  process.env.HOME = tmpXdg;
  process.env.XDG_CONFIG_HOME = tmpXdg;
  process.env.CODEX_HOME = join(tmpXdg, 'codex-home');
  spyOn(grokCredential, 'resolveGrokCredential').mockImplementation(((opts = {}) => (
    resolveGrokCredential({ ...opts, home: tmpXdg ?? undefined })
  )) as typeof resolveGrokCredential);
  spyOn(grokCredential, 'resolveFreshGrokCredential').mockImplementation((opts = {}) => (
    resolveGrokCredential({ ...opts, home: tmpXdg ?? undefined })
  ));
  spyOn(config, 'getOpenAIApiKey').mockImplementation(() => process.env.OPENAI_API_KEY);
  spyOn(config, 'getAnthropicApiKey').mockImplementation(() => process.env.ANTHROPIC_API_KEY);
  spyOn(config, 'getGeminiApiKey').mockImplementation(() => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  spyOn(config, 'getLocalLLMUrl').mockImplementation(() => process.env.LOCAL_LLM_URL);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setUserConfigOverlay(null);
  spyOn(config, 'getOpenAIApiKey').mockRestore();
  spyOn(config, 'getAnthropicApiKey').mockRestore();
  spyOn(config, 'getGeminiApiKey').mockRestore();
  spyOn(config, 'getLocalLLMUrl').mockRestore();
  spyOn(grokCredential, 'resolveGrokCredential').mockRestore();
  spyOn(grokCredential, 'resolveFreshGrokCredential').mockRestore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tmpXdg) { rmSync(tmpXdg, { recursive: true, force: true }); tmpXdg = null; }
});

describe('getProviderForConfig — explicit provider overrides', () => {
  test('grok with inline apiKey preserves runtime credential availability', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'grok', apiKey: 'xai-test', model: 'grok-4' };
    const p = getProviderForConfig(cfg);
    const decision = decideProviderForConfig(cfg);
    const envCredential = grokCredential.resolveGrokCredential({ home: tmpXdg ?? undefined, model: 'grok-4' });
    expect(p.name).toBe('grok');
    expect(p.defaultModel).toBe('grok-4');
    expect(envCredential).toBeNull();
    expect(decision.auth).toBe('apikey');
    expect(p.available()).toBe(true);
  });

  test('grok inline apiKey is the credential sent by the config-routed runtime provider', async () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'grok', apiKey: 'xai-config-runtime', model: 'grok-4' };
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), auth: headers.get('Authorization') });
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const p = getProviderForConfig(cfg);
    const chunks: string[] = [];
    for await (const chunk of p.chat([{ role: 'user', content: 'hello' }])) chunks.push(chunk);

    expect(chunks).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('api.x.ai');
    expect(requests[0]?.auth).toBe('Bearer xai-config-runtime');
  });

  test('grok without apiKey is not available', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'grok' };
    const p = getProviderForConfig(cfg);
    expect(p.available()).toBe(false);
  });

  test('openai with apiKey and custom model', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' };
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('openai');
    expect(p.defaultModel).toBe('gpt-4o');
    expect(p.available()).toBe(true);
  });

  test('openai-codex exposes codex default model', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai-codex', apiKey: 'sk-codex' };
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('openai-codex');
    expect(p.defaultModel).toBe(CODEX_DEFAULT_MODEL);
    expect(p.available()).toBe(true);
  });

  test('openai-codex honors custom baseUrl', () => {
    const cfg = baseUserConfig();
    cfg.llm = {
      provider: 'openai-codex',
      apiKey: 'sk-codex',
      baseUrl: 'http://codex-proxy.local/v1',
      model: 'codex-mini-latest',
    };
    const p = getProviderForConfig(cfg);
    // Can't inspect the URL from outside; just make sure it didn't throw.
    expect(p.name).toBe('openai-codex');
    expect(p.available()).toBe(true);
  });

  test('gemini with apiKey', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'gemini', apiKey: 'AIza-test', model: 'gemini-2.5-pro' };
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('gemini');
    expect(p.defaultModel).toBe('gemini-2.5-pro');
    expect(p.available()).toBe(true);
  });

  test('gemini env fallback', () => {
    process.env.GEMINI_API_KEY = 'AIza-env';
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'auto' };
    const p = getProviderForConfig(cfg);
    // grok/anthropic/openai unset → gemini wins the auto fallthrough
    expect(p.name).toBe('gemini');
  });

  test('anthropic with apiKey', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'anthropic', apiKey: 'sk-ant-test' };
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('anthropic');
    expect(p.available()).toBe(true);
  });

  test('local requires baseUrl — throws helpful error when missing', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'local' };
    expect(() => getProviderForConfig(cfg)).toThrow(/baseUrl/);
  });

  test('local with baseUrl is available (no apiKey needed)', () => {
    const cfg = baseUserConfig();
    cfg.llm = {
      provider: 'local',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
    };
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('local');
    expect(p.defaultModel).toBe('llama3');
    expect(p.available()).toBe(true);
  });
});

describe('openai-codex OAuth-aware provider', () => {
  test('available() true when OAuth tokens stored, even without apiKey', () => {
    saveTokens('openai-codex', {
      accessToken: 'oauth-A',
      refreshToken: 'oauth-R',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai-codex' };
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('openai-codex');
    expect(p.available()).toBe(true);
  });

  test('available() false when neither OAuth nor apiKey present', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai-codex' };
    const p = getProviderForConfig(cfg);
    expect(p.available()).toBe(false);
  });

  test('available() true with apiKey fallback', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai-codex', apiKey: 'sk-codex-dev' };
    const p = getProviderForConfig(cfg);
    expect(p.available()).toBe(true);
  });

  test('OAuth tokens take precedence over apiKey when both present', () => {
    // Phase 26/27: OAuth routes to /responses (ChatGPT backend),
    // apiKey routes to /chat/completions (api.openai.com). When both
    // are configured we use OAuth — the user explicitly ran
    // `elanous login openai-codex` so that's the intended credential.
    saveTokens('openai-codex', {
      accessToken: 'oauth-wins',
      refreshToken: 'oauth-R',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai-codex', apiKey: 'sk-apikey-fallback' };
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('openai-codex');
    expect(p.available()).toBe(true);
    expect(loadTokens('openai-codex')?.tokens.accessToken).toBe('oauth-wins');
  });
});

describe('getProviderForConfig — auto fallthrough', () => {
  test('provider=auto + no env → throws (no provider available)', () => {
    const cfg = baseUserConfig();
    expect(() => getProviderForConfig(cfg)).toThrow(/No LLM provider available/);
  });

  test('no credentials at all → message leads with `elanous setup`, keys come last', () => {
    const msg = noProviderAvailableMessage();
    expect(msg.startsWith('No LLM provider available.')).toBe(true);
    expect(msg).toContain('`elanous setup`');
    expect(msg).toContain('`elanous login openai-codex`');
    expect(msg.indexOf('`elanous setup`')).toBeLessThan(msg.indexOf('XAI_API_KEY'));
  });

  test('codex login present → message names the provider line, never asks for API keys', () => {
    saveTokens('openai-codex', {
      accessToken: 'oauth-msg',
      refreshToken: 'oauth-R',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    const msg = noProviderAvailableMessage();
    expect(msg.startsWith('No LLM provider available.')).toBe(true);
    expect(msg).toContain('`elanous config set llm.provider openai-codex`');
    expect(msg).not.toContain('XAI_API_KEY');
  });

  // ⭐ 2026-09-24 — 역할 LLM·대시보드가 쓰는 resolveActiveProvider 도 런타임과 같은 답(codex)을 낸다.
  //   종전엔 getProvider() 가 auto 에서 codex 를 건너뛰어 grok(키가 있으면)을 말하거나 codex 만 있으면 예외를 던졌다.
  test('provider=auto + codex subscription → resolveActiveProvider says openai-codex, same as the runtime decision', () => {
    saveTokens('openai-codex', {
      accessToken: 'oauth-active-codex',
      refreshToken: 'oauth-R',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    process.env.XAI_API_KEY = 'xai-env';
    const cfg = baseUserConfig();
    setUserConfigOverlay(() => cfg);
    expect(decideProviderForConfig(cfg).provider).toBe('auto:openai-codex');
    expect(resolveActiveProvider(cfg)).toBe('openai-codex');
  });

  test('provider=auto + codex subscription and env keys → codex OAuth before env API keys', async () => {
    saveTokens('openai-codex', {
      accessToken: 'oauth-auto-codex',
      refreshToken: 'oauth-R',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    writeGrokSubscriptionCredential();
    process.env.XAI_API_KEY = 'xai-env';
    process.env.OPENAI_API_KEY = 'sk-env';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const cfg = baseUserConfig();
    setUserConfigOverlay(() => cfg);
    const requests: Array<{ url: string; auth: string | null; model?: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: unknown } : {};
      requests.push({ url: String(input), auth: headers.get('Authorization'), model: body.model });
      return new Response('data: {"type":"response.output_text.delta","delta":"codex"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const decision = decideProviderForConfig(cfg);
    const provider = getProviderForConfig(cfg);
    const resolved = resolveDefaultProvider();
    const info = inspectActiveProvider(cfg);
    const chunks: string[] = [];
    const full = await streamLLM([{ role: 'user', content: 'hello' }], (delta) => chunks.push(delta));
    expect(decision.provider).toBe('auto:openai-codex');
    expect(decision.auth).toBe('oauth');
    expect(decision.model).toBe(CODEX_DEFAULT_MODEL);
    expect(provider.name).toBe('openai-codex');
    expect(provider.defaultModel).toBe(CODEX_DEFAULT_MODEL);
    expect(resolved.name).toBe('openai-codex');
    expect(resolved.defaultModel).toBe(CODEX_DEFAULT_MODEL);
    expect(info.provider).toBe('auto:openai-codex');
    expect(info.auth).toBe('oauth');
    expect(info.authDetail).toContain('OAuth');
    expect(full).toBe('codex');
    expect(chunks).toEqual(['codex']);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/responses');
    expect(requests[0]?.auth).toBe('Bearer oauth-auto-codex');
    expect(requests[0]?.model).toBe(CODEX_DEFAULT_MODEL);
  });

  test('provider=auto + grok subscription only → grok OAuth after codex has no account', () => {
    writeGrokSubscriptionCredential();
    process.env.XAI_API_KEY = 'xai-env';
    const cfg = baseUserConfig();
    const decision = decideProviderForConfig(cfg);
    const p = getProviderForConfig(cfg);
    expect(decision.provider).toBe('auto:grok');
    expect(decision.auth).toBe('oauth');
    expect(p.name).toBe('grok');
  });

  test('provider=auto + GROK env without subscriptions → env-driven grok provider', () => {
    process.env.XAI_API_KEY = 'xai-env';
    const cfg = baseUserConfig();
    const p = getProviderForConfig(cfg);
    const decision = decideProviderForConfig(cfg);
    expect(p.name).toBe('grok');
    expect(decision.provider).toBe('auto:grok');
    expect(decision.auth).toBe('apikey');
    // Auto path uses the module-level singleton — verify identity.
    expect(p).toBe(PROVIDERS.grok);
  });

  test('provider=auto + OPENAI_API_KEY and no model selects OpenAI in decision, runtime, and summary paths', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'auto' };
    const decision = decideProviderForConfig(cfg);
    const provider = getProviderForConfig(cfg);
    const info = inspectActiveProvider(cfg);
    expect(decision.provider).toBe('auto:openai');
    expect(decision.model).toBe(PROVIDERS.openai.defaultModel);
    expect(decision.auth).toBe('apikey');
    expect(provider.name).toBe('openai');
    expect(provider).toBe(PROVIDERS.openai);
    expect(info.provider).toBe('auto:openai');
    expect(info.model).toBe(decision.model);
    expect(info.auth).toBe(decision.auth);
    expect(info.authDetail).toBe('API key (env OPENAI_API_KEY)');
  });
});

describe('shared provider decision — runtime and summary paths', () => {
  test('auto config selects the same provider in decision, runtime, and summary paths', () => {
    process.env.GEMINI_API_KEY = 'AIza-env';
    const cfg = baseUserConfig();
    const decision = decideProviderForConfig(cfg);
    const provider = getProviderForConfig(cfg);
    const info = inspectActiveProvider(cfg);
    expect(decision.provider).toBe('auto:gemini');
    expect(provider.name).toBe('gemini');
    expect(info.provider).toBe('auto:gemini');
    expect(info.provider.replace(/^auto:/, '')).toBe(provider.name);
    expect(info.model).toBe(decision.model);
    expect(info.auth).toBe(decision.auth);
  });

  test('auto config with requested OpenAI model records the real provider while preserving singleton defaults', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    const cfg = baseUserConfig();
    const decision = decideProviderForConfig(cfg, 'gpt-4o');
    const provider = getProviderForConfig(cfg, 'gpt-4o');
    expect(decision.provider).toBe('openai');
    expect(decision.model).toBe('gpt-4o');
    expect(decision.auth).toBe('apikey');
    expect(provider.name).toBe('openai');
    expect(provider).toBe(PROVIDERS.openai);
    expect(provider.defaultModel).toBe(PROVIDERS.openai.defaultModel);
  });

  test('auto config reports Grok subscription OAuth when that is the runtime credential', () => {
    writeGrokSubscriptionCredential();
    const cfg = baseUserConfig();
    const decision = decideProviderForConfig(cfg);
    const provider = getProviderForConfig(cfg);
    const info = inspectActiveProvider(cfg);
    expect(decision.provider).toBe('auto:grok');
    expect(decision.auth).toBe('oauth');
    expect(provider.name).toBe('grok');
    expect(info.provider).toBe('auto:grok');
    expect(info.auth).toBe('oauth');
    expect(info.authDetail).toBe('구독 OAuth (~/.grok/auth.json · `grok login`)');
  });

  test('explicit providers preserve externally visible runtime and summary selections', () => {
    const cases: Array<{ provider: UserConfig['llm']['provider']; apiKey?: string; baseUrl?: string; model: string }> = [
      { provider: 'grok', apiKey: 'xai-test', model: 'grok-4' },
      { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' },
      { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-3-5-haiku-20241022' },
      { provider: 'gemini', apiKey: 'AIza-test', model: 'gemini-2.5-pro' },
      { provider: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
    ];
    for (const llm of cases) {
      const cfg = baseUserConfig();
      cfg.llm = llm;
      const decision = decideProviderForConfig(cfg);
      const provider = getProviderForConfig(cfg);
      const info = inspectActiveProvider(cfg);
      expect(decision.provider).toBe(llm.provider);
      expect(provider.name).toBe(llm.provider);
      expect(provider.defaultModel).toBe(llm.model);
      expect(info.provider).toBe(llm.provider);
      expect(info.model).toBe(llm.model);
      expect(info.auth).toBe(decision.auth);
      if (llm.provider === 'grok') {
        expect(grokCredential.resolveGrokCredential({ home: tmpXdg ?? undefined, model: llm.model })).toBeNull();
        expect(decision.auth).toBe('apikey');
        expect(provider.available()).toBe(true);
        expect(info.authDetail).toBe('API key (config)');
      }
    }
  });

  test('per-call cross-family model uses the same shared decision as runtime routing', () => {
    process.env.GEMINI_API_KEY = 'AIza-env';
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-3-5-haiku-20241022' };
    const decision = decideProviderForConfig(cfg, 'gemini-2.5-pro');
    const provider = getProviderForConfig(cfg, 'gemini-2.5-pro');
    expect(decision.provider).toBe('gemini');
    expect(decision.model).toBe('gemini-2.5-pro');
    expect(provider.name).toBe('gemini');
    expect(provider.defaultModel).toBe('gemini-2.5-pro');
  });
});

describe('finalizeProviderModelCompatibility', () => {
  test('preserves an already compatible provider-model pair', () => {
    const decision: ProviderDecision = { provider: 'openai-codex', model: 'gpt-5.6-sol', auth: 'oauth' };
    expect(finalizeProviderModelCompatibility(decision)).toEqual(decision);
  });

  test('reroutes an incompatible model to its inferred provider and records it', () => {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    try {
      expect(finalizeProviderModelCompatibility({ provider: 'openai-codex', model: 'grok-4.6', auth: 'oauth' }))
        .toEqual({ provider: 'grok', model: 'grok-4.6', auth: 'none' });
      expect(events).toContainEqual({
        category: 'llm.router',
        event: 'provider-model-rerouted',
        data: { fromProvider: 'openai-codex', toProvider: 'grok', model: 'grok-4.6' },
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('reroutes the OpenAI API-key route to Codex when the model has a subscription credential', () => {
    saveTokens('openai-codex', {
      accessToken: 'subscription-token',
      refreshToken: 'subscription-refresh',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });

    expect(finalizeProviderModelCompatibility({ provider: 'openai', model: 'gpt-6-astra', auth: 'apikey' }))
      .toEqual({ provider: 'openai-codex', model: 'gpt-6-astra', auth: 'oauth' });
  });

  test('preserves the OpenAI API-key route and records subscription divergence when Codex lacks credentials', () => {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    try {
      expect(finalizeProviderModelCompatibility({ provider: 'openai', model: 'gpt-6-astra', auth: 'apikey' }))
        .toEqual({ provider: 'openai', model: 'gpt-6-astra', auth: 'apikey' });
      expect(events).toContainEqual({
        category: 'llm.router',
        event: 'subscription-provider-divergence',
        data: { configProvider: 'openai', inferredProvider: 'openai-codex', model: 'gpt-6-astra' },
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('uses the same subscription routing result as configuration resolution', () => {
    saveTokens('openai-codex', {
      accessToken: 'subscription-token',
      refreshToken: 'subscription-refresh',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai', apiKey: 'sk-openai' };

    expect(finalizeProviderModelCompatibility({ provider: 'openai', model: 'gpt-6-astra', auth: 'apikey' }))
      .toEqual(decideProviderForConfig(cfg, 'gpt-6-astra'));
  });

  test('rejects an incompatible pair when no supported provider can be inferred', () => {
    expect(() => finalizeProviderModelCompatibility({
      provider: 'unsupported' as ProviderDecision['provider'],
      model: 'grok-4.6',
      auth: 'none',
    })).toThrow('Cannot establish provider-model compatibility: unknown provider "unsupported" for model "grok-4.6"');
  });

  test('getProviderForConfig applies the final compatibility check before constructing a provider', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai-codex', model: 'grok-4.6' };
    expect(getProviderForConfig(cfg).name).toBe('grok');
  });
});

describe('isLoopbackBaseUrl — cloud-brand baseUrl guard (grok misroute regression)', () => {
  test('loopback hosts → true (stale local-LLM baseUrl)', () => {
    expect(isLoopbackBaseUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:1234/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://0.0.0.0:8080/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://lmstudio.localhost/v1')).toBe(true);
  });

  test('real cloud hosts → false (honored as custom gateway)', () => {
    expect(isLoopbackBaseUrl('https://api.x.ai/v1')).toBe(false);
    expect(isLoopbackBaseUrl('https://gateway.corp.example.com/v1')).toBe(false);
    expect(isLoopbackBaseUrl('https://api.openai.com/v1')).toBe(false);
  });

  test('malformed → false (fall through to honoring it · no crash)', () => {
    expect(isLoopbackBaseUrl('not a url')).toBe(false);
    expect(isLoopbackBaseUrl('')).toBe(false);
  });
});

// ⭐ 2026-09-02 (대표 지시로 기전 추적) — 호환성 검사가 «폴백에도» 걸린다.
//   🩸 계기: 종전엔 가드가 «인자 model» 에만 걸리고, 인자가 없으면 `userConfig.llm.model` 을
//     ***검사 없이*** 썼다. 그래서 config/env 의 모델이 provider 와 어긋나면
//     ***「provider=openai-codex · model=grok-4.6」이 조용히 반환***됐고, 그 호출은 «항상» 400 이었다:
//       Codex API 400: "The 'grok-4.6' model is not supported when using Codex with a ChatGPT account."
//     📏 실물 표본: 그 400 이 리뷰 경로에서 나 «리뷰가 조용히 안 돌았고» 런이 2h40m 뒤 abandoned 였다(OBS-T372).
//   ⛔ 이 시험이 못 보는 것: 「그 400 이 «어느 실행 경로»에서 났나」는 안 잰다 — 조합 판정만 잰다.
describe('decideProviderForConfig — config 모델이 provider 와 어긋날 때', () => {
  test('routes an OpenAI-compatible Codex model through Codex when its subscription credential exists', () => {
    saveTokens('openai-codex', {
      accessToken: 'subscription-token',
      refreshToken: 'subscription-refresh',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai', apiKey: 'sk-openai' };

    expect(decideProviderForConfig(cfg, 'gpt-6-astra')).toEqual({
      provider: 'openai-codex', model: 'gpt-6-astra', auth: 'oauth',
    });
  });

  test('preserves the OpenAI API-key route and records divergence when Codex lacks a subscription credential', () => {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    try {
      const cfg = baseUserConfig();
      cfg.llm = { provider: 'openai', apiKey: 'sk-openai' };

      expect(decideProviderForConfig(cfg, 'gpt-6-astra')).toEqual({
        provider: 'openai', model: 'gpt-6-astra', auth: 'apikey',
      });
      expect(events).toContainEqual({
        category: 'llm.router',
        event: 'subscription-provider-divergence',
        data: { configProvider: 'openai', inferredProvider: 'openai-codex', model: 'gpt-6-astra' },
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('preserves an already matching Codex provider and model', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai-codex' };

    expect(decideProviderForConfig(cfg, 'gpt-5.6-terra').provider).toBe('openai-codex');
  });

  test('reroutes a cross-family Grok model as before', () => {
    const cfg = baseUserConfig();
    cfg.llm = { provider: 'openai-codex' };

    expect(decideProviderForConfig(cfg, 'grok-4.6').provider).toBe('grok');
  });

  test('★ 양성 — 인자가 없어도 config 모델의 provider 로 간다(400 조합을 안 낸다)', () => {
    const cfg = baseUserConfig();
    cfg.llm.provider = 'openai-codex';
    cfg.llm.model = 'grok-4.6';
    const d = decideProviderForConfig(cfg);
    expect(d.provider).toBe('grok');
    expect(d.model).toBe('grok-4.6');
  });

  test('★ 음성 — 같은 provider 의 모델이면 그대로 둔다(정당한 사용을 안 건드린다)', () => {
    const cfg = baseUserConfig();
    cfg.llm.provider = 'openai-codex';
    cfg.llm.model = 'gpt-5.6-sol';
    const d = decideProviderForConfig(cfg);
    expect(d.provider).toBe('openai-codex');
    expect(d.model).toBe('gpt-5.6-sol');
  });

  test('★ 음성 — 인자 model 이 있으면 종전 규칙이 그대로다(폴백을 안 탄다)', () => {
    const cfg = baseUserConfig();
    cfg.llm.provider = 'openai-codex';
    cfg.llm.model = 'grok-4.6';
    const d = decideProviderForConfig(cfg, 'gpt-5.6-terra');
    expect(d.provider).toBe('openai-codex');
    expect(d.model).toBe('gpt-5.6-terra');
  });
});
