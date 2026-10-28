import { afterEach, describe, expect, test } from 'bun:test';
import { grokAgentSearch } from '../grok/agent-search.js';
import { setUserConfigOverlay } from '../user-config.js';
import { _resetWebSearchProvidersForTests, addWebSearchProvider, listWebSearchProviders, searchWeb } from './index.js';

afterEach(() => {
  setUserConfigOverlay(null);
  _resetWebSearchProvidersForTests();
});

describe('Grok subscription search default', () => {
  test('API key presence alone cannot register metered providers', () => {
    setUserConfigOverlay(c => ({ ...c, webSearch: {} }));
    _resetWebSearchProvidersForTests();
    expect(listWebSearchProviders().map(p => p.id)).toEqual(['grok', 'ddg-free']);
  });

  test('metered providers require explicit opt-in', () => {
    setUserConfigOverlay(c => ({ ...c, webSearch: { grokApi: { enabled: true }, firecrawl: { enabled: true } } }));
    _resetWebSearchProvidersForTests();
    expect(listWebSearchProviders().map(p => p.id)).toEqual(['grok', 'grok-api', 'firecrawl', 'ddg-free']);
  });

  test('subscription quota exhaustion falls through to free search without invoking metered search', async () => {
    setUserConfigOverlay(c => ({ ...c, webSearch: {} }));
    _resetWebSearchProvidersForTests();
    expect(listWebSearchProviders().map(p => p.id)).toEqual(['grok', 'ddg-free']);
    _resetWebSearchProvidersForTests(false);
    const calls: string[] = [];
    addWebSearchProvider({ id: 'grok', displayName: 'subscription', available: () => true, search: async () => {
      calls.push('grok');
      throw new Error('429 usage_limit_reached');
    } });
    addWebSearchProvider({ id: 'ddg-free', displayName: 'free', available: () => true, search: async () => {
      calls.push('ddg-free');
      return { providerName: 'ddg-free', durationMs: 0, hits: [{ url: 'https://example.org', title: 'Source', snippet: '' }] };
    } });
    expect((await searchWeb({ query: 'example' })).providerName).toBe('ddg-free');
    expect(calls).toEqual(['grok', 'ddg-free']);
  });

  test('subscription quota exhaustion may use metered fallback after explicit opt-in', async () => {
    setUserConfigOverlay(c => ({ ...c, webSearch: { grokApi: { enabled: true } } }));
    _resetWebSearchProvidersForTests();
    expect(listWebSearchProviders().map(p => p.id)).toEqual(['grok', 'grok-api', 'ddg-free']);
    _resetWebSearchProvidersForTests(false);
    const calls: string[] = [];
    addWebSearchProvider({ id: 'grok', displayName: 'subscription', available: () => true, search: async () => {
      calls.push('grok');
      throw new Error('429 usage_limit_reached');
    } });
    addWebSearchProvider({ id: 'grok-api', displayName: 'metered', available: () => true, search: async () => {
      calls.push('grok-api');
      return { providerName: 'grok-api', durationMs: 0, hits: [{ url: 'https://example.org', title: 'Source', snippet: '' }] };
    } });
    expect((await searchWeb({ query: 'example' })).providerName).toBe('grok-api');
    expect(calls).toEqual(['grok', 'grok-api']);
  });

  test('explicit grok selection can use an enabled API provider when subscription is unavailable', async () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider({ id: 'grok', displayName: 'subscription', available: () => false, search: async () => { throw new Error('must not run'); } });
    addWebSearchProvider({ id: 'grok-api', displayName: 'metered', available: () => true, search: async () => ({
      providerName: 'grok-api', durationMs: 0, hits: [{ url: 'https://example.org', title: 'Source', snippet: '' }],
    }) });
    expect((await searchWeb({ query: 'example' }, { providerId: 'grok' })).providerName).toBe('grok-api');
  });

  test('subscription response request uses proxy endpoint and preserves cited sources', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const result = await grokAgentSearch('latest release', {
      apiKey: 'test-subscription-token',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      headers: { 'x-grok-client-version': '1.0.41' },
      model: 'grok-4.6',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response(JSON.stringify({ output: [
          { type: 'web_search_call', action: { sources: [{ url: 'https://example.org/source', title: 'Source' }] } },
          { type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [
            { type: 'url_citation', url: 'https://example.org/source', title: 'Source' },
          ] }] },
        ] }), { status: 200 });
      },
    });
    expect(captured?.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(captured?.init?.headers).toMatchObject({ authorization: 'Bearer test-subscription-token', 'x-grok-client-version': '1.0.41' });
    expect(JSON.parse(String(captured?.init?.body)).model).toBe('grok-4.6');
    expect(result).toMatchObject({ ok: true, status: 200, text: 'Answer', citations: [{ url: 'https://example.org/source', title: 'Source' }] });
  });

  test('an endpoint base already ending in /responses does not duplicate the path', async () => {
    let endpoint = '';
    await grokAgentSearch('query', {
      apiKey: 'test', baseUrl: 'https://cli-chat-proxy.grok.com/v1/responses',
      fetchImpl: async url => { endpoint = url; return new Response(JSON.stringify({ output: [] }), { status: 200 }); },
    });
    expect(endpoint).toBe('https://cli-chat-proxy.grok.com/v1/responses');
  });
});
