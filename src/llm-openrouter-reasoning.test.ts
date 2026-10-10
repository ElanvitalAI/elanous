import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { getProviderForConfig, type LLMOpts } from './llm.js';
import type { UserConfig } from './user-config.js';

// OpenRouter effort request bodies and non-OpenRouter byte preservation; fetch is mocked (no API calls).

const messages = [{ role: 'user' as const, content: 'hello' }];

async function captureRaw(provider: string, model: string, opts: LLMOpts = {}, reasoningLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh'): Promise<string> {
  const bodies: string[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const config = { llm: { provider, model, apiKey: 'test-key', reasoningLevel, ...(provider === 'local' ? { baseUrl: 'http://localhost:1234/v1' } : {}) } } as UserConfig;
    for await (const _ of getProviderForConfig(config).streamChat!(messages, opts)) { /* consume */ }
    expect(bodies.length).toBe(1);
    return bodies[0]!;
  } finally {
    mock.mockRestore();
  }
}

async function captureBody(provider: string, model: string, opts: LLMOpts = {}, reasoningLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh'): Promise<Record<string, any>> {
  return JSON.parse(await captureRaw(provider, model, opts, reasoningLevel));
}

const OR_MODEL = 'openrouter/z-ai/glm-5.1';

test('openrouter: xhigh → reasoning.effort high · minimal → low · non-open-weight 미지정 → reasoning 칸 없음', async () => {
  expect((await captureBody('openrouter', OR_MODEL, { reasoningEffort: 'xhigh' })).reasoning).toEqual({ effort: 'high' });
  expect((await captureBody('openrouter', OR_MODEL, { reasoningEffort: 'minimal' })).reasoning).toEqual({ effort: 'low' });
  const none = await captureBody('openrouter', 'openrouter/openai/gpt-6-sol');
  expect('reasoning' in none).toBe(false);
});

test('openrouter: 사상표 전수 (low·medium·high·max) · 모르는 값은 안 싣는다', async () => {
  const cases: Array<[NonNullable<LLMOpts['reasoningEffort']>, string]> = [
    ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['max', 'high'],
  ];
  for (const [requested, sent] of cases) {
    expect((await captureBody('openrouter', OR_MODEL, { reasoningEffort: requested })).reasoning).toEqual({ effort: sent });
  }
  const unknown = await captureBody('openrouter', OR_MODEL, { reasoningEffort: 'turbo' as never });
  expect('reasoning' in unknown).toBe(false);
});

test('openrouter: maxTokens 300 이어도 max_tokens·max_completion_tokens 가 없다 (reasoning 과 함께여도)', async () => {
  for (const opts of [{ maxTokens: 300 }, { maxTokens: 300, reasoningEffort: 'high' as const }]) {
    const body = await captureBody('openrouter', OR_MODEL, opts);
    expect('max_tokens' in body).toBe(false);
    expect('max_completion_tokens' in body).toBe(false);
  }
});

test('openrouter: provider 선호·usage.include 는 reasoning 과 함께 그대로 실린다', async () => {
  const body = await captureBody('openrouter', OR_MODEL, { reasoningEffort: 'medium' });
  expect(body.usage).toEqual({ include: true });
  expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: true });
  expect(body.reasoning).toEqual({ effort: 'medium' });
  expect(body.model).toBe('z-ai/glm-5.1');
});

test('openrouter: debug.log llm.openrouter reasoning 에 requested·sent·source·field 를 남긴다', async () => {
  const logs: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    logs.push({ category, event, data });
  });
  try {
    await captureBody('openrouter', OR_MODEL, { reasoningEffort: 'xhigh' });
    await captureBody('openrouter', OR_MODEL);
    await captureBody('openrouter', 'openrouter/openai/gpt-6-sol');
    await captureBody('openrouter', 'openrouter/anthropic/claude-sonnet-5.5', {}, 'high');
    await captureBody('openrouter', OR_MODEL, {}, 'high');
  } finally {
    log.mockRestore();
  }
  const hits = logs.filter((l) => l.category === 'llm.openrouter' && l.event === 'reasoning');
  expect(hits.map((h) => h.data)).toEqual([
    { model: OR_MODEL, requested: 'xhigh', sent: 'high', source: 'call', field: 'reasoning' },
    { model: OR_MODEL, requested: null, sent: 'medium', source: 'default', field: 'reasoning' },
    { model: 'openrouter/openai/gpt-6-sol', requested: null, sent: null, source: 'none', field: 'none' },
    { model: 'openrouter/anthropic/claude-sonnet-5.5', requested: null, sent: 'high', source: 'config', field: 'verbosity' },
    { model: OR_MODEL, requested: null, sent: 'high', source: 'config', field: 'reasoning' },
  ]);
  expect(JSON.stringify(hits)).not.toContain('test-key');
});

