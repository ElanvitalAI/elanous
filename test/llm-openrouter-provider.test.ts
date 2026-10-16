// 대표 2026-09-23 — OpenRouter provider 의 wire 계약.
//   ⑴ 카탈로그 id `openrouter/<vendor>/<model>` → wire 는 접두를 뗀다
//   ⑵ ⛔ 교차 경로(config provider ≠ openrouter)에서 «남의 키·남의 baseUrl» 을 OpenRouter 로 보내지 않는다
//   ⑶ 레거시 `getProvider(model)` 이 `openrouter/` 를 기본 provider 로 흘리지 않는다
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⛔ 키 캐시는 프로세스당 첫 읽기를 기억한다 — llm 을 import 하기 «전»에 캐시 디렉토리를 고정한다.
const keyDir = mkdtempSync(join(tmpdir(), 'or-keys-'));
writeFileSync(join(keyDir, 'openrouter_api_key'), 'sk-or-from-cache\n');
const savedKeyDir = process.env.ELANOUS_KEY_CACHE_DIR;
const savedKeep = process.env.ELANOUS_KEEP_ENV_KEYS;
process.env.ELANOUS_KEY_CACHE_DIR = keyDir;
delete process.env.ELANOUS_KEEP_ENV_KEYS;

const llm = await import('../src/llm.js');
const uc = await import('../src/user-config.js');
const { OPENROUTER_API_URL, _resetKeyCacheForTests } = await import('../src/config.js');
// R4 (gate 0.2.30 pod-15): the memo is per «process», not per file — an earlier file in the same shard had already read
// OPENROUTER_API_KEY (no cache file → null), so the cache dir above was never consulted. Forget it here and on the way out
// (the fixture key must not outlive this file either).
_resetKeyCacheForTests();

type Capture = { url: string; headers: Record<string, string>; body: any };
let calls: Capture[];
let prior: typeof fetch;
beforeEach(() => {
  calls = [];
  prior = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(url), headers, body: JSON.parse(init.body) });
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = prior; });
beforeAll(() => {});
afterAll(() => {
  _resetKeyCacheForTests();
  if (savedKeyDir === undefined) delete process.env.ELANOUS_KEY_CACHE_DIR; else process.env.ELANOUS_KEY_CACHE_DIR = savedKeyDir;
  if (savedKeep !== undefined) process.env.ELANOUS_KEEP_ENV_KEYS = savedKeep;
});

function cfg(llmPatch: Record<string, unknown>) {
  const base = uc.getUserConfig();
  return { ...base, llm: { ...base.llm, apiKey: undefined, baseUrl: undefined, ...llmPatch } } as never;
}
async function drain(p: ReturnType<typeof llm.getProviderForConfig>, model?: string) {
  for await (const _ of p.streamChat!([{ role: 'user', content: 'hi' }], model ? { model } : {})) { /* consume */ }
}

