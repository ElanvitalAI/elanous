import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { streamLLM, type LLMProvider, type LLMStreamEvent } from './llm.js';

const message = [{ role: 'user' as const, content: 'review' }];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function textProvider(iterator: AsyncIterator<LLMStreamEvent>): LLMProvider {
  return {
    name: 'probe-provider',
    defaultModel: 'gpt-4o-mini',
    available: () => true,
    streamChat: () => ({ [Symbol.asyncIterator]: () => iterator }) as AsyncGenerator<LLMStreamEvent, void, unknown>,
    async *chat() {},
  };
}

test('a partial text stream that stalls rejects within a second, closes once, and records the idle failure', async () => {
  let nextCalls = 0;
  let returns = 0;
  const iterator: AsyncIterator<LLMStreamEvent> = {
    next: () => ++nextCalls === 1
      ? Promise.resolve({ done: false, value: { type: 'text', delta: 'partial' } })
      : new Promise<IteratorResult<LLMStreamEvent>>(() => {}),
    return: async () => { returns++; return { done: true, value: undefined }; },
  };
  const records: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    records.push({ category, event, data });
  });
  const chunks: string[] = [];
  const started = Date.now();
  try {
    await expect(streamLLM(message, (_delta, full) => chunks.push(full), {
      provider: textProvider(iterator), streamIdleTimeoutMs: 50,
    })).rejects.toMatchObject({ name: 'StreamIdleTimeoutError', message: expect.stringMatching(/stream idle timeout after 50ms/) });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(chunks).toEqual(['partial']);
    expect(returns).toBe(1);
    expect(records).toContainEqual({
      category: 'llm', event: 'stream-idle-timeout',
      data: { provider: 'probe-provider', model: 'gpt-4o-mini', idleMs: 50, receivedChars: 7, site: 'stream-llm' },
    });
  } finally {
    log.mockRestore();
  }
});

test('a stalled async generator cannot keep streamLLM waiting on its queued return', async () => {
  let returned = 0;
  const iterator = (async function* (): AsyncGenerator<LLMStreamEvent> {
    try {
      yield { type: 'text', delta: 'partial' };
      await new Promise<void>(() => {});
    } finally {
      returned++;
    }
  })();
  const started = Date.now();
  await expect(streamLLM(message, () => {}, {
    provider: textProvider(iterator), streamIdleTimeoutMs: 50,
  })).rejects.toMatchObject({ name: 'StreamIdleTimeoutError' });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(returned).toBe(0);
});

test('five text events spaced 30ms apart preserve full text and usage with a 200ms idle limit', async () => {
  const provider: LLMProvider = {
    name: 'probe-provider', defaultModel: 'gpt-4o-mini', available: () => true,
    async *streamChat() {
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } };
      for (const delta of ['a', 'b', 'c', 'd', 'e']) {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 30));
        yield { type: 'text', delta };
      }
    },
    async *chat() {},
  };
  const chunks: string[] = [];
  const usage: number[] = [];
  expect(await streamLLM(message, (_delta, full) => chunks.push(full), {
    provider, streamIdleTimeoutMs: 200, onUsage: (value) => usage.push(value.inputTokens ?? 0),
  })).toBe('abcde');
  expect(chunks).toEqual(['a', 'ab', 'abc', 'abcd', 'abcde']);
  expect(usage).toEqual([4]);
});

test('each successful next, including completion, clears its idle timer', async () => {
  const active = new Set<ReturnType<typeof setTimeout>>();
  let armed = 0;
  let cleared = 0;
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((handler: TimerHandler, timeout?: number) => {
    const timer = realSetTimeout(handler, timeout) as unknown as ReturnType<typeof setTimeout>;
    if (timeout === 200) {
      active.add(timer);
      armed++;
    }
    return timer;
  }) as unknown as typeof setTimeout;
  (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    if (active.delete(timer)) cleared++;
    realClearTimeout(timer);
  }) as typeof clearTimeout;
  try {
    const provider: LLMProvider = {
      name: 'probe-provider', defaultModel: 'gpt-4o-mini', available: () => true,
      async *streamChat() {
        for (const delta of ['a', 'b', 'c', 'd', 'e']) {
          await new Promise<void>((resolve) => realSetTimeout(resolve, 30));
          yield { type: 'text', delta };
        }
      },
      async *chat() {},
    };
    const started = Date.now();
    expect(await streamLLM(message, () => {}, { provider, streamIdleTimeoutMs: 200 })).toBe('abcde');
    // Idle bounds the gap between events, not total time; active timers below prove nothing lingers.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(armed).toBe(6);
    expect(cleared).toBe(6);
    expect(active.size).toBe(0);
  } finally {
    for (const timer of active) realClearTimeout(timer);
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
    (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = realClearTimeout;
  }
});

test('default text idle uses the existing reasoning-family and provider ceilings', async () => {
  const delays: number[] = [];
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((handler: TimerHandler, timeout?: number) => {
    delays.push(timeout ?? 0);
    return realSetTimeout(handler, timeout);
  }) as typeof setTimeout;
  try {
    for (const [name, model] of [['probe-provider', 'gpt-4o-mini'], ['probe-provider', 'claude-sonnet-5'], ['openai-codex', 'gpt-6-astra']] as const) {
      const provider = textProvider({ next: async () => ({ done: true, value: undefined }) });
      provider.name = name;
      provider.defaultModel = model;
      expect(await streamLLM(message, () => {}, { provider })).toBe('');
    }
    expect(delays).toEqual([45_000, 180_000, 180_000]);
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
  }
});
