/** PWA chat runtime — local meta dispatch and ACP/SSE turn contracts. */

import { afterEach, beforeEach, describe, expect, it, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AcpConnection, AcpFrame, AcpFrameHandler } from './daemon-client';
import { DaemonClient } from './daemon-client';
import { parseElanousFeedbackEnvelope } from './elanous-feedback-envelope';
import { FEEDBACK_KINDS } from './feedback-envelope';
import * as feedbackBlockAccumulator from './feedback-block-accumulator';
import {
  dispatchMeta,
  META_COMMANDS,
  META_HANDLERS,
  isMetaCommand,
  newMetaMessage,
  newUserMessage,
  parseMcpAppPayload,
  runAcpForeignTurnObserver,
  runChatTurnAcp,
  type ChatBlock,
  type ChatMessage,
  type ChatRuntimeContext,
} from './chat-runtime';

interface FetchCall {
  url: string | URL;
  init?: RequestInit;
}

interface FeedbackEnvelopeVector {
  name: string;
  wire: string;
  expect: { accepted: boolean; result?: unknown };
}

interface FeedbackEnvelopeVectors {
  kinds: string[];
  vectors: FeedbackEnvelopeVector[];
}

const feedbackEnvelopeVectorsPath = join(import.meta.dir, '..', '..', '..', '..', 'elanous-feedback-envelope-vectors.json');
const canonicalFeedbackEnvelopeVectorsPath = realpathSync(
  join(import.meta.dir, '..', '..', '..', '..', 'elanous-feedback-envelope-vectors.json'),
);
const feedbackEnvelopeVectors = JSON.parse(
  readFileSync(feedbackEnvelopeVectorsPath, 'utf8'),
) as FeedbackEnvelopeVectors;

function assertCanonicalFeedbackEnvelopeVectorsPath(path: string): void {
  expect(realpathSync(path)).toBe(canonicalFeedbackEnvelopeVectorsPath);
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function mockResponse(opts: { status: number; body: unknown }): typeof fetch {
  return ((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input as string | URL, init });
    return {
      ok: opts.status >= 200 && opts.status < 300,
      status: opts.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => opts.body,
      text: async () => JSON.stringify(opts.body),
    } as unknown as Response;
  }) as unknown) as typeof fetch;
}

function makeCtx(sessionId = 'session-1', provider = 'anthropic'): ChatRuntimeContext {
  const client = new DaemonClient({
    baseUrl: 'http://localhost:31415',
    token: 'tok',
    provider,
  });
  return {
    client,
    sessionId,
    provider,
    setSessionId: () => {},
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// ── Phase B-2 (PWA chat streaming · 2026-05-06) ────────────────────
//
// `runChatTurnStreaming` block accumulator: text deltas grow the
// single text block at index 0 in place; image-blocks append in
// arrival order; finalized ChatMessage exposes `.blocks` only when
// at least one image arrived (text-only turns keep legacy `.text`).

import { runChatTurnStreaming } from './chat-runtime';

function mockSseResponseChunks(chunks: string[]): typeof fetch {
  return ((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input as string | URL, init });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
      text: async () => chunks.join(''),
    } as unknown as Response;
  }) as unknown) as typeof fetch;
}

describe('parseMcpAppPayload', () => {
  const validResource = {
    content: [{
      type: 'resource',
      resource: {
        uri: 'ui://canvas',
        mimeType: 'text/html',
        text: '<main>Canvas</main>',
        _meta: {
          ui: {
            csp: {
              connectDomains: ['https://api.example.test', 42],
              resourceDomains: ['https://cdn.example.test', 42],
            },
          },
        },
      },
    }],
  };

  it('accepts HTML only for the known app result and preserves string origin metadata', () => {
    expect(parseMcpAppPayload(validResource, 'ui://canvas')).toEqual({
      html: '<main>Canvas</main>',
      connectDomains: ['https://api.example.test'],
      resourceDomains: ['https://cdn.example.test'],
    });
  });

  it('finds the matching HTML resource after unrelated resource content', () => {
    expect(parseMcpAppPayload({
      content: [
        { type: 'resource', resource: { uri: 'ui://other', mimeType: 'text/html', text: '<main>Other</main>' } },
        ...validResource.content,
      ],
    }, 'ui://canvas')).toEqual({
      html: '<main>Canvas</main>',
      connectDomains: ['https://api.example.test'],
      resourceDomains: ['https://cdn.example.test'],
    });
  });

  it.each([
    [undefined, 'ui://canvas'],
    [{ content: [] }, 'ui://canvas'],
    [{ content: [{ type: 'resource', resource: { ...validResource.content[0].resource, uri: 'ui://other' } }] }, 'ui://canvas'],
    [{ content: [{ type: 'resource', resource: { ...validResource.content[0].resource, mimeType: 'text/plain' } }] }, 'ui://canvas'],
    [{ content: [{ type: 'resource', resource: { uri: 'ui://canvas', mimeType: 'text/html' } }] }, 'ui://canvas'],
  ])('ignores malformed or unrelated app resource payload %#', (rawOutput, screenUrl) => {
    expect(parseMcpAppPayload(rawOutput, screenUrl)).toBeUndefined();
  });
});

