import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anyProviderAvailable, getProvider, getProviderForConfig, streamLLM, streamLLMWithTools } from '../llm.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../llm.js';
import type { UserConfig } from '../user-config/types.js';
import { _resetKeyCacheForTests } from '../config.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { deviceFidelityStatus } from './device-fidelity.js';
import * as grokCredential from '../grok/credential.js';
import {
  TEST_FAKE_LLM_400_MESSAGE, TEST_FAKE_LLM_CAPTURE_ENV, TEST_FAKE_LLM_CHUNK_SIZE_ENV, TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV,
  createSimLlmRouter, parseSimWorldLlmConfig, resetTestFakeLlmScript, simOutboundAllowed, testFakeLlmEnabled, testFakeLlmProvider,
} from './fake-llm.js';
import { matchFailureText } from '../self-health/signatures.js';
import { assembleWorld, parseSimWorld, runInWorld, runSimWorldLlmNode } from './world.js';

const names = [
  'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_TEST_FAKE_LLM_RESPONSE', 'ELANOUS_TEST_FAKE_LLM_CHUNK_SIZE', 'ELANOUS_TEST_FAKE_LLM_SCRIPT', 'ELANOUS_TEST_FAKE_LLM_CAPTURE',
  'ELANOUS_TEST_FAKE_LLM_TOOL_CALL', 'ELANOUS_TEST_FAKE_LLM_DELAY_MS', 'ELANOUS_TEST_FAKE_LLM_DELAY_WHEN',
  'ELANOUS_LLM_MODE', 'NODE_ENV', 'ELANOUS_STATE_DIR', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE',
  'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'LOCAL_LLM_URL',
  'HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_KEY_CACHE_DIR',
] as const;
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const dirs: string[] = [];
const originalTestStateRoot = getTestStateRoot();

afterEach(() => {
  setTestStateRoot(originalTestStateRoot ?? null);
  spyOn(grokCredential, 'resolveGrokCredential').mockRestore();
  _resetKeyCacheForTests();
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function keyless(): void {
  for (const name of names) if (name.endsWith('_API_KEY') || name === 'LOCAL_LLM_URL') delete process.env[name];
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-'));
  dirs.push(dir);
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.CODEX_HOME = join(dir, 'codex');
  process.env.ELANOUS_KEY_CACHE_DIR = dir;
  _resetKeyCacheForTests();
  spyOn(grokCredential, 'resolveGrokCredential').mockImplementation((() => null) as typeof grokCredential.resolveGrokCredential);
}

test('test execution defaults to a fixed fake stream without network access; real override disables it', async () => {
  delete process.env.ELANOUS_TEST_FAKE_LLM;
  process.env.NODE_ENV = 'test';
  delete process.env.ELANOUS_LLM_MODE;
  expect(testFakeLlmEnabled()).toBe(false);
  expect(testFakeLlmProvider.available()).toBe(true);
  const messages = [{ role: 'user' as const, content: 'a secret prompt' }];
  const first = await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  const second = await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  expect(first).toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
  expect(second).toEqual(first);
  expect((await Array.fromAsync(testFakeLlmProvider.chat(messages))).join('')).toBe('[test-fake-llm] OK');
  process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = '{"ok":true}';
  expect(await Array.fromAsync(testFakeLlmProvider.chat(messages))).toEqual(['{"ok":true}']);
  process.env.ELANOUS_LLM_MODE = 'real';
  expect(testFakeLlmProvider.available()).toBe(false);
});

test('{reply} advances for each emitted fake response even when turn history has the same user count', async () => {
  resetTestFakeLlmScript();
  process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = 'step {reply}';
  const messages = [{ role: 'user' as const, content: 'continue' }];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(messages))).toEqual([{ type: 'text', delta: 'step 1' }]);
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(messages))).toEqual([{ type: 'text', delta: 'step 2' }]);
  resetTestFakeLlmScript();
});

test('capture env appends each request (role · string content) as one JSONL row — off when unset', async () => {
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-capture-'));
  dirs.push(dir);
  const path = join(dir, 'requests.jsonl');
  const messages = [{ role: 'system' as const, content: 'preamble 줄' }, { role: 'user' as const, content: '안녕' }];
  delete process.env[TEST_FAKE_LLM_CAPTURE_ENV];
  await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  expect(existsSync(path)).toBe(false);
  process.env[TEST_FAKE_LLM_CAPTURE_ENV] = path;
  await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  await Array.fromAsync(testFakeLlmProvider.chat(messages));
  const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(rows).toEqual([
    { messages: [{ role: 'system', content: 'preamble 줄' }, { role: 'user', content: '안녕' }] },
    { messages: [{ role: 'system', content: 'preamble 줄' }, { role: 'user', content: '안녕' }] },
  ]);
});

test('keyless auto routing follows explicit real/fake overrides', () => {
  keyless();
  const config = { llm: { provider: 'auto' } } as UserConfig;
  process.env.NODE_ENV = 'production';
  delete process.env.ELANOUS_TEST_FAKE_LLM;
  process.env.ELANOUS_LLM_MODE = 'real';
  expect(() => getProviderForConfig(config)).toThrow('No LLM provider available');
  expect(() => getProvider()).toThrow('No LLM provider available');
  process.env.ELANOUS_LLM_MODE = 'fake';
  expect(getProviderForConfig(config).name).toBe('test-fake-llm');
  expect(getProvider().name).toBe('test-fake-llm');
});

