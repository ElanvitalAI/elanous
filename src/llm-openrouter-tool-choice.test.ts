// OR-TOOLCHOICE-PASS (2026-10-10) — the OpenRouter request builder carries the caller's toolChoice
// as `tool_choice` (via toChatToolChoice), and nothing else moves:
//   · openrouter without toolChoice → body unchanged (no tool_choice key)
//   · codex · claude(anthropic) · grok (and the openai compat path) → body unchanged by this fix
// Fake fetch via spyOn (never mock.module).
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { getProviderForConfig, openRouterToolChoice, toChatToolChoice, toResponsesToolChoice, type LLMToolSpec, type ToolChoice } from './llm.js';
import { saveTokens } from './oauth/store.js';
import type { UserConfig } from './user-config.js';

const tools: LLMToolSpec[] = [{ name: 'demo', description: 'demo', parameters: { type: 'object', properties: { a: { type: 'string' } } } }];
const messages = [{ role: 'user' as const, content: 'hello' }];

// ── TOOLCHOICE-SEAMS-INTERFERENCE (2026-10-11) — 공유 상태 격리 ───────────────────────────
//
// 이 파일이 재는 것은 «요청 본문»이고, 그 본문은 프로세스 밖 상태 **두 곳**에 닿아 있다:
//   ① `ELANOUS_RUN_ID` — OpenRouter sticky routing(`openRouterStickySessionKey`)이 본문에
//      `session_id` 를 싣는다 ⇒ 키 순서 기대(`['model','messages','tools','usage','provider','stream']`)가
//      깨진다. `test/preload-isolation.ts` 가 프로세스 시작 때 한 번 지우지만, **묶음에서 앞서 돈
//      파일이 다시 심으면** 되살아난다.
//      📏 실측: 이 키를 «쓰는» 테스트 파일 26개(`grep -rl "process.env.ELANOUS_RUN_ID = " --include=*.test.ts src test scripts | wc -l`),
//        그리고 이 키를 심은 preload 와 함께 이 파일을 돌리면 `+ "session_id"` diff 로 1건이 진다.
//   ② codex 자격 — 호스트 `auth.json`(elanous 스토어 ⊕ `$CODEX_HOME` 미러)이 «있으면» Responses
//      경로(`tool_choice` 있음), «없으면» API-key 경로(`tool_choice` 없음)로 갈린다
//      (`src/llm.ts` makeCodexProvider · `loadFreshCodexAuthState`). 게이트 Pod 마다 값이 다르다.
// ⇒ 둘 다 **이 파일 안에서** 못 박는다(제품 코드 무접촉).
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = { ...process.env };
  delete process.env.ELANOUS_RUN_ID;
  delete process.env.ELANOUS_SESSION_ID;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key];
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** ② codex 자격을 «호스트 상태와 무관하게» Responses 경로로 고정한다 — 임의 토큰을 격리 스토어에 심는다.
 *  `XDG_CONFIG_HOME` 이 `authStorePath()` 를 옮기고, 빈 `CODEX_HOME` 이 호스트 `~/.codex/auth.json`
 *  미러가 그 토큰을 덮지 못하게 막는다. 만료는 1시간 뒤(`CODEX_REFRESH_BUFFER_MS` 120초 밖)라
 *  갱신=네트워크 호출이 일어나지 않는다. env 복원은 위 afterEach 가 한다. */
async function withCodexResponsesCredential(run: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'elanous-or-toolchoice-codex-'));
  try {
    const xdg = join(root, 'xdg');
    mkdirSync(join(xdg, 'elanous'), { recursive: true });
    mkdirSync(join(root, 'codex-home'), { recursive: true });
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.CODEX_HOME = join(root, 'codex-home');
    process.env.ELANOUS_SUPPRESS_XDG_WARNING = '1';
    delete process.env.ELANOUS_CODEX_ACCOUNT;   // 기본 계정(storeKey 'openai-codex') 고정
    saveTokens('openai-codex', {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      tokenType: 'Bearer',
    }, { authMode: 'chatgpt', mirrorCodex: false }, join(xdg, 'elanous', 'auth.json'));
    await run();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function captureBody(llm: Record<string, unknown>, opts: { toolChoice?: ToolChoice; tools?: LLMToolSpec[] | null }) {
  const bodies: string[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const provider = getProviderForConfig({ llm } as unknown as UserConfig);
    const streamOpts = {
      ...(opts.tools === null ? {} : { tools: opts.tools ?? tools }),
      ...(opts.toolChoice !== undefined ? { toolChoice: opts.toolChoice } : {}),
    };
    for await (const _ of provider.streamChat!(messages, streamOpts)) { /* consume */ }
    expect(bodies.length).toBeGreaterThan(0);
    return bodies[0]!;
  } finally {
    mock.mockRestore();
  }
}

const OR_GLM = { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'test-key' };
const OR_KIMI = { provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3', apiKey: 'test-key' };

test('openrouter: toolChoice "required" → body.tool_choice === "required"', async () => {
  const body = JSON.parse(await captureBody(OR_GLM, { toolChoice: 'required' }));
  expect(body.tool_choice).toBe('required');
  expect(body.tools[0].function.name).toBe('demo');
});

test('openrouter: toolChoice {name} → toChatToolChoice shape', async () => {
  const body = JSON.parse(await captureBody(OR_GLM, { toolChoice: { name: 'demo' } }));
  expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'demo' } });
  expect(body.tool_choice).toEqual(toChatToolChoice({ name: 'demo' }) as object);
});