describe('OpenRouter provider wire', () => {
  test('config provider=openrouter — 접두를 떼고, 설정 키와 X-Title 을 보낸다', async () => {
    const p = llm.getProviderForConfig(cfg({ provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3', apiKey: 'sk-or-cfg' }));
    expect(p.name).toBe('openrouter');
    await drain(p);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OPENROUTER_API_URL);
    expect(calls[0]!.body.model).toBe('moonshotai/kimi-k3');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-or-cfg');
    expect(calls[0]!.headers['x-title']).toBe('elanous');
    expect(calls[0]!.headers['http-referer']).toBeUndefined();
  });

  test('⛔ 교차 경로 — config 가 grok 이면 그 키·baseUrl 을 OpenRouter 로 «안» 보낸다', async () => {
    const p = llm.getProviderForConfig(
      cfg({ provider: 'grok', model: 'grok-4.7', apiKey: 'xai-SECRET', baseUrl: 'https://proxy.example/v1' }),
      'openrouter/z-ai/glm-5.3',
    );
    expect(p.name).toBe('openrouter');
    await drain(p);
    expect(calls[0]!.url).toBe(OPENROUTER_API_URL);
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-or-from-cache');
    expect(calls[0]!.body.model).toBe('z-ai/glm-5.3');
  });

  test('레거시 getProvider(model) — `openrouter/` 는 openrouter 로 간다(기본 provider 로 새지 않는다)', () => {
    expect(llm.getProvider('openrouter/qwen/qwen3.8-flash').name).toBe('openrouter');
  });

  test('openRouterWireModel — 접두만 뗀다', () => {
    expect(llm.openRouterWireModel('openrouter/qwen/qwen3.8-flash')).toBe('qwen/qwen3.8-flash');
    expect(llm.openRouterWireModel('qwen/qwen3.8-flash')).toBe('qwen/qwen3.8-flash');
  });

  test('⛔ OpenRouter 의 `delta.reasoning` 을 추론 이벤트로 낸다 — 안 내면 추론하는 동안 이벤트 0개로 유휴 타임아웃에 죽는다', async () => {
    globalThis.fetch = (async () => {
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning":"We need","reasoning_details":[{"type":"reasoning.text","text":"We need"}]}}]}',
        'data: {"choices":[{"delta":{"content":"","reasoning":" to count"}}]}',
        'data: {"choices":[{"delta":{"content":"400"}}]}',
        'data: [DONE]', '',
      ].join('\n\n');
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const p = llm.getProviderForConfig(cfg({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'sk-or-cfg' }));
    const events: any[] = [];
    for await (const e of p.streamChat!([{ role: 'user', content: 'q' }], {})) events.push(e);
    const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.delta).join('');
    expect(reasoning).toBe('We need to count');
    expect(events.filter((e) => e.type === 'text').map((e) => e.text ?? e.delta).join('')).toBe('400');
  });

  test('⛔ max_tokens 를 «안» 보낸다 — codex 처럼 출력 상한 없음 (호출자가 작은 값을 줘도, 큰 값을 줘도)', async () => {
    const p = llm.getProviderForConfig(cfg({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'sk-or-cfg' }));
    await drain(p);
    expect('max_tokens' in calls[0]!.body).toBe(false);
    expect('max_completion_tokens' in calls[0]!.body).toBe(false);
    for await (const _ of p.streamChat!([{ role: 'user', content: 'hi' }], { maxTokens: 40000 })) { /* consume */ }
    expect('max_tokens' in calls[1]!.body).toBe(false);
  });

  test('⛔ reasoning_details 왕복 — 조각을 이어 첫 도구 호출에 싣고, 다음 요청 어시스턴트 메시지에 되돌린다(Kimi K3 는 필수)', async () => {
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url: String(url), headers: {}, body: JSON.parse(init.body) });
      const sse = [
        'data: {"choices":[{"delta":{"reasoning":"We ","reasoning_details":[{"type":"reasoning.text","text":"We ","index":0,"format":"unknown"}]}}]}',
        'data: {"choices":[{"delta":{"reasoning":"read","reasoning_details":[{"type":"reasoning.text","text":"read","index":0}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"functions.Read:0","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]', '',
      ].join('\n\n');
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const p = llm.getProviderForConfig(cfg({ provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3', apiKey: 'sk-or-cfg' }));
    const events: any[] = [];
    for await (const e of p.streamChat!([{ role: 'user', content: 'q' }], {})) events.push(e);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call.providerMeta.reasoningDetails).toEqual([{ type: 'reasoning.text', text: 'We read', index: 0, format: 'unknown' }]);

    const history = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.args, providerMeta: call.providerMeta }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] },
    ];
    for await (const _ of p.streamChat!(history as never, {})) { /* consume */ }
    const assistantMsg = calls[1]!.body.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'We read', index: 0, format: 'unknown' }]);

    // 대조군 — grok 은 같은 기록이어도 reasoning_details 를 싣지 않는다(모르는 칸 400 방지)
    const g = llm.getProviderForConfig(cfg({ provider: 'grok', model: 'grok-4.7', apiKey: 'xai-x', baseUrl: 'https://proxy.example/v1' }));
    for await (const _ of g.streamChat!(history as never, {})) { /* consume */ }
    const gAssistant = calls[2]!.body.messages.find((m: any) => m.role === 'assistant');
    expect(gAssistant.reasoning_details).toBeUndefined();
  });

  test('⛔ temperature — 기본 0.3 을 강제하지 않는다(명시하면 싣는다) · 대조군 grok 은 종전대로 0.3', async () => {
    const p = llm.getProviderForConfig(cfg({ provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3', apiKey: 'sk-or-cfg' }));
    await drain(p);
    expect('temperature' in calls[0]!.body).toBe(false);
    for await (const _ of p.streamChat!([{ role: 'user', content: 'hi' }], { temperature: 0.7 })) { /* consume */ }
    expect(calls[1]!.body.temperature).toBe(0.7);
    const g = llm.getProviderForConfig(cfg({ provider: 'grok', model: 'grok-4.7', apiKey: 'xai-x', baseUrl: 'https://proxy.example/v1' }));
    await drain(g);
    expect(calls[2]!.body.temperature).toBe(0.3);
  });
});

