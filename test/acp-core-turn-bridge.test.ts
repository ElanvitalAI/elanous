// UI-Core arc Phase U3b Step 2 — ACP ↔ runCoreTurn bridge test.
//
// Locks the translation from AcpTurnContext into CoreTurnContext:
//   - getMessages / getTools / dispatchTool are wired through
//   - onText deltas flow to AcpTurnContext.push
//   - onTurnComplete forwards to the caller's persistence hook
//   - abort polling flips the AbortController promptly
//   - resolveModel / resolveMaxToolTurns are respected when provided
//
// `runCoreTurn` itself is covered in test/core-turn-adapter.test.ts.
// Here we mock it so we observe the ctx the bridge builds, rather
// than re-exercising the streamLLMWithTools path.

import { describe, expect, test, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMMessage, LLMToolSpec } from '../src/llm.js';
import { createSession, loadSession } from '../src/session/index.js';
import { writeOriginSessionMeta } from '../src/acp/origin-session-meta.js';
import { persistCompletedTuiAcpTurn } from '../src/acp/server.js';
import { dispatchSessionQuery } from '../src/domains/session-query-tool.js';
import { DashboardSession } from '../src/tui-client/dashboard-session.js';
import type { AcpTurnContext } from '../src/acp/server.js';
import { debug } from '../src/debug/log.js';
import * as coreTurnModule from '../src/core-turn/index.js';
import * as userConfigModule from '../src/user-config.js';
import type {
  CoreTurnContext,
  CoreTurnResult,
} from '../src/core-turn/index.js';

type RunCoreTurnCall = {
  ctx: CoreTurnContext;
};
const runCoreTurnCalls: RunCoreTurnCall[] = [];
let runCoreTurnImpl: (ctx: CoreTurnContext) => Promise<CoreTurnResult> =
  async () => ({ stopReason: 'end_turn', finalText: '' });

const {
  bridgeCoreTurnToAcp,
  defaultAcpMessagesSeed,
} = await import('../src/acp/core-turn-bridge.js');

let sessionRoot: string;
beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), 'acp-tui-persistence-'));
  process.env.ELANOUS_SESSION_ROOT = sessionRoot;
  runCoreTurnCalls.length = 0;
  runCoreTurnImpl = async () => ({ stopReason: 'end_turn', finalText: '' });
  spyOn(userConfigModule, 'getUserConfig').mockReturnValue({
    llm: { model: 'gpt-4o-mini', goalLoop: { enabled: false } },
  } as ReturnType<typeof userConfigModule.getUserConfig>);
  // BACKLOG #5 — spyOn replaces `runCoreTurn` for this test file
  // only; `mock.restore()` in afterEach reverts. Pre-cleanup version
  // used `mock.module()` which leaked process-wide.
  spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(
    async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      runCoreTurnCalls.push({ ctx });
      return runCoreTurnImpl(ctx);
    },
  );
});

afterEach(() => {
  runCoreTurnCalls.length = 0;
  mock.restore();
  rmSync(sessionRoot, { recursive: true, force: true });
  delete process.env.ELANOUS_SESSION_ROOT;
});

function makeTurnCtx(over: Partial<AcpTurnContext> = {}): {
  ctx: AcpTurnContext;
  pushes: string[];
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  toolResults: Array<{ id: string; name: string; result: unknown }>;
  usages: Array<Parameters<AcpTurnContext['pushUsage']>[0]>;
  setAborted: (v: boolean) => void;
} {
  const pushes: string[] = [];
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  const toolResults: Array<{ id: string; name: string; result: unknown }> = [];
  const usages: Array<Parameters<AcpTurnContext['pushUsage']>[0]> = [];
  let aborted = false;
  const userText = over.userText ?? 'hello';
  const ctx: AcpTurnContext = {
    sessionId: over.sessionId ?? 'sess-1',
    cwd: over.cwd ?? '/tmp',
    userText,
    promptBlocks: over.promptBlocks ?? [{ type: 'text', text: userText }],
    isAborted: over.isAborted ?? (() => aborted),
    push: over.push ?? (async (chunk) => { pushes.push(chunk); }),
    pushWithMeta: over.pushWithMeta ?? (async (chunk) => { pushes.push(chunk); }),
    pushSessionUpdate: over.pushSessionUpdate ?? (async () => {}),
    pushToolCall: over.pushToolCall ?? (async (call) => { toolCalls.push(call); }),
    pushToolResult: over.pushToolResult ?? (async (call) => { toolResults.push(call); }),
    pushUsage: over.pushUsage ?? (async (usage) => { usages.push(usage); }),
    requestApproval: over.requestApproval ?? (async () => 'deny-once'),
  };
  return { ctx, pushes, toolCalls, toolResults, usages, setAborted: (v) => { aborted = v; } };
}

