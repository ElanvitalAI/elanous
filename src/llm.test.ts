import { setDefaultTimeout, expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { _usesAdaptiveThinkingForContractTest, AnthropicProvider, PROVIDERS, streamLLM, streamLLMWithTools, type LLMProvider } from './llm.js';

async function observeDone(run: () => Promise<unknown>) {
  const done: Record<string, unknown>[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.router.done' && event === 'streamLLM') done.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    await run();
    return done;
  } finally {
    log.mockRestore();
  }
}

test('streamLLM always consumes streamChat usage, aggregates raw fields, and preserves callback fail-softness', async () => {
  let chatCalls = 0;
  let streamCalls = 0;
  const provider: LLMProvider = {
    name: 'grok',
    defaultModel: 'grok-4.6',
    available: () => true,
    async *chat() { chatCalls++; yield 'fallback'; },
    async *streamChat() {
      streamCalls++;
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 2 } };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, cacheCreationInputTokens: 1 } };
      yield { type: 'text', delta: 'answer' };
    },
  };
  const usages: number[] = [];
  const chunks: string[] = [];
  let withCallback = '';
  let withoutCallback = '';
  const done = await observeDone(async () => {
    withCallback = await streamLLM([{ role: 'user', content: 'question' }], (delta) => chunks.push(delta), {
      provider,
      onUsage: ({ inputTokens }) => {
        usages.push(inputTokens ?? 0);
        throw new Error('telemetry unavailable');
      },
    });
    withoutCallback = await streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider });
  });

  expect(withCallback).toBe('answer');
  expect(withoutCallback).toBe('answer');
  expect(usages).toEqual([12, 8]);
  expect(chunks).toEqual(['answer']);
  expect(chatCalls).toBe(0);
  expect(streamCalls).toBe(2);
  expect(done).toHaveLength(2);
  expect(done.map((entry) => entry.usage)).toEqual([
    { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 },
    { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 },
  ]);
});

test('streamLLM retains chat fallback and observes usage as unmeasured without streamChat', async () => {
  let chatCalls = 0;
  const provider: LLMProvider = {
    name: 'grok',
    defaultModel: 'grok-4.6',
    available: () => true,
    async *chat() { chatCalls++; yield 'fallback'; },
  };
  let text = '';
  const done = await observeDone(async () => {
    text = await streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider });
  });

  expect(text).toBe('fallback');
  expect(chatCalls).toBe(1);
  expect(done).toHaveLength(1);
  expect(done[0]?.usage).toBe('unmeasured');
});

test('streamLLM preserves an injected unregistered provider at the streaming boundary', async () => {
  const provider: LLMProvider = {
    name: 'injected-test-provider',
    defaultModel: 'injected-model',
    available: () => true,
    async *chat() { yield 'injected'; },
  };

  await expect(streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider }))
    .resolves.toBe('injected');
});

test('streamLLM reroutes an incompatible Codex provider and Grok model before streaming', async () => {
  const codex = PROVIDERS['openai-codex']!;
  const grok = PROVIDERS.grok!;
  const originalCodexStream = codex.streamChat;
  const originalGrokStream = grok.streamChat;
  let codexCalls = 0;
  let receivedModel = '';
  codex.streamChat = async function* () { codexCalls++; yield { type: 'text', delta: 'wrong-provider' }; };
  grok.streamChat = async function* (_messages, opts) {
    receivedModel = opts?.model ?? '';
    yield { type: 'text', delta: 'rerouted' };
  };
  try {
    const text = await streamLLM([{ role: 'user', content: 'question' }], () => {}, {
      provider: codex,
      model: 'grok-4.6',
    });
    expect(text).toBe('rerouted');
    expect(codexCalls).toBe(0);
    expect(receivedModel).toBe('grok-4.6');
  } finally {
    codex.streamChat = originalCodexStream;
    grok.streamChat = originalGrokStream;
  }
});

test('streamLLMWithTools reroutes an incompatible Codex provider and Grok model before streaming', async () => {
  const codex = PROVIDERS['openai-codex']!;
  const grok = PROVIDERS.grok!;
  const originalCodexStream = codex.streamChat;
  const originalGrokStream = grok.streamChat;
  let codexCalls = 0;
  let receivedModel = '';
  codex.streamChat = async function* () { codexCalls++; yield { type: 'text', delta: 'wrong-provider' }; };
  grok.streamChat = async function* (_messages, opts) {
    receivedModel = opts?.model ?? '';
    yield { type: 'text', delta: 'rerouted-tools' };
  };
  try {
    const text = await streamLLMWithTools(
      [{ role: 'user', content: 'question' }],
      { onText() {}, dispatchTool: async () => 'unused' },
      { provider: codex, model: 'grok-4.6', tools: [{ name: 'unused', description: 'unused', parameters: { type: 'object', properties: {} } }] },
    );
    expect(text).toBe('rerouted-tools');
    expect(codexCalls).toBe(0);
    expect(receivedModel).toBe('grok-4.6');
  } finally {
    codex.streamChat = originalCodexStream;
    grok.streamChat = originalGrokStream;
  }
});

