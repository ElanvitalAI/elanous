// OPENROUTER-CLAUDE(대표 11-17 · P0) — `--provider openrouter --model anthropic/claude-opus-5.5` 가
//   anthropic 직결로 새어 1초 빈 «done» 이 되던 결함의 회귀 시험(가짜 fetch · 실호출 0).
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { _resetKeyCacheForTests } from './config.js';
import { decideProviderForConfig, getProviderForConfig, isModelCompatible } from './llm.js';
import { isOpenRouterNativeModelId, isRuntimeLlmModelCompatibleWithProvider } from './llm/runtime-model-family.js';
import { assertTurnNotSilentFailure, TurnSilentFailureError } from './session/turn-silent-failure.js';
import { withRealProviderFakeFetchDevice } from './ux-sim/fake-fetch.js';
import type { UserConfig } from './user-config/types.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'anthropic/claude-opus-5.5';
const messages = [{ role: 'user' as const, content: 'ok 라고만 답해' }];
// 가짜 키 — 실물 꼴(`sk-or-v1-` ⊕ 영숫자)이라 가림 규칙이 실제로 걸리는지 본다. 값은 시험 전용이다.
const FAKE_OR_KEY = `sk-or-v1-${'a1b2c3d4'.repeat(4)}`;

const ENV_KEYS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'ELANOUS_KEY_CACHE_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};
let keyDir = '';

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  keyDir = mkdtempSync(join(tmpdir(), 'or-claude-keys-'));
  // 호스트의 실제 키 캐시·env 를 읽지 않는다 — «키 없음» 이 진짜로 없음이 되게.
  process.env.ELANOUS_KEY_CACHE_DIR = keyDir;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  _resetKeyCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  _resetKeyCacheForTests();
  rmSync(keyDir, { recursive: true, force: true });
});

function orConfig(apiKey?: string, model = MODEL): UserConfig {
  return { llm: { provider: 'openrouter', model, ...(apiKey ? { apiKey } : {}) } } as UserConfig;
}

async function collectText(config: UserConfig): Promise<string> {
  let text = '';
  for await (const event of getProviderForConfig(config).streamChat!(messages)) {
    if (event.type === 'text') text += event.delta;
  }
  return text;
}

test('anthropic/* 는 openrouter 가 명시되면 OpenRouter 원어 id 로 호환 판정된다(anthropic 직결로 재경로 0)', () => {
  expect(isOpenRouterNativeModelId(MODEL)).toBe(true);
  expect(isOpenRouterNativeModelId('openrouter/anthropic/claude-haiku-5.5')).toBe(true);
  expect(isOpenRouterNativeModelId('claude-opus-5-5')).toBe(false);
  expect(isOpenRouterNativeModelId('opengateway/foo/bar')).toBe(false);
  expect(isOpenRouterNativeModelId('bedrock/anthropic.claude-x')).toBe(false);
  expect(isModelCompatible('openrouter', MODEL)).toBe(true);
  expect(isRuntimeLlmModelCompatibleWithProvider('openrouter', MODEL)).toBe(true);
  // 다른 provider 에는 여전히 접두 규칙 그대로(무회귀).
  expect(isModelCompatible('openai', MODEL)).toBe(false);
  const decision = decideProviderForConfig(orConfig(FAKE_OR_KEY));
  expect(decision.provider).toBe('openrouter');
  expect(decision.model).toBe(MODEL);
  expect(decideProviderForConfig(orConfig(FAKE_OR_KEY), MODEL).provider).toBe('openrouter');
});

test('정상 응답: anthropic/claude-opus-5.5 가 OpenRouter 어댑터로 가서 본문을 돌려준다', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  await withRealProviderFakeFetchDevice([
    { url: OPENROUTER_URL, method: 'POST', response: (request) => {
      bodies.push(JSON.parse(request.body ?? 'null') as Record<string, unknown>);
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    } },
    { url: ANTHROPIC_URL, method: 'POST', response: () => new Response('{"error":"must not be called"}', { status: 500 }) },
  ], async (device) => {
    const provider = getProviderForConfig(orConfig(FAKE_OR_KEY));
    expect(provider.name).toBe('openrouter');
    expect(await collectText(orConfig(FAKE_OR_KEY))).toBe('ok');
    const calls = device.calls();
    expect(calls.map((call) => call.url)).toEqual([OPENROUTER_URL]);
    expect(bodies[0]?.model).toBe(MODEL);
  });
});

test('키 없음: OpenRouter 어댑터가 시끄럽게 던지고 anthropic 으로 새지 않는다', async () => {
  await withRealProviderFakeFetchDevice([
    { url: OPENROUTER_URL, method: 'POST', response: () => new Response('data: [DONE]\n\n', { status: 200 }) },
    { url: ANTHROPIC_URL, method: 'POST', response: () => new Response('{}', { status: 401 }) },
  ], async (device) => {
    expect(getProviderForConfig(orConfig()).name).toBe('openrouter');
    await expect(collectText(orConfig())).rejects.toThrow(/openrouter unavailable/);
    expect(device.calls()).toHaveLength(0);
  });
});

