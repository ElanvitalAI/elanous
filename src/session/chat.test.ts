import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, LLMMessage, LLMOpts, LLMProvider, LLMToolSpec, StreamWithToolsHandlers } from '../llm.js';
import type { CoreTurnDispatchTool } from '../core-turn/index.js';
import { PTY_BUDGET_GRANT, TERMINAL_MISSION_DISCIPLINE } from '../agent/terminal-surface.js';
import * as actualMemory from '../memory.js';
import { debug } from '../debug/log.js';
import { compactSessionHistory } from './compact-session.js';
import { appendMessage, createSession, loadSession, rewriteSessionMessages } from './index.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import type { CompactProvider } from '../compact/provider.js';
import type { ChatAutoCompactConfig } from '../user-config.js';

const streamCalls: Array<{
  messages: LLMMessage[];
  opts: LLMOpts & { tools?: LLMToolSpec[]; provider?: LLMProvider };
  dispatchResult: unknown;
}> = [];
const directCalls: Array<{ messages: LLMMessage[]; opts: LLMOpts }> = [];
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

const { runTurn } = await import('./chat.js');

function tool(name: string): LLMToolSpec {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
  };
}

function testConfig(provider: LLMProvider, goalLoopEnabled = false) {
  return {
    llm: {
      provider: provider.name,
      model: provider.defaultModel,
      memoryJudge: { enabled: false, crossRecall: false },
      goalLoop: { enabled: goalLoopEnabled },
    },
  } as never;
}

