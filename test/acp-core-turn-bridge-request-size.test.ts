// TUI-TOKEN-GUARD-WIRE — the #32254 request-size cap on the production TUI path.
//
// The TUI runs DashboardSession → bridgeCoreTurnToAcp → runCoreTurn, not
// session/chat.ts runTurn. Before this cell the bridge built a CoreTurnContext
// with no `requestSizeGuard`, so a 2M-char history went to Codex uncompacted
// and no `request-size-compact` event fired. These tests lock:
//   ① preflight — an over-cap seed compacts the host history store in place
//     (write-back), the bridge re-reads it, the core turn gets < cap, and the
//     event fires; the next prompt reads the compacted history;
//   ② wire guard — the guard the bridge attaches is the one llm.ts's Codex
//     path consumes: an over-cap wire body is compacted under the cap, the
//     event fires, and the first compacted request also writes back.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROVIDERS, streamLLMWithTools, type LLMMessage, type LLMToolSpec } from '../src/llm.js';
import type { ChatMessage } from '../src/chat/index.js';
import type { AcpTurnContext } from '../src/acp/server.js';
import { debug } from '../src/debug/log.js';
import * as coreTurnModule from '../src/core-turn/index.js';
import type { CoreTurnContext, CoreTurnResult } from '../src/core-turn/index.js';
import * as userConfigModule from '../src/user-config.js';
import { bootDashboardAcpSession, compactDashboardChatHistory } from '../src/dashboard/acp-boot.js';
import { estimateRequestChars, REQUEST_SIZE_MAX_CHARS } from '../src/session/request-size-guard.js';
import { resetAutoCompactStateForTest } from '../src/compact/auto-state.js';
import { saveTokens } from '../src/oauth/store.js';

const { bridgeCoreTurnToAcp } = await import('../src/acp/core-turn-bridge.js');

type DebugCall = { category: string; event: string; data: Record<string, unknown> };

let root = '';
let debugCalls: DebugCall[] = [];
let coreCalls: CoreTurnContext[] = [];
let coreImpl: (ctx: CoreTurnContext) => Promise<CoreTurnResult> = async () => ({ stopReason: 'end_turn', finalText: '' });
let previousFetch: typeof fetch;
let wires: string[] = [];
const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_SESSION_ROOT', 'ELANOUS_TEST_FAKE_LLM'] as const;
let savedEnv: Partial<Record<typeof envKeys[number], string>> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-request-size-'));
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  resetAutoCompactStateForTest();
  debugCalls = [];
  coreCalls = [];
  wires = [];
  coreImpl = async () => ({ stopReason: 'end_turn', finalText: '' });
  spyOn(userConfigModule, 'getUserConfig').mockReturnValue({
    llm: { model: 'gpt-5.6-terra', goalLoop: { enabled: false } },
    chat: {
      factQuestion: { maxToolTurns: 3 },
      autoCompact: { enabled: true, triggerRatio: 0.9, preserveLastN: 2, preserveFirstN: 0, partial: true, workingBudgetTokens: 128_000 },
      compact: { archiveEnabled: false },
    },
  } as unknown as ReturnType<typeof userConfigModule.getUserConfig>);
  const realLog = debug.log.bind(debug);
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown, opts?: unknown) => {
    debugCalls.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    return (realLog as (...args: unknown[]) => unknown)(category, event, data, opts);
  }) as typeof debug.log);
  spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
    coreCalls.push(ctx);
    return coreImpl(ctx);
  });
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    wires.push(String(init?.body ?? ''));
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"compact summary"}',
      '',
      'data: {"choices":[{"delta":{"content":"compact summary"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  mock.restore();
  resetAutoCompactStateForTest();
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function turnCtx(userText: string, statusLines: string[] = []): AcpTurnContext {
  return {
    sessionId: 'acp-sess',
    cwd: root,
    userText,
    promptBlocks: [{ type: 'text', text: userText }],
    isAborted: () => false,
    push: async () => {},
    pushWithMeta: async () => {},
    pushSessionUpdate: async (update: unknown) => {
      const text = (update as { content?: { text?: string } }).content?.text;
      if (typeof text === 'string') statusLines.push(text);
    },
    pushToolCall: async () => {},
    pushToolResult: async () => {},
    pushUsage: async () => {},
    requestApproval: async () => 'deny-once',
  } as unknown as AcpTurnContext;
}

