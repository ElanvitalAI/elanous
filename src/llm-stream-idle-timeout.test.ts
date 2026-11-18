import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from './debug/log.js';
import { PROVIDERS, streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from './llm.js';
import { StreamTotalTimeoutError } from './llm/stream-fallback.js';
import { setUserConfigOverlay } from './user-config.js';

const realTimeout = globalThis.setTimeout;

function providerForTimeout(retryEvents: LLMStreamEvent[] | null): {
  provider: LLMProvider;
  getCalls(): number;
  getReturns(): number;
  returnSettled(): boolean;
  getSignals(): AbortSignal[];
} {
  let calls = 0;
  let returns = 0;
  let returnSettled = false;
  const signals: AbortSignal[] = [];
  const provider: LLMProvider = {
    name: 'idle-timeout-test-provider',
    defaultModel: 'idle-timeout-test-model',
    available: () => true,
    async *chat() { yield 'unused'; },
    streamChat(_messages, opts) {
      calls++;
      if (opts.signal) signals.push(opts.signal);
      if (calls > 1 && retryEvents !== null) {
        return (async function* () { yield* retryEvents; })();
      }
      let first = true;
      const iterator: AsyncGenerator<LLMStreamEvent, void, unknown> = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (first) {
            first = false;
            return { done: false, value: { type: 'text', delta: 'partial' } };
          }
          return new Promise<IteratorResult<LLMStreamEvent, void>>(() => {});
        },
        async return() {
          returns++;
          await new Promise<void>(() => {});
          returnSettled = true;
          return { done: true, value: undefined };
        },
        async throw(error?: unknown) { throw error; },
      };
      return iterator;
    },
  };
  return { provider, getCalls: () => calls, getReturns: () => returns, returnSettled: () => returnSettled, getSignals: () => signals };
}

