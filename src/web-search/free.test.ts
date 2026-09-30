import { afterEach, describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { buildWebSearchTool, dispatchWebSearch } from '../boot/daemon-tools/web-search.js';
import { ToolSafetyError } from '../boot/daemon-tools/types.js';
import { nativeToolCatalog } from '../native-tool-catalog.js';
import { buildFreeWebSearchProvider } from './free.js';
import {
  _resetWebSearchProvidersForTests,
  addWebSearchProvider,
  listWebSearchProviders,
  searchWeb,
  WebSearchUnavailableError,
} from './index.js';

const html = `
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst%3Fa%3D1%26b%3D2">First &amp; best</a>
<a class="result__snippet">Snippet <b>one</b></a></div>
<div class="result"><a class="result__a" href="https://example.org/second">Second</a>
<a class="result__snippet">Snippet two</a></div>
<div class="result"><a class="result__a" href="https://example.net/third">Third</a>
<a class="result__snippet">Snippet three</a></div>`;

const fakeFetch = (body: string, status = 200): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

const query = { query: 'private search terms' };

afterEach(() => _resetWebSearchProvidersForTests());

describe('keyless DuckDuckGo provider', () => {
  test('POST form, paired snippets, unwrapped URL and three hits; no query text in provider logs', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const provider = buildFreeWebSearchProvider({ fetch: (async (url, init) => {
      request = { url: String(url), init };
      return new Response(html);
    }) as typeof fetch });
    expect(provider.id).toBe('ddg-free');
    expect(provider.displayName).toBe('DuckDuckGo (keyless)');
    expect(provider.available()).toBe(true);
    const result = await provider.search(query);
    expect(result.providerName).toBe('ddg-free');
    expect(result.hits).toEqual([
      { url: 'https://example.com/first?a=1&b=2', title: 'First & best', snippet: 'Snippet one' },
      { url: 'https://example.org/second', title: 'Second', snippet: 'Snippet two' },
      { url: 'https://example.net/third', title: 'Third', snippet: 'Snippet three' },
    ]);
    expect(request?.url).toBe('https://html.duckduckgo.com/html/');
    expect(request?.init?.method).toBe('POST');
    expect(new URLSearchParams(String(request?.init?.body)).get('q')).toBe(query.query);
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal);
    const event = debug.events().at(-1);
    expect(event?.category).toBe('web-search.free');
    expect(event?.event).toBe('search');
    expect(event?.data).toMatchObject({ hits: 3, status: 200, queryLength: query.query.length });
    expect(JSON.stringify(event)).not.toContain(query.query);
  });

  test('preserves encoded path separators and literal percent signs inside unwrapped URLs', async () => {
    const original = 'https://example.com/a%2Fb?literal=100%&encoded=%25';
    const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(original)}`;
    const provider = buildFreeWebSearchProvider({ fetch: fakeFetch(
      `<div class="result"><a class="result__a" href="${wrapped}">Encoded</a><a class="result__snippet">URL</a></div>`,
    ) });
    expect((await provider.search(query)).hits[0].url).toBe(original);
  });

  test('keeps snippets inside their own result block when a middle result has none', async () => {
    const missing = `<div class="result"><a class="result__a" href="https://example.org/1">One</a><a class="result__snippet">First</a></div>
<div class="result"><a class="result__a" href="https://example.org/2">Two</a></div>
<div class="result"><a class="result__a" href="https://example.org/3">Three</a><a class="result__snippet">Third</a></div>`;
    const provider = buildFreeWebSearchProvider({ fetch: fakeFetch(missing) });
    expect((await provider.search(query)).hits.map(hit => hit.snippet)).toEqual(['First', '', 'Third']);
  });

  test('limit 2 truncates; limit above 20 caps at 20', async () => {
    const provider = buildFreeWebSearchProvider({ fetch: fakeFetch(html) });
    expect((await provider.search({ ...query, limit: 2 })).hits).toHaveLength(2);
    const many = Array.from({ length: 22 }, (_, i) =>
      `<a class="result__a" href="https://example.org/${i}">Title ${i}</a><a class="result__snippet">Snippet ${i}</a>`).join('');
    expect((await buildFreeWebSearchProvider({ fetch: fakeFetch(many) }).search({ ...query, limit: 50 })).hits).toHaveLength(20);
  });

  test('HTTP 503 and zero parsed results throw rather than returning empty hits', async () => {
    await expect(buildFreeWebSearchProvider({ fetch: fakeFetch('unavailable', 503) }).search(query)).rejects.toThrow('HTTP 503');
    expect(debug.events().at(-1)).toMatchObject({ category: 'web-search.free', event: 'failed', data: { status: 503, queryLength: query.query.length } });
    await expect(buildFreeWebSearchProvider({ fetch: fakeFetch('<html>no results</html>') }).search(query)).rejects.toThrow('No DuckDuckGo results parsed');
    expect(debug.events().at(-1)).toMatchObject({ category: 'web-search.free', event: 'failed', data: { reason: 'request-or-parse-failed' } });
    expect(JSON.stringify(debug.events().slice(-2))).not.toContain(query.query);
  });

  test('registry puts builtin ddg-free last and cascades from unavailable providers to injected fetch', async () => {
    _resetWebSearchProvidersForTests();
    const builtins = listWebSearchProviders();
    expect(builtins.at(-1)).toMatchObject({ id: 'ddg-free', available: true });
    expect(builtins.slice(0, -1).map(p => p.id)).toEqual(builtins.some(p => p.id === 'tavily')
      ? ['tavily', 'grok', 'firecrawl'] : ['grok', 'firecrawl']);

    _resetWebSearchProvidersForTests(false);
    for (const id of ['tavily', 'grok', 'firecrawl']) {
      addWebSearchProvider({ id, displayName: id, available: () => false, search: async () => { throw new Error('should not run'); } });
    }
    addWebSearchProvider(buildFreeWebSearchProvider({ fetch: fakeFetch(html) }));
    expect(listWebSearchProviders().at(-1)).toMatchObject({ id: 'ddg-free', available: true });
    const result = await searchWeb(query);
    expect(result.providerName).toBe('ddg-free');
    expect(result.hits).toHaveLength(3);
  });

  test('registry preserves preferred providers ahead of keyless fallback', async () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider({ id: 'grok', displayName: 'grok', available: () => true, search: async () => ({
      providerName: 'grok', hits: [{ url: 'https://grok.example/', title: 'Grok', snippet: '' }], durationMs: 0,
    }) });
    addWebSearchProvider(buildFreeWebSearchProvider({ fetch: (async () => { throw new Error('DDG should not run'); }) as unknown as typeof fetch }));
    expect((await searchWeb(query)).providerName).toBe('grok');
  });

  test('registry exhausts with WebSearchUnavailableError on DDG HTTP 503', async () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider({ id: 'grok', displayName: 'grok', available: () => false, search: async () => { throw new Error('should not run'); } });
    addWebSearchProvider(buildFreeWebSearchProvider({ fetch: fakeFetch('unavailable', 503) }));
    await expect(searchWeb(query)).rejects.toBeInstanceOf(WebSearchUnavailableError);
  });

  test('daemon dispatch uses the same keyless registry and keeps its result shape and unavailable mapping', async () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider({ id: 'grok', displayName: 'grok', available: () => false, search: async () => { throw new Error('should not run'); } });
    addWebSearchProvider(buildFreeWebSearchProvider({ fetch: fakeFetch(html) }));
    const ctx = { cwd: process.cwd(), signal: new AbortController().signal };
    expect(await dispatchWebSearch({ query: query.query, limit: 2 }, ctx)).toEqual({
      query: query.query, providerName: 'ddg-free', numHits: 2, hits: [
        { url: 'https://example.com/first?a=1&b=2', title: 'First & best', snippet: 'Snippet one' },
        { url: 'https://example.org/second', title: 'Second', snippet: 'Snippet two' },
      ],
    });
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider(buildFreeWebSearchProvider({ fetch: fakeFetch('unavailable', 503) }));
    await expect(dispatchWebSearch({ query: query.query }, ctx)).rejects.toMatchObject({
      name: ToolSafetyError.name, kind: 'unavailable',
    });
  });

  test('both model-facing descriptions advertise keyless DuckDuckGo fallback', () => {
    expect(buildWebSearchTool().description).toContain('keyless DuckDuckGo');
    const entry = nativeToolCatalog.find(tool => tool.id === 'web_search');
    expect(entry?.description).toContain('keyless DuckDuckGo');
    expect(entry?.promptSummary).toContain('keyless DuckDuckGo');
  });
});
