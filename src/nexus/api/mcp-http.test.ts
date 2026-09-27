// Direct-Request tests for POST /v1/mcp opt-in progress streaming.
// No daemon, no open port — handleMcpHttpPost is invoked with Request objects.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { makeEnvelope, createSeqTracker, type FeedbackEnvelope } from '../../feedback/envelope.js';
import { handleMcpHttpPost, isProgressStreamOptIn, MCP_PROGRESS_FIELD, MCP_PROGRESS_HEADER, MCP_PROGRESS_STREAM } from './mcp-http.js';
import { listNativeToolsForHost, type NativeToolCatalogEntry } from '../../native-tool-catalog.js';
import { registerToolRuntime, _resetToolRuntimeRegistryForTest } from '../../tool-runtime/registry.js';
import type { ToolRuntime, ToolRuntimeContext } from '../../tool-runtime/types.js';

/** Frozen default initialize envelope — HTTP layer must emit this byte-for-byte
 *  when streaming is not opted in. Produced by JSON.stringify of handleMcpRequest. */
const DEFAULT_INITIALIZE_BODY =
  '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"monad-agent","version":"0.1.0"}}}';

const DEFAULT_TOOL_CALL_BODY =
  '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"xcode.build done"}],"structuredContent":{"output":"xcode.build done"}}}';

const PARSE_ERROR_BODY =
  '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}';

const INVALID_OBJECT_BODY =
  '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"invalid request: expected object"}}';

const METHOD_MISSING_BODY =
  '{"jsonrpc":"2.0","id":5,"error":{"code":-32600,"message":"invalid request: method missing"}}';

function loopbackContext(overrides: Record<string, unknown> = {}) {
  return { peerAddress: '127.0.0.1', ...overrides };
}

function catalogTool(id: string, overrides: Partial<NativeToolCatalogEntry> = {}): NativeToolCatalogEntry {
  return {
    id,
    aliases: [],
    kind: 'other',
    displayName: id,
    description: id,
    promptSummary: id,
    host: ['mcp'],
    safety: ['read-only'],
    supportsParallel: false,
    defaultEnabled: true,
    ...overrides,
  };
}

function jsonRpcReq(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request('http://test.local/v1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function streamHeader(): Record<string, string> {
  return { [MCP_PROGRESS_HEADER]: MCP_PROGRESS_STREAM };
}

function progressEnvelope(seq: SeqLike, line: string): FeedbackEnvelope {
  return makeEnvelope(
    {
      kind: 'tool.progress',
      sessionId: 'mcp-http-test',
      blockId: 'mcp-http-progress',
      phase: 'delta',
      payload: { stream: 'generic', lines: [line] },
      asciiFallback: [line],
    },
    seq,
  );
}

type SeqLike = ReturnType<typeof createSeqTracker>;

function makeProgressRuntime(
  id: string,
  opts: {
    progressLines?: string[];
    throwMessage?: string;
    onRun?: (ctx: ToolRuntimeContext) => void;
    hold?: { release: Promise<void> };
  } = {},
): ToolRuntime {
  return {
    id,
    spec: { name: id, description: `proxy ${id}`, parameters: { type: 'object' } },
    surfaces: ['mcp'],
    async run(_req, ctx) {
      opts.onRun?.(ctx);
      const seq = createSeqTracker();
      for (const line of opts.progressLines ?? []) {
        ctx.emitFeedback?.(progressEnvelope(seq, line));
      }
      if (opts.hold) await opts.hold.release;
      if (opts.throwMessage) throw new Error(opts.throwMessage);
      return { output: `${id} done` };
    },
  };
}

function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  const chunks = text.split('\n\n').filter((chunk) => chunk.trim().length > 0);
  for (const chunk of chunks) {
    let event = '';
    let dataRaw = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) dataRaw = line.slice('data: '.length);
    }
    frames.push({ event, data: dataRaw ? JSON.parse(dataRaw) as unknown : null });
  }
  return frames;
}

function responseModeEvents(): Array<{ category: string; event: string; data?: unknown }> {
  return debug.events(200).filter((entry) => entry.category === 'mcp.http.response' && entry.event === 'mode');
}

let debugLevelBeforeTest: ReturnType<typeof debug.level>;

