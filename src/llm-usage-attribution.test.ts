import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { PROVIDERS, streamLLM, type LLMProvider } from './llm.js';
import { setUserConfigOverlay } from './user-config.js';

async function observeAttempts(run: () => Promise<unknown>) {
  const done: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (event !== 'streamLLM') return;
    if (category === 'llm.router.done') done.push((data ?? {}) as Record<string, unknown>);
    if (category === 'llm.router.error') errors.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    await run();
    return { done, errors };
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