test('streamLLM calls the selected fake provider boundary with Unicode-safe deltas and injected errors, without fetch', async () => {
  keyless();
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = '가🙂나다';
  process.env[TEST_FAKE_LLM_CHUNK_SIZE_ENV] = '2';
  resetTestFakeLlmScript();
  const provider = getProviderForConfig({ llm: { provider: 'auto' } } as UserConfig);
  const fetchSpy = spyOn(globalThis, 'fetch');
  try {
    const chunks: string[] = [];
    const result = await streamLLM([{ role: 'user', content: 'boundary check' }], (delta) => chunks.push(delta), { provider });
    expect(provider.name).toBe('test-fake-llm');
    expect(chunks).toEqual(['가🙂', '나다']);
    expect(result).toBe('가🙂나다');
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.ELANOUS_TEST_FAKE_LLM_SCRIPT = '400';
    resetTestFakeLlmScript();
    const errorChunks: string[] = [];
    await expect(streamLLM([{ role: 'user', content: 'inject error' }], (delta) => errorChunks.push(delta), { provider }))
      .rejects.toThrow(TEST_FAKE_LLM_400_MESSAGE);
    expect(errorChunks).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    resetTestFakeLlmScript();
  }
});

test('explicit real override keeps configured providers ahead of fake; fake override wins both', () => {
  keyless();
  process.env.NODE_ENV = 'test';
  process.env.ELANOUS_LLM_MODE = 'real';
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env.OPENROUTER_API_KEY = 'test-only-key';
  const auto = { llm: { provider: 'auto' } } as UserConfig;
  expect(getProviderForConfig(auto).name).toBe('openrouter');
  delete process.env.OPENROUTER_API_KEY;
  _resetKeyCacheForTests();
  const explicit = { llm: { provider: 'openai', apiKey: 'test-only-key' } } as UserConfig;
  expect(getProviderForConfig(explicit).name).toBe('openai');
  const loopback = { llm: { provider: 'local', baseUrl: 'http://127.0.0.1:43210/v1' } } as UserConfig;
  expect(getProviderForConfig(loopback).name).toBe('local');
  process.env.ELANOUS_LLM_MODE = 'fake';
  expect(getProviderForConfig(auto).name).toBe('test-fake-llm');
});

test('test execution defaults to fake before credentials, while --test state stays real', async () => {
  keyless();
  const auto = { llm: { provider: 'auto' } } as UserConfig;
  process.env.NODE_ENV = 'test';
  delete process.env.ELANOUS_LLM_MODE;
  delete process.env.ELANOUS_TEST_FAKE_LLM;
  process.env.OPENROUTER_API_KEY = 'test-only-key';
  const fetchSpy = spyOn(globalThis, 'fetch');
  try {
    const fake = getProviderForConfig(auto);
    expect(fake.name).toBe('test-fake-llm');
    expect(await streamLLM([{ role: 'user', content: 'simulation fixture' }], () => {}, { provider: fake })).toBe('[test-fake-llm] OK');
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.NODE_ENV = 'test';
    process.env.ELANOUS_STATE_DIR = '/tmp/isolated-test-state';
    delete process.env.ELANOUS_TEST_FAKE_LLM;
    process.env.ELANOUS_LLM_MODE = 'real';
    expect(getProviderForConfig({ llm: { provider: 'openrouter', apiKey: 'test-only-key' } } as UserConfig).name).toBe('openrouter');
  } finally { fetchSpy.mockRestore(); }
});

test('simulated world defaults to fake with credentials and records zero network attempts', async () => {
  keyless();
  process.env.NODE_ENV = 'production';
  delete process.env.ELANOUS_LLM_MODE;
  delete process.env.ELANOUS_TEST_FAKE_LLM;
  process.env.OPENROUTER_API_KEY = 'test-only-key';
  const root = mkdtempSync(join(tmpdir(), 'fake-llm-sim-world-'));
  dirs.push(root);
  const spec = {
    world: 'fake-llm-provider-default', seed: 1, devices: ['fake-llm'], events: [],
    llm: parseSimWorldLlmConfig({ mode: 'auto', outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 } }), // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  };
  const sim = { id: 'fake-llm-provider-default', root, spec, networkEvents: [] };
  const fetchSpy = spyOn(globalThis, 'fetch');
  try {
    await runInWorld(sim, async () => {
      const world = assembleWorld({ root, spec });
      expect(await runSimWorldLlmNode(world, 'summary', [{ role: 'user', content: 'simulated provider selection' }]))
        .toBe('[test-fake-llm] OK');
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sim.networkEvents).toEqual([]);
  } finally { fetchSpy.mockRestore(); }
});

test('explicit --fake-llm replaces a real provider passed to the tool-loop boundary', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ELANOUS_LLM_MODE = 'fake';
  let realProviderCalls = 0;
  const provider: LLMProvider = {
    name: 'openrouter', defaultModel: 'real-model', available: () => true,
    async *chat() { yield 'real response'; },
    async *streamChat() { realProviderCalls += 1; yield { type: 'text', delta: 'real response' }; },
  };
  const result = await streamLLMWithTools([{ role: 'user', content: 'force fake' }], {
    onText() {}, dispatchTool: async () => 'unused',
  }, { provider, tools: [{ name: 'unused', description: 'unused', parameters: { type: 'object', properties: {} } }] });
  expect(result).toBe('[test-fake-llm] OK');
  expect(realProviderCalls).toBe(0);
});

