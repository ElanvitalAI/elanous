import { afterEach, expect, spyOn, test } from 'bun:test';
import { addWebSearchProvider, _resetWebSearchProvidersForTests, type WebSearchProvider } from '../../web-search/index.js';
import { buildExaWebSearchProvider } from '../../web-search/exa.js';
import { dispatchOmniSearch, dispatchResearchOmniSearch, getAvailableResearchSearchEngineIds, omniSearchAvailable, researchOmniSearchAvailable } from './omni-search.js';

function provider(id: string, search: WebSearchProvider['search']): WebSearchProvider {
  return { id, displayName: id, available: () => true, search };
}

afterEach(() => _resetWebSearchProvidersForTests());

test('research dispatch selects Exa and Firecrawl, excluding Grok, Tavily and DDG', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  for (const id of ['grok', 'grok-api', 'exa', 'firecrawl', 'tavily', 'ddg']) {
    addWebSearchProvider(provider(id, async () => {
      calls.push(id);
      return { providerName: id, durationMs: 1, hits: [{ url: `https://${id}.example`, title: id, snippet: id }] };
    }));
  }
  const result = await dispatchResearchOmniSearch({ query: 'HBM4' });
  expect(calls).toEqual(['exa']);
  expect(result.metadata.perEngine).toMatchObject({ exa: { hits: 1 } });
});

test('research explicit engines intersect the allowlist and empty intersections never use defaults', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  for (const id of ['grok', 'firecrawl', 'tavily', 'ddg']) {
    addWebSearchProvider(provider(id, async () => {
      calls.push(id);
      return { providerName: id, durationMs: 1, hits: [] };
    }));
  }
  const allowed = await dispatchResearchOmniSearch({ query: 'topic', engines: ['tavily', 'firecrawl', 'ddg'] });
  expect(calls).toEqual(['firecrawl']);
  expect(allowed.metadata.perEngine).toHaveProperty('firecrawl');
  calls.length = 0;
  const empty = await dispatchResearchOmniSearch({ query: 'topic', engines: ['tavily', 'ddg'] });
  expect(calls).toEqual([]);
  expect(empty.metadata.perEngine).toEqual({});
});

test('Firecrawl-only HBM4 mock retains five hits and a 949ms duration (plumbing only)', async () => {
  _resetWebSearchProvidersForTests(false);
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  addWebSearchProvider(provider('firecrawl', async () => {
    now = 949;
    return {
      providerName: 'firecrawl', durationMs: 949,
      hits: Array.from({ length: 5 }, (_, index) => ({
        url: `https://example.test/hbm4/${index + 1}`, title: `HBM4 source ${index + 1}`, snippet: 'HBM4 evidence',
      })),
    };
  }));
  try {
    const result = await dispatchResearchOmniSearch({ query: 'HBM4', engines: ['firecrawl'] });
    expect(result.metadata).toMatchObject({ totalHits: 5, perEngine: { firecrawl: { hits: 5, durationMs: 949 } } });
    expect(Object.keys(result.metadata.perEngine)).toEqual(['firecrawl']);
  } finally {
    Date.now = originalNow;
  }
});

test('research dispatch never invokes Grok even when it is configured', async () => {
  _resetWebSearchProvidersForTests(false);
  let grokCalls = 0;
  addWebSearchProvider(provider('grok', async () => { grokCalls++; throw new DOMException('timed out', 'TimeoutError'); }));
  addWebSearchProvider(provider('firecrawl', async () => ({
    providerName: 'firecrawl', durationMs: 1,
    hits: Array.from({ length: 5 }, (_, index) => ({
      url: `https://example.test/hbm4/${index + 1}`, title: `HBM4 source ${index + 1}`, snippet: 'HBM4 evidence',
    })),
  })));
  const result = await dispatchResearchOmniSearch({ query: 'HBM4' });
  expect(result.metadata.totalHits).toBe(5);
  expect(grokCalls).toBe(0);
  expect(Object.keys(result.metadata.perEngine)).toEqual(['firecrawl']);
});

test('research dispatch excludes both Grok routes', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  addWebSearchProvider({ ...provider('grok', async () => { calls.push('grok'); return { providerName: 'grok', durationMs: 1, hits: [] }; }), available: () => false });
  addWebSearchProvider(provider('grok-api', async () => { calls.push('grok-api'); return { providerName: 'grok-api', durationMs: 1, hits: [] }; }));
  addWebSearchProvider(provider('firecrawl', async () => { calls.push('firecrawl'); return { providerName: 'firecrawl', durationMs: 1, hits: [] }; }));
  await dispatchResearchOmniSearch({ query: 'topic' });
  expect(calls.sort()).toEqual(['firecrawl']);
});