test('교차 계열 재경로(openrouter ⊕ 맨 claude-* id)는 OpenRouter 키를 anthropic 에 싣지 않는다', async () => {
  await withRealProviderFakeFetchDevice([
    { url: ANTHROPIC_URL, method: 'POST', response: () => new Response('{"type":"error"}', { status: 401 }) },
  ], async (device) => {
    let failure: unknown;
    try {
      await collectText(orConfig(FAKE_OR_KEY, 'claude-opus-5-5'));
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    // 키가 없으니 anthropic 은 요청 전에 «키 없음»으로 멈춘다 — OpenRouter 키가 헤더로 나간 호출 0.
    for (const call of device.calls()) {
      expect(JSON.stringify(call.headers)).not.toContain(FAKE_OR_KEY);
    }
    expect(device.calls()).toHaveLength(0);
  });
});

test('4xx: 401 은 상태 코드를 실은 오류로 던진다(조용한 빈 스트림 아님)', async () => {
  await withRealProviderFakeFetchDevice([
    { url: OPENROUTER_URL, method: 'POST', response: () => new Response('{"error":{"message":"No auth credentials found","code":401}}', { status: 401 }) },
  ], async () => {
    await expect(collectText(orConfig(FAKE_OR_KEY))).rejects.toThrow(/401/);
  });
});

test('5xx: 503 은 재시도 뒤 상태 코드를 실은 오류로 던진다', async () => {
  await withRealProviderFakeFetchDevice([
    { url: OPENROUTER_URL, method: 'POST', response: () => new Response('{"error":"unavailable"}', { status: 503, headers: { 'retry-after-ms': '1' } }) },
  ], async () => {
    await expect(collectText(orConfig(FAKE_OR_KEY))).rejects.toThrow(/503/);
  });
});

test('빈 스트림: 턴 판정이 ✗ ⊕ turn.empty-response 사건을 내고 «완료»로 넘기지 않는다', async () => {
  const logs: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
  try {
    let text = '';
    await withRealProviderFakeFetchDevice([
      { url: OPENROUTER_URL, method: 'POST', response: () => new Response('data: [DONE]\n\n', { status: 200 }) },
    ], async () => { text = await collectText(orConfig(FAKE_OR_KEY)); });
    expect(text).toBe('');
    let failure: unknown;
    try {
      assertTurnNotSilentFailure({ sessionId: 's-or-claude', provider: 'openrouter', model: MODEL, text, toolCalls: 0, aborted: false, stopReason: 'end_turn' });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TurnSilentFailureError);
    const message = (failure as Error).message;
    expect(message.startsWith('✗')).toBe(true);
    expect(message).toContain('provider=openrouter');
    expect(message).toContain(`model=${MODEL}`);
    expect(message).toContain('empty response');
    expect(logs.some((l) => l.category === 'turn' && l.event === 'empty-response')).toBe(true);
  } finally {
    log.mockRestore();
  }
});

test('공급자 실패(auth_rejected): ✗ 줄에 이유를 싣되 키 값은 가리고 turn.provider-failed 를 남긴다', () => {
  const logs: Array<{ category: string; event: string }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event) => { logs.push({ category, event }); });
  try {
    let failure: unknown;
    try {
      assertTurnNotSilentFailure({
        sessionId: 's-or-claude', provider: 'openrouter', model: MODEL, text: '', toolCalls: 0, aborted: false,
        stopReason: 'auth_rejected', errorMessage: `401 invalid x-api-key ${FAKE_OR_KEY}`,
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TurnSilentFailureError);
    expect((failure as TurnSilentFailureError).status).toBe(401);
    const message = (failure as Error).message;
    expect(message.startsWith('✗')).toBe(true);
    expect(message).toContain('provider=openrouter');
    expect(message).toContain('401');
    expect(message).not.toContain(FAKE_OR_KEY);
    expect(logs.some((l) => l.category === 'turn' && l.event === 'provider-failed')).toBe(true);
  } finally {
    log.mockRestore();
  }
});

test('정상·사람 중단·도구만 쓴 턴은 실패로 치지 않는다', () => {
  const base = { sessionId: 's-or-claude', provider: 'openrouter', model: MODEL } as const;
  expect(() => assertTurnNotSilentFailure({ ...base, text: 'ok', toolCalls: 0, aborted: false, stopReason: 'end_turn' })).not.toThrow();
  expect(() => assertTurnNotSilentFailure({ ...base, text: '', toolCalls: 0, aborted: true })).not.toThrow();
  expect(() => assertTurnNotSilentFailure({ ...base, text: '', toolCalls: 0, aborted: false, stopReason: 'aborted' })).not.toThrow();
  expect(() => assertTurnNotSilentFailure({ ...base, text: '', toolCalls: 1, aborted: false, stopReason: 'goal_complete' })).not.toThrow();
});
