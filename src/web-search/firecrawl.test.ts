import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { STATIC_LEASE_COPY_FORMAT, staticLeaseCopyPath, staticLeaseMetaPath } from '../secret/static-lease-consumer.js';
import { isPaidWebSearchEnabled, setUserConfigOverlay } from '../user-config.js';
import { createResearchAxisSearcher } from '../research/axis-fanout.js';
import { buildFirecrawlWebSearchProvider } from './firecrawl.js';
import { webSearchProviderReady } from './provider.js';
import { _resetWebSearchProvidersForTests, addWebSearchProvider, listWebSearchProviders, searchWeb } from './index.js';

const secret = 'synthetic-firecrawl-only';
const source = { url: 'https://example.org/observed', title: 'Observed', description: 'Evidence snippet' };
const fakeFetch: typeof fetch = (async () => Response.json({ data: [source] })) as unknown as typeof fetch;
afterEach(() => { setUserConfigOverlay(null); _resetWebSearchProvidersForTests(); });

test('Firecrawl typed async slot works without env/config keys and never exposes its key', async () => {
  let slot = '';
  let keyUsed = '';
  const provider = buildFirecrawlWebSearchProvider(() => ({ apiKey: '' }), {
    keyLookup: async name => { slot = name; return secret; },
    fetch: (async (_url, init) => { keyUsed = new Headers(init?.headers).get('authorization') ?? ''; return Response.json({ data: [source] }); }) as typeof fetch,
  });
  expect(provider.available()).toBe(false);
  expect(await webSearchProviderReady(provider)).toBe(true);
  expect((await provider.search({ query: 'synthetic private query' })).hits).toHaveLength(1);
  expect(slot).toBe('cred:firecrawl.api_key');
  expect(keyUsed).toBe('Bearer ' + secret);
  expect(JSON.stringify(debug.events().slice(-5))).not.toContain(secret);
});

test('empty or rejected typed slots cannot silently fall back to another identity', async () => {
  let network = 0;
  for (const keyLookup of [async () => '', async (): Promise<string | undefined> => { throw new Error('synthetic store refused'); }]) {
    const provider = buildFirecrawlWebSearchProvider(() => ({ apiKey: 'synthetic-legacy' }), {
      keyLookup, fetch: (async () => { network++; return Response.json({ data: [] }); }) as unknown as typeof fetch,
    });
    expect(await webSearchProviderReady(provider)).toBe(false);
    await expect(provider.search({ query: 'synthetic' })).rejects.toThrow();
  }
  expect(network).toBe(0);
});

test('missing typed slot preserves read-only legacy config fallback', async () => {
  const provider = buildFirecrawlWebSearchProvider(() => ({ apiKey: secret }), { keyLookup: async () => undefined, fetch: fakeFetch });
  expect(await webSearchProviderReady(provider)).toBe(true);
  expect((await provider.search({ query: 'synthetic' })).hits[0]?.url).toBe(source.url);
});

test('ordinary search and research preflight admit async-store Firecrawl before keyless fallback', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  const provider = buildFirecrawlWebSearchProvider(() => ({ apiKey: '' }), {
    keyLookup: async () => secret,
    fetch: (async () => { calls.push('firecrawl'); return Response.json({ data: [source] }); }) as unknown as typeof fetch,
  });
  addWebSearchProvider(provider);
  addWebSearchProvider({ id: 'ddg-free', displayName: 'synthetic fallback', available: () => true,
    search: async () => { calls.push('ddg-free'); return { hits: [], providerName: 'ddg-free', durationMs: 0 }; } });
  expect((await searchWeb({ query: 'synthetic market evidence' })).providerName).toBe('firecrawl');
  const research = await createResearchAxisSearcher()('synthetic market evidence');
  expect((Array.isArray(research) ? research : research.hits)[0]?.url).toBe(source.url);
  expect(calls).toEqual(['firecrawl', 'firecrawl']);
  const preflight = [...debug.events()].reverse().find(event => event.category === 'web-search' && event.event === 'service-preflight');
  expect(JSON.stringify(preflight)).toContain('unmeasured');
  expect(JSON.stringify(preflight)).not.toContain(secret);
});

