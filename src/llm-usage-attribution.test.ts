import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { judgeGoalTurn } from './goals/judge.js';
import { analyzeDiff } from './grok.js';
import * as llm from './llm.js';
import { PROVIDERS, streamLLM, streamLLMWithTools, type LLMProvider } from './llm.js';
import { setUserConfigOverlay } from './user-config.js';

// Tests here inject fixture providers; a global ELANOUS_TEST_FAKE_LLM=1 (gate pods) is a forced-fake fence that outranks
// them by design. The one test that pins that fence sets the switch itself, so lift it for the file and restore it.
let priorTestFakeLlm: string | undefined;
beforeAll(() => { priorTestFakeLlm = process.env.ELANOUS_TEST_FAKE_LLM; delete process.env.ELANOUS_TEST_FAKE_LLM; });
afterAll(() => { if (priorTestFakeLlm === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM; else process.env.ELANOUS_TEST_FAKE_LLM = priorTestFakeLlm; });

function bypassProvider(name: string, model: string, text: string, usage: { inputTokens: number; outputTokens: number }): LLMProvider {
  return {
    name,
    defaultModel: model,
    available: () => true,
    async *chat() { yield text; },
    async *streamChat() {
      yield { type: 'usage', usage };
      yield { type: 'text', delta: text };
    },
  };
}

async function observeAttempts(run: () => Promise<unknown>) {
  const done: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const usage: Record<string, unknown>[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.usage') usage.push((data ?? {}) as Record<string, unknown>);
    if (event !== 'streamLLM') return;
    if (category === 'llm.router.done') done.push((data ?? {}) as Record<string, unknown>);
    if (category === 'llm.router.error') errors.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    await run();
    return { done, errors, usage };
  } finally {
    log.mockRestore();
  }
}

test('streamLLM attributes measured and unmeasured usage to its active model', async () => {
  const measured: LLMProvider = {
    name: 'measured-provider',
    defaultModel: 'measured-model',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() {
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } };
      yield { type: 'text', delta: 'measured' };
    },
  };
  const unmeasured: LLMProvider = {
    name: 'unmeasured-provider',
    defaultModel: 'unmeasured-model',
    available: () => true,
    async *chat() { yield 'unmeasured'; },
  };

  const observed = await observeAttempts(async () => {
    await streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider: measured });
    await streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider: unmeasured });
  });

  expect(observed.errors).toEqual([]);
  expect(observed.done).toEqual([
    expect.objectContaining({
      provider: 'measured-provider',
      model: 'measured-model',
      textChars: 'measured'.length,
      usage: { inputTokens: 12, outputTokens: 3 },
    }),
    expect.objectContaining({
      provider: 'unmeasured-provider',
      model: 'unmeasured-model',
      textChars: 'unmeasured'.length,
      usage: 'unmeasured',
    }),
  ]);
  expect(observed.usage).toEqual([
    expect.objectContaining({ model: 'measured-model', inputTokens: 12, outputTokens: 3 }),
    expect.objectContaining({ model: 'unmeasured-model', billingProvider: 'unmeasured-provider',
      measured: false, missingReason: 'provider-usage-absent', cost: { kind: 'unknown', model: 'unmeasured-model' } }),
  ]);
  expect(observed.usage[1]).not.toHaveProperty('inputTokens');
  expect(observed.usage[1]).not.toHaveProperty('outputTokens');
});

test('tool-loop records a bounded unknown-cost row when the provider finishes without usage', async () => {
  const provider: LLMProvider = { name: 'silent-usage-provider', defaultModel: 'silent-model', available: () => true,
    async *chat() { yield 'unused'; }, async *streamChat() { yield { type: 'text', delta: 'answer' }; } };
  const observed = await observeAttempts(async () => {
    expect(await streamLLMWithTools([{ role: 'user', content: 'question' }],
      { onText() {}, dispatchTool: async () => 'unused' }, { provider, model: 'silent-model',
        tools: [{ name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } }] })).toBe('answer');
  });
  expect(observed.usage).toEqual([expect.objectContaining({ site: 'stream-llm-with-tools',
    model: 'silent-model', billingProvider: 'silent-usage-provider', measured: false,
    cost: { kind: 'unknown', model: 'silent-model' } })]);
});

test('tool-loop records a failed provider attempt without inventing tokens or zero cost', async () => {
  const provider: LLMProvider = { name: 'failed-tool-provider', defaultModel: 'failed-tool-model', available: () => true,
    async *chat() { yield 'unused'; }, async *streamChat() { throw new Error('synthetic provider outage'); } };
  const observed = await observeAttempts(async () => {
    await expect(streamLLMWithTools([{ role: 'user', content: 'question' }],
      { onText() {}, dispatchTool: async () => 'unused' }, { provider, model: 'failed-tool-model',
        tools: [{ name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } }] }))
      .rejects.toThrow('synthetic provider outage');
  });
  expect(observed.usage).toEqual([expect.objectContaining({ site: 'stream-llm-with-tools',
    model: 'failed-tool-model', billingProvider: 'failed-tool-provider', measured: false,
    missingReason: 'provider-call-failed', cost: { kind: 'unknown', model: 'failed-tool-model' } })]);
  expect(observed.usage[0]).not.toHaveProperty('inputTokens');
  expect(observed.usage[0]).not.toHaveProperty('outputTokens');
});

test('streamLLM forced fake fences provider, initialProvider, and session pin', async () => {
  let calls = 0;
  const injected: LLMProvider = {
    name: 'injected', defaultModel: 'injected-model', available: () => true,
    async *chat() { calls++; yield 'injected-reply'; },
    async *streamChat() { calls++; yield { type: 'text', delta: 'injected-reply' }; },
  };
  const keys = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE'] as const;
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const forced of [{ ELANOUS_LLM_MODE: 'fake' }, { ELANOUS_TEST_FAKE_LLM: '1' },
      { ELANOUS_UX_SIM_RUN_ID: 'forced-sim' }, { ELANOUS_SIM_UNIVERSE: '1' }]) {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, forced);
      for (const options of [{ provider: injected }, { initialProvider: injected },
        { provider: injected, preferExplicitProvider: true }]) {
        const reply = await streamLLM([{ role: 'user', content: 'question' }], () => {}, options);
        expect(reply).not.toBe('injected-reply');
      }
    }
    expect(calls).toBe(0);
  } finally {
    for (const key of keys) {
      const value = prior[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('streamLLM usageSite overrides the ledger site and omission keeps the default', async () => {
  const provider: LLMProvider = {
    name: 'usage-site-provider',
    defaultModel: 'usage-site-model',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() {
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } };
      yield { type: 'text', delta: 'answer' };
    },
  };

  const observed = await observeAttempts(async () => {
    await streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider, usageSite: 'custom-site' });
    await streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider });
  });

  expect(observed.errors).toEqual([]);
  expect(observed.usage).toEqual([
    expect.objectContaining({ site: 'custom-site' }),
    expect.objectContaining({ site: 'stream-llm' }),
  ]);
});

test('streamLLM attributes a 503 failure and fallback success to their respective active models', async () => {
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto', fallbackChain: ['codex-rotate', 'grok'] } }));
  const grokAvailable = spyOn(PROVIDERS.grok!, 'available').mockReturnValue(true);
  const initial = PROVIDERS['openai-codex']!;
  const originalStreams = new Map(Object.values(PROVIDERS).map((provider) => [provider.name, provider.streamChat]));

  try {
    for (const provider of Object.values(PROVIDERS)) {
      provider.streamChat = provider.name === initial.name
        ? async function* () { throw new Error('503 provider overloaded'); }
        : async function* () { yield { type: 'text', delta: 'fallback' }; };
    }
    const observed = await observeAttempts(async () => {
      await expect(streamLLM([{ role: 'user', content: 'question' }], () => {}, { initialProvider: initial })).resolves.toBe('fallback');
    });
    const fallbackDone = observed.done[0]!;

    expect(observed.errors).toEqual([
      expect.objectContaining({ provider: initial.name, model: initial.defaultModel, durationMs: expect.any(Number), message: '503 provider overloaded' }),
    ]);
    expect(fallbackDone).toEqual(expect.objectContaining({
      model: PROVIDERS[fallbackDone.provider as string]!.defaultModel,
      textChars: 'fallback'.length,
      usage: 'unmeasured',
    }));
    expect(fallbackDone.provider).not.toBe(initial.name);
    expect(fallbackDone.model).not.toBe(initial.defaultModel);
  } finally {
    for (const provider of Object.values(PROVIDERS)) provider.streamChat = originalStreams.get(provider.name);
    grokAvailable.mockRestore();
    setUserConfigOverlay(null);
  }
});

test('judge and grok bypass paths each leave one llm.usage row', async () => {
  const judgeProvider = bypassProvider(
    'judge-bypass',
    'judge-model',
    '{"verdict":"continue","summary":"still working","confidence":0.8}',
    { inputTokens: 9, outputTokens: 4 },
  );
  const grokProvider = bypassProvider(
    'grok-bypass',
    'grok-model',
    '{"deltas":[],"summary":"ok"}',
    { inputTokens: 6, outputTokens: 2 },
  );
  const resolve = spyOn(llm, 'resolveDefaultProvider').mockReturnValue(judgeProvider);
  const getForConfig = spyOn(llm, 'getProviderForConfig').mockReturnValue(grokProvider);
  const anyAvail = spyOn(llm, 'anyProviderAvailable').mockReturnValue(true);
  try {
    const observed = await observeAttempts(async () => {
      await judgeGoalTurn({ objective: 'x', lastAssistantTurn: 'y' });
      await analyzeDiff({
        skillName: 's',
        server: 'h',
        service: 'svc',
        localOnly: [],
        remoteOnly: [],
        modified: [],
        envDeltas: [],
      });
    });
    expect(observed.usage).toEqual([
      expect.objectContaining({ site: 'goals.judge', model: 'judge-model', billingProvider: 'judge-bypass', inputTokens: 9, outputTokens: 4 }),
      expect.objectContaining({ site: 'grok.direct', model: 'grok-model', billingProvider: 'grok-bypass', inputTokens: 6, outputTokens: 2 }),
    ]);
  } finally {
    resolve.mockRestore();
    getForConfig.mockRestore();
    anyAvail.mockRestore();
  }
});