describe('runChatTurnStreaming — block accumulator (Phase B-2)', () => {
  it('text-only turn returns ChatMessage without `.blocks` (legacy text path preserved)', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-A"}\n\n`,
      `event: text-delta\ndata: {"delta":"hi","full":"hi"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-A","text":"hi","stopReason":"end_turn"}\n\n`,
    ]);
    const result = await runChatTurnStreaming('hello', makeCtx('sess-A'));
    expect(result.message.text).toBe('hi');
    expect(result.message.blocks).toBeUndefined();
  });

  it('attaches `.blocks` with text + image entries when image-block events arrive', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-B"}\n\n`,
      `event: text-delta\ndata: {"delta":"see","full":"see"}\n\n`,
      `event: image-block\ndata: {"src":"data:image/png;base64,XYZ","mediaType":"image/png","alt":"shot"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-B","text":"see this","stopReason":"end_turn"}\n\n`,
    ]);
    const result = await runChatTurnStreaming('shot please', makeCtx('sess-B'));
    expect(result.message.blocks).toBeDefined();
    expect(result.message.blocks).toHaveLength(2);
    expect(result.message.blocks![0]).toEqual({ kind: 'text', text: 'see this' });
    expect(result.message.blocks![1]).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,XYZ',
      mediaType: 'image/png',
      alt: 'shot',
    });
    // Final text block is reconciled to res.text (server canonical),
    // not the last delta — protects against missed-tail deltas.
    expect(result.message.text).toBe('see this');
  });

  it('streams onPartial + onPartialBlocks during the turn (mid-stream UX hooks)', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-C"}\n\n`,
      `event: text-delta\ndata: {"delta":"He","full":"He"}\n\n`,
      `event: image-block\ndata: {"src":"data:image/png;base64,A","mediaType":"image/png"}\n\n`,
      `event: text-delta\ndata: {"delta":"llo","full":"Hello"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-C","text":"Hello","stopReason":"end_turn"}\n\n`,
    ]);
    const partials: string[] = [];
    const blockSnapshots: number[] = [];
    await runChatTurnStreaming('hi', makeCtx('sess-C'), {
      onPartial: (full) => partials.push(full),
      onPartialBlocks: (blocks) => blockSnapshots.push(blocks.length),
    });
    expect(partials).toEqual(['He', 'Hello']);
    // Three onPartialBlocks calls: text(He) → +image → text(Hello).
    // Block list snapshot length: 1 → 2 → 2.
    expect(blockSnapshots).toEqual([1, 2, 2]);
  });

  // ── Phase B-3 — tool_use block lifecycle ─────────────────────────

  it('B-3: pushes a running tool_use block on tool-call event', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-tc"}\n\n`,
      `event: tool-call\ndata: {"id":"c1","name":"WebTerminalScreenshot","args":{"terminalId":"t-1"}}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-tc","text":"","stopReason":"end_turn"}\n\n`,
    ]);
    const result = await runChatTurnStreaming('cap', makeCtx('sess-tc'));
    expect(result.message.blocks).toBeDefined();
    expect(result.message.blocks).toHaveLength(1);
    const tool = result.message.blocks![0]!;
    expect(tool.kind).toBe('tool_use');
    expect((tool as { id: string }).id).toBe('c1');
    expect((tool as { status: string }).status).toBe('running');
    expect((tool as { startedAt?: number }).startedAt).toEqual(expect.any(Number));
    expect((tool as { endedAt?: number }).endedAt).toBeUndefined();
  });

  it('B-3: flips matching tool_use block to done on tool-result event (same id)', async () => {
    const now = spyOn(Date, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200);
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-tr"}\n\n`,
      `event: tool-call\ndata: {"id":"c1","name":"Read","args":{"path":"/tmp/x"}}\n\n`,
      `event: tool-result\ndata: {"id":"c1","name":"Read","ok":true,"summary":"3 lines"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-tr","text":"done","stopReason":"end_turn"}\n\n`,
    ]);
    const result = await runChatTurnStreaming('read', makeCtx('sess-tr'));
    expect(result.message.blocks).toBeDefined();
    // text block + tool block (text gets reconciled to res.text 'done').
    const tool = result.message.blocks!.find((b) => b.kind === 'tool_use');
    expect(tool).toBeDefined();
    expect((tool as { status: string }).status).toBe('done');
    expect((tool as { summary?: string }).summary).toBe('3 lines');
    expect((tool as { startedAt?: number }).startedAt).toBe(100);
    expect((tool as { endedAt?: number }).endedAt).toBe(200);
    now.mockRestore();
  });

  it('B-3: flips status to error when tool-result.ok is false', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-err"}\n\n`,
      `event: tool-call\ndata: {"id":"c1","name":"Grep","args":{"q":"x"}}\n\n`,
      `event: tool-result\ndata: {"id":"c1","name":"Grep","ok":false}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-err","text":"","stopReason":"end_turn"}\n\n`,
    ]);
    const result = await runChatTurnStreaming('grep', makeCtx('sess-err'));
    const tool = result.message.blocks!.find((b) => b.kind === 'tool_use');
    expect((tool as { status: string }).status).toBe('error');
  });

  it('B-3: synthesizes a done pill when tool-result arrives without a matching tool-call (defensive)', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-orphan"}\n\n`,
      // Server fired result before call (rare wire ordering). PWA
      // must still render a done pill so the user sees the tool ran.
      `event: tool-result\ndata: {"id":"orphan","name":"Mystery","ok":true,"summary":"42 things"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-orphan","text":"","stopReason":"end_turn"}\n\n`,
    ]);
    const result = await runChatTurnStreaming('x', makeCtx('sess-orphan'));
    const tool = result.message.blocks!.find((b) => b.kind === 'tool_use');
    expect(tool).toBeDefined();
    expect((tool as { id: string }).id).toBe('orphan');
    expect((tool as { status: string }).status).toBe('done');
  });

  it('creates an mcp_app block after the preserved tool pill when a result includes a screen URL', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-mcp"}\n\n`,
      `event: tool-call\ndata: {"id":"c1","name":"Canvas","args":{}}\n\n`,
      `event: tool-result\ndata: {"id":"c1","name":"Canvas","ok":true,"summary":"Open in a compatible client","result":{"_meta":{"ui":{"resourceUri":"ui://canvas"}},"content":[{"type":"resource","resource":{"uri":"ui://canvas","mimeType":"text/html","text":"<main>Canvas</main>","_meta":{"ui":{"csp":{"connectDomains":["https://api.example.test","bad value"],"resourceDomains":["https://cdn.example.test","bad value"]}}}}}]}}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-mcp","text":"","stopReason":"end_turn"}\n\n`,
    ]);

    const result = await runChatTurnStreaming('show canvas', makeCtx('sess-mcp'));
    const app = result.message.blocks!.find((block) => block.kind === 'mcp_app') as Extract<ChatBlock, { kind: 'mcp_app' }>;
    // ⭐ 원 결과는 «따로» 문다 — 규범상 호스트가 위젯에 초기 상태로 밀어야 하는 값이고,
    //   이 자리에 없으면 밀 것이 없다(2026-08-21 실측: 그래서 위젯이 영영 갱신되지 않았다).
    //   ⛔ 그 큰 덩어리를 여기 «베껴» 적으면 이 시험은 결과 «모양»을 계약으로 잠근다 — 그건 이 시험의 일이 아니다.
    expect(app.toolResult).toMatchObject({ _meta: { ui: { resourceUri: 'ui://canvas' } } });
    const { toolResult: _carried, ...rendered } = app;
    expect(result.message.blocks![0]).toMatchObject({
      kind: 'tool_use', id: 'c1', name: 'Canvas', status: 'done', args: {}, summary: 'Open in a compatible client', startedAt: expect.any(Number), endedAt: expect.any(Number),
    });
    expect(rendered).toEqual({
      kind: 'mcp_app',
      toolId: 'c1',
      toolName: 'Canvas',
      screenUrl: 'ui://canvas',
      html: '<main>Canvas</main>',
      connectDomains: ['https://api.example.test', 'bad value'],
      resourceDomains: ['https://cdn.example.test', 'bad value'],
      fallbackText: 'Open in a compatible client',
    });
    expect(result.message.blocks).toHaveLength(2);
  });

  it('does not create an mcp_app block when a tool result has no screen URL', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-no-mcp"}\n\n`,
      `event: tool-call\ndata: {"id":"c1","name":"Read","args":{}}\n\n`,
      `event: tool-result\ndata: {"id":"c1","name":"Read","ok":true,"summary":"3 lines"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-no-mcp","text":"","stopReason":"end_turn"}\n\n`,
    ]);

    const result = await runChatTurnStreaming('read', makeCtx('sess-no-mcp'));
    expect(result.message.blocks).toHaveLength(1);
    expect(result.message.blocks![0]).toMatchObject({
      kind: 'tool_use', id: 'c1', name: 'Read', status: 'done', args: {}, summary: '3 lines', startedAt: expect.any(Number), endedAt: expect.any(Number),
    });
  });

  it.each(['', null])('does not create an mcp_app block for an invalid screen URL: %p', async (resourceUri) => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-invalid-mcp"}\n\n`,
      `event: tool-call\ndata: {"id":"c1","name":"Canvas","args":{}}\n\n`,
      `event: tool-result\ndata: ${JSON.stringify({
        id: 'c1',
        name: 'Canvas',
        ok: true,
        // ⛔ 발신 이름은 `result` 다 — `rawOutput` 으로 쓰면 파싱 자체가 안 돼
        //    「잘못된 URI 라 블록이 없다」가 아니라 «아무것도 안 읽어서» 통과하는 헛시험이 된다.
        result: { _meta: { ui: { resourceUri } } },
      })}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-invalid-mcp","text":"","stopReason":"end_turn"}\n\n`,
    ]);

    const result = await runChatTurnStreaming('show canvas', makeCtx('sess-invalid-mcp'));
    expect(result.message.blocks).toHaveLength(1);
    expect(result.message.blocks![0]).toMatchObject({
      kind: 'tool_use', id: 'c1', name: 'Canvas', status: 'done', args: {}, startedAt: expect.any(Number), endedAt: expect.any(Number),
    });
  });

  it('B-3: tool_use blocks alone (no image) attach .blocks to ChatMessage', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-tool-only"}\n\n`,
      `event: tool-call\ndata: {"id":"c1","name":"List","args":{}}\n\n`,
      `event: tool-result\ndata: {"id":"c1","name":"List","ok":true,"summary":"5 entries"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-tool-only","text":"hi","stopReason":"end_turn"}\n\n`,
    ]);
    const result = await runChatTurnStreaming('list', makeCtx('sess-tool-only'));
    expect(result.message.blocks).toBeDefined();
    expect(result.message.blocks!.some((b) => b.kind === 'tool_use')).toBe(true);
  });

  it('B-3: forwards handlers.signal so AbortController on caller fires fetch abort', async () => {
    // Mock fetch to reject if signal is aborted before fetch completes.
    globalThis.fetch = ((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: input as string | URL, init });
      if (init?.signal?.aborted) throw new Error('aborted');
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: turn-end\ndata: {"sessionId":"sess-ab","text":"x","stopReason":"end_turn"}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown) as typeof fetch;
    const ac = new AbortController();
    ac.abort();
    await expect(
      runChatTurnStreaming('x', makeCtx('sess-ab'), { signal: ac.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it('emits image alt only when supplied (omitting it produces a plain image block)', async () => {
    globalThis.fetch = mockSseResponseChunks([
      `event: turn-begin\ndata: {"sessionId":"sess-D"}\n\n`,
      `event: image-block\ndata: {"src":"data:image/png;base64,Z","mediaType":"image/png"}\n\n`,
      `event: turn-end\ndata: {"sessionId":"sess-D","text":"","stopReason":"end_turn"}\n\n`,
    ]);
    const result = await runChatTurnStreaming('img', makeCtx('sess-D'));
    expect(result.message.blocks).toBeDefined();
    const imgBlock = result.message.blocks!.find((b) => b.kind === 'image');
    expect(imgBlock).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,Z',
      mediaType: 'image/png',
    });
  });
});

