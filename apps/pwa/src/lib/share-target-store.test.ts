// Service Worker Phase 2 — share-target store unit tests.
//
// Bun runtime doesn't ship the Cache Storage API natively, so the
// tests stub `caches` with a minimal in-memory shim. The shape of
// the shim mirrors the subset of the Cache API our store touches:
// `keys()`, `open(name)`, `match(url)`, `put(url, response)`,
// `delete(url)`. Anything more elaborate (varied options, request
// objects) would diverge from real browser behaviour without
// catching real regressions.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { acknowledgeSharedPayloadFiles, takeSharedPayload } from './share-target-store';

const realCaches = (globalThis as { caches?: unknown }).caches;

interface StubResponse {
  json: () => Promise<unknown>;
  blob: () => Promise<Blob>;
  text: () => Promise<string>;
}

interface StubCache {
  match: (url: string) => Promise<StubResponse | undefined>;
  put: (url: string, res: StubResponse) => Promise<void>;
  delete: (url: string) => Promise<boolean>;
}

interface StubCaches {
  open: (name: string) => Promise<StubCache>;
  keys: () => Promise<string[]>;
  delete: (name: string) => Promise<boolean>;
}

function createStubCaches(): {
  caches: StubCaches;
  inspect: (name: string) => Map<string, StubResponse> | null;
} {
  const buckets = new Map<string, Map<string, StubResponse>>();
  const stub: StubCaches = {
    keys: async () => Array.from(buckets.keys()),
    open: async (name: string) => {
      let bucket = buckets.get(name);
      if (!bucket) {
        bucket = new Map();
        buckets.set(name, bucket);
      }
      const cache: StubCache = {
        match: async (url: string) => bucket!.get(url),
        put: async (url: string, res: StubResponse) => {
          bucket!.set(url, res);
        },
        delete: async (url: string) => bucket!.delete(url),
      };
      return cache;
    },
    delete: async (name: string) => buckets.delete(name),
  };
  return {
    caches: stub,
    inspect: (name: string) => buckets.get(name) ?? null,
  };
}

function makeJsonResponse(body: unknown): StubResponse {
  return {
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)], { type: 'application/json' }),
    text: async () => JSON.stringify(body),
  };
}

function makeBlobResponse(blob: Blob): StubResponse {
  return {
    json: async () => null,
    blob: async () => blob,
    text: async () => '',
  };
}

let stubCaches: ReturnType<typeof createStubCaches>;

