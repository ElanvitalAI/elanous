/**
 * ELN-TURN-STALL-WATCHDOG — through the real `runCoreTurn` → `streamLLMWithTools` tool loop with fake providers and a
 * fake mailer (never the real ledger). The limit comes from config (`llm.turnNoProgressMs`), the way a seat sets it.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { PROVIDERS, type LLMProvider, type LLMStreamEvent } from '../llm.js';
import { setUserConfigOverlay } from '../user-config.js';
import { TEST_FAKE_LLM_SCRIPT_ENV, resetTestFakeLlmScript, testFakeLlmProvider } from '../ux-sim/fake-llm.js';
import { runCoreTurn } from './run-core-turn.js';
import type { CoreTurnContext } from './types.js';

const PROBE_TOOL = { name: 'probe', description: 'a tool the turn may call', parameters: { type: 'object', properties: {} } };

let events: string[] = [];
let mails: Array<{ from: string; to: readonly string[]; body: string }> = [];
const originalGrok = PROVIDERS.grok!;
const priorScript = process.env[TEST_FAKE_LLM_SCRIPT_ENV];

beforeEach(() => {
  events = [];
  mails = [];
  spyOn(debug, 'log').mockImplementation((category: string, event: string) => {
    if (category === 'llm.stream' || category === 'core.turn' || category === 'llm.router') events.push(`${category}:${event}`);
  });
  // Same neutral surface and deferral as run-core-turn.test.ts: the probe tool stays in the catalog the model sees.
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockImplementation(() => ({
    id: 'default', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  }) as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages],
    tools: [...tools],
    stats: { activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false, deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
  }) as unknown as ReturnType<typeof deferredModule.applyDeferredTools>);
});

afterEach(() => {
  mock.restore();
  setUserConfigOverlay(null);
  PROVIDERS.grok = originalGrok;
  if (priorScript === undefined) delete process.env[TEST_FAKE_LLM_SCRIPT_ENV];
  else process.env[TEST_FAKE_LLM_SCRIPT_ENV] = priorScript;
  resetTestFakeLlmScript();
});

function useChain(chain: string[], limitMs: number): void {
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto', fallbackChain: chain, turnNoProgressMs: limitMs } }));
}

function answeringGrok(answer: string): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      name: 'grok', defaultModel: 'grok-test-model', available: () => true,
      async *chat() { yield answer; },
      async *streamChat() { calls += 1; yield { type: 'text', delta: answer }; },
    },
  };
}

/** Yields `make(i)` every `everyMs` until it has yielded `count` events or the attempt is aborted. */
function pacedProvider(name: string, count: number, everyMs: number, make: (i: number) => LLMStreamEvent): LLMProvider {
  return {
    name, defaultModel: `${name}-model`, available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(_messages, opts) {
      for (let i = 0; i < count; i += 1) {
        if (opts?.signal?.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, everyMs));
        if (opts?.signal?.aborted) return;
        yield make(i);
      }
    },
  };
}

function ctx(initialProvider: LLMProvider, dispatchTool: CoreTurnContext['dispatchTool'] = async () => ({ ok: true })): CoreTurnContext {
  return {
    sessionId: 'stall-session-1',
    messages: [{ role: 'user', content: 'do the work' }],
    tools: [PROBE_TOOL],
    dispatchTool,
    signal: new AbortController().signal,
    initialProvider,
  };
}