// ── CV-1 (PLAN v1.2 §5 · 2026-05-07) ──────────────────────────────
//
// `runAcpForeignTurnObserver` mirrors cross-surface ACP `session/update`
// notifications into the chat history. Tests cover: text accumulation,
// dedupe gates (local POST + remote SSE), session filter, idle timer
// finalize + fresh placeholder for next turn, tool_call lifecycle.

function makeMockAcp(): { acp: AcpConnection; emit: (frame: AcpFrame) => void } {
  const handlers = new Set<AcpFrameHandler>();
  const acp: AcpConnection = {
    send: async () => null,
    on: (kind, cb) => {
      if (kind === 'sessionUpdate') {
        handlers.add(cb);
        return () => { handlers.delete(cb); };
      }
      return () => {};
    },
    onAny: () => () => {},
    // 🩸 `AcpConnection` 이 `#11378`(13일 전)에서 셋을 더했는데 이 목이 «안 따라갔다» — 🅕 46차가 tsc 게이트에서 잡았다.
    //    ⛔ 그 뒤로 ***이 파일을 안 건드리는 변경도*** 저장소 범위 tsc 에서 막혔다.
    onRequest: () => () => {},
    onState: () => () => {},
    state: 'OPEN',
    close: () => {},
    readyState: 1,
    ready: Promise.resolve(''),
  };
  return {
    acp,
    emit: (frame) => handlers.forEach((h) => h(frame)),
  };
}

// ── CV-1b (PLAN v1.2 §5 · 2026-05-07) ──────────────────────────────
//
// `runChatTurnAcp` — chat self-turn ACP path (replaces SSE
// `/v1/prompt/stream` for chat's own POST). Tests cover: RPC
// dispatch, chunks → text accumulation, tool lifecycle, abort wire
// (session/cancel notification), userContent multipart, stopReason
// surfacing.

interface MockAcpHandle {
  acp: AcpConnection;
  emit: (frame: AcpFrame) => void;
  sentRpcs: { method: string; params: unknown }[];
  /** Pre-program a response for the next `send(method)` invocation. The
   *  emitter fires `chunks` on `sessionUpdate` synchronously between the
   *  send-time and the resolve-time so the listener accumulates state
   *  before the RPC promise settles. */
  programNext: (
    method: string,
    chunks: AcpFrame[],
    response: unknown,
  ) => void;
}

function makeProgrammableAcp(): MockAcpHandle {
  const handlers = new Set<AcpFrameHandler>();
  const programmed: { method: string; chunks: AcpFrame[]; response: unknown }[] = [];
  const sentRpcs: { method: string; params: unknown }[] = [];
  const acp: AcpConnection = {
    send: async (method, params) => {
      sentRpcs.push({ method, params });
      const idx = programmed.findIndex((p) => p.method === method);
      if (idx === -1) return null;
      const [{ chunks, response }] = programmed.splice(idx, 1);
      // Fire chunks before the RPC resolves so the listener accumulates
      // state in the same micro-task boundary the daemon would.
      for (const f of chunks) handlers.forEach((h) => h(f));
      return response;
    },
    on: (kind, cb) => {
      if (kind === 'sessionUpdate') {
        handlers.add(cb);
        return () => { handlers.delete(cb); };
      }
      return () => {};
    },
    onAny: () => () => {},
    // 🩸 `AcpConnection` 이 `#11378`(13일 전)에서 셋을 더했는데 이 목이 «안 따라갔다» — 🅕 46차가 tsc 게이트에서 잡았다.
    //    ⛔ 그 뒤로 ***이 파일을 안 건드리는 변경도*** 저장소 범위 tsc 에서 막혔다.
    onRequest: () => () => {},
    onState: () => () => {},
    state: 'OPEN',
    close: () => {},
    readyState: 1,
    ready: Promise.resolve(''),
  };
  return {
    acp,
    emit: (frame) => handlers.forEach((h) => h(frame)),
    sentRpcs,
    programNext: (method, chunks, response) => {
      programmed.push({ method, chunks, response });
    },
  };
}

function makeAcpCtx(sessionId = 'sess-acp', provider = 'anthropic'): ChatRuntimeContext {
  const client = new DaemonClient({
    baseUrl: 'http://localhost:31415',
    token: 'tok',
    provider,
  });
  return {
    client,
    sessionId,
    provider,
    setSessionId: () => {},
  };
}

function chunkUpdate(sessionId: string, update: Record<string, unknown>): AcpFrame {
  return {
    kind: 'sessionUpdate',
    method: 'session/update',
    params: { sessionId, update },
  };
}

