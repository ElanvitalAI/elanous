import { expect, test } from 'bun:test';
import { startFakeUpstageServer } from '../../../test/fixtures/fake-upstage-server.js';
import {
  createUpstageEmbeddingTransport, createUpstageEmbeddingsProvider,
  UPSTAGE_EMBEDDING_DIMENSIONS, UPSTAGE_EMBEDDING_MODELS, type UpstageEmbeddingTransportOptions,
} from './upstage-embeddings.js';

const key = 'fake-upstage-key'; // U-0 shared server's synthetic bearer, never a real credential.
const input = { input: 'synthetic retrieval text', consent: true };
const context = (value: unknown = input) => ({ graphId: 'upstage-embeddings', runId: 'shared-fake', nodeId: 'embed', input: value, outputs: {} });

test('U-0 fake /v1/embeddings returns deterministic vectors and receives distinct query/passage model IDs', async () => {
  const fake = await startFakeUpstageServer();
  const slots: string[] = [];
  try {
    const transport = createUpstageEmbeddingTransport({
      keyLookup: async slot => { slots.push(slot); return key; },
      env: { NODE_ENV: 'test', UPSTAGE_BASE_URL: fake.baseUrl, UPSTAGE_API_KEY: 'wrong-synthetic-env-key' },
    });
    const provider = createUpstageEmbeddingsProvider(transport);
    const query = await provider(context());
    const repeated = await provider(context());
    const passage = await provider(context({ ...input, purpose: 'passage' }));
    expect(query.ok && repeated.ok && passage.ok).toBe(true);
    const queryData = query.result as { embeddings: number[][]; model: string };
    expect(queryData.embeddings).toHaveLength(1);
    expect(queryData.embeddings[0]).toHaveLength(UPSTAGE_EMBEDDING_DIMENSIONS);
    expect(query.result).toEqual(repeated.result);
    expect(passage.result).toMatchObject({ model: UPSTAGE_EMBEDDING_MODELS.passage, purpose: 'passage' });
    expect(fake.requests.map(request => request.path)).toEqual(Array.from({ length: 3 }, () => '/v1/embeddings'));
    expect(fake.requests.map(request => JSON.parse(request.body).model)).toEqual([
      UPSTAGE_EMBEDDING_MODELS.query, UPSTAGE_EMBEDDING_MODELS.query, UPSTAGE_EMBEDDING_MODELS.passage,
    ]);
    expect(fake.requests.every(request => request.authorized)).toBe(true);
    expect(slots).toEqual(Array.from({ length: 3 }, () => 'cred:upstage.api_key'));
    expect(JSON.stringify([query, passage, fake.requests])).not.toContain(key);
    const before = fake.requests.length;
    expect((await provider(context({ ...input, model: 'embedding-query' }))).error).toContain(UPSTAGE_EMBEDDING_MODELS.query);
    expect(fake.requests).toHaveLength(before);
    expect(slots).toHaveLength(before);
  } finally { await fake.close(); }
});

test('env-only compatibility works with the same fake server and missing keys give setup guidance without HTTP', async () => {
  const fake = await startFakeUpstageServer();
  try {
    const env = { NODE_ENV: 'test', UPSTAGE_BASE_URL: fake.baseUrl, UPSTAGE_API_KEY: key };
    const envProvider = createUpstageEmbeddingsProvider(createUpstageEmbeddingTransport({ keyLookup: async () => undefined, env }));
    expect((await envProvider(context())).ok).toBe(true);
    const missing = createUpstageEmbeddingsProvider(createUpstageEmbeddingTransport({
      keyLookup: async () => undefined, env: { NODE_ENV: 'test', UPSTAGE_BASE_URL: fake.baseUrl },
    }));
    const result = await missing(context());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('eln secret slot setup upstage');
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(key);
  } finally { await fake.close(); }
});

