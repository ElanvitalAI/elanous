// U3c Phase 4 — DashboardSession end-to-end round-trip test.
//
// Proves the full ACP-bridge fabric works when a real in-process
// server + client pair is wired together:
//
//   1. `DashboardSession.create(opts)` boots the server + client,
//      completes the ACP handshake, and exposes `.send(...)`.
//   2. Calling `.send({ userText })` reaches the server, which hands
//      the turn to `bridgeCoreTurnToAcp` → `runCoreTurn` →
//      `streamLLMWithTools` (mocked here so we observe just the
//      bridge's fanout, not the LLM).
//   3. Text deltas come back via `onText`; tool call/result land on
//      `onToolCall`/`onToolResult`; usage lands on `onUsage`.
//   4. `stopReason` resolves to `'end_turn'` for the happy path.
//
// This is the parity-style proof Phase 5's migration leans on: as
// long as this round-trip reproduces the direct-path events faithfully,
// flipping a substitution site onto `DashboardSession.send(...)` is a
// structural swap, not a behavioral redesign.

import { describe, expect, test, mock, spyOn, beforeEach, afterEach } from 'bun:test';

import type {
  LLMMessage,
  LLMToolSpec,
  StreamWithToolsHandlers,
} from '../src/llm.js';
import * as llmModule from '../src/llm.js';
import { isTuiRouteLine } from '../src/core-turn/short-question.js';

type StreamCall = {
  messages: LLMMessage[];
  handlers: StreamWithToolsHandlers;
  opts: Record<string, unknown>;
};
const streamCalls: StreamCall[] = [];
let streamImpl: (args: StreamCall) => Promise<string> = async () => '';

const { DashboardSession } = await import('../src/tui-client/dashboard-session.js');

// DashboardSession 은 tuiRouting 이 켜져 있어 goal loop 밖 턴은 답 앞에 «라우팅 줄»을 먼저 보낸다(#27555).
// 그 줄은 브리지의 안내이지 모델 스트림이 아니다 — 왕복 단언은 모델이 낸 청크만 본다.
const modelText = (texts: readonly string[]): string[] => texts.filter((t) => !isTuiRouteLine(t));

const tool: LLMToolSpec = {
  name: 'echo',
  description: '',
  parameters: { type: 'object', properties: {} },
};

beforeEach(() => {
  streamCalls.length = 0;
  streamImpl = async () => '';
  // BACKLOG #5 — spyOn `streamLLMWithTools` per-file. Pre-cleanup
  // version used `mock.module()` which leaked process-wide. The
  // runCoreTurn path only drives this branch when tools[] is
  // non-empty; tests below always supply at least one LLMToolSpec.
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(
    (async (
      messages: LLMMessage[],
      handlers: StreamWithToolsHandlers,
      opts?: Record<string, unknown>,
    ): Promise<string> => {
      const call: StreamCall = { messages, handlers, opts: opts ?? {} };
      streamCalls.push(call);
      return streamImpl(call);
    }) as typeof llmModule.streamLLMWithTools,
  );
});

afterEach(() => {
  streamCalls.length = 0;
  mock.restore();
});

describe('DashboardSession — full ACP round-trip (Phase 4)', () => {
  test('text + tool + usage events flow through ACP in-process', async () => {
    streamImpl = async ({ handlers }) => {
      handlers.onText('hel', 'hel');
      handlers.onText('lo', 'hello');
      handlers.onToolCall?.({ id: 'c1', name: 'echo', args: { x: 1 } });
      handlers.onToolResult?.({ id: 'c1', name: 'echo', result: { ok: true } });
      handlers.onUsage?.({ provider: 'anthropic', inputTokens: 7, outputTokens: 2 });
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'hello' }]);
      return 'hello';
    };

    const session = await DashboardSession.create({
      cwd: '/tmp',
      getMessages: () => [{ role: 'user', content: 'hi' }],
      getTools: () => [tool],
      dispatchTool: async () => null,
    });

    const texts: string[] = [];
    const toolCalls: Array<{ id: string; name: string }> = [];
    const toolResults: Array<{ id: string; name: string; result: unknown }> = [];
    const usages: Array<Record<string, unknown>> = [];

    const { stopReason } = await session.send({
      userText: 'hi',
      onText: (t) => texts.push(t),
      onToolCall: (c) => toolCalls.push({ id: c.id, name: c.name }),
      onToolResult: (c) => toolResults.push({ id: c.id, name: c.name, result: c.result }),
      onUsage: (u) => usages.push(u as Record<string, unknown>),
    });

    expect(stopReason).toBe('end_turn');
    expect(modelText(texts).join('')).toBe('hello');
    expect(toolCalls).toEqual([{ id: 'c1', name: 'echo' }]);
    expect(toolResults).toEqual([{ id: 'c1', name: 'echo', result: { ok: true } }]);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ provider: 'anthropic', inputTokens: 7, outputTokens: 2 });

    await session.close();
  });

  test('callers can opt out of any individual callback', async () => {
    streamImpl = async ({ handlers }) => {
      handlers.onText('ok', 'ok');
      handlers.onToolCall?.({ id: 'c2', name: 'echo', args: {} });
      handlers.onUsage?.({ provider: 'openai', outputTokens: 3 });
      return 'ok';
    };

    const session = await DashboardSession.create({
      cwd: '/tmp',
      getMessages: () => [{ role: 'user', content: 'hi' }],
      getTools: () => [tool],
      dispatchTool: async () => null,
    });

    const texts: string[] = [];
    const { stopReason } = await session.send({
      userText: 'hi',
      onText: (t) => texts.push(t),
      // intentionally no onToolCall / onToolResult / onUsage — must not throw
    });
    expect(stopReason).toBe('end_turn');
    expect(modelText(texts)).toEqual(['ok']);

    await session.close();
  });

  test('getMessages + getTools receive the session id', async () => {
    streamImpl = async () => '';
    const seenMessages: unknown[] = [];
    const seenTools: unknown[] = [];
    const session = await DashboardSession.create({
      cwd: '/tmp',
      getMessages: (ctx) => {
        seenMessages.push(ctx);
        return [{ role: 'user', content: ctx.userText }];
      },
      getTools: (ctx) => {
        seenTools.push(ctx);
        return [tool];
      },
      dispatchTool: async () => null,
    });

    await session.send({ userText: 'test' });

    expect(seenMessages).toHaveLength(1);
    expect(seenTools).toHaveLength(1);
    const seenMsg = seenMessages[0] as { sessionId: string; userText: string };
    expect(seenMsg.userText).toBe('test');
    expect(typeof seenMsg.sessionId).toBe('string');
    expect(seenMsg.sessionId.length).toBeGreaterThan(0);

    await session.close();
  });

  test('onTurnComplete persistence hook fires with new messages', async () => {
    streamImpl = async ({ handlers }) => {
      handlers.onTurnComplete?.([
        { role: 'assistant', content: 'ack' },
      ]);
      return 'ack';
    };

    const captured: Array<{ sessionId: string; count: number }> = [];
    const session = await DashboardSession.create({
      cwd: '/tmp',
      getMessages: () => [{ role: 'user', content: 'hi' }],
      getTools: () => [tool],
      dispatchTool: async () => null,
      onTurnComplete: ({ sessionId, newMessages }) => {
        captured.push({ sessionId, count: newMessages.length });
      },
    });

    await session.send({ userText: 'hi' });
    // onTurnComplete in the bridge is async — give it one microtask.
    await new Promise((r) => setTimeout(r, 1));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.count).toBe(1);
    expect(typeof captured[0]!.sessionId).toBe('string');

    await session.close();
  });
});
