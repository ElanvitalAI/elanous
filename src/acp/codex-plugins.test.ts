// PLAN-codex-app-server-hermes-parity §5 Phase H2·1 test —
// parseCodexPluginsResponse filter logic + fetchCodexPlugins TTL cache.

import { describe, test, expect } from 'bun:test';
import {
  parseCodexPluginsResponse,
  fetchCodexPlugins,
  readCodexPluginsObservation,
  readCodexPluginsFromAppServer,
  clearCodexPluginsCache,
} from './codex-plugins.js';
import type { CodexAppServerClient } from './codex-app-server-client.js';

/** Mirrors the response a fresh `~/.codex/config.toml` with
 *  google-calendar / gmail / google-drive plugins enabled produces.
 *  Adds two negative cases (uninstalled · unavailable) so the filter
 *  is exercised end-to-end. */
const REAL_FIXTURE = {
  marketplaces: [
    {
      name: 'openai-curated',
      plugins: [
        { name: 'gmail', installed: true, availability: 'AVAILABLE', enabled: true },
        { name: 'google-calendar', installed: true, availability: 'AVAILABLE', enabled: true },
        { name: 'google-drive', installed: true, availability: 'AVAILABLE', enabled: true },
        { name: 'linear', installed: false, availability: 'AVAILABLE', enabled: true },
        { name: 'github', installed: true, availability: 'UNAVAILABLE', enabled: true },
      ],
    },
  ],
};

test('app-server probe initializes a live client and closes it, preserving unknown on failure', async () => {
  const methods: string[] = [];
  let closed = 0;
  let killed = 0;
  const client = {
    request: async (method: string) => { methods.push(method); return method === 'plugin/list' ? REAL_FIXTURE : {}; },
    close: async () => { closed++; },
  } as unknown as CodexAppServerClient;
  const spawn = (() => ({ client, child: { kill: () => { killed++; } } })) as unknown as Parameters<typeof readCodexPluginsFromAppServer>[0];
  const observed = await readCodexPluginsFromAppServer(spawn);
  expect(observed.status).toBe('ok');
  expect(observed.plugins.map(plugin => plugin.name)).toEqual(['gmail', 'google-calendar', 'google-drive']);
  expect(methods).toEqual(['initialize', 'plugin/list']);
  expect([closed, killed]).toEqual([1, 1]);
  expect(await readCodexPluginsFromAppServer(() => { throw new Error('no binary'); })).toEqual({ status: 'unknown', plugins: [] });
});

