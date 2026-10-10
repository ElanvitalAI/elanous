import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, saveUserConfig } from './user-config.js';
import { getProviderForConfig, sanitizeToolSchemaForKimi, type LLMToolSpec } from './llm.js';
import type { UserConfig } from './user-config.js';

const schema = {
  type: 'object',
  properties: {
    a: { $ref: '#/x', description: 'd' },
    b: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
  },
};
const tools: LLMToolSpec[] = [{ name: 'demo', description: 'demo', parameters: schema }];
const messages = [{ role: 'user' as const, content: 'hello' }];

async function captureRequest(provider: string, model: string, preferences?: Record<string, unknown>) {
  const bodies: Record<string, any>[] = [];
  const urls: string[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const config = { llm: { provider, model, apiKey: 'test-key', ...(provider === 'local' ? { baseUrl: 'http://localhost:1234/v1' } : {}), ...(preferences ? { openrouter: { providerPreferences: preferences } } : {}) } } as UserConfig;
    for await (const _ of getProviderForConfig(config).streamChat!(messages, { tools })) { /* consume */ }
    return { body: bodies[0]!, url: urls[0] };
  } finally {
    mock.mockRestore();
  }
}

test('OpenRouter provider defaults and shallow config override preserve usage.include', async () => {
  const base = (await captureRequest('openrouter', 'openrouter/z-ai/glm-5.3')).body;
  expect(base.provider).toEqual({ require_parameters: true, allow_fallbacks: true });
  expect(base.usage).toEqual({ include: true });
  const override = (await captureRequest('openrouter', 'openrouter/z-ai/glm-5.3', { order: ['z-ai'], allow_fallbacks: false })).body;
  expect(override.provider).toEqual({ require_parameters: true, allow_fallbacks: false, order: ['z-ai'] });
  expect(override.usage).toEqual({ include: true });
});

test('user config preserves object-shaped OpenRouter provider preferences', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openrouter-config-'));
  try {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ llm: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', openrouter: { providerPreferences: { order: ['z-ai'] } } } }));
    const loaded = buildUserConfig(path);
    expect(loaded.llm.openrouter?.providerPreferences).toEqual({ order: ['z-ai'] });
    const savedPath = join(root, 'saved.json');
    saveUserConfig(loaded, savedPath);
    expect(buildUserConfig(savedPath).llm.openrouter?.providerPreferences).toEqual({ order: ['z-ai'] });
    const bodies: any[] = [];
    const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: [DONE]\n\n', { status: 200 });
    }) as typeof fetch);
    try {
      for await (const _ of getProviderForConfig({ ...loaded, llm: { ...loaded.llm, apiKey: 'test-key' } }).streamChat!(messages, { tools })) { /* consume */ }
      expect(bodies[0].provider).toEqual({ require_parameters: true, allow_fallbacks: true, order: ['z-ai'] });
      expect(bodies[0].usage).toEqual({ include: true });
    } finally {
      mock.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi schema sanitizer is pure, recursively removes $ref siblings and tuple items', () => {
  const original = structuredClone(schema);
  expect(sanitizeToolSchemaForKimi(schema)).toEqual({
    type: 'object', properties: {
      a: { $ref: '#/x' },
      b: { type: 'array', items: { type: 'string' } },
    },
  });
  expect(schema).toEqual(original);
});

test('only OpenRouter moonshotai tools are sanitized in the serialized request', async () => {
  const kimi = (await captureRequest('openrouter', 'openrouter/moonshotai/kimi-k3')).body;
  expect(kimi.model).toBe('moonshotai/kimi-k3');
  expect(kimi.tools[0].function.parameters.properties.a).toEqual({ $ref: '#/x' });
  expect(kimi.tools[0].function.parameters.properties.b.items).toEqual({ type: 'string' });
  for (const [provider, model] of [
    ['openrouter', 'openrouter/z-ai/glm-5.3'],
    ['openai', 'gpt-5.6'],
    ['grok', 'grok-4.7'],
    ['local', 'local-model'],
  ]) {
    const { body } = await captureRequest(provider!, model!);
    expect(body.tools[0].function.parameters.properties.a).toEqual({ $ref: '#/x', description: 'd' });
    expect(body.tools[0].function.parameters.properties.b.items).toEqual(schema.properties.b.items);
    if (provider !== 'openrouter') expect(body.provider).toBeUndefined();
  }
  expect(schema.properties.a.description).toBe('d');
});