test('Firecrawl default preserves explicit opt-out and Grok API opt-in', () => {
  expect(isPaidWebSearchEnabled('firecrawl', { webSearch: {} })).toBe(true);
  expect(isPaidWebSearchEnabled('grokApi', { webSearch: {} })).toBe(false);
  expect(isPaidWebSearchEnabled('firecrawl', { webSearch: { firecrawl: { enabled: false } } })).toBe(false);
  setUserConfigOverlay(config => ({ ...config, webSearch: { firecrawl: { enabled: false } } }));
  _resetWebSearchProvidersForTests();
  expect(listWebSearchProviders().map(provider => provider.id)).not.toContain('firecrawl');
});

test('already cancelled readiness never reads the secret or starts a request', async () => {
  const controller = new AbortController(); controller.abort();
  let reads = 0;
  const provider = buildFirecrawlWebSearchProvider(() => ({ apiKey: '' }), {
    keyLookup: async () => { reads++; return secret; }, fetch: fakeFetch,
  });
  expect(await webSearchProviderReady(provider, controller.signal)).toBe(false);
  expect(reads).toBe(0);
});

test('isolated static lease copy alone makes Firecrawl ready, then expiry fails closed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'firecrawl-host-lease-'));
  const configDir = join(home, '.elanous');
  const cacheDir = join(home, '.cache');
  const cachePath = staticLeaseCopyPath(configDir, 'firecrawl_api_key');
  const metaPath = staticLeaseMetaPath(configDir, 'firecrawl_api_key');
  const oldCacheDir = process.env.ELANOUS_KEY_CACHE_DIR;
  const lease = (expiresAt: string) => ({
    format: STATIC_LEASE_COPY_FORMAT, leaseId: 'sl_fake_firecrawl', kind: 'static',
    id: 'firecrawl', cacheName: 'firecrawl_api_key', target: 'fake-host',
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt, copyPath: cachePath,
  });
  try {
    mkdirSync(cacheDir, { mode: 0o700 });
    mkdirSync(join(configDir, 'secrets-lease', 'meta'), { recursive: true, mode: 0o700 });
    mkdirSync(join(configDir, 'secrets-lease', 'copies'), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, secret + '\n', { mode: 0o600 });
    chmodSync(cachePath, 0o600);
    writeFileSync(metaPath, JSON.stringify(lease(new Date(Date.now() + 60_000).toISOString())), { mode: 0o600 });
    setElanousConfigDir(configDir);
    process.env.ELANOUS_KEY_CACHE_DIR = cacheDir;
    const provider = buildFirecrawlWebSearchProvider(() => ({ apiKey: '' }), { fetch: fakeFetch });
    expect(await webSearchProviderReady(provider)).toBe(true);
    expect((await provider.search({ query: 'fake market' })).hits).toHaveLength(1);
    _resetWebSearchProvidersForTests(false);
    let fallbackCalls = 0;
    addWebSearchProvider(provider);
    addWebSearchProvider({ id: 'ddg-free', displayName: 'synthetic fallback', available: () => true,
      search: async () => { fallbackCalls++; return { hits: [{ url: 'https://fallback.example', title: 'Fallback', snippet: 'Fallback' }], providerName: 'ddg-free', durationMs: 0 }; } });
    const researchSearch = createResearchAxisSearcher();
    const liveResult = await researchSearch('fake market');
    expect((Array.isArray(liveResult) ? liveResult : liveResult.hits)[0]?.engine).toBe('firecrawl');
    expect(fallbackCalls).toBe(0);

    chmodSync(cachePath, 0o644);
    expect(await webSearchProviderReady(provider)).toBe(false);
    chmodSync(cachePath, 0o600);
    chmodSync(metaPath, 0o644);
    expect(await webSearchProviderReady(provider)).toBe(false);
    chmodSync(metaPath, 0o600);
    const outside = join(home, 'other-key');
    writeFileSync(outside, secret, { mode: 0o600 });
    rmSync(cachePath);
    symlinkSync(outside, cachePath);
    expect(await webSearchProviderReady(provider)).toBe(false);
    rmSync(cachePath);
    writeFileSync(cachePath, secret + '\n', { mode: 0o600 });

    const secretsPath = join(configDir, 'secrets.json');
    writeFileSync(secretsPath, '{corrupt', { mode: 0o600 });
    expect(await webSearchProviderReady(provider)).toBe(false);
    await expect(provider.search({ query: 'fake market' })).rejects.toThrow('credential unavailable');
    rmSync(secretsPath);
    writeFileSync(metaPath, JSON.stringify({ ...lease(new Date(Date.now() + 60_000).toISOString()), id: 'other' }), { mode: 0o600 });
    expect(await webSearchProviderReady(provider)).toBe(false);

    writeFileSync(metaPath, JSON.stringify(lease(new Date(Date.now() - 1).toISOString())), { mode: 0o600 });
    const legacyProvider = buildFirecrawlWebSearchProvider(() => ({ apiKey: 'legacy-must-not-win' }), { fetch: fakeFetch });
    expect(await webSearchProviderReady(legacyProvider)).toBe(false);
    await expect(legacyProvider.search({ query: 'fake market' })).rejects.toThrow('credential unavailable');
    const expiredResult = await researchSearch('fake market');
    expect((Array.isArray(expiredResult) ? expiredResult : expiredResult.hits)[0]?.engine).toBe('ddg-free');
    expect(fallbackCalls).toBe(1);
    expect(JSON.stringify(debug.events().slice(-8))).not.toContain(secret);
  } finally {
    resetElanousConfigDir();
    if (oldCacheDir === undefined) delete process.env.ELANOUS_KEY_CACHE_DIR;
    else process.env.ELANOUS_KEY_CACHE_DIR = oldCacheDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test('host lease cache reaches Firecrawl readiness in an isolated fake HOME process', () => {
  const home = mkdtempSync(join(tmpdir(), 'firecrawl-host-process-'));
  const configDir = join(home, '.elanous');
  const cacheDir = join(home, '.cache');
  const cachePath = join(cacheDir, 'firecrawl_api_key');
  try {
    mkdirSync(cacheDir, { mode: 0o700 });
    mkdirSync(join(configDir, 'secrets-lease', 'meta'), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, secret + '\n', { mode: 0o600 });
    writeFileSync(staticLeaseMetaPath(configDir, 'firecrawl_api_key'), JSON.stringify({
      format: STATIC_LEASE_COPY_FORMAT, leaseId: 'sl_fake_host', kind: 'static',
      id: 'firecrawl', cacheName: 'firecrawl_api_key', target: 'fake-host',
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), copyPath: cachePath,
    }), { mode: 0o600 });
    const child = spawnSync(process.execPath, ['-e', [
      "import { homedir } from 'node:os'; import { join } from 'node:path'; import { readFileSync, writeFileSync } from 'node:fs';",
      "import { setElanousConfigDir } from './src/elanous-config-dir.ts';",
      "import { buildFirecrawlWebSearchProvider } from './src/web-search/firecrawl.ts';",
      "import { webSearchProviderReady } from './src/web-search/provider.ts';",
      "import { createResearchAxisSearcher } from './src/research/axis-fanout.ts';",
      "import { _resetWebSearchProvidersForTests, addWebSearchProvider } from './src/web-search/index.ts';",
      "const root = join(homedir(), '.elanous'); setElanousConfigDir(root);",
      "const provider = buildFirecrawlWebSearchProvider(() => ({ apiKey: '' }), { fetch: async () => Response.json({ data: [{ url: 'https://source.example', title: 'Source' }] }) });",
      "_resetWebSearchProvidersForTests(false); addWebSearchProvider(provider);",
      "addWebSearchProvider({ id: 'ddg-free', displayName: 'fallback', available: () => true, search: async () => ({ hits: [{ url: 'https://fallback.example', title: 'Fallback', snippet: '' }], providerName: 'ddg-free', durationMs: 0 }) });",
      "const search = createResearchAxisSearcher(); if (!(await webSearchProviderReady(provider))) process.exit(1);",
      "const live = await search('fake market'); if ((Array.isArray(live) ? live : live.hits)[0]?.engine !== 'firecrawl') process.exit(2);",
      "const metaPath = join(root, 'secrets-lease', 'meta', 'firecrawl_api_key.json'); const meta = JSON.parse(readFileSync(metaPath, 'utf8'));",
      "writeFileSync(metaPath, JSON.stringify({ ...meta, expiresAt: new Date(Date.now() - 1).toISOString() }));",
      "if (await webSearchProviderReady(provider)) process.exit(3);",
      "const expired = await search('fake market'); if ((Array.isArray(expired) ? expired : expired.hits)[0]?.engine !== 'ddg-free') process.exit(4);",
    ].join('\n')], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, ELANOUS_KEY_CACHE_DIR: cacheDir, FIRECRAWL_API_KEY: '' }, encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    expect(child.stdout + child.stderr).not.toContain(secret);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
