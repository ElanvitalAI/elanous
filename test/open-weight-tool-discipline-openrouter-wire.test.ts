// OR-FAMILY-DISCIPLINE (review r1 should-fix) — the capturing-provider test proves injection
// before streamChat; this one proves the discipline survives the real OpenRouter adapter:
// streamLLMWithTools with the catalog id `openrouter/<vendor>/<model>` → the request body that
// reaches fetch carries OPEN_WEIGHT_TOOL_DISCIPLINE as a system message, and the wire model is
// the prefix-stripped id. Control: a non-open-weight OpenRouter id carries no such message.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OPEN_WEIGHT_TOOL_DISCIPLINE, getProviderForConfig, streamLLMWithTools } from '../src/llm';
import { getUserConfig } from '../src/user-config';

let bodies: any[];
let prior: typeof fetch;
beforeEach(() => {
  bodies = [];
  prior = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const sse = 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = prior; });

async function firstWireBody(model: string) {
  const base = getUserConfig();
  const provider = getProviderForConfig({
    ...base, llm: { ...base.llm, provider: 'openrouter', model, apiKey: 'sk-or-test', baseUrl: undefined },
  } as never);
  expect(provider.name).toBe('openrouter');
  await streamLLMWithTools(
    [{ role: 'user', content: 'go' }],
    { onText() {}, dispatchTool: async () => 'ok' },
    { provider, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }], maxTurns: 2, model },
  );
  expect(bodies.length).toBeGreaterThan(0);
  return bodies[0];
}

const systemTexts = (body: any): string[] => (body.messages as any[])
  .filter(m => m.role === 'system')
  // OR-ANTHROPIC-CACHE — moonshotai/* system content is a text-part array carrying cache_control; read the text.
  .map(m => (typeof m.content === 'string' ? m.content : (m.content as any[]).map(p => p?.text ?? '').join('')));

describe('open-weight discipline on the real OpenRouter wire', () => {
  for (const [model, wire] of [
    ['openrouter/z-ai/glm-5.3', 'z-ai/glm-5.3'],
    ['openrouter/moonshotai/kimi-k3', 'moonshotai/kimi-k3'],
    ['openrouter/qwen/qwen3.8-flash', 'qwen/qwen3.8-flash'],
  ] as const) {
    test(`${model} → request body carries the discipline`, async () => {
      const body = await firstWireBody(model);
      expect(body.model).toBe(wire);
      expect(systemTexts(body).some(text => text.includes(OPEN_WEIGHT_TOOL_DISCIPLINE))).toBe(true);
    });
  }

  test('control: openrouter/anthropic/claude-opus-4-8 → no open-weight discipline on the wire', async () => {
    const body = await firstWireBody('openrouter/anthropic/claude-opus-4-8');
    expect(systemTexts(body).some(text => text.includes('[open-weight tool-use discipline]'))).toBe(false);
  });
});
