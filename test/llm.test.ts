// ── LLM message-shape tests ──
//
// Covers the Phase 8 surface:
//   - ContentBlock type round-trips through OpenAI and Anthropic converters
//   - buildMessagesWithContext prepends text attachments as labeled sections
//   - Images flip the content shape to ContentBlock[]
//   - system messages are collapsed correctly for Anthropic
//
// Network calls are NOT exercised here — provider.chat() is tested live in
// Phase 0's manual verification and covered by the existing dashboard smoke.

import { afterEach, beforeEach, describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMessagesWithContext,
  toOpenAIMessage,
  toAnthropicMessage,
  systemToAnthropicString,
  isLikelyVisionModel,
  streamLLM,
  _remainingFallbackProviderNamesForTest,
  streamLLMWithTools,
  PROVIDERS,
  type LLMMessage,
  type ContentBlock,
  type LLMProvider,
  type LLMStreamEvent,
  type LLMToolSpec,
} from '../src/llm';
import { createContextRegistry, addAttachment } from '../src/context';
import { setUserConfigOverlay } from '../src/user-config';
import { debug } from '../src/debug/log';
import { ProviderFallbackError } from '../src/session-runtime/retry-policy';
import { resetProviderCircuitForTest } from '../src/session-runtime/provider-circuit';

// ── Helpers ────────────────────────────────────────────────

function seedLoadedText(
  reg: ReturnType<typeof createContextRegistry>,
  filename: string,
  kind: 'text' | 'md' | 'pdf' | 'docx' | 'xlsx',
  body: string,
) {
  const att = addAttachment(reg, {
    kind,
    sourcePath: `/tmp/${filename}`,
    filename,
    sizeBytes: body.length,
    mtime: 1,
  });
  att.text = body;
  att.extractedBytes = body.length;
  att.loaded = true;
  return att;
}

function seedImage(
  reg: ReturnType<typeof createContextRegistry>,
  filename: string,
  base64: string,
  mediaType = 'image/png',
) {
  const att = addAttachment(reg, {
    kind: 'image',
    sourcePath: `/tmp/${filename}`,
    filename,
    sizeBytes: 1024,
    mtime: 1,
    mediaType,
    base64,
  });
  return att;
}

describe('streamLLMWithTools provider fallback', () => {
  const originalProviders = { ...PROVIDERS };
  const savedEnv: Record<string, string | undefined> = {};
  let tmpHome: string | null = null;

  function scriptedProvider(name: string, script: (opts?: { model?: string; tools?: LLMToolSpec[] }) => AsyncGenerator<LLMStreamEvent, void, unknown>): LLMProvider {
    return {
      name,
      defaultModel: `${name}-model`,
      available: () => true,
      streamChat: (_messages, opts) => script(opts),
      async *chat(_messages, opts) {
        for await (const event of script(opts)) {
          if (event.type === 'text') yield event.delta;
        }
      },
    };
  }

  beforeEach(() => {
    resetProviderCircuitForTest();
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL']) {
      savedEnv[key] = process.env[key];
    }
    tmpHome = mkdtempSync(join(tmpdir(), 'llm-fallback-'));
    process.env.HOME = tmpHome;
    process.env.XDG_CONFIG_HOME = tmpHome;
    process.env.CODEX_HOME = join(tmpHome, 'codex-home');
    for (const key of ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL']) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetProviderCircuitForTest();
    Object.assign(PROVIDERS, originalProviders);
    setUserConfigOverlay(null);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = null;
    }
  });

  test('retries a quota-blocked automatic provider with its own model, normalized tools, and named fallback observation', async () => {
    const fallbackCalls: Array<{ model?: string; tools?: LLMToolSpec[] }> = [];
    const log = spyOn(debug, 'log');
    const blocked = scriptedProvider('grok', async function* () {
      throw Object.assign(new Error('usage limit reached'), { status: 429 });
    });
    const fallback = scriptedProvider('anthropic', async function* (opts) {
      fallbackCalls.push({ model: opts?.model, tools: opts?.tools });
      yield { type: 'tool_call', id: 'fallback-call', name: 'echo', args: { value: 'ok' } };
    });
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = blocked;
    PROVIDERS.anthropic = fallback;
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {});
    PROVIDERS.local = scriptedProvider('local', async function* () {});

    const tool: LLMToolSpec = {
      name: 'echo', description: 'echo', parameters: {
        type: 'object', properties: { value: { type: 'string' } }, required: ['value'],
      },
    };
    const dispatched: string[] = [];
    const final = await streamLLMWithTools(
      [{ role: 'user', content: 'use echo' }],
      { onText: () => {}, dispatchTool: async (name) => { dispatched.push(name); return 'ok'; } },
      { provider: undefined, tools: [tool], maxTurns: 1 },
    );

    expect(fallbackCalls).toEqual([{ model: 'anthropic-model', tools: [tool] }]);
    expect(dispatched).toEqual(['echo']);
    expect(final).toContain('[NO FINAL SYNTHESIS]');
    expect(log).toHaveBeenCalledWith('llm.router', 'provider-fallback', expect.objectContaining({
      blockedProvider: 'grok', fallbackProvider: 'anthropic', tools: ['echo'],
    }), expect.anything());
    log.mockRestore();
  });

  test('falls back from a model-only request with the fallback provider default model and records the dropped override', async () => {
    const calls: Array<{ provider: string; model?: string }> = [];
    const log = spyOn(debug, 'log');
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.openai = scriptedProvider('openai', async function* (opts) {
      calls.push({ provider: 'openai', model: opts?.model });
      throw new Error('openai socket hang up');
    });
    PROVIDERS.grok = scriptedProvider('grok', async function* (opts) {
      calls.push({ provider: 'grok', model: opts?.model });
      yield { type: 'text', delta: 'fallback recovered' };
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {});
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {});
    PROVIDERS.local = scriptedProvider('local', async function* () {});

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { model: 'gpt-5.6-terra', tools: [], maxTurns: 1 },
    );

    expect(calls).toEqual([
      { provider: 'openai', model: 'gpt-5.6-terra' },
      { provider: 'grok', model: 'grok-model' },
    ]);
    expect(result).toBe('fallback recovered');
    expect(log).toHaveBeenCalledWith('llm.router', 'provider-fallback', expect.objectContaining({
      blockedProvider: 'openai', fallbackProvider: 'grok', modelOverrideDropped: 'gpt-5.6-terra',
    }), expect.anything());
    log.mockRestore();
  });

  test('streamLLM drops a model-only override before retrying the fallback provider', async () => {
    const calls: Array<{ provider: string; model?: string }> = [];
    const log = spyOn(debug, 'log');
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.openai = scriptedProvider('openai', async function* (opts) {
      calls.push({ provider: 'openai', model: opts?.model });
      throw new Error('openai socket hang up');
    });
    PROVIDERS.grok = scriptedProvider('grok', async function* (opts) {
      calls.push({ provider: 'grok', model: opts?.model });
      yield { type: 'text', delta: 'stream fallback recovered' };
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {});
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {});
    PROVIDERS.local = scriptedProvider('local', async function* () {});

    const result = await streamLLM(
      [{ role: 'user', content: 'q' }],
      () => {},
      { model: 'gpt-5.6-terra' },
    );

    expect(calls).toEqual([
      { provider: 'openai', model: 'gpt-5.6-terra' },
      { provider: 'grok', model: 'grok-model' },
    ]);
    expect(result).toBe('stream fallback recovered');
    expect(log).toHaveBeenCalledWith('llm.router', 'provider-fallback', expect.objectContaining({
      blockedProvider: 'openai', fallbackProvider: 'grok', modelOverrideDropped: 'gpt-5.6-terra',
    }), expect.anything());
    log.mockRestore();
  });

  test('attempts each automatic provider at most once when every fallback is quota-blocked', async () => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    for (const name of ['grok', 'anthropic', 'gemini', 'local']) {
      PROVIDERS[name] = scriptedProvider(name, async function* () {
        calls.push(name);
        throw Object.assign(new Error(`${name} quota exhausted`), { status: 429 });
      });
    }

    const thrown = await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { provider: undefined, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }], maxTurns: 1 },
    ).catch((err: unknown) => err);
    expect(calls).toEqual(['grok', 'anthropic', 'gemini', 'local']);
    expect(thrown).toBeInstanceOf(ProviderFallbackError);
    expect((thrown as ProviderFallbackError).message).toContain('[LLM PROVIDER BLOCKED] fallback candidates exhausted');
    expect((thrown as ProviderFallbackError).verdictReason).toBe('fallback candidates exhausted');
    for (const name of calls) expect((thrown as ProviderFallbackError).message).toContain(`${name}: ${name} quota exhausted`);
    expect((thrown as ProviderFallbackError).fallbackAttempts.map((entry) => entry.provider)).toEqual(calls);
  });

  test('returns a named blocking result without rejecting when the only available automatic provider is blocked', async () => {
    const calls: string[] = [];
    const chunks: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      throw Object.assign(new Error('grok usage limit reached'), { status: 429 });
    });
    for (const name of ['anthropic', 'gemini', 'local']) {
      PROVIDERS[name] = { ...scriptedProvider(name, async function* () {}), available: () => false };
    }

    const result = await streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      (delta) => chunks.push(delta),
    );

    expect(calls).toEqual(['grok']);
    expect(result).toContain('[LLM PROVIDER BLOCKED]');
    expect(result).toContain('grok: grok usage limit reached');
    expect(chunks).toEqual([result]);
  });

  test('propagates a quota-shaped onChunk error without trying another provider', async () => {
    const calls: string[] = [];
    const callbackError = Object.assign(new Error('429 quota callback failure'), { status: 429 });
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      yield { type: 'text', delta: '' };
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
      yield { type: 'text', delta: 'fallback chunk' };
    });

    await expect(streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      () => { throw callbackError; },
    )).rejects.toBe(callbackError);

    expect(calls).toEqual(['grok']);
  });

  test('closes the provider iterator when onChunk throws without attempting a fallback', async () => {
    const callbackError = Object.assign(new Error('429 quota callback failure'), { status: 429 });
    const calls: string[] = [];
    let finalized = false;
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      try {
        yield { type: 'text', delta: 'chunk' };
        await new Promise(() => {});
      } finally {
        finalized = true;
      }
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
      yield { type: 'text', delta: 'fallback chunk' };
    });

    await expect(streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      () => { throw callbackError; },
    )).rejects.toBe(callbackError);

    expect(finalized).toBe(true);
    expect(calls).toEqual(['grok']);
  });

  test.each([
    ['streamChat()', () => { throw Object.assign(new Error('grok quota exhausted during stream setup'), { status: 429 }); }],
    ['iterator acquisition', () => ({ [Symbol.asyncIterator]() { throw Object.assign(new Error('grok quota exhausted during iterator setup'), { status: 429 }); } })],
  ])('falls back when %s throws a synchronous provider block', async (_name, failingStreamChat) => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = {
      ...scriptedProvider('grok', async function* () {}),
      streamChat: failingStreamChat as unknown as LLMProvider['streamChat'],
    };
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
      yield { type: 'text', delta: 'fallback rendered' };
    });

    await expect(streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      () => {},
    )).resolves.toBe('fallback rendered');
    expect(calls).toEqual(['anthropic']);
  });

  test('forwards provider usage through the non-tools stream when requested', async () => {
    const usage = { inputTokens: 12, outputTokens: 7 };
    const received: Array<{ inputTokens?: number; outputTokens?: number }> = [];
    const provider = scriptedProvider('usage', async function* () {
      yield { type: 'usage', usage };
      yield { type: 'text', delta: 'measured response' };
    });

    await expect(streamLLM(
      [{ role: 'user', content: 'measure this response' }],
      () => {},
      { provider, onUsage: (event) => received.push(event) },
    )).resolves.toBe('measured response');

    expect(received).toEqual([usage]);
  });

  test('does not fallback after a provider emitted output, and appends its named block under the streaming contract', async () => {
    const calls: string[] = [];
    const chunks: Array<{ delta: string; full: string }> = [];
    let rendered = '';
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      yield { type: 'text', delta: 'partial output' };
      throw Object.assign(new Error('grok usage limit reached'), { status: 429 });
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
      yield { type: 'text', delta: 'fallback output' };
    });

    const result = await streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      (delta, full) => {
        rendered += delta;
        chunks.push({ delta, full });
        expect(rendered).toBe(full);
      },
    );

    expect(calls).toEqual(['grok']);
    expect(result).toBe(rendered);
    expect(result).toContain('partial output');
    expect(result).toContain('grok: grok usage limit reached');
    expect(result).toContain('fallback candidates exhausted');
    expect(chunks).toEqual([
      { delta: 'partial output', full: 'partial output' },
      { delta: '\n\n[LLM PROVIDER BLOCKED] fallback candidates exhausted\n- grok: grok usage limit reached', full: result },
    ]);
  });

  test('does not return partial output when a provider throws undefined after streaming', async () => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      yield { type: 'text', delta: 'partial output' };
      throw undefined;
    });

    await expect(streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      () => {},
    )).rejects.toBeUndefined();
    expect(calls).toEqual(['grok']);
  });

  test('returns a named blocking result so the initial screen can render after every automatic provider is blocked', async () => {
    const calls: string[] = [];
    const chunks: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    for (const name of ['grok', 'anthropic', 'gemini', 'local']) {
      PROVIDERS[name] = scriptedProvider(name, async function* () {
        calls.push(name);
        throw Object.assign(new Error(`${name} usage limit reached`), { status: 429 });
      });
    }

    const result = await streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      (delta) => chunks.push(delta),
    );

    expect(calls).toEqual(['grok', 'anthropic', 'gemini', 'local']);
    expect(result).toContain('[LLM PROVIDER BLOCKED]');
    for (const name of calls) expect(result).toContain(`${name}: ${name} usage limit reached`);
    expect(chunks).toEqual([result]);
  });

  test.each([
    'prompt is too long for context window',
    'Gemini safety filter blocked content (finishReason=SAFETY)',
    'store must be set to false',
  ])('does not fallback for user-caused %s errors', async (message) => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      throw new Error(message);
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
    });

    await expect(streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { provider: undefined, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }], maxTurns: 1 },
    )).rejects.toThrow(message);
    expect(calls).toEqual(['grok']);
  });

  test('falls back on ECONNREFUSED / provider connection wording before killing the turn', async () => {
    const calls: string[] = [];
    const log = spyOn(debug, 'log');
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      throw Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' });
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
      yield { type: 'text', delta: 'fallback recovered' };
    });

    const result = await streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      () => {},
    );

    expect(calls).toEqual(['grok', 'anthropic']);
    expect(result).toBe('fallback recovered');
    expect(log).toHaveBeenCalledWith('llm.router', 'provider-fallback', expect.objectContaining({
      blockedProvider: 'grok', fallbackProvider: 'anthropic', category: 'network-transient',
    }), expect.anything());
    log.mockRestore();
  });

  test('records sanitized attempt history when connection fallbacks are exhausted', async () => {
    const calls: string[] = [];
    const log = spyOn(debug, 'log');
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    for (const name of ['grok', 'anthropic', 'gemini', 'local']) {
      PROVIDERS[name] = scriptedProvider(name, async function* () {
        calls.push(name);
        throw Object.assign(new Error(`${name} Unable to connect. Bearer sk-abcdefghijklmnopqrstuvwxyz`), { code: 'ECONNREFUSED' });
      });
    }

    const result = await streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      () => {},
    );

    expect(calls).toEqual(['grok', 'anthropic', 'gemini', 'local']);
    expect(result).toContain('[LLM PROVIDER BLOCKED] fallback candidates exhausted');
    for (const name of calls) expect(result).toContain(`${name}:`);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(log).toHaveBeenCalledWith('llm.router', 'provider-fallback-exhausted', expect.objectContaining({
      reason: 'fallback candidates exhausted',
      blockedProviders: expect.arrayContaining([
        expect.objectContaining({ provider: 'grok', category: 'network-transient' }),
      ]),
    }), expect.anything());
    log.mockRestore();
  });

  // ⛔ #16667 리뷰 must-fix ④ — 「넓힌 정책」의 대조군.
  //   이 시험이 없으면 isProviderFallbackEligible 을 다시 「빼고 전부」로 되돌려도
  //   아래 소진 시험은 «여전히 초록»이다(그것은 자격이 있는 경우만 누르므로).
  test('a provider-independent failure stops at the FIRST provider and does not spend the chain', async () => {
    const calls: string[] = [];
    const log = spyOn(debug, 'log');
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    for (const name of ['grok', 'anthropic', 'gemini', 'local']) {
      PROVIDERS[name] = scriptedProvider(name, async function* () {
        calls.push(name);
        // 우리 쪽 요청 조립 버그 — 어느 프로바이더로 가도 똑같이 실패한다.
        throw Object.assign(new Error('400 invalid_request_error: unexpected field "storee"'), { status: 400 });
      });
    }

    const thrown = await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { provider: undefined, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }], maxTurns: 1 },
    ).catch((err: unknown) => err);

    // 📌 핵심 — 체인에 후보가 셋 더 남아 있는데도 «한 번만» 불렸다.
    expect(calls).toEqual(['grok']);
    // stop 은 감싸지 않고 «원 오류»를 그대로 올린다 — 요청 조립 버그는 그 문면이 답이다.
    expect(thrown).not.toBeInstanceOf(ProviderFallbackError);
    expect(String((thrown as Error).message)).toContain('invalid_request_error');
    expect(log).toHaveBeenCalledWith('llm.router', 'provider-fallback-stop', expect.objectContaining({
      category: 'unknown',
      reason: 'category is not provider-dependent; do not spend remaining fallbacks',
    }), expect.anything());
    log.mockRestore();
  });

  // ⛔ #16667 재심 should-fix ② 의 자.
  //   이 시험을 붙이기 «전»에 처방을 도로 빼 봤더니 test/llm.test.ts 가 67/0 «초록»이었다 —
  //   즉 그 계약을 무는 자가 하나도 없었다. 반증이 조용하면 안 돌아간 것이다.
  test('an explicitly pinned provider throws the ORIGINAL error, never a wrapped exhaust', async () => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    const pinned = scriptedProvider('grok', async function* () {
      calls.push('grok');
      // 폴백 «자격이 있는» 범주여야 의미가 있다 — 자격이 없으면 어차피 stop 이라 계약을 못 가른다.
      throw new Error('grok socket hang up');
    });
    PROVIDERS.grok = pinned;
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () { calls.push('anthropic'); });

    const thrown = await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { provider: pinned, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }], maxTurns: 1 },
    ).catch((err: unknown) => err);

    expect(calls).toEqual(['grok']);
    expect(thrown).not.toBeInstanceOf(ProviderFallbackError);
    expect(String((thrown as Error).message)).toBe('grok socket hang up');
  });

  test('a provider-dependent failure walks the whole chain and records attempts on exhaustion', async () => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    for (const name of ['grok', 'anthropic', 'gemini', 'local']) {
      PROVIDERS[name] = scriptedProvider(name, async function* () {
        calls.push(name);
        throw new Error(`${name} socket hang up`);
      });
    }

    const thrown = await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { provider: undefined, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }], maxTurns: 1 },
    ).catch((err: unknown) => err);

    expect(calls).toEqual(['grok', 'anthropic', 'gemini', 'local']);
    expect(thrown).toBeInstanceOf(ProviderFallbackError);
    const aggregated = thrown as ProviderFallbackError;
    expect(aggregated.message).toContain('[LLM PROVIDER BLOCKED] fallback candidates exhausted');
    expect(aggregated.message).toContain('local socket hang up');
    for (const name of calls) expect(aggregated.message).toContain(`${name}:`);
    expect(aggregated.verdictReason).toBe('fallback candidates exhausted');
    expect(aggregated.fallbackAttempts.map((entry) => entry.provider))
      .toEqual(['grok', 'anthropic', 'gemini', 'local']);
  });

  // ⛔⭐ 두 축은 «갈려야» 한다 — 무인 리뷰가 이것을 must-fix 로 두 번 올렸으므로 자로 못 박는다.
  //
  //   `llm.fallbackChain` 은 「codex 가 소진되면 다음 칸」을 답하는 축이고
  //   (`src/oauth/fallback-chain.ts` 머리말 · 대표 2026-08-13), 그 단계는 전수
  //   `FALLBACK_STEPS = ['codex-rotate','grok']` «둘»뿐이다.
  //   `llm.provider = 'auto'` 는 「쓸 수 있는 프로바이더 중 고른다」는 다른 축이고
  //   그 순서는 `['grok','anthropic','gemini','local']` 이다.
  //
  //   📌 그래서 auto 경로를 fallbackChain 으로 바꾸면 **anthropic·gemini·local 셋이
  //   조용히 사라진다** — 체인 타입이 그 셋을 «표현할 수 없기» 때문이다.
  //   ⇒ 공유가 아니라 «분리»가 설계다. 이 시험이 그것을 말한다.
  // ⭐ 2026-09-24 결정으로 계약이 «뒤집혔다» — 종전 판은 「auto 는 체인을 무시한다」를 못 박았다.
  //   이제 auto 폴백은 llm.fallbackChain 을 «먼저» 걷고, 체인이 다루지 않는 후보(anthropic·gemini·local)가 뒤에 온다.
  test('auto mode walks llm.fallbackChain first, then the providers the chain does not govern', async () => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({
      ...config,
      llm: { ...config.llm, provider: 'auto', fallbackChain: ['codex-rotate'] },
    }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
      yield { type: 'text', delta: 'auto-order recovered' };
    });
    PROVIDERS['openai-codex'] = scriptedProvider('openai-codex', async function* () {
      calls.push('openai-codex');
      yield { type: 'text', delta: 'chain-order recovered' };
    });
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () { calls.push('gemini'); });
    PROVIDERS.local = scriptedProvider('local', async function* () { calls.push('local'); });

    const result = await streamLLM([{ role: 'user', content: 'q' }], () => {});

    // 체인의 'codex-rotate'(→ openai-codex)가 auto 순서의 다음 칸(anthropic)보다 «먼저» 온다.
    expect(calls).toEqual(['grok', 'openai-codex']);
    expect(result).toBe('chain-order recovered');
  });

  test('auto mode: after codex fails, a chain without grok never leaks to grok; the default chain tries grok first', () => {
    for (const name of ['grok', 'anthropic', 'gemini', 'local', 'openai-codex'] as const) {
      PROVIDERS[name] = scriptedProvider(name, async function* () { yield { type: 'text', delta: name }; });
    }
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto', fallbackChain: ['codex-rotate'] } }));
    expect(_remainingFallbackProviderNamesForTest(['openai-codex'])).toEqual(['anthropic', 'gemini', 'local']);
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto', fallbackChain: ['codex-rotate', 'grok'] } }));
    expect(_remainingFallbackProviderNamesForTest(['openai-codex'])).toEqual(['grok', 'anthropic', 'gemini', 'local']);
  });

  test('honors injected llm.fallbackChain when provider is not auto', async () => {
    const calls: string[] = [];
    const log = spyOn(debug, 'log');
    const injectedChain = ['codex-rotate', 'grok'];
    setUserConfigOverlay((config) => ({
      ...config,
      llm: { ...config.llm, provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: '', fallbackChain: injectedChain },
    }));
    // Non-auto routing constructs makeAnthropicProvider (not PROVIDERS.anthropic).
    // Remaining candidates must still come from the injected chain, not AUTOMATIC_PROVIDER_ORDER
    // (which would try grok first).
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
    });
    PROVIDERS['openai-codex'] = scriptedProvider('openai-codex', async function* () {
      calls.push('openai-codex');
      yield { type: 'text', delta: 'configured-chain recovered' };
    });
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      yield { type: 'text', delta: 'should-not-run' };
    });
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {
      calls.push('gemini');
    });
    PROVIDERS.local = scriptedProvider('local', async function* () {
      calls.push('local');
    });

    const result = await streamLLM(
      [{ role: 'user', content: 'boot initial screen' }],
      () => {},
    );

    expect(calls).toEqual(['openai-codex']);
    expect(result).toBe('configured-chain recovered');
    expect(log).toHaveBeenCalledWith('llm.router', 'provider-fallback', expect.objectContaining({
      blockedProvider: 'anthropic', fallbackProvider: 'openai-codex',
    }), expect.anything());
    log.mockRestore();
  });

  test('exhausts the injected fallback chain and records sanitized history without mutating frozen or string throws', async () => {
    const calls: string[] = [];
    const log = spyOn(debug, 'log');
    const injectedChain = ['codex-rotate', 'grok'];
    const frozen = Object.freeze(new Error('Unable to connect. Bearer sk-abcdefghijklmnopqrstuvwxyz'));
    setUserConfigOverlay((config) => ({
      ...config,
      llm: { ...config.llm, provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: '', fallbackChain: injectedChain },
    }));
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
    });
    PROVIDERS['openai-codex'] = scriptedProvider('openai-codex', async function* () {
      calls.push('openai-codex');
      throw frozen;
    });
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      throw 'Unable to connect. Bearer sk-abcdefghijklmnopqrstuvwxyz';
    });
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {
      calls.push('gemini');
    });
    PROVIDERS.local = scriptedProvider('local', async function* () {
      calls.push('local');
    });

    const thrown = await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { provider: undefined, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }], maxTurns: 1 },
    ).catch((err: unknown) => err);

    expect(calls).toEqual(['openai-codex', 'grok']);
    expect(thrown).toBeInstanceOf(ProviderFallbackError);
    const aggregated = thrown as ProviderFallbackError;
    expect(aggregated.message).toContain('[LLM PROVIDER BLOCKED] fallback candidates exhausted');
    expect(aggregated.message).toContain('anthropic:');
    expect(aggregated.message).toContain('openai-codex:');
    expect(aggregated.message).toContain('grok:');
    expect(aggregated.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(String(aggregated.stack ?? '')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(aggregated.verdictReason).toBe('fallback candidates exhausted');
    expect(aggregated.fallbackAttempts.map((entry) => entry.provider)).toEqual(['anthropic', 'openai-codex', 'grok']);
    expect(aggregated.originalCause).toBe('Unable to connect. Bearer sk-abcdefghijklmnopqrstuvwxyz');
    expect((frozen as { fallbackAttempts?: unknown }).fallbackAttempts).toBeUndefined();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(log).toHaveBeenCalledWith('llm.router', 'provider-fallback-exhausted', expect.objectContaining({
      reason: 'fallback candidates exhausted',
      blockedProviders: expect.arrayContaining([
        expect.objectContaining({ provider: 'anthropic' }),
        expect.objectContaining({ provider: 'openai-codex', category: 'network-transient' }),
        expect.objectContaining({ provider: 'grok' }),
      ]),
    }), expect.anything());
    log.mockRestore();
  });

  test('does not override an explicitly selected provider when it is quota-blocked', async () => {
    let fallbackCalls = 0;
    const blocked = scriptedProvider('blocked', async function* () {
      throw Object.assign(new Error('quota exhausted'), { status: 429 });
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () { fallbackCalls++; });

    await expect(streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { provider: blocked, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }], maxTurns: 1 },
    )).rejects.toThrow('quota exhausted');
    expect(fallbackCalls).toBe(0);
  });

});