async function waitUntil(predicate: () => boolean, ms = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

beforeEach(() => {
  _resetToolRuntimeRegistryForTest();
  debugLevelBeforeTest = debug.level();
  // `handleMcpHttpPost` logs response modes directly; trail enables the ring
  // sink so this test observes that existing product path without credentials.
  debug.setLevel('trail');
  debug.clear();
});

afterEach(() => {
  _resetToolRuntimeRegistryForTest();
  debug.clear();
  debug.setLevel(debugLevelBeforeTest);
});

describe('handleMcpHttpPost — default JSON contract (opt-in off)', () => {
  test('streaming not requested → single application/json body, byte-identical to frozen envelope', async () => {
    const res = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      loopbackContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(DEFAULT_INITIALIZE_BODY);
  });

  test('Accept: text/event-stream alone keeps the frozen JSON envelope', async () => {
    const res = await handleMcpHttpPost(
      jsonRpcReq(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { accept: 'application/json, text/event-stream' },
      ),
      loopbackContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(DEFAULT_INITIALIZE_BODY);
  });

  test('params._mcpProgress does not switch off the default JSON envelope', async () => {
    registerToolRuntime(makeProgressRuntime('xcode.build', { progressLines: ['one', 'two'] }));
    const baseline = await handleMcpHttpPost(
      jsonRpcReq({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'xcode.build', arguments: {} },
      }),
      loopbackContext(),
    );
    const smuggled = await handleMcpHttpPost(
      jsonRpcReq({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'xcode.build', arguments: {}, _mcpProgress: MCP_PROGRESS_STREAM },
      }),
      loopbackContext(),
    );
    expect(baseline.status).toBe(200);
    expect(baseline.headers.get('content-type')).toBe('application/json');
    expect(smuggled.status).toBe(200);
    expect(smuggled.headers.get('content-type')).toBe('application/json');
    const baselineBody = await baseline.text();
    const smuggledBody = await smuggled.text();
    expect(baselineBody).toBe(DEFAULT_TOOL_CALL_BODY);
    expect(smuggledBody).toBe(DEFAULT_TOOL_CALL_BODY);
    expect(smuggledBody).toBe(baselineBody);
  });

  test('notification without id → 202 empty body (unchanged)', async () => {
    const res = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      loopbackContext(),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('notification stays 202 even when streaming is requested', async () => {
    const res = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', method: 'notifications/initialized' }, streamHeader()),
      loopbackContext(),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
});

describe('handleMcpHttpPost — catalog automatic SSE progress', () => {
  test.each([
    ['delegate', catalogTool('long.delegate', { kind: 'delegate' }), 'delegate'],
    ['process safety', catalogTool('long.process', { safety: ['process'] }), 'process'],
    ['agent safety', catalogTool('long.agent', { safety: ['agent'] }), 'agent'],
  ] as const)('%s catalog signal streams automatically and records its reason', async (_label, tool, reason) => {
    registerToolRuntime(makeProgressRuntime(tool.id, { progressLines: ['working'] }));
    const before = responseModeEvents().length;
    const res = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: tool.id, arguments: {} } }),
      loopbackContext({ mcpToolCatalog: [tool] }),
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(parseSse(await res.text()).map((frame) => frame.event)).toEqual(['progress', 'result']);
    const event = responseModeEvents().slice(before).at(-1)!;
    expect(event.data).toMatchObject({ mode: 'sse', automatic: true, reason, toolName: tool.id });
  });

  test('fast catalog tool stays JSON, params signal remains ignored, and disabling detection restores JSON', async () => {
    const tool = catalogTool('fast.read');
    registerToolRuntime(makeProgressRuntime(tool.id));
    const body = { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: tool.id, arguments: {}, _mcpProgress: MCP_PROGRESS_STREAM } };
    const fast = await handleMcpHttpPost(jsonRpcReq(body), loopbackContext({ mcpToolCatalog: [tool] }));
    expect(fast.headers.get('content-type')).toBe('application/json');

    const longTool = catalogTool('long.disabled', { kind: 'delegate' });
    registerToolRuntime(makeProgressRuntime(longTool.id));
    const disabled = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: longTool.id, arguments: {} } }),
      loopbackContext({ mcpToolCatalog: [longTool], automaticProgressDetection: false }),
    );
    expect(disabled.headers.get('content-type')).toBe('application/json');
  });

  test('header and top-level field remain authoritative for fast tools, while non-call methods stay JSON', async () => {
    const tool = catalogTool('fast.explicit');
    registerToolRuntime(makeProgressRuntime(tool.id));
    const header = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: tool.id, arguments: {} } }, streamHeader()),
      loopbackContext({ mcpToolCatalog: [tool] }),
    );
    expect(header.headers.get('content-type')).toBe('text/event-stream');
    const body = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: tool.id, arguments: {} }, [MCP_PROGRESS_FIELD]: MCP_PROGRESS_STREAM }),
      loopbackContext({ mcpToolCatalog: [tool] }),
    );
    expect(body.headers.get('content-type')).toBe('text/event-stream');
    const nonCall = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 26, method: 'tools/list' }),
      loopbackContext({ mcpToolCatalog: [catalogTool('not.used', { kind: 'delegate' })] }),
    );
    expect(nonCall.headers.get('content-type')).toBe('application/json');
  });

  test('actual MCP catalog routes all 49 injected tools through the HTTP response policy', async () => {
    const catalog = listNativeToolsForHost('mcp');
    for (const tool of catalog) registerToolRuntime(makeProgressRuntime(tool.id));

    const automatic: NativeToolCatalogEntry[] = [];
    const unchanged: NativeToolCatalogEntry[] = [];
    for (const [index, tool] of catalog.entries()) {
      const rpc = { jsonrpc: '2.0' as const, id: index + 100, method: 'tools/call', params: { name: tool.id, arguments: {} } };
      const decision = isProgressStreamOptIn(jsonRpcReq(rpc), rpc, { mcpToolCatalog: catalog });
      const response = await handleMcpHttpPost(jsonRpcReq(rpc), loopbackContext({ mcpToolCatalog: catalog }));

      expect(response.status).toBe(200);
      if (decision.automatic) {
        automatic.push(tool);
        expect(decision).toMatchObject({ stream: true, toolName: tool.id });
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        expect(parseSse(await response.text()).map((frame) => frame.event)).toEqual(['result']);
      } else {
        unchanged.push(tool);
        expect(decision).toEqual({ stream: false, automatic: false });
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: index + 100, result: { content: [{ type: 'text' }] } });
      }
    }

    // The four additional entries are legitimate: their catalog metadata is
    // MCP-only and default-enabled, and handleMcpRequest filters runtimes to
    // the MCP surface. They must therefore remain visible here.
    expect(catalog).toHaveLength(49);
    expect(catalog.map((tool) => tool.id)).toEqual(expect.arrayContaining([
      'self_recall',
      'logs_query',
      'ops_status',
      'memory_recall',
    ]));
    expect(automatic).toHaveLength(4);
    expect(unchanged).toHaveLength(45);
  });

  test('removing automatic detection makes the long-running decision fail', () => {
    const req = jsonRpcReq({ jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'long.delegate', arguments: {} } });
    const decision = isProgressStreamOptIn(req, { method: 'tools/call', params: { name: 'long.delegate' } }, {
      mcpToolCatalog: [catalogTool('long.delegate', { kind: 'delegate' })],
    });
    expect(decision).toMatchObject({ stream: true, automatic: true, reason: 'delegate' });
  });
});

