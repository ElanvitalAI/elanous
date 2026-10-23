// UI-Core arc Phase U3b Step 1 — core-turn-adapter test.
//
// Locks in two promises that downstream phases (U3b Step 2 = ACP
// server runTurn wiring, U3b Step 3 = dashboard substitution) will
// lean on:
//
//   1. `runCoreTurn` boots a turn WITHOUT importing dashboard / chat
//      / tui-client modules. The static headless-guard scan (in
//      test/tui-client-headless-guard.test.ts) enforces the import-
//      graph side; this test enforces the *runtime* shape — it mocks
//      `streamLLMWithTools` and verifies the adapter forwards args
//      and callbacks faithfully with no hidden renderer dependency.
//
//   2. The stop-reason mapping is explicit and stable. ACP
//      `PromptResponse.stopReason` uses the same string values, so
//      Step 2 will translate 1:1 — any drift here would show up as
//      a test failure rather than as silent breakage at the wire.

import { describe, expect, test, mock, spyOn, beforeEach, afterEach } from 'bun:test';

import type { LLMMessage, LLMToolSpec, StreamWithToolsHandlers } from '../src/llm.js';
import * as llmModule from '../src/llm.js';
import { debug, getAmbientSessionId, setAmbientSessionId } from '../src/debug/log.js';

type StreamCall = {
  messages: LLMMessage[];
  handlers: StreamWithToolsHandlers;
  opts: Record<string, unknown>;
};
const streamCalls: StreamCall[] = [];
let streamImpl: (args: StreamCall) => Promise<string> = async () => '';

const { runCoreTurn } = await import('../src/core-turn/run-core-turn.js');

beforeEach(() => {
  streamCalls.length = 0;
  streamImpl = async () => '';
  // BACKLOG #5 — spyOn replaces `streamLLMWithTools` per-file. The
  // pre-cleanup version used `mock.module()` which leaked into every
  // subsequent test file in a combined `bun test` run; spyOn +
  // `mock.restore()` is per-file scoped.
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(
    (async (
      messages: LLMMessage[],
      handlers: StreamWithToolsHandlers,
      opts?: Record<string, unknown>,
    ): Promise<string> => {
      const call = { messages, handlers, opts: opts ?? {} };
      streamCalls.push(call);
      return streamImpl(call);
    }) as typeof llmModule.streamLLMWithTools,
  );
});

afterEach(() => {
  streamCalls.length = 0;
  mock.restore();
});

const baseMessages: LLMMessage[] = [{ role: 'user', content: 'hi' }];
const baseTool: LLMToolSpec = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: {} },
};