test('research availability is based only on Exa and Firecrawl', async () => {
  _resetWebSearchProvidersForTests(false);
  addWebSearchProvider(provider('grok', async () => ({ providerName: 'grok', durationMs: 1, hits: [] })));
  expect(researchOmniSearchAvailable()).toBe(false);
  expect(getAvailableResearchSearchEngineIds()).toEqual([]);
});

test('research web fallbacks share the 14.5-second deadline and pass remaining time to each provider', async () => {
  _resetWebSearchProvidersForTests(false);
  let now = 0;
  const calls: string[] = [];
  let firecrawlSignal: AbortSignal | undefined;
  addWebSearchProvider(provider('exa', async () => {
    calls.push('exa');
    now = 10_000;
    throw new Error('Exa unavailable');
  }));
  addWebSearchProvider(provider('firecrawl', async (_query, signal) => {
    calls.push('firecrawl');
    firecrawlSignal = signal;
    return { providerName: 'firecrawl', durationMs: 1, hits: [{ url: 'https://firecrawl.example', title: 'Firecrawl', snippet: 'fallback' }] };
  }));
  const timeoutSpy = spyOn(globalThis, 'setTimeout');
  try {
    const result = await dispatchResearchOmniSearch({ query: 'topic' }, { now: () => now });
    expect(calls).toEqual(['exa', 'firecrawl']);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4_500);
    expect(firecrawlSignal).toBeInstanceOf(AbortSignal);
    expect(result.metadata.perEngine.firecrawl?.hits).toBe(1);
  } finally {
    timeoutSpy.mockRestore();
  }
});

 test('research dispatch emits no Grok event because Grok is not selected', async () => {
  _resetWebSearchProvidersForTests(false);
  addWebSearchProvider(provider('grok', async () => { throw new Error('HTTP 429 quota exhausted'); }));
  const events: Array<{ engine: string; phase: string; error?: string }> = [];
  const result = await dispatchResearchOmniSearch({ query: 'topic' }, {
    onEngine: event => { if (event.phase === 'complete') events.push(event); },
  });
  expect(result.metadata.perEngine.grok).toBeUndefined();
  expect(events).toEqual([]);
});

 test('research availability requires Exa or Firecrawl, never Grok/Tavily/DDG', () => {
  _resetWebSearchProvidersForTests(false);
  addWebSearchProvider(provider('tavily', async () => ({ providerName: 'tavily', durationMs: 1, hits: [] })));
  addWebSearchProvider(provider('ddg', async () => ({ providerName: 'ddg', durationMs: 1, hits: [] })));
  expect(omniSearchAvailable()).toBe(false);
  expect(researchOmniSearchAvailable()).toBe(false);
  addWebSearchProvider(provider('firecrawl', async () => ({ providerName: 'firecrawl', durationMs: 1, hits: [] })));
  expect(omniSearchAvailable()).toBe(false);
  expect(researchOmniSearchAvailable()).toBe(true);
  addWebSearchProvider(provider('grok-api', async () => ({ providerName: 'grok-api', durationMs: 1, hits: [] })));
  expect(researchOmniSearchAvailable()).toBe(true);
  expect(getAvailableResearchSearchEngineIds()).toEqual(['firecrawl']);
  addWebSearchProvider(provider('exa', async () => ({ providerName: 'exa', durationMs: 1, hits: [] })));
  expect(omniSearchAvailable()).toBe(true);
  expect(getAvailableResearchSearchEngineIds()).toEqual(['exa', 'firecrawl']);
});

test('general OmniSearch excludes Grok and does not apply research timeouts', async () => {
  _resetWebSearchProvidersForTests(false);
  let receivedSignal: AbortSignal | undefined;
  addWebSearchProvider(provider('grok', async (_query, signal) => {
    receivedSignal = signal;
    return { providerName: 'grok', durationMs: 1, hits: [] };
  }));
  addWebSearchProvider(provider('firecrawl', async () => ({ providerName: 'firecrawl', durationMs: 1, hits: [] })));
  const timeoutSpy = spyOn(globalThis, 'setTimeout');
  try {
    await dispatchOmniSearch({ query: 'topic' });
    expect(receivedSignal).toBeUndefined();
    expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 8_000);
  } finally {
    timeoutSpy.mockRestore();
  }
});

test('general omni dispatch uses the Exa/Firecrawl allowlist', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  for (const id of ['exa', 'firecrawl', 'grok', 'ddg-free']) addWebSearchProvider(provider(id, async () => {
    calls.push(id);
    return { providerName: id, durationMs: 1, hits: [] };
  }));
  const result = await dispatchOmniSearch({ query: 'topic' });
  expect(calls.sort()).toEqual(['exa', 'firecrawl']);
  expect(result.metadata.perEngine).toHaveProperty('exa');
  expect(result.metadata.perEngine).toHaveProperty('firecrawl');
  expect(result.metadata.perEngine).not.toHaveProperty('grok');
});