async function runToolTurn(
  tools: LLMToolSpec[],
  llmOpts?: LLMOpts,
  extra?: {
    userText?: string;
    providerName?: string;
    goalLoop?: boolean;
    goalLoopMaxIterations?: number;
    dispatchTool?: CoreTurnDispatchTool;
    goalLoopConfigEnabled?: boolean;
    sessionId?: string;
  },
): Promise<string> {
  const provider: LLMProvider = {
    name: extra?.providerName ?? 'test-provider',
    defaultModel: 'test-model',
    available: () => true,
    async *chat() { yield 'plain'; },
    async *streamChat(messages, opts = {}) {
      directCalls.push({ messages, opts });
      yield { type: 'text', delta: 'plain' } as const;
    },
  };
  activeProvider = provider;
  const session = extra?.sessionId
    ? { id: extra.sessionId }
    : createSession({ provider: provider.name, model: provider.defaultModel, source: 'tui' });
  const dispatchTool: CoreTurnDispatchTool = extra?.dispatchTool ?? (async (name) => name === 'PtyShellScreenshot'
    ? { output: 'captured', _imageFile: '/tmp/nonexistent-chat-test.png' }
    : { ok: true });
  await runTurn({
    userConfig: testConfig(provider, extra?.goalLoopConfigEnabled === true),
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
  return session.id;
}

describe('session chat terminal-capable turns', () => {
  let sessionRoot: string;

  afterEach(() => {
    streamCalls.length = 0;
    directCalls.length = 0;
    resetAutoCompactStateForTest();
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
    expect(streamCalls[0]?.opts.requestSizeGuard).toBeUndefined();
    expect(String(streamCalls[0]?.messages[0]?.content ?? '')).not.toContain(TERMINAL_MISSION_DISCIPLINE);
    expect(streamCalls[0]?.dispatchResult).toEqual({
      output: 'captured',
      _imageFile: '/tmp/nonexistent-chat-test.png',
    });
  });

  test('wires the request-size guard through Codex TUI tool turns', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-codex-request-size-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    await runToolTurn([tool('Read')], undefined, { providerName: 'openai-codex' });

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.opts.requestSizeGuard?.maxChars).toBe(400_000);
    expect(typeof streamCalls[0]?.opts.requestSizeGuard?.compactMessages).toBe('function');
    expect(typeof streamCalls[0]?.opts.requestSizeGuard?.onMeasured).toBe('function');
  });

  test('wires the request-size guard through Codex TUI goal-loop turns', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-codex-request-size-goal-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;

    await runToolTurn([tool('Read')], undefined, {
      providerName: 'openai-codex',
      goalLoop: true,
      goalLoopMaxIterations: 1,
    });

    expect(streamCalls.length).toBeGreaterThan(0);
    expect(streamCalls.every(call => call.opts.requestSizeGuard?.maxChars === 400_000)).toBe(true);
  });

  test('wires the request-size guard through direct Codex TUI turns', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-codex-request-size-direct-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    const provider: LLMProvider = {
      name: 'openai-codex',
      defaultModel: 'test-model',
      available: () => true,
      async *chat() { yield 'plain'; },
      async *streamChat(messages, opts = {}) {
        directCalls.push({ messages, opts });
        yield { type: 'text', delta: 'plain' } as const;
      },
    };
    activeProvider = provider;
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'tui' });
    await runTurn({
      userConfig: testConfig(provider),
      sessionId: session.id,
      userText: 'hello',
      systemPrompt: 'base prompt',
      skipMemoryInjection: true,
      provider,
    });

    expect(directCalls).toHaveLength(1);
    expect(directCalls[0]?.opts.requestSizeGuard?.maxChars).toBe(400_000);
  });

  test('after direct session compaction, the next provider input has the latest text and image exactly once', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-codex-compact-preserves-image-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    resetAutoCompactStateForTest();
    const provider: LLMProvider = {
      name: 'openai-codex',
      defaultModel: 'test-model',
      available: () => true,
      async *chat() { yield 'plain'; },
      async *streamChat(messages, opts = {}) {
        directCalls.push({ messages, opts });
        yield { type: 'text', delta: 'plain' } as const;
      },
    };
    activeProvider = provider;
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'tui' });
    const latestText = 'latest user request survives compact';
    for (let i = 0; i < 6; i++) {
      appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `older-${i} ${'x'.repeat(200)}`,
        ts: new Date().toISOString(),
      });
    }
    appendMessage(session.id, {
      role: 'user',
      content: `[+1 image]\n${latestText}`,
      ts: new Date().toISOString(),
    });
    const compactProvider: CompactProvider = {
      async summarize() {
        return { summary: 'prior history summary', modelUsed: 'stub', sourceMessageCount: 4 };
      },
      getContextWindow() { return 32_000; },
      getAutoCompactThreshold() { return 16_000; },
    };
    const compactConfig: ChatAutoCompactConfig = {
      enabled: true, triggerRatio: 0, preserveLastN: 1, preserveFirstN: 0,
      partial: true, workingBudgetTokens: 256_000,
    };
    const compacted = await compactSessionHistory(session.id, {
      config: compactConfig,
      provider: compactProvider,
      force: true,
    });
    expect(compacted.fired).toBe(true);
    const compactedHistory = loadSession(session.id)!.messages;
    expect(compactedHistory.length).toBeLessThan(7);
    expect(compactedHistory.at(-1)?.content).toBe(`[+1 image]\n${latestText}`);
    // Mirror runTurn's first-compaction rebuild: omit the persisted current row,
    // then assemble the canonical user text and image blocks exactly once.
    rewriteSessionMessages(session.id, compactedHistory.slice(0, -1));
    const image: ContentBlock = { type: 'image', mediaType: 'image/png', base64: 'aW1hZ2UtYnl0ZXM=' };
    await runTurn({
      userConfig: testConfig(provider),
      sessionId: session.id,
      userText: latestText,
      userImages: [image],
      systemPrompt: 'base prompt',
      skipMemoryInjection: true,
      provider,
    });

    const nextInput = directCalls[0]?.messages ?? [];
    const latest = nextInput.filter(message => message.role === 'user' && Array.isArray(message.content)
      && message.content.some(block => block.type === 'text' && block.text === latestText));
    expect(latest).toHaveLength(1);
    expect(latest[0]!.content).toEqual([
      image,
      { type: 'text', text: latestText },
    ]);
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

