import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { makeOpenRouterProvider, modelProfileSampling, modelProfileTimeoutMs, streamLLM, streamLLMWithTools } from '../src/llm.js';
import { resolveModelProfile } from '../src/llm-model-profiles.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeOpenRouter(model: string) {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = ((_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }));
  }) as unknown as typeof fetch;
  const provider = makeOpenRouterProvider({ provider: 'openrouter', apiKey: 'fake-key', model } as Parameters<typeof makeOpenRouterProvider>[0]);
  return { provider, bodies };
}

test('Qwen and GLM profiles reach the actual OpenRouter request; caller sampling wins', async () => {
  const qwen = fakeOpenRouter('openrouter/qwen/qwen3.8-flash');
  expect(await streamLLM([{ role: 'user', content: 'x' }], () => {}, { provider: qwen.provider })).toBe('ok');
  expect(qwen.bodies[0]?.temperature).toBe(0.55);
  expect(qwen.bodies[0]?.frequency_penalty).toBeUndefined();

  const glm = fakeOpenRouter('openrouter/z-ai/glm-5.3');
  expect(await streamLLM([{ role: 'user', content: 'x' }], () => {}, { provider: glm.provider })).toBe('ok');
  expect(glm.bodies[0]?.temperature).toBe(1);
  expect(await streamLLM([{ role: 'user', content: 'x' }], () => {}, { provider: glm.provider, temperature: 0.2, frequencyPenalty: 0 })).toBe('ok');
  expect(glm.bodies[1]?.temperature).toBe(0.2);
  expect(glm.bodies[1]?.frequency_penalty).toBe(0);
});

test('Solar demo models and unknown IDs keep the existing wire defaults', async () => {
  expect(resolveModelProfile('openrouter/upstage/solar-pro4')).toBeUndefined();
  expect(resolveModelProfile('openrouter/upstage/solar-mini4')).toBeUndefined();
  expect(resolveModelProfile('unknown/example')).toBeUndefined();
  const solar = fakeOpenRouter('openrouter/upstage/solar-pro4');
  expect(await streamLLM([{ role: 'user', content: 'x' }], () => {}, { provider: solar.provider })).toBe('ok');
  expect(solar.bodies[0]?.temperature).toBeUndefined();
  expect(solar.bodies[0]?.frequency_penalty).toBeUndefined();
  const mini = fakeOpenRouter('openrouter/upstage/solar-mini4');
  expect(await streamLLM([{ role: 'user', content: 'x' }], () => {}, { provider: mini.provider })).toBe('ok');
  expect(mini.bodies[0]?.temperature).toBeUndefined();
  expect(mini.bodies[0]?.frequency_penalty).toBeUndefined();
});

test('Solar Pro 3 reasoning effort map is consumed at the OpenRouter wire call', async () => {
  const solar = fakeOpenRouter('openrouter/upstage/solar-pro3');
  expect(await streamLLM([{ role: 'user', content: 'x' }], () => {}, {
    provider: solar.provider, reasoningEffort: 'high',
  })).toBe('ok');
  expect(solar.bodies[0]?.reasoning).toEqual({ effort: 'high' });
});

test('the product tool loop uses profile idle timeout and caller override', async () => {
  const qwen = fakeOpenRouter('openrouter/qwen/qwen3.8-flash');
  const starts: Array<Record<string, unknown>> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.stream' && event === 'consume-start') starts.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    const handlers = { onText: () => {}, dispatchTool: async () => ({}) };
    const tools = [{ name: 'probe', description: 'fake tool', parameters: { type: 'object' } }];
    await streamLLMWithTools([{ role: 'user', content: 'x' }], handlers, { provider: qwen.provider, tools });
    expect(starts.at(-1)).toMatchObject({ idleMs: 180_000, idleMsSource: 'profile' });
    await streamLLMWithTools([{ role: 'user', content: 'x' }], handlers, {
      provider: qwen.provider, tools,
      // 출처: .rules/30-harness/testing-gates.md · 호출자 명시 상한이 프로필보다 우선한다.
      streamIdleTimeoutMs: 50,
    });
    expect(starts.at(-1)).toMatchObject({ idleMs: 50, idleMsSource: 'call' });
    const grok = fakeOpenRouter('grok-4.7');
    // Keep the real OpenRouter request/stream consumer, but mark this injected
    // fixture as non-catalog so model-family dispatch cannot switch to the
    // credential-backed GrokProvider before the fake fetch runs.
    const fixtureProvider = { ...grok.provider, name: 'fixture-openrouter' };
    await streamLLMWithTools([{ role: 'user', content: 'x' }], handlers, { provider: fixtureProvider, tools });
    expect(starts.at(-1)).toMatchObject({ model: 'grok-4.7', idleMs: 300_000, idleMsSource: 'profile' });
  } finally {
    log.mockRestore();
  }
});

test('all four profile timeout fields convert seconds to milliseconds once, with absence preserved', () => {
  const profile = { timeouts: { header_s: 7, first_token_s: 11, idle_chunk_s: 13, total_s: 17 } };
  expect(modelProfileTimeoutMs(profile, 'header_s')).toBe(7_000);
  expect(modelProfileTimeoutMs(profile, 'first_token_s')).toBe(11_000);
  expect(modelProfileTimeoutMs(profile, 'idle_chunk_s')).toBe(13_000);
  expect(modelProfileTimeoutMs(profile, 'total_s')).toBe(17_000);
  expect(modelProfileTimeoutMs(undefined, 'header_s')).toBeUndefined();
  expect(modelProfileTimeoutMs({ timeouts: {} }, 'idle_chunk_s')).toBeUndefined();
});

test('profile sampling applies optional frequency penalty and explicit caller values win', () => {
  const profile = { sampling: { temperature: 0.55, frequency_penalty: 0.4 } };
  expect(modelProfileSampling(profile, {})).toEqual({ temperature: 0.55, frequencyPenalty: 0.4 });
  expect(modelProfileSampling(profile, { temperature: 0.2, frequencyPenalty: 0 })).toEqual({ temperature: 0.2, frequencyPenalty: 0 });
  expect(modelProfileSampling(undefined, {})).toEqual({ temperature: undefined, frequencyPenalty: undefined });
});