/** A dashboard-like host: `chat.history` store + buildTurnMessages-like seed. */
function makeHost(history: ChatMessage[], compactHistoryMessages?: Parameters<typeof compactDashboardChatHistory>[0]['compactHistoryMessages']) {
  const host = {
    history,
    replaced: 0,
    getMessages: ({ userText }: { userText: string }): LLMMessage[] => {
      const last = host.history.at(-1);
      const trailingText = typeof last?.content === 'string'
        ? last.content
        : Array.isArray(last?.content)
          ? last.content.filter((block) => block && typeof block === 'object' && 'text' in block)
            .map((block) => (block as { text?: unknown }).text).filter((text): text is string => typeof text === 'string').join('\n')
          : '';
      const messages: LLMMessage[] = [
        { role: 'system', content: 'preamble' },
        ...(host.history as unknown as LLMMessage[]),
      ];
      if (!(last?.role === 'user' && trailingText.includes(userText))) messages.push({ role: 'user', content: userText });
      return messages;
    },
    compactPersistedHistory: (ctx: { sessionId: string; userText: string }) => compactDashboardChatHistory({
      getChatHistory: () => host.history,
      replaceChatHistory: (next) => { host.history = [...next]; host.replaced += 1; },
      getActiveModel: () => null,
      ...(compactHistoryMessages ? { compactHistoryMessages } : {}),
    }, ctx),
  };
  return host;
}

const tools: LLMToolSpec[] = [{ name: 'Read', description: 'read', parameters: { type: 'object' } }];
const sizeEvents = () => debugCalls.filter(call => call.category === 'llm.request' && call.event === 'request-size-compact');