describe('runChatTurnAcp — CV-1b chat self-turn ACP path', () => {
  it('dispatches session/prompt with sessionId + text prompt block, accumulates text deltas via onPartial', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext(
      'session/prompt',
      [
        chunkUpdate('sess-A', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello ' },
        }),
        chunkUpdate('sess-A', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        }),
      ],
      { stopReason: 'end_turn' },
    );
    const partials: string[] = [];
    const result = await runChatTurnAcp(handle.acp, 'hello', makeAcpCtx('sess-A'), {
      onPartial: (full) => partials.push(full),
    });
    expect(handle.sentRpcs).toHaveLength(1);
    expect(handle.sentRpcs[0]).toEqual({
      method: 'session/prompt',
      params: { sessionId: 'sess-A', prompt: [{ type: 'text', text: 'hello' }] },
    });
    expect(partials).toEqual(['Hello ', 'Hello world']);
    expect(result.message.text).toBe('Hello world');
    expect(result.message.meta?.stopReason).toBe('end_turn');
    expect(result.message.role).toBe('assistant');
    expect(result.message.blocks).toBeUndefined();
  });

  it('attaches .blocks when image / tool_use chunks arrive', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext(
      'session/prompt',
      [
        chunkUpdate('sess-B', {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Read',
          rawInput: { path: '/x' },
        }),
        chunkUpdate('sess-B', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'see' },
        }),
        chunkUpdate('sess-B', {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          title: '3 lines',
        }),
      ],
      { stopReason: 'end_turn' },
    );
    const result = await runChatTurnAcp(handle.acp, 'read', makeAcpCtx('sess-B'));
    expect(result.message.blocks).toBeDefined();
    const tool = result.message.blocks!.find((b) => b.kind === 'tool_use');
    expect(tool).toMatchObject({ id: 'tc-1', status: 'done', summary: '3 lines' });
    expect((tool as { startedAt?: number }).startedAt).toEqual(expect.any(Number));
    expect((tool as { endedAt?: number }).endedAt).toEqual(expect.any(Number));
    expect((tool as { endedAt: number }).endedAt).toBeGreaterThanOrEqual(
      (tool as { startedAt: number }).startedAt,
    );
    expect(result.message.text).toBe('see');
  });

  /** ⛔⭐⭐⭐ 📏 2026-08-22 라이브(16차 `[F]`): ***위젯이 「뜨긴 하고 비어 있었다».***
   *
   *  `kind: 'mcp_app'` 블록을 만드는 자리가 **셋**인데(streaming · observer · ACP)
   *  결과를 싣는 곳은 **둘**이었다. 그리고 ***`ChatLayout` 은 데몬이 있으면 ACP 경로를 탄다*** —
   *  즉 빠진 그 하나가 «실제로 도는 길»이었다. 기존 mcp_app 시험은 streaming 경로만 물어서
   *  그 결손이 초록으로 통과했다.
   *
   *  🔎 추론이 아니라 «관측»이 이 자리를 가리켰다(같은 PR 이 심었다):
   *  ```
   *  mcp-app.bridge.attach {"hasTool":true,"hasToolResult":false,"skipped":"no-tool-result"}
   *  ```
   *  📏 수리 뒤 같은 자로 다시 재자 `"hasToolResult":true,"published":true` 로 뒤집혔고,
   *  실물 위젯이 «Connecting…» 에서 벗어나 응답을 그렸다. */
  it('carries the tool result onto the ACP mcp_app block — the widget has nothing to draw without it', async () => {
    const rawOutput = {
      _meta: { ui: { resourceUri: 'ui://acp/screen.html' } },
      content: [{ type: 'text', text: 'generation ready' }],
    };
    const handle = makeProgrammableAcp();
    handle.programNext(
      'session/prompt',
      [
        chunkUpdate('sess-W', {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-w',
          status: 'completed',
          title: 'show',
          rawOutput,
        }),
      ],
      { stopReason: 'end_turn' },
    );
    const result = await runChatTurnAcp(handle.acp, 'show', makeAcpCtx('sess-W'));
    const app = result.message.blocks!.find((b) => b.kind === 'mcp_app') as Extract<ChatBlock, { kind: 'mcp_app' }> | undefined;
    expect(app).toBeDefined();
    expect(app!.screenUrl).toBe('ui://acp/screen.html');
    // ⛔ 이 단언이 깨지면 「시험이 까다롭다」가 아니라 ***「위젯이 빈 화면으로 뜬다」***로 읽는다.
    //   브리지는 `toolResult` 가 있어야만 publish 한다(`attachMcpAppFrame`).
    expect(app!.toolResult).toEqual(rawOutput);
  });

  it('aborts via session/cancel notification when handlers.signal fires', async () => {
    const handle = makeProgrammableAcp();
    // Program no chunks — the RPC will resolve promptly with cancelled.
    handle.programNext('session/prompt', [], { stopReason: 'cancelled' });
    const ac = new AbortController();
    const promise = runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-C'), {
      signal: ac.signal,
    });
    ac.abort();
    await promise;
    const cancelCall = handle.sentRpcs.find((r) => r.method === 'session/cancel');
    expect(cancelCall).toBeDefined();
    expect(cancelCall!.params).toEqual({ sessionId: 'sess-C' });
  });

  it('throws synchronously when signal is already aborted before send', async () => {
    const handle = makeProgrammableAcp();
    const ac = new AbortController();
    ac.abort();
    await expect(
      runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-D'), { signal: ac.signal }),
    ).rejects.toThrow(/aborted/);
    // The pre-abort check returns before any RPC is sent.
    expect(handle.sentRpcs).toHaveLength(0);
  });

  it('uses handlers.userContent multipart when supplied (image + text)', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [], { stopReason: 'end_turn' });
    const userContent = [
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'BASE64', mimeType: 'image/png' },
    ];
    await runChatTurnAcp(handle.acp, 'caption', makeAcpCtx('sess-E'), {
      userContent,
    });
    expect(handle.sentRpcs[0]!.params).toEqual({
      sessionId: 'sess-E',
      prompt: userContent,
    });
  });

  it('throws when ctx.sessionId is empty (handshake guard)', async () => {
    const handle = makeProgrammableAcp();
    await expect(
      runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('')),
    ).rejects.toThrow(/sessionId required/);
  });

  it('forwards stopReason from RPC response into ChatMessage.meta', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [], { stopReason: 'max_tokens' });
    const result = await runChatTurnAcp(handle.acp, 'long', makeAcpCtx('sess-F'));
    expect(result.message.meta?.stopReason).toBe('max_tokens');
  });

  it('disposes the listener after the RPC settles (no leak on subsequent foreign chunks)', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext(
      'session/prompt',
      [
        chunkUpdate('sess-G', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'A' },
        }),
      ],
      { stopReason: 'end_turn' },
    );
    const partials: string[] = [];
    await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-G'), {
      onPartial: (full) => partials.push(full),
    });
    expect(partials).toEqual(['A']);
    // Post-RPC chunks must NOT call the disposed listener.
    handle.emit(
      chunkUpdate('sess-G', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'leaked' },
      }),
    );
    expect(partials).toEqual(['A']);
  });
});