test('sim default replaces injected real providers at both streaming boundaries', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.ELANOUS_LLM_MODE;
  let realProviderCalls = 0;
  const provider: LLMProvider = {
    name: 'openrouter', defaultModel: 'real-model', available: () => true,
    async *chat() { realProviderCalls += 1; yield 'real response'; },
    async *streamChat() { realProviderCalls += 1; yield { type: 'text', delta: 'real response' }; },
  };
  const root = mkdtempSync(join(tmpdir(), 'fake-llm-default-world-'));
  dirs.push(root);
  const sim = { id: 'fake-llm-default-world', root,
    spec: { world: 'fake-llm-default-world', seed: 1, devices: [], events: [] }, networkEvents: [] };
  await runInWorld(sim, async () => {
    expect(await streamLLM([{ role: 'user', content: 'sim default' }], () => {}, { provider })).toBe('[test-fake-llm] OK');
    expect(await streamLLMWithTools([{ role: 'user', content: 'sim default' }], {
      onText() {}, dispatchTool: async () => 'unused',
    }, { provider, tools: [{ name: 'unused', description: 'unused', parameters: { type: 'object', properties: {} } }] }))
      .toBe('[test-fake-llm] OK');
  });
  expect(realProviderCalls).toBe(0);
});

test('결함 스크립트: 400 칸은 «대화 기록 어긋남» 400 을 던지고(자동 회복 지문이 문다) 끝나면 ok', async () => {
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env.ELANOUS_TEST_FAKE_LLM_SCRIPT = '400,ok';
  resetTestFakeLlmScript();
  const messages = [{ role: 'user' as const, content: 'x' }];
  await expect(Array.fromAsync(testFakeLlmProvider.streamChat!(messages))).rejects.toThrow(TEST_FAKE_LLM_400_MESSAGE);
  expect(matchFailureText(TEST_FAKE_LLM_400_MESSAGE)?.autoheal).toBe('new-session-then-provider');
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(messages))).toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
  expect((await Array.fromAsync(testFakeLlmProvider.chat(messages))).join('')).toBe('[test-fake-llm] OK');
  resetTestFakeLlmScript();
});

test('결함 스크립트 커서는 스크립트 문자열이 바뀌면 처음부터 센다', async () => {
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  const messages = [{ role: 'user' as const, content: 'x' }];
  process.env.ELANOUS_TEST_FAKE_LLM_SCRIPT = 'ok,400';
  await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  process.env.ELANOUS_TEST_FAKE_LLM_SCRIPT = '400';
  await expect(Array.fromAsync(testFakeLlmProvider.streamChat!(messages))).rejects.toThrow(TEST_FAKE_LLM_400_MESSAGE);
  resetTestFakeLlmScript();
});

test('키 없는 auto 가용성: 명시 시험 env 면 참 — auto 해석(fake)과 같은 답', () => {
  keyless();
  const auto = { llm: { provider: 'auto' } } as UserConfig;
  // ⚠️ env 가 꺼진 쪽은 단언하지 않는다 — 호스트 자격(구독 파일 등)에 따라 키 없이도 참일 수 있다(이 PR 이 안 바꾼 축).
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  // gate 전역 스위치만으로는 가용성이 바뀌지 않는다(«아무것도 없으면 false» 계약 보존) — 라이브 무대 명시 표지가 있어야 참.
  delete process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER;
  expect(getProviderForConfig(auto).name).toBe('test-fake-llm');
  process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER = '1';
  expect(anyProviderAvailable(auto)).toBe(true);
  delete process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER;
  expect(getProviderForConfig(auto).name).toBe('test-fake-llm');
});

test('도구 호출 스크립트: 표지 있는 사람 발화엔 도구 호출 하나 · 도구 결과 뒤·표지 없는 발화엔 고정 응답', async () => {
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env[TEST_FAKE_LLM_TOOL_CALL_ENV] = JSON.stringify({ when: '예약해줘', name: 'ScheduleWakeup', args: { delaySeconds: 60, reason: '점검' } });
  const asked = [{ role: 'user' as const, content: '60초 뒤 예약해줘' }];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(asked))).toEqual([
    { type: 'tool_call', id: 'call_fake_llm_tool_1', name: 'ScheduleWakeup', args: { delaySeconds: 60, reason: '점검' } },
  ]);
  const answered = [
    ...asked,
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_fake_llm_tool_1', name: 'ScheduleWakeup', input: {} }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'call_fake_llm_tool_1', content: '{}' }] },
  ];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(answered))).toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!([{ role: 'user' as const, content: '[예약 깨움 w1] 점검' }])))
    .toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
  // 틀린 JSON 은 스크립트가 없는 것과 같다(시험 무대가 공급자를 깨지 않는다).
  process.env[TEST_FAKE_LLM_TOOL_CALL_ENV] = '{';
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(asked))).toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
});