describe('TUI-TOKEN-GUARD-WIRE — ACP bridge request-size cap', () => {
  test('persisted compaction keeps the current user text+image block verbatim', async () => {
    const current: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this image' },
        { type: 'image', mediaType: 'image/png', base64: 'aGVsbG8=' },
      ] as any,
    };
    let written: readonly ChatMessage[] = [];
    const result = await compactDashboardChatHistory({
      getChatHistory: () => [{ role: 'user', content: 'old context' }, current],
      replaceChatHistory: (next) => { written = next; },
      getActiveModel: () => null,
      compactHistoryMessages: async (messages) => ({ messages: messages.slice(-1), reason: 'test-compaction' }),
    }, { sessionId: 'image-session', userText: 'inspect this image' });

    expect(result.fired).toBe(true);
    expect(written.at(-1)).toEqual(current);
  });

  test('an over-cap seed estimate does not write history before exact wire measurement', async () => {
    // 460 × ~1,000 chars ≈ 460k chars of history — over the 400k cap (the prod incident was 2.1M).
    const big: ChatMessage[] = Array.from({ length: 460 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i} ${'x'.repeat(1_000)}`,
    }) as unknown as ChatMessage);
    const host = makeHost(big, async (messages) => ({
      // Deterministic stand-in for the summarizer: summary + last two messages.
      messages: [{ role: 'system', content: '<context_summary>\nearlier work\n</context_summary>' }, ...messages.slice(-2)],
      reason: 'live-request-compact',
    }));
    expect(estimateRequestChars(host.getMessages({ userText: 'next step' }), tools)).toBeGreaterThan(REQUEST_SIZE_MAX_CHARS);

    const runTurn = bridgeCoreTurnToAcp({
      tuiRouting: true,
      getMessages: host.getMessages,
      getTools: () => tools,
      dispatchTool: async () => 'ok',
      compactPersistedHistory: host.compactPersistedHistory,
    });
    await runTurn(turnCtx('next step'));

    expect(coreCalls).toHaveLength(1);
    const sent = coreCalls[0]!;
    expect(sent.requestSizeGuard?.maxChars).toBe(REQUEST_SIZE_MAX_CHARS);
    expect(estimateRequestChars(sent.messages, tools)).toBeGreaterThan(REQUEST_SIZE_MAX_CHARS);
    expect(sent.messages.filter(m => m.role === 'user' && m.content === 'next step')).toHaveLength(1);
    // An approximate seed estimate cannot authorize mutation before provider wire measurement.
    expect(host.replaced).toBe(0);
    expect(sizeEvents().some(call => call.data.stage === 'estimate' && call.data.compacted === false)).toBe(true);

    debugCalls = [];
    await runTurn(turnCtx('and then'));
    expect(coreCalls).toHaveLength(2);
    expect(estimateRequestChars(coreCalls[1]!.messages, tools)).toBeGreaterThan(REQUEST_SIZE_MAX_CHARS);
    expect(host.replaced).toBe(0);
  });

  test('the bridge guard compacts an over-cap Codex wire body under the cap and writes back the first request', async () => {
    saveTokens('openai-codex', {
      accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresAt: null,
    }, { mirrorCodex: false, codexHome: process.env.CODEX_HOME });
    const history: ChatMessage[] = Array.from({ length: 7 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `older-${i} ${'history '.repeat(70)}`,
    }) as unknown as ChatMessage);
    const imageTurn: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'latest ask' },
        { type: 'image', mediaType: 'image/png', base64: 'aGVsbG8=' },
      ] as any,
    };
    history.push(imageTurn);
    const host = makeHost(history);
    const statusLines: string[] = [];
    // Drive the real Codex provider (fetch stubbed) with the ctx the bridge built.
    coreImpl = async (ctx) => {
      const codex = PROVIDERS['openai-codex']!;
      for await (const _event of codex.streamChat!([...ctx.messages], {
        model: 'gpt-5.6-terra',
        ...(ctx.requestSizeGuard ? { requestSizeGuard: ctx.requestSizeGuard } : {}),
      })) { /* drain */ }
      return { stopReason: 'end_turn', finalText: '' };
    };
    const booted = await bootDashboardAcpSession({
      getCwd: () => root,
      getChatHistory: () => host.history,
      getPreamble: () => [],
      getTools: () => [],
      getActiveModel: () => 'gpt-5.6-terra',
      dispatchTool: async () => 'ok',
      pushTurnToolHistory: () => {},
      replaceChatHistory: (next) => { host.history = [...next]; host.replaced += 1; },
      compactHistoryMessages: async (messages) => ({ messages: [{ role: 'user', content: 'condensed prior context' }, ...messages.slice(-1)], reason: 'test-compaction' }),
      // Seed estimate fits while exact Codex framing exceeds this cap.
      requestSizeMaxChars: estimateRequestChars(host.getMessages({ userText: 'latest ask' })) + 20,
    });
    const codex = PROVIDERS['openai-codex']!;
    const testProvider = {
      ...codex,
      async *streamChat(messages: LLMMessage[], opts: Parameters<NonNullable<typeof codex.streamChat>>[1]) {
        yield* codex.streamChat!(messages, opts);
      },
    };
    coreImpl = async (ctx) => {
      const finalText = await streamLLMWithTools([...ctx.messages], {
        onText: (delta, full) => ctx.callbacks?.onText?.(delta, full),
        dispatchTool: ctx.dispatchTool,
      }, {
        provider: testProvider,
        model: 'gpt-5.6-terra',
        tools: ctx.tools,
        signal: ctx.signal,
        ...(ctx.requestSizeGuard ? { requestSizeGuard: ctx.requestSizeGuard } : {}),
      });
      return { stopReason: 'end_turn', finalText };
    };
    try {
      await booted.session.send({ userText: 'latest ask', onStatus: (line) => statusLines.push(line) });
    } finally {
      await booted.session.close();
    }

    expect(coreCalls).toHaveLength(1);
    const cap = coreCalls[0]!.requestSizeGuard!.maxChars;
    const wire = sizeEvents().find(call => call.data.provider === 'openai-codex');
    expect(wire).toBeDefined();
    expect(wire!.data.compacted).toBe(true);
    expect(Number(wire!.data.beforeChars)).toBeGreaterThan(cap);
    expect(Number(wire!.data.afterChars)).toBeLessThanOrEqual(cap);
    const codexWire = wires.find(body => body.includes('"input"') && body.includes('latest ask'));
    expect(codexWire).toBeDefined();
    expect(codexWire!.length).toBeLessThanOrEqual(cap);
    expect(codexWire).toContain('aGVsbG8=');
    // First compacted request also persisted into the host store.
    expect(host.replaced).toBe(1);
    expect(host.history.at(-1)).toEqual(imageTurn);
    expect(statusLines.some(line => line.includes('· compact'))).toBe(true);
  });
});