describe('runAcpForeignTurnObserver — CV-1 cross-surface mirror', () => {
  it('routes agent_message_chunk text deltas into a freshly allocated placeholder', () => {
    const { acp, emit } = makeMockAcp();
    const placeholders: string[] = [];
    let lastBlocks: ChatBlock[] = [];
    const dispose = runAcpForeignTurnObserver(acp, 'sess-A', {
      onPlaceholder: ({ sessionId }) => {
        const id = `ph-${sessionId}`;
        placeholders.push(id);
        return id;
      },
      onPartialBlocks: (_id, blocks) => { lastBlocks = blocks; },
    });
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-A',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello ' },
        },
      },
    });
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-A',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        },
      },
    });
    expect(placeholders).toEqual(['ph-sess-A']);
    expect(lastBlocks).toEqual([{ kind: 'text', text: 'Hello world' }]);
    dispose();
  });

  it('drops events when isLocalTurnInFlight returns true (Q1=A1 self-POST dedupe)', () => {
    const { acp, emit } = makeMockAcp();
    let placeholderCalls = 0;
    const dispose = runAcpForeignTurnObserver(acp, 'sess-B', {
      isLocalTurnInFlight: () => true,
      onPlaceholder: () => { placeholderCalls += 1; return 'x'; },
      onPartialBlocks: () => {},
    });
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-B',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'self chunk' },
        },
      },
    });
    expect(placeholderCalls).toBe(0);
    dispose();
  });

  it('drops events when isRemoteSseTurnInFlight returns true (cross-tab SSE dedupe)', () => {
    const { acp, emit } = makeMockAcp();
    let placeholderCalls = 0;
    const dispose = runAcpForeignTurnObserver(acp, 'sess-C', {
      isRemoteSseTurnInFlight: () => true,
      onPlaceholder: () => { placeholderCalls += 1; return 'x'; },
      onPartialBlocks: () => {},
    });
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-C',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'sse-mirrored chunk' },
        },
      },
    });
    expect(placeholderCalls).toBe(0);
    dispose();
  });

  it('ignores events whose sessionId does not match the bound session', () => {
    const { acp, emit } = makeMockAcp();
    let placeholderCalls = 0;
    const dispose = runAcpForeignTurnObserver(acp, 'sess-D', {
      onPlaceholder: () => { placeholderCalls += 1; return 'x'; },
      onPartialBlocks: () => {},
    });
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'OTHER-SESSION',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'wrong session' },
        },
      },
    });
    expect(placeholderCalls).toBe(0);
    dispose();
  });

  it('finalizes via idle timer and allocates a fresh placeholder for the next foreign turn', async () => {
    const { acp, emit } = makeMockAcp();
    const placeholders: string[] = [];
    const finalizes: string[] = [];
    let counter = 0;
    const dispose = runAcpForeignTurnObserver(acp, 'sess-E', {
      idleFinalizeMs: 30,
      onPlaceholder: () => {
        const id = `ph-${counter}`;
        counter += 1;
        placeholders.push(id);
        return id;
      },
      onPartialBlocks: () => {},
      onFinalize: (id) => { finalizes.push(id); },
    });
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-E',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'turn 1' },
        },
      },
    });
    expect(placeholders).toEqual(['ph-0']);
    await new Promise((r) => setTimeout(r, 70));
    expect(finalizes).toEqual(['ph-0']);
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-E',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'turn 2' },
        },
      },
    });
    expect(placeholders).toEqual(['ph-0', 'ph-1']);
    dispose();
  });

  it('routes tool_call → tool_call_update lifecycle into a tool_use block', () => {
    const { acp, emit } = makeMockAcp();
    let lastBlocks: ChatBlock[] = [];
    const dispose = runAcpForeignTurnObserver(acp, 'sess-F', {
      onPlaceholder: () => 'p1',
      onPartialBlocks: (_id, blocks) => { lastBlocks = blocks; },
    });
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-F',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Read',
          rawInput: { path: '/x' },
        },
      },
    });
    expect(lastBlocks).toHaveLength(1);
    expect(lastBlocks[0]).toMatchObject({
      kind: 'tool_use',
      id: 'tc-1',
      status: 'running',
      startedAt: expect.any(Number),
    });
    const startedAt = (lastBlocks[0] as Extract<ChatBlock, { kind: 'tool_use' }>).startedAt;
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-F',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          title: '3 lines',
        },
      },
    });
    expect(lastBlocks[0]).toMatchObject({
      kind: 'tool_use',
      id: 'tc-1',
      status: 'done',
      summary: '3 lines',
      startedAt,
      endedAt: expect.any(Number),
    });
    dispose();
  });

  it('disposer clears the idle timer (no spurious finalize after unmount)', async () => {
    const { acp, emit } = makeMockAcp();
    const finalizes: string[] = [];
    const dispose = runAcpForeignTurnObserver(acp, 'sess-G', {
      idleFinalizeMs: 30,
      onPlaceholder: () => 'ph-G',
      onPartialBlocks: () => {},
      onFinalize: (id) => { finalizes.push(id); },
    });
    emit({
      kind: 'sessionUpdate',
      params: {
        sessionId: 'sess-G',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'in-flight' },
        },
      },
    });
    dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(finalizes).toEqual([]);
  });
});

describe(':budget · :history · :help', () => {
  const budgetBody = {
    status: 'ok',
    percent: null,
    notifyAtPct: 80,
    monthSoFarUsd: 0,
    monthYYYYMM: '2026-09',
  };

  function ctxWith(
    extra: Partial<ChatRuntimeContext> = {},
  ): ChatRuntimeContext {
    return { ...makeCtx(), ...extra };
  }

  it(':budget prints the fake status as one line', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: budgetBody });
    const result = await dispatchMeta(':budget', ctxWith({
      daemon: { baseUrl: 'http://localhost:31415', token: 'tok' },
    }));
    expect(result?.text).toBe('budget 2026-09: $0.00 · 알림 80%');
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/budget/status');
    expect(result?.text).not.toContain('TODO');
  });

  it(':budget says the status could not be read when fetch returns null', async () => {
    globalThis.fetch = mockResponse({ status: 503, body: { error: 'down' } });
    const result = await dispatchMeta(':budget', ctxWith({
      daemon: { baseUrl: 'http://localhost:31415' },
    }));
    expect(result?.text).toBe('예산 상태를 읽지 못했습니다');
  });

  it(':budget says the status could not be read when daemon settings are absent', async () => {
    const result = await dispatchMeta(':budget', ctxWith());
    expect(result?.text).toBe('예산 상태를 읽지 못했습니다');
    expect(calls).toHaveLength(0);
  });

  it(':history summarizes the local buffer as role: first 80 chars and does not call the server', async () => {
    const long = '가'.repeat(90);
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', text: long, timestamp: 1 },
      { id: 'a1', role: 'assistant', text: '짧은 답', timestamp: 2 },
    ];
    const result = await dispatchMeta(':history', ctxWith({ messages }));
    expect(result?.text).toBe(`user: ${'가'.repeat(80)}\nassistant: 짧은 답`);
    expect(calls).toHaveLength(0);
  });

  it(':history on an empty buffer says there is no conversation yet', async () => {
    const result = await dispatchMeta(':history', ctxWith({ messages: [] }));
    expect(result?.text).toBe('아직 대화가 없습니다');
  });

  it(':history defaults to the last 10 turns', async () => {
    const messages: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `turn-${i}`,
      timestamp: i,
    }));
    const result = await dispatchMeta(':history', ctxWith({ messages }));
    const lines = result?.text.split('\n') ?? [];
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('user: turn-2');
    expect(lines[9]).toBe('assistant: turn-11');
  });

  it(':help output contains no TODO and describes :budget and :history', async () => {
    const result = await dispatchMeta(':help', ctxWith());
    expect(result?.text).not.toContain('TODO');
    expect(result?.text).toContain(':budget');
    expect(result?.text).toContain(':history');
    expect(result?.text).toContain(':session');
    expect(result?.text).toContain(':fork');
    expect(result?.text).not.toContain(':provider');
    expect(result?.text).toContain(':clear');
    expect(result?.text).toContain('메타 명령(:이름 또는 /이름) (Meta commands)');
  });

  it(':session · :clear preserve local replies and :provider is unknown', async () => {
    const ctx = ctxWith();
    expect((await dispatchMeta(':session', ctx))?.text).toBe('session = session-1');
    expect((await dispatchMeta(':provider x', ctx))?.text).toBe('unknown meta command: :provider');
    expect((await dispatchMeta(':clear', ctx))?.text).toBe('__CLEAR__');
    const forked = await dispatchMeta(':fork', ctx);
    expect(forked?.newSessionId).toBeTruthy();
    expect(forked?.text).toContain('forked → new session');
  });

  it('dispatches /help locally and explains unsupported TUI commands without prompting', async () => {
    const ctx = ctxWith();
    expect((await dispatchMeta('/help', ctx))?.text).toContain(':help');
    expect((await dispatchMeta('/clear', ctx))?.text).toBe('__CLEAR__');
    expect((await dispatchMeta('/run-skill test', ctx))?.text).toBe('/run-skill 은 PWA 채팅에서 아직 안 됩니다 — 지금 되는 명령: /help /session /fork /budget /history /clear');
    expect(isMetaCommand('/help')).toBe(true);
    expect(isMetaCommand('/run-skill test')).toBe(true);
  });

  it('offers exactly the same names in the menu as the meta handlers', () => {
    expect(new Set(META_COMMANDS.map(({ name }) => name))).toEqual(
      new Set(Object.keys(META_HANDLERS).map((key) => key.slice(1))),
    );
  });
});