describe('ELN-TURN-STALL-WATCHDOG through runCoreTurn', () => {
  test('fake-llm «stall:» after the first chunk → aborted, same context on the next provider, one mail line', async () => {
    process.env[TEST_FAKE_LLM_SCRIPT_ENV] = 'stall:첫 조각만 나오고 멈춤';
    resetTestFakeLlmScript();
    const grok = answeringGrok('다음 공급자의 답');
    PROVIDERS.grok = grok.provider;
    useChain(['grok'], 80);
    const result = await runCoreTurn(ctx(testFakeLlmProvider), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(result.finalText).toBe('다음 공급자의 답');
    expect(grok.calls()).toBe(1);
    expect(events).toContain('llm.stream:no-progress');
    expect(events).toContain('llm.router:provider-fallback');
    expect(events).toContain('core.turn:turn-stall');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.from).toBe('QSEAT');
    expect(mails[0]!.to).toEqual(['OP']);
    expect(mails[0]!.body).toContain('[turn-stall] QSEAT · no output for 1 min (limit 1 min) on test-fake-llm/');
    expect(mails[0]!.body).toContain('· recovered on grok · session stall-se');
  }, 5_000);

  test('reasoning keeps streaming with no output (the JUD-B shape) → fires and moves on', async () => {
    const thinker = pacedProvider('reasoning-only', 1_000, 5, () => ({ type: 'reasoning', kind: 'inline_delta', delta: '…' }));
    const grok = answeringGrok('추론만 하던 공급자 대신 답');
    PROVIDERS.grok = grok.provider;
    useChain(['grok'], 80);
    const result = await runCoreTurn(ctx(thinker), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(result.finalText).toBe('추론만 하던 공급자 대신 답');
    expect(events).toContain('llm.stream:no-progress');
    expect(events).not.toContain('llm.stream:idle-timeout');
    expect(mails).toHaveLength(1);
  }, 5_000);

  test('slow but progressing (a chunk every 30 ms for 300 ms, limit 80 ms) → never killed, no mail', async () => {
    const slow = pacedProvider('slow-writer', 10, 30, (i) => ({ type: 'text', delta: `${i}` }));
    PROVIDERS.grok = answeringGrok('불리면 안 되는 공급자').provider;
    useChain(['grok'], 80);
    const result = await runCoreTurn(ctx(slow), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(result.finalText).toBe('0123456789');
    expect(events).not.toContain('llm.stream:no-progress');
    expect(mails).toEqual([]);
  }, 5_000);

  test('a tool call that runs 300 ms (limit 80 ms) is not killed: tools run between stream attempts', async () => {
    let round = 0;
    const toolThenAnswer: LLMProvider = {
      name: 'tool-user', defaultModel: 'tool-user-model', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat() {
        round += 1;
        if (round === 1) { yield { type: 'tool_call', id: 'call-1', name: 'probe', args: {} }; return; }
        yield { type: 'text', delta: '도구가 끝난 뒤의 답' };
      },
    };
    PROVIDERS.grok = answeringGrok('불리면 안 되는 공급자').provider;
    useChain(['grok'], 80);
    let dispatched = 0;
    const result = await runCoreTurn(ctx(toolThenAnswer, async () => {
      dispatched += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { ok: true };
    }), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(dispatched).toBe(1);
    expect(result.finalText).toContain('도구가 끝난 뒤의 답');
    expect(events).not.toContain('llm.stream:no-progress');
    expect(mails).toEqual([]);
  }, 5_000);

  test('retry chain exhausted → explicit event, the turn ends with an honest error, one mail line', async () => {
    process.env[TEST_FAKE_LLM_SCRIPT_ENV] = 'stall:멈춘 조각';
    resetTestFakeLlmScript();
    useChain([], 80);
    let caught: unknown = null;
    try {
      await runCoreTurn(ctx(testFakeLlmProvider), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(events).toContain('llm.stream:no-progress');
    expect(events).toContain('llm.stream:no-progress-exhausted');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.body).toContain('· chain exhausted, turn ended with error: ');
  }, 5_000);

  // ── #38515 r1 must-fixes (remote-terra-38515-38515-a983090cd35e.json) ──

  test('r1 MF1: the stalled attempt\'s own request signal is aborted before the next provider is asked', async () => {
    let stalledSignal: AbortSignal | undefined;
    let abortedWhenFallbackAsked = null as boolean | null; // `as`: the closure assigns it (no narrowing to null)
    const stuck: LLMProvider = {
      name: 'stuck', defaultModel: 'stuck-model', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(_messages, opts) {
        stalledSignal = opts?.signal;
        yield { type: 'text', delta: '첫 조각' };
        await new Promise(() => {}); // a pending next() that only the request signal could end
      },
    };
    PROVIDERS.grok = {
      name: 'grok', defaultModel: 'grok-test-model', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat() { abortedWhenFallbackAsked = stalledSignal?.aborted ?? null; yield { type: 'text', delta: '대체 답' }; },
    };
    useChain(['grok'], 80);
    const result = await runCoreTurn(ctx(stuck), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(result.finalText).toBe('대체 답');
    expect(abortedWhenFallbackAsked).toBe(true);
  }, 5_000);

  test('r1 MF2: a user cancel racing the watchdog wins over keep-pending — the escaped tool call is NOT run', async () => {
    const user = new AbortController();
    let toolRuns = 0;
    spyOn(debug, 'log').mockImplementation((category: string, event: string) => {
      if (category === 'llm.stream' || category === 'core.turn' || category === 'llm.router') events.push(`${category}:${event}`);
      if (category === 'llm.stream' && event === 'no-progress') user.abort(new Error('user cancel')); // lands in the race window
    });
    const toolThenStall: LLMProvider = {
      name: 'tool-staller', defaultModel: 'tool-staller-model', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat() {
        yield { type: 'tool_call', id: 'call-1', name: 'probe', args: {} };
        await new Promise(() => {});
      },
    };
    PROVIDERS.grok = answeringGrok('불리면 안 되는 공급자').provider;
    useChain(['grok'], 80);
    const context = { ...ctx(toolThenStall, async () => { toolRuns += 1; return { ok: true }; }), signal: user.signal };
    await runCoreTurn(context, { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } }).catch(() => undefined);
    expect(events).toContain('llm.stream:no-progress');
    expect(events).not.toContain('llm.stream:no-progress-keep-pending');
    expect(toolRuns).toBe(0);
  }, 5_000);
});
