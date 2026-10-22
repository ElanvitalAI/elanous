import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keyDir = mkdtempSync(join(tmpdir(), 'opengateway-keys-'));
const priorCacheDir = process.env.ELANOUS_KEY_CACHE_DIR;
const priorKey = process.env.OPENGATEWAY_API_KEY;
process.env.ELANOUS_KEY_CACHE_DIR = keyDir;
process.env.OPENGATEWAY_API_KEY = 'test-env-key';
writeFileSync(join(keyDir, 'opengateway_api_key'), 'test-cache-key\n');

const { _resetKeyCacheForTests, getOpenGatewayApiKey, OPENGATEWAY_API_URL } = await import('../src/config.js');
const llm = await import('../src/llm.js');
const { getUserConfig } = await import('../src/user-config.js');
const { configuredOpenGatewayKeys } = await import('../src/llm/provider-credentials.js');
const { detectProviders } = await import('../src/llm/provider-detect.js');
const { debug } = await import('../src/debug/log.js');
const { defaultChildLlmModel, resolveImplementationChildModel } = await import('../src/self-dev/dev-cli.js');
_resetKeyCacheForTests();

test('configured OpenGateway key counts as a named child credential', () => {
  expect(configuredOpenGatewayKeys({ provider: 'opengateway', apiKey: 'config-only-key' })).toEqual(['config-only-key']);
  expect(configuredOpenGatewayKeys({ provider: 'openai', apiKey: 'unrelated-key' })).toEqual([]);
});

let originalFetch: typeof fetch;
let request: { url: string; authorization: string | null; model: string; stream_options?: unknown; body: Record<string, unknown> } | null;
beforeEach(() => {
  request = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; stream_options?: unknown };
    request = { url: String(input), authorization: new Headers(init?.headers).get('authorization'), model: body.model, stream_options: body.stream_options, body };
    const bytes = new TextEncoder().encode('data:{"choices":[{"delta":{"content":"hello"}}]}\n\n'
      + 'data:{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n'
      + 'data:[DONE]\n\n');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => {
  _resetKeyCacheForTests();
  if (priorCacheDir === undefined) delete process.env.ELANOUS_KEY_CACHE_DIR; else process.env.ELANOUS_KEY_CACHE_DIR = priorCacheDir;
  if (priorKey === undefined) delete process.env.OPENGATEWAY_API_KEY; else process.env.OPENGATEWAY_API_KEY = priorKey;
  rmSync(keyDir, { recursive: true, force: true });
});

test('OpenGateway is explicit, uses the cached key and wire model, and emits one usage row', async () => {
  expect(getOpenGatewayApiKey()).toBe('test-cache-key');
  const base = getUserConfig();
  const provider = llm.getProviderForConfig({ ...base, llm: { ...base.llm,
    provider: 'opengateway', model: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
    apiKey: undefined, baseUrl: undefined } } as never);
  expect(provider.name).toBe('opengateway');
  const spy = spyOn(debug, 'log');
  try {
    expect(await llm.streamLLM([{ role: 'user', content: 'hi' }], () => {}, { provider })).toBe('hello');
    expect(request).toMatchObject({ url: OPENGATEWAY_API_URL, authorization: 'Bearer test-cache-key',
      model: 'deepseek/deepseek-v4.1-flash-ultrafast', stream_options: { include_usage: true } });
    const rows = spy.mock.calls.filter((call) => call[0] === 'llm.usage' && call[1] === 'llm-usage'
      && (call[2] as { site?: string })?.site === 'stream-llm');
    expect(rows).toHaveLength(1);
    expect(rows[0]![2]).toMatchObject({ inputTokens: 4, outputTokens: 1, billingProvider: 'opengateway' });
  } finally { spy.mockRestore(); }
});

test('OpenGateway chat follows the LLMProvider async generator contract', async () => {
  const base = getUserConfig();
  const provider = llm.getProviderForConfig({ ...base, llm: { ...base.llm,
    provider: 'opengateway', model: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
    apiKey: undefined, baseUrl: undefined } } as never);
  const chunks: string[] = [];
  for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) chunks.push(chunk);
  expect(chunks.join('')).toBe('hello');
  expect(request?.model).toBe('deepseek/deepseek-v4.1-flash-ultrafast');
});

