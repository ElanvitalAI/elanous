import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from './debug/log.js';
import { PROVIDERS, streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from './llm.js';
import { setUserConfigOverlay } from './user-config.js';

function providerForTimeout(retryEvents: LLMStreamEvent[] | null): {
  provider: LLMProvider;
  getCalls(): number;
  getReturns(): number;
  returnSettled(): boolean;
} {
  let calls = 0;
  let returns = 0;
  let returnSettled = false;
  const provider: LLMProvider = {
    name: 'idle-timeout-test-provider',
    defaultModel: 'idle-timeout-test-model',
    available: () => true,
    async *chat() { yield 'unused'; },
    streamChat() {
      calls++;
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
  return { provider, getCalls: () => calls, getReturns: () => returns, returnSettled: () => returnSettled };
}

describe('LLM stream idle timeout recovery', () => {
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
      expect(fake.returnSettled()).toBe(false);
      expect(chunks).toContain('partial');
      expect(statuses).toContain('스트림 무응답 · 재시도 1/1');
      expect(events.some((row) => row.event === 'idle-timeout-retry')).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 500);

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
});
