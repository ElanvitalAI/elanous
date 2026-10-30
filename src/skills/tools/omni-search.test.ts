import { afterEach, expect, spyOn, test } from 'bun:test';
import { addWebSearchProvider, _resetWebSearchProvidersForTests, type WebSearchProvider } from '../../web-search/index.js';
import { dispatchOmniSearch, dispatchResearchOmniSearch, getAvailableResearchSearchEngineIds, omniSearchAvailable, researchOmniSearchAvailable } from './omni-search.js';

function provider(id: string, search: WebSearchProvider['search']): WebSearchProvider {
  return { id, displayName: id, available: () => true, search };
}

afterEach(() => _resetWebSearchProvidersForTests());

test('research dispatch selects one Grok route and Firecrawl, excluding Tavily and DDG', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  for (const id of ['grok', 'grok-api', 'firecrawl', 'tavily', 'ddg']) {
    addWebSearchProvider(provider(id, async () => {
      calls.push(id);
      return { providerName: id, durationMs: 1, hits: [{ url: `https://${id}.example`, title: id, snippet: id }] };
    }));
  }
  const result = await dispatchResearchOmniSearch({ query: 'HBM4' });
  expect(calls.sort()).toEqual(['firecrawl', 'grok']);
  expect(result.metadata.perEngine).toMatchObject({ grok: { hits: 1 }, firecrawl: { hits: 1 } });
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

test('Grok timeout reason is emitted and retained with successful Firecrawl hits', async () => {
  _resetWebSearchProvidersForTests(false);
  addWebSearchProvider(provider('grok', async () => { throw new DOMException('timed out', 'TimeoutError'); }));
  addWebSearchProvider(provider('firecrawl', async () => ({
    providerName: 'firecrawl', durationMs: 1,
    hits: Array.from({ length: 5 }, (_, index) => ({
      url: `https://example.test/hbm4/${index + 1}`, title: `HBM4 source ${index + 1}`, snippet: 'HBM4 evidence',
    })),
  })));
  const events: Array<{ engine: string; phase: string; error?: string }> = [];
  const result = await dispatchResearchOmniSearch({ query: 'HBM4' }, {
    onEngine: event => { if (event.phase === 'complete') events.push(event); },
  });
  expect(result.metadata.totalHits).toBe(5);
  expect(result.metadata.perEngine.grok).toMatchObject({ error: 'timed out', durationMs: expect.any(Number) });
  expect(result.metadata.perEngine.firecrawl).toMatchObject({ hits: 5, durationMs: expect.any(Number) });
  expect(events).toContainEqual(expect.objectContaining({ engine: 'grok', phase: 'complete', error: 'timed out' }));
});

test('Grok API is the single selected route when subscription Grok is unavailable', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  addWebSearchProvider({ ...provider('grok', async () => { calls.push('grok'); return { providerName: 'grok', durationMs: 1, hits: [] }; }), available: () => false });
  addWebSearchProvider(provider('grok-api', async () => { calls.push('grok-api'); return { providerName: 'grok-api', durationMs: 1, hits: [] }; }));
  addWebSearchProvider(provider('firecrawl', async () => { calls.push('firecrawl'); return { providerName: 'firecrawl', durationMs: 1, hits: [] }; }));
  await dispatchResearchOmniSearch({ query: 'topic' });
  expect(calls.sort()).toEqual(['firecrawl', 'grok-api']);
});

test('Grok receives an abort signal and an 8-second initial search deadline', async () => {
  _resetWebSearchProvidersForTests(false);
  let signal: AbortSignal | undefined;
  addWebSearchProvider(provider('grok', async (_query, receivedSignal) => {
    signal = receivedSignal;
    return { providerName: 'grok', durationMs: 1, hits: [] };
  }));
  const timeoutSpy = spyOn(globalThis, 'setTimeout');
  try {
    await dispatchResearchOmniSearch({ query: 'topic' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 8_000);
  } finally {
    timeoutSpy.mockRestore();
  }
});

 test('Grok quota code is retained in per-engine metadata and completion events', async () => {
  _resetWebSearchProvidersForTests(false);
  addWebSearchProvider(provider('grok', async () => { throw new Error('HTTP 429 quota exhausted'); }));
  const events: Array<{ engine: string; phase: string; error?: string }> = [];
  const result = await dispatchResearchOmniSearch({ query: 'topic' }, {
    onEngine: event => { if (event.phase === 'complete') events.push(event); },
  });
  expect(result.metadata.perEngine.grok?.error).toBe('HTTP 429 quota exhausted');
  expect(events).toContainEqual(expect.objectContaining({ engine: 'grok', phase: 'complete', error: 'HTTP 429 quota exhausted' }));
});

 test('research availability requires the allowed Grok/Firecrawl pair', () => {
  _resetWebSearchProvidersForTests(false);
  addWebSearchProvider(provider('tavily', async () => ({ providerName: 'tavily', durationMs: 1, hits: [] })));
  addWebSearchProvider(provider('ddg', async () => ({ providerName: 'ddg', durationMs: 1, hits: [] })));
  expect(omniSearchAvailable()).toBe(true);
  expect(researchOmniSearchAvailable()).toBe(false);
  addWebSearchProvider(provider('firecrawl', async () => ({ providerName: 'firecrawl', durationMs: 1, hits: [] })));
  expect(omniSearchAvailable()).toBe(true);
  expect(researchOmniSearchAvailable()).toBe(false);
  addWebSearchProvider(provider('grok-api', async () => ({ providerName: 'grok-api', durationMs: 1, hits: [] })));
  expect(researchOmniSearchAvailable()).toBe(true);
  expect(getAvailableResearchSearchEngineIds()).toEqual(['grok-api', 'firecrawl']);
});

test('ordinary OmniSearch does not apply the research-only Grok timeout or abort signal', async () => {
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

test('ordinary omni dispatch behavior remains available through its existing API', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: string[] = [];
  for (const id of ['alpha', 'beta']) addWebSearchProvider(provider(id, async () => {
    calls.push(id);
    return { providerName: id, durationMs: 1, hits: [] };
  }));
  const result = await dispatchOmniSearch({ query: 'topic' });
  expect(calls.sort()).toEqual(['alpha', 'beta']);
  expect(result.metadata.perEngine).toHaveProperty('alpha');
  expect(result.metadata.perEngine).toHaveProperty('beta');
});