describe('parseCodexPluginsResponse', () => {
  test('filters installed + available plugins (real-world 3 plugin fixture)', () => {
    const out = parseCodexPluginsResponse(REAL_FIXTURE);
    expect(out).toEqual([
      { name: 'gmail', marketplace: 'openai-curated', enabled: true },
      { name: 'google-calendar', marketplace: 'openai-curated', enabled: true },
      { name: 'google-drive', marketplace: 'openai-curated', enabled: true },
    ]);
  });

  test('drops uninstalled plugins', () => {
    const out = parseCodexPluginsResponse({
      marketplaces: [
        {
          name: 'openai-curated',
          plugins: [
            { name: 'a', installed: false, availability: 'AVAILABLE' },
            { name: 'b', installed: true, availability: 'AVAILABLE' },
          ],
        },
      ],
    });
    expect(out.map((p) => p.name)).toEqual(['b']);
  });

  test('drops plugins with availability !== AVAILABLE', () => {
    const out = parseCodexPluginsResponse({
      marketplaces: [
        {
          name: 'openai-curated',
          plugins: [
            { name: 'a', installed: true, availability: 'UNAVAILABLE' },
            { name: 'b', installed: true, availability: 'available' }, // case-insensitive
            { name: 'c', installed: true }, // missing availability = treat as AVAILABLE (Hermes parity)
          ],
        },
      ],
    });
    expect(out.map((p) => p.name)).toEqual(['b', 'c']);
  });

  test('deduplicates by (name, marketplace)', () => {
    const out = parseCodexPluginsResponse({
      marketplaces: [
        {
          name: 'openai-curated',
          plugins: [
            { name: 'gmail', installed: true, availability: 'AVAILABLE' },
            { name: 'gmail', installed: true, availability: 'AVAILABLE' },
          ],
        },
        {
          name: 'community',
          plugins: [
            { name: 'gmail', installed: true, availability: 'AVAILABLE' },
          ],
        },
      ],
    });
    expect(out).toEqual([
      { name: 'gmail', marketplace: 'openai-curated', enabled: true },
      { name: 'gmail', marketplace: 'community', enabled: true },
    ]);
  });

  test('defaults enabled to true when missing', () => {
    const out = parseCodexPluginsResponse({
      marketplaces: [
        { name: 'm', plugins: [{ name: 'p', installed: true, availability: 'AVAILABLE' }] },
      ],
    });
    expect(out[0]!.enabled).toBe(true);
  });

  test('respects enabled=false', () => {
    const out = parseCodexPluginsResponse({
      marketplaces: [
        { name: 'm', plugins: [{ name: 'p', installed: true, availability: 'AVAILABLE', enabled: false }] },
      ],
    });
    expect(out[0]!.enabled).toBe(false);
  });

  test('defaults marketplace name to openai-curated when missing', () => {
    const out = parseCodexPluginsResponse({
      marketplaces: [
        { plugins: [{ name: 'p', installed: true, availability: 'AVAILABLE' }] },
      ],
    });
    expect(out[0]!.marketplace).toBe('openai-curated');
  });

  test('returns [] on malformed responses', () => {
    expect(parseCodexPluginsResponse(null)).toEqual([]);
    expect(parseCodexPluginsResponse(undefined)).toEqual([]);
    expect(parseCodexPluginsResponse('')).toEqual([]);
    expect(parseCodexPluginsResponse({})).toEqual([]);
    expect(parseCodexPluginsResponse({ marketplaces: 'not-an-array' })).toEqual([]);
    expect(parseCodexPluginsResponse({ marketplaces: [null, 'x', { plugins: 'not-array' }] })).toEqual([]);
  });

  test('drops plugins with empty name', () => {
    const out = parseCodexPluginsResponse({
      marketplaces: [
        { name: 'm', plugins: [{ name: '', installed: true, availability: 'AVAILABLE' }] },
      ],
    });
    expect(out).toEqual([]);
  });
});

/** Build a fake CodexAppServerClient where `request` returns a
 *  predefined response and counts invocations. Cast through unknown
 *  because we only need the `request` shape. */
function fakeClient(opts: {
  response?: unknown;
  throwError?: Error;
}): { client: CodexAppServerClient; calls: () => number } {
  let count = 0;
  const handle = {
    request: async () => {
      count += 1;
      if (opts.throwError) throw opts.throwError;
      return opts.response;
    },
  };
  return {
    client: handle as unknown as CodexAppServerClient,
    calls: () => count,
  };
}

describe('readCodexPluginsObservation', () => {
  test('distinguishes missing session and failed RPC from a successfully empty inventory', async () => {
    expect(await readCodexPluginsObservation(null)).toEqual({ status: 'unknown', plugins: [] });
    expect(await readCodexPluginsObservation(fakeClient({ throwError: new Error('disconnected') }).client)).toEqual({ status: 'unknown', plugins: [] });
    expect(await readCodexPluginsObservation(fakeClient({ response: { marketplaces: [] } }).client)).toEqual({ status: 'ok', plugins: [] });
    expect(await readCodexPluginsObservation(fakeClient({ response: {} }).client)).toEqual({ status: 'unknown', plugins: [] });
    // A damaged/changed RPC shape is unknown, not a confirmed empty install list.
    expect(await readCodexPluginsObservation(fakeClient({ response: { marketplaces: [{ name: 'm', plugins: 'x' }] } }).client)).toEqual({ status: 'unknown', plugins: [] });
    expect(await readCodexPluginsObservation(fakeClient({ response: { marketplaces: [{ plugins: [] }] } }).client)).toEqual({ status: 'unknown', plugins: [] });
    expect(await readCodexPluginsObservation(fakeClient({ response: { marketplaces: [null] } }).client)).toEqual({ status: 'unknown', plugins: [] });
    expect(await readCodexPluginsObservation(fakeClient({ response: { marketplaces: [{ name: 'm', plugins: [{ installed: true }] }] } }).client)).toEqual({ status: 'unknown', plugins: [] });
    const observed = await readCodexPluginsObservation(fakeClient({ response: REAL_FIXTURE }).client);
    expect(observed.status).toBe('ok');
    expect(observed.plugins.map(plugin => plugin.name)).toEqual(['gmail', 'google-calendar', 'google-drive']);
  });
});