describe('streamLLMWithTools terminal reason observation', () => {
  const tool: LLMToolSpec = {
    name: 'inspect',
    description: 'inspect',
    parameters: { type: 'object' },
  };

  test('returns streamed text without a no-final-synthesis notice when aborted by the provider before its first event', async () => {
    const controller = new AbortController();
    const log = spyOn(debug, 'log');
    const texts: string[] = [];
    const completed: unknown[][] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      name: 'scripted',
      defaultModel: 'scripted-model',
      available: () => true,
      async *streamChat() {
        providerCalls++;
        controller.abort();
      },
      async *chat() {},
    };

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'stop before tools' }],
      {
        onText: (_delta, full) => texts.push(full),
        dispatchTool: async () => 'unused',
        onTurnComplete: (history) => completed.push(history),
      },
      { provider, tools: [tool], maxTurns: 3, signal: controller.signal },
    );

    expect(providerCalls).toBe(1);
    expect(result).toBe('');
    expect(texts).toEqual([]);
    expect(completed).toHaveLength(1);
    expect(log.mock.calls.filter(([, event]) => event === 'tool-loop.aborted-without-tools')).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('llm.router', 'tool-loop.aborted-without-tools', {
      turn: 1,
      textChars: 0,
    });
    expect(log.mock.calls.filter(([, event]) => event === 'tool-loop.max-turns.no-final-synthesis')).toHaveLength(0);
    log.mockRestore();
  });

  test('appends only a brief Korean cancellation notice when aborted after a tool call', async () => {
    const controller = new AbortController();
    const log = spyOn(debug, 'log');
    let call = 0;
    const provider: LLMProvider = {
      name: 'scripted',
      defaultModel: 'scripted-model',
      available: () => true,
      async *streamChat() {
        if (call++ === 0) {
          yield { type: 'tool_call', id: 'inspect-1', name: 'inspect', args: {} };
        }
      },
      async *chat() {},
    };

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'inspect once' }],
      {
        onText: () => {},
        dispatchTool: async () => {
          controller.abort();
          return 'inspected';
        },
      },
      { provider, tools: [tool], maxTurns: 3, signal: controller.signal },
    );

    expect(result).toBe('⏹️ 중단했습니다.');
    expect(result).not.toContain('[NO FINAL SYNTHESIS]');
    expect(result).not.toContain('===== EXPLORATION GATHERED =====');
    expect(log).toHaveBeenCalledWith('llm.router', 'tool-loop.max-turns.no-final-synthesis', expect.objectContaining({
      turn: 1,
      maxTurns: 3,
      trigger: 'aborted',
    }));
    log.mockRestore();
  });

  test('preserves streamed text before appending the cancellation notice after a tool call', async () => {
    const controller = new AbortController();
    let call = 0;
    const provider: LLMProvider = {
      name: 'scripted',
      defaultModel: 'scripted-model',
      available: () => true,
      async *streamChat() {
        if (call++ === 0) {
          yield { type: 'tool_call', id: 'inspect-1', name: 'inspect', args: {} };
          return;
        }
        yield { type: 'text', delta: '중단 전 본문' };
        controller.abort();
        yield { type: 'tool_call', id: 'inspect-2', name: 'inspect', args: {} };
      },
      async *chat() {},
    };

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'inspect and interrupt' }],
      { onText: () => {}, dispatchTool: async () => 'inspected' },
      { provider, tools: [tool], maxTurns: 3, signal: controller.signal },
    );

    expect(result).toBe('중단 전 본문\n\n⏹️ 중단했습니다.');
    expect(result).not.toContain('[NO FINAL SYNTHESIS]');
    expect(result).not.toContain('===== EXPLORATION GATHERED =====');
  });

  test('preserves the budget-exhausted terminal record when no abort signal arrives', async () => {
    const log = spyOn(debug, 'log');
    let call = 0;
    const provider: LLMProvider = {
      name: 'scripted',
      defaultModel: 'scripted-model',
      available: () => true,
      async *streamChat() {
        yield { type: 'tool_call', id: `inspect-${++call}`, name: 'inspect', args: {} };
      },
      async *chat() {},
    };

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'inspect twice' }],
      { onText: () => {}, dispatchTool: async () => 'inspected' },
      { provider, tools: [tool], maxTurns: 2 },
    );

    expect(result).toContain('The model used the available tool-loop turns without writing a plain-text answer.');
    expect(result).toContain('===== EXPLORATION GATHERED =====');
    expect(result).toContain('inspect');
    expect(log).toHaveBeenCalledWith('llm.router', 'tool-loop.max-turns.no-final-synthesis', expect.objectContaining({
      turn: 2,
      maxTurns: 2,
      trigger: 'budget-exhausted',
    }));
    log.mockRestore();
  });
});

