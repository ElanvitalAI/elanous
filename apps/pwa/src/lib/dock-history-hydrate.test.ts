import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DaemonClient } from './daemon-client';
import {
  __INTERNAL_HISTORY_TAIL_LIMIT,
  extractMessageText,
  fetchDockHistory,
  mapServerHistoryToChat,
  mapServerMessageToChat,
} from './dock-history-hydrate';

describe('extractMessageText', () => {
  it('passes plain strings through', () => {
    expect(extractMessageText('hello world')).toBe('hello world');
  });

  it('flattens text content blocks with newline separator', () => {
    const blocks = [
      { type: 'text', text: 'first line' },
      { type: 'text', text: 'second line' },
    ];
    expect(extractMessageText(blocks)).toBe('first line\nsecond line');
  });

  it('replaces image / audio blocks with paperclip glyph', () => {
    const blocks = [
      { type: 'text', text: 'caption' },
      { type: 'image', mediaType: 'image/png', base64: 'xxx' },
      { type: 'audio', mediaType: 'audio/wav', base64: 'yyy' },
    ];
    expect(extractMessageText(blocks)).toBe('caption\n📎 image\n📎 audio');
  });

  it('replaces tool_use / tool_result with wrench glyph + name', () => {
    const blocks = [
      { type: 'tool_use', id: 't1', name: 'WebTerminalScreenshot', input: {} },
      { type: 'tool_result', tool_use_id: 't1', content: '...' },
    ];
    expect(extractMessageText(blocks)).toBe('🛠️ WebTerminalScreenshot\n🛠️ result');
  });

  it('falls back to "tool" when tool_use has no name', () => {
    const blocks = [{ type: 'tool_use', id: 't1' }];
    expect(extractMessageText(blocks)).toBe('🛠️ tool');
  });

  it('returns empty for null / undefined / non-array', () => {
    expect(extractMessageText(null)).toBe('');
    expect(extractMessageText(undefined)).toBe('');
    expect(extractMessageText(42)).toBe('');
  });
});

describe('mapServerMessageToChat', () => {
  it('maps user role to a user message with hydrate id', () => {
    const m = mapServerMessageToChat({ role: 'user', content: 'hi' }, 0);
    expect(m).not.toBeNull();
    expect(m!.role).toBe('user');
    expect(m!.text).toBe('hi');
    expect(m!.id).toBe('hydrate-u-0');
  });

  it('maps assistant role with provider=history meta', () => {
    const m = mapServerMessageToChat({ role: 'assistant', content: 'response' }, 1);
    expect(m).not.toBeNull();
    expect(m!.role).toBe('assistant');
    expect(m!.text).toBe('response');
    expect(m!.id).toBe('hydrate-a-1');
    expect(m!.meta?.provider).toBe('history');
  });

  it('drops system role to keep dock UI clean', () => {
    expect(mapServerMessageToChat({ role: 'system', content: 'You are…' }, 0)).toBeNull();
  });

  it('drops empty-text messages to avoid blank rows', () => {
    expect(mapServerMessageToChat({ role: 'user', content: '' }, 0)).toBeNull();
    expect(mapServerMessageToChat({ role: 'assistant', content: [] }, 0)).toBeNull();
  });

  it('routes unknown roles to a meta line (preserves visibility)', () => {
    const m = mapServerMessageToChat({ role: 'developer', content: 'side-effect' }, 5);
    expect(m).not.toBeNull();
    expect(m!.role).toBe('meta');
    expect(m!.text).toBe('side-effect');
  });
});