describe('fetchCodexPlugins', () => {
  test('returns [] when client is null/undefined', async () => {
    expect(await fetchCodexPlugins(null)).toEqual([]);
    expect(await fetchCodexPlugins(undefined)).toEqual([]);
  });

  test('caches results within TTL', async () => {
    const { client, calls } = fakeClient({ response: REAL_FIXTURE });
    let clock = 1_000;
    const now = () => clock;

    const r1 = await fetchCodexPlugins(client, { now });
    expect(calls()).toBe(1);
    expect(r1).toHaveLength(3);

    clock = 1_000 + 100_000; // <5min
    const r2 = await fetchCodexPlugins(client, { now });
    expect(calls()).toBe(1); // cached — no extra RPC
    expect(r2).toBe(r1); // same reference

    clearCodexPluginsCache(client);
  });

  test('refetches after TTL expiry', async () => {
    const { client, calls } = fakeClient({ response: REAL_FIXTURE });
    let clock = 1_000;
    const now = () => clock;

    await fetchCodexPlugins(client, { now });
    expect(calls()).toBe(1);

    clock = 1_000 + 6 * 60 * 1000; // >5min
    await fetchCodexPlugins(client, { now });
    expect(calls()).toBe(2);

    clearCodexPluginsCache(client);
  });

  test('noCache forces a fresh RPC', async () => {
    const { client, calls } = fakeClient({ response: REAL_FIXTURE });
    await fetchCodexPlugins(client);
    expect(calls()).toBe(1);
    await fetchCodexPlugins(client, { noCache: true });
    expect(calls()).toBe(2);
    clearCodexPluginsCache(client);
  });

  test('soft-fails on RPC error — returns stale cache when available', async () => {
    const { client, calls } = fakeClient({ response: REAL_FIXTURE });
    let clock = 1_000;
    const now = () => clock;

    const r1 = await fetchCodexPlugins(client, { now });
    expect(r1).toHaveLength(3);

    // Force expiry + swap to throwing implementation by mutating the
    // fake handle. We can't easily swap the closure, so instead we
    // wrap a fresh client that throws — but the cache key is the
    // client ref, so a fresh client gets an empty cache. To exercise
    // the "stale cache" branch, mutate the existing client's request
    // function via Object.assign.
    Object.assign(client as object, {
      request: async () => {
        throw new Error('codex closed');
      },
    });

    clock = 1_000 + 100_000; // still within TTL — returns cached
    const r2 = await fetchCodexPlugins(client, { now });
    expect(r2).toEqual(r1);
    expect(calls()).toBe(1); // request wasn't called (cache hit)

    clock = 1_000 + 6 * 60 * 1000; // past TTL — request runs, throws, falls back to stale
    const r3 = await fetchCodexPlugins(client, { now });
    expect(r3).toEqual(r1); // still the stale cached value
    clearCodexPluginsCache(client);
  });

  test('returns [] when RPC throws and no cache exists', async () => {
    const { client } = fakeClient({ throwError: new Error('boom') });
    const r = await fetchCodexPlugins(client);
    expect(r).toEqual([]);
  });
});
