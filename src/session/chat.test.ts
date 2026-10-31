import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
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
let activeStreamScript: ((messages: LLMMessage[], handlers: StreamWithToolsHandlers) => Promise<string>) | undefined;

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
    if (activeStreamScript) {
      const text = await activeStreamScript(messages, _handlers);
      streamCalls.push({ messages, opts, dispatchResult: text });
      return text;
    }
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
const coreTurnModule = await import('../core-turn/index.js');

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
    activeStreamScript = undefined;
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

test('Next TUI replays a short evidence challenge through real tools and answers in the same turn', async () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'next-tui-proactive-reconcile-'));
  const savedRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = sessionRoot;
  const userText = '앞서 그 스킬을 쓴 게 맞나요?';
  const originalRequest = '이번 주 한국 시장 변화와 관련 뉴스를 omni-crawl, omni-market, kr-flow로 조사해 분석해줘.';
  const correctedAnswerPrefix = '확인된 도구 결과를 반영해 원래 이번 주 시장 분석을 다시 했습니다.';
  const provider: LLMProvider = {
    name: 'reconcile-test-provider', defaultModel: 'reconcile-test-model', available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() { yield { type: 'text', delta: 'unused' } as const; },
  };
  activeProvider = provider;
  const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'tui' });
  appendMessage(session.id, {
    role: 'user', content: originalRequest, ts: '2026-10-29T00:00:00.000Z',
  });
  appendMessage(session.id, {
    role: 'assistant', content: '{"summary":{"결론":"스킬 사용을 확인할 수 없습니다."},"skill_status":{}}',
    ts: '2026-10-29T00:00:01.000Z',
  });
  const calledTools: string[] = [];
  const toolResults: unknown[] = [];
  let correctedAnswer = '';
  activeStreamScript = async (messages, handlers) => {
    expect(messages.some(message => message.role === 'system'
      && String(message.content).includes('## Proactive Reconciliation'))).toBe(true);
    expect(messages.some(message => message.role === 'system'
      && String(message.content).includes('You are in `research/agent`.'))).toBe(false);
    expect(messages.filter(message => message.role === 'user')).toHaveLength(2);
    expect(messages.some(message => message.role === 'user' && message.content === originalRequest)).toBe(true);
    expect(messages.some(message => message.role === 'user' && message.content === userText)).toBe(true);
    expect(messages.some(message => message.role === 'assistant'
      && String(message.content).includes('"skill_status"'))).toBe(true);
    for (const [index, name, args] of [
      [0, 'elanous_skills_list', { query: 'omni market flow' }],
      [1, 'skill_exec', { name: 'omni-crawl' }],
      [2, 'skill_exec', { name: 'omni-market' }],
      [3, 'skill_exec', { name: 'kr-flow' }],
      [4, 'OmniSearch', { query: '이번 주 한국 시장 변화' }],
    ] as const) {
      calledTools.push(name);
      toolResults.push(await handlers.dispatchTool(name, args, { callId: `next-reconcile-${index}` }));
    }
    const evidence = toolResults.map(result => String((result as { evidence?: string }).evidence ?? '')).join(' · ');
    expect(evidence).toContain('verified:skill_exec:omni-crawl');
    correctedAnswer = `${correctedAnswerPrefix} (${evidence})`;
    handlers.onText(correctedAnswer, correctedAnswer);
    handlers.onTurnComplete?.([{ role: 'assistant', content: correctedAnswer, phase: 'final_answer' }]);
    return correctedAnswer;
  };
  try {
    const result = await runTurn({
      userConfig: testConfig(provider, false), sessionId: session.id, userText,
      utteranceSurface: 'tui', systemPrompt: 'base session prompt', skipMemoryInjection: true,
      tools: [
        tool('elanous_skills_list'), tool('skill_exec'), tool('OmniSearch'),
      ],
      dispatchTool: async (name, args) => ({
        ok: true, evidence: `verified:${name}:${String(args.name ?? args.query ?? '')}`,
      }), provider,
      goalLoop: true, goalLoopMaxIterations: 1,
    });
    expect(streamCalls).toHaveLength(1);
    expect(calledTools).toEqual(['elanous_skills_list', 'skill_exec', 'skill_exec', 'skill_exec', 'OmniSearch']);
    expect(toolResults).toHaveLength(5);
    expect(result.text).toBe(correctedAnswer);
    expect(result.text.startsWith('{')).toBe(false);
  } finally {
    activeStreamScript = undefined;
    activeProvider = undefined;
    if (savedRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = savedRoot;
    rmSync(sessionRoot, { recursive: true, force: true });
  }
});

describe('Next TUI research turn routing', () => {
  let sessionRoot: string;

  afterEach(() => {
    if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
    delete process.env.ELANOUS_SESSION_ROOT;
    activeProvider = undefined;
  });

  test('uses the shared first-reply core turn with the across-turn goal loop disabled', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-next-tui-research-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    const provider: LLMProvider = {
      name: 'test-provider', defaultModel: 'test-model', available: () => true,
      async *chat() { yield 'plain'; }, async *streamChat() { yield { type: 'text', delta: 'plain' } as const; },
    };
    activeProvider = provider;
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'tui' });
    const core = spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async () => ({
      stopReason: 'end_turn', finalText: 'fast research answer',
    }));
    try {
      const result = await runTurn({
        userConfig: testConfig(provider, false), sessionId: session.id,
        userText: '이번 주 한국 시장과 업계 변화를 조사해 비교해줘', utteranceSurface: 'tui', systemPrompt: 'TUI prompt',
        skipMemoryInjection: true, tools: [tool('Read')], dispatchTool: async () => 'read result', provider,
        llmOpts: { reasoningEffort: 'high' },
      });
      expect(core).toHaveBeenCalledTimes(1);
      expect(core.mock.calls[0]?.[0].userText).toBe('이번 주 한국 시장과 업계 변화를 조사해 비교해줘');
      expect(core.mock.calls[0]?.[0].reasoningEffort).toBe('high');
      expect(result.text).toBe('fast research answer');
    } finally {
      core.mockRestore();
    }
  });

  test('routes a headless ask research intent through the shared core turn', async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-headless-ask-research-'));
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    const provider: LLMProvider = {
      name: 'test-provider', defaultModel: 'test-model', available: () => true,
      async *chat() { yield 'plain'; }, async *streamChat() { yield { type: 'text', delta: 'plain' } as const; },
    };
    activeProvider = provider;
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'cli' });
    const core = spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async () => ({
      stopReason: 'end_turn', finalText: 'headless research answer',
    }));
    try {
      const result = await runTurn({
        userConfig: testConfig(provider, false), sessionId: session.id,
        userText: '이번 주 한국 시장과 업계 변화를 조사해 비교해줘', utteranceSurface: 'ask', systemPrompt: 'CLI prompt',
        skipMemoryInjection: true, tools: [tool('Read')], dispatchTool: async () => 'read result', provider,
      });
      expect(core).toHaveBeenCalledTimes(1);
      expect(core.mock.calls[0]?.[0].userText).toBe('이번 주 한국 시장과 업계 변화를 조사해 비교해줘');
      expect(result.text).toBe('headless research answer');
    } finally {
      core.mockRestore();
    }
  });
});
