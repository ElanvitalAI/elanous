import { afterEach, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
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
