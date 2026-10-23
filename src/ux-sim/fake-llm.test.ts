import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anyProviderAvailable, getProvider, getProviderForConfig } from '../llm.js';
import type { UserConfig } from '../user-config.js';
import { _resetKeyCacheForTests } from '../config.js';
import * as grokCredential from '../grok/credential.js';
import {
  TEST_FAKE_LLM_400_MESSAGE, TEST_FAKE_LLM_CAPTURE_ENV, TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV,
  resetTestFakeLlmScript, testFakeLlmEnabled, testFakeLlmProvider,
} from './fake-llm.js';
import { matchFailureText } from '../self-health/signatures.js';

const names = [
  'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_TEST_FAKE_LLM_RESPONSE', 'ELANOUS_TEST_FAKE_LLM_SCRIPT', 'ELANOUS_TEST_FAKE_LLM_CAPTURE',
  'ELANOUS_TEST_FAKE_LLM_TOOL_CALL', 'ELANOUS_TEST_FAKE_LLM_DELAY_MS', 'ELANOUS_TEST_FAKE_LLM_DELAY_WHEN',
  'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'LOCAL_LLM_URL',
  'HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_KEY_CACHE_DIR',
] as const;
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const dirs: string[] = [];

afterEach(() => {
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

test('test fake is opt-in and returns a fixed stream without network access', async () => {
  delete process.env.ELANOUS_TEST_FAKE_LLM;
  expect(testFakeLlmEnabled()).toBe(false);
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  expect(testFakeLlmProvider.available()).toBe(true);
  const messages = [{ role: 'user' as const, content: 'a secret prompt' }];
  const first = await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  const second = await Array.fromAsync(testFakeLlmProvider.streamChat!(messages));
  expect(first).toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
  expect(second).toEqual(first);
  expect((await Array.fromAsync(testFakeLlmProvider.chat(messages))).join('')).toBe('[test-fake-llm] OK');
  process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = '{"ok":true}';
  expect(await Array.fromAsync(testFakeLlmProvider.chat(messages))).toEqual(['{"ok":true}']);
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

test('keyless auto routing selects fake only when test env is enabled', () => {
  keyless();
  const config = { llm: { provider: 'auto' } } as UserConfig;
  delete process.env.ELANOUS_TEST_FAKE_LLM;
  expect(() => getProviderForConfig(config)).toThrow('No LLM provider available');
  expect(() => getProvider()).toThrow('No LLM provider available');
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  expect(getProviderForConfig(config).name).toBe('test-fake-llm');
  expect(getProvider().name).toBe('test-fake-llm');
});

test('test env leaves real auto candidates and explicit providers ahead of fake', () => {
  keyless();
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