test('OpenGateway refuses a config key that conflicts with the portable Pod key', () => {
  const base = getUserConfig();
  expect(() => llm.getProviderForConfig({ ...base, llm: { ...base.llm,
    provider: 'opengateway', model: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
    apiKey: 'different-config-key', baseUrl: undefined } } as never)).toThrow('config apiKey conflicts with env/cache key');
  expect(request).toBeNull();
});

test('llm detect includes an exported OpenGateway key without revealing it', async () => {
  const result = await detectProviders({ env: { OPENGATEWAY_API_KEY: 'test-secret' }, home: '/isolated',
    authStore: '/isolated/no-auth.json', readFile: async () => '{}', access: async () => false });
  expect(result).toContainEqual(expect.objectContaining({ provider: 'opengateway', auth: 'apikey', source: 'env:OPENGATEWAY_API_KEY' }));
  expect(JSON.stringify(result)).not.toContain('test-secret');
  const cachePath = '/isolated/.cache/opengateway_api_key';
  const cached = await detectProviders({ env: {}, home: '/isolated', authStore: '/isolated/no-auth.json',
    isFile: async (path) => path === cachePath, readFile: async (path) => path === cachePath ? 'cache-secret' : '{}' ,
    access: async () => false });
  expect(cached).toContainEqual(expect.objectContaining({ provider: 'opengateway', source: 'cache:OPENGATEWAY_API_KEY' }));
  expect(JSON.stringify(cached)).not.toContain('cache-secret');
});

test('the implementation child accepts both live verified OpenGateway models', () => {
  const deepseek = 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast';
  const glm = 'opengateway/z-ai/glm-5.3-flash-ultrafast';
  expect(defaultChildLlmModel('opengateway')).toBe(deepseek);
  expect(resolveImplementationChildModel('opengateway', deepseek)).toMatchObject({ resolvedId: deepseek });
  expect(resolveImplementationChildModel('opengateway', glm)).toMatchObject({ resolvedId: glm });
  expect(resolveImplementationChildModel('opengateway', deepseek).supportsThinking).toBe(false);
  expect(resolveImplementationChildModel('opengateway', glm).supportsThinking).toBe(false);
  expect(() => resolveImplementationChildModel('opengateway', 'opengateway/unknown/model')).toThrow('알 수 없음');
});

test('OpenGateway omits unsupported reasoning controls even when configured and requested', async () => {
  const base = getUserConfig();
  const provider = llm.getProviderForConfig({ ...base, llm: { ...base.llm,
    provider: 'opengateway', model: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
    apiKey: undefined, baseUrl: undefined, reasoningLevel: 'high' } } as never);
  for await (const _ of provider.chat([{ role: 'user', content: 'hi' }], { reasoningEffort: 'high' })) { /* drain */ }
  expect(request?.body).not.toHaveProperty('reasoning');
  expect(request?.body).not.toHaveProperty('reasoning_effort');
  expect(request?.body).not.toHaveProperty('thinking');
});

test('the host refuses an unverified OpenGateway model before sending a request', async () => {
  const base = getUserConfig();
  expect(() => llm.getProviderForConfig({ ...base, llm: { ...base.llm, provider: 'opengateway',
    model: 'opengateway/other/model', apiKey: undefined, baseUrl: undefined } } as never)).toThrow('model not verified');
  const provider = llm.getProviderForConfig({ ...base, llm: { ...base.llm, provider: 'opengateway',
    model: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast', apiKey: undefined, baseUrl: undefined } } as never);
  await expect(llm.streamLLM([{ role: 'user', content: 'hi' }], () => {}, { provider,
    model: 'opengateway/other/model' })).rejects.toThrow('model not verified');
  const chat = provider.chat!([{ role: 'user', content: 'hi' }], { model: 'opengateway/other/model' });
  await expect(chat.next()).rejects.toThrow('model not verified');
  expect(request).toBeNull();
});

test('the host sends the verified GLM model without its provider prefix', async () => {
  const base = getUserConfig();
  const provider = llm.getProviderForConfig({ ...base, llm: { ...base.llm, provider: 'opengateway',
    model: 'opengateway/z-ai/glm-5.3-flash-ultrafast', apiKey: undefined, baseUrl: undefined } } as never);
  expect(await llm.streamLLM([{ role: 'user', content: 'hi' }], () => {}, { provider })).toBe('hello');
  expect(request?.model).toBe('z-ai/glm-5.3-flash-ultrafast');
});