test('도구 호출 시퀀스: 한 사람 발화의 연속 tool 결과마다 다음 호출을 내고 끝나면 고정 응답', async () => {
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env[TEST_FAKE_LLM_TOOL_CALL_ENV] = JSON.stringify({ when: '세 자식', calls: [
    { name: 'Agent', args: { description: 'child 1' } },
    { name: 'Agent', args: { description: 'child 2' } },
    { name: 'Agent', args: { description: 'child 3' } },
  ] });
  const asked = [{ role: 'user' as const, content: '세 자식으로 조사해줘' }];
  const first = await Array.fromAsync(testFakeLlmProvider.streamChat!(asked));
  expect(first).toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 1' } }]);
  const firstId = (first[0] as Extract<LLMStreamEvent, { type: 'tool_call' }>).id;
  const afterResult = (prior: typeof asked, id: string) => [
    ...prior,
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id, name: 'Agent', input: {} }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: id, content: '{}' }] },
  ];
  const afterFirst = afterResult(asked, firstId);
  const second = await Array.fromAsync(testFakeLlmProvider.streamChat!(afterFirst as never));
  expect(second)
    .toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 2' } }]);
  const secondId = (second[0] as Extract<LLMStreamEvent, { type: 'tool_call' }>).id;
  const afterSecond = afterResult(afterFirst as typeof asked, secondId);
  const third = await Array.fromAsync(testFakeLlmProvider.streamChat!(afterSecond as never));
  expect(third)
    .toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 3' } }]);
  const thirdId = (third[0] as Extract<LLMStreamEvent, { type: 'tool_call' }>).id;
  const afterThird = afterResult(afterSecond as typeof asked, thirdId);
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(afterThird as never)))
    .toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);

  const pendingFirst = await Array.fromAsync(testFakeLlmProvider.streamChat!(asked));
  const pendingFirstId = (pendingFirst[0] as Extract<LLMStreamEvent, { type: 'tool_call' }>).id;
  const pendingHistory = [
    ...asked,
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: pendingFirstId, name: 'Agent', input: { description: 'child 1' } }] },
  ];
  const retriedFirst = await Array.fromAsync(testFakeLlmProvider.streamChat!(pendingHistory as never));
  const retriedFirstId = (retriedFirst[0] as Extract<LLMStreamEvent, { type: 'tool_call' }>).id;
  const duplicateFirstSuccesses = [
    ...asked,
    { role: 'assistant' as const, content: [
      { type: 'tool_use' as const, id: pendingFirstId, name: 'Agent', input: { description: 'child 1' } },
      { type: 'tool_use' as const, id: retriedFirstId, name: 'Agent', input: { description: 'child 1' } },
    ] },
    { role: 'user' as const, content: [
      { type: 'tool_result' as const, tool_use_id: pendingFirstId, content: '{}' },
      { type: 'tool_result' as const, tool_use_id: retriedFirstId, content: '{}' },
    ] },
  ];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(duplicateFirstSuccesses as never)))
    .toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 2' } }]);

  const outOfOrderStages = [
    ...asked,
    { role: 'assistant' as const, content: [
      { type: 'tool_use' as const, id: firstId, name: 'Agent', input: { description: 'child 1' } },
      { type: 'tool_use' as const, id: secondId, name: 'Agent', input: { description: 'child 2' } },
    ] },
    { role: 'user' as const, content: [
      { type: 'tool_result' as const, tool_use_id: secondId, content: '{}' },
      { type: 'tool_result' as const, tool_use_id: firstId, content: '{}' },
    ] },
  ];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(outOfOrderStages as never)))
    .toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 2' } }]);

  const orphanedCall = [
    ...asked,
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_fake_llm_tool_pending', name: 'Agent', input: {} }] },
  ];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(orphanedCall as never)))
    .toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 1' } }]);
  const failedCall = [
    ...orphanedCall,
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'call_fake_llm_tool_pending', content: 'failed', isError: true }] },
  ];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(failedCall as never)))
    .toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 1' } }]);
  const unrelatedSameName = [
    ...asked,
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'unrelated-call', name: 'Agent', input: {} }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'unrelated-call', content: 'done' }] },
  ];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(unrelatedSameName as never)))
    .toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 1' } }]);
  const mismatchedResult = [
    ...asked,
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_fake_llm_tool_unmatched', name: 'Agent', input: {} }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'another-call', content: 'done' }] },
  ];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(mismatchedResult as never)))
    .toMatchObject([{ type: 'tool_call', name: 'Agent', args: { description: 'child 1' } }]);
  const newHumanPrompt = [...failedCall, { role: 'user' as const, content: '다른 질문' }];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(newHumanPrompt as never)))
    .toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
});

test('도구 호출 시퀀스는 이전 성공 결과의 taskId 표지를 다음 호출 인자로 연결한다', async () => {
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env[TEST_FAKE_LLM_TOOL_CALL_ENV] = JSON.stringify({ when: 'background child', calls: [
    { name: 'Agent', args: { run_in_background: true } },
    { name: 'AgentOutput', args: { taskId: '$previousToolResult.taskId', block: true } },
  ] });
  const asked = [{ role: 'user' as const, content: 'background child 확인' }];
  const first = await Array.fromAsync(testFakeLlmProvider.streamChat!(asked));
  const firstId = (first[0] as Extract<LLMStreamEvent, { type: 'tool_call' }>).id;
  const next = await Array.fromAsync(testFakeLlmProvider.streamChat!([
    ...asked,
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: firstId, name: 'Agent', input: {} }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: firstId, content: JSON.stringify({ taskId: 'task-from-agent' }) }] },
  ] as never));
  expect(next).toMatchObject([{ type: 'tool_call', name: 'AgentOutput', args: { taskId: 'task-from-agent', block: true } }]);
});

