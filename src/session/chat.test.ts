import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage, LLMOpts, LLMProvider, LLMToolSpec, StreamWithToolsHandlers } from '../llm.js';
import type { CoreTurnDispatchTool } from '../core-turn/index.js';
import { PTY_BUDGET_GRANT, TERMINAL_MISSION_DISCIPLINE } from '../agent/terminal-surface.js';
import * as actualMemory from '../memory.js';

const streamCalls: Array<{
  messages: LLMMessage[];
  opts: LLMOpts & { tools?: LLMToolSpec[]; provider?: LLMProvider };
  dispatchResult: unknown;
}> = [];
let activeProvider: LLMProvider | undefined;
const OMIT_DISPATCH_CTX = Symbol('omit-dispatch-ctx');
let nextDispatchCtx: unknown = OMIT_DISPATCH_CTX;

mock.module('../memory.js', () => ({
  ...actualMemory,
  buildMemoryInjection: () => ({ block: '', injectedIds: [] }),
  buildMemoryInjectionLLM: async () => ({ block: '', injectedIds: [] }),
}));

mock.module('../domains/surface-events.js', () => ({
  openSurfaceEventsDb: () => ({ close() {} }),
  recallEvents: () => [],
}));

mock.module('../user-intent/index.js', () => ({
  userIntentLogger: () => ({ emit() {} }),
}));

mock.module('../llm.js', () => ({
  getProviderForConfig: () => activeProvider,
  isAuthRejectionError: () => false,
  getToolLoopPhaseRejectedTools: () => null,
  streamLLMWithTools: async (
    messages: LLMMessage[],
    _handlers: StreamWithToolsHandlers,
    opts: LLMOpts & { tools?: LLMToolSpec[]; provider?: LLMProvider } = {},
  ) => {
    const dispatchResult = nextDispatchCtx === OMIT_DISPATCH_CTX
      ? await _handlers.dispatchTool('PtyShellScreenshot', {})
      : await _handlers.dispatchTool(
        'PtyShellScreenshot',
        {},
        nextDispatchCtx as { callId: string },
      );
    streamCalls.push({ messages, opts, dispatchResult });
    return 'ok';
  },
}));

const { createSession } = await import('./index.js');
const { runTurn } = await import('./chat.js');

function tool(name: string): LLMToolSpec {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
  };
}

function testConfig(provider: LLMProvider) {
  return {
    llm: {
      provider: provider.name,
      model: provider.defaultModel,
      memoryJudge: { enabled: false, crossRecall: false },
      goalLoop: { enabled: false },
    },
  } as never;
}

async function runToolTurn(
  tools: LLMToolSpec[],
  llmOpts?: LLMOpts,
  extra?: {
    userText?: string;
    goalLoop?: boolean;
    goalLoopMaxIterations?: number;
    dispatchTool?: CoreTurnDispatchTool;
  },
): Promise<void> {
  const provider: LLMProvider = {
    name: 'test-provider',
    defaultModel: 'test-model',
    available: () => true,
    async *chat() { yield 'plain'; },
    async *streamChat() { yield { type: 'text', delta: 'plain' } as const; },
  };
  activeProvider = provider;
  const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'tui' });
  const dispatchTool: CoreTurnDispatchTool = extra?.dispatchTool ?? (async (name) => name === 'PtyShellScreenshot'
    ? { output: 'captured', _imageFile: '/tmp/nonexistent-chat-test.png' }
    : { ok: true });
  await runTurn({
    userConfig: testConfig(provider),
    sessionId: session.id,
    userText: extra?.userText ?? 'hello',
    systemPrompt: 'base prompt',
    skipMemoryInjection: true,
    tools,
    dispatchTool,
    provider,
    ...(llmOpts ? { llmOpts } : {}),
    ...(extra?.goalLoop ? { goalLoop: true } : {}),
    ...(extra?.goalLoopMaxIterations !== undefined
      ? { goalLoopMaxIterations: extra.goalLoopMaxIterations }
      : {}),
  });
}

