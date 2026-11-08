// Entry-point integration tests for the local OpenAI-compatible provider.
//
// These tests go all the way through the REAL provider resolver and
// the REAL runTurn() path in src/session-chat.ts — the only thing
// stubbed is `globalThis.fetch`. That proves:
//
//   1. user-config.llm = { provider:'local', baseUrl, model } resolves
//      to the LocalProvider (not OpenAI, not anything else).
//   2. The streamChat adapter posts to `${baseUrl}/chat/completions`
//      with the model id + messages in OpenAI wire format.
//   3. SSE framing is parsed and surfaced through runTurn as text,
//      then persisted to the session JSONL.
//   4. A bearer token from user-config.llm.apiKey is forwarded.
//
// Those four facts are what "compatibility" means for elanous — if
// they hold against our mock, swapping in any OpenAI-compatible
// endpoint (LM Studio, vLLM, llama.cpp server) is plug-and-play.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, loadSession } from '../src/session/index.js';
import { runTurn } from '../src/session/chat.js';
import { getProviderForConfig, LocalProvider } from '../src/llm.js';
import type { UserConfig } from '../src/user-config.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

// ── Fixtures ─────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};
let tmpRoot: string;
let fakeFetch: FakeFetchDevice | undefined;
let expectedFetchCalls: string[] | undefined;

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, callCount = 1): void {
  fakeFetch?.restore();
  const baseUrl = (process.env.LOCAL_LLM_URL ?? 'http://192.168.0.50:1234').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  expectedFetchCalls = Array.from({ length: callCount }, () => `POST ${url}`);
  fakeFetch = createFakeFetchDevice([{
    url,
    method: 'POST',
    response: (request) => handler(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body !== null ? { body: request.body } : {}),
      signal: request.signal,
    }),
  }]);
}