describe('bridgeCoreTurnToAcp — forwarding', () => {
  test('builds CoreTurnContext from deps + AcpTurnContext', async () => {
    const tools: LLMToolSpec[] = [
      { name: 'echo', description: '', parameters: { type: 'object' } },
    ];
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ];
    const getMessagesArgs: unknown[] = [];
    const getToolsArgs: unknown[] = [];

    const runTurn = bridgeCoreTurnToAcp({
      getMessages: (args) => { getMessagesArgs.push(args); return messages; },
      getTools: (args) => { getToolsArgs.push(args); return tools; },
      dispatchTool: async () => 'ok',
    });
    const { ctx } = makeTurnCtx({ sessionId: 'sess-42', userText: 'hello' });
    await runTurn(ctx);

    expect(getMessagesArgs).toEqual([
      {
        sessionId: 'sess-42',
        userText: 'hello',
        promptBlocks: [{ type: 'text', text: 'hello' }],
      },
    ]);
    expect(getToolsArgs).toEqual([
      { sessionId: 'sess-42', userText: 'hello' },
    ]);
    expect(runCoreTurnCalls).toHaveLength(1);
    const built = runCoreTurnCalls[0]!.ctx;
    expect(built.sessionId).toBe('sess-42');
    expect(built.messages).toEqual(messages);
    expect(built.tools).toEqual(tools);
    expect(typeof built.dispatchTool).toBe('function');
    expect(built.signal).toBeInstanceOf(AbortSignal);
  });

  test('records dispatch-ready metadata immediately before dispatch without user text', async () => {
    const log = spyOn(debug, 'log');
    const tools: LLMToolSpec[] = [
      { name: 'echo', description: '', parameters: { type: 'object' } },
      { name: 'clock', description: '', parameters: { type: 'object' } },
    ];
    const dispatchTool = async function dashboardDispatcher() { return 'ok'; };
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: () => [{ role: 'user', content: '' }],
      getTools: () => tools,
      dispatchTool,
    });

    await runTurn(makeTurnCtx({ userText: '' }).ctx);

    expect(log).toHaveBeenCalledWith('acp.turn', 'dispatch-ready', {
      hasUserText: false,
      userTextLength: 0,
      hasDispatchTool: true,
      forwardsDispatchTool: true,
      dispatchToolName: 'dashboardDispatcher',
      toolCount: 2,
    });
    expect(runCoreTurnCalls[0]!.ctx.dispatchTool).toBe(dispatchTool);
    expect(runCoreTurnCalls[0]!.ctx.tools).toEqual(expect.arrayContaining(tools));
  });

  test('records an empty dispatcher name and continues when reading it fails', async () => {
    const log = spyOn(debug, 'log');
    const anonymousDispatchTool = async () => 'ok';
    Object.defineProperty(anonymousDispatchTool, 'name', { value: '' });
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: anonymousDispatchTool,
    });

    await runTurn(makeTurnCtx().ctx);

    expect(log).toHaveBeenCalledWith('acp.turn', 'dispatch-ready', expect.objectContaining({
      dispatchToolName: '',
    }));

    const nameReadFailsDispatchTool = new Proxy(async () => 'ok', {
      get(target, property, receiver) {
        if (property === 'name') throw new Error('name unavailable');
        return Reflect.get(target, property, receiver);
      },
    });
    const runTurnWithUnreadableName = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: nameReadFailsDispatchTool,
    });

    await runTurnWithUnreadableName(makeTurnCtx().ctx);

    expect(log).toHaveBeenLastCalledWith('acp.turn', 'dispatch-ready', expect.objectContaining({
      hasDispatchTool: true,
      forwardsDispatchTool: true,
      dispatchToolName: '',
    }));
    expect(runCoreTurnCalls).toHaveLength(2);
    expect(runCoreTurnCalls[1]!.ctx.dispatchTool).toBe(nameReadFailsDispatchTool);
  });

  test('continues dispatching when dispatch-ready observation fails', async () => {
    spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      if (category === 'acp.turn' && event === 'dispatch-ready') {
        throw new Error('log sink unavailable');
      }
    }) as never);
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => 'ok',
    });

    await runTurn(makeTurnCtx().ctx);

    expect(runCoreTurnCalls).toHaveLength(1);
  });

  // PLAN-multi-surface-pty-shell M3 — daemon hosts with a PtyShell
  // surface arm the tool-loop budget extension through the bridge.
  test('forwards deps.budgetGrant to runCoreTurn (omitted when unset)', async () => {
    const grant = { tools: ['PtyShellSend'], perCall: 6, ceiling: 60 };
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: () => [{ role: 'user', content: 'hi' }],
      getTools: () => [],
      dispatchTool: async () => 'ok',
      budgetGrant: grant,
    });
    await runTurn(makeTurnCtx().ctx);
    expect(runCoreTurnCalls[0]!.ctx.budgetGrant).toEqual(grant);

    runCoreTurnCalls.length = 0;
    const runTurnNoGrant = bridgeCoreTurnToAcp({
      getMessages: () => [{ role: 'user', content: 'hi' }],
      getTools: () => [],
      dispatchTool: async () => 'ok',
    });
    await runTurnNoGrant(makeTurnCtx().ctx);
    expect('budgetGrant' in runCoreTurnCalls[0]!.ctx).toBe(false);
  });

  test('onText deltas flow to AcpTurnContext.push', async () => {
    runCoreTurnImpl = async (ctx) => {
      ctx.callbacks?.onText?.('he', 'he');
      ctx.callbacks?.onText?.('llo', 'hello');
      return { stopReason: 'end_turn', finalText: 'hello' };
    };
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
    });
    const { ctx, pushes } = makeTurnCtx();
    await runTurn(ctx);
    // push is async — let the fire-and-forget complete.
    await new Promise((r) => setTimeout(r, 1));
    expect(pushes).toEqual(['he', 'llo']);
  });

  test('P2-bridge-ext — onToolCall fires pushToolCall on turnCtx', async () => {
    runCoreTurnImpl = async (ctx) => {
      ctx.callbacks?.onToolCall?.({ id: 'c1', name: 'echo', args: { x: 1 } });
      ctx.callbacks?.onToolCall?.({ id: 'c2', name: 'bash', args: { cmd: 'ls' } });
      return { stopReason: 'end_turn', finalText: '' };
    };
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
    });
    const { ctx, toolCalls } = makeTurnCtx();
    await runTurn(ctx);
    await new Promise((r) => setTimeout(r, 1));
    expect(toolCalls).toEqual([
      { id: 'c1', name: 'echo', args: { x: 1 } },
      { id: 'c2', name: 'bash', args: { cmd: 'ls' } },
    ]);
  });

  test('P2-bridge-ext — onToolResult fires pushToolResult on turnCtx', async () => {
    runCoreTurnImpl = async (ctx) => {
      ctx.callbacks?.onToolResult?.({ id: 'c1', name: 'echo', result: { ok: true } });
      return { stopReason: 'end_turn', finalText: '' };
    };
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
    });
    const { ctx, toolResults } = makeTurnCtx();
    await runTurn(ctx);
    await new Promise((r) => setTimeout(r, 1));
    expect(toolResults).toEqual([{ id: 'c1', name: 'echo', result: { ok: true } }]);
  });

  test('P2-bridge-ext — onUsage fires pushUsage on turnCtx', async () => {
    runCoreTurnImpl = async (ctx) => {
      ctx.callbacks?.onUsage?.({ provider: 'anthropic', inputTokens: 10, outputTokens: 4 });
      return { stopReason: 'end_turn', finalText: '' };
    };
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
      resolveModel: () => 'routed-model-x',
    });
    const { ctx, usages } = makeTurnCtx();
    await runTurn(ctx);
    await new Promise((r) => setTimeout(r, 1));
    // 턴 모델(라우팅 결과)을 실어 보낸다 — 대시보드 턴 지표가 설정 모델로 ctx·단가를 잡지 않게.
    expect(usages).toEqual([{ provider: 'anthropic', model: 'routed-model-x', inputTokens: 10, outputTokens: 4 }]);
  });

  test('onUsage — 내보내는 쪽이 준 모델이 라우팅 모델보다 이긴다', async () => {
    runCoreTurnImpl = async (ctx) => {
      ctx.callbacks?.onUsage?.({ provider: 'openai', model: 'emitter-model', inputTokens: 1 });
      return { stopReason: 'end_turn', finalText: '' };
    };
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
      resolveModel: () => 'routed-model-x',
    });
    const { ctx, usages } = makeTurnCtx();
    await runTurn(ctx);
    await new Promise((r) => setTimeout(r, 1));
    expect(usages).toEqual([{ provider: 'openai', model: 'emitter-model', inputTokens: 1 }]);
  });

  test('onTurnComplete forwards to deps hook with sessionId', async () => {
    runCoreTurnImpl = async (ctx) => {
      ctx.callbacks?.onTurnComplete?.([
        { role: 'assistant', content: 'ack' },
      ]);
      return { stopReason: 'end_turn', finalText: 'ack' };
    };
    const completeSeen: Array<{ sessionId: string; count: number }> = [];
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
      onTurnComplete: ({ sessionId, newMessages }) => {
        completeSeen.push({ sessionId, count: newMessages.length });
      },
    });
    const { ctx } = makeTurnCtx({ sessionId: 'sess-9' });
    await runTurn(ctx);
    await new Promise((r) => setTimeout(r, 1));
    expect(completeSeen).toEqual([{ sessionId: 'sess-9', count: 1 }]);
  });

  test('records when an unknown model disables the context-pressure bail safeguard', async () => {
    const log = spyOn(debug, 'log');
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
      resolveModel: () => 'totally-unknown-model',
    });

    await runTurn(makeTurnCtx().ctx);

    expect(log).toHaveBeenCalledWith('acp.turn', 'context-pressure-bail-disabled', {
      model: 'totally-unknown-model',
      safeguard: 'context-pressure-bail',
    });
    expect(runCoreTurnCalls).toHaveLength(1);
    expect(runCoreTurnCalls[0]!.ctx.modelOverride).toBe('totally-unknown-model');
  });

  test('resolveModel / resolveMaxToolTurns are wired through', async () => {
    let routeText = '';
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
      resolveModel: ({ sessionId, userText }) => {
        routeText = userText;
        return sessionId === 'sess-sonnet' ? 'claude-3-5-sonnet-latest' : undefined;
      },
      resolveMaxToolTurns: () => 20,
    });
    const { ctx } = makeTurnCtx({ sessionId: 'sess-sonnet' });
    await runTurn(ctx);
    const built = runCoreTurnCalls[0]!.ctx;
    expect(built.modelOverride).toBe('claude-3-5-sonnet-latest');
    expect(built.maxToolTurns).toBe(20);
    expect(routeText).toBe('hello');
  });

  test('omits modelOverride/maxToolTurns when resolvers return undefined', async () => {
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
    });
    const { ctx } = makeTurnCtx();
    await runTurn(ctx);
    const built = runCoreTurnCalls[0]!.ctx;
    expect(built.modelOverride).toBeUndefined();
    expect(built.maxToolTurns).toBeUndefined();
  });
});