describe('runCoreTurn — happy path', () => {
  test('forwards messages/tools/model through to streamLLMWithTools', async () => {
    streamImpl = async () => 'final-text';
    const ctrl = new AbortController();
    const result = await runCoreTurn({
      sessionId: 's1',
      messages: baseMessages,
      tools: [baseTool],
      dispatchTool: async () => 'ok',
      signal: ctrl.signal,
      maxToolTurns: 12,
      modelOverride: 'claude-3-5-sonnet-latest',
    });
    expect(result).toEqual({ stopReason: 'end_turn', finalText: 'final-text' });
    expect(streamCalls).toHaveLength(1);
    const c = streamCalls[0]!;
    expect(c.messages).toEqual(baseMessages);
    expect(c.opts.tools).toEqual([baseTool]);
    expect(c.opts.signal).toBe(ctrl.signal);
    expect(c.opts.maxTurns).toBe(12);
    expect(c.opts.model).toBe('claude-3-5-sonnet-latest');
  });

  // PLAN-multi-surface-pty-shell M0 — budgetGrant passes through verbatim
  // so daemon-path surfaces (PWA/iOS/ACP) can arm the PtyShell budget
  // extension without touching llm.ts.
  test('forwards budgetGrant through to streamLLMWithTools', async () => {
    streamImpl = async () => '';
    const ctrl = new AbortController();
    const grant = { tools: ['PtyShellSend'], perCall: 6, ceiling: 60 };
    await runCoreTurn({
      sessionId: 's1b',
      messages: baseMessages,
      tools: [baseTool],
      dispatchTool: async () => 'ok',
      signal: ctrl.signal,
      budgetGrant: grant,
    });
    expect(streamCalls[0]!.opts.budgetGrant).toEqual(grant);
  });

  test('omits maxTurns/model/budgetGrant when caller leaves them undefined', async () => {
    streamImpl = async () => '';
    const ctrl = new AbortController();
    await runCoreTurn({
      sessionId: 's2',
      messages: baseMessages,
      tools: [],
      dispatchTool: async () => null,
      signal: ctrl.signal,
    });
    const opts = streamCalls[0]!.opts;
    expect('maxTurns' in opts).toBe(false);
    expect('model' in opts).toBe(false);
    expect('budgetGrant' in opts).toBe(false);
  });

  test('forwards onText / onToolCall / onToolResult / onTurnComplete', async () => {
    const textDeltas: Array<[string, string]> = [];
    const toolCalls: Array<{ id: string; name: string }> = [];
    const toolResults: Array<{ id: string; result: unknown }> = [];
    const completeMsgs: LLMMessage[][] = [];

    streamImpl = async ({ handlers }) => {
      handlers.onText('he', 'he');
      handlers.onText('llo', 'hello');
      handlers.onToolCall?.({ id: '1', name: 'echo', args: { x: 1 } });
      handlers.onToolResult?.({ id: '1', name: 'echo', result: { ok: true } });
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'hello' }]);
      return 'hello';
    };

    const ctrl = new AbortController();
    const result = await runCoreTurn({
      sessionId: 's3',
      messages: baseMessages,
      tools: [baseTool],
      dispatchTool: async () => null,
      signal: ctrl.signal,
      callbacks: {
        onText: (delta, full) => textDeltas.push([delta, full]),
        onToolCall: (call) => toolCalls.push({ id: call.id, name: call.name }),
        onToolResult: (call) => toolResults.push({ id: call.id, result: call.result }),
        onTurnComplete: (msgs) => completeMsgs.push(msgs),
      },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(textDeltas).toEqual([['he', 'he'], ['llo', 'hello']]);
    expect(toolCalls).toEqual([{ id: '1', name: 'echo' }]);
    expect(toolResults).toEqual([{ id: '1', result: { ok: true } }]);
    expect(completeMsgs).toHaveLength(1);
  });

  test('forwards onUsage — P2-bridge-ext', async () => {
    const usages: Array<Record<string, unknown>> = [];
    streamImpl = async ({ handlers }) => {
      handlers.onUsage?.({ provider: 'anthropic', inputTokens: 12, outputTokens: 3 });
      handlers.onUsage?.({ provider: 'anthropic', outputTokens: 5, cacheReadInputTokens: 80 });
      return '';
    };
    await runCoreTurn({
      sessionId: 's-usage',
      messages: baseMessages,
      tools: [baseTool],
      dispatchTool: async () => null,
      signal: new AbortController().signal,
      callbacks: {
        onText: () => { /* no-op */ },
        onUsage: (u) => usages.push(u as Record<string, unknown>),
      },
    });
    expect(usages).toEqual([
      { provider: 'anthropic', inputTokens: 12, outputTokens: 3 },
      { provider: 'anthropic', outputTokens: 5, cacheReadInputTokens: 80 },
    ]);
  });

  test('onUsage opt-in — absent callback leaves handlers.onUsage undefined', async () => {
    await runCoreTurn({
      sessionId: 's-no-usage',
      messages: baseMessages,
      tools: [],
      dispatchTool: async () => null,
      signal: new AbortController().signal,
      callbacks: { onText: () => { /* no-op */ } },
    });
    expect(streamCalls[0]!.handlers.onUsage).toBeUndefined();
  });

  test('dispatchTool passthrough preserves callId ctx', async () => {
    const dispatchSeen: Array<{ name: string; callId: string | undefined }> = [];
    streamImpl = async ({ handlers }) => {
      await handlers.dispatchTool('echo', { a: 1 }, { callId: 'call-7' });
      return '';
    };
    await runCoreTurn({
      sessionId: 's4',
      messages: baseMessages,
      tools: [baseTool],
      dispatchTool: async (name, _args, ctx) => {
        dispatchSeen.push({ name, callId: ctx?.callId });
        return 'ok';
      },
      signal: new AbortController().signal,
    });
    expect(dispatchSeen).toEqual([{ name: 'echo', callId: 'call-7' }]);
  });
});