describe('chat-runtime helpers — meta detection + message factories', () => {
  it('isMetaCommand identifies leading colon', () => {
    expect(isMetaCommand(':help')).toBe(true);
    expect(isMetaCommand('hello')).toBe(false);
    expect(isMetaCommand('  :help')).toBe(true);
    expect(isMetaCommand('')).toBe(false);
  });

  it('newUserMessage / newMetaMessage assign role + non-empty id', () => {
    const u = newUserMessage('hi');
    const m = newMetaMessage('switched');
    expect(u.role).toBe('user');
    expect(u.text).toBe('hi');
    expect(u.id.length).toBeGreaterThan(0);
    expect(m.role).toBe('meta');
    expect(m.text).toBe('switched');
    expect(m.id.length).toBeGreaterThan(0);
  });
});

// 대표 2026-08-17 — "그럼 대화에도 터미널 id 가 배지로 남아야겠네요".
// 📏 그 전 실물: 탭을 바꾸면 Dock 부제만 바뀌고 «대화는 그대로 남아», 18:00:39 의 btop 문답이
//    실제로는 preview-1 과의 것인데 화면엔 self_8f9da868 과 나눈 것처럼 보였다.
describe('메시지가 «어느 터미널과의» 대화인지 스스로 말한다', () => {
  test('터미널 id 를 주면 메시지에 실린다', () => {
    expect(newUserMessage('date 실행', 'self_5837456a').terminalId).toBe('self_5837456a');
    expect(newMetaMessage('captured', 'self_5837456a').terminalId).toBe('self_5837456a');
  });

  test('안 주면 «칸 자체가 없다» — 터미널이 없는 서피스의 렌더는 그대로다', () => {
    const u = newUserMessage('안녕');
    const m = newMetaMessage('note');
    expect('terminalId' in u).toBe(false);
    expect('terminalId' in m).toBe(false);
  });
});

/** ⛔⭐⭐⭐ 「생각」 블록의 열림/닫힘 계약 — 대표 2026-08-22 결정으로 신설된 축.
 *
 *  📏 이 절은 ***사후 리뷰가 요구해서*** 생겼다(PR #11308). 그 배선은 `pr land` 의
 *  「작업 트리 담기」 기본 때문에 ***리뷰를 안 거치고 착지***했고, 뒤늦게 돌린 리뷰가
 *  ***실제 결함 둘***을 잡았다 — 이미지 본문이 생각을 안 닫는다 · 실패/중단에서 안 닫힌다.
 *  🔑 그래서 규칙을 «말»이 아니라 «실행»으로 못 박는다. */
describe('runChatTurnAcp — 에이전트의 「생각」 블록', () => {
  const thought = (text: string) => chunkUpdate('sess-T', {
    sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text },
  });
  const thinkingOf = (blocks: readonly { kind: string }[] | undefined) =>
    (blocks ?? []).find((b) => b.kind === 'agent_thinking') as
      | { kind: 'agent_thinking'; msg: string; done: boolean } | undefined;

  it('⭐ 여러 청크를 «한 블록»에 누적한다 — 쪼개지 않는다', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [thought('생각을 '), thought('잇는다')], { stopReason: 'end_turn' });
    const { message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-T'));
    const all = (message.blocks ?? []).filter((b) => b.kind === 'agent_thinking');
    expect(all).toHaveLength(1);
    expect(thinkingOf(message.blocks)?.msg).toBe('생각을 잇는다');
  });

  it('⛔ 어시스턴트 «본문»이 시작되면 닫힌다 — 텍스트', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [
      thought('먼저 생각'),
      chunkUpdate('sess-T', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '답' } }),
    ], { stopReason: 'end_turn' });
    const { message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-T'));
    expect(thinkingOf(message.blocks)?.done).toBe(true);
  });

  it('⛔⭐ 이미지 «본문»도 생각을 닫는다 — 무인 리뷰가 잡은 결함', async () => {
    // 🔑 「본문이 시작되면 닫는다」는 ***텍스트에만* 걸린 규칙이 아니다.**
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [
      thought('그림을 생각'),
      chunkUpdate('sess-T', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'https://cdn.example.com/a.png', mimeType: 'image/png' },
      }),
    ], { stopReason: 'end_turn' });
    const { message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-T'));
    expect((message.blocks ?? []).some((b) => b.kind === 'image')).toBe(true);
    expect(thinkingOf(message.blocks)?.done).toBe(true);
  });

  it('⛔ 본문 «없이» 끝나는 턴에서도 닫힌다 — 툴만 돈 경우', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [thought('생각만 하고 끝')], { stopReason: 'end_turn' });
    const { message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-T'));
    expect(thinkingOf(message.blocks)?.done).toBe(true);
  });
});

/** ⛔⭐⭐⭐ 「생각」이 실패·중단에서도 닫히고, 그 사실이 «화면까지» 간다 — 사후 리뷰 must-fix.
 *
 *  📏 리뷰: *"`acp.prompt()` 가 reject/abort 되면 정상 반환 뒤에만 있는 `closeActiveThought()` 가
 *  실행되지 않아 ***열린 ThinkingPill 이 남는다***."*
 *  ⛔⭐ 그리고 고치다 «반쯤만» 고칠 뻔했다 — 블록을 닫아도 ***`onPartialBlocks` 를 안 보내면
 *  화면은 그대로 맥박친다.*** 실패 경로는 `message` 를 반환하지 못하므로 그 콜백이 유일한 길이다. */
describe('runChatTurnAcp — 턴이 죽어도 「생각」은 닫힌다', () => {
  it('⛔ prompt 가 실패해도 열린 생각을 닫고 «스냅샷을 보낸다»', async () => {
    // ⭐ 기존 목을 «재사용»한다 — 새로 만들면 `AcpConnection` 의 필드를 빠뜨린다(실제로 그랬다).
    const base = makeMockAcp();
    const acp: AcpConnection = {
      ...base.acp,
      // 생각 청크를 «흘린 뒤» 실패한다 — 실제 중단/오류의 모양이다.
      send: async () => {
        base.emit(chunkUpdate('sess-F', {
          sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '생각 중' },
        }));
        throw new Error('boom');
      },
    };

    const snapshots: Array<readonly { kind: string; done?: boolean }[]> = [];
    let threw = false;
    try {
      await runChatTurnAcp(acp, 'hi', makeAcpCtx('sess-F'), {
        onPartialBlocks: (blocks) => snapshots.push(blocks as never),
      });
    } catch { threw = true; }

    expect(threw).toBe(true);
    // 🔑 «마지막» 스냅샷이 닫힌 상태여야 한다 — 그것이 화면이 보는 마지막 그림이다.
    const last = snapshots.at(-1);
    const thinking = (last ?? []).find((b) => b.kind === 'agent_thinking') as { done: boolean } | undefined;
    expect(thinking).toBeDefined();
    expect(thinking?.done).toBe(true);
  });
});

/** ⛔⭐⭐⭐ 「생각 채널」로 오는 것이 «전부 생각은 아니다» — 17차 `[F]` 라이브 회귀.
 *
 *  📏 2026-08-22: `agent_thought_chunk` 배선을 켠 «첫 라이브»에서 화면에
 *  ***`<<elanous-feedback-end …>>` 원시 마커가 그대로 샜다.***
 *  ⇒ `src/acp/elanous-extensions.ts` 가 ***FeedbackEnvelope 을 그 채널 「위에」 싣기*** 때문이다
 *    (ACP SDK 가 커스텀 sessionUpdate 를 거부해서 그렇게 했다).
 *  🔑 ***내가 켠 배선이 남의 봉투를 화면에 끌어냈다*** — 켜기 전엔 이 채널을 통째로 무시했으니 안 보였다. */
