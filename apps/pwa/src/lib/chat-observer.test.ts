/**
 * Phase B-4 follow-up (PWA chat streaming · 2026-05-06) — observer
 * runtime contract.
 *
 * `runChatTurnObserver` is the multi-tab consistency consumer: it
 * subscribes to /v1/chat/events for the current sessionId and
 * translates the SSE wire (turn-begin / text-delta / image-block /
 * tool-call / tool-result / turn-end) into the same placeholder +
 * blocks lifecycle that ChatLayout uses for its own POST turns.
 *
 * Three layers covered:
 * 1. `consumeObserverSse` — multi-turn parser (no terminal resolve).
 * 2. `runChatTurnObserver` — placeholder synthesis · block accum ·
 *    dedupe via isLocalTurnInFlight.
 * 3. fetch-level subscription wiring — `subscribeChatEvents` calls
 *    GET /v1/chat/events?sessionId=… with the right headers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DaemonClient, consumeObserverSse } from './daemon-client';
import {
  runChatTurnObserver,
  type ChatBlock,
  type ChatMessage,
} from './chat-runtime';

interface FetchCall {
  url: string | URL;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function mockObserverResponse(chunks: string[]): typeof fetch {
  return ((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input as string | URL, init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: makeStream(chunks),
      text: async () => chunks.join(''),
    } as unknown as Response;
  }) as unknown) as typeof fetch;
}

function makeClient(opts: { baseUrl?: string; token?: string } = {}): DaemonClient {
  return new DaemonClient({
    baseUrl: opts.baseUrl ?? 'http://localhost:31415',
    token: opts.token ?? '',
    provider: 'anthropic',
  });
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('consumeObserverSse — multi-turn parser', () => {
  it('dispatches turn lifecycle events to handlers without terminating on turn-end', async () => {
    const trace: string[] = [];
    const stream = makeStream([
      `event: subscribed\ndata: {"sessionId":"sess-1"}\n\n`,
      `event: turn-begin\ndata: {"sessionId":"sess-1"}\n\n`,
      `event: text-delta\ndata: {"delta":"Hi","full":"Hi"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-1","text":"Hi","stopReason":"end_turn"}\n\n`,
      // Second turn on same stream — observer must keep going.
      `event: turn-begin\ndata: {"sessionId":"sess-1"}\n\n`,
      `event: text-delta\ndata: {"delta":"Bye","full":"Bye"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-1","text":"Bye","stopReason":"end_turn"}\n\n`,
    ]);
    await consumeObserverSse(stream, {
      onTurnBegin: ({ sessionId }) => trace.push(`begin:${sessionId}`),
      onTextDelta: ({ full }) => trace.push(`delta:${full}`),
      onTurnEnd: ({ text }) => trace.push(`end:${text}`),
    });
    // Two complete turn cycles observed on a single subscription.
    expect(trace).toEqual([
      'begin:sess-1',
      'delta:Hi',
      'end:Hi',
      'begin:sess-1',
      'delta:Bye',
      'end:Bye',
    ]);
  });

  it('forwards error events to onError without breaking the stream', async () => {
    const errors: { error: string; message?: string }[] = [];
    const turns: string[] = [];
    const stream = makeStream([
      `event: turn-begin\ndata: {"sessionId":"sess-1"}\n\n`,
      `event: error\ndata: {"error":"turn_failed","message":"x"}\n\n`,
      // Next turn arrives anyway — observer keeps going.
      `event: turn-begin\ndata: {"sessionId":"sess-1"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-1","text":"recovered","stopReason":"end_turn"}\n\n`,
    ]);
    await consumeObserverSse(stream, {
      onTurnBegin: ({ sessionId }) => turns.push(`begin:${sessionId}`),
      onTurnEnd: ({ text }) => turns.push(`end:${text}`),
      onError: (info) => errors.push(info),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe('turn_failed');
    expect(turns).toEqual(['begin:sess-1', 'begin:sess-1', 'end:recovered']);
  });

  it('drops the synthetic `subscribed` marker silently (parser sees it as a no-op)', async () => {
    const events: string[] = [];
    const stream = makeStream([
      `event: subscribed\ndata: {"sessionId":"sess-1"}\n\n`,
      `event: turn-begin\ndata: {"sessionId":"sess-1"}\n\n`,
    ]);
    await consumeObserverSse(stream, {
      onTurnBegin: () => events.push('begin'),
      onTextDelta: () => events.push('delta'),
    });
    // No 'subscribed' handler; it should not appear via any other
    // dispatch path.
    expect(events).toEqual(['begin']);
  });
});

describe('DaemonClient.subscribeChatEvents — fetch wiring', () => {
  it('hits GET /v1/chat/events?sessionId=… with the bearer header', async () => {
    globalThis.fetch = mockObserverResponse([]);
    const client = makeClient({ token: 'tok-abc' });
    const dispose = client.subscribeChatEvents('sess-X', {});
    // Give the fire-and-forget IIFE a tick to call fetch.
    await new Promise((r) => setTimeout(r, 5));
    dispose();
    expect(String(calls[0]!.url)).toBe(
      'http://localhost:31415/v1/chat/events?sessionId=sess-X',
    );
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.accept).toBe('text/event-stream');
    expect(headers.authorization).toBe('Bearer tok-abc');
  });

  it('encodes special characters in the sessionId query param', async () => {
    globalThis.fetch = mockObserverResponse([]);
    const client = makeClient();
    const dispose = client.subscribeChatEvents('a/b c+d', {});
    await new Promise((r) => setTimeout(r, 5));
    dispose();
    expect(String(calls[0]!.url)).toBe(
      'http://localhost:31415/v1/chat/events?sessionId=a%2Fb%20c%2Bd',
    );
  });

  it('disposer aborts the underlying fetch', async () => {
    let abortObserved = false;
    globalThis.fetch = ((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: input as string | URL, init });
      // Never-resolving body so the consumer sits in the read loop;
      // the abort signal is the only exit. Race the read against a
      // tiny timer so the test doesn't hang on regression.
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              abortObserved = true;
              try { controller.close(); } catch { /* ignore */ }
            });
          },
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown) as typeof fetch;
    const client = makeClient();
    const dispose = client.subscribeChatEvents('sess-1', {});
    await new Promise((r) => setTimeout(r, 5));
    dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(abortObserved).toBe(true);
  });
});

