/**
 * NEXUS T3 endpoint contract test — DaemonClient surface.
 *
 * 모든 PWA → NEXUS REST 트래픽이 거치는 single point. 본 test 는:
 * - GET `/v1/health` (DOGFOOD §0.4 PWA-side)
 * - generic `fetchJson<T>` wrapper 의 200 / non-OK / JSON 디코딩 분기
 * - URL 합성 (trailing slash strip · path concat)
 * - bearer token authorization header forwarding
 *
 * WS upgrade builders (`buildAcpWsUrl` / `buildVoiceWsUrl`) 의 contract
 * 는 별도 daemon-config.ws-url.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DaemonClient, type DaemonTerminalSummary } from './daemon-client';

// Compile-time wire contract: current daemon values and absent legacy rows are both valid.
const terminalOriginContract: readonly DaemonTerminalSummary['origin'][] = [
  'human', 'system', 'unknown', undefined,
];
// @ts-expect-error terminal origins are limited to the daemon's three-value contract.
const invalidTerminalOrigin: DaemonTerminalSummary['origin'] = 'agent';
void terminalOriginContract;
void invalidTerminalOrigin;

interface FetchCall {
  url: string | URL;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function mockResponse(opts: {
  status: number;
  body: unknown;
  contentType?: string;
}): typeof fetch {
  return ((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input as string | URL, init });
    const ctype = opts.contentType ?? 'application/json';
    return {
      ok: opts.status >= 200 && opts.status < 300,
      status: opts.status,
      headers: new Headers({ 'content-type': ctype }),
      json: async () => opts.body,
      text: async () =>
        typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
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

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  binaryType = '';
  sent: string[] = [];
  closeCalls = 0;

  constructor(_url: string, _protocols?: string | string[]) {
    super();
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('closed send');
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState === MockWebSocket.CLOSED || this.readyState === MockWebSocket.CLOSING) return;
    // Browser close is asynchronous: consumers can reacquire while this
    // socket remains CLOSING, before its eventual close event.
    this.readyState = MockWebSocket.CLOSING;
  }

  finishClose(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  open(): void {
    if (this.readyState !== MockWebSocket.CONNECTING) return;
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  error(): void {
    this.dispatchEvent(new Event('error'));
  }

  fail(): void {
    this.error();
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code: 1006 }));
  }

  respond(id: number, result: unknown): void {
    this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id, result }),
    }));
  }

  respondError(id: number, message: string): void {
    this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }),
    }));
  }

  request(id: number, method: string, params: unknown): void {
    this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }));
  }
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  calls = [];
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});
afterEach(() => { globalThis.WebSocket = realWebSocket; });

describe('DaemonClient.health — GET /v1/health (DOGFOOD §0.4)', () => {
  it('hits /v1/health and returns the parsed body', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { ok: true, tabs: [], phase: 'idle' },
    });
    const client = makeClient();
    const result = await client.health();
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/health');
    expect(result.ok).toBe(true);
  });

  it('throws on non-200 with daemon error detail', async () => {
    globalThis.fetch = mockResponse({
      status: 500,
      body: { error: 'boot_in_progress' },
    });
    const client = makeClient();
    await expect(client.health()).rejects.toThrow(/boot_in_progress/);
  });
});

describe('DaemonClient.fetchJson — generic wrapper', () => {
  it('strips trailing slash from baseUrl before concatenation', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true } });
    const client = makeClient({ baseUrl: 'http://localhost:31415/' });
    await client.fetchJson('/v1/health');
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/health');
  });

  it('forwards bearer token via authorization header', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true } });
    const client = makeClient({ token: 'tok-xyz' });
    await client.fetchJson('/v1/health');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-xyz');
  });

  it('omits authorization header when token is empty', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true } });
    const client = makeClient({ token: '' });
    await client.fetchJson('/v1/health');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('decodes JSON when content-type is application/json', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { foo: 'bar' },
      contentType: 'application/json',
    });
    const client = makeClient();
    const result = await client.fetchJson<{ foo: string }>('/v1/anything');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('treats text/* as raw text body', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: 'plain string',
      contentType: 'text/plain',
    });
    const client = makeClient();
    const result = await client.fetchJson<string>('/v1/raw');
    expect(result).toBe('plain string');
  });

  it('throws using daemon `reason` field when 4xx body has it', async () => {
    globalThis.fetch = mockResponse({
      status: 400,
      body: { reason: 'bad_input', error: 'noisy' },
    });
    const client = makeClient();
    await expect(client.fetchJson('/v1/x')).rejects.toThrow(/bad_input/);
  });

  it('falls back to status code when error body is empty', async () => {
    globalThis.fetch = mockResponse({ status: 500, body: {} });
    const client = makeClient();
    await expect(client.fetchJson('/v1/x')).rejects.toThrow(/500/);
  });

  it('forwards caller-provided headers (init.headers wins on conflict via spread order)', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true } });
    const client = makeClient({ token: 'tok' });
    await client.fetchJson('/v1/x', {
      headers: { 'x-trace-id': 'abc-123' },
    });
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-trace-id']).toBe('abc-123');
    expect(headers.authorization).toBe('Bearer tok');
  });
});

// ── Phase B-1 (PWA chat streaming · 2026-05-06) — promptStream ─────

function mockSseResponse(opts: {
  status: number;
  chunks: string[];
}): typeof fetch {
  return ((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input as string | URL, init });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of opts.chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return {
      ok: opts.status >= 200 && opts.status < 300,
      status: opts.status,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
      text: async () => opts.chunks.join(''),
    } as unknown as Response;
  }) as unknown) as typeof fetch;
}

describe('DaemonClient.promptStream — POST /v1/prompt/stream (SSE)', () => {
  it('has no non-streaming prompt entry point', () => {
    expect('prompt' in DaemonClient.prototype).toBe(false);
  });

  it('hits /v1/prompt/stream with content-type + accept + bearer header', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: turn-begin\ndata: {"sessionId":"s-1"}\n\n`,
        `event: turn-end\ndata: {"sessionId":"s-1","text":"hi","stopReason":"end_turn"}\n\n`,
      ],
    });
    const client = makeClient({ token: 'tok-stream' });
    await client.promptStream({
      sessionId: 's-1',
      userText: 'hello',
      provider: 'anthropic',
    });
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/prompt/stream');
    expect(calls[0]!.init?.method).toBe('POST');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('text/event-stream');
    expect(headers.authorization).toBe('Bearer tok-stream');
  });

  it('serializes the SSE request without a tool-surface override', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: turn-end\ndata: {"sessionId":"s-2","text":"x","stopReason":"end_turn"}\n\n`,
      ],
    });
    const client = makeClient();
    await client.promptStream({
      sessionId: 's-2',
      userText: 'hello world',
      provider: 'codex',
    });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      sessionId: 's-2',
      userText: 'hello world',
      provider: 'codex',
    });
    await client.promptStream({
      userText: 'no override',
      tools: 'readonly',
    } as Parameters<DaemonClient['promptStream']>[0]);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ userText: 'no override' });
  });

  it('dispatches deltas to onTextDelta and resolves with the turn-end payload', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: turn-begin\ndata: {"sessionId":"s-3"}\n\n`,
        `event: text-delta\ndata: {"delta":"He","full":"He"}\n\n`,
        `event: text-delta\ndata: {"delta":"llo","full":"Hello"}\n\n`,
        `event: turn-end\ndata: {"sessionId":"s-3","text":"Hello","stopReason":"end_turn"}\n\n`,
      ],
    });
    const client = makeClient();
    const partials: string[] = [];
    const result = await client.promptStream(
      { userText: 'hi' },
      { onTextDelta: ({ full }) => partials.push(full) },
    );
    expect(partials).toEqual(['He', 'Hello']);
    expect(result).toEqual({
      sessionId: 's-3',
      text: 'Hello',
      stopReason: 'end_turn',
    });
  });

  it('rejects on non-200 with the response text body', async () => {
    globalThis.fetch = mockSseResponse({
      status: 503,
      chunks: ['meta-api-runtime-not-wired'],
    });
    const client = makeClient();
    await expect(
      client.promptStream({ userText: 'hi' }),
    ).rejects.toThrow(/503.*meta-api-runtime-not-wired/);
  });

  it('rejects with the daemon error event payload', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: turn-begin\ndata: {"sessionId":"s-4"}\n\n`,
        `event: error\ndata: {"error":"turn_failed","message":"boom"}\n\n`,
      ],
    });
    const client = makeClient();
    await expect(
      client.promptStream({ userText: 'hi' }),
    ).rejects.toThrow(/turn_failed.*boom/);
  });

  it('preserves the complete turn_busy error payload for the error handler', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: error\ndata: {"error":"turn_busy","message":"This session is currently receiving input from PWA tab.","holder":"PWA tab","requestId":"r-1"}\n\n`,
      ],
    });
    const client = makeClient();
    const seen: Record<string, unknown>[] = [];
    await expect(client.promptStream({ userText: 'hi' }, {
      onError: (info) => seen.push(info),
    })).rejects.toThrow(/turn_busy/);
    expect(seen).toEqual([{
      error: 'turn_busy',
      message: 'This session is currently receiving input from PWA tab.',
      holder: 'PWA tab',
      requestId: 'r-1',
    }]);
  });

  it('preserves a compatible turn_busy payload when the daemon has no holder', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: error\ndata: {"error":"turn_busy","message":"This session is currently receiving input."}\n\n`,
      ],
    });
    const client = makeClient();
    const seen: Record<string, unknown>[] = [];
    await expect(client.promptStream({ userText: 'hi' }, {
      onError: (info) => seen.push(info),
    })).rejects.toThrow(/turn_busy/);
    expect(seen).toEqual([{
      error: 'turn_busy',
      message: 'This session is currently receiving input.',
    }]);
  });

  // M6 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
  // opt-in `?debug-tap=on` URL query so daemon's debug-bridge
  // activates only when the chat client wants to mirror debug.log
  // entries (drawer UI).
  it('omits `?debug-tap=on` by default (debugTap absent)', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: turn-end\ndata: {"sessionId":"s-5","text":"x","stopReason":"end_turn"}\n\n`,
      ],
    });
    const client = makeClient();
    await client.promptStream({ userText: 'hi' });
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/prompt/stream');
  });

  it('appends `?debug-tap=on` when debugTap=true', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: turn-end\ndata: {"sessionId":"s-6","text":"x","stopReason":"end_turn"}\n\n`,
      ],
    });
    const client = makeClient();
    await client.promptStream({ userText: 'hi' }, { debugTap: true });
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/prompt/stream?debug-tap=on');
  });

  it('omits `?debug-tap=on` when debugTap=false explicitly', async () => {
    globalThis.fetch = mockSseResponse({
      status: 200,
      chunks: [
        `event: turn-end\ndata: {"sessionId":"s-7","text":"x","stopReason":"end_turn"}\n\n`,
      ],
    });
    const client = makeClient();
    await client.promptStream({ userText: 'hi' }, { debugTap: false });
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/prompt/stream');
  });
});

describe('DaemonClient.listTerminals — GET /v1/terminals (CV-3 P4.2)', () => {
  it('hits /v1/terminals + returns parsed terminals array', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: {
        terminals: [
          {
            id: 'pty_1',
            alive: true,
            correlationId: 'corr_1',
            hasPty: true,
            instance: 'test',
            name: 'terminal one',
            sessionId: 'session_1',
            sourceRoot: { name: 'test', dbPath: '/tmp/pty-manifest.db' },
            startedAt: 1,
            status: 'running',
            kind: 'webterm',
            origin: 'human',
          },
        ],
      },
    });
    const client = makeClient();
    const { terminals } = await client.listTerminals();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      id: 'pty_1',
      hasPty: true,
      name: 'terminal one',
      status: 'running',
      kind: 'webterm',
      origin: 'human',
    });
    expect(calls[0]!.url).toBe('http://localhost:31415/v1/terminals');
  });

  it('keeps origin absent for legacy terminal rows', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: {
        terminals: [{
          id: 'legacy-pty', alive: true, correlationId: 'legacy-corr', instance: 'test',
          sessionId: 'legacy-session', startedAt: 1,
        }],
      },
    });
    const { terminals } = await makeClient().listTerminals();
    expect(terminals[0]?.origin).toBeUndefined();
  });

  it('throws on non-200 with daemon error reason', async () => {
    globalThis.fetch = mockResponse({
      status: 503,
      body: { error: 'meta-api-runtime-not-wired' },
    });
    const client = makeClient();
    await expect(client.listTerminals()).rejects.toThrow(/meta-api-runtime-not-wired/);
  });
});

describe('DaemonClient.controlTerminal — POST /v1/terminals/:id/control', () => {
  it('sends encoded takeover JSON with the authenticated POST convention', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { status: 'success' } });
    const client = makeClient({ token: 'tok-control' });

    const result = await client.controlTerminal('pty / one', 'takeover');

    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/terminals/pty%20%2F%20one/control');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(new Headers(calls[0]!.init?.headers).get('content-type')).toBe('application/json');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok-control');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ action: 'takeover' });
    expect(result).toEqual({ status: 'success' });
  });

  it('sends release as the only alternative control action', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { status: 'success' } });
    const client = makeClient();

    await client.controlTerminal('pty_1', 'release');

    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ action: 'release' });
  });

  it.each([
    [200, 'success', 'success'],
    [404, 'unknown-pty', 'unknown-pty'],
    [409, 'denied', 'denied'],
    [502, 'failed', 'failed'],
    [502, 'write-failed', 'failed'],
    [504, 'owner-unreachable', 'owner-unreachable'],
  ] as const)('preserves %i / %s as the distinct %s outcome', async (httpStatus, wireStatus, expectedStatus) => {
    globalThis.fetch = mockResponse({ status: httpStatus, body: { status: wireStatus } });
    const client = makeClient();

    const result = await client.controlTerminal('pty_1', 'takeover');

    expect(result.status).toBe(expectedStatus);
  });

  it.each([
    [200, 'denied'],
    [409, 'owner-unreachable'],
    [502, 'unknown-pty'],
    [504, 'failed'],
  ] as const)('rejects mismatched HTTP status %i and body status %s', async (httpStatus, wireStatus) => {
    globalThis.fetch = mockResponse({ status: httpStatus, body: { status: wireStatus } });
    const client = makeClient();

    await expect(client.controlTerminal('pty_1', 'takeover')).rejects.toThrow(/unexpected response/);
  });

  it('rejects missing status, invalid JSON, and transport failures rather than returning an outcome', async () => {
    globalThis.fetch = mockResponse({ status: 502, body: { error: 'control-failed' } });
    const client = makeClient();
    await expect(client.controlTerminal('pty_1', 'takeover')).rejects.toThrow(/control-failed/);

    globalThis.fetch = (async () => ({
      status: 200,
      json: async () => { throw new SyntaxError('not JSON'); },
    }) as unknown as Response) as unknown as typeof fetch;
    await expect(client.controlTerminal('pty_1', 'takeover')).rejects.toThrow(/invalid JSON response/);

    globalThis.fetch = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
    await expect(client.controlTerminal('pty_1', 'takeover')).rejects.toThrow(/network down/);
  });
});

describe('DaemonClient live PTY control', () => {
  it('posts an ANSI snapshot and retains its screen', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { status: 'success', screen: '\x1b[32mlive' } });
    const result = await makeClient({ token: 'tok' }).snapshotTerminal('codex / 1', { ansi: true });
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/terminals/codex%20%2F%201/control');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ action: 'snapshot', ansi: true });
    expect(result.screen).toBe('\x1b[32mlive');
  });

  it('sends text and key via chars and preserves distinct failure statuses and reason', async () => {
    globalThis.fetch = mockResponse({ status: 409, body: { status: 'denied', reason: 'agent controls this PTY' } });
    expect(await makeClient().sendTerminalText('pty', 'hello')).toEqual({ status: 'denied', reason: 'agent controls this PTY' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ action: 'input-text', chars: 'hello' });
    globalThis.fetch = mockResponse({ status: 504, body: { status: 'owner-unreachable' } });
    expect(await makeClient().sendTerminalKey('pty', '\r')).toEqual({ status: 'owner-unreachable' });
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ action: 'input-key', chars: '\r' });
    globalThis.fetch = mockResponse({ status: 404, body: { status: 'unknown-pty' } });
    expect((await makeClient().snapshotTerminal('pty', { ansi: true })).status).toBe('unknown-pty');
    globalThis.fetch = mockResponse({ status: 502, body: { status: 'write-failed' } });
    expect((await makeClient().sendTerminalText('pty', 'x')).status).toBe('failed');
  });
});

describe('DaemonClient federated live PTY request', () => {
  it('sends the selected source root in snapshot, takeover, text, key and release URLs', async () => {
    const sourceRoot = '/roots/test/pty/manifest.db';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url instanceof Request ? url.url : url, init });
      const action = (JSON.parse(String(init?.body)) as { action: string }).action;
      return new Response(JSON.stringify({ status: 'success', ...(action === 'snapshot' ? { screen: 'screen' } : {}) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = makeClient();
    await client.snapshotTerminal('pty / one', { ansi: true, sourceRoot });
    await client.controlTerminal('pty / one', 'takeover', { sourceRoot });
    await client.sendTerminalText('pty / one', 'a', { sourceRoot });
    await client.sendTerminalKey('pty / one', '\r', { sourceRoot });
    await client.controlTerminal('pty / one', 'release', { sourceRoot });
    expect(calls.map((call) => String(call.url))).toEqual(Array(5).fill(`http://localhost:31415/v1/terminals/pty%20%2F%20one/control?sourceRoot=${encodeURIComponent(sourceRoot)}`));
    expect(calls.map((call) => (JSON.parse(String(call.init?.body)) as { action: string }).action)).toEqual(['snapshot', 'takeover', 'input-text', 'input-key', 'release']);
  });
});

describe('DaemonClient.renameTerminal — POST /v1/terminals/:id/rename', () => {
  it('sends encoded name JSON with the authenticated POST convention', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { status: 'success', id: 'pty / one', name: 'build terminal' } });
    const client = makeClient({ token: 'tok-rename' });

    const result = await client.renameTerminal('pty / one', 'build terminal');

    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/terminals/pty%20%2F%20one/rename');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(new Headers(calls[0]!.init?.headers).get('content-type')).toBe('application/json');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok-rename');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: 'build terminal' });
    expect(result).toEqual({ status: 'success', id: 'pty / one', name: 'build terminal' });
  });

  it.each([
    [404, { status: 'unknown-pty' }, 'unknown-pty'],
    [400, { error: 'invalid-name' }, 'invalid-name'],
    [409, { status: 'denied' }, 'denied'],
    [504, { status: 'owner-unreachable' }, 'owner-unreachable'],
  ] as const)('preserves HTTP %i as the distinct %s outcome', async (httpStatus, body, expectedStatus) => {
    globalThis.fetch = mockResponse({ status: httpStatus, body });

    const result = await makeClient().renameTerminal('pty_1', 'name');

    expect(result.status).toBe(expectedStatus);
  });

  it('rejects mismatched HTTP status and body status', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { status: 'denied' } });

    await expect(makeClient().renameTerminal('pty_1', 'name')).rejects.toThrow(/unexpected response/);
  });
});

describe('DaemonClient.listProgressFrames — GET /v1/logs', () => {
  it('filters GET /v1/logs to progress-frame events with a bounded limit', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { ok: true, logs: [], count: 0, ts: '2026-08-14T00:00:00.000Z' },
    });
    const client = makeClient({ token: 'tok-logs' });
    const result = await client.listProgressFrames(200);

    expect(String(calls[0]!.url)).toBe(
      'http://localhost:31415/v1/logs?event=headless.progress-frame&limit=200',
    );
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok-logs');
    expect(result.logs).toEqual([]);
  });
});

describe('DaemonClient.fetchTerminalScrollback — GET /v1/terminals/:id/scrollback', () => {
  it('default lines=50 hits /scrollback?lines=50', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: {
        id: 'pty_1',
        lines: 5,
        totalLines: 5,
        scrollback: 'line-1\nline-2\nline-3\nline-4\nline-5',
      },
    });
    const client = makeClient();
    const out = await client.fetchTerminalScrollback('pty_1');
    expect(out.lines).toBe(5);
    expect(out.scrollback).toContain('line-5');
    expect(String(calls[0]!.url)).toBe(
      'http://localhost:31415/v1/terminals/pty_1/scrollback?lines=50',
    );
  });

  it('custom lines forwarded', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { id: 'a', lines: 1, totalLines: 1, scrollback: 'x' },
    });
    const client = makeClient();
    await client.fetchTerminalScrollback('a', 200);
    expect(String(calls[0]!.url)).toContain('lines=200');
  });

  it('URL-encodes the id (path traversal-safe)', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { id: 'with space', lines: 0, totalLines: 0, scrollback: '' },
    });
    const client = makeClient();
    await client.fetchTerminalScrollback('with space', 50);
    expect(String(calls[0]!.url)).toContain('/v1/terminals/with%20space/scrollback');
  });

  it('forwards the selected row source root without changing the scrollback response', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { id: 'remote', lines: 1, totalLines: 1, scrollback: 'remote output' } });
    const client = makeClient();
    const result = await client.fetchTerminalScrollback('remote', 50, { sourceRoot: '/roots/remote/pty/manifest.db' });
    expect(result).toEqual({ id: 'remote', lines: 1, totalLines: 1, scrollback: 'remote output' });
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/terminals/remote/scrollback?lines=50&sourceRoot=%2Froots%2Fremote%2Fpty%2Fmanifest.db');
  });

  it('forwards bearer token to /v1/terminals routes', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { terminals: [] } });
    const client = makeClient({ token: 'tok-xyz' });
    await client.listTerminals();
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-xyz');
  });
});

describe('DaemonClient.fetchTerminalFrame — GET /v1/terminals/:id/frame', () => {
  it('forwards the selected row source root without changing the frame response', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { id: 'remote', frame: 'remote frame', frameAt: 1, frameSource: 'stored', kind: 'tui', instance: 'remote', remote: true } });
    const client = makeClient();
    const result = await client.fetchTerminalFrame('remote', { sourceRoot: '/roots/remote/pty/manifest.db' });
    expect(result).toEqual({ id: 'remote', frame: 'remote frame', frameAt: 1, frameSource: 'stored' });
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/terminals/remote/frame?sourceRoot=%2Froots%2Fremote%2Fpty%2Fmanifest.db');
  });
});

describe('DaemonClient.{getLlmHosts,setLlmHosts,clearLlmHosts} — §3.6 (FU.A3 #2118 GUI consumer)', () => {
  it('GET /v1/llm/hosts returns the parsed hosts response', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: {
        ok: true,
        source: 'legacy',
        count: 1,
        hosts: [{ name: 'local', kind: 'lm-studio', endpoint: 'http://localhost:1234' }],
      },
    });
    const client = makeClient();
    const r = await client.getLlmHosts();
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/llm/hosts');
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
    expect(r.source).toBe('legacy');
    expect(r.hosts).toHaveLength(1);
    expect(r.hosts[0]!.kind).toBe('lm-studio');
  });

  it('PUT /v1/llm/hosts forwards the host array as JSON body', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: {
        ok: true,
        source: 'override',
        count: 2,
        hosts: [
          { name: 'local', kind: 'lm-studio', endpoint: 'http://localhost:1234' },
          { name: 'anthropic', kind: 'anthropic-openai-wrap', endpoint: 'https://api.anthropic.com', apiKey: '[redacted]' },
        ],
      },
    });
    const client = makeClient();
    const r = await client.setLlmHosts([
      { name: 'local', kind: 'lm-studio', endpoint: 'http://localhost:1234' },
      { name: 'anthropic', kind: 'anthropic-openai-wrap', endpoint: 'https://api.anthropic.com', apiKey: 'sk-ant-test' },
    ]);
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/llm/hosts');
    expect(calls[0]!.init?.method).toBe('PUT');
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toHaveLength(2);
    expect(body[1].apiKey).toBe('sk-ant-test');
    expect(r.source).toBe('override');
    // GET-like response shape — apiKey is `[redacted]` after the round trip.
    expect(r.hosts[1]!.apiKey).toBe('[redacted]');
  });

  it('DELETE /v1/llm/hosts clears the override and returns env/legacy', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: {
        ok: true,
        cleared: true,
        source: 'legacy',
        count: 1,
        hosts: [{ name: 'local', kind: 'lm-studio', endpoint: 'http://localhost:1234' }],
      },
    });
    const client = makeClient();
    const r = await client.clearLlmHosts();
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/llm/hosts');
    expect(calls[0]!.init?.method).toBe('DELETE');
    expect(r.cleared).toBe(true);
    expect(r.source).toBe('legacy');
  });

  it('surfaces non-2xx as an Error so toast can render the daemon detail', async () => {
    globalThis.fetch = mockResponse({
      status: 400,
      body: { error: 'invalid-host', detail: 'kind must be one of …' },
    });
    const client = makeClient();
    await expect(client.setLlmHosts([])).rejects.toThrow(/invalid-host/);
  });
});

describe('DaemonClient.connectAcp lifecycle leases', () => {
  it('defers the last lease release until an in-flight prompt replies, then closes', async () => {
    const client = makeClient();
    const acp = client.connectAcp({ sessionId: 'stale' });
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(1, {});
    await Promise.resolve();
    await Promise.resolve();
    socket.respondError(2, 'unknown session');
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(3, { sessionId: 'issued' });
    expect(await acp.ready).toBe('issued');

    const reply = acp.send('session/prompt', { sessionId: 'issued', prompt: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ id: 4, method: 'session/prompt' });
    acp.close();
    expect(socket.closeCalls).toBe(0);
    expect(acp.state).not.toBe('CLOSED');
    socket.respond(4, { stopReason: 'end_turn' });
    expect(await reply).toEqual({ stopReason: 'end_turn' });
    await Promise.resolve();
    expect(socket.closeCalls).toBe(1);
  });

  it('closes immediately with no pending requests and keeps a deferred core if reacquired', async () => {
    const client = makeClient();
    const first = client.connectAcp({ sessionId: 'shared' });
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(1, {});
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(2, {});
    await first.ready;
    const reply = first.send('session/prompt', {});
    await Promise.resolve();
    await Promise.resolve();
    first.close();
    const second = client.connectAcp({ sessionId: 'shared' });
    expect(MockWebSocket.instances).toHaveLength(1);
    socket.respond(3, { stopReason: 'end_turn' });
    await reply;
    await Promise.resolve();
    expect(socket.closeCalls).toBe(0);
    second.close();
    expect(socket.closeCalls).toBe(1);
  });
  it('shares one connecting WebSocket, retains it after a pre-open release, and closes after the final open lease releases', () => {
    const client = makeClient();
    const first = client.connectAcp({ sessionId: 'shared-session' });
    const second = client.connectAcp({ sessionId: 'shared-session' });
    const socket = MockWebSocket.instances[0]!;

    expect(MockWebSocket.instances).toHaveLength(1);
    first.close();
    expect(socket.closeCalls).toBe(0);

    socket.open();
    second.close();
    expect(socket.closeCalls).toBe(1);
  });

  it('publishes failed state, removes a disposed state subscription, and blocks sends after failure', async () => {
    const client = makeClient();
    const acp = client.connectAcp({ sessionId: 'failed-session' });
    const socket = MockWebSocket.instances[0]!;
    const states: string[] = [];
    const off = acp.onState((state) => states.push(state));
    off();

    socket.fail();
    expect(acp.state).toBe('FAILED');
    expect(states).toEqual(['CONNECTING']);
    await expect(acp.send('terminal/input', { data: 'x' })).rejects.toThrow(/socket/i);
    expect(socket.sent).toHaveLength(0);
  });

  it('treats a remote close before handshake completion as FAILED, rejects readiness work, and evicts the shared transport', async () => {
    const client = makeClient();
    const acp = client.connectAcp({ sessionId: 'closed-before-ready' });
    const socket = MockWebSocket.instances[0]!;
    const states: string[] = [];
    acp.onState((state) => states.push(state));

    socket.finishClose(1006);

    await expect(acp.ready).resolves.toBe('');
    expect(acp.state).toBe('FAILED');
    expect(states).toEqual(['CONNECTING', 'FAILED']);
    await expect(acp.send('terminal/input', { data: 'x' })).rejects.toThrow('socket closed: 1006');

    const replacement = client.connectAcp({ sessionId: 'closed-before-ready' });
    expect(MockWebSocket.instances).toHaveLength(2);
    replacement.close();
  });

  it('includes a nonempty remote close reason in the fallback send error', async () => {
    const client = makeClient();
    const acp = client.connectAcp({ sessionId: 'close-reason' });
    const socket = MockWebSocket.instances[0]!;

    socket.finishClose(1008, 'auth_failed');

    await expect(acp.ready).resolves.toBe('');
    await expect(acp.send('terminal/input', { data: 'x' })).rejects.toThrow('socket closed: 1008: auth_failed');
    expect(socket.sent).toHaveLength(0);

    const replacement = client.connectAcp({ sessionId: 'closed-before-ready' });
    expect(MockWebSocket.instances).toHaveLength(2);
    replacement.close();
  });

  it('reports CLOSED only after a completed handshake later ends', async () => {
    const client = makeClient();
    const acp = client.connectAcp({ sessionId: 'closed-after-ready' });
    const socket = MockWebSocket.instances[0]!;

    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(1, {});
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(2, {});
    await expect(acp.ready).resolves.toBe('closed-after-ready');

    socket.finishClose();
    expect(acp.state).toBe('CLOSED');
    await expect(acp.send('terminal/input', { data: 'x' })).rejects.toThrow(/socket closed/i);
    expect(socket.sent).toHaveLength(2);
  });

  it('closes and evicts an open transport when initialize receives a JSON-RPC error', async () => {
    const client = makeClient();
    const acp = client.connectAcp({ sessionId: 'rpc-rejected' });
    const socket = MockWebSocket.instances[0]!;

    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent).toHaveLength(1);
    socket.respondError(1, 'initialize rejected');

    await expect(acp.ready).resolves.toBe('');
    expect(acp.state).toBe('FAILED');
    expect(socket.closeCalls).toBe(1);
    acp.close();
    socket.finishClose();

    const replacement = client.connectAcp({ sessionId: 'rpc-rejected' });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket.sent).toHaveLength(1);
    replacement.close();
  });

  it('evicts shared transports when URL or token configuration changes', () => {
    const client = makeClient({ token: 'old-token' });
    const first = client.connectAcp({ sessionId: 'reconfigured' });
    const firstSocket = MockWebSocket.instances[0]!;

    client.updateConfig({ baseUrl: 'http://localhost:31416', token: 'new-token', provider: 'anthropic' });
    expect(first.state).toBe('CLOSED');
    expect(firstSocket.closeCalls).toBe(1);

    const replacement = client.connectAcp({ sessionId: 'reconfigured' });
    expect(MockWebSocket.instances).toHaveLength(2);
    replacement.close();
    first.close();
  });

  it('uses only the latest same-method request handler and restores the prior handler after disposal', async () => {
    const client = makeClient();
    const first = client.connectAcp({ sessionId: 'request-handlers' });
    const second = client.connectAcp({ sessionId: 'request-handlers' });
    const socket = MockWebSocket.instances[0]!;
    const calls: string[] = [];
    const disposeFirst = first.onRequest('elanous/ask/request', () => {
      calls.push('first');
      return { owner: 'first' };
    });
    const disposeSecond = second.onRequest('elanous/ask/request', () => {
      calls.push('second');
      return { owner: 'second' };
    });

    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(1, {});
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(2, {});
    await first.ready;

    socket.request(99, 'elanous/ask/request', { question: 'first' });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['second']);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ id: 99, result: { owner: 'second' } });

    disposeSecond();
    socket.request(100, 'elanous/ask/request', { question: 'first-restored' });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['second', 'first']);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ id: 100, result: { owner: 'first' } });

    disposeFirst();
    socket.request(101, 'elanous/ask/request', { question: 'none' });
    await Promise.resolve();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ id: 101, error: { code: -32601 } });
    first.close();
    second.close();
  });

  it('rejects every registration API after lease close without leaving core handlers', async () => {
    const client = makeClient();
    const released = client.connectAcp({ sessionId: 'released-registration' });
    const active = client.connectAcp({ sessionId: 'released-registration' });
    const socket = MockWebSocket.instances[0]!;
    let calls = 0;

    released.close();
    released.on('sessionUpdate', () => { calls += 1; });
    released.onAny(() => { calls += 1; });
    released.onRequest('elanous/ask/request', () => { calls += 1; return {}; });
    released.onState(() => { calls += 1; });
    released.close();
    expect(calls).toBe(0);

    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(1, {});
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(2, {});
    await active.ready;

    socket.request(99, 'elanous/ask/request', {});
    await Promise.resolve();
    expect(calls).toBe(0);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ id: 99, error: { code: -32601 } });
    active.close();
  });

  it('drops an async responder error response when the socket closes before it settles', async () => {
    const client = makeClient();
    const acp = client.connectAcp({ sessionId: 'request-close-race' });
    const socket = MockWebSocket.instances[0]!;
    let rejectResponder!: (error: Error) => void;
    acp.onRequest('elanous/ask/request', () => new Promise((_resolve, reject) => { rejectResponder = reject; }));

    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(1, {});
    await Promise.resolve();
    await Promise.resolve();
    socket.respond(2, {});
    await acp.ready;

    socket.request(99, 'elanous/ask/request', {});
    socket.finishClose(1006);
    rejectResponder(new Error('responder failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(acp.state).toBe('CLOSED');
    expect(socket.sent).toHaveLength(2);
  });

  it('isolates throwing state consumers so terminal cleanup and other leases still complete', async () => {
    const client = makeClient();
    const first = client.connectAcp({ sessionId: 'throwing-state-consumer' });
    const second = client.connectAcp({ sessionId: 'throwing-state-consumer' });
    const socket = MockWebSocket.instances[0]!;
    const received: string[] = [];
    first.onState(() => { throw new Error('consumer failed'); });
    second.onState((state) => received.push(state));

    socket.fail();

    expect(first.state).toBe('FAILED');
    expect(second.state).toBe('FAILED');
    expect(received).toEqual(['CONNECTING', 'FAILED']);
    await expect(second.send('terminal/input', { data: 'x' })).rejects.toThrow(/socket/i);
    expect(socket.sent).toHaveLength(0);

    const replacement = client.connectAcp({ sessionId: 'throwing-state-consumer' });
    expect(MockWebSocket.instances).toHaveLength(2);
    replacement.close();
  });

  it('replaces a released CONNECTING core before its delayed close and retains the replacement after that close', () => {
    const client = makeClient();
    const first = client.connectAcp({ sessionId: 'replaceable' });
    const firstSocket = MockWebSocket.instances[0]!;

    first.close();
    expect(first.state).toBe('CLOSED');
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSING);

    const replacement = client.connectAcp({ sessionId: 'replaceable' });
    const replacementSocket = MockWebSocket.instances[1]!;
    expect(MockWebSocket.instances).toHaveLength(2);

    firstSocket.finishClose();
    const anotherLease = client.connectAcp({ sessionId: 'replaceable' });
    expect(MockWebSocket.instances).toHaveLength(2);

    replacement.close();
    anotherLease.close();
    expect(replacementSocket.closeCalls).toBe(1);
  });

  it('rejects handshake work immediately on error even when close is delayed', async () => {
    const client = makeClient();
    const acp = client.connectAcp({ sessionId: 'error-before-close' });
    const socket = MockWebSocket.instances[0]!;

    const ready = acp.ready;
    socket.open();
    await Promise.resolve();
    await Promise.resolve(); // initialize request is now pending.
    expect(socket.sent).toHaveLength(1);
    socket.error();

    await expect(ready).resolves.toBe('');
    expect(acp.state).toBe('FAILED');
    await expect(acp.send('terminal/input', { data: 'x' })).rejects.toThrow(/socket error/i);
    expect(socket.readyState).toBe(MockWebSocket.CLOSING);
    expect(socket.sent).toHaveLength(1);
  });

  it('cancels released connecting new-session transports before late opens can handshake', async () => {
    const client = makeClient();
    const first = client.connectAcp();
    const second = client.connectAcp();
    const [firstSocket, secondSocket] = MockWebSocket.instances;

    expect(MockWebSocket.instances).toHaveLength(2);
    first.close();
    second.close();
    expect(firstSocket!.closeCalls).toBe(1);
    expect(secondSocket!.closeCalls).toBe(1);

    firstSocket!.open();
    secondSocket!.open();
    await Promise.resolve();
    expect(first.state).toBe('CLOSED');
    expect(second.state).toBe('CLOSED');
    expect(firstSocket!.sent).toHaveLength(0);
    expect(secondSocket!.sent).toHaveLength(0);
  });
});