describe('runCoreTurn — daemon tool observability', () => {
  test('records the immediate/deferred catalog and actual tool selection under the turn session', async () => {
    const records: Array<{ category: string; event: string; data: unknown; sessionId: string | null }> = [];
    const off = debug.registerSink({
      name: 'daemon-tool-observability-test',
      emit: (record) => records.push({
        category: record.category,
        event: record.event,
        data: record.data,
        sessionId: (record as { session_id?: string }).session_id ?? null,
      }),
    });
    setAmbientSessionId('outer-session');
    streamImpl = async ({ handlers }) => {
      handlers.onToolCall?.({ id: 'call-42', name: 'echo', args: { exact: true } });
      return 'done';
    };
    try {
      await runCoreTurn({
        sessionId: 'daemon-session-42',
        userText: 'submit a goal with the harness for this feature',
        messages: [{ role: 'user', content: 'submit a goal with the harness for this feature' }],
        tools: [
          baseTool,
          ...['tool-2', 'tool-3', 'tool-4', 'tool-5', 'tool-6', 'tool-7', 'tool-8'].map((name) => ({ ...baseTool, name })),
        ],
        dispatchTool: async () => 'ok',
        signal: new AbortController().signal,
      });
    } finally {
      off?.();
    }

    const catalog = records.find((record) => record.category === 'capability.resolve' && record.event === 'tool-tier-split');
    const selected = records.find((record) => record.category === 'capability.resolve' && record.event === 'tool-selected');
    expect(catalog).toEqual(expect.objectContaining({
      category: 'capability.resolve',
      event: 'tool-tier-split',
      data: expect.objectContaining({
        sessionId: 'daemon-session-42',
        surfaceId: 'coding/agent',
        surfaceSelectionReason: 'dev-harness-intent',
        activeCount: 8,
        deferredCount: 0,
        immediateCount: 8,
        immediate: ['echo', 'tool-2', 'tool-3', 'tool-4', 'tool-5', 'tool-6', 'tool-7', 'tool-8'],
        warmPreloaded: 0,
        deferred: [],
        unhydratable: [],
      }),
      sessionId: 'daemon-session-42',
    }));
    expect(selected).toEqual(expect.objectContaining({
      category: 'capability.resolve',
      event: 'tool-selected',
      data: expect.objectContaining({
        sessionId: 'daemon-session-42',
        callId: 'call-42',
        tool: 'echo',
      }),
      sessionId: 'daemon-session-42',
    }));
    expect(getAmbientSessionId()).toBe('outer-session');
    setAmbientSessionId(null);
  });
});