test('지연: 표지 있는 마지막 사람 발화만 그만큼 늦게 답한다(«바쁜 턴» 무대)', async () => {
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env[TEST_FAKE_LLM_DELAY_MS_ENV] = '300';
  process.env[TEST_FAKE_LLM_DELAY_WHEN_ENV] = '긴 작업';
  let t = performance.now();
  await Array.fromAsync(testFakeLlmProvider.streamChat!([{ role: 'user' as const, content: '짧은 질문' }]));
  expect(performance.now() - t).toBeLessThan(200);
  t = performance.now();
  await Array.fromAsync(testFakeLlmProvider.streamChat!([{ role: 'user' as const, content: '긴 작업 하나' }]));
  expect(performance.now() - t).toBeGreaterThanOrEqual(280);
  delete process.env[TEST_FAKE_LLM_DELAY_WHEN_ENV];
  t = performance.now();
  await Array.fromAsync(testFakeLlmProvider.streamChat!([{ role: 'user' as const, content: '짧은 질문' }]));
  expect(performance.now() - t).toBeGreaterThanOrEqual(280);
});

test('{step} in the response becomes the user-message count — a different reply per turn of one conversation', async () => {
  process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = '{step}단계 — 아직 못 했습니다.';
  const one = [{ role: 'user' as const, content: '영상 만들어줘' }];
  const three = [...one, { role: 'assistant' as const, content: 'x' }, { role: 'user' as const, content: '[골 이어가기] …' }, { role: 'assistant' as const, content: 'y' }, { role: 'user' as const, content: '[골 이어가기] …' }];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(one))).toEqual([{ type: 'text', delta: '1단계 — 아직 못 했습니다.' }]);
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(three))).toEqual([{ type: 'text', delta: '3단계 — 아직 못 했습니다.' }]);
  const withToolResult = [...one, { role: 'assistant' as const, content: 'z' }, { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'ok' }] }];
  expect(await Array.fromAsync(testFakeLlmProvider.streamChat!(withToolResult as never))).toEqual([{ type: 'text', delta: '1단계 — 아직 못 했습니다.' }]);
});

function providerReturning(events: LLMStreamEvent[], calls: string[] = []): LLMProvider {
  return {
    name: 'shared-test-provider', defaultModel: 'shared-test-model', available: () => true,
    async *chat() { calls.push('chat'); for (const event of events) if (event.type === 'text') yield event.delta; },
    async *streamChat() { calls.push('streamChat'); yield* events; },
  };
}

test('auto records a miss through the injected shared fake provider, then replays the cassette without a second call', async () => {
  const calls: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch');
  try {
    const router = createSimLlmRouter({ mode: 'auto', sharedCredentialProvider: providerReturning([
      { type: 'text', delta: 'auto fixture answer' },
    ], calls), outboundAllowlist: ['llm'], budget: { maxCalls: 2, maxWallMs: 10_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
    });
    const provider = router.forNode('summary');
    const request = [{ role: 'user' as const, content: 'fixture prompt' }];
    expect(await Array.fromAsync(provider.streamChat!(request))).toEqual([{ type: 'text', delta: 'auto fixture answer' }]);
    expect(router.recordings.size).toBe(1);
    expect(await Array.fromAsync(provider.streamChat!(request))).toEqual([{ type: 'text', delta: 'auto fixture answer' }]);
    expect(calls).toEqual(['streamChat']);
    expect(router.budgetSnapshot().calls).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

test('world mode and per-node override select fake, replay, or real; replay misses fail closed', async () => {
  const cassettes = new Map<string, readonly LLMStreamEvent[]>();
  const router = createSimLlmRouter({ mode: 'replay', nodeModes: { planner: 'fake', responder: 'auto' },
    recordings: cassettes, sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'recorded response' }]),
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
    fakeProvider: providerReturning([{ type: 'text', delta: 'fake response' }]) });
  const request = [{ role: 'user' as const, content: 'same request' }];
  expect(await Array.fromAsync(router.forNode('planner').chat(request))).toEqual(['fake response']);
  expect(await Array.fromAsync(router.forNode('responder').chat(request))).toEqual(['recorded response']);
  expect(cassettes.size).toBe(1);
  await expect(Array.fromAsync(router.forNode('unrecorded').chat(request))).rejects.toThrow('cassette miss');
  expect(router.budgetSnapshot().calls).toBe(1);
});

test('real calls require the LLM-only egress exception and enforce the shared run call budget', async () => {
  const calls: string[] = [];
  const shared = providerReturning([{ type: 'text', delta: 'approved fixture' }], calls);
  expect(simOutboundAllowed('llm', ['llm'])).toBe(true);
  for (const boundary of ['github', 'shell', 'network']) expect(simOutboundAllowed(boundary, ['llm'])).toBe(false);
  const blocked = createSimLlmRouter({ mode: 'real', sharedCredentialProvider: shared,
    outboundAllowlist: ['github'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  await expect(Array.fromAsync(blocked.forNode('node-a').chat([{ role: 'user', content: 'x' }]))).rejects.toThrow('outbound blocked');
  expect(calls).toEqual([]);

  const allowed = createSimLlmRouter({ mode: 'real', sharedCredentialProvider: shared,
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  const request = [{ role: 'user' as const, content: 'x' }];
  expect(await Array.fromAsync(allowed.forNode('node-a').chat(request))).toEqual(['approved fixture']);
  await expect(Array.fromAsync(allowed.forNode('node-b').chat(request))).rejects.toThrow('call budget exceeded');
  expect(calls).toEqual(['streamChat']);
  expect(allowed.budgetSnapshot().calls).toBe(1);
});

test('recordings hash requests and redact credential-shaped response content', async () => {
  const router = createSimLlmRouter({ mode: 'auto', sharedCredentialProvider: providerReturning([
    { type: 'text', delta: 'Bearer abcdefghijklmnop and sk-abcdefghijklmnop' },
  ]), outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  const request = [{ role: 'user' as const, content: 'private prompt phrase' }];
  await Array.fromAsync(router.forNode('writer').chat(request));
  const cassette = JSON.stringify([...router.recordings]);
  expect(cassette).not.toContain('private prompt phrase');
  expect(cassette).not.toContain('abcdefghijklmnop');
  expect(cassette).toContain('[REDACTED]');
});

test('auto persists its recording and a fresh world replays it without credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-cassette-'));
  dirs.push(dir);
  const recordingFile = join(dir, 'llm-cassette.json');
  const calls: string[] = [];
  const request = [{ role: 'user' as const, content: 'persistent fixture prompt' }];
  const recordWorld = createSimLlmRouter({ mode: 'auto', recordingFile,
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'persistent fixture answer' }], calls),
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  await Array.fromAsync(recordWorld.forNode('summary').chat(request));
  expect(recordWorld.recordingIds.size).toBe(0);
  const replayWorld = createSimLlmRouter({ mode: 'auto', recordingFile });
  expect(await Array.fromAsync(replayWorld.forNode('summary').chat(request))).toEqual(['persistent fixture answer']);
  expect(calls).toEqual(['streamChat']);
  expect(replayWorld.recordingIds.size).toBe(1);
  const entry = JSON.parse(readFileSync(join(`${recordingFile}.records`, `${[...replayWorld.recordings.keys()][0]}.json`), 'utf8')) as Record<string, unknown>;
  expect(entry.provenance).toEqual({ source: 'replay' });
  expect(typeof entry.expiresAt).toBe('string');
});

test('expired cassette refuses replay and auto records a fresh response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-expiry-'));
  dirs.push(dir);
  const recordingFile = join(dir, 'llm-cassette.json');
  const request = [{ role: 'user' as const, content: 'expiry fixture' }];
  const start = new Date('2026-11-10T00:00:00.000Z');
  const first = createSimLlmRouter({ mode: 'auto', recordingFile, wallNow: () => start, recordingTtlMs: 24 * 60 * 60 * 1000, // Source: cassette expiry test seam (custom one-day TTL).
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'first' }]), outboundAllowlist: ['llm'],
    budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  await Array.fromAsync(first.forNode('node').chat(request));
  const expiredNow = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000); // Source: cassette expiry test seam (custom one-day TTL).
  const replay = createSimLlmRouter({ mode: 'replay', recordingFile, wallNow: () => expiredNow, recordingTtlMs: 24 * 60 * 60 * 1000 }); // Source: cassette expiry test seam (custom one-day TTL).
  await expect(Array.fromAsync(replay.forNode('node').chat(request))).rejects.toThrow('expired');
  const refreshed = createSimLlmRouter({ mode: 'auto', recordingFile, wallNow: () => expiredNow, recordingTtlMs: 24 * 60 * 60 * 1000,
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'renewed' }]), outboundAllowlist: ['llm'],
    budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  expect(await Array.fromAsync(refreshed.forNode('node').chat(request))).toEqual(['renewed']);
});

test('invalid v3 expiry metadata fails closed instead of replaying forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-invalid-expiry-'));
  dirs.push(dir);
  const recordingFile = join(dir, 'llm-cassette.json');
  const request = [{ role: 'user' as const, content: 'invalid expiry fixture' }];
  const writer = createSimLlmRouter({ mode: 'auto', recordingFile,
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'saved' }]), outboundAllowlist: ['llm'],
    budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  await Array.fromAsync(writer.forNode('node').chat(request));
  const key = [...writer.recordings.keys()][0]!;
  const entryPath = join(`${recordingFile}.records`, `${key}.json`);
  const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as Record<string, unknown>;
  entry.expiresAt = 'not-a-date';
  writeFileSync(entryPath, JSON.stringify(entry));
  expect(() => createSimLlmRouter({ mode: 'replay', recordingFile })).toThrow('invalid expiry or provenance');
});

test('real mode compares an expired cassette but does not attach the real response to its receipt', async () => {
  const previousRoot = getTestStateRoot();
  const root = mkdtempSync(join(tmpdir(), 'fake-llm-expired-real-'));
  dirs.push(root);
  setTestStateRoot(root);
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-expired-real-cassette-'));
  dirs.push(dir);
  const recordingFile = join(dir, 'llm-cassette.json');
  const request = [{ role: 'user' as const, content: 'expired real comparison' }];
  const recordedAt = new Date('2026-11-10T00:00:00.000Z');
  const recorder = createSimLlmRouter({ mode: 'auto', recordingFile, wallNow: () => recordedAt, recordingTtlMs: 24 * 60 * 60 * 1000, // Source: cassette expiry test seam (custom one-day TTL).
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'old answer' }]), outboundAllowlist: ['llm'],
    budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  await Array.fromAsync(recorder.forNode('node').chat(request));
  const entryPath = join(`${recordingFile}.records`, `${[...recorder.recordings.keys()][0]}.json`);
  const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as { recordingId: string };
  const comparator = createSimLlmRouter({ mode: 'real', recordingFile, wallNow: () => new Date(recordedAt.getTime() + 2 * 24 * 60 * 60 * 1000), // Source: cassette expiry test seam (expired by one day).
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'new answer' }]), outboundAllowlist: ['llm'],
    budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  expect(await Array.fromAsync(comparator.forNode('node').chat(request))).toEqual(['new answer']);
  expect(comparator.recordingIds.size).toBe(0);
  expect(deviceFidelityStatus('fake-llm', [entry.recordingId]).verdict).toBe('yellow');
  setTestStateRoot(previousRoot ?? null);
});

