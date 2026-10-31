import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { dispatchWebSearch as dispatchModelWebSearch } from '../skills/tools/web-search.js';
import { dispatchWebSearch as dispatchDaemonWebSearch } from '../boot/daemon-tools/web-search.js';
import { buildGrokWebSearchProvider } from './grok.js';
import { _resetWebSearchProvidersForTests, addWebSearchProvider, searchWeb } from './index.js';
import { wantsGrokSearch, wantsXSearch } from './x-intent.js';

const xQuery = { query: 'X에서 엘라누스 반응' };

afterEach(() => _resetWebSearchProvidersForTests(false));

describe('X search intent', () => {
  test('recognizes explicit X/Twitter requests without matching incidental x', () => {
    for (const query of ['X에서 엘라누스 반응', '엑스에서 반응', 'X 반응', '트위터 반응', '트윗 찾아줘', 'x.com/elanous/status/1', 'twitter', 'on X', 'X reactions']) {
      expect(wantsXSearch(query)).toBe(true);
    }
    for (const query of ['X축 그래프', '엑셀 xlsx', 'next index', 'Xcode 개발', '서울 날씨', 'examplex.com', 'twittering']) {
      expect(wantsXSearch(query)).toBe(false);
    }
    expect(wantsGrokSearch('반응형 웹 레이아웃')).toBe(false);
    expect(wantsGrokSearch('부작용 반응을 정리해줘')).toBe(false);
    expect(wantsGrokSearch('mx 반응')).toBe(false);
    expect(wantsGrokSearch('사용자 반응 분석')).toBe(false);
    expect(wantsGrokSearch('최신 모델 스펙')).toBe(false);
    expect(wantsGrokSearch('latest community reactions')).toBe(false);
    expect(wantsGrokSearch('chemical reactions of the compound')).toBe(false);
    expect(wantsGrokSearch('Hacker News community guidelines')).toBe(false);
    expect(wantsGrokSearch('community feedback about the release')).toBe(false);
    expect(wantsGrokSearch('market sentiment this week')).toBe(false);
    expect(wantsGrokSearch('X에서 최신 반응')).toBe(true);
  });

  test('routes explicit X requests to Grok and general queries through Exa/Firecrawl only', async () => {
    _resetWebSearchProvidersForTests(false);
    const calls: string[] = [];
    for (const id of ['exa', 'firecrawl', 'ddg', 'grok']) {
      addWebSearchProvider({
        id, displayName: id, available: () => true,
        search: async () => {
          calls.push(id);
          if (id === 'exa') throw new Error('offline');
          return { hits: [{ url: `https://${id}.example`, title: id, snippet: id }], providerName: id, durationMs: 1 };
        },
      });
    }
    expect(wantsGrokSearch('최신 반도체 여론')).toBe(false);
    expect(wantsGrokSearch('X에서 최신 반도체 여론')).toBe(true);
    expect((await searchWeb({ query: '반도체 공급망 구조' })).providerName).toBe('firecrawl');
    expect(calls).toEqual(['exa', 'firecrawl']);
    calls.length = 0;
    expect((await searchWeb({ query: '최신 반도체 여론' })).providerName).toBe('firecrawl');
    expect(calls).toEqual(['exa', 'firecrawl']);
    calls.length = 0;
    expect((await searchWeb({ query: 'X에서 최신 반도체 여론' })).providerName).toBe('grok');
    expect(calls).toEqual(['grok']);
  });

  test('explains when Grok is configured but ordinary search providers are unavailable', async () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider({ id: 'grok', displayName: 'grok', available: () => true,
      search: async () => ({ hits: [], providerName: 'grok', durationMs: 1 }) });
    await expect(searchWeb({ query: 'ordinary product architecture' })).rejects.toThrow(
      'Grok is reserved for explicit X/Twitter searches. Configure Exa or Firecrawl for general web search.',
    );
  });

  test('routes X intent to grok, ordinary query to first provider, and falls back when grok is unavailable', async () => {
    _resetWebSearchProvidersForTests(false);
    const calls: string[] = [];
    let grokAvailable = true;
    addWebSearchProvider({
      id: 'firecrawl', displayName: 'firecrawl fake', available: () => true,
      search: async () => {
        calls.push('firecrawl');
        return { hits: [{ url: 'https://example.org/news', title: 'News', snippet: '' }], providerName: 'firecrawl', durationMs: 0 };
      },
    });
    addWebSearchProvider({
      id: 'grok', displayName: 'grok fake', available: () => grokAvailable,
      search: async () => {
        calls.push('grok');
        return { hits: [{ url: 'https://x.com/elanous/status/1', title: 'X post', snippet: '', xSearchSource: true }], providerName: 'grok', durationMs: 0 };
      },
    });

    const xResult = await searchWeb(xQuery);
    expect(calls).toEqual(['grok']);
    expect(xResult.hits[0].url.startsWith('https://x.com/')).toBe(true);
    expect(xResult.xSearch).toBe('grok');
    expect(debug.events().at(-1)).toMatchObject({ category: 'web-search.route', event: 'x-intent', data: { provider: 'grok', xIntent: true, fallback: false } });
    expect(JSON.stringify(debug.events().at(-1))).not.toContain(xQuery.query);

    const weather = await searchWeb({ query: '서울 날씨' });
    expect(calls).toEqual(['grok', 'firecrawl']);
    expect(weather).not.toHaveProperty('xSearch');

    grokAvailable = false;
    const fallback = await searchWeb(xQuery);
    expect(calls).toEqual(['grok', 'firecrawl', 'firecrawl']);
    expect(fallback.xSearch).toBe('unavailable');
    expect(debug.events().at(-1)).toMatchObject({ category: 'web-search.route', event: 'x-intent', data: { provider: 'firecrawl', xIntent: true, fallback: true } });
    expect(JSON.stringify(debug.events().at(-1))).not.toContain(xQuery.query);

    const forced = await searchWeb(xQuery, { providerId: 'firecrawl' });
    expect(calls).toEqual(['grok', 'firecrawl', 'firecrawl', 'firecrawl']);
    expect(forced).not.toHaveProperty('xSearch');

    grokAvailable = true;
    const modelOutput = await dispatchModelWebSearch(xQuery);
    expect(modelOutput.output).toContain('https://x.com/elanous/status/1');
    expect(modelOutput.output).not.toContain('X search unavailable:');
    expect(calls.at(-1)).toBe('grok');
  });

  test('real grok adapter with web-only citations cannot claim X success; both model and daemon consumers see fallback', async () => {
    const oldKey = process.env.XAI_API_KEY;
    const oldKeep = process.env.ELANOUS_KEEP_ENV_KEYS;
    process.env.XAI_API_KEY = 'test-key';
    process.env.ELANOUS_KEEP_ENV_KEYS = '1';
    const requests: unknown[] = [];
    let searchCallType: 'web_search_call' | 'x_search_call' = 'web_search_call';
    let sourceUrl = 'https://example.org/news';
    let webSources: Array<{ url: string }> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ output: [
        ...(webSources.length ? [{ type: 'web_search_call', action: { sources: webSources } }] : []),
        { type: searchCallType, action: { sources: [{ url: sourceUrl, title: 'Source' }] } },
        { type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [] }] },
      ] }), { status: 200 });
    }) as typeof fetch);
    try {
      _resetWebSearchProvidersForTests(false);
      addWebSearchProvider({
        id: 'firecrawl', displayName: 'firecrawl fake', available: () => true,
        search: async () => ({ hits: [{ url: 'https://example.org/fallback', title: 'Fallback', snippet: '' }], providerName: 'firecrawl', durationMs: 0 }),
      });
      addWebSearchProvider(buildGrokWebSearchProvider());
      const result = await searchWeb(xQuery);
      expect(requests).toHaveLength(1);
      expect((requests[0] as { tools: Array<{ type: string }> }).tools).toEqual([{ type: 'web_search' }, { type: 'x_search' }]);
      expect(result.xSearch).toBe('unavailable');
      expect(result.providerName).toBe('grok');
      expect(result.hits.map(hit => hit.url)).toEqual(['https://example.org/news']);
      expect(result.hits[0].xSearchSource).not.toBe(true);
      expect(result.note).toBeUndefined();
      expect(JSON.stringify(debug.events().at(-1))).not.toContain(xQuery.query);
      expect(debug.events().at(-1)).toMatchObject({ category: 'web-search.route', event: 'x-intent', data: { provider: 'grok', xIntent: true, fallback: true } });
      expect((await dispatchModelWebSearch(xQuery)).output).toContain('X search unavailable:');
      const daemonResult = await dispatchDaemonWebSearch(xQuery, { cwd: process.cwd(), signal: new AbortController().signal });
      expect(daemonResult.xSearch).toBe('unavailable');
      expect(daemonResult.hits[0].url).toBe('https://example.org/news');
      sourceUrl = 'https://x.com/elanous/status/9';
      const webIndexedPost = await searchWeb(xQuery);
      expect(webIndexedPost.xSearch).toBe('unavailable');
      expect(webIndexedPost.hits).toEqual([]);
      searchCallType = 'x_search_call';
      webSources = [{ url: 'https://example.org/first' }];
      const verified = await searchWeb({ ...xQuery, limit: 1 });
      expect(verified.xSearch).toBe('grok');
      expect(verified.hits[0]).toMatchObject({ url: 'https://x.com/elanous/status/9', xSearchSource: true });
      expect((await dispatchModelWebSearch(xQuery)).output).toContain('https://x.com/elanous/status/9');
      const daemonVerified = await dispatchDaemonWebSearch(xQuery, { cwd: process.cwd(), signal: new AbortController().signal });
      expect(daemonVerified.xSearch).toBe('grok');
      expect(daemonVerified.hits[0].url).toBe('https://x.com/elanous/status/9');
    } finally {
      fetchSpy.mockRestore();
      if (oldKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = oldKey;
      if (oldKeep === undefined) delete process.env.ELANOUS_KEEP_ENV_KEYS;
      else process.env.ELANOUS_KEEP_ENV_KEYS = oldKeep;
    }
  });

  test('falls through to the original preference order if grok search fails', async () => {
    _resetWebSearchProvidersForTests(false);
    const calls: string[] = [];
    addWebSearchProvider({
      id: 'firecrawl', displayName: 'firecrawl fake', available: () => true,
      search: async () => {
        calls.push('firecrawl');
        return { hits: [], providerName: 'firecrawl', durationMs: 0 };
      },
    });
    addWebSearchProvider({
      id: 'grok', displayName: 'grok fake', available: () => true,
      search: async () => { calls.push('grok'); throw new Error('search failed'); },
    });
    const result = await searchWeb(xQuery);
    expect(calls).toEqual(['grok', 'firecrawl']);
    expect(result.xSearch).toBe('unavailable');
  });
});
