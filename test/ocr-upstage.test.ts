// Upstage OCR module — covers the API key resolver chain + the
// fetch round-trip shape (mocked). Live API call against
// https://api.upstage.ai is gated by env (UPSTAGE_API_KEY required)
// and skipped when absent so CI stays hermetic.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  resolveUpstageApiKey,
  runUpstageOcr,
  type UpstageOcrResult,
} from '../src/ocr/upstage.js';

// Bun's `typeof fetch` includes a `preconnect` method. Test fakes
// only need the call signature, so cast through unknown.
type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;
const asFetch = (fn: FetchLike) => fn as unknown as typeof fetch;

describe('resolveUpstageApiKey · fallback chain', () => {
  let savedEnv: string | undefined;
  beforeEach(() => { savedEnv = process.env.UPSTAGE_API_KEY; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = savedEnv;
  });

  test('env-set returns immediately', () => {
    process.env.UPSTAGE_API_KEY = '  test-key  ';
    expect(resolveUpstageApiKey()).toBe('test-key');
  });

  test('blank env triggers fallback (cache or shell or null)', () => {
    process.env.UPSTAGE_API_KEY = '   ';
    const result = resolveUpstageApiKey();
    if (result !== null) {
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe('runUpstageOcr · fetch contract (mocked)', () => {
  test('auth failure when resolver returns null', async () => {
    const res = await runUpstageOcr({
      file: new Uint8Array([0x89, 0x50]),
      filename: 'x.png',
      resolveApiKey: () => null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stage).toBe('auth');
  });

  test('happy path · default = document-parse · markdown/html surfaced', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = asFetch(async (input, init) => {
      captured = { url: String(input), init: init as RequestInit };
      return new Response(
        JSON.stringify({
          content: {
            markdown: '# Title\n\n- item 1\n- item 2',
            html: '<h1>Title</h1>',
            text: 'Title item 1 item 2',
          },
          pages: [{ index: 0 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const res: UpstageOcrResult = await runUpstageOcr({
      file: new Uint8Array([0x89]),
      filename: 'memo.jpg',
      mimeType: 'image/jpeg',
      apiKey: 'fake-key',
      fetchImpl: fakeFetch,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.markdown).toBe('# Title\n\n- item 1\n- item 2');
      expect(res.html).toBe('<h1>Title</h1>');
      expect(res.text).toBe('Title item 1 item 2');
      expect((res.raw as { pages: unknown }).pages).toEqual([{ index: 0 }]);
    }
    expect(captured!.url).toBe('https://api.upstage.ai/v1/document-digitization');
    const body = captured!.init.body;
    expect(body).toBeInstanceOf(FormData);
    if (body instanceof FormData) {
      expect(body.get('model')).toBe('document-parse');
    }
  });

  test('ocr model · top-level text · empty markdown/html', async () => {
    const fakeFetch = asFetch(async () => new Response(
      JSON.stringify({ text: 'raw OCR text', pages: [{ words: [] }] }),
      { status: 200 },
    ));
    const res = await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'x.png',
      apiKey: 'k',
      model: 'ocr',
      fetchImpl: fakeFetch,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toBe('raw OCR text');
      expect(res.markdown).toBe('');
      expect(res.html).toBe('');
    }
  });

  test('parseMode forwarded only for document-parse', async () => {
    const seen: { mode: string | null; model: string | null } = { mode: null, model: null };
    const fakeFetch = asFetch(async (_url, init) => {
      const body = (init as RequestInit).body;
      if (body instanceof FormData) {
        const md = body.get('mode');
        const mdl = body.get('model');
        seen.mode = typeof md === 'string' ? md : null;
        seen.model = typeof mdl === 'string' ? mdl : null;
      }
      return new Response(JSON.stringify({ text: '' }), { status: 200 });
    });
    // document-parse + enhanced → mode field set
    await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'x.png',
      apiKey: 'k',
      parseMode: 'enhanced',
      fetchImpl: fakeFetch,
    });
    expect(seen.model).toBe('document-parse');
    expect(seen.mode).toBe('enhanced');
    // ocr + parseMode → mode field NOT set (Upstage rejects it)
    seen.mode = null;
    await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'x.png',
      apiKey: 'k',
      model: 'ocr',
      parseMode: 'enhanced',
      fetchImpl: fakeFetch,
    });
    expect(seen.model).toBe('ocr');
    expect(seen.mode).toBeNull();
  });

  test('useAsync flips endpoint to /async', async () => {
    const seen: { url: string | null } = { url: null };
    const fakeFetch = asFetch(async (input) => {
      seen.url = String(input);
      return new Response(JSON.stringify({ text: '' }), { status: 200 });
    });
    await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'big.pdf',
      apiKey: 'k',
      useAsync: true,
      fetchImpl: fakeFetch,
    });
    expect(seen.url).toBe('https://api.upstage.ai/v1/document-digitization/async');
  });

  test('http error surfaces stage=http with status', async () => {
    const sensitive = 'synthetic-private-value';
    const fakeFetch = asFetch(async () => new Response(
      `rate limited ${sensitive}`,
      { status: 429, headers: { 'content-type': 'text/plain' } },
    ));
    const res = await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'x.png',
      apiKey: 'k',
      fetchImpl: fakeFetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe('http');
      expect(res.status).toBe(429);
      expect(res.message).toBe('Upstage OCR HTTP 429');
      expect(JSON.stringify(res)).not.toContain(sensitive);
    }
  });

  test('network failure surfaces stage=network', async () => {
    const sensitive = 'synthetic-private-value';
    const fakeFetch = asFetch(async () => {
      throw new TypeError(`connection refused ${sensitive}`);
    });
    const res = await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'x.png',
      apiKey: 'k',
      fetchImpl: fakeFetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe('network');
      expect(res.message).toBe('Upstage OCR network request failed');
      expect(JSON.stringify(res)).not.toContain(sensitive);
    }
  });

  test('non-JSON response surfaces stage=parse', async () => {
    const sensitive = 'synthetic-private-value';
    const fakeFetch = asFetch(async () => new Response(
      `not json{ ${sensitive}`,
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const res = await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'x.png',
      apiKey: 'k',
      fetchImpl: fakeFetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe('parse');
      expect(res.message).toBe('Upstage OCR returned invalid JSON');
      expect(JSON.stringify(res)).not.toContain(sensitive);
    }
  });

  test('default model + override', async () => {
    const seen: { model: string | null } = { model: null };
    const fakeFetch = asFetch(async (_url, init) => {
      const body = (init as RequestInit).body;
      if (body instanceof FormData) {
        const v = body.get('model');
        seen.model = typeof v === 'string' ? v : null;
      }
      return new Response(JSON.stringify({ text: '' }), { status: 200 });
    });
    await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'x.png',
      apiKey: 'k',
      fetchImpl: fakeFetch,
    });
    expect(seen.model).toBe('document-parse'); // new default

    await runUpstageOcr({
      file: new Uint8Array([0]),
      filename: 'x.png',
      apiKey: 'k',
      model: 'ocr',
      fetchImpl: fakeFetch,
    });
    expect(seen.model).toBe('ocr');
  });
});