describe('handleMcpHttpPost — opt-in SSE progress', () => {
  test('header opt-in + two progress events → ordered progress then result', async () => {
    registerToolRuntime(makeProgressRuntime('xcode.build', { progressLines: ['one', 'two'] }));
    const res = await handleMcpHttpPost(
      jsonRpcReq(
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } },
        streamHeader(),
      ),
      loopbackContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = parseSse(await res.text());
    expect(frames.map((f) => f.event)).toEqual(['progress', 'progress', 'result']);
    const lines = frames
      .filter((f) => f.event === 'progress')
      .map((f) => (f.data as FeedbackEnvelope).payload as { lines: string[] })
      .map((p) => p.lines[0]);
    expect(lines).toEqual(['one', 'two']);
    const result = frames.at(-1)!.data as { id: number; result: { content: Array<{ text?: string }> } };
    expect(result.id).toBe(7);
    expect(result.result.content[0]!.text).toContain('xcode.build done');
  });

  test('body-field opt-in with no progress still delivers the terminal result', async () => {
    registerToolRuntime(makeProgressRuntime('xcode.build', { progressLines: [] }));
    const res = await handleMcpHttpPost(
      jsonRpcReq({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'xcode.build', arguments: {} },
        [MCP_PROGRESS_FIELD]: MCP_PROGRESS_STREAM,
      }),
      loopbackContext(),
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = parseSse(await res.text());
    expect(frames.map((f) => f.event)).toEqual(['result']);
    const result = frames[0]!.data as { id: number; result: { content: Array<{ text?: string }> } };
    expect(result.id).toBe(8);
    expect(result.result.content[0]!.text).toContain('xcode.build done');
  });

  test('opt-in tool exception is delivered as an error event, not silence', async () => {
    registerToolRuntime(makeProgressRuntime('xcode.build', { throwMessage: 'boom-from-tool' }));
    const res = await handleMcpHttpPost(
      jsonRpcReq(
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } },
        streamHeader(),
      ),
      loopbackContext(),
    );
    const frames = parseSse(await res.text());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)!.event).toBe('error');
    const err = frames.at(-1)!.data as { error: { message: string } };
    expect(err.error.message).toContain('boom-from-tool');
  });

  test('client cancel of the response stream does not cancel server-side work', async () => {
    let started = false;
    let finished = false;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const runtime = makeProgressRuntime('xcode.build', {
      progressLines: ['held'],
      hold: { release: hold },
    });
    const originalRun = runtime.run.bind(runtime);
    runtime.run = async (req, ctx) => {
      started = true;
      try {
        return await originalRun(req, ctx);
      } finally {
        finished = true;
      }
    };
    registerToolRuntime(runtime);

    const res = await handleMcpHttpPost(
      jsonRpcReq(
        { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } },
        streamHeader(),
      ),
      loopbackContext(),
    );
    expect(res.body).toBeTruthy();
    const reader = res.body!.getReader();
    expect(await waitUntil(() => started)).toBe(true);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(false);
    release();
    expect(await waitUntil(() => finished)).toBe(true);
  });

  test('removing the streaming branch would fail this inspection', async () => {
    registerToolRuntime(makeProgressRuntime('xcode.build', { progressLines: ['one'] }));
    const res = await handleMcpHttpPost(
      jsonRpcReq(
        { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } },
        streamHeader(),
      ),
      loopbackContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('content-type')).not.toBe('application/json');
    const body = await res.text();
    expect(body).not.toBe(DEFAULT_TOOL_CALL_BODY.replace('"id":1', '"id":12'));
    const frames = parseSse(body);
    expect(frames.map((f) => f.event)).toEqual(['progress', 'result']);
  });
});