function sseRes(events: unknown[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const ev of events) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function baseConfig(overrides: Partial<UserConfig['llm']> = {}): UserConfig {
  return {
    skillRouter: {
      autoRoute: false, autoRouteCountdownMs: 1000, llmFallback: false,
      keywordScoreThreshold: 2, llmConfidenceThreshold: 0.5,
      autoRouteMinScore: 1, autoRouteRequireAutoTrigger: true,
    },
    llm: {
      provider: 'local',
      baseUrl: 'http://192.168.0.50:1234',
      model: 'mlx-community/gemma-4-26b-a4b-it',
      ...overrides,
    },
    skills: { activeSet: 'opencode', dirs: [] },
    obsidian: { vault: '/tmp/v' },
    telegram: { enabled: false, allowedUsers: [] },
    discord: { enabled: false, allowedUsers: [] },
    onboarding: { completed: true, version: 1 },
    debug: { file: false },
    raw: {},
  };
}

beforeEach(() => {
  // Give each test its own sessions/state root so the on-disk JSONL
  // from runTurn() doesn't leak across tests or into the user's real
  // store. ELANOUS_STATE_DIR is what `sessionRoot()` honors — XDG alone is
  // NOT enough. 2026-07-09 rooted the store at ~/.elanous and made XDG an
  // explicit no-op (src/session/index.ts:56-58), which silently turned
  // this isolation off and leaked ~86 runs' worth of fixture sessions
  // (entry-point-test / err-test / stream-test / …) into the real store.
  // Keep XDG for anything else that still reads it.
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-local-entry-'));
  savedEnv.ELANOUS_STATE_DIR = process.env.ELANOUS_STATE_DIR;
  savedEnv.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
  savedEnv.XDG_STATE_HOME = process.env.XDG_STATE_HOME;
  savedEnv.LOCAL_LLM_URL = process.env.LOCAL_LLM_URL;
  savedEnv.LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL;
  process.env.ELANOUS_STATE_DIR = join(tmpRoot, 'state');
  process.env.XDG_DATA_HOME = join(tmpRoot, 'data');
  process.env.XDG_STATE_HOME = join(tmpRoot, 'state');
  // Explicitly clear env — we want tests to prove user-config drives
  // the provider, not LOCAL_LLM_URL env leakage.
  delete process.env.LOCAL_LLM_URL;
  delete process.env.LOCAL_LLM_MODEL;
});

afterEach(() => {
  try {
    if (fakeFetch && expectedFetchCalls) {
      expect(fakeFetch.calls().map(({ method, url }) => `${method} ${url}`).sort()).toEqual([...expectedFetchCalls].sort());
    }
  } finally {
    fakeFetch?.restore();
    fakeFetch = undefined;
    expectedFetchCalls = undefined;
    rmSync(tmpRoot, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── Provider resolution ──────────────────────────────────────

describe('getProviderForConfig — local provider', () => {
  it('user-config provider=local routes to LocalProvider-shaped adapter', () => {
    const cfg = baseConfig();
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('local');
    expect(p.defaultModel).toBe('mlx-community/gemma-4-26b-a4b-it');
    expect(p.available()).toBe(true);
  });

  it('missing baseUrl raises a clear error (not a cryptic fetch crash)', () => {
    const cfg = baseConfig({ baseUrl: undefined });
    expect(() => getProviderForConfig(cfg)).toThrow(/Local LLM unavailable/);
  });

  it('falls back to LOCAL_LLM_URL env when user-config baseUrl empty', () => {
    process.env.LOCAL_LLM_URL = 'http://192.168.0.50:1234/v1';
    const cfg = baseConfig({ baseUrl: undefined });
    const p = getProviderForConfig(cfg);
    expect(p.name).toBe('local');
  });
});

// ── Wire format via runTurn ──────────────────────────────────

describe('runTurn — local provider end-to-end', () => {
  it('POSTs to {baseUrl}/chat/completions with model id + messages', async () => {
    let sawUrl = '';
    let sawBody: any = null;
    installFetch((url, init) => {
      sawUrl = url;
      sawBody = init?.body ? JSON.parse(init.body as string) : null;
      return sseRes([
        { choices: [{ delta: { content: 'hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
      ]);
    });

    const cfg = baseConfig();
    const meta = createSession({
      source: 'cli',
      provider: 'local',
      model: cfg.llm.model!,
      title: 'entry-point-test',
    });
    const result = await runTurn({
      userConfig: cfg,
      sessionId: meta.id,
      userText: 'say hi',
      skipMemoryInjection: true,
    });

    // (1) Routing: hit the local endpoint, not OpenAI / Anthropic.
    expect(sawUrl).toBe('http://192.168.0.50:1234/chat/completions');
    expect(sawUrl).not.toContain('openai');
    expect(sawUrl).not.toContain('anthropic');
    expect(sawUrl).not.toContain('x.ai');

    // (2) Wire format: OpenAI-style body with the target model id.
    expect(sawBody.model).toBe('mlx-community/gemma-4-26b-a4b-it');
    expect(Array.isArray(sawBody.messages)).toBe(true);
    const lastMsg = sawBody.messages[sawBody.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toBe('say hi');

    // (3) Response: SSE decoded, text surfaced, session updated.
    expect(result.text).toBe('hello world');
    expect(result.provider).toBe('local');
    expect(result.model).toBe('mlx-community/gemma-4-26b-a4b-it');

    // (4) Persistence: user + assistant turns written to JSONL.
    const loaded = loadSession(meta.id);
    expect(loaded).toBeTruthy();
    const msgs = loaded!.messages;
    expect(msgs.some(m => m.role === 'user' && m.content === 'say hi')).toBe(true);
    expect(msgs.some(m => m.role === 'assistant' && m.content === 'hello world')).toBe(true);
  });

  it('forwards user-config apiKey as Bearer auth for gated endpoints', async () => {
    let sawAuth: string | null = null;
    installFetch((_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sawAuth = headers.authorization ?? (headers as any).Authorization ?? null;
      return sseRes([{ choices: [{ delta: { content: 'ok' } }] }]);
    });

    const cfg = baseConfig({ apiKey: 'sk-local-test' });
    const meta = createSession({
      source: 'cli', provider: 'local', model: cfg.llm.model!, title: 'auth-test',
    });
    await runTurn({
      userConfig: cfg,
      sessionId: meta.id,
      userText: 'ping',
      skipMemoryInjection: true,
    });
    expect(sawAuth).toBe('Bearer sk-local-test');
  });

  it('handles the exact gemma model id without rejection', async () => {
    // Regression guard: the model id contains a slash and hyphens
    // (mlx-community/gemma-4-26b-a4b-it). Earlier versions of the
    // provider stripped `local:` prefixes, so make sure NO filtering
    // mangles the bare id.
    let sawModel = '';
    installFetch((_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      sawModel = body.model;
      return sseRes([{ choices: [{ delta: { content: '.' } }] }]);
    });
    const cfg = baseConfig();
    const meta = createSession({
      source: 'cli', provider: 'local', model: cfg.llm.model!, title: 'modelid-test',
    });
    await runTurn({
      userConfig: cfg,
      sessionId: meta.id,
      userText: 'x',
      skipMemoryInjection: true,
    });
    expect(sawModel).toBe('mlx-community/gemma-4-26b-a4b-it');
  });

  it('onDelta is called as the SSE stream arrives', async () => {
    installFetch(() => sseRes([
      { choices: [{ delta: { content: 'A' } }] },
      { choices: [{ delta: { content: 'B' } }] },
      { choices: [{ delta: { content: 'C' } }] },
    ]));
    const cfg = baseConfig();
    const meta = createSession({
      source: 'cli', provider: 'local', model: cfg.llm.model!, title: 'stream-test',
    });
    const deltas: string[] = [];
    const result = await runTurn({
      userConfig: cfg,
      sessionId: meta.id,
      userText: 'stream',
      skipMemoryInjection: true,
      onDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(['A', 'B', 'C']);
    expect(result.text).toBe('ABC');
  });

  it('a non-2xx response surfaces as an error through runTurn', async () => {
    installFetch(() => jsonRes({ error: 'model not loaded' }, 503), 3);
    const cfg = baseConfig();
    const meta = createSession({
      source: 'cli', provider: 'local', model: cfg.llm.model!, title: 'err-test',
    });
    await expect(runTurn({
      userConfig: cfg,
      sessionId: meta.id,
      userText: 'x',
      skipMemoryInjection: true,
    })).rejects.toThrow();
  });
});

// ── Raw LocalProvider via env ────────────────────────────────

describe('LocalProvider — env-var driven fallback', () => {
  it('reads LOCAL_LLM_URL + LOCAL_LLM_MODEL when config is not explicit', async () => {
    // The `PROVIDERS.local` / `LocalProvider` export is used when the
    // user-config provider is 'auto' and LOCAL_LLM_URL is set. Keep it
    // wired even after we moved the primary path to
    // getProviderForConfig.
    process.env.LOCAL_LLM_URL = 'http://10.0.0.5:9999';
    // LocalProvider is constructed at import time with the current
    // env values — available() re-reads so setting the env after
    // import still flips it on.
    expect(LocalProvider.name).toBe('local');
    expect(LocalProvider.available()).toBe(true);

    let sawUrl = '';
    installFetch((url) => {
      sawUrl = url;
      return sseRes([{ choices: [{ delta: { content: 'ok' } }] }]);
    });
    const stream = LocalProvider.streamChat!(
      [{ role: 'user', content: 'hi' }],
      { model: 'some-id', temperature: 0 },
    );
    for await (const _ of stream) { /* drain */ }
    expect(sawUrl).toContain('10.0.0.5:9999');
    expect(sawUrl).toContain('/chat/completions');
  });
});

// ── Cross-cutting: telegram /local + chat /local registered ──

describe('LocalProvider — effective template thinking state', () => {
  async function requestBodyFor(messages: Parameters<NonNullable<typeof LocalProvider.streamChat>>[0], model: string): Promise<Record<string, unknown>> {
    let requestBody: Record<string, unknown> | undefined;
    installFetch((_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseRes([{ choices: [{ delta: { content: 'ok' } }] }]);
    });
    for await (const _ of LocalProvider.streamChat!(messages, { model })) { /* drain */ }
    return requestBody!;
  }

  beforeEach(() => {
    process.env.LOCAL_LLM_URL = 'http://10.0.0.5:9999';
  });

  it('preserves the model-selected non-thinking preset when no template tag is present', async () => {
    const requestBody = await requestBodyFor(
      [{ role: 'user', content: 'answer briefly' }],
      'qwen3-instruct-2507',
    );

    expect(requestBody).toMatchObject({
      temperature: 0.7,
      top_p: 0.8,
      presence_penalty: 1.5,
      max_tokens: 4096,
    });
  });

  it('omits presence_penalty when the selected preset leaves it unset', async () => {
    const requestBody = await requestBodyFor(
      [{ role: 'user', content: '/think answer carefully' }],
      'qwen3-instruct-2507',
    );

    expect(requestBody).not.toHaveProperty('presence_penalty');
  });

  it('uses the thinking preset after the current user template explicitly enables thinking', async () => {
    const requestBody = await requestBodyFor(
      [{ role: 'system', content: '/no_think historical instruction' }, { role: 'user', content: '/think answer carefully' }],
      'qwen3-instruct-2507',
    );

    expect(requestBody).toMatchObject({ temperature: 0.6, top_p: 0.95, max_tokens: 8192 });
  });

  it('uses the non-thinking preset when the assembled template disables thinking', async () => {
    const requestBody = await requestBodyFor(
      [{ role: 'user', content: '/no_think answer briefly' }],
      'qwen3.6-35b-a3b-ud-mlx',
    );

    expect(requestBody).toMatchObject({ temperature: 0.7, top_p: 0.8, max_tokens: 4096 });
    expect(requestBody.messages).toEqual([{ role: 'user', content: '/no_think answer briefly' }]);
  });

  it('uses the latest user turn rather than historical thinking directives', async () => {
    const disabled = await requestBodyFor(
      [
        { role: 'user', content: '/think historical request' },
        { role: 'assistant', content: 'historical answer' },
        { role: 'user', content: '/no_think current request' },
      ],
      'qwen3.6-35b-a3b-ud-mlx',
    );
    const enabled = await requestBodyFor(
      [
        { role: 'user', content: '/no_think historical request' },
        { role: 'assistant', content: 'historical answer' },
        { role: 'user', content: '/think current request' },
      ],
      'qwen3-instruct-2507',
    );

    expect(disabled).toMatchObject({ temperature: 0.7, top_p: 0.8, max_tokens: 4096 });
    expect(enabled).toMatchObject({ temperature: 0.6, top_p: 0.95, max_tokens: 8192 });
  });

  it('uses the final consecutive template tag as the effective thinking state', async () => {
    const disabled = await requestBodyFor(
      [{ role: 'user', content: '/think /no_think answer briefly' }],
      'qwen3.6-35b-a3b-ud-mlx',
    );
    const enabled = await requestBodyFor(
      [{ role: 'user', content: '/no_think /think answer carefully' }],
      'qwen3.6-35b-a3b-ud-mlx',
    );

    expect(disabled).toMatchObject({ temperature: 0.7, top_p: 0.8, max_tokens: 4096 });
    expect(enabled).toMatchObject({ temperature: 0.6, top_p: 0.95, max_tokens: 8192 });
  });
});

// ── Cross-cutting: telegram /local + chat /local registered ──

describe('slash command registration', () => {
  it('`/local` exists in the chat SLASH_COMMANDS registry', async () => {
    const { SLASH_COMMANDS } = await import('../src/chat/index.js');
    const local = SLASH_COMMANDS.find(c => c.name === 'local');
    expect(local).toBeDefined();
    expect(local!.subcommands).toContain('ping');
    expect(local!.subcommands).toContain('test');
  });

  it('`/local` exists in the default Telegram commands', async () => {
    const { defaultTelegramCommands } = await import('../src/telegram-commands.js');
    const cmds = defaultTelegramCommands();
    const local = cmds.find(c => c.name === 'local');
    expect(local).toBeDefined();
    expect(local!.streaming).toBe(true);
  });
});