describe('session chat child context composition', () => {
  let sessionRoot: string;

  afterEach(() => {
    streamCalls.length = 0;
    activeProvider = undefined;
    nextDispatchCtx = OMIT_DISPATCH_CTX;
    if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
    delete process.env.ELANOUS_SESSION_ROOT;
    delete process.env.ELANOUS_HARNESS_SPACE;
    delete process.env.ELANOUS_HARNESS_SPACE_ID;
    delete process.env.ELANOUS_PROMPT_BUDGET;
  });

  function compositionEvents() {
    return debug
      .events(500)
      .filter((ev) => ev.category === 'self-implement' && ev.event === 'child.context-composition');
  }

  async function runGuardedTurn<T>(turn: () => Promise<T>): Promise<T> {
    const previousGuard = debug.setLogDietGuard(null);
    try {
      return await turn();
    } finally {
      debug.setLogDietGuard(previousGuard);
    }
  }

  test('implementation child first goal-loop turn records exactly one composition event', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-composition-child-first-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
    process.env.ELANOUS_HARNESS_SPACE_ID = 'chat-composition-first';
    debug.clear();
    const goalText = 'wire the child context budget instrumentation';
    const readTool = tool('Read');
    await runGuardedTurn(() => runToolTurn([readTool], undefined, {
      userText: goalText,
      goalLoop: true,
      goalLoopMaxIterations: 1,
    }));

    expect(streamCalls.length).toBeGreaterThan(0);
    const fired = compositionEvents();
    expect(fired).toHaveLength(1);
    const composition = fired[0]?.data as {
      profile: string;
      components: Record<string, { inputBytes: number; includedBytes: number; truncated: boolean }>;
    };
    expect(composition.profile).toBe('default');
    expect(composition.components.systemPrompt.inputBytes).toBe(Buffer.byteLength('base prompt'));
    expect(composition.components.systemPrompt.includedBytes).toBe(Buffer.byteLength('base prompt'));
    expect(composition.components.systemPrompt.truncated).toBe(false);
    expect(composition.components.toolSchemas.inputBytes).toBe(Buffer.byteLength(JSON.stringify([readTool])));
    expect(composition.components.toolSchemas.truncated).toBe(false);
    expect(composition.components.goal.inputBytes).toBe(Buffer.byteLength(goalText));
    expect(composition.components.goal.truncated).toBe(false);
    expect(composition.components.agentsMd.inputBytes).toBe(0);
    expect(composition.components.claudeMd.inputBytes).toBe(0);
    expect(composition.components.ledger.inputBytes).toBe(0);
  });

  test('implementation child with the lean prompt budget records the small profile', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-composition-child-lean-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
    process.env.ELANOUS_HARNESS_SPACE_ID = 'chat-composition-lean';
    process.env.ELANOUS_PROMPT_BUDGET = 'lean';
    debug.clear();
    await runGuardedTurn(() => runToolTurn([tool('Read')], undefined, {
      userText: 'measure the lean child context budget',
      goalLoop: true,
      goalLoopMaxIterations: 1,
    }));

    expect(streamCalls.length).toBeGreaterThan(0);
    const fired = compositionEvents();
    expect(fired).toHaveLength(1);
    const composition = fired[0]?.data as { profile: string };
    expect(composition.profile).toBe('small');
  });

  test('second goal-loop turn in the same child session does not re-emit the composition event', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-composition-child-second-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
    process.env.ELANOUS_HARNESS_SPACE_ID = 'chat-composition-second';
    debug.clear();
    const firstSessionId = await runGuardedTurn(() => runToolTurn([tool('Read')], undefined, {
      userText: 'first goal-loop turn of the child session',
      goalLoop: true,
      goalLoopMaxIterations: 1,
    }));
    expect(compositionEvents()).toHaveLength(1);
    await runGuardedTurn(() => runToolTurn([tool('Read')], undefined, {
      userText: 'follow-up goal-loop turn of the same child session',
      goalLoop: true,
      goalLoopMaxIterations: 1,
      sessionId: firstSessionId,
    }));

    expect(streamCalls.length).toBeGreaterThan(0);
    expect(compositionEvents()).toHaveLength(1);
  });

  test('implementation child ordinary tool turn without goal-loop arming emits no composition event', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-composition-child-unarmed-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
    process.env.ELANOUS_HARNESS_SPACE_ID = 'chat-composition-unarmed';
    debug.clear();
    await runGuardedTurn(() => runToolTurn([tool('Read')]));

    expect(streamCalls.length).toBeGreaterThan(0);
    expect(compositionEvents()).toHaveLength(0);
  });

  test('ordinary non-child goal-loop-armed chat emits no composition event', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-composition-ordinary-goal-loop-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    debug.clear();
    await runGuardedTurn(() => runToolTurn([tool('Read')], undefined, {
      userText: 'ordinary user goal-loop turn outside the child space',
      goalLoop: true,
      goalLoopMaxIterations: 1,
    }));
    await runGuardedTurn(() => runToolTurn([tool('Read')], undefined, {
      userText: 'ordinary config-enabled goal-loop turn outside the child space',
      goalLoopMaxIterations: 1,
      goalLoopConfigEnabled: true,
    }));

    expect(streamCalls.length).toBeGreaterThan(0);
    expect(compositionEvents()).toHaveLength(0);
  });

  test('emits no composition event on ordinary tool turns', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-composition-ordinary-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    debug.clear();
    await runGuardedTurn(() => runToolTurn([tool('Read')]));

    expect(streamCalls.length).toBeGreaterThan(0);
    expect(compositionEvents()).toHaveLength(0);
  });
});
