import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { debug } from './debug/log.js';
import { PROVIDERS, streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from './llm.js';
import { setUserConfigOverlay } from './user-config.js';

/** Stream-stall sentinel: every streamChat call emits one tool_call and then hangs, so the
 *  only way this turn can complete is O10 — advance to the next provider and finish there. */
const STALL_TEST_MAX_TURNS = 3; // NUMGUARD — 라운드 상한 숫자 리터럴 금지: 시험 종료 조건 상한

function stallingSideEffectProvider(): { provider: LLMProvider; getCalls(): number } {
  let calls = 0;

  const provider: LLMProvider = {
    name: 'stall-side-effect-provider',
    defaultModel: 'stall-side-effect-model',
    available: () => true,
    async *chat() { yield 'unused'; },
    streamChat() {
      calls++;
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
      } as unknown as AsyncGenerator<LLMStreamEvent, void, unknown>;
    },
  };
  return { provider, getCalls: () => calls };
}

describe('LLM stream stall advance (O10)', () => {
  let previousWireMode: string | undefined;
  beforeEach(() => {
    previousWireMode = process.env.ELANOUS_LLM_MODE;
    process.env.ELANOUS_LLM_MODE = 'real';
  });
  afterEach(() => {
    if (previousWireMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = previousWireMode;
  });

  it('advances to the next provider when the stream stalls after a tool call escaped', async () => {
    const stalled = stallingSideEffectProvider();
    const originalGrok = PROVIDERS.grok!;
    let fallbackCalls = 0;
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
    let dispatches = 0;
    const statuses: string[] = [];
    try {
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'continue on the next provider after a stall' }],
        {
          onText: () => {},
          onStatus: (line) => statuses.push(line),
          dispatchTool: async () => { dispatches++; return 'done'; },
        },
        {
          initialProvider: stalled.provider,
          model: 'stall-side-effect-model',
          streamIdleTimeoutMs: 10,
          tools: [{ name: 'probe', description: 'side effect sentinel', parameters: { type: 'object' } }],
          // NUMGUARD: 3 = 허용 라운드 상한. 유래: runAgentTurnOptions.maxTurns 기본값 관례(테스트 범위 밖 실측) — 시험 종료 조건 명시.
          maxTurns: STALL_TEST_MAX_TURNS,
        },
      );

      // O10 — the turn must complete on the fallback provider, not end silently on the stalled one.
      expect(result).toBe('fallback answer');
      // The escaped tool side effect ran exactly once — no replay on either provider path.
      expect(dispatches).toBe(1);
      // The stalled provider served round 1 only; the continuation round belongs to the fallback.
      expect(stalled.getCalls()).toBe(1);
      expect(fallbackCalls).toBe(1);
      expect(statuses.some((line) => line.startsWith('⚠ 공급자 전환: stall-side-effect-provider → grok ('))).toBe(true);
    } finally {
      log.mockRestore();
      setUserConfigOverlay(null);
      PROVIDERS.grok = originalGrok;
    }
  }, 1000);
});