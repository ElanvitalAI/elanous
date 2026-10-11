// OR-DEEPSEEK-TUNE — OpenRouter deepseek/* 조정의 요청 바이트 계약. fetch 는 spy(실호출 없음 · mock.module 없음).
// 대조군(z-ai/glm-5.1 · moonshotai/kimi-k3)으로 «DeepSeek 가 아닌 모델은 그대로» 를 같이 문다.
import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import {
  getProviderForConfig, parseOpenAISSELines, streamLLMWithTools, toOpenAIMessages, OPEN_WEIGHT_TOOL_DISCIPLINE,
  type LLMMessage, type LLMOpts, type LLMStreamEvent,
} from './llm.js';
import { getModelFamily } from './models/prompts.js';
import {
  isOpenRouterDeepSeekV4WireModel, nonEmptyReasoningDetails, openRouterDeepSeekCatalogEffort, openRouterDeepSeekEffort,
  openRouterDeepSeekProviderField, resolveOpenRouterUpstreamPin, summarizeDeepSeekReplay,
} from './llm/openrouter-deepseek.js';
import { DEFAULT_OPENROUTER_UPSTREAM_PINS } from './llm/openrouter-upstream-pins.config.js';
import { buildUserConfig } from './user-config.js';
import type { UserConfig } from './user-config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FLASH = 'openrouter/deepseek/deepseek-v4.1-flash';
const PRO = 'openrouter/deepseek/deepseek-v4-pro-0813';
const GLM = 'openrouter/z-ai/glm-5.1';

function sse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function capture(
  model: string,
  messages: LLMMessage[],
  opts: LLMOpts = {},
  llmExtra: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const bodies: string[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const config = { llm: { provider: 'openrouter', model, apiKey: 'test-key', ...llmExtra } } as unknown as UserConfig;
    for await (const _ of getProviderForConfig(config).streamChat!(messages, opts)) { /* consume */ }
    expect(bodies.length).toBe(1);
    return JSON.parse(bodies[0]!);
  } finally {
    mock.mockRestore();
  }
}

const hello: LLMMessage[] = [{ role: 'user', content: 'hello' }];

// ① 모델군
test('① openrouter/deepseek/* → open-weight 군 · 맨 deepseek/* (LM Studio 꼴) 는 other 그대로', () => {
  expect(getModelFamily(FLASH)).toBe('open-weight');
  expect(getModelFamily(PRO)).toBe('open-weight');
  expect(getModelFamily('deepseek/deepseek-v4-flash')).toBe('other');
  expect(getModelFamily('deepseek-v4-flash')).toBe('other');
});

test('① 실 OpenRouter 배선: deepseek 요청에 open-weight 도구 규율이 실린다', async () => {
  const bodies: any[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]);
  }) as typeof fetch);
  try {
    const provider = getProviderForConfig({ llm: { provider: 'openrouter', model: FLASH, apiKey: 'k' } } as unknown as UserConfig);
    await streamLLMWithTools([{ role: 'user', content: 'go' }], { onText() {}, dispatchTool: async () => 'ok' },
      { provider, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }], maxTurns: 2, model: FLASH });
  } finally {
    mock.mockRestore();
  }
  const sys = (bodies[0].messages as any[]).filter((m) => m.role === 'system').map((m) => String(m.content));
  expect(sys.some((t) => t.includes(OPEN_WEIGHT_TOOL_DISCIPLINE))).toBe(true);
  expect(bodies[0].model).toBe('deepseek/deepseek-v4.1-flash');
});

// ② effort 표
test('② DeepSeek V4: xhigh·max → xhigh · off/모르는 값 → 칸 없음 · 나머지는 그대로', async () => {
  for (const [req, sent] of [['xhigh', 'xhigh'], ['max', 'xhigh'], ['high', 'high'], ['medium', 'medium'], ['low', 'low'], ['minimal', 'low']] as const) {
    expect((await capture(FLASH, hello, { reasoningEffort: req })).reasoning).toEqual({ effort: sent });
  }
  expect('reasoning' in await capture(FLASH, hello, {}, { reasoningLevel: 'off' })).toBe(false);
  expect('reasoning' in await capture(FLASH, hello, { reasoningEffort: 'turbo' as never })).toBe(false);
  expect(openRouterDeepSeekEffort('z-ai/glm-5.1', 'max')).toBeUndefined();
  expect(isOpenRouterDeepSeekV4WireModel('deepseek/deepseek-v4-pro-0813')).toBe(true);
  expect(isOpenRouterDeepSeekV4WireModel('deepseek/deepseek-r1')).toBe(false);
});