describe('LLM stream idle timeout recovery', () => {
  /** One stream attempt — the idle path, not a second turn, decides (A207). */
  const ONE_TURN = 1; // 출처: #38137 one stream attempt
  /** indexOf sentinel: Blocked is present when this lower bound holds (A207). */
  const BLOCKED_PRESENT = 0; // 출처: #38137 Blocked must be in the status list
  it('does not await a stalled iterator return and retries the same provider once', async () => {
    const fake = providerForTimeout([{ type: 'text', delta: 'partial answer' }]);
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category.startsWith('llm.')) events.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    });
    const chunks: string[] = [];
    const statuses: string[] = [];
    try {
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'recover stalled stream' }],
        { onText: (delta) => chunks.push(delta), onStatus: (line) => statuses.push(line), dispatchTool: async () => ({}) },
        {
          provider: fake.provider,
          model: 'idle-timeout-test-model',
          streamIdleTimeoutMs: 10,
          tools: [{ name: 'probe', description: 'keeps tool streaming enabled', parameters: { type: 'object' } }],
          maxTurns: 1,
        },
      );

      expect(result).toBe('partial answer');
      expect(fake.getCalls()).toBe(2);
      expect(fake.getReturns()).toBe(1);
      expect(fake.getSignals()[0]?.aborted).toBe(true);
      expect(fake.getSignals()[1]?.aborted).toBe(false);
      expect(fake.returnSettled()).toBe(false);
      expect(chunks).toContain('partial');
      expect(statuses).toContain('스트림 무응답 · 재시도 1/1');
      expect(events.some((row) => row.event === 'idle-timeout-retry')).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 500);

  it('detaches the stalled iterator when the total stream timeout fires (A207)', async () => {
    const fake = providerForTimeout(null);
    const statuses: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      let caught: unknown = null;
      try {
        await streamLLMWithTools(
          [{ role: 'user', content: 'total timeout must detach the socket' }],
          { onText: () => {}, onStatus: (line) => statuses.push(line), dispatchTool: async () => ({}) },
          {
            provider: fake.provider,
            model: 'idle-timeout-test-model',
            streamIdleTimeoutMs: 10_000, // keep the idle path dormant; total fires first
            streamTotalTimeoutMs: 10,
            tools: [{ name: 'probe', description: 'keeps tool streaming enabled', parameters: { type: 'object' } }],
            maxTurns: ONE_TURN,
          },
        );
      } catch (err) {
        caught = err;
      }

      // The total-timeout error must surface to the caller…
      expect(caught).toBeInstanceOf(StreamTotalTimeoutError);
      expect((caught as StreamTotalTimeoutError).totalMs).toBe(10);
      // …while the abandoned provider iterator is detached without being awaited…
      expect(fake.getReturns()).toBe(1);
      expect(fake.returnSettled()).toBe(false);
      // …and the attempt abort signal fires so the provider socket tears down.
      expect(fake.getSignals()[0]?.aborted).toBe(true);
      expect(statuses.some((line) => line.includes('응답 시간 상한 초과'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 500);

  it('says Blocked after the one no-progress retry when no provider is left (A207)', async () => {
    const fake = providerForTimeout(null);
    const statuses: string[] = [];
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event) => {
      if (category === 'llm.stream' || category === 'llm.retry') events.push(event);
    });
    setUserConfigOverlay((config) => ({
      ...config,
      llm: { ...config.llm, provider: 'auto', fallbackChain: [] },
    }));
    try {
      let caught: unknown = null;
      try {
        await streamLLMWithTools(
          [{ role: 'user', content: 'no progress and nowhere to fall back' }],
          { onText: () => {}, onStatus: (line) => statuses.push(line), dispatchTool: async () => ({}) },
          {
            initialProvider: fake.provider,
            model: 'idle-timeout-test-model',
            streamIdleTimeoutMs: 10,
            tools: [{ name: 'probe', description: 'keeps tool streaming enabled', parameters: { type: 'object' } }],
            maxTurns: ONE_TURN,
          },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(fake.getCalls()).toBe(2);
      expect(statuses).toContain('스트림 무응답 · 재시도 1/1');
      expect(statuses.filter((line) => line.startsWith('스트림 무응답 · 재시도'))).toHaveLength(1);
      expect(statuses).toContain('⏸ Blocked · 스트림 무진행');
      expect(events.filter((event) => event === 'idle-timeout-retry')).toHaveLength(1);
      expect(events).toContain('idle-timeout-blocked');
    } finally {
      log.mockRestore();
      setUserConfigOverlay(null);
    }
  }, 1000);

  it('caps idle retries at one and preserves pinned-provider partial text', async () => {
    const fake = providerForTimeout(null);
    let idleRetries = 0;
    const log = spyOn(debug, 'log').mockImplementation((category, event) => {
      if (category === 'llm.retry' && event === 'idle-timeout-retry') idleRetries++;
    });
    try {
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'stop after one retry' }],
        { onText: () => {}, dispatchTool: async () => ({}) },
        {
          provider: fake.provider,
          model: 'idle-timeout-test-model',
          streamIdleTimeoutMs: 10,
          tools: [{ name: 'probe', description: 'keeps tool streaming enabled', parameters: { type: 'object' } }],
          maxTurns: 1,
        },
      );
      expect(result).toBe('partial');
      expect(fake.getCalls()).toBe(2);
      expect(fake.getReturns()).toBe(2);
      expect(idleRetries).toBe(1);
      expect(fake.returnSettled()).toBe(false);
    } finally {
      log.mockRestore();
    }
  }, 500);

  it('uses the existing provider fallback after the same-provider idle retry', async () => {
    const stalled = providerForTimeout(null);
    const originalGrok = PROVIDERS.grok!;
    let fallbackCalls = 0;
    const statuses: string[] = [];
    const fallback: LLMProvider = {
      name: 'grok',
      defaultModel: 'grok-test-model',
      available: () => true,
      async *chat() { yield 'fallback answer'; },
      async *streamChat() { fallbackCalls++; yield { type: 'text', delta: 'fallback answer' }; },
    };
    PROVIDERS.grok = fallback;
    setUserConfigOverlay((config) => ({
      ...config,
      llm: { ...config.llm, provider: 'auto', fallbackChain: ['grok'] },
    }));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'fall back after idle retry' }],
        { onText: () => {}, onStatus: (line) => statuses.push(line), dispatchTool: async () => ({}) },
        {
          initialProvider: stalled.provider,
          model: 'idle-timeout-test-model',
          streamIdleTimeoutMs: 10,
          tools: [{ name: 'probe', description: 'keeps tool streaming enabled', parameters: { type: 'object' } }],
          maxTurns: 1,
        },
      );

      expect(result).toBe('fallback answer');
      expect(stalled.getCalls()).toBe(2);
      expect(stalled.getReturns()).toBe(2);
      expect(fallbackCalls).toBe(1);
      expect(statuses).toContain('스트림 무응답 · 재시도 1/1');
      // A207 — the one no-progress retry is per turn. Crossing to the fallback must not
      // announce a second «재시도 1/1».
      expect(statuses.filter((line) => line.startsWith('스트림 무응답 · 재시도'))).toHaveLength(1);
      expect(statuses.some((line) => line.startsWith('⚠ 공급자 전환: idle-timeout-test-provider → grok ('))).toBe(true);
    } finally {
      log.mockRestore();
      setUserConfigOverlay(null);
      PROVIDERS.grok = originalGrok;
    }
  }, 1000);

  it('does not replay or fall back after a tool call has escaped', async () => {
    let streamCalls = 0;
    let dispatches = 0;
    let retryEvents = 0;
    const provider: LLMProvider = {
      name: 'idle-timeout-side-effect-provider',
      defaultModel: 'idle-timeout-side-effect-model',
      available: () => true,
      async *chat() { yield 'unused'; },
      streamChat() {
        streamCalls++;
        let first = true;
        return {
          [Symbol.asyncIterator]() { return this; },
          async next() {
            if (first) {
              first = false;
              return { done: false, value: { type: 'tool_call', id: 'call-1', name: 'probe', args: {} } };
            }
            return new Promise<IteratorResult<LLMStreamEvent, void>>(() => {});
          },
          async return() { return { done: true, value: undefined }; },
          async throw(error?: unknown) { throw error; },
        } as AsyncGenerator<LLMStreamEvent, void, unknown>;
      },
    };
    const log = spyOn(debug, 'log').mockImplementation((category, event) => {
      if (category === 'llm.retry' && event === 'idle-timeout-retry') retryEvents++;
    });
    try {
      await streamLLMWithTools(
        [{ role: 'user', content: 'do not repeat dispatched tools' }],
        { onText: () => {}, dispatchTool: async () => { dispatches++; return 'done'; } },
        {
          provider,
          model: 'idle-timeout-side-effect-model',
          streamIdleTimeoutMs: 10,
          tools: [{ name: 'probe', description: 'side effect sentinel', parameters: { type: 'object' } }],
          maxTurns: 1,
        },
      );
      expect(streamCalls).toBe(1);
      expect(dispatches).toBe(1);
      expect(retryEvents).toBe(0);
    } finally {
      log.mockRestore();
    }
  }, 500);


  it('uses the configured idle timeout and preserves pinned partial text after retry exhaustion', async () => {
    const fake = providerForTimeout(null);
    const statuses: string[] = [];
    setUserConfigOverlay((config) => ({
      ...config,
      llm: { ...config.llm, streamIdleTimeoutMs: 10 },
    }));
    try {
      const result = await Promise.race([
        streamLLMWithTools(
          [{ role: 'user', content: 'preserve partial output' }],
          { onText: () => {}, onStatus: (line) => statuses.push(line), dispatchTool: async () => ({}) },
          {
            provider: fake.provider,
            model: 'idle-timeout-test-model',
            tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }],
            maxTurns: 1,
          },
        ),
        new Promise<never>((_, reject) => realTimeout(() => reject(new Error('configured idle timeout ignored')), 300)),
      ]);
      expect(result).toBe('partial');
      expect(fake.getCalls()).toBe(2);
      expect(fake.getReturns()).toBe(2);
      expect(statuses).toContain('스트림 무응답 · 재시도 소진 (부분 응답 유지)');
    } finally {
      setUserConfigOverlay(null);
    }
  }, 500);

  it('surfaces an idle timeout when a pinned provider has no partial output', async () => {
    const never = new Promise<IteratorResult<LLMStreamEvent, void>>(() => {});
    const provider: LLMProvider = {
      name: 'idle-timeout-empty-provider',
      defaultModel: 'idle-timeout-empty-model',
      available: () => true,
      async *chat() {},
      streamChat() {
        return {
          [Symbol.asyncIterator]() { return this; },
          next: () => never,
          return: () => never,
        } as AsyncGenerator<LLMStreamEvent, void, unknown>;
      },
    };
    const result = streamLLMWithTools(
      [{ role: 'user', content: 'no partial output' }],
      { onText: () => {}, dispatchTool: async () => ({}) },
      {
        provider,
        model: provider.defaultModel,
        streamIdleTimeoutMs: 10,
        tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }],
        maxTurns: 1,
      },
    );
    await expect(Promise.race([
      result,
      new Promise<never>((_, reject) => realTimeout(() => reject(new Error('pinned timeout did not settle')), 300)),
    ])).rejects.toMatchObject({
      name: 'StreamIdleTimeoutError',
      code: 'ETIMEDOUT',
      message: 'stream idle timeout after 10ms',
    });
  }, 500);

  it('says Blocked before the pinned-provider stop throw (A207)', async () => {
    const never = new Promise<IteratorResult<LLMStreamEvent, void>>(() => {});
    let calls = 0;
    const provider: LLMProvider = {
      name: 'idle-timeout-stop-provider',
      defaultModel: 'idle-timeout-stop-model',
      available: () => true,
      async *chat() {},
      streamChat() {
        calls++;
        return {
          [Symbol.asyncIterator]() { return this; },
          next: () => never,
          async return() { return { done: true, value: undefined }; },
        } as AsyncGenerator<LLMStreamEvent, void, unknown>;
      },
    };
    const statuses: string[] = [];
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event) => {
      if (category === 'llm.stream') events.push(event);
    });
    try {
      let caught: unknown = null;
      try {
        await streamLLMWithTools(
          [{ role: 'user', content: 'pinned stop must say Blocked first' }],
          { onText: () => {}, onStatus: (line) => statuses.push(line), dispatchTool: async () => ({}) },
          {
            provider,
            model: provider.defaultModel,
            streamIdleTimeoutMs: 10,
            tools: [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }],
            maxTurns: ONE_TURN,
          },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ name: 'StreamIdleTimeoutError' });
      expect(calls).toBe(2);
      expect(statuses).toContain('스트림 무응답 · 재시도 1/1');
      const blockedAt = statuses.indexOf('⏸ Blocked · 스트림 무진행');
      expect(blockedAt).toBeGreaterThanOrEqual(BLOCKED_PRESENT);
      expect(events).toContain('idle-timeout-blocked');
    } finally {
      log.mockRestore();
    }
  }, 1000);

});