test('openrouter: model family, not vendor, decides the default effort and observation', async () => {
  const cases = [
    { model: 'openrouter/moonshotai/kimi-k2.6', sent: 'medium', source: 'default', field: 'reasoning' },
    { model: 'openrouter/qwen/qwen3.6-flash', sent: 'medium', source: 'default', field: 'reasoning' },
    { model: 'openrouter/qwen/qwen3.6-max-preview', sent: null, source: 'none', field: 'none' },
    { model: 'openrouter/mistralai/mistral-large-next', sent: null, source: 'none', field: 'none' },
    { model: 'openrouter/qwen/qwen3.8-max-0902', sent: null, source: 'none', field: 'none' },
    { model: 'openrouter/auto', sent: null, source: 'none', field: 'none' },
  ] as const;
  const logs: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    logs.push({ category, event, data });
  });
  try {
    for (const { model, sent, source, field } of cases) {
      const body = await captureBody('openrouter', model);
      if (sent) expect(body.reasoning).toEqual({ effort: sent });
      else expect('reasoning' in body).toBe(false);
      expect('verbosity' in body).toBe(false);
      expect(logs.filter((l) => l.category === 'llm.openrouter' && l.event === 'reasoning').at(-1)?.data)
        .toEqual({ model, requested: null, sent, source, field });
    }
  } finally {
    log.mockRestore();
  }
});

test('openrouter: config high wins over open-weight medium, and call low wins over config high', async () => {
  const model = 'openrouter/qwen/qwen3.6-flash';
  expect((await captureBody('openrouter', model, {}, 'high')).reasoning).toEqual({ effort: 'high' });
  expect((await captureBody('openrouter', model, { reasoningEffort: 'low' }, 'high')).reasoning).toEqual({ effort: 'low' });
  expect((await captureBody('openrouter', model)).reasoning).toEqual({ effort: 'medium' });
  expect('reasoning' in await captureBody('openrouter', model, {}, 'off')).toBe(false);
  expect((await captureBody('openrouter', model, { reasoningEffort: 'low' }, 'off')).reasoning).toEqual({ effort: 'low' });
});

test('openrouter: cross-family model route preserves the resolved config effort', async () => {
  const priorKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    const config = { llm: { provider: 'openai-codex', model: 'gpt-6-sol', reasoningLevel: 'high' } } as UserConfig;
    const model = 'openrouter/qwen/qwen3.8-max-0902';
    const provider = getProviderForConfig(config, model);
    expect(provider.name).toBe('openrouter');
    const bodies: string[] = [];
    const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response('data: [DONE]\n\n', { status: 200 });
    }) as typeof fetch);
    try {
      for await (const _ of provider.streamChat!(messages)) { /* consume */ }
    } finally {
      mock.mockRestore();
    }
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).reasoning).toEqual({ effort: 'high' });
  } finally {
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
  }
});

test('openrouter: anthropic effort uses verbosity only, with existing mapping at every level', async () => {
  const model = 'openrouter/anthropic/claude-sonnet-5.5';
  for (const [effort, expected] of [['minimal', 'low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'high']] as const) {
    const body = await captureBody('openrouter', model, { reasoningEffort: effort });
    expect(body.verbosity).toBe(expected);
    expect('reasoning' in body).toBe(false);
  }
  const configured = await captureBody('openrouter', model, {}, 'high');
  expect(configured.verbosity).toBe('high');
  expect('reasoning' in configured).toBe(false);
  const none = await captureBody('openrouter', model);
  expect('verbosity' in none).toBe(false);
});

// 불변식(OP): openrouter 가 아닌 openai 호환 provider 본문은 reasoningEffort 를 줘도 이 골 전과 바이트 동일.
for (const [provider, model] of [['grok', 'grok-4.7'], ['openai', 'gpt-5.6'], ['local', 'local-model']] as const) {
  test(`불변식: ${provider} 본문은 reasoningEffort 'high' 를 줘도 reasoning 칸이 없고 바이트 동일`, async () => {
    const rawWith = await captureRaw(provider, model, { reasoningEffort: 'high', maxTokens: 300 });
    const rawWithout = await captureRaw(provider, model, { maxTokens: 300 });
    expect(rawWith).toBe(rawWithout); // fetch 가 받은 원본 본문 문자열 그대로 비교(바이트 동일)
    const withEffort = JSON.parse(rawWith);
    expect('reasoning' in withEffort).toBe(false);
    expect(withEffort.provider).toBeUndefined();
    expect(withEffort.usage).toBeUndefined();
  });
}