test('world LLM device adapter applies node overrides and persists auto recordings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-world-'));
  dirs.push(dir);
  // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  const config = parseSimWorldLlmConfig({ mode: 'auto', nodes: { summary: 'auto', classifier: 'replay' },
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 } }); // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  expect(config.nodeModes).toEqual({ summary: 'auto', classifier: 'replay' });
  const calls: string[] = [];
  const spec = { world: 'hybrid-llm', seed: 7, devices: ['fake-llm'], events: [], llm: config };
  const options = { sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'world fixture answer' }], calls) };
  const firstWorld = assembleWorld({ spec, root: dir, llmRuntime: options });
  const request = [{ role: 'user' as const, content: 'world integration fixture' }];
  expect(await runSimWorldLlmNode(firstWorld, 'summary', request)).toBe('world fixture answer');
  expect(existsSync(join(dir, 'llm-cassette.json'))).toBe(true);
  const replayWorld = assembleWorld({ spec, root: dir, llmRuntime: options });
  expect(await runSimWorldLlmNode(replayWorld, 'summary', request)).toBe('world fixture answer');
  expect(calls).toEqual(['streamChat']);
  await expect(runSimWorldLlmNode(replayWorld, 'classifier', request)).rejects.toThrow('cassette miss');
});

test('parsed world fake-llm response uses the configured node router', async () => {
  const spec = parseSimWorld(`
world: parsed-llm-world
seed: 1
devices: [fake-llm]
llm:
  mode: fake
  nodes: { summary: replay }
events: []
`);
  const device = assembleWorld({ spec }).devices.get('fake-llm') as {
    response(nodeId?: string, messages?: LLMMessage[]): Promise<string>;
  };
  const response = await device.response('constructor', [{ role: 'user', content: 'yaml path' }]);
  expect(response).toContain('test-fake-llm');
});

test('independent auto routers merge cassette writes before a fresh replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-shared-cassette-'));
  dirs.push(dir);
  const recordingFile = join(dir, 'llm-cassette.json');
  const first = createSimLlmRouter({ mode: 'auto', recordingFile,
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'first recording' }]),
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  const second = createSimLlmRouter({ mode: 'auto', recordingFile,
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'second recording' }]),
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  const firstRequest = [{ role: 'user' as const, content: 'first prompt' }];
  const secondRequest = [{ role: 'user' as const, content: 'second prompt' }];
  expect(await Array.fromAsync(first.forNode('first-node').chat(firstRequest))).toEqual(['first recording']);
  expect(await Array.fromAsync(second.forNode('second-node').chat(secondRequest))).toEqual(['second recording']);

  const replay = createSimLlmRouter({ mode: 'replay', recordingFile });
  expect(await Array.fromAsync(replay.forNode('first-node').chat(firstRequest))).toEqual(['first recording']);
  expect(await Array.fromAsync(replay.forNode('second-node').chat(secondRequest))).toEqual(['second recording']);
});

test('concurrent worker processes preserve both writes to one cassette file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-process-cassette-'));
  dirs.push(dir);
  const recordingFile = join(dir, 'llm-cassette.json');
  writeFileSync(`${recordingFile}.lock`, 'stale lock from interrupted writer');
  mkdirSync(`${recordingFile}.records`);
  writeFileSync(join(`${recordingFile}.records`, 'interrupted.tmp'), '{partial');
  const writer = `
    import { createSimLlmRouter } from './src/ux-sim/fake-llm.ts';
    const node = process.env.SIM_LLM_CHILD_NODE!;
    const content = process.env.SIM_LLM_CHILD_CONTENT!;
    const provider = { name: 'sim-test', defaultModel: 'sim-test-model', available: () => true,
      async *chat() { yield content; }, async *streamChat() { yield { type: 'text', delta: content }; } };
    const router = createSimLlmRouter({ mode: 'auto', recordingFile: process.env.SIM_LLM_CHILD_CASSETTE!,
      sharedCredentialProvider: provider, outboundAllowlist: ['llm'], budget: {
        maxCalls: Number(process.env.SIM_LLM_CHILD_MAX_CALLS), maxWallMs: Number(process.env.SIM_LLM_CHILD_MAX_WALL_MS),
      } });
    await Array.fromAsync(router.forNode(node).chat([{ role: 'user', content }]));
  `;
  const spawnWriter = (node: string, content: string) => Bun.spawn([process.execPath, '-e', writer], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', env: { ...process.env,
      SIM_LLM_CHILD_NODE: node, SIM_LLM_CHILD_CONTENT: content, SIM_LLM_CHILD_CASSETTE: recordingFile,
      SIM_LLM_CHILD_MAX_CALLS: '1', SIM_LLM_CHILD_MAX_WALL_MS: '5000' },
  });
  const children = [spawnWriter('process-one', 'first process'), spawnWriter('process-two', 'second process')];
  const exits = await Promise.all(children.map((child) => child.exited));
  for (const [index, child] of children.entries()) {
    if (exits[index] !== 0) throw new Error(`cassette writer process failed: ${await new Response(child.stderr).text()}`);
  }
  expect(existsSync(`${recordingFile}.lock`)).toBe(true);
  const replay = createSimLlmRouter({ mode: 'replay', recordingFile });
  expect(await Array.fromAsync(replay.forNode('process-one').chat([{ role: 'user', content: 'first process' }]))).toEqual(['first process']);
  expect(await Array.fromAsync(replay.forNode('process-two').chat([{ role: 'user', content: 'second process' }]))).toEqual(['second process']);
});

