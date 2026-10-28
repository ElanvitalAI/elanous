import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { debug } from './debug/log.js';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from './llm.js';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

type StreamObservation = { event: string; data: Record<string, unknown>; level?: string };

function provider(model: string, events: LLMStreamEvent[]): LLMProvider {
  return {
    name: 'probe-provider',
    defaultModel: model,
    available: () => true,
    async *streamChat() {
      yield* events;
    },
    async *chat() {
      for (const event of events) if (event.type === 'text') yield event.delta;
    },
  };
}

function idleProvider(model: string): LLMProvider {
  const iterator = {
    next: () => new Promise<IteratorResult<LLMStreamEvent, void>>(() => {}),
    return: async () => ({ done: true as const, value: undefined }),
    [Symbol.asyncIterator]() { return this; },
  };
  return {
    name: 'probe-provider',
    defaultModel: model,
    available: () => true,
    streamChat: () => iterator as AsyncGenerator<LLMStreamEvent, void, unknown>,
    async *chat() {},
  };
}

async function observeTurn(
  model: string,
  events: LLMStreamEvent[],
  options: { idle?: boolean } = {},
) {
  const observed: StreamObservation[] = [];
  const armedDelays: number[] = [];
  const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data, logOptions) => {
    if (category === 'llm.stream') {
      observed.push({ event, data: (data ?? {}) as Record<string, unknown>, level: logOptions?.level });
    }
  });
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((handler: TimerHandler, timeout?: number) => {
    armedDelays.push(timeout ?? 0);
    if (options.idle && typeof handler === 'function') queueMicrotask(() => { if (armedDelays.length <= 2) handler(); });
    return realSetTimeout(handler, timeout);
  }) as typeof setTimeout;
  let error: unknown;
  try {
    await streamLLMWithTools(
      [{ role: 'user', content: 'observe idle timeout' }],
      { onText: () => {}, dispatchTool: async () => ({}) },
      {
        provider: options.idle ? idleProvider(model) : provider(model, events),
        model,
        tools: [{ name: 'probe', description: 'keeps the tool loop active', parameters: {} }],
        maxTurns: 1,
      },
    );
  } catch (caught) {
    if (!options.idle) throw caught;
    error = caught;
  } finally {
    logSpy.mockRestore();
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
  }
  return { observed, armedDelays, error };
}

afterEach(() => {
  (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = realClearTimeout;
});

describe('llm.stream consume-start idle watchdog observation', () => {
  it('records the codex reasoning-family 180000ms ceiling and the exact armed delay', async () => {
    const { observed, armedDelays } = await observeTurn('gpt-6-codex', [{ type: 'text', delta: 'done' }]);
    const start = observed.find(({ event }) => event === 'consume-start')!;

    expect(start.data).toMatchObject({
      turn: 0,
      provider: 'probe-provider',
      model: 'gpt-6-codex',
      modelFamily: 'codex',
      idleMs: 180_000,
    });
    expect(armedDelays).toHaveLength(2);
    expect(armedDelays.every((delay) => delay === start.data.idleMs)).toBe(true);
  });

  it('records the gpt 45000ms ceiling without changing the existing consume-start fields', async () => {
    const { observed, armedDelays } = await observeTurn('gpt-4o-mini', [{ type: 'text', delta: 'done' }]);
    const start = observed.find(({ event }) => event === 'consume-start')!;

    expect(start.data).toMatchObject({
      turn: 0,
      provider: 'probe-provider',
      model: 'gpt-4o-mini',
      modelFamily: 'gpt',
      idleMs: 45_000,
    });
    expect(armedDelays).toHaveLength(2);
    expect(armedDelays.every((delay) => delay === start.data.idleMs)).toBe(true);
  });

  it('omits modelFamily for an unknown family while retaining the 45000ms ceiling', async () => {
    const { observed, armedDelays } = await observeTurn('unclassified-model', [{ type: 'text', delta: 'done' }]);
    const start = observed.find(({ event }) => event === 'consume-start')!;

    expect(start.data).toMatchObject({
      turn: 0,
      provider: 'probe-provider',
      model: 'unclassified-model',
      idleMs: 45_000,
    });
    expect(start.data).not.toHaveProperty('modelFamily');
    expect(armedDelays).toHaveLength(2);
    expect(armedDelays.every((delay) => delay === start.data.idleMs)).toBe(true);
  });

  it('preserves the idle-timeout warning payload and level', async () => {
    const { observed, error } = await observeTurn('gpt-4o-mini', [], { idle: true });
    const idleTimeout = observed.find(({ event }) => event === 'idle-timeout')!;

    expect(error).toMatchObject({ name: 'StreamIdleTimeoutError', code: 'ETIMEDOUT', idleMs: 45_000 });
    expect(idleTimeout).toMatchObject({
      level: 'warn',
      data: {
        turn: 0,
        evCount: 0,
        lastEvType: 'none',
        idleMs: 45_000,
        textChars: 0,
        pendingCalls: 0,
      },
    });
  });
});