describe('streamLLMWithTools final verification evidence', () => {
  test('deduplicates repeated changed files and verification flows in first-seen order', async () => {
    const turns: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'edit-1', name: 'Edit', args: { file_path: '/tmp/repeated.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'verify-1', name: 'RunShell', args: { command: ['bun', 'test', 'test/repeated.test.ts'] } }],
      [{ type: 'tool_call', id: 'edit-2', name: 'Edit', args: { file_path: '/tmp/repeated.ts', old_string: 'b', new_string: 'c' } }],
      [{ type: 'tool_call', id: 'verify-2', name: 'RunShell', args: { command: ['bun', 'test', 'test/repeated.test.ts'] } }],
      [{ type: 'text', delta: 'Repeated verification is complete.' }],
    ];
    let call = 0;
    const provider: LLMProvider = {
      name: 'scripted',
      defaultModel: 'gpt-5.4',
      available: () => true,
      async *streamChat() {
        for (const event of turns[call++] ?? []) yield event;
      },
      async *chat() {},
    };

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'edit and verify the repeated file' }],
      {
        onText: () => {},
        dispatchTool: async (name) => name === 'RunShell'
          ? { output: 'PASS test/repeated.test.ts', stdout: 'PASS test/repeated.test.ts', exitCode: 0, outcome: 'exit' }
          : { output: 'edited /tmp/repeated.ts' },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 6,
      },
    );

    expect(result).toContain('변경 파일: /tmp/repeated.ts');
    expect(result).not.toContain('/tmp/repeated.ts, /tmp/repeated.ts');
    expect(result).toContain('최근 검증 흐름: bun test test/repeated.test.ts -> PASS (PASS test/repeated.test.ts)');
    expect(result).not.toContain(' | bun test test/repeated.test.ts -> PASS (PASS test/repeated.test.ts)');
  });

  // ⭐ 아래 둘이 「자율 판 셋을 가른 «결정»」을 문다. 위 시험은 「같은 PASS 둘」만 보므로
  //   세 판이 «전부» 통과했다 — 즉 결정 자체는 «안 재고» 있었다(2026-08-28 실측).
  //   ⛔ 이 둘을 지우면 다음 판이 어느 설계를 골라도 초록이 된다.
  function scriptedRun(turns: LLMStreamEvent[][], shell: (call: number) => Record<string, unknown>) {
    let call = 0;
    let shellCall = 0;
    const provider: LLMProvider = {
      name: 'scripted', defaultModel: 'gpt-5.4', available: () => true,
      async *streamChat() { for (const event of turns[call++] ?? []) yield event; },
      async *chat() {},
    };
    return streamLLMWithTools(
      [{ role: 'user', content: 'edit and verify' }],
      {
        onText: () => {},
        dispatchTool: async (name) => name === 'RunShell' ? shell(shellCall++) : { output: 'edited /tmp/a.ts' },
      },
      {
        provider, model: 'gpt-5.4',
        tools: [
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
  }
  const scriptedEdit = (id: string): LLMStreamEvent[] => [{ type: 'tool_call', id, name: 'Edit', args: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' } }];
  const scriptedVerify = (id: string, command: string[]): LLMStreamEvent[] => [{ type: 'tool_call', id, name: 'RunShell', args: { command } }];

  test('같은 명령이라도 성패가 다르면 «둘 다» 남는다 — 산출이 비어도(동일성에 ok 가 들어간다)', async () => {
    // 📍 summary 는 `executionSummary ?? ''` 라 «빈 문자열»이 될 수 있다(llm.ts) ⇒ command+summary 만으로
    //    동일성을 보면 FAIL→PASS 전이가 «한 줄로 뭉개진다». 그래서 기존 summarizeVerifyFingerprint 를
    //    그대로 쓰지 «않는다» — 그것은 루프 건강 판정용이고 ok 를 «일부러» 뺀 다른 동일성이다.
    const result = await scriptedRun(
      [scriptedEdit('e1'), scriptedVerify('v1', ['bun', 'test']), scriptedVerify('v2', ['bun', 'test']), [{ type: 'text', delta: '끝.' }]],
      (call) => call === 0
        ? { output: '', stdout: '', exitCode: 1, outcome: 'exit' }
        : { output: '', stdout: '', exitCode: 0, outcome: 'exit' },
    );
    const flow = result.split('\n').find(line => line.startsWith('최근 검증 흐름:')) ?? '';
    expect(flow).toContain('FAIL');
    expect(flow).toContain('PASS');
  });

  test('서로 다른 검증 명령 둘은 흐름에 «둘 다» 남는다(유일화가 다른 것을 지우지 않는다)', async () => {
    // 📍 ⛔ 이 시험은 「유일화가 창보다 먼저인가」는 «못 잰다» — 그 축을 재려면 원장에 [A,B,B] 가 들어가야
    //    하는데 이 하네스로는 셋째 검증이 원장에 «안 들어갔다»(2026-08-28 실측: 두 설계의 산출이 «같았다»
    //    — "bun test alpha -> FAIL (FAIL) | bun test beta -> FAIL (FAIL)").
    //    ⇒ 그러니 이 자리는 「유일화가 «다른» 항목을 지우지 않는다」까지만 지킨다. 순서 축은 «미측정»이다.
    const result = await scriptedRun(
      [scriptedEdit('e1'), scriptedVerify('v1', ['bun', 'test', 'alpha']),
       scriptedEdit('e2'), scriptedVerify('v2', ['bun', 'test', 'beta']),
       scriptedEdit('e3'), scriptedVerify('v3', ['bun', 'test', 'beta']),
       [{ type: 'text', delta: '끝.' }]],
      (call) => call < 2
        ? { output: 'FAIL', stdout: 'FAIL', exitCode: 1, outcome: 'exit' }
        : { output: 'FAIL', stdout: 'FAIL', exitCode: 1, outcome: 'exit' },
    );
    const flow = result.split('\n').find(line => line.startsWith('최근 검증 흐름:')) ?? '';
    expect(flow).toContain('alpha');
    expect(flow).toContain('beta');
  });
});

// ═══════════════════════════════════════════
// 1. toOpenAIMessage
// ═══════════════════════════════════════════

describe('toOpenAIMessage', () => {
  test('passes string content through unchanged', () => {
    const m: LLMMessage = { role: 'user', content: 'hello' };
    expect(toOpenAIMessage(m)).toEqual({ role: 'user', content: 'hello' });
  });

  test('translates text blocks to {type,text} parts', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'describe this' }] as ContentBlock[],
    };
    expect(toOpenAIMessage(m)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'describe this' }],
    });
  });

  test('encodes images as data-URL image_url entries', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
        { type: 'text',  text: 'caption please' },
      ],
    };
    const out = toOpenAIMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.role).toBe('user');
    expect(out.content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AAAA' },
    });
    expect(out.content[1]).toEqual({ type: 'text', text: 'caption please' });
  });
});