test('② 대조: GLM 은 종전 표 그대로(xhigh·max → high)', async () => {
  expect((await capture(GLM, hello, { reasoningEffort: 'xhigh' })).reasoning).toEqual({ effort: 'high' });
  expect((await capture(GLM, hello, { reasoningEffort: 'max' })).reasoning).toEqual({ effort: 'high' });
});

// ③ 카탈로그 → 기본 effort (카탈로그 YAML 에 의존하지 않게: 손 레코드는 stub 로, 배선은 폴백 경로로 문다)
test('③ 카탈로그 손 레코드의 reasoning 이 기본 effort · 자동 폴드·비 DeepSeek·없음 → undefined', () => {
  const stub = (rec: Record<string, unknown> | undefined) => () => rec as never;
  expect(openRouterDeepSeekCatalogEffort(PRO, stub({ reasoning: 'high', discoveryMeta: { autoFilled: false } }))).toBe('high');
  expect(openRouterDeepSeekCatalogEffort(FLASH, stub({ reasoning: 'medium' }))).toBe('medium');
  expect(openRouterDeepSeekCatalogEffort(FLASH, stub({ reasoning: 'high', discoveryMeta: { autoFilled: true } }))).toBeUndefined();
  expect(openRouterDeepSeekCatalogEffort(FLASH, stub({ reasoning: 'off' }))).toBeUndefined();
  expect(openRouterDeepSeekCatalogEffort(FLASH, stub(undefined))).toBeUndefined();
  expect(openRouterDeepSeekCatalogEffort(GLM, stub({ reasoning: 'high' }))).toBeUndefined();
  expect(openRouterDeepSeekCatalogEffort(FLASH, () => { throw new Error('boom'); })).toBeUndefined();
});

test('③ 배선: 손 레코드 값 또는 기존 폴백(builtin openWeight → medium) — v4-flash · v4-pro(0423)', async () => {
  for (const m of ['openrouter/deepseek/deepseek-v4-flash', 'openrouter/deepseek/deepseek-v4-pro']) {
    // 카탈로그에 손 레코드가 나중에 생겨도 깨지지 않게: 레코드가 있으면 그 값, 없으면 폴백 medium.
    expect((await capture(m, hello)).reasoning).toEqual({ effort: openRouterDeepSeekCatalogEffort(m) ?? 'medium' });
  }
});

// ④ reasoning_details 재전송
const DETAILS = [{ type: 'reasoning.text', index: 0, text: 'think', format: 'unknown' }];
const textTurnHistory: LLMMessage[] = [
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: [{ type: 'text', text: 'a1', providerMeta: { reasoningDetails: DETAILS } }] },
  { role: 'user', content: 'q2' },
];

test('④ deepseek: 도구 없는 assistant 턴에도 reasoning_details 를 되돌린다', async () => {
  const body = await capture(FLASH, textTurnHistory);
  const asst = (body.messages as any[]).find((m) => m.role === 'assistant');
  expect(asst.reasoning_details).toEqual(DETAILS);
  expect(asst.content).toEqual([{ type: 'text', text: 'a1' }]);
});

test('④ 대조: GLM 은 같은 history 여도 텍스트 턴에 reasoning_details 를 싣지 않는다(바이트 불변)', async () => {
  const withMeta = await capture(GLM, textTurnHistory);
  const plain = await capture(GLM, [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: [{ type: 'text', text: 'a1' }] }, { role: 'user', content: 'q2' },
  ]);
  expect(JSON.stringify(withMeta)).toBe(JSON.stringify(plain));
});

test('④ 빈 추론 조각은 placeholder 없이 걷는다 — 도구 턴·텍스트 턴 모두', () => {
  const empty = [{ type: 'reasoning.text', index: 0, text: '' }];
  const toolTurn: LLMMessage = { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {}, providerMeta: { reasoningDetails: empty } }] };
  const textTurn: LLMMessage = { role: 'assistant', content: [{ type: 'text', text: 'x', providerMeta: { reasoningDetails: empty } }] };
  for (const m of [toolTurn, textTurn]) {
    const wire = toOpenAIMessages(m, { echoReasoningDetails: true, deepSeekReplay: true });
    expect('reasoning_details' in wire[0]!).toBe(false);
  }
  // 대조: deepSeekReplay 없이(=Kimi·GLM) 도구 턴은 종전대로 받은 그대로 되돌린다.
  expect(toOpenAIMessages(toolTurn, { echoReasoningDetails: true })[0]!.reasoning_details).toEqual(empty);
  expect(nonEmptyReasoningDetails([{ type: 'reasoning.encrypted', data: 'x' }, { type: 'reasoning.text', text: '' }]))
    .toEqual([{ type: 'reasoning.encrypted', data: 'x' }]);
});