test('openrouter: toolChoice "auto"/"none" pass through verbatim', async () => {
  expect(JSON.parse(await captureBody(OR_GLM, { toolChoice: 'auto' })).tool_choice).toBe('auto');
  expect(JSON.parse(await captureBody(OR_GLM, { toolChoice: 'none' })).tool_choice).toBe('none');
});

test('openrouter: no toolChoice → body byte-identical to the pre-fix shape (no tool_choice key)', async () => {
  const raw = await captureBody(OR_GLM, {});
  const body = JSON.parse(raw);
  expect('tool_choice' in body).toBe(false);
  // Pre-fix key order: model · messages · tools · usage · provider · stream (sampling fields are omitted on OpenRouter).
  expect(Object.keys(body)).toEqual(['model', 'messages', 'tools', 'usage', 'provider', 'stream']);
  // Adding then removing tool_choice reproduces the exact bytes.
  const withChoice = JSON.parse(await captureBody(OR_GLM, { toolChoice: 'required' }));
  delete withChoice.tool_choice;
  expect(JSON.stringify(withChoice)).toBe(raw);
});

test('openrouter: toolChoice without tools → no tool_choice key (avoid 400 on tool-less requests)', async () => {
  const body = JSON.parse(await captureBody(OR_GLM, { toolChoice: 'required', tools: null }));
  expect('tool_choice' in body).toBe(false);
  expect('tools' in body).toBe(false);
});

test('openrouter Kimi (moonshotai/*): forced choice is lowered to "auto"; auto/none unchanged', async () => {
  expect(JSON.parse(await captureBody(OR_KIMI, { toolChoice: 'required' })).tool_choice).toBe('auto');
  expect(JSON.parse(await captureBody(OR_KIMI, { toolChoice: { name: 'demo' } })).tool_choice).toBe('auto');
  expect(JSON.parse(await captureBody(OR_KIMI, { toolChoice: 'none' })).tool_choice).toBe('none');
  expect(openRouterToolChoice('moonshotai/kimi-k3', undefined)).toBeUndefined();
  expect(openRouterToolChoice('z-ai/glm-5.3', 'required')).toBe('required');
});

test('openrouter: tool-choice-sent is observed under llm.openrouter only when tool_choice is set', async () => {
  const logs: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    logs.push({ category, event, data });
  }) as typeof debug.log);
  try {
    await captureBody(OR_GLM, {});
    expect(logs.filter((l) => l.event === 'tool-choice-sent')).toHaveLength(0);
    await captureBody(OR_GLM, { toolChoice: 'required' });
    const sent = logs.filter((l) => l.event === 'tool-choice-sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.category).toBe('llm.openrouter');
    expect(sent[0]!.data).toMatchObject({ model: 'z-ai/glm-5.3', toolChoice: 'required' });
  } finally {
    log.mockRestore();
  }
});

// ── Invariants: paths outside OpenRouter are untouched by this fix ─────────────────────────────

test('invariant: claude(anthropic) body ignores toolChoice exactly as before (byte-identical)', async () => {
  const llm = { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-test' };
  const without = await captureBody(llm, {});
  for (const tc of ['required', 'auto', { name: 'demo' }] as ToolChoice[]) {
    expect(await captureBody(llm, { toolChoice: tc })).toBe(without);
  }
  expect('tool_choice' in JSON.parse(without)).toBe(false);
});

test('invariant: grok and the openai compat path still drop toolChoice (byte-identical)', async () => {
  for (const llm of [
    { provider: 'grok', model: 'grok-4.7', apiKey: 'xai-test' },
    { provider: 'openai', model: 'gpt-5.6', apiKey: 'sk-test' },
  ]) {
    const without = await captureBody(llm, {});
    for (const tc of ['required', { name: 'demo' }] as ToolChoice[]) {
      expect(await captureBody(llm, { toolChoice: tc })).toBe(without);
    }
    expect('tool_choice' in JSON.parse(without)).toBe(false);
  }
});

test('invariant: codex body keeps its Responses-API tool_choice (toResponsesToolChoice) and is otherwise unchanged', () => withCodexResponsesCredential(async () => {
  const llm = { provider: 'openai-codex', model: 'gpt-5.6', apiKey: 'sk-test' };
  const without = JSON.parse(await captureBody(llm, {}));
  expect('tool_choice' in without).toBe(false);
  expect('input' in without).toBe(true); // Responses-API shape, not /chat/completions
  for (const tc of ['required', { name: 'demo' }] as ToolChoice[]) {
    const body = JSON.parse(await captureBody(llm, { toolChoice: tc }));
    expect(body.tool_choice).toBe(toResponsesToolChoice(tc) as string);
    delete body.tool_choice;
    expect(body).toEqual(without);
  }
}));