// P-3 §6.9 (2026-05-07) — toOpenAIMessages user-message image gating.
// Uses toOpenAIMessages directly because toOpenAIMessage is the
// single-message convenience and doesn't accept opts.
describe('toOpenAIMessages — userMessage image axis (P-3 §6.9 · 2026-05-07)', () => {
  // Need toOpenAIMessages (plural) — re-export reaches it.
  const { toOpenAIMessages } = require('../src/llm');

  test('default (acceptUserMessageImages=true) — user image stays as image_url', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', base64: 'XYZ' },
        { type: 'text', text: 'describe' },
      ],
    };
    const out = toOpenAIMessages(m);
    expect(out).toHaveLength(1);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,XYZ' },
    });
  });

  test('acceptUserMessageImages=false — user image becomes text placeholder', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: '/9j/' },
        { type: 'text', text: 'describe' },
      ],
    };
    const out = toOpenAIMessages(m, { acceptUserMessageImages: false });
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'text',
      text: '[image: image/jpeg (model not vision-capable)]',
    });
  });

  test('Q1=B order — text-then-image preserved across image_url + text blocks', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'compare these' },
        { type: 'image', mediaType: 'image/png', base64: 'A' },
        { type: 'image', mediaType: 'image/png', base64: 'B' },
      ],
    };
    const out = toOpenAIMessages(m);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url', 'image_url']);
  });

  test('acceptUserMessageImages=false does NOT affect tool-result followup workaround', () => {
    // Followup workaround is for tool-result images, not user-message
    // images — they're separate axes even though they both end up on
    // role: 'user' wire. The followup must still emit image_url even
    // when acceptUserMessageImages is false.
    const m: LLMMessage = {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', mediaType: 'image/png', base64: 'IMG' },
        ],
      }],
    };
    const out = toOpenAIMessages(m, {
      acceptToolImagesViaFollowup: true,
      acceptUserMessageImages: false,
    });
    // Expect a {role:'tool',...} message + a {role:'user',content:[text, image_url]} followup.
    expect(out.length).toBe(2);
    expect(out[0].role).toBe('tool');
    expect(out[1].role).toBe('user');
    const followupContent = out[1].content as Array<Record<string, unknown>>;
    expect(followupContent.find((c) => c.type === 'image_url')).toBeDefined();
  });
});

