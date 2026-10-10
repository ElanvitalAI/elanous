// OR-ANTHROPIC-CACHE (2026-10-10) — OpenRouter 뒤 anthropic/* · moonshotai/* 에만 cache_control 중단점을 싣는다.
import { expect, spyOn, test } from 'bun:test';
import { getProviderForConfig, type LLMMessage, type LLMToolSpec } from './llm.js';
import { applyOpenRouterCacheControl, openRouterPromptCacheFamily } from './prompt-cache/openrouter.js';
import type { UserConfig } from './user-config.js';

const tools: LLMToolSpec[] = [{ name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const loop: LLMMessage[] = [
  { role: 'system', content: 'You are elanous. '.repeat(20) },
  { role: 'user', content: 'read a.ts' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export const a = 1;' }] },
  { role: 'assistant', content: 'a is 1' },
  { role: 'user', content: 'and b?' },
];

async function capture(provider: string, model: string, opts: Record<string, unknown> = {}) {
  const bodies: string[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const config = { llm: { provider, model, apiKey: 'test-key', ...(provider === 'local' ? { baseUrl: 'http://localhost:1234/v1' } : {}) } } as UserConfig;
    for await (const _ of getProviderForConfig(config).streamChat!(loop, { tools, ...opts })) { /* consume */ }
    return { raw: bodies[0]!, body: JSON.parse(bodies[0]!) as Record<string, any> };
  } finally {
    mock.mockRestore();
  }
}

function countMarkers(raw: string): number {
  return raw.split('"cache_control"').length - 1;
}

test('family gate: only anthropic/* and moonshotai/* wire models', () => {
  expect(openRouterPromptCacheFamily('anthropic/claude-haiku-5.5')).toBe('anthropic');
  expect(openRouterPromptCacheFamily('moonshotai/kimi-k3')).toBe('moonshotai');
  expect(openRouterPromptCacheFamily('z-ai/glm-5.3')).toBeNull();
  expect(openRouterPromptCacheFamily('qwen/qwen3.6-coder')).toBeNull();
  expect(openRouterPromptCacheFamily('openai/gpt-5.5')).toBeNull();
});

test('anthropic via OpenRouter: system + last two cacheable messages carry markers (≤4)', async () => {
  const { raw, body } = await capture('openrouter', 'openrouter/anthropic/claude-haiku-5.5');
  const msgs = body.messages as Array<Record<string, any>>;
  const sys = msgs[0]!;
  expect(sys.role).toBe('system');
  expect(Array.isArray(sys.content)).toBe(true);
  expect(sys.content.at(-1)).toEqual({ type: 'text', text: 'You are elanous. '.repeat(20), cache_control: { type: 'ephemeral' } });
  const n = countMarkers(raw);
  expect(n).toBeGreaterThanOrEqual(1);
  expect(n).toBeLessThanOrEqual(4);
  expect(n).toBe(3); // system 1 ⊕ tail 2
  // tail = 'a is 1' (assistant) ⊕ 'and b?' (user) — marker on the content part, never top-level.
  expect(msgs.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'and b?', cache_control: { type: 'ephemeral' } }] });
  expect(msgs.at(-2)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'a is 1', cache_control: { type: 'ephemeral' } }] });
  for (const m of msgs) expect('cache_control' in m).toBe(false);
  // tools carry no marker — the system breakpoint covers the tools prefix (tools → system → messages).
  expect(JSON.stringify(body.tools)).not.toContain('cache_control');
});

test('tool loop tail: tool message gets a part-level marker, pure tool_calls assistant is skipped', () => {
  const wire = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'result' },
  ];
  const before = structuredClone(wire);
  const plan = applyOpenRouterCacheControl(wire, { family: 'anthropic' });
  expect(wire).toEqual(before); // pure
  expect(plan.breakpoints).toBe(3);
  expect(plan.messages[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: 'result', cache_control: { type: 'ephemeral' } }] });
  expect(plan.messages[2]).toEqual(wire[2]!);
  expect(plan.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'go', cache_control: { type: 'ephemeral' } }] });
});

test('budget: two system messages + two tail = 4; never more', () => {
  const wire = [
    { role: 'system', content: 's1' }, { role: 'system', content: 's2' }, { role: 'system', content: 's3' },
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' },
  ];
  const plan = applyOpenRouterCacheControl(wire, { family: 'anthropic' });
  expect(plan.breakpoints).toBe(4);
  expect(plan.systemBreakpoints).toBe(2);
  expect(plan.messages[2]).toEqual({ role: 'system', content: 's3' });
  expect(plan.messages[3]).toEqual({ role: 'user', content: 'u1' });
});

test('image-last user part is not marked (conservative — text parts only)', () => {
  const wire = [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }];
  expect(applyOpenRouterCacheControl(wire, { family: 'anthropic' }).breakpoints).toBe(0);
});

test('TTL: 1h is sent for anthropic only; moonshot stays on the default tier', async () => {
  const a = await capture('openrouter', 'openrouter/anthropic/claude-sonnet-5.5', { promptCacheTTL: '1h' });
  expect(a.body.messages[0].content.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  const k = await capture('openrouter', 'openrouter/moonshotai/kimi-k3', { promptCacheTTL: '1h' });
  expect(k.body.messages[0].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
  expect(countMarkers(k.raw)).toBe(3);
});

test('promptCache:false turns the markers off on the OpenRouter anthropic path', async () => {
  const { raw, body } = await capture('openrouter', 'openrouter/anthropic/claude-haiku-5.5', { promptCache: false });
  expect(raw).not.toContain('cache_control');
  expect(body.messages[0]).toEqual({ role: 'system', content: 'You are elanous. '.repeat(20) });
});

test('invariant: non-targeted OpenRouter models and compat providers keep byte-identical bodies', async () => {
  // glm: default (cache on) body == promptCache:false body, byte for byte, and system stays a plain string.
  const glmOn = await capture('openrouter', 'openrouter/z-ai/glm-5.3');
  const glmOff = await capture('openrouter', 'openrouter/z-ai/glm-5.3', { promptCache: false });
  expect(glmOn.raw).toBe(glmOff.raw);
  expect(glmOn.raw).not.toContain('cache_control');
  expect(glmOn.body.messages[0]).toEqual({ role: 'system', content: 'You are elanous. '.repeat(20) });
  // anthropic with cache off == the shape a non-targeted model gets (only the model id differs).
  const anthOff = await capture('openrouter', 'openrouter/anthropic/claude-haiku-5.5', { promptCache: false });
  expect(anthOff.raw.replace('anthropic/claude-haiku-5.5', 'z-ai/glm-5.3')).toBe(glmOff.raw);
  for (const p of [['openai', 'gpt-5.5'], ['local', 'qwen3.6']] as const) {
    const on = await capture(p[0], p[1]);
    const off = await capture(p[0], p[1], { promptCache: false });
    expect(on.raw).not.toContain('cache_control');
    expect(on.raw).toBe(off.raw);
  }
});