describe('runChatTurnAcp — 봉투는 「생각」이 아니다', () => {
  const validEnvelope = (blockId: string, msg: string, phase: 'start' | 'update' = 'start') => [
    `[elanous/feedback/emit] ${blockId}`,
    JSON.stringify({
      envelopeVersion: 1,
      sessionId: 'sess-E',
      blockId,
      kind: 'agent.thinking',
      phase,
      emittedAt: 1_700_000_000_000,
      seq: 1,
      payload: { msg },
      asciiFallback: ['⌁ thinking'],
    }),
    `<<elanous-feedback-end ${blockId}>>`,
  ].join('\n');
  const envelope = [
    '[elanous/feedback/emit] blk-1',
    JSON.stringify({ kind: 'agent.thinking', blockId: 'blk-1', phase: 'start' }),
    '<<elanous-feedback-end blk-1>>',
  ].join('\n');

  it('loads every vector from the repository-root canonical source', () => {
    assertCanonicalFeedbackEnvelopeVectorsPath(feedbackEnvelopeVectorsPath);
  });

  it('rejects a same-content vector-file copy, so a divergent PWA loader fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-feedback-envelope-vectors-'));
    const copiedPath = join(directory, 'elanous-feedback-envelope-vectors.json');
    try {
      writeFileSync(copiedPath, readFileSync(feedbackEnvelopeVectorsPath, 'utf8'));
      expect(() => assertCanonicalFeedbackEnvelopeVectorsPath(copiedPath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('matches the shared daemon vocabulary bidirectionally', () => {
    const sharedKinds = new Set(feedbackEnvelopeVectors.kinds);
    const pwaKinds = new Set<string>(FEEDBACK_KINDS);
    expect([...sharedKinds].filter((kind) => !pwaKinds.has(kind))).toEqual([]);
    expect([...pwaKinds].filter((kind) => !sharedKinds.has(kind))).toEqual([]);
  });

  it.each(feedbackEnvelopeVectors.vectors)('$name follows the shared feedback envelope contract', (vector) => {
    const parsed = parseElanousFeedbackEnvelope(vector.wire);
    expect(parsed).toEqual(
      (vector.expect.accepted ? vector.expect.result : null) as ReturnType<typeof parseElanousFeedbackEnvelope>,
    );
  });

  it('parses the daemon compatibility wire sample and rejects malformed bodies', () => {
    const text = validEnvelope('blk-1', 'reading source');
    expect(parseElanousFeedbackEnvelope(text)).toMatchObject({
      method: 'emit',
      payload: { blockId: 'blk-1', kind: 'agent.thinking', payload: { msg: 'reading source' } },
    });
    expect(parseElanousFeedbackEnvelope('[elanous/feedback/emit] blk-1\n{not json}\n<<elanous-feedback-end blk-1>>')).toBeNull();
    expect(parseElanousFeedbackEnvelope(`${text}\nextra`)).toMatchObject({ payload: { blockId: 'blk-1' } });
    expect(parseElanousFeedbackEnvelope(text.replace('<<elanous-feedback-end blk-1>>', '<<elanous-feedback-end other>>'))).toMatchObject({
      payload: { blockId: 'blk-1' },
    });
  });

  it('accumulates valid feedback envelopes through the existing stable-block accumulator', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [
      chunkUpdate('sess-E', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: validEnvelope('blk-1', 'first') } }),
      chunkUpdate('sess-E', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: validEnvelope('blk-1', 'updated', 'update') } }),
    ], { stopReason: 'end_turn' });

    const { message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-E'));
    const feedbackBlocks = (message.blocks ?? []).filter((block) => block.kind === 'agent_thinking');
    expect(feedbackBlocks).toHaveLength(1);
    expect(feedbackBlocks[0]).toMatchObject({ blockId: 'blk-1', msg: 'updated' });
  });

  it('passes the shared mission.update wire sample to the accumulator as unhandled without growing rendered blocks', async () => {
    const vector = feedbackEnvelopeVectors.vectors.find(({ name }) => name === 'mission-update-unhandled');
    expect(vector).toBeDefined();
    const parsed = parseElanousFeedbackEnvelope(vector!.wire);
    expect(parsed).not.toBeNull();
    const accumulatorSpy = spyOn(feedbackBlockAccumulator, 'applyFeedbackEnvelope');
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [
      chunkUpdate('sess-E', {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: vector!.wire },
      }),
    ], { stopReason: 'end_turn' });

    try {
      const { message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-E'));
      expect(accumulatorSpy).toHaveBeenCalledWith([], parsed!.payload);
      expect(accumulatorSpy).toHaveReturnedWith('unhandled');
      expect(message.blocks ?? []).toHaveLength(0);
    } finally {
      accumulatorSpy.mockRestore();
    }
  });

  it('⛔ 봉투 텍스트는 화면 블록으로 «안» 그려진다', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [
      chunkUpdate('sess-E', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: envelope } }),
      chunkUpdate('sess-E', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '답' } }),
    ], { stopReason: 'end_turn' });
    const { message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-E'));
    const blocks = message.blocks ?? [];
    expect(blocks.some((b) => b.kind === 'agent_thinking')).toBe(false);
    // ⭐ 그리고 «어디에도» 그 마커가 없어야 한다 — 텍스트로도 새면 안 된다.
    expect(JSON.stringify(blocks)).not.toContain('elanous-feedback-end');
    expect(message.text ?? '').not.toContain('elanous-feedback-end');
  });

  it('⭐ 그러나 «진짜 생각»은 그대로 보여준다 — 봉투만 거른다', async () => {
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [
      chunkUpdate('sess-E', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: envelope } }),
      chunkUpdate('sess-E', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '진짜 생각' } }),
    ], { stopReason: 'end_turn' });
    const { message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-E'));
    const thinking = (message.blocks ?? []).find((b) => b.kind === 'agent_thinking') as { msg: string } | undefined;
    expect(thinking?.msg).toBe('진짜 생각');
  });
});

/** ⛔⭐⭐ 관측 payload 를 «런타임»으로 잡는다 — 무인 리뷰 should-fix(PR #11332):
 *  *"소스 문자열 검사만으로 배선이 보장되는 것처럼 보이지 않게 하라."*
 *
 *  ⚠️📏 16차 `[F]` 가 여기서 한 번 헛짚었다 — `console.log` 를 스파이했는데 실제는 `console.debug` 였다.
 *  ⇒ 그래서 «정확히» `console.debug` 를 잡는다. */