describe('session chat terminal-capable turns', () => {
  let sessionRoot: string;

  afterEach(() => {
    streamCalls.length = 0;
    activeProvider = undefined;
    nextDispatchCtx = OMIT_DISPATCH_CTX;
    if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
    delete process.env.ELANOUS_SESSION_ROOT;
  });

  test('wires PtyShell-family tools through the canonical terminal-capable turn', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-terminal-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    await runToolTurn([tool('PtyShellStart')]);

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.opts.budgetGrant).toBe(PTY_BUDGET_GRANT);
    expect(streamCalls[0]?.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining(TERMINAL_MISSION_DISCIPLINE),
    });
    expect(streamCalls[0]?.dispatchResult).toEqual({ output: 'captured' });
  });

  test('does not wire ordinary non-terminal tool turns', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-ordinary-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    await runToolTurn([tool('Read')]);

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.opts.budgetGrant).toBeUndefined();
    expect(String(streamCalls[0]?.messages[0]?.content ?? '')).not.toContain(TERMINAL_MISSION_DISCIPLINE);
    expect(streamCalls[0]?.dispatchResult).toEqual({
      output: 'captured',
      _imageFile: '/tmp/nonexistent-chat-test.png',
    });
  });

  test('does not treat matching budget and prompt values as already terminal-capable', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-terminal-values-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    const matchingValuesOnly: LLMOpts = { budgetGrant: PTY_BUDGET_GRANT };
    await runToolTurn([tool('PtyShellStart')], matchingValuesOnly);

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.opts.budgetGrant).toBe(PTY_BUDGET_GRANT);
    expect(streamCalls[0]?.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining(TERMINAL_MISSION_DISCIPLINE),
    });
    expect(streamCalls[0]?.dispatchResult).toEqual({ output: 'captured' });
  });
});

describe('session chat dispatchTool ctx forwarding', () => {
  let sessionRoot: string;

  afterEach(() => {
    streamCalls.length = 0;
    activeProvider = undefined;
    nextDispatchCtx = OMIT_DISPATCH_CTX;
    if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
    delete process.env.ELANOUS_SESSION_ROOT;
  });

  test('forwards the human sentence as ctx.userText through runTurn', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-dispatch-usertext-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    const human = 'please inspect the harness mention';
    nextDispatchCtx = { callId: 'call-1', userText: human };
    const recorded: Array<Parameters<CoreTurnDispatchTool>[2]> = [];
    await runToolTurn([tool('Read')], undefined, {
      userText: human,
      dispatchTool: async (_name, _args, ctx) => {
        recorded.push(ctx);
        return { ok: true };
      },
    });

    expect(streamCalls).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.userText).toBe(human);
    expect(streamCalls[0]?.dispatchResult).toEqual({ ok: true });
  });

  test('preserves the injected ctx key set through the wrapper', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-dispatch-keys-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    const injected = {
      callId: 'call-2',
      turnIndex: 3,
      sessionId: 'sess-keys',
      userText: 'keep these keys',
      extra: 'untouched',
    };
    nextDispatchCtx = injected;
    const recorded: Array<Parameters<CoreTurnDispatchTool>[2]> = [];
    await runToolTurn([tool('Read')], undefined, {
      userText: 'keep these keys',
      dispatchTool: async (_name, _args, ctx) => {
        recorded.push(ctx);
        return { ok: true };
      },
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toBe(injected);
    expect(Object.keys(recorded[0] as object).sort()).toEqual(Object.keys(injected).sort());
  });

  test('keeps two-argument dispatch behavior when ctx is omitted', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-dispatch-omit-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    const recorded: Array<Parameters<CoreTurnDispatchTool>[2]> = [];
    const expected = { ok: true, via: 'two-arg' };
    await runToolTurn([tool('Read')], undefined, {
      dispatchTool: async (_name, _args, ctx) => {
        recorded.push(ctx);
        return expected;
      },
    });

    expect(streamCalls).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toBeUndefined();
    expect(streamCalls[0]?.dispatchResult).toEqual(expected);
  });

  test('forwards core-turn synthesized userText on the goal-loop hop', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-dispatch-goal-loop-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    const human = 'please inspect the harness mention';
    const recorded: Array<Parameters<CoreTurnDispatchTool>[2]> = [];
    await runToolTurn([tool('Read')], undefined, {
      userText: human,
      goalLoop: true,
      goalLoopMaxIterations: 1,
      dispatchTool: async (_name, _args, ctx) => {
        recorded.push(ctx);
        return { ok: true };
      },
    });

    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0]?.userText).toBe(human);
  });
});