test('sidecar recordings preserve and replay a legacy cassette without a trailing newline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-legacy-cassette-'));
  dirs.push(dir);
  const recordingFile = join(dir, 'llm-cassette.json');
  const messages = [{ role: 'user' as const, content: 'legacy prompt' }];
  const key = createHash('sha256').update(JSON.stringify({ nodeId: 'legacy-node', messages })).digest('hex');
  writeFileSync(recordingFile, JSON.stringify({ version: 1, recordings: { [key]: [{ type: 'text', delta: 'legacy answer' }] } }));
  const calls: string[] = [];
  const router = createSimLlmRouter({ mode: 'auto', recordingFile,
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'new answer' }], calls),
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  expect(await Array.fromAsync(router.forNode('legacy-node').chat(messages))).toEqual(['legacy answer']);
  expect(await Array.fromAsync(router.forNode('new-node').chat([{ role: 'user', content: 'new prompt' }]))).toEqual(['new answer']);
  const replay = createSimLlmRouter({ mode: 'replay', recordingFile });
  expect(await Array.fromAsync(replay.forNode('legacy-node').chat(messages))).toEqual(['legacy answer']);
  expect(await Array.fromAsync(replay.forNode('new-node').chat([{ role: 'user', content: 'new prompt' }]))).toEqual(['new answer']);
  expect(calls).toEqual(['streamChat']);
});

test('auto does not publish an in-memory hit when cassette persistence fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-persist-fail-'));
  dirs.push(dir);
  const parentFile = join(dir, 'not-a-directory');
  writeFileSync(parentFile, 'fixture');
  const calls: string[] = [];
  const router = createSimLlmRouter({ mode: 'auto', recordingFile: join(parentFile, 'cassette.json'),
    sharedCredentialProvider: providerReturning([{ type: 'text', delta: 'not persisted' }], calls),
    outboundAllowlist: ['llm'], budget: { maxCalls: 2, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  const request = [{ role: 'user' as const, content: 'write failure fixture' }];
  await expect(Array.fromAsync(router.forNode('summary').chat(request))).rejects.toThrow();
  expect(router.recordings.size).toBe(0);
  await expect(Array.fromAsync(router.forNode('summary').chat(request))).rejects.toThrow();
  expect(calls).toEqual(['streamChat', 'streamChat']);
});

test('credential redaction spans text chunks and stores the sanitized cassette shape', async () => {
  const router = createSimLlmRouter({ mode: 'auto', sharedCredentialProvider: providerReturning([
    { type: 'text', delta: 'Bearer abcdefgh' },
    { type: 'text', delta: 'ijklmnop and sk-abcdef' },
    { type: 'text', delta: 'ghijklmnop' },
  ]), outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 5_000 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  const request = [{ role: 'user' as const, content: 'credential split fixture' }];
  await Array.fromAsync(router.forNode('redactor').chat(request));
  const saved = [...router.recordings.values()][0]!;
  expect(saved).toEqual([{ type: 'text', delta: 'Bearer [REDACTED] and [REDACTED]' }]);
  expect(JSON.stringify(saved)).not.toContain('abcdefghijklmnop');
});

test('real LLM wall budget rejects an overrun and does not save a partial cassette', async () => {
  let elapsed = 0;
  const provider: LLMProvider = {
    name: 'clock-advancing-test-provider', defaultModel: 'fixture', available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() { elapsed = 101; yield { type: 'text', delta: 'late response' }; },
  };
  const timed = createSimLlmRouter({ mode: 'real', sharedCredentialProvider: provider,
    outboundAllowlist: ['llm'], budget: { maxCalls: 2, maxWallMs: 100 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
    now: () => elapsed });
  await expect(Array.fromAsync(timed.forNode('slow-node').streamChat!([{ role: 'user', content: 'slow' }]))).rejects.toThrow('wall-time budget exceeded');
  expect(timed.recordings.size).toBe(0);
});

test('real LLM wall timeout ends a provider that ignores abort and never returns another chunk', async () => {
  const provider: LLMProvider = {
    name: 'non-cooperative-test-provider', defaultModel: 'fixture', available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() {
      yield { type: 'text', delta: 'partial response' };
      await new Promise<void>(() => {});
    },
  };
  const router = createSimLlmRouter({ mode: 'real', sharedCredentialProvider: provider,
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 50 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  await expect(Array.fromAsync(router.forNode('hung-node').streamChat!([{ role: 'user', content: 'hang' }]))).rejects.toThrow('wall-time budget exceeded');
  expect(router.recordings.size).toBe(0);
});

test('real LLM deadline remains handled if the consumer pauses after a stream chunk', async () => {
  const provider = providerReturning([{ type: 'text', delta: 'first chunk' }, { type: 'text', delta: 'late chunk' }]);
  const router = createSimLlmRouter({ mode: 'real', sharedCredentialProvider: provider,
    outboundAllowlist: ['llm'], budget: { maxCalls: 1, maxWallMs: 50 }, // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  });
  const iterator = router.forNode('paused-consumer').streamChat!([{ role: 'user', content: 'pause' }])[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ value: { type: 'text', delta: 'first chunk' }, done: false });
  await new Promise((resolve) => setTimeout(resolve, 80)); // Source: 내부 문서 `sim-scenario-regression-load` §A2 real.budget.
  await expect(iterator.next()).rejects.toThrow('wall-time budget exceeded');
  expect(router.recordings.size).toBe(0);
});