// ═══════════════════════════════════════════
// 2. toAnthropicMessage
// ═══════════════════════════════════════════

describe('toAnthropicMessage', () => {
  test('string content passes through', () => {
    const m: LLMMessage = { role: 'assistant', content: 'ok' };
    expect(toAnthropicMessage(m)).toEqual({ role: 'assistant', content: 'ok' });
  });

  test('encodes images with source.type=base64', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', base64: 'XYZ' },
        { type: 'text',  text: 'what is this?' },
      ],
    };
    const out = toAnthropicMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'XYZ' },
    });
    expect(out.content[1]).toEqual({ type: 'text', text: 'what is this?' });
  });
});

// ═══════════════════════════════════════════
// 2.5 §3.4 — audio routing (LLM-side ContentBlock 'audio' type)
// ═══════════════════════════════════════════

describe('toOpenAIMessage — audio routing (§3.4 · 2026-04-30)', () => {
  test('wav audio → input_audio with format=wav', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'audio', mediaType: 'audio/wav', base64: 'AAAA' },
        { type: 'text', text: 'transcribe' },
      ],
    };
    const out = toOpenAIMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.content[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: 'AAAA', format: 'wav' },
    });
    expect(out.content[1]).toEqual({ type: 'text', text: 'transcribe' });
  });

  test('mp3 audio → input_audio with format=mp3', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [{ type: 'audio', mediaType: 'audio/mpeg', base64: 'BBBB' }],
    };
    const out = toOpenAIMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.content[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: 'BBBB', format: 'mp3' },
    });
  });

  test('audio/mp3 alias → format=mp3', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [{ type: 'audio', mediaType: 'audio/mp3', base64: 'CCCC' }],
    };
    const out = toOpenAIMessage(m) as { content: Array<{ input_audio?: { format: string } }> };
    expect(out.content[0]!.input_audio!.format).toBe('mp3');
  });

  test('unsupported codec (ogg/opus/flac) → text placeholder (OpenAI rejects non-wav/mp3)', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [{ type: 'audio', mediaType: 'audio/ogg', base64: 'DDDD' }],
    };
    const out = toOpenAIMessage(m) as { content: Array<Record<string, unknown>> };
    expect(out.content[0]).toEqual({
      type: 'text',
      text: '[audio: audio/ogg (unsupported codec)]',
    });
  });

  test('audio + image + text mixed', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'audio', mediaType: 'audio/wav', base64: 'AUD' },
        { type: 'image', mediaType: 'image/png', base64: 'IMG' },
        { type: 'text', text: 'what?' },
      ],
    };
    const out = toOpenAIMessage(m) as { content: Array<Record<string, unknown>> };
    expect(out.content.map((c) => c.type)).toEqual(['input_audio', 'image_url', 'text']);
  });
});