const reasoningChunks = [
  { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'th' }] } }] },
  { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'ink' }] } }] },
  { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
];

test('④ 파서: 텍스트만 낸 턴의 추론은 플래그가 있을 때만 끝에 한 번 낸다', async () => {
  const lines = reasoningChunks.map((c) => `data: ${JSON.stringify(c)}`).concat(['data: [DONE]']);
  const on: LLMStreamEvent[] = []; const off: LLMStreamEvent[] = [];
  for await (const ev of parseOpenAISSELines(lines, { flagInvalidToolArgs: true, emitTrailingReasoningDetails: true })) on.push(ev);
  for await (const ev of parseOpenAISSELines(lines, { flagInvalidToolArgs: true })) off.push(ev);
  expect(on.filter((e) => e.type === 'reasoning_details')).toEqual([
    { type: 'reasoning_details', details: [{ type: 'reasoning.text', index: 0, text: 'think' }] },
  ]);
  expect(off.some((e) => e.type === 'reasoning_details')).toBe(false);
});

test('④ 도구 루프: deepseek 최종 텍스트 턴이 추론을 들고 history 로 나가고, 다음 요청에 되돌아간다', async () => {
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async () => sse(reasoningChunks)) as unknown as typeof fetch);
  let turnMessages: LLMMessage[] = [];
  try {
    const provider = getProviderForConfig({ llm: { provider: 'openrouter', model: FLASH, apiKey: 'k' } } as unknown as UserConfig);
    await streamLLMWithTools([{ role: 'user', content: 'go' }],
      { onText() {}, dispatchTool: async () => 'ok', onTurnComplete: (m) => { turnMessages = m; } },
      { provider, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }], maxTurns: 2, model: FLASH });
  } finally {
    mock.mockRestore();
  }
  const last = turnMessages.at(-1)!;
  expect(last.role).toBe('assistant');
  expect(last.content).toEqual([{ type: 'text', text: 'answer', providerMeta: { reasoningDetails: [{ type: 'reasoning.text', index: 0, text: 'think' }] } }]);
  const body = await capture(FLASH, [{ role: 'user', content: 'go' }, last, { role: 'user', content: 'next' }]);
  expect((body.messages as any[]).find((m) => m.role === 'assistant').reasoning_details).toEqual([{ type: 'reasoning.text', index: 0, text: 'think' }]);
});

test('④ 대조: GLM 도구 루프의 최종 텍스트 턴엔 providerMeta 가 없다', async () => {
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async () => sse(reasoningChunks)) as unknown as typeof fetch);
  let turnMessages: LLMMessage[] = [];
  try {
    const provider = getProviderForConfig({ llm: { provider: 'openrouter', model: GLM, apiKey: 'k' } } as unknown as UserConfig);
    await streamLLMWithTools([{ role: 'user', content: 'go' }],
      { onText() {}, dispatchTool: async () => 'ok', onTurnComplete: (m) => { turnMessages = m; } },
      { provider, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }], maxTurns: 2, model: GLM });
  } finally {
    mock.mockRestore();
  }
  expect(turnMessages.at(-1)!.content).toEqual([{ type: 'text', text: 'answer' }]);
});

// ⑤ 도구 스키마
test('⑤ deepseek 도구 스키마는 Kimi sanitizer 를 탄다 · GLM 은 그대로', async () => {
  const tools = [{ name: 'T', description: 'd', parameters: { type: 'object', properties: { a: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] }, r: { $ref: '#/x', description: 'gone' } } } }];
  const ds = await capture(FLASH, hello, { tools });
  expect(ds.tools[0].function.parameters.properties.a.items).toEqual({ type: 'string' });
  expect(ds.tools[0].function.parameters.properties.r).toEqual({ $ref: '#/x' });
  const glm = await capture(GLM, hello, { tools });
  expect(Array.isArray(glm.tools[0].function.parameters.properties.a.items)).toBe(true);
});

// 상류 고정 — 대상 이름은 설정 기본값(DEFAULT_OPENROUTER_UPSTREAM_PINS)에서 온다. 시험은 그 값을 읽어 단언한다(값이 바뀌어도 안 깨진다).
const flashPin = [...DEFAULT_OPENROUTER_UPSTREAM_PINS['deepseek/deepseek-v4.1-flash']!];

test('상류 고정: 설정 기본값이 있는 deepseek 모델은 order=<기본값> · allow_fallbacks=false · GLM 은 그대로', async () => {
  expect(flashPin.length).toBeGreaterThan(0);
  const ds = await capture(FLASH, hello);
  expect(ds.provider).toEqual({ require_parameters: true, allow_fallbacks: false, order: flashPin });
  const glm = await capture(GLM, hello);
  expect(glm.provider).toEqual({ require_parameters: true, allow_fallbacks: true });
});