test('streamLLMWithTools preserves compatible provider/model pairs before streaming', async () => {
  const grok = PROVIDERS.grok!;
  const originalGrokStream = grok.streamChat;
  let receivedModel = '';
  grok.streamChat = async function* (_messages, opts) {
    receivedModel = opts?.model ?? '';
    yield { type: 'text', delta: 'compatible' };
  };
  try {
    const text = await streamLLMWithTools(
      [{ role: 'user', content: 'question' }],
      { onText() {}, dispatchTool: async () => 'unused' },
      { provider: grok, model: 'grok-4.6', tools: [{ name: 'unused', description: 'unused', parameters: { type: 'object', properties: {} } }] },
    );
    expect(text).toBe('compatible');
    expect(receivedModel).toBe('grok-4.6');
  } finally {
    grok.streamChat = originalGrokStream;
  }
});

test('Anthropic request for Claude 5.5 includes interleaved-thinking beta', async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const sent: { model: string; beta: string | null }[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_input, init) => {
    const headers = new Headers(init?.headers);
    sent.push({ model: JSON.parse(String(init?.body)).model, beta: headers.get('anthropic-beta') });
    return new Response('data: {"type":"message_stop"}\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    for await (const _event of AnthropicProvider.streamChat!([{ role: 'user', content: 'hi' }], {
      model: 'claude-sonnet-5-5', promptCache: false,
    })) { /* consume the response */ }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.model).toBe('claude-sonnet-5-5');
    expect(sent[0]?.beta?.split(',')).toContain('interleaved-thinking-2025-05-14');
  } finally {
    fetchSpy.mockRestore();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

// 🩸 2026-09-25 — 도구 루프 조립부가 reasoning 꺼진 adaptive 모델(claude-sonnet-5)에 temperature 를 보내 400.
import { anthropicTemperatureField } from './llm.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

test('adaptive thinking contract stays on 4.7+ and 5.x, not legacy 3.7/4.5', () => {
  for (const model of ['claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-4-7']) {
    expect(_usesAdaptiveThinkingForContractTest(model)).toBe(true);
  }
  for (const model of ['claude-3-7-sonnet', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku']) {
    expect(_usesAdaptiveThinkingForContractTest(model)).toBe(false);
  }
});

test('anthropic temperature field: adaptive models never get temperature, even with thinking off', () => {
  expect(anthropicTemperatureField('claude-sonnet-5', false, undefined)).toEqual({});
  expect(anthropicTemperatureField('claude-opus-5', false, 0.7)).toEqual({});
  expect(anthropicTemperatureField('claude-sonnet-4-7', false, undefined)).toEqual({});
  expect(anthropicTemperatureField('claude-haiku-4-5-20251001', false, undefined)).toEqual({ temperature: 0.3 });
  expect(anthropicTemperatureField('claude-haiku-4-5-20251001', true, undefined)).toEqual({});
  expect(anthropicTemperatureField('claude-haiku-4-5-20251001', false, 0.9)).toEqual({ temperature: 0.9 });
});

// BACKLOG B7 — anthropic 기본 모델은 사다리 best(최신 Opus)에서 파생 · 옛 haiku 상수가 아니다(대표 09-25).
test('ANTHROPIC_MODEL defaults to the anthropic ladder best model (latest Opus), not the legacy haiku constant', () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_MODEL;
  const r = Bun.spawnSync({
    cmd: [process.execPath, '-e', `import { ANTHROPIC_MODEL } from ${JSON.stringify(new URL('./config.ts', import.meta.url).href)}; import { lookupLlmTierSpec } from ${JSON.stringify(new URL('./model-tier/llm-tier-map.ts', import.meta.url).href)}; console.log(JSON.stringify({ got: ANTHROPIC_MODEL, want: lookupLlmTierSpec('anthropic', 'best').model }))`],
    env, stdout: 'pipe', stderr: 'pipe',
  });
  const { got, want } = JSON.parse(new TextDecoder().decode(r.stdout).trim());
  expect(got).toBe(want);
  expect(got).not.toContain('haiku');
});