describe('runCoreTurn — caller-side dispatch observability', () => {
  test('records the selected tool and forwards the dispatcher result at the caller', async () => {
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'core-turn-dispatch-test',
      emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }),
    });
    const result = { dispatched: true };
    const dispatchPromise = Promise.resolve(result);
    streamImpl = async ({ handlers }) => {
      await expect(handlers.dispatchTool('echo', { exact: true }, { callId: 'caller-side-1' })).resolves.toBe(result);
      return 'done';
    };
    try {
      await runCoreTurn({
        sessionId: 'caller-side-session',
        messages: baseMessages,
        tools: [baseTool],
        dispatchTool: (name, args, ctx) => {
          expect(name).toBe('echo');
          expect(args).toEqual({ exact: true });
          expect(ctx?.callId).toBe('caller-side-1');
          return dispatchPromise;
        },
        signal: new AbortController().signal,
      });
    } finally {
      off?.();
    }

    expect(records).toContainEqual(expect.objectContaining({
      category: 'core.turn', event: 'dispatch',
      data: expect.objectContaining({ sessionId: 'caller-side-session', tool: 'echo', dispatchCount: 1 }),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      category: 'core.turn', event: 'dispatch-done',
      data: expect.objectContaining({ sessionId: 'caller-side-session', tool: 'echo', dispatchCount: 1, success: true }),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      category: 'core.turn', event: 'dispatch-summary',
      data: expect.objectContaining({ sessionId: 'caller-side-session', dispatchCount: 1 }),
    }));
  });

  test('records a zero dispatch summary when the model selects no tools', async () => {
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'core-turn-zero-dispatch-test',
      emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      await runCoreTurn({
        sessionId: 'no-tool-session',
        messages: baseMessages,
        tools: [baseTool],
        dispatchTool: async () => 'not-called',
        signal: new AbortController().signal,
      });
    } finally {
      off?.();
    }

    expect(records).toContainEqual(expect.objectContaining({
      category: 'core.turn', event: 'dispatch-summary',
      data: expect.objectContaining({ sessionId: 'no-tool-session', dispatchCount: 0 }),
    }));
    expect(records.some((record) => record.category === 'core.turn' && record.event === 'dispatch')).toBe(false);
  });

  test('continues dispatching when caller-side observation throws', async () => {
    const originalLog = debug.log.bind(debug);
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, ...rest: unknown[]) => {
      if (category === 'core.turn' && event === 'dispatch') throw new Error('sink unavailable');
      return originalLog(category, event, ...(rest as [Record<string, unknown>, { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical' } | undefined]));
    }) as typeof debug.log);
    const result = { still: 'dispatched' };
    streamImpl = async ({ handlers }) => handlers.dispatchTool('echo', { x: 1 }, { callId: 'fail-open' }).then(() => 'done');
    try {
      await expect(runCoreTurn({
        sessionId: 'fail-open-session',
        messages: baseMessages,
        tools: [baseTool],
        dispatchTool: async () => result,
        signal: new AbortController().signal,
      })).resolves.toEqual({ stopReason: 'end_turn', finalText: 'done' });
    } finally {
      log.mockRestore();
    }
  });
});

describe('runCoreTurn — abort semantics', () => {
  test('pre-aborted signal short-circuits without calling stream', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await runCoreTurn({
      sessionId: 's-pre',
      messages: baseMessages,
      tools: [],
      dispatchTool: async () => null,
      signal: ctrl.signal,
    });
    expect(result).toEqual({ stopReason: 'aborted', finalText: '' });
    expect(streamCalls).toHaveLength(0);
  });

  test('abort mid-flight maps thrown AbortError to aborted stop reason', async () => {
    const ctrl = new AbortController();
    streamImpl = async ({ handlers }) => {
      handlers.onText('partial', 'partial');
      ctrl.abort();
      throw new Error('AbortError: signal aborted');
    };
    const result = await runCoreTurn({
      sessionId: 's-mid',
      messages: baseMessages,
      tools: [],
      dispatchTool: async () => null,
      signal: ctrl.signal,
    });
    expect(result.stopReason).toBe('aborted');
    expect(result.finalText).toBe('partial');
  });
});

describe('runCoreTurn — error passthrough', () => {
  test('unexpected throw surfaces (not swallowed)', async () => {
    streamImpl = async () => {
      throw new Error('kaboom');
    };
    await expect(
      runCoreTurn({
        sessionId: 's-err',
        messages: baseMessages,
        tools: [],
        dispatchTool: async () => null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('kaboom');
  });
});

describe('C4 — turn signal threads into dispatchTool ctx', () => {
  test('dispatchTool receives the TURN AbortSignal (and sessionId) in ctx', async () => {
    const seen: Array<{ signal?: AbortSignal; sessionId?: string }> = [];
    const ctrl = new AbortController();
    streamImpl = async ({ handlers }) => {
      await handlers.dispatchTool!('echo', {}, { callId: 'c1' });
      // legacy provider path — no per-call ctx at all
      await (handlers.dispatchTool as (n: string, a: Record<string, unknown>, c?: unknown) => Promise<unknown>)('echo', {});
      return 'done';
    };
    await runCoreTurn({
      sessionId: 's-c4',
      messages: baseMessages,
      tools: [baseTool],
      dispatchTool: async (_n, _a, ctx) => { seen.push({ signal: ctx?.signal, sessionId: ctx?.sessionId }); return 'ok'; },
      signal: ctrl.signal,
    });
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.signal).toBe(ctrl.signal);
      expect(s.sessionId).toBe('s-c4');
    }
  });
});