describe('toAnthropicMessage — audio routing (§3.4 · 2026-04-30)', () => {
  test('audio block → text placeholder (Anthropic Messages API has no audio support as of 2026-04)', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'audio', mediaType: 'audio/wav', base64: 'AAAA' },
        { type: 'text', text: 'hi' },
      ],
    };
    const out = toAnthropicMessage(m) as { content: Array<Record<string, unknown>> };
    expect(out.content[0]).toEqual({ type: 'text', text: '[audio: audio/wav]' });
    expect(out.content[1]).toEqual({ type: 'text', text: 'hi' });
  });
});

// P-3 §6.9 (2026-05-07) — user-message image gating.
describe('toAnthropicMessage — userMessage image gating (P-3 §6.9 · 2026-05-07)', () => {
  test('default (acceptUserMessageImages=true) — user image passes through as base64 image block', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', mediaType: 'image/png', base64: 'XYZ' },
      ],
    };
    const out = toAnthropicMessage(m) as { content: Array<Record<string, unknown>> };
    expect(out.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'XYZ' },
    });
  });

  test('acceptUserMessageImages=false — user image becomes text placeholder', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
      ],
    };
    const out = toAnthropicMessage(m, { acceptUserMessageImages: false }) as {
      content: Array<Record<string, unknown>>;
    };
    expect(out.content[1]).toEqual({
      type: 'text',
      text: '[image: image/jpeg (model not vision-capable)]',
    });
  });

  test('acceptUserMessageImages=false does NOT affect assistant-role images', () => {
    const m: LLMMessage = {
      role: 'assistant',
      content: [
        { type: 'image', mediaType: 'image/png', base64: 'YYY' },
      ],
    };
    const out = toAnthropicMessage(m, { acceptUserMessageImages: false }) as {
      content: Array<Record<string, unknown>>;
    };
    expect(out.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'YYY' },
    });
  });

  test('Q1=B ordering — text-then-image array preserves order in wire shape', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'compare these' },
        { type: 'image', mediaType: 'image/png', base64: 'A' },
        { type: 'image', mediaType: 'image/png', base64: 'B' },
      ],
    };
    const out = toAnthropicMessage(m) as { content: Array<{ type: string }> };
    expect(out.content.map((b) => b.type)).toEqual(['text', 'image', 'image']);
  });
});

// ═══════════════════════════════════════════
// 3. systemToAnthropicString
// ═══════════════════════════════════════════

describe('providerSupportsAudio (§3.4 · 2026-04-30)', () => {
  // Need a separate import block — providerSupportsAudio is in
  // src/llm.ts. We dynamically require to avoid touching the
  // existing import line.
  const { providerSupportsAudio } = require('../src/llm');

  test('OpenAI gpt-4o-audio-preview → true', () => {
    expect(providerSupportsAudio('gpt-4o-audio-preview')).toBe(true);
    expect(providerSupportsAudio('gpt-4o-audio-preview-2024-10-01')).toBe(true);
  });

  test('OpenAI gpt-4o-realtime-preview → true', () => {
    expect(providerSupportsAudio('gpt-4o-realtime-preview')).toBe(true);
    expect(providerSupportsAudio('gpt-4o-realtime-preview-2024-12-17')).toBe(true);
  });

  test('OpenAI plain gpt-4o / gpt-4o-mini → false', () => {
    expect(providerSupportsAudio('gpt-4o')).toBe(false);
    expect(providerSupportsAudio('gpt-4o-mini')).toBe(false);
    expect(providerSupportsAudio('gpt-4-turbo')).toBe(false);
  });

  test('Anthropic Claude → false (Messages API has no audio as of 2026-04)', () => {
    expect(providerSupportsAudio('claude-opus-4-7')).toBe(false);
    expect(providerSupportsAudio('claude-sonnet-4-6')).toBe(false);
    expect(providerSupportsAudio('claude-haiku-4-5')).toBe(false);
  });

  test('xAI Grok → false (Chat Completions has no audio; Voice Agent is separate WS endpoint)', () => {
    expect(providerSupportsAudio('grok-4')).toBe(false);
    expect(providerSupportsAudio('grok-4-0709')).toBe(false);
    // Even Grok's voice-think model is via Voice Agent WS, not Chat Completions
    expect(providerSupportsAudio('grok-voice-think-fast-1.0')).toBe(false);
  });

  test('Gemini 1.5+ → true (W8-A 후속 #3 · 2026-05-14 native generateContent audio land)', () => {
    expect(providerSupportsAudio('gemini-3-flash-preview')).toBe(true);
    expect(providerSupportsAudio('gemini-1.5-pro')).toBe(true);
    expect(providerSupportsAudio('gemini-1.5-flash')).toBe(true);
    expect(providerSupportsAudio('gemini-2.0-pro-exp')).toBe(true);
  });

  test('local / unknown → false', () => {
    expect(providerSupportsAudio('llama3')).toBe(false);
    expect(providerSupportsAudio('')).toBe(false);
    expect(providerSupportsAudio('unknown-model')).toBe(false);
  });

  test('case-insensitive', () => {
    expect(providerSupportsAudio('GPT-4O-AUDIO-PREVIEW')).toBe(true);
    expect(providerSupportsAudio('Gpt-4o-Realtime-Preview')).toBe(true);
  });
});