describe('bridgeCoreTurnToAcp — abort polling', () => {
  test('flipping isAborted aborts the core-turn signal', async () => {
    const { ctx, setAborted } = makeTurnCtx();
    let capturedSignal: AbortSignal | null = null;
    runCoreTurnImpl = async (coreCtx) => {
      capturedSignal = coreCtx.signal;
      setAborted(true);
      // Wait long enough for the poll to trip at least once.
      await new Promise((r) => setTimeout(r, 15));
      return { stopReason: 'aborted', finalText: '' };
    };
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
      abortPollMs: 2,
    });
    await runTurn(ctx);
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(true);
  });

  test('pre-aborted turn still reaches runCoreTurn so the adapter can short-circuit', async () => {
    const { ctx, setAborted } = makeTurnCtx();
    setAborted(true);
    const runTurn = bridgeCoreTurnToAcp({
      getMessages: defaultAcpMessagesSeed,
      getTools: () => [],
      dispatchTool: async () => null,
      abortPollMs: 2,
    });
    await runTurn(ctx);
    // The bridge doesn't short-circuit — runCoreTurn itself returns
    // { stopReason: 'aborted' } when signal is already aborted.
    // What the bridge MUST do is pass an aborted signal in, which
    // it does because the first poll tick fires before runCoreTurn
    // receives the ctx. On very fast machines the first tick may
    // land after — so the contract under test here is looser:
    // runCoreTurn is invoked (i.e. no exception, no hang).
    expect(runCoreTurnCalls).toHaveLength(1);
  });
});