describe('runChatTurnObserver — placeholder lifecycle', () => {
  it('carries the app_deploy receipt through the SSE observer', async () => {
    const receipt = { kind: 'site-deploy', status: 'published', publicUrl: 'https://demo--alice.elanous.app/' };
    globalThis.fetch = mockObserverResponse([
      `event: turn-begin\ndata: {"sessionId":"sess-deploy"}\n\n`,
      `event: tool-call\ndata: {"id":"d1","name":"app_deploy","args":{"appId":"demo"}}\n\n`,
      `event: tool-result\ndata: ${JSON.stringify({ id: 'd1', name: 'app_deploy', ok: true, result: receipt })}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-deploy","text":"배포 완료","stopReason":"end_turn"}\n\n`,
    ]);
    let final: ChatMessage | undefined;
    const dispose = runChatTurnObserver(makeClient(), 'sess-deploy', {
      onPlaceholder: () => 'p-deploy',
      onPartialBlocks: () => {},
      onFinalize: (_id, message) => { final = message; },
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    expect(final?.blocks?.find((block) => block.kind === 'deploy_result')).toEqual({ kind: 'deploy_result', toolId: 'd1',
      result: { status: 'published', publicUrl: receipt.publicUrl } });
  });
  it('uses turn-end text as the final answer even without a post-tool delta', async () => {
    globalThis.fetch = mockObserverResponse([
      `event: turn-begin\ndata: {"sessionId":"sess-final"}\n\n`,
      `event: text-delta\ndata: {"delta":"진행 중","full":"진행 중"}\n\n`,
      `event: tool-call\ndata: {"id":"t1","name":"Read"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-final","text":"최종 답","stopReason":"end_turn"}\n\n`,
    ]);
    let final: ChatMessage | undefined;
    const dispose = runChatTurnObserver(makeClient(), 'sess-final', {
      onPlaceholder: () => 'p-final',
      onPartialBlocks: () => {},
      onFinalize: (_id, message) => { final = message; },
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    expect(final?.text).toBe('최종 답');
    expect(final?.incomplete).toBeUndefined();
  });

  it('keeps abnormal turn-end prose folded', async () => {
    globalThis.fetch = mockObserverResponse([
      `event: turn-begin\ndata: {"sessionId":"sess-abort"}\n\n`,
      `event: text-delta\ndata: {"delta":"부분 답","full":"부분 답"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-abort","text":"부분 답","stopReason":"aborted"}\n\n`,
    ]);
    let final: ChatMessage | undefined;
    const dispose = runChatTurnObserver(makeClient(), 'sess-abort', {
      onPlaceholder: () => 'p-abort',
      onPartialBlocks: () => {},
      onFinalize: (_id, message) => { final = message; },
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    expect(final?.incomplete).toBe(true);
    expect(final?.meta?.stopReason).toBe('aborted');
  });

  it('synthesizes a placeholder on turn-begin and finalizes on turn-end', async () => {
    globalThis.fetch = mockObserverResponse([
      `event: subscribed\ndata: {"sessionId":"sess-rem"}\n\n`,
      `event: turn-begin\ndata: {"sessionId":"sess-rem"}\n\n`,
      `event: text-delta\ndata: {"delta":"Hi","full":"Hi"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-rem","text":"Hi","stopReason":"end_turn"}\n\n`,
    ]);
    const placeholders: { id: string; sessionId: string }[] = [];
    const finals: ChatMessage[] = [];
    const client = makeClient();
    const dispose = runChatTurnObserver(client, 'sess-rem', {
      onPlaceholder: ({ sessionId }) => {
        const id = `p-${placeholders.length}`;
        placeholders.push({ id, sessionId });
        return id;
      },
      onPartialBlocks: () => { /* ignored — checked via final */ },
      onFinalize: (_pid, msg) => finals.push(msg),
    });
    // Wait for the stream to drain.
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]!.sessionId).toBe('sess-rem');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('Hi');
    expect(finals[0]!.meta?.stopReason).toBe('end_turn');
  });

  it('drops events while isLocalTurnInFlight returns true (own-POST dedupe)', async () => {
    globalThis.fetch = mockObserverResponse([
      `event: subscribed\ndata: {"sessionId":"sess-dedupe"}\n\n`,
      `event: turn-begin\ndata: {"sessionId":"sess-dedupe"}\n\n`,
      `event: text-delta\ndata: {"delta":"x","full":"x"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-dedupe","text":"x","stopReason":"end_turn"}\n\n`,
    ]);
    const placeholders: { id: string }[] = [];
    const finals: ChatMessage[] = [];
    const client = makeClient();
    const dispose = runChatTurnObserver(client, 'sess-dedupe', {
      isLocalTurnInFlight: () => true, // simulate active local POST
      onPlaceholder: () => {
        placeholders.push({ id: 'p-x' });
        return 'p-x';
      },
      onPartialBlocks: () => {},
      onFinalize: (_pid, msg) => finals.push(msg),
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    // Placeholder never spawned; finalize never fired.
    expect(placeholders).toHaveLength(0);
    expect(finals).toHaveLength(0);
  });

  it('streams text + image + tool blocks into the placeholder via onPartialBlocks', async () => {
    globalThis.fetch = mockObserverResponse([
      `event: turn-begin\ndata: {"sessionId":"sess-mix"}\n\n`,
      `event: text-delta\ndata: {"delta":"He","full":"He"}\n\n`,
      `event: image-block\ndata: {"src":"data:image/png;base64,A","mediaType":"image/png"}\n\n`,
      `event: tool-call\ndata: {"id":"c1","name":"Read","args":{"path":"/tmp/x"}}\n\n`,
      `event: tool-result\ndata: {"id":"c1","name":"Read","ok":true,"summary":"3 lines"}\n\n`,
      `event: text-delta\ndata: {"delta":"llo","full":"Hello"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-mix","text":"Hello","stopReason":"end_turn"}\n\n`,
    ]);
    let lastBlocks: ChatBlock[] = [];
    let finalMsg: ChatMessage | null = null;
    const client = makeClient();
    const dispose = runChatTurnObserver(client, 'sess-mix', {
      onPlaceholder: () => 'p-1',
      onPartialBlocks: (_pid, blocks) => { lastBlocks = blocks; },
      onFinalize: (_pid, msg) => { finalMsg = msg; },
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    // Final blocks: text + image + tool_use (single tool because
    // tool-call+tool-result mutate the same block).
    const final = finalMsg as unknown as ChatMessage | null;
    expect(final).not.toBeNull();
    expect(final!.blocks).toBeDefined();
    expect(final!.blocks!.find((b) => b.kind === 'text')).toBeDefined();
    expect(final!.blocks!.find((b) => b.kind === 'image')).toBeDefined();
    const tool = final!.blocks!.find((b) => b.kind === 'tool_use');
    expect(tool).toBeDefined();
    expect((tool as { status: string }).status).toBe('done');
    // Last partial snapshot mirrors the final block list.
    expect(lastBlocks.length).toBe(final!.blocks!.length);
  });

  it('forwards error events to onError tagged with the placeholder id', async () => {
    globalThis.fetch = mockObserverResponse([
      `event: turn-begin\ndata: {"sessionId":"sess-err"}\n\n`,
      `event: error\ndata: {"error":"turn_failed","message":"boom"}\n\n`,
    ]);
    const errors: { id: string; info: { error: string } }[] = [];
    const client = makeClient();
    const dispose = runChatTurnObserver(client, 'sess-err', {
      onPlaceholder: () => 'p-err',
      onPartialBlocks: () => {},
      onFinalize: () => {},
      onError: (id, info) => errors.push({ id, info }),
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe('p-err');
    expect(errors[0]!.info.error).toBe('turn_failed');
  });

  it('host can veto a turn by returning null from onPlaceholder', async () => {
    globalThis.fetch = mockObserverResponse([
      `event: turn-begin\ndata: {"sessionId":"sess-veto"}\n\n`,
      `event: text-delta\ndata: {"delta":"x","full":"x"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-veto","text":"x","stopReason":"end_turn"}\n\n`,
    ]);
    let onPartialFired = false;
    let onFinalizeFired = false;
    const client = makeClient();
    const dispose = runChatTurnObserver(client, 'sess-veto', {
      onPlaceholder: () => null, // veto
      onPartialBlocks: () => { onPartialFired = true; },
      onFinalize: () => { onFinalizeFired = true; },
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    expect(onPartialFired).toBe(false);
    expect(onFinalizeFired).toBe(false);
  });

  it('a fresh turn-begin after disconnect mid-stream resets accumulator state', async () => {
    globalThis.fetch = mockObserverResponse([
      `event: turn-begin\ndata: {"sessionId":"sess-reset"}\n\n`,
      `event: text-delta\ndata: {"delta":"first","full":"first"}\n\n`,
      // No turn-end; second turn starts cold.
      `event: turn-begin\ndata: {"sessionId":"sess-reset"}\n\n`,
      `event: text-delta\ndata: {"delta":"second","full":"second"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-reset","text":"second","stopReason":"end_turn"}\n\n`,
    ]);
    const placeholders: string[] = [];
    const interrupted: string[] = [];
    let finalMsg: ChatMessage | null = null;
    const client = makeClient();
    const dispose = runChatTurnObserver(client, 'sess-reset', {
      onPlaceholder: () => {
        const id = `p-${placeholders.length}`;
        placeholders.push(id);
        return id;
      },
      onPartialBlocks: () => {},
      onFinalize: (_pid, msg) => { finalMsg = msg; },
      onInterrupted: (id) => { interrupted.push(id); },
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    // Two placeholders allocated (one per turn-begin).
    expect(placeholders).toEqual(['p-0', 'p-1']);
    expect(interrupted).toEqual(['p-0']);
    // Final text = second turn's content (not "firstsecond").
    const final = finalMsg as unknown as ChatMessage | null;
    expect(final!.text).toBe('second');
  });
});

/** ⛔⭐⭐⭐ 📏 2026-08-22 라이브(16차 `[F]`): ***위젯이 영영 비어 있었던 이유가 여기였다.***
 *
 *  같은 `mcp_app` 블록을 만드는 자리가 «둘»이다 — `runChatTurnStreaming` ⊕ `runChatTurnObserver`.
 *  그런데 툴 결과를 블록에 싣는 것은 **저쪽뿐**이었고, ***PWA 채팅이 실제로 쓰는 것은 이쪽***이다.
 *  ⇒ 위젯은 규범대로 악수를 걸고(`ui/initialize`), 브리지는 응답까지 했는데, **밀 것이 없었다.**
 *
 *  🔎 그것을 말해 준 것은 추론이 아니라 «관측»이다(같은 PR 이 심었다):
 *  ```
 *  mcp-app.bridge.attach {"hasTool":true,"hasToolResult":false,"skipped":"no-tool-result"}
 *  ```
 *  ⛔ 이 저장소가 이름 붙인 「배선」 형태의 재판이다 — 「기능이 없다」가 아니라 «있는데 이 경로가 안 쓴다».
 *  그래서 그 경로를 여기서 «직접» 문다. */
describe('observer must carry the tool result into the widget block — the widget has nothing to draw without it', () => {
  it('puts toolResult on the mcp_app block so the bridge has something to publish', async () => {
    const rawOutput = {
      content: [{ type: 'text', text: 'generation ready' }],
      _meta: { ui: { resourceUri: 'ui://server/screen.html' } },
    };
    globalThis.fetch = mockObserverResponse([
      `event: turn-begin\ndata: {"sessionId":"sess-widget"}\n\n`,
      `event: tool-call\ndata: {"id":"w1","name":"show","args":{}}\n\n`,
      // ⛔ 전선의 이름은 `result` 다 — 핸들러 인자 이름(`rawOutput`)과 «다르다».
      //   1차판이 `rawOutput` 으로 보냈고 블록이 아예 안 생겨서 시험이 먼저 깨졌다.
      `event: tool-result\ndata: ${JSON.stringify({ id: 'w1', name: 'show', ok: true, summary: 'ok', result: rawOutput })}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-widget","text":"done","stopReason":"end_turn"}\n\n`,
    ]);
    let finalMsg: ChatMessage | null = null;
    const dispose = runChatTurnObserver(makeClient(), 'sess-widget', {
      onPlaceholder: () => 'p-w',
      onPartialBlocks: () => {},
      onFinalize: (_pid, msg) => { finalMsg = msg; },
    });
    await new Promise((r) => setTimeout(r, 30));
    dispose();

    const blocks = (finalMsg as unknown as ChatMessage | null)?.blocks ?? [];
    const widget = blocks.find((b) => b.kind === 'mcp_app') as Extract<ChatBlock, { kind: 'mcp_app' }> | undefined;
    expect(widget).toBeDefined();
    expect(widget?.screenUrl).toBe('ui://server/screen.html');
    // ⛔ 이 단언이 깨지면 「시험이 까다롭다」가 아니라 ***「위젯이 빈 화면으로 뜬다」***로 읽는다.
    //   브리지는 `toolResult` 가 있어야만 publish 한다(`attachMcpAppFrame`).
    expect(widget?.toolResult).toEqual(rawOutput);
  });
});