test('research Exa success stops before Firecrawl fallback', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  addWebSearchProvider(provider('exa', async () => {
    calls.push('exa');
    return { providerName: 'exa', durationMs: 1, hits: [{ url: 'https://exa.example', title: 'Exa', snippet: 'primary' }] };
  }));
  addWebSearchProvider(provider('firecrawl', async () => {
    calls.push('firecrawl');
    return { providerName: 'firecrawl', durationMs: 1, hits: [] };
  }));

  const result = await dispatchResearchOmniSearch({ query: 'topic' });

  expect(calls).toEqual(['exa']);
  expect(result.metadata.perEngine).toMatchObject({ exa: { hits: 1 } });
});

test('SEARCH-EXA-FIRST: research web fallback tries Exa then Firecrawl only', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  addWebSearchProvider(provider('exa', async () => {
    calls.push('exa');
    throw new Error('Exa search unavailable');
  }));
  addWebSearchProvider(provider('firecrawl', async () => {
    calls.push('firecrawl');
    throw new Error('Firecrawl search unavailable');
  }));

  const result = await dispatchResearchOmniSearch({ query: 'topic' });

  expect(calls).toEqual(['exa', 'firecrawl']);
  expect(result.metadata.perEngine).toMatchObject({
    exa: { error: 'Exa search unavailable' },
    firecrawl: { error: 'Firecrawl search unavailable' },
  });
  expect(result.output).not.toContain('EXA_API_KEY');
});

test('a successful Exa response with no hits continues to Firecrawl for usable research evidence', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  addWebSearchProvider(provider('exa', async () => {
    calls.push('exa');
    return { providerName: 'exa', durationMs: 1, hits: [] };
  }));
  addWebSearchProvider(provider('firecrawl', async () => {
    calls.push('firecrawl');
    return { providerName: 'firecrawl', durationMs: 1, hits: [{ url: 'https://firecrawl.example', title: 'Firecrawl', snippet: 'fallback' }] };
  }));

  const result = await dispatchResearchOmniSearch({ query: 'topic' });

  expect(calls).toEqual(['exa', 'firecrawl']);
  expect(result.metadata.perEngine).toMatchObject({ exa: { hits: 0 }, firecrawl: { hits: 1 } });
});

test('a stalled Exa is aborted early enough for Firecrawl within the shared research deadline', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  addWebSearchProvider(provider('exa', async (_query, signal) => new Promise(resolve => {
    signal?.addEventListener('abort', () => resolve({ providerName: 'exa', durationMs: 4_500, hits: [] }), { once: true });
  })));
  addWebSearchProvider(provider('firecrawl', async (_query, signal) => {
    calls.push('firecrawl');
    expect(signal).toBeInstanceOf(AbortSignal);
    return { providerName: 'firecrawl', durationMs: 1, hits: [{ url: 'https://firecrawl.example', title: 'fallback', snippet: 'usable' }] };
  }));
  const started = Date.now();
  const result = await dispatchResearchOmniSearch({ query: 'topic' });
  expect(Date.now() - started).toBeLessThan(14_500);
  expect(calls).toEqual(['firecrawl']);
  expect(result.metadata.perEngine.firecrawl?.hits).toBe(1);
});

test('research stops at Exa hits before invoking the Firecrawl fallback', async () => {
  _resetWebSearchProvidersForTests(false);
  const hits = (id: string) => [1, 2].map(n => ({ url: `https://${id}.example/${n}`, title: `${id}-${n}`, snippet: '' }));
  addWebSearchProvider(provider('exa', async () => ({ providerName: 'exa', durationMs: 1, hits: hits('exa') })));
  const calls: string[] = [];
  addWebSearchProvider(provider('firecrawl', async () => { calls.push('firecrawl'); return { providerName: 'firecrawl', durationMs: 1, hits: hits('firecrawl') }; }));
  const result = await dispatchResearchOmniSearch({ query: 'topic', limit: 3 });
  expect(calls).toEqual([]);
  expect(result.metadata.totalHits).toBe(2);
  expect(result.metadata.perEngine.exa?.hits).toBe(2);
  expect(result.metadata.perEngine.firecrawl).toBeUndefined();
  expect(result.output.match(/^- \[/gm)).toHaveLength(2);
});

test('research Exa redacts a fake credential from provider errors, output, and observer events', async () => {
  _resetWebSearchProvidersForTests(false);
  const secret = 'fake-exa-secret-9e68d1';
  const events: Array<{ engine: string; phase: string; error?: string }> = [];
  addWebSearchProvider(buildExaWebSearchProvider({
    getEnv: () => secret,
    fetch: async () => { throw new Error(`request failed for ${secret}`); },
  }));
  const result = await dispatchResearchOmniSearch({ query: 'topic' }, {
    onEngine: event => { if (event.phase === 'complete') events.push(event); },
  });
  expect(result.output).not.toContain(secret);
  expect(JSON.stringify(result.metadata)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(result.metadata.perEngine.exa?.error).toContain('[redacted]');
});