describe('TUI ACP durable persistence', () => {
  test('adopts the ACP id once, persists repeated completed turns, is searchable, and leaves external ACP untouched', async () => {
    const tuiMeta = writeOriginSessionMeta('tui-parent-session');
    persistCompletedTuiAcpTurn('elanous-session-tui', tuiMeta, 'find this TUI prompt', 'first answer');
    persistCompletedTuiAcpTurn('elanous-session-tui', tuiMeta, 'find this TUI prompt', 'first answer');
    persistCompletedTuiAcpTurn('elanous-session-tui', tuiMeta, 'second TUI prompt', 'second answer');
    persistCompletedTuiAcpTurn('elanous-session-external', undefined, 'external prompt', 'external answer');

    const stored = loadSession('elanous-session-tui');
    expect(stored?.meta).toMatchObject({
      id: 'elanous-session-tui',
      source: 'tui',
      transport: 'acp',
    });
    expect(stored?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'find this TUI prompt'],
      ['assistant', 'first answer'],
      ['user', 'find this TUI prompt'],
      ['assistant', 'first answer'],
      ['user', 'second TUI prompt'],
      ['assistant', 'second answer'],
    ]);
    const directTui = createSession({ source: 'tui' });
    expect(directTui.transport).toBeUndefined();
    expect(loadSession(directTui.id)?.meta.transport).toBeUndefined();

    const search = await dispatchSessionQuery(
      { action: 'search', query: 'second TUI prompt', source: 'tui' },
      { root: sessionRoot },
    ) as { hits: Array<{ sessionId: string; source: string; snippets: Array<{ role: string; text: string }> }> };
    expect(search.hits).toEqual([
      expect.objectContaining({
        sessionId: 'elanous-session-tui',
        source: 'tui',
        snippets: [expect.objectContaining({ role: 'user', text: expect.stringContaining('second TUI prompt') })],
      }),
    ]);
    expect(loadSession('elanous-session-external')).toBeNull();
  });

  test('reads a legacy transport-less index record without assigning a transport', () => {
    const id = 'legacy-tui-session';
    writeFileSync(join(sessionRoot, 'index.json'), JSON.stringify([{
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'legacy',
      provider: 'auto',
      model: '',
      messageCount: 0,
      source: 'tui',
    }]));
    writeFileSync(join(sessionRoot, `${id}.jsonl`), '');

    expect(loadSession(id)?.meta).toMatchObject({ id, source: 'tui' });
    expect(loadSession(id)?.meta.transport).toBeUndefined();
  });

  test('persists a DashboardSession.send turn through the real ACP prompt handler', async () => {
    runCoreTurnImpl = async (ctx) => {
      ctx.callbacks?.onText?.('server answer', 'server answer');
      return { stopReason: 'end_turn', finalText: 'server answer' };
    };
    const session = await DashboardSession.create({
      cwd: '/tmp',
      getMessages: () => [{ role: 'user', content: 'TUI integration prompt' }],
      getTools: () => [],
      dispatchTool: async () => null,
    });
    session.setOriginSessionIdReader(() => 'durable-tui-origin');
    try {
      await session.send({ userText: 'TUI integration prompt' });
      const stored = loadSession(session.id);
      expect(stored?.meta).toMatchObject({ id: session.id, source: 'tui' });
      expect(stored?.messages.map((message) => [message.role, message.content])).toEqual([
        ['user', 'TUI integration prompt'],
        // A plain read prompt routes to 읽기·분석, and its route line is part of the turn as on every non-goal route.
        ['assistant', '라우팅: 읽기·분석\nserver answer'],
      ]);
    } finally {
      await session.close();
    }
  });

  test('does not persist a cancelled DashboardSession.send turn', async () => {
    let resolveTurnStarted: (() => void) | undefined;
    const turnStarted = new Promise<void>((resolve) => { resolveTurnStarted = resolve; });
    let resolveTurn: (() => void) | undefined;
    const turnCanFinish = new Promise<void>((resolve) => { resolveTurn = resolve; });
    const session = await DashboardSession.create({
      cwd: '/tmp',
      getMessages: () => [{ role: 'user', content: 'cancelled TUI prompt' }],
      getTools: () => [],
      dispatchTool: async () => null,
      serverOptions: {
        runTurn: async () => {
          resolveTurnStarted?.();
          await turnCanFinish;
        },
      },
    });
    session.setOriginSessionIdReader(() => 'durable-tui-origin');
    const controller = new AbortController();
    try {
      const sending = session.send({ userText: 'cancelled TUI prompt', signal: controller.signal });
      await turnStarted;
      controller.abort();
      resolveTurn?.();
      await sending;
      expect(loadSession(session.id)).toBeNull();
    } finally {
      await session.close();
    }
  });
});

describe('defaultAcpMessagesSeed', () => {
  test('returns single user message with the prompt text', () => {
    const msgs = defaultAcpMessagesSeed({ sessionId: 's', userText: 'hi' });
    expect(msgs).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
