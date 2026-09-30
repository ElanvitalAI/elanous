// Service Worker Phase 4 — test the same classic script loaded by sw.js.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, runInNewContext } from 'node:vm';

interface StubResponse {
  ok: boolean;
  status: number;
  clone: () => StubResponse;
  body?: string;
}
interface StubCache {
  match: (req: string) => Promise<StubResponse | undefined>;
  put: (req: string, res: StubResponse) => Promise<void>;
}

function makeStubCache(seed: Record<string, StubResponse> = {}): StubCache {
  const store = new Map<string, StubResponse>(Object.entries(seed));
  return {
    match: async (req: string) => store.get(req),
    put: async (req: string, res: StubResponse) => {
      store.set(req, res);
    },
  };
}

function makeResponse(body: string, opts: { ok?: boolean; status?: number } = {}): StubResponse {
  const r: StubResponse = {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body,
    clone: () => r,
  };
  return r;
}

const runtime = 'runtime-cache';
const precache = 'precache';
const strategiesPath = new URL('../../public/sw-strategies.js', import.meta.url);
const source = readFileSync(strategiesPath, 'utf8');
const { cacheFirst, networkFirstWithOfflineFallback } = runInNewContext(
  `${source}\n({ cacheFirst, networkFirstWithOfflineFallback })`,
  { Response },
) as {
  cacheFirst: (
    request: string,
    caches: { open: (name: string) => Promise<StubCache> },
    doFetch: (req: string) => Promise<StubResponse>,
    runtimeCache: string,
  ) => Promise<StubResponse>;
  networkFirstWithOfflineFallback: (
    request: string,
    caches: { open: (name: string) => Promise<StubCache> },
    doFetch: (req: string) => Promise<StubResponse>,
    runtimeCache: string,
    precacheName: string,
  ) => Promise<StubResponse>;
};

function cacheStorage(runtimeCache: StubCache, offlineCache = makeStubCache()) {
  return {
    open: async (name: string) => {
      if (name === runtime) return runtimeCache;
      if (name === precache) return offlineCache;
      throw new Error(`unexpected cache: ${name}`);
    },
  };
}

test('sw.js loads the tested strategies and routes static/navigation requests without changing passthrough', async () => {
  const handlers = new Map<string, (event: any) => void>();
  const cache = makeStubCache();
  const offline = makeStubCache({ '/app/offline.html': makeResponse('offline-shell') });
  const storage = {
    open: async (name: string) => {
      if (name.includes('precache')) return offline;
      return cache;
    },
  };
  const seenScripts: string[] = [];
  const context = createContext({
    Response,
    URL,
    fetch: async () => { throw new Error('offline'); },
    self: {
      caches: storage,
      location: { origin: 'https://example.test' },
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    },
    importScripts: (name: string) => {
      seenScripts.push(name);
      runInContext(readFileSync(new URL(`../../public/${name}`, import.meta.url), 'utf8'), context);
    },
  });
  runInContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), context);
  expect(seenScripts).toEqual(['sw-strategies.js']);
  const onFetch = handlers.get('fetch');
  expect(onFetch).toBeDefined();
  async function dispatch(path: string, method = 'GET', mode = 'no-cors', accept = '', origin = 'https://example.test') {
    let response: Promise<StubResponse | Response> | undefined;
    onFetch!({
      request: {
        url: `${origin}${path}`, method, mode,
        headers: { get: () => accept },
      },
      respondWith: (value: Promise<StubResponse | Response>) => { response = value; },
    });
    return response;
  }
  expect((await dispatch('/app/_next/static/x.js'))?.status).toBe(504);
  expect((await dispatch('/app/fonts/x.woff2'))?.status).toBe(504);
  expect((await dispatch('/app/term', 'GET', 'navigate'))?.body).toBe('offline-shell');
  expect((await dispatch('/app/term', 'GET', 'no-cors', 'text/html'))?.body).toBe('offline-shell');
  expect(await dispatch('/v1/data')).toBeUndefined();
  expect(await dispatch('/app/term', 'PUT')).toBeUndefined();
  expect(await dispatch('/app/term', 'GET', 'navigate', '', 'https://other.test')).toBeUndefined();
  expect(await dispatch('/outside', 'GET', 'navigate')).toBeUndefined();
});

describe('cacheFirst', () => {
  test('returns cached entry without calling fetch', async () => {
    const cache = makeStubCache({ '/app/_next/static/x.js': makeResponse('cached') });
    let fetchCalls = 0;
    const r = await cacheFirst('/app/_next/static/x.js', cacheStorage(cache), async () => {
      fetchCalls += 1;
      return makeResponse('fresh');
    }, runtime);
    expect(r.body).toBe('cached');
    expect(fetchCalls).toBe(0);
  });

  test('falls through to network on cache miss + populates cache', async () => {
    const cache = makeStubCache();
    const r = await cacheFirst('/app/_next/static/y.js', cacheStorage(cache), async () =>
      makeResponse('fresh'), runtime,
    );
    expect(r.body).toBe('fresh');
    const second = await cache.match('/app/_next/static/y.js');
    expect(second?.body).toBe('fresh');
  });

  test('does not cache non-OK responses', async () => {
    const cache = makeStubCache();
    await cacheFirst('/app/_next/static/missing.js', cacheStorage(cache), async () =>
      makeResponse('Not Found', { ok: false, status: 404 }), runtime,
    );
    const cached = await cache.match('/app/_next/static/missing.js');
    expect(cached).toBeUndefined();
  });

  test('returns 504 stub when fetch throws and cache is empty', async () => {
    const cache = makeStubCache();
    const r = await cacheFirst('/app/_next/static/z.js', cacheStorage(cache), async () => {
      throw new Error('offline');
    }, runtime);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(504);
  });
});

describe('networkFirstWithOfflineFallback', () => {
  test('returns fresh response when network succeeds + populates runtime cache', async () => {
    const cache = makeStubCache();
    const r = await networkFirstWithOfflineFallback(
      '/app/term', cacheStorage(cache), async () => makeResponse('live'), runtime, precache,
    );
    expect(r.body).toBe('live');
    const cached = await cache.match('/app/term');
    expect(cached?.body).toBe('live');
  });

  test('falls back to runtime cache on network failure', async () => {
    const cache = makeStubCache({ '/app/term': makeResponse('stale') });
    const r = await networkFirstWithOfflineFallback(
      '/app/term', cacheStorage(cache), async () => { throw new Error('offline'); }, runtime, precache,
    );
    expect(r.body).toBe('stale');
  });

  test('falls back to precache offline.html when both fail', async () => {
    const cache = makeStubCache();
    const offline = makeStubCache({ '/app/offline.html': makeResponse('offline-shell') });
    const r = await networkFirstWithOfflineFallback(
      '/app/term', cacheStorage(cache, offline), async () => { throw new Error('offline'); }, runtime, precache,
    );
    expect(r.body).toBe('offline-shell');
  });

  test('returns 503 when network down, no cache, no offline shell', async () => {
    const cache = makeStubCache();
    const r = await networkFirstWithOfflineFallback(
      '/app/term', cacheStorage(cache), async () => { throw new Error('offline'); }, runtime, precache,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  test('does NOT cache non-OK responses', async () => {
    const cache = makeStubCache();
    await networkFirstWithOfflineFallback(
      '/app/term', cacheStorage(cache), async () => makeResponse('500', { ok: false, status: 500 }), runtime, precache,
    );
    const cached = await cache.match('/app/term');
    expect(cached).toBeUndefined();
  });
});