beforeEach(() => {
  stubCaches = createStubCaches();
  Object.defineProperty(globalThis, 'caches', {
    value: stubCaches.caches,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'caches', {
    value: realCaches,
    configurable: true,
    writable: true,
  });
});

describe('takeSharedPayload', () => {
  test('returns null for empty id', async () => {
    const r = await takeSharedPayload('');
    expect(r).toBe(null);
  });

  test('returns null when no Share Cache exists', async () => {
    const r = await takeSharedPayload('id-no-cache');
    expect(r).toBe(null);
  });

  test('returns null when manifest missing in Share Cache', async () => {
    const cacheName = 'elanous-pwa-share-target-v2';
    const cache = await stubCaches.caches.open(cacheName);
    // populate something else but not the manifest
    await cache.put(
      '/__share/other-id/0/foo.jpg',
      makeBlobResponse(new Blob(['x'], { type: 'image/jpeg' })),
    );
    const r = await takeSharedPayload('missing-id');
    expect(r).toBe(null);
  });

  test('reads manifest + files + drains them on success', async () => {
    const cacheName = 'elanous-pwa-share-target-v2';
    const cache = await stubCaches.caches.open(cacheName);
    const id = 'id-A';
    const manifest = {
      id,
      ts: 123,
      title: 'Photo',
      text: 'check this out',
      url: 'https://example.com/x',
      files: [
        {
          index: 0,
          cacheUrl: `/__share/${id}/0/cat.jpg`,
          filename: 'cat.jpg',
          type: 'image/jpeg',
          size: 100,
        },
        {
          index: 1,
          cacheUrl: `/__share/${id}/1/notes.txt`,
          filename: 'notes.txt',
          type: 'text/plain',
          size: 12,
        },
      ],
    };
    await cache.put(`/__share/${id}/manifest.json`, makeJsonResponse(manifest));
    await cache.put(
      manifest.files[0]!.cacheUrl,
      makeBlobResponse(new Blob([new Uint8Array(100)], { type: 'image/jpeg' })),
    );
    await cache.put(
      manifest.files[1]!.cacheUrl,
      makeBlobResponse(new Blob(['hello world\n'], { type: 'text/plain' })),
    );

    const payload = await takeSharedPayload(id);
    expect(payload).not.toBe(null);
    if (!payload) throw new Error('unreachable');
    expect(payload.id).toBe(id);
    expect(payload.title).toBe('Photo');
    expect(payload.text).toBe('check this out');
    expect(payload.url).toBe('https://example.com/x');
    expect(payload.files).toHaveLength(2);
    expect(payload.files[0]!.name).toBe('cat.jpg');
    expect(payload.files[0]!.type).toBe('image/jpeg');
    expect(payload.files[1]!.name).toBe('notes.txt');
    expect(payload.combinedText).toBe('Photo\n\ncheck this out\n\nhttps://example.com/x');

    // Drained — second take returns null.
    const second = await takeSharedPayload(id);
    expect(second).toBe(null);
  });

  test('partial acknowledgement keeps failed share files available for retry', async () => {
    const cache = await stubCaches.caches.open('elanous-pwa-share-target-v2');
    const id = 'id-partial';
    const firstKey = `/__share/${id}/0/ok.jpg`;
    const secondKey = `/__share/${id}/1/retry.jpg`;
    await cache.put(`/__share/${id}/manifest.json`, makeJsonResponse({
      id, ts: 1, title: '', text: '', url: '',
      files: [
        { index: ''.length, cacheUrl: firstKey, filename: 'ok.jpg', type: 'image/jpeg', size: 'x'.length },
        { index: 'x'.length, cacheUrl: secondKey, filename: 'retry.jpg', type: 'image/jpeg', size: 'x'.length },
      ],
    }));
    await cache.put(firstKey, makeBlobResponse(new Blob(['ok'], { type: 'image/jpeg' })));
    await cache.put(secondKey, makeBlobResponse(new Blob(['retry'], { type: 'image/jpeg' })));

    const first = await takeSharedPayload(id, { drain: false });
    expect(first?.files.map((file) => file.name)).toEqual(['ok.jpg', 'retry.jpg']);
    await acknowledgeSharedPayloadFiles(id, [first!.fileKeys[0]!]);
    const retry = await takeSharedPayload(id, { drain: false });
    expect(retry?.files.map((file) => file.name)).toEqual(['retry.jpg']);
  });

  test('skips file entries whose blob is missing from cache', async () => {
    const cacheName = 'elanous-pwa-share-target-v2';
    const cache = await stubCaches.caches.open(cacheName);
    const id = 'id-missing';
    const manifest = {
      id,
      ts: 123,
      title: '',
      text: '',
      url: '',
      files: [
        {
          index: 0,
          cacheUrl: `/__share/${id}/0/present.jpg`,
          filename: 'present.jpg',
          type: 'image/jpeg',
          size: 1,
        },
        {
          index: 1,
          cacheUrl: `/__share/${id}/1/missing.jpg`,
          filename: 'missing.jpg',
          type: 'image/jpeg',
          size: 1,
        },
      ],
    };
    await cache.put(`/__share/${id}/manifest.json`, makeJsonResponse(manifest));
    await cache.put(
      manifest.files[0]!.cacheUrl,
      makeBlobResponse(new Blob(['x'], { type: 'image/jpeg' })),
    );
    // intentionally omit files[1] from cache

    const payload = await takeSharedPayload(id);
    expect(payload).not.toBe(null);
    if (!payload) throw new Error('unreachable');
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.name).toBe('present.jpg');
  });

  test('combinedText omits empty parts', async () => {
    const cacheName = 'elanous-pwa-share-target-v2';
    const cache = await stubCaches.caches.open(cacheName);
    const id = 'id-empty';
    await cache.put(
      `/__share/${id}/manifest.json`,
      makeJsonResponse({
        id,
        ts: 1,
        title: 'only title',
        text: '',
        url: '',
        files: [],
      }),
    );
    const payload = await takeSharedPayload(id);
    if (!payload) throw new Error('unreachable');
    expect(payload.combinedText).toBe('only title');
  });

  test('selects most-recent matching cache name when multiple exist', async () => {
    // Sort-reverse picks `v3` over `v2` when both exist.
    const c1 = await stubCaches.caches.open('elanous-pwa-share-target-v2');
    const c2 = await stubCaches.caches.open('elanous-pwa-share-target-v3');
    await c1.put(
      `/__share/old/manifest.json`,
      makeJsonResponse({ id: 'old', ts: 0, title: 'OLD', text: '', url: '', files: [] }),
    );
    await c2.put(
      `/__share/new/manifest.json`,
      makeJsonResponse({ id: 'new', ts: 1, title: 'NEW', text: '', url: '', files: [] }),
    );
    const r = await takeSharedPayload('new');
    if (!r) throw new Error('unreachable');
    expect(r.title).toBe('NEW');
    // Old cache lookup by id `old` should still work via fallback —
    // but our scan picks the latest ONLY (v3). So `old` returns null
    // because v3 has no entry for it.
    const oldR = await takeSharedPayload('old');
    expect(oldR).toBe(null);
  });
});