test('상류 고정: 기본값 표에 없는 deepseek 모델은 고정하지 않는다(OR 기본 라우팅) · 공식 deepseek 고정 기본값은 없다', async () => {
  const ds = await capture('openrouter/deepseek/deepseek-v4-flash', hello);
  expect(ds.provider).toEqual({ require_parameters: true, allow_fallbacks: true });
  for (const order of Object.values(DEFAULT_OPENROUTER_UPSTREAM_PINS)) expect(order).not.toContain('deepseek');
});

test('상류 고정: 사용자 upstreamPins 가 모델별로 덮는다 · [] 면 고정 안 함', async () => {
  const over = await capture(FLASH, hello, {}, { openrouter: { upstreamPins: { 'deepseek/deepseek-v4.1-flash': ['x-host'] } } });
  expect(over.provider).toEqual({ require_parameters: true, allow_fallbacks: false, order: ['x-host'] });
  const off = await capture(FLASH, hello, {}, { openrouter: { upstreamPins: { 'deepseek/deepseek-v4.1-flash': [] } } });
  expect(off.provider).toEqual({ require_parameters: true, allow_fallbacks: true });
  expect(resolveOpenRouterUpstreamPin('deepseek/a', { 'deepseek/a': ['h1', 7, ''] }, {})).toEqual(['h1']);
  expect(resolveOpenRouterUpstreamPin('deepseek/a', undefined, { 'deepseek/a': ['d'] })).toEqual(['d']);
  expect(resolveOpenRouterUpstreamPin('deepseek/a', { 'deepseek/a': 'h1' }, { 'deepseek/a': ['d'] })).toBeUndefined();
});

test('상류 고정: 사용자가 라우팅을 명시했으면 손대지 않는다', async () => {
  const prefs = { order: ['fireworks'] };
  const ds = await capture(FLASH, hello, {}, { openrouter: { providerPreferences: prefs } });
  expect(ds.provider).toEqual({ require_parameters: true, allow_fallbacks: true, order: ['fireworks'] });
  expect(openRouterDeepSeekProviderField('deepseek/a', {}, { allow_fallbacks: true }, undefined, { 'deepseek/a': ['d'] })).toEqual({});
  expect(openRouterDeepSeekProviderField('z-ai/glm-5.1', {}, undefined, { 'z-ai/glm-5.1': ['d'] }, { 'z-ai/glm-5.1': ['d'] })).toEqual({});
  // 라우팅과 무관한 명시(예: data_collection)는 고정을 막지 않는다.
  const dc = await capture(FLASH, hello, {}, { openrouter: { providerPreferences: { data_collection: 'deny' } } });
  expect(dc.provider).toEqual({ require_parameters: true, allow_fallbacks: false, data_collection: 'deny', order: flashPin });
});

// ⑥ 관측
test('⑥ 관측 llm.openrouter deepseek-replay — deepseek 요청만 한 줄', async () => {
  const logs: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
  try {
    await capture(FLASH, textTurnHistory);
    await capture(GLM, textTurnHistory);
  } finally {
    log.mockRestore();
  }
  const hits = logs.filter((l) => l.category === 'llm.openrouter' && l.event === 'deepseek-replay');
  expect(hits.length).toBe(1);
  expect(hits[0]!.data).toEqual({
    model: 'deepseek/deepseek-v4.1-flash', assistantTurns: 1, withReasoning: 1, toolTurns: 0, textTurnsWithReasoning: 1, upstreamPin: flashPin,
  });
  expect(summarizeDeepSeekReplay([{ role: 'assistant', tool_calls: [{}], reasoning_details: [{}] }]))
    .toEqual({ assistantTurns: 1, withReasoning: 1, toolTurns: 1, textTurnsWithReasoning: 0 });
});

test('설정: llm.openrouter.upstreamPins 가 읽힌다 · 문자열 배열이 아닌 칸은 버린다', () => {
  const root = mkdtempSync(join(tmpdir(), 'or-upstream-pins-'));
  try {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ llm: { provider: 'openai-codex', openrouter: {
      upstreamPins: { 'deepseek/deepseek-v4.1-flash': ['x-host'], 'deepseek/bad': 'nope', 'deepseek/off': [] },
    } } }));
    expect(buildUserConfig(path).llm.openrouter).toEqual({ upstreamPins: { 'deepseek/deepseek-v4.1-flash': ['x-host'], 'deepseek/off': [] } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