describe('systemToAnthropicString', () => {
  test('joins multiple system messages with blank lines', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'tone: terse' },
      { role: 'system', content: 'format: markdown' },
      { role: 'user',   content: 'hi' },
    ];
    expect(systemToAnthropicString(msgs)).toBe('tone: terse\n\nformat: markdown');
  });

  test('extracts text blocks from ContentBlock[] system messages', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'rule A' },
          { type: 'image', mediaType: 'image/png', base64: '...' },  // dropped
          { type: 'text', text: 'rule B' },
        ],
      },
    ];
    expect(systemToAnthropicString(msgs)).toBe('rule A\n\nrule B');
  });

  test('returns empty string with no system messages', () => {
    expect(systemToAnthropicString([{ role: 'user', content: 'hi' }])).toBe('');
  });
});

// ═══════════════════════════════════════════
// 4. buildMessagesWithContext
// ═══════════════════════════════════════════

describe('buildMessagesWithContext', () => {
  test('returns a plain-text user message when the registry is empty', () => {
    const reg = createContextRegistry();
    const msgs = buildMessagesWithContext('summarize this', reg);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'summarize this' });
  });

  test('prepends system prompt when provided', () => {
    const reg = createContextRegistry();
    const msgs = buildMessagesWithContext('hi', reg, 'You are a helpful assistant.');

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(msgs[1]!.content).toBe('hi');
  });

  test('inlines loaded text attachments as labeled fenced sections', () => {
    const reg = createContextRegistry();
    seedLoadedText(reg, 'report.md', 'md',  '# Title\nbody');
    seedLoadedText(reg, 'slides.pdf', 'pdf', 'page 1 text');

    const msgs = buildMessagesWithContext('요약해줘', reg);
    const content = msgs[0]!.content as string;

    expect(typeof content).toBe('string');
    expect(content).toContain('[Attached Markdown #1: report.md]');
    expect(content).toContain('# Title\nbody');
    expect(content).toContain('[Attached PDF #2: slides.pdf]');
    expect(content).toContain('page 1 text');
    expect(content.endsWith('요약해줘')).toBe(true);
  });

  test('skips unloaded attachments entirely', () => {
    const reg = createContextRegistry();
    // Registered but never loaded — should NOT appear.
    addAttachment(reg, {
      kind: 'pdf',
      sourcePath: '/tmp/unloaded.pdf',
      filename: 'unloaded.pdf',
      sizeBytes: 100,
      mtime: 1,
    });

    const msgs = buildMessagesWithContext('hi', reg);
    expect(msgs[0]!.content).toBe('hi');
  });

  test('switches to ContentBlock[] when images are present', () => {
    const reg = createContextRegistry();
    seedLoadedText(reg, 'readme.txt', 'text', 'context line');
    seedImage(reg, 'chart.png', 'IMGDATA');

    const msgs = buildMessagesWithContext('explain', reg);
    expect(Array.isArray(msgs[0]!.content)).toBe(true);

    const blocks = msgs[0]!.content as ContentBlock[];
    expect(blocks[0]).toEqual({ type: 'image', mediaType: 'image/png', base64: 'IMGDATA' });

    const text = blocks[1] as { type: 'text'; text: string };
    expect(text.type).toBe('text');
    expect(text.text).toContain('[Attached Text #1: readme.txt]');
    expect(text.text).toContain('context line');
    expect(text.text.endsWith('explain')).toBe(true);
  });

  test('images without base64 (unloaded) are ignored', () => {
    const reg = createContextRegistry();
    // Image registered but base64 never populated → treated as absent.
    addAttachment(reg, {
      kind: 'image',
      sourcePath: '/tmp/pending.png',
      filename: 'pending.png',
      sizeBytes: 4096,
      mtime: 1,
    });

    const msgs = buildMessagesWithContext('go', reg);
    expect(msgs[0]!.content).toBe('go');   // stayed as plain string
  });
});

// ═══════════════════════════════════════════
// 4. isLikelyVisionModel
// ═══════════════════════════════════════════

describe('isLikelyVisionModel', () => {
  test('Claude 3/4 family recognized', () => {
    expect(isLikelyVisionModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isLikelyVisionModel('claude-opus-4-6')).toBe(true);
    expect(isLikelyVisionModel('claude-sonnet-4-5')).toBe(true);
  });

  test('OpenAI vision-capable models recognized', () => {
    expect(isLikelyVisionModel('gpt-4o-mini')).toBe(true);
    expect(isLikelyVisionModel('gpt-4.1-preview')).toBe(true);
    expect(isLikelyVisionModel('gpt-4-turbo-2024-04-09')).toBe(true);
    expect(isLikelyVisionModel('o1-preview')).toBe(true);
    expect(isLikelyVisionModel('o3-mini')).toBe(true);
  });

  test('OpenAI text-only models rejected', () => {
    expect(isLikelyVisionModel('gpt-3.5-turbo')).toBe(false);
    expect(isLikelyVisionModel('text-davinci-003')).toBe(false);
  });

  test('Grok-4 series and explicit vision SKUs recognized', () => {
    expect(isLikelyVisionModel('grok-4-1-fast')).toBe(true);
    expect(isLikelyVisionModel('grok-2-vision')).toBe(true);
  });

  test('Grok-3 rejected (text-only)', () => {
    expect(isLikelyVisionModel('grok-3')).toBe(false);
    expect(isLikelyVisionModel('grok-3-mini')).toBe(false);
  });

  test('Gemini accepted', () => {
    expect(isLikelyVisionModel('gemini-1.5-pro')).toBe(true);
  });

  test('Unknown local model rejected (conservative default)', () => {
    expect(isLikelyVisionModel('local:llama3')).toBe(false);
    expect(isLikelyVisionModel(undefined)).toBe(false);
    expect(isLikelyVisionModel('')).toBe(false);
  });

  test('Case-insensitive', () => {
    expect(isLikelyVisionModel('CLAUDE-OPUS-4-6')).toBe(true);
    expect(isLikelyVisionModel('Gpt-4O-Mini')).toBe(true);
  });
});
