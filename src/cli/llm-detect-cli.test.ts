import { describe, expect, test } from 'bun:test';
import { getProviderForConfig, type LLMProvider } from '../llm.js';
import { probeProvider } from '../llm/provider-probe.js';
import type { DetectedProvider } from '../llm/provider-detect.js';
import type { UserConfig } from '../user-config.js';
import { runLlmDetect, type LlmDetectDeps } from './llm-detect-cli.js';

const key = 'secret-test-key';
const candidates: DetectedProvider[] = [
  { provider: 'anthropic', auth: 'apikey', source: 'env:ANTHROPIC_API_KEY', available: true, rank: 3 },
  { provider: 'openai-codex', auth: 'oauth', source: 'codex-auth', available: true, rank: 0 },
  { provider: 'openrouter', auth: 'apikey', source: 'env:OPENROUTER_API_KEY', available: false, rank: 9 },
];
const config = (): UserConfig => ({ llm: { provider: 'auto', apiKey: key, model: 'old-model' } } as UserConfig);
const provider = (name: string): LLMProvider => ({
  name, defaultModel: `${name}-model`, available: () => true,
  chat: async function* () { yield 'OK'; },
});

function fixture() {
  const outputs: string[] = [];
  const saved: UserConfig[] = [];
  const attempted: string[] = [];
  const deps: LlmDetectDeps = {
    config,
    detect: async () => [...candidates],
    resolve: (entry) => provider(entry.provider),
    save: (cfg) => saved.push(cfg),
    output: (text) => outputs.push(text),
  };
  return { outputs, saved, attempted, deps };
}