describe('handleMcpHttpPost — response-mode observation', () => {
  test('json and sse modes leave distinguishable mcp.http.response mode values', async () => {
    registerToolRuntime(makeProgressRuntime('xcode.build'));
    const before = responseModeEvents().length;
    const json = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      loopbackContext(),
    );
    const sse = await handleMcpHttpPost(
      jsonRpcReq(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } },
        streamHeader(),
      ),
      loopbackContext(),
    );
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    const modes = responseModeEvents()
      .slice(before)
      .map((entry) => (entry.data as { mode?: string } | undefined)?.mode);
    expect(modes).toContain('json');
    expect(modes).toContain('sse');
    expect(new Set(modes)).toEqual(new Set(['json', 'sse']));
  });
});

describe('handleMcpHttpPost — access and malformed preservation', () => {
  test('browser origin is still denied before dispatch', async () => {
    let executions = 0;
    registerToolRuntime(makeProgressRuntime('xcode.build', { onRun() { executions += 1; } }));
    const res = await handleMcpHttpPost(
      jsonRpcReq(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } },
        { origin: 'https://attacker.example', ...streamHeader() },
      ),
      loopbackContext(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(await res.text()).toBe('');
    expect(executions).toBe(0);
  });

  test('loopback peer behind a proxy (X-Forwarded-For · Tailscale-*) is not trusted without a token — RFC 공개 MCP M0', async () => {
    let executions = 0;
    registerToolRuntime(makeProgressRuntime('xcode.build', { onRun() { executions += 1; } }));
    const proxiedHeaders: Record<string, string>[] = [{ 'x-forwarded-for': '100.83.1.69' }, { 'tailscale-user-login': 'someone@example.com' }, { forwarded: 'for=203.0.113.9' }];
    for (const proxied of proxiedHeaders) {
      const res = await handleMcpHttpPost(
        jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } }, proxied),
        loopbackContext(),
      );
      expect(res.status).toBe(401);
    }
    expect(executions).toBe(0);
    // 대조군: 같은 요청이 프록시 표식 없이 루프백에서 직접 오면 종전대로 통과한다(이 기계의 로컬 클라이언트).
    const direct = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      loopbackContext(),
    );
    expect(direct.status).toBe(200);
  });

  test('non-JSON body → 400 parse error with frozen envelope bytes', async () => {
    const req = new Request('http://test.local/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {{',
    });
    const res = await handleMcpHttpPost(req, loopbackContext());
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(PARSE_ERROR_BODY);
  });

  test('object-not / method-missing → 400 invalid request with frozen envelope bytes', async () => {
    const cases: Array<{ body: string; expected: string }> = [
      { body: JSON.stringify([1, 2, 3]), expected: INVALID_OBJECT_BODY },
      { body: 'null', expected: INVALID_OBJECT_BODY },
      { body: JSON.stringify({ jsonrpc: '2.0', id: 5 }), expected: METHOD_MISSING_BODY },
    ];
    for (const { body, expected } of cases) {
      const req = new Request('http://test.local/v1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const res = await handleMcpHttpPost(req, loopbackContext());
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.text()).toBe(expected);
    }
  });
});