describe('mapServerHistoryToChat', () => {
  it('preserves the order of mapped messages', () => {
    const result = mapServerHistoryToChat([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(result.map((m) => m.text)).toEqual(['q1', 'a1', 'q2']);
  });

  it('skips system messages and empty rows', () => {
    const result = mapServerHistoryToChat([
      { role: 'system', content: 'You are…' },
      { role: 'user', content: '' },
      { role: 'user', content: 'q1' },
    ]);
    expect(result.map((m) => m.role)).toEqual(['user']);
  });

  it('caps the tail to HISTORY_TAIL_LIMIT for very long sessions', () => {
    const long = Array.from({ length: __INTERNAL_HISTORY_TAIL_LIMIT + 50 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }));
    const result = mapServerHistoryToChat(long);
    expect(result.length).toBe(__INTERNAL_HISTORY_TAIL_LIMIT);
    // First retained message should be at offset 50 (oldest 50 dropped)
    expect(result[0]!.text).toBe('m50');
  });
});

// 엔드포인트 계약 — P4(2026-07-12) 이후 on-disk store `GET /v1/sessions/store/:id`
// 소비 (구 in-memory /v1/sessions/:id 에서 이관). fetch mock 으로 200 mapping +
// 503/404/network silent null 검증.

interface FetchCall { url: string | URL }

const realFetch = globalThis.fetch;
let httpCalls: FetchCall[] = [];

function mockResponse(opts: { status: number; body: unknown }): typeof fetch {
  return ((async (input: RequestInfo | URL) => {
    httpCalls.push({ url: input as string | URL });
    return {
      ok: opts.status >= 200 && opts.status < 300,
      status: opts.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => opts.body,
      text: async () => JSON.stringify(opts.body),
    } as unknown as Response;
  }) as unknown) as typeof fetch;
}

function makeClient(): DaemonClient {
  return new DaemonClient({
    baseUrl: 'http://localhost:31415',
    token: '',
    provider: 'anthropic',
  });
}

describe('fetchDockHistory — NEXUS T3 endpoint contract', () => {
  beforeEach(() => { httpCalls = []; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('issues a GET to /v1/sessions/store/:id with the session id encoded', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { ok: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    const result = await fetchDockHistory(makeClient(), 's-1');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(String(httpCalls[0]!.url)).toBe('http://localhost:31415/v1/sessions/store/s-1?ifExists=1');
  });

  it('folds store tool rows into a compact 🛠️ meta line (P4)', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: {
        ok: true,
        messages: [
          { role: 'user', content: 'run it' },
          { role: 'tool', toolName: 'Bash', content: 'very long breadcrumb output…' },
        ],
      },
    });
    const result = await fetchDockHistory(makeClient(), 's-1');
    expect(result!.length).toBe(2);
    expect(result![1]!.text).toBe('🛠️ Bash');
  });

  it('returns null silently when the daemon returns 404 unknown_session', async () => {
    globalThis.fetch = mockResponse({
      status: 404,
      body: { error: 'unknown_session', sessionId: 's-fresh' },
    });
    const result = await fetchDockHistory(makeClient(), 's-fresh');
    expect(result).toBeNull();
  });

  it('returns null silently when NEXUS PR k 이전 상태 (503 not-wired)', async () => {
    globalThis.fetch = mockResponse({
      status: 503,
      body: { error: 'meta-api-runtime-not-wired' },
    });
    const result = await fetchDockHistory(makeClient(), 's-1');
    expect(result).toBeNull();
  });

  it('returns null on a network failure rather than throwing', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const result = await fetchDockHistory(makeClient(), 's-1');
    expect(result).toBeNull();
  });

  it('returns null when the response body is missing the messages array', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { sessionId: 's-1' },
    });
    const result = await fetchDockHistory(makeClient(), 's-1');
    expect(result).toBeNull();
  });

  it('skips the fetch entirely on an empty sessionId', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { sessionId: '', messages: [] } });
    const result = await fetchDockHistory(makeClient(), '');
    expect(result).toBeNull();
    expect(httpCalls.length).toBe(0);
  });

  it('encodes path segments with /', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { messages: [] } });
    await fetchDockHistory(makeClient(), 'a/b');
    expect(String(httpCalls[0]!.url)).toBe('http://localhost:31415/v1/sessions/store/a%2Fb?ifExists=1');
  });
});