test('production ignores a test base URL and the transport forbids redirect following', async () => {
  let endpoint = '';
  let redirect: RequestRedirect | undefined;
  const provider = createUpstageEmbeddingsProvider(createUpstageEmbeddingTransport({
    keyLookup: async () => key,
    env: { NODE_ENV: 'production', UPSTAGE_BASE_URL: 'http://127.0.0.1:1/v1' },
    fetchImpl: (async (url, options) => {
      endpoint = String(url); redirect = options?.redirect;
      return new Response('{}', { status: 302, headers: { location: 'https://redirect.invalid/' } });
    }) as NonNullable<UpstageEmbeddingTransportOptions['fetchImpl']>,
  }));
  expect((await provider(context())).ok).toBe(false);
  expect(endpoint).toBe('https://api.upstage.ai/v1/embeddings');
  expect(redirect).toBe('error');
});

test('non-loopback test overrides fail before key lookup or HTTP', async () => {
  let calls = 0;
  const provider = createUpstageEmbeddingsProvider(createUpstageEmbeddingTransport({
    keyLookup: async () => { calls++; return key; },
    env: { NODE_ENV: 'test', UPSTAGE_BASE_URL: 'https://outside.invalid/v1' },
    fetchImpl: (async () => { calls++; throw new Error('must not fetch'); }) as NonNullable<UpstageEmbeddingTransportOptions['fetchImpl']>,
  }));
  expect((await provider(context())).ok).toBe(false);
  expect(calls).toBe(0);
});

test('the overall deadline bounds stalled key lookup, fetch and response body', async () => {
  for (const phase of ['lookup', 'fetch', 'body'] as const) {
    let fetches = 0;
    let cancelled = false;
    const never = () => new Promise<never>(() => {});
    const provider = createUpstageEmbeddingsProvider(createUpstageEmbeddingTransport({
      // 출처: #35843 P4 synthetic deadline regression; 5ms is test-only, not a provider SLA.
      timeoutMs: 5, keyLookup: phase === 'lookup' ? never : async () => key, env: {},
      fetchImpl: (async () => {
        fetches++;
        if (phase === 'fetch') return never();
        return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }));
      }) as NonNullable<UpstageEmbeddingTransportOptions['fetchImpl']>,
    }));
    expect((await provider(context())).ok).toBe(false);
    expect(fetches).toBe(phase === 'lookup' ? 0 : 1);
    if (phase === 'body') expect(cancelled).toBe(true);
  }
});

test('streamed response byte limits cancel the body without exposing its contents', async () => {
  let cancelled = false;
  // 출처: #35843 P4 synthetic oversized-body regression; 64 bytes is test-only.
  const maxResponseBytes = 64;
  const provider = createUpstageEmbeddingsProvider(createUpstageEmbeddingTransport({
    maxResponseBytes, keyLookup: async () => key, env: {},
    fetchImpl: (async () => new Response(new ReadableStream({
      start: controller => { controller.enqueue(new Uint8Array(maxResponseBytes + 1)); },
      cancel: () => { cancelled = true; },
    }))) as NonNullable<UpstageEmbeddingTransportOptions['fetchImpl']>,
  }));
  const result = await provider(context());
  expect(result.ok).toBe(false);
  expect(cancelled).toBe(true);
  expect(JSON.stringify(result)).not.toContain(key);
});

test('untrusted lookup, fetch and JSON failures never expose credential values', async () => {
  const variants: UpstageEmbeddingTransportOptions[] = [
    { keyLookup: async () => { throw new Error(key); } },
    { keyLookup: async () => key, fetchImpl: (async () => { throw new Error(key); }) as NonNullable<UpstageEmbeddingTransportOptions['fetchImpl']> },
    { keyLookup: async () => key, fetchImpl: (async () => new Response(key)) as NonNullable<UpstageEmbeddingTransportOptions['fetchImpl']> },
  ];
  for (const variant of variants) {
    const provider = createUpstageEmbeddingsProvider(createUpstageEmbeddingTransport({ env: {}, ...variant }));
    const result = await provider(context());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
  }
});