test('OpenRouter upstream Provider returned error retries and labels debug.log openrouter', async () => {
  const logs: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    logs.push({ category, event, data });
  });
  const urls: string[] = [];
  let calls = 0;
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url) => {
    urls.push(String(url));
    calls++;
    return calls === 1
      ? new Response('{"error":"Provider returned error"}', { status: 502 })
      : new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const config = { llm: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'test-key' } } as UserConfig;
    for await (const _ of getProviderForConfig(config).streamChat!(messages)) { /* consume */ }
    expect(urls[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls).toBe(2);
    expect(logs.some(l => l.category === 'llm.retry' && l.event === 'retry' && l.data.provider === 'openrouter')).toBe(true);
  } finally {
    fetchMock.mockRestore();
    log.mockRestore();
  }
});

test('non-OpenRouter upstream error body retains its generic 400 retry policy and label', async () => {
  const logs: Array<{ category: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, _event, data) => {
    logs.push({ category, data });
  });
  let calls = 0;
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, _init) => {
    calls++;
    return new Response('{"error":"Provider returned error"}', { status: 400 });
  }) as typeof fetch);
  try {
    const config = { llm: { provider: 'openai', model: 'gpt-5.6', apiKey: 'test-key' } } as UserConfig;
    try {
      for await (const _ of getProviderForConfig(config).streamChat!(messages)) { /* consume */ }
      throw new Error('expected HTTP 400');
    } catch (error) {
      expect(String(error)).toContain('400');
    }
    expect(calls).toBe(2); // Existing generic unknown-error retry policy is preserved.
    expect(logs.some(l => l.category === 'llm.retry' && l.data.provider === 'openai' && l.data.category !== 'overloaded')).toBe(true);
  } finally {
    fetchMock.mockRestore();
    log.mockRestore();
  }
});

test('OpenRouter upstream error body retries as overloaded even when the HTTP status is not 5xx', async () => {
  const logs: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    logs.push({ category, event, data });
  });
  let calls = 0;
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, _init) => {
    calls++;
    return calls === 1
      ? new Response('{"error":"Provider returned error"}', { status: 400 })
      : new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const config = { llm: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'test-key' } } as UserConfig;
    for await (const _ of getProviderForConfig(config).streamChat!(messages)) { /* consume */ }
    expect(calls).toBe(2);
    expect(logs.some(l => l.category === 'llm.retry' && l.event === 'retry' && l.data.provider === 'openrouter' && l.data.category === 'overloaded')).toBe(true);
  } finally {
    fetchMock.mockRestore();
    log.mockRestore();
  }
});

test('llm.openrouter keeps providerPreferences and fallbackModel together through save → reload', () => {
  const root = mkdtempSync(join(tmpdir(), 'openrouter-config-both-'));
  try {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ llm: { provider: 'openai-codex', openrouter: {
      providerPreferences: { order: ['z-ai'] }, fallbackModel: 'openrouter/z-ai/glm-5.3-flash',
    } } }));
    const loaded = buildUserConfig(path);
    expect(loaded.llm.openrouter).toEqual({ providerPreferences: { order: ['z-ai'] }, fallbackModel: 'openrouter/z-ai/glm-5.3-flash' });
    const savedPath = join(root, 'saved.json');
    saveUserConfig(loaded, savedPath);
    expect(buildUserConfig(savedPath).llm.openrouter).toEqual(loaded.llm.openrouter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