describe('runChatTurnAcp — 끝 관측 payload (런타임)', () => {
  const validEnvelope = (blockId: string, msg: string, phase: 'start' | 'update' = 'start') => [
    `[elanous/feedback/emit] ${blockId}`,
    JSON.stringify({
      envelopeVersion: 1,
      sessionId: 'sess-P',
      blockId,
      kind: 'agent.thinking',
      phase,
      emittedAt: 1_700_000_000_000,
      seq: 1,
      payload: { msg },
      asciiFallback: ['⌁ thinking'],
    }),
    `<<elanous-feedback-end ${blockId}>>`,
  ].join('\n');

  it('⭐ valid envelopes accumulate into one stable block and leave the suppressed-envelope count at zero', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const original = console.debug;
    console.debug = ((...args: unknown[]) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (first.includes('webterm.chat.runturn.acp.end')) {
        const payload = args[args.length - 1];
        if (payload && typeof payload === 'object') seen.push(payload as Record<string, unknown>);
      }
    }) as typeof console.debug;

    let message: Awaited<ReturnType<typeof runChatTurnAcp>>['message'];
    try {
      const handle = makeProgrammableAcp();
      handle.programNext('session/prompt', [
        chunkUpdate('sess-P', {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: validEnvelope('obs-1', 'first') },
        }),
        chunkUpdate('sess-P', {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: validEnvelope('obs-1', 'updated', 'update') },
        }),
      ], { stopReason: 'end_turn' });
      ({ message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-P')));
    } finally {
      console.debug = original;
    }

    const feedbackBlocks = (message!.blocks ?? []).filter((block) => block.kind === 'agent_thinking');
    expect(feedbackBlocks).toEqual([
      expect.objectContaining({ blockId: 'obs-1', msg: 'updated' }),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ feedbackEnvelopes: 0, thoughts: 0 });
  });

  it('⭐ malformed envelope-shaped text remains counted as suppressed and does not leak markers', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const original = console.debug;
    console.debug = ((...args: unknown[]) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (first.includes('webterm.chat.runturn.acp.end')) {
        const payload = args[args.length - 1];
        if (payload && typeof payload === 'object') seen.push(payload as Record<string, unknown>);
      }
    }) as typeof console.debug;

    let message: Awaited<ReturnType<typeof runChatTurnAcp>>['message'];
    try {
      const handle = makeProgrammableAcp();
      handle.programNext('session/prompt', [
        chunkUpdate('sess-P', {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: '[elanous/feedback/emit] b1\n{"kind":"x"}\n<<elanous-feedback-end b1>>' },
        }),
        chunkUpdate('sess-P', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '진짜' } }),
      ], { stopReason: 'end_turn' });
      ({ message } = await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-P')));
    } finally {
      console.debug = original;
    }

    expect(JSON.stringify(message!.blocks ?? [])).not.toContain('elanous-feedback-end');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ feedbackEnvelopes: 1, thoughts: 1 });
  });
});

/** ⛔⭐⭐⭐ **「시작만 내고 끝이 없는 턴」을 잡는 자 — 19차 `[F]`.**
 *
 *  ## 왜 이 자가 있나
 *
 *  📏 2026-08-22 라이브 실측: 데몬을 재시작한 뒤 브라우저 탭의 WebSocket 이 죽어 있었다.
 *  그 위로 턴을 보내니 ***화면엔 `error: socket closed: 1006` 이 떴는데***,
 *  `elanous logs` 에는 **`webterm.chat.runturn.acp.start` 만 있고 끝이 «한 줄도» 없었다.**
 *
 *  🔑 ***그래서 관측만 보면 그 턴은 「아직 도는 중」과 구별되지 않는다.***
 *  ⛔ 그리고 그것은 조용하다 — 사람은 실패를 «겪고» 있는데 관측은 아무 말도 하지 않는다.
 *
 *  ## ⛔ 이 자가 무는 규칙 — 「시작을 냈으면 끝을 낸다」
 *
 *  `…​.start` 를 낸 경로는 **모든 종료 갈래**(성공 · 중단 · 실패)에서 `…​.end` 를 내야 한다.
 *  ⭐ 그리고 ***이름을 갈지 않는다*** — 실패만 다른 이벤트로 빼면 조회가 갈려서
 *    「시작 N · 끝 N」 대조가 «불가능»해진다. 갈리는 것은 `stopReason` 뿐이다.
 *
 *  ## ⚠️ 이 자가 답하지 «않는» 것
 *
 *  `ChatLayout` 같은 리액트 컴포넌트의 갈래 — 이 저장소엔 리액트 시험 도구가 «없다»(로드맵 ⑤).
 *  ⇒ 그 축은 `turn-end-observation.test.ts` 가 «배선»만 본다. */
describe('⛔ 실패한 턴도 「끝」을 낸다 — 시작만 남기지 않는다', () => {
  /** `console.debug` 를 잡아 특정 카테고리의 payload 만 모은다.
   *  ⚠️ `debugLog` 는 `console.log` 가 아니라 **`console.debug`** 다(16차가 여기서 헛짚었다). */
  function captureEnds(marker: string): { seen: Array<Record<string, unknown>>; restore: () => void } {
    const seen: Array<Record<string, unknown>> = [];
    const original = console.debug;
    console.debug = ((...args: unknown[]) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (first.includes(marker)) {
        const payload = args[args.length - 1];
        if (payload && typeof payload === 'object') seen.push(payload as Record<string, unknown>);
      }
    }) as typeof console.debug;
    return { seen, restore: () => { console.debug = original; } };
  }

  it('ACP 경로 — `session/prompt` 가 reject 해도 `acp.end` 를 낸다', async () => {
    const cap = captureEnds('webterm.chat.runturn.acp.end');
    const base = makeProgrammableAcp();
    const failing: AcpConnection = {
      ...base.acp,
      send: async () => { throw new Error('socket closed: 1006'); },
    };
    try {
      await expect(runChatTurnAcp(failing, 'hi', makeAcpCtx('sess-FAIL')))
        .rejects.toThrow('socket closed: 1006');
    } finally {
      cap.restore();
    }
    expect(cap.seen).toHaveLength(1);
    // 🔑 이름은 «같고» `stopReason` 만 갈린다 — 그래야 「시작 N · 끝 N」 대조가 선다.
    expect(cap.seen[0]).toMatchObject({ stopReason: 'error', error: 'socket closed: 1006' });
    // ⭐ 실패 시점까지 «실제로 센» 값은 싣는다 — 「측정 불가」가 아니라 「0을 쟀다」이므로.
    expect(cap.seen[0]).toMatchObject({ images: 0, tools: 0, mcpApps: 0, thoughts: 0 });
  });

  it('⭐ ACP 경로 — 사용자 중단은 `error` 가 아니라 `aborted` 로 «구별»된다', async () => {
    const cap = captureEnds('webterm.chat.runturn.acp.end');
    const base = makeProgrammableAcp();
    const ac = new AbortController();
    const failing: AcpConnection = {
      ...base.acp,
      // 턴이 «도는 중»에 중단된 상황 — 진입 시점 중단은 시작 관측 «전»이라 짝이 안 깨진다.
      send: async () => { ac.abort(); throw new Error('aborted'); },
    };
    try {
      await expect(runChatTurnAcp(failing, 'hi', makeAcpCtx('sess-ABRT'), { signal: ac.signal }))
        .rejects.toThrow();
    } finally {
      cap.restore();
    }
    expect(cap.seen).toHaveLength(1);
    expect(cap.seen[0]).toMatchObject({ stopReason: 'aborted' });
  });

  it('스트리밍 경로 — `promptStream` 이 reject 해도 `stream.end` 를 낸다', async () => {
    const cap = captureEnds('webterm.chat.runturn.stream.end');
    const ctx = makeCtx('sess-SFAIL');
    (ctx.client as unknown as { promptStream: () => Promise<never> }).promptStream =
      async () => { throw new Error('daemon gone'); };
    try {
      await expect(runChatTurnStreaming('hi', ctx)).rejects.toThrow('daemon gone');
    } finally {
      cap.restore();
    }
    expect(cap.seen).toHaveLength(1);
    expect(cap.seen[0]).toMatchObject({ stopReason: 'error', error: 'daemon gone' });
    // ⛔ 이 경로가 «세는» 축은 넷이다 — 실패해도 그대로 싣는다(자 `turn-end-observation` 과 같은 규칙).
    expect(cap.seen[0]).toMatchObject({ images: 0, tools: 0, mcpApps: 0, feedback: 0 });
  });

  it('⛔ 성공 payload 에는 `error` 를 «넣지 않는다» — 있으면 실패로 오독된다', async () => {
    const cap = captureEnds('webterm.chat.runturn.acp.end');
    const handle = makeProgrammableAcp();
    handle.programNext('session/prompt', [], { stopReason: 'end_turn' });
    try {
      await runChatTurnAcp(handle.acp, 'hi', makeAcpCtx('sess-OK'));
    } finally {
      cap.restore();
    }
    expect(cap.seen).toHaveLength(1);
    expect(Object.keys(cap.seen[0]!)).not.toContain('error');
  });
});