describe('llm detect CLI handler', () => {
  test('agent-cli ranks first but cannot be resolved, probed or applied; guides both CLI backends', async () => {
    const f = fixture();
    f.deps.detect = async () => [
      { provider: 'claude-code', auth: 'agent-cli', source: 'claude-auth-status', available: true, rank: 0,
        agent: { cli: 'claude', loggedIn: true, storedLoggedIn: true, method: 'claude.ai', via: 'claude-auth-status' } },
      { provider: 'antigravity', auth: 'agent-cli', source: 'agy-install', available: true, rank: 1,
        agent: { cli: 'agy', loggedIn: null, via: 'install-dir' } },
      { provider: 'openai', auth: 'apikey', source: 'env:OPENAI_API_KEY', available: true, rank: 2 },
    ];
    f.deps.resolve = (entry) => {
      f.attempted.push(entry.provider);
      if (entry.auth === 'agent-cli') throw new Error('agent must not resolve');
      return provider(entry.provider);
    };
    f.deps.probeProvider = async (p) => ({ success: true, durationMs: 1, model: p.defaultModel });
    const result = await runLlmDetect({ probe: true, apply: true }, f.deps);
    expect(f.attempted).toEqual(['openai']);
    expect(result).toMatchObject({ selected: 'openai', applied: true });
    expect(result.candidates.slice(0, 2).every((row) => row.probe === undefined)).toBe(true);
    expect(f.saved[0]?.llm.provider).toBe('openai');
    expect(f.outputs).toContain('agent  claude-code  logged-in (stored)  → elanous agent-mission … --backend claude');
    expect(f.outputs.some((line) => line.includes('--backend gemini'))).toBe(true);
    const json = fixture();
    json.deps.detect = f.deps.detect;
    await runLlmDetect({ json: true }, json.deps);
    expect(JSON.parse(json.outputs[0]!).candidates[0]).toMatchObject({
      agent: { cli: 'claude', loggedIn: true, storedLoggedIn: true, method: 'claude.ai', via: 'claude-auth-status' },
      command: 'elanous agent-mission … --backend claude',
    });
  });

  test('Claude session-only login guides unattended use without changing JSON or other agent statuses', async () => {
    const f = fixture();
    f.deps.detect = async () => [
      { provider: 'claude-code', auth: 'agent-cli', source: 'claude-auth-status', available: true, rank: -2,
        agent: { cli: 'claude', loggedIn: true, storedLoggedIn: false, method: 'oauth_token', via: 'claude-auth-status' } },
      { provider: 'antigravity', auth: 'agent-cli', source: 'agy-install', available: true, rank: -1,
        agent: { cli: 'agy', loggedIn: null, via: 'install-dir' } },
    ];
    const result = await runLlmDetect({}, f.deps);
    expect(f.outputs).toContain('agent  claude-code  session token only — run `claude` then `/login` in a normal terminal for unattended use  → elanous agent-mission … --backend claude');
    expect(f.outputs).toContain('agent  antigravity  login unknown  → elanous agent-mission … --backend gemini');
    expect(result.candidates[0]?.agent).toEqual({
      cli: 'claude', loggedIn: true, storedLoggedIn: false, method: 'oauth_token', via: 'claude-auth-status',
    });
    const json = fixture();
    json.deps.detect = f.deps.detect;
    await runLlmDetect({ json: true }, json.deps);
    expect(JSON.parse(json.outputs[0]!).candidates[0].agent).toEqual(result.candidates[0]?.agent);
    expect(json.outputs[0]).not.toContain('session token only');
  });

  test('Claude without confirmed stored status keeps the existing logged-in, logged-out and unknown labels', async () => {
    const f = fixture();
    f.deps.detect = async () => [
      { provider: 'claude-code', auth: 'agent-cli', source: 'claude-auth-status', available: true, rank: -2,
        agent: { cli: 'claude', loggedIn: true, storedLoggedIn: null, method: 'claude.ai', via: 'claude-auth-status' } },
      { provider: 'claude-logged-out', auth: 'agent-cli', source: 'claude-auth-status', available: false, rank: -1,
        agent: { cli: 'claude', loggedIn: false, storedLoggedIn: false, via: 'claude-auth-status' } },
      { provider: 'claude-unknown', auth: 'agent-cli', source: 'path:claude', available: false, rank: 0,
        agent: { cli: 'claude', loggedIn: null, storedLoggedIn: null, via: 'path:claude' } },
    ];
    await runLlmDetect({}, f.deps);
    expect(f.outputs).toContain('agent  claude-code  logged-in (oauth)  → elanous agent-mission … --backend claude');
    expect(f.outputs).toContain('agent  claude-logged-out  logged-out  → elanous agent-mission … --backend claude');
    expect(f.outputs).toContain('agent  claude-unknown  login unknown  → elanous agent-mission … --backend claude');
  });

  test('--apply never overwrites an explicit llm.provider; it says so and saves nothing', async () => {
    const f = fixture();
    f.deps.config = () => ({ llm: { provider: 'grok', apiKey: key, model: 'old-model' } } as UserConfig);
    const result = await runLlmDetect({ apply: true, probe: true }, f.deps);
    expect(result).toMatchObject({ selected: 'openai-codex', applied: false, notApplied: 'llm.provider is already grok — left unchanged' });
    expect(f.saved).toHaveLength(0);
    expect(f.outputs).toContain('llm.provider is already grok — left unchanged');
  });

  test('renders ranked discoveries without probing or writing and JSON exposes no credentials', async () => {
    const f = fixture();
    const result = await runLlmDetect({}, f.deps);
    expect(result.candidates.map((row) => row.provider)).toEqual(['openai-codex', 'anthropic', 'openrouter']);
    expect(result.selected).toBeNull();
    expect(f.saved).toHaveLength(0);
    expect(f.outputs[0]).toStartWith('openai-codex');
    const json = fixture();
    await runLlmDetect({ json: true }, json.deps);
    expect(json.outputs).toHaveLength(1);
    expect(JSON.parse(json.outputs[0]!).candidates).toHaveLength(3);
    expect(json.outputs[0]).not.toContain(key);
  });

  test('probe tries available candidates in rank order, stops on first success, never saves without --apply', async () => {
    const f = fixture();
    f.deps.probeProvider = async (p) => {
      f.attempted.push(p.name);
      return { success: p.name === 'anthropic', durationMs: 1, model: p.defaultModel,
        ...(p.name !== 'anthropic' ? { error: `failure ${key}` } : {}) };
    };
    const result = await runLlmDetect({ probe: true, json: true }, f.deps);
    expect(f.attempted).toEqual(['openai-codex', 'anthropic']);
    expect(result.selected).toBe('anthropic');
    expect(result.applied).toBe(false);
    expect(f.saved).toHaveLength(0);
    expect(f.outputs[0]).not.toContain(key);
    expect(JSON.parse(f.outputs[0]!).candidates[0].probe.error).toBe('probe failed');
  });

  test('--apply requires --probe and does not even perform discovery', async () => {
    const f = fixture();
    f.deps.detect = async () => { throw new Error('must not detect'); };
    const result = await runLlmDetect({ apply: true, json: true }, f.deps);
    expect(result).toMatchObject({ applied: false, selected: null, error: '--apply requires --probe' });
    expect(f.saved).toHaveLength(0);
  });

  test('--apply writes only llm.provider after a successful probe; keeps all other values', async () => {
    const f = fixture();
    f.deps.probeProvider = async (p) => {
      f.attempted.push(p.name);
      return { success: p.name === 'anthropic', durationMs: 1, model: p.defaultModel };
    };
    const result = await runLlmDetect({ apply: true, probe: true }, f.deps);
    expect(f.attempted).toEqual(['openai-codex', 'anthropic']);
    expect(result).toMatchObject({ selected: 'anthropic', applied: true });
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.llm).toEqual({ provider: 'anthropic', apiKey: key, model: 'old-model' });
  });

  test('failed probes and unavailable candidates never change provider', async () => {
    const f = fixture();
    f.deps.probeProvider = async (p) => {
      f.attempted.push(p.name);
      return { success: false, durationMs: 2, model: p.defaultModel, error: 'probe failed' };
    };
    const result = await runLlmDetect({ apply: true, probe: true }, f.deps);
    expect(f.attempted).toEqual(['openai-codex', 'anthropic']);
    expect(result).toMatchObject({ selected: null, applied: false });
    expect(f.saved).toHaveLength(0);
  });

  test('--apply probes the exact persisted credential, endpoint and model through the real provider', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; authorization: string | null; model: string }> = [];
    const configured: UserConfig = {
      llm: {
        provider: 'auto', apiKey: 'sk-configured-only-for-openai',
        model: 'gpt-4o-mini', baseUrl: 'https://detect-probe.invalid/v1/chat/completions',
      },
    } as UserConfig;
    const saved: UserConfig[] = [];
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get('authorization');
        const model = (JSON.parse(String(init?.body)) as { model: string }).model;
        calls.push({ url, authorization, model });
        if (url !== configured.llm.baseUrl || authorization !== `Bearer ${configured.llm.apiKey}` || model !== configured.llm.model) {
          return new Response('unexpected probe settings', { status: 401 });
        }
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;
      const result = await runLlmDetect({ apply: true, probe: true }, {
        config: () => configured,
        detect: async () => [{ provider: 'openai', auth: 'apikey', source: 'env:OPENAI_API_KEY', available: true, rank: 0 }],
        save: (next) => saved.push(next),
        output: () => {},
      });
      expect(result).toMatchObject({ selected: 'openai', applied: true });
      expect(saved).toHaveLength(1);
      expect(saved[0]?.llm).toEqual({ ...configured.llm, provider: 'openai' });
      const persisted = getProviderForConfig(saved[0]!);
      expect(persisted.name).toBe('openai');
      expect((await probeProvider(persisted)).success).toBe(true);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call).toEqual({
          url: configured.llm.baseUrl!, authorization: `Bearer ${configured.llm.apiKey}`, model: configured.llm.model!,
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('--apply refuses a candidate when the persisted model routes it to another provider', async () => {
    const f = fixture();
    f.deps.resolve = undefined;
    f.deps.config = () => ({ llm: { provider: 'grok', model: 'grok-4.6', apiKey: key } } as UserConfig);
    f.deps.detect = async () => [{ provider: 'openai', auth: 'apikey', source: 'env:OPENAI_API_KEY', available: true, rank: 0 }];
    f.deps.probeProvider = async () => { throw new Error('must not probe the wrong provider'); };
    const result = await runLlmDetect({ apply: true, probe: true }, f.deps);
    expect(result).toMatchObject({ selected: null, applied: false });
    expect(f.saved).toHaveLength(0);
  });

  test('provider construction failure moves to the next usable candidate without leaking secrets', async () => {
    const f = fixture();
    f.deps.resolve = (entry) => {
      f.attempted.push(entry.provider);
      if (entry.provider === 'openai-codex') throw new Error(key);
      return provider(entry.provider);
    };
    f.deps.probeProvider = async (p) => ({ success: true, durationMs: 1, model: p.defaultModel });
    const result = await runLlmDetect({ apply: true, probe: true, json: true }, f.deps);
    expect(f.attempted).toEqual(['openai-codex', 'anthropic']);
    expect(result.selected).toBe('anthropic');
    expect(f.outputs[0]).not.toContain(key);
  });
});
