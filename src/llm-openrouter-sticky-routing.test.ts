// OR-STICKY-ROUTING (2026-10-10) — OpenRouter 요청에 세션/런 단위 고정 라우팅 키(body session_id ⊕ x-session-id).
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { getProviderForConfig, openRouterStickySessionKey, streamLLMWithTools, type LLMToolSpec } from './llm.js';
import type { UserConfig } from './user-config.js';

const tools: LLMToolSpec[] = [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: { p: { type: 'string' } } } }];
const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hello' }];

let savedRunId: string | undefined;
beforeEach(() => { savedRunId = process.env.ELANOUS_RUN_ID; delete process.env.ELANOUS_RUN_ID; });
afterEach(() => { if (savedRunId === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = savedRunId; });

async function capture(provider: string, model: string, opts: Record<string, unknown> = {}, prefs?: Record<string, unknown>) {
  const out: { raw: string; headers: Record<string, string> }[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    out.push({ raw: String(init?.body), headers: Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()) });
    return new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const config = { llm: { provider, model, apiKey: 'test-key', ...(provider === 'local' ? { baseUrl: 'http://localhost:1234/v1' } : {}), ...(prefs ? { openrouter: { providerPreferences: prefs } } : {}) } } as UserConfig;
    for await (const _ of getProviderForConfig(config).streamChat!(messages, { tools, ...opts })) { /* consume */ }
    return { ...out[0]!, body: JSON.parse(out[0]!.raw) as Record<string, any> };
  } finally {
    mock.mockRestore();
  }
}

test('key: session id wins over run id; neither → null', () => {
  expect(openRouterStickySessionKey('sess-1', 'run-9')).toEqual({ key: 'sess-1', source: 'session', hashed: false });
  expect(openRouterStickySessionKey(undefined, 'run-9')).toEqual({ key: 'run-9', source: 'run', hashed: false });
  expect(openRouterStickySessionKey('  ', '')).toBeNull();
  expect(openRouterStickySessionKey(undefined, undefined)).toBeNull();
});

test('key: long or unusual ids fold to a stable sha256 prefix', () => {
  const long = 'x'.repeat(200);
  const a = openRouterStickySessionKey(long, undefined)!;
  expect(a.hashed).toBe(true);
  expect(a.key).toMatch(/^elanous-[0-9a-f]{32}$/);
  expect(openRouterStickySessionKey(long, undefined)!.key).toBe(a.key);
  expect(openRouterStickySessionKey('/Users/me/space one', undefined)!.hashed).toBe(true);
  // padded ids are not trimmed into a different id — they hash, and differ from the bare id.
  const padded = openRouterStickySessionKey(' sess ', undefined)!;
  expect(padded.hashed).toBe(true);
  expect(padded.key).not.toBe('sess');
  expect(padded.key).not.toBe(openRouterStickySessionKey('sess', undefined)!.key);
});

test('OpenRouter: sessionId → body session_id and x-session-id header, same key on every turn', async () => {
  const one = await capture('openrouter', 'openrouter/z-ai/glm-5.3', { sessionId: 'sess-abc' });
  const two = await capture('openrouter', 'openrouter/z-ai/glm-5.3', { sessionId: 'sess-abc' });
  expect(one.body.session_id).toBe('sess-abc');
  expect(one.headers['x-session-id']).toBe('sess-abc');
  expect(one.headers['x-title']).toBe('elanous');
  expect(two.body.session_id).toBe(one.body.session_id);
  expect(one.raw).not.toContain('x-session-affinity');
  expect(one.headers['x-session-affinity']).toBeUndefined();
});

test('OpenRouter: harness run id is the fallback key', async () => {
  process.env.ELANOUS_RUN_ID = 'run-20261010-x1';
  const r = await capture('openrouter', 'openrouter/anthropic/claude-haiku-5.5');
  expect(r.body.session_id).toBe('run-20261010-x1');
  expect(r.headers['x-session-id']).toBe('run-20261010-x1');
});

test('quantizations / order stay optional config passthrough (no default injected)', async () => {
  const plain = await capture('openrouter', 'openrouter/z-ai/glm-5.3');
  expect(plain.body.provider).toEqual({ require_parameters: true, allow_fallbacks: true });
  const pinned = await capture('openrouter', 'openrouter/z-ai/glm-5.3', { sessionId: 's' }, { quantizations: ['fp8', 'bf16'], order: ['z-ai'] });
  expect(pinned.body.provider).toEqual({ require_parameters: true, allow_fallbacks: true, quantizations: ['fp8', 'bf16'], order: ['z-ai'] });
  expect(pinned.body.session_id).toBe('s');
});

test('invariant: no key → OpenRouter body/headers unchanged; other providers never carry the key', async () => {
  const none = await capture('openrouter', 'openrouter/z-ai/glm-5.3');
  expect('session_id' in none.body).toBe(false);
  expect(none.headers['x-session-id']).toBeUndefined();
  // headers without a key are exactly the pre-change set (auth · content-type · X-Title).
  expect(Object.keys(none.headers).sort()).toEqual(['authorization', 'content-type', 'x-title']);
  // with a key, removing exactly the session_id field gives back the keyless body byte-for-byte.
  const keyed = await capture('openrouter', 'openrouter/z-ai/glm-5.3', { sessionId: 'sess-abc' });
  const { session_id: _drop, ...rest } = keyed.body;
  expect(JSON.stringify(rest)).toBe(none.raw);
  process.env.ELANOUS_RUN_ID = 'run-1';
  for (const p of [['openai', 'gpt-5.5'], ['local', 'qwen3.6']] as const) {
    const withKey = await capture(p[0], p[1], { sessionId: 'sess-abc' });
    delete process.env.ELANOUS_RUN_ID;
    const without = await capture(p[0], p[1]);
    process.env.ELANOUS_RUN_ID = 'run-1';
    expect(withKey.raw).toBe(without.raw);
    expect(withKey.raw).not.toContain('session_id');
    expect(withKey.headers['x-session-id']).toBeUndefined();
  }
});

test('tool loop: streamLLMWithTools carries the same sessionId into every OpenRouter turn', async () => {
  const bodies: Record<string, any>[] = [];
  let call = 0;
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    call++;
    const sse = call === 1
      ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"Read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
      : 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch);
  try {
    const provider = getProviderForConfig({ llm: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'k' } } as UserConfig);
    await streamLLMWithTools([{ role: 'user', content: 'go' }], { onText() {}, dispatchTool: async () => 'ok' }, { provider, tools, maxTurns: 3, sessionId: 'sess-loop' });
  } finally {
    mock.mockRestore();
  }
  expect(bodies.length).toBeGreaterThanOrEqual(2);
  for (const b of bodies) expect(b.session_id).toBe('sess-loop');
});
