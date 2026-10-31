// Provider-interface tests. No network calls — we register a stub
// provider and drive the registry + tool dispatcher against it.

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWebSearchProvider,
  addWebSearchProviderFirst,
  listWebSearchProviders,
  searchWeb,
  WebSearchUnavailableError,
  _resetWebSearchProvidersForTests,
  type WebSearchProvider,
} from '../src/web-search/index';
import { buildWebSearchTool, dispatchWebSearch } from '../src/skills/tools/web-search';
import { _resetTavilyKeyCacheForTests } from '../src/web-search/tavily';
import { _resetKeyCacheForTests } from '../src/config';
import { buildFirecrawlWebSearchProvider } from '../src/web-search/firecrawl';
import { resetUserConfig } from '../src/user-config';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir';

function stubProvider(overrides: Partial<WebSearchProvider> = {}): WebSearchProvider {
  return {
    id: 'stub',
    displayName: 'Stub',
    available: () => true,
    search: async (q) => ({
      hits: [
        { url: 'https://example.com/a', title: 'A', snippet: `match for ${q.query}` },
        { url: 'https://example.com/b', title: 'B', snippet: '' },
      ],
      providerName: 'stub',
      durationMs: 42,
    }),
    ...overrides,
  };
}

// Hide built-in providers (Tavily / Grok / Firecrawl) by clearing keys
// before the registry boots. Tavily falls back to the omni-crawl skill's
// .env file, so point TAVILY_ENV_FILE at a nonexistent path for isolation.
const ORIGINAL_KEYS = {
  XAI_API_KEY: process.env.XAI_API_KEY,
  // ⛔⭐ `getGrokApiKey` 는 `XAI_API_KEY` «다음»으로 이 이름도 본다 — 지우는 문이 하나 모자랐다.
  GROK_API_KEY: process.env.GROK_API_KEY,
  // ⛔⭐⭐ 그리고 해석기는 env «보다 먼저» ~/.cache 의 키 캐시 파일을 본다.
  //   ⇒ env 를 아무리 지워도 ***캐시가 이긴다***. 이음매(ELANOUS_KEY_CACHE_DIR)로 그 문도 닫는다.
  ELANOUS_KEY_CACHE_DIR: process.env.ELANOUS_KEY_CACHE_DIR,
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  TAVILY_KEY: process.env.TAVILY_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  TAVILY_ENV_FILE: process.env.TAVILY_ENV_FILE,
};

beforeEach(() => {
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_API_KEY;
  process.env.ELANOUS_KEY_CACHE_DIR = '/nonexistent/elanous-key-cache';
  _resetKeyCacheForTests();
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.TAVILY_KEY;
  delete process.env.TAVILY_API_KEY;
  process.env.TAVILY_ENV_FILE = '/nonexistent/tavily.env';
  _resetTavilyKeyCacheForTests();
  _resetWebSearchProvidersForTests();
});

// Restore env after the suite — bun test reuses the worker.
afterAll(() => {
  if (ORIGINAL_KEYS.XAI_API_KEY !== undefined) process.env.XAI_API_KEY = ORIGINAL_KEYS.XAI_API_KEY;
  if (ORIGINAL_KEYS.GROK_API_KEY !== undefined) process.env.GROK_API_KEY = ORIGINAL_KEYS.GROK_API_KEY;
  if (ORIGINAL_KEYS.ELANOUS_KEY_CACHE_DIR !== undefined) process.env.ELANOUS_KEY_CACHE_DIR = ORIGINAL_KEYS.ELANOUS_KEY_CACHE_DIR;
  else delete process.env.ELANOUS_KEY_CACHE_DIR;
  _resetKeyCacheForTests();
  if (ORIGINAL_KEYS.FIRECRAWL_API_KEY !== undefined) process.env.FIRECRAWL_API_KEY = ORIGINAL_KEYS.FIRECRAWL_API_KEY;
  if (ORIGINAL_KEYS.TAVILY_KEY !== undefined) process.env.TAVILY_KEY = ORIGINAL_KEYS.TAVILY_KEY;
  if (ORIGINAL_KEYS.TAVILY_API_KEY !== undefined) process.env.TAVILY_API_KEY = ORIGINAL_KEYS.TAVILY_API_KEY;
  if (ORIGINAL_KEYS.TAVILY_ENV_FILE !== undefined) process.env.TAVILY_ENV_FILE = ORIGINAL_KEYS.TAVILY_ENV_FILE;
  else delete process.env.TAVILY_ENV_FILE;
  _resetTavilyKeyCacheForTests();
});

describe('Firecrawl web-search provider', () => {
  let configDir = '';
  const realFetch = globalThis.fetch;

  function writeFirecrawlConfig(apiKey: string): void {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ registry: { discovery: { firecrawl: { apiKey } } } }),
      'utf-8',
    );
    resetUserConfig();
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'web-search-firecrawl-'));
    setElanousConfigDir(configDir);
    resetUserConfig();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetElanousConfigDir();
    rmSync(configDir, { recursive: true, force: true });
    configDir = '';
    resetUserConfig();
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    resetUserConfig();
  });

  test('is available with a config-only key', () => {
    writeFirecrawlConfig('fc-config');
    expect(buildFirecrawlWebSearchProvider().available()).toBe(true);
  });

  test('is available with an env-only key', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-env';
    expect(buildFirecrawlWebSearchProvider().available()).toBe(true);
  });

  test('is unavailable without config or env credentials', () => {
    expect(buildFirecrawlWebSearchProvider().available()).toBe(false);
  });

  test('uses the config key over env for Authorization', async () => {
    writeFirecrawlConfig('fc-config');
    process.env.FIRECRAWL_API_KEY = 'fc-env';
    let authorization = '';
    globalThis.fetch = (async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    await buildFirecrawlWebSearchProvider().search({ query: 'configuration precedence' });

    expect(authorization).toBe('Bearer fc-config');
  });

  test('uses an injected resolver for availability and requests', async () => {
    let calls = 0;
    const provider = buildFirecrawlWebSearchProvider(() => {
      calls += 1;
      return { apiKey: 'fc-injected' };
    });
    let authorization = '';
    globalThis.fetch = (async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    expect(provider.available()).toBe(true);
    await provider.search({ query: 'injected resolver' });

    expect(calls).toBe(2);
    expect(authorization).toBe('Bearer fc-injected');
  });
});

describe('web-search registry', () => {
  test('registers the grok built-in on reset', () => {
    const providers = listWebSearchProviders();
    expect(providers.some(p => p.id === 'grok')).toBe(true);
  });

  test('addWebSearchProvider appends; First prepends', () => {
    addWebSearchProvider(stubProvider({ id: 'last' }));
    addWebSearchProviderFirst(stubProvider({ id: 'first' }));
    const ids = listWebSearchProviders().map(p => p.id);
    expect(ids[0]).toBe('first');
    expect(ids[ids.length - 1]).toBe('last');
  });

  test('searchWeb routes to the first available provider', async () => {
    _resetWebSearchProvidersForTests();
    addWebSearchProviderFirst(stubProvider({ id: 'exa' }));
    const r = await searchWeb({ query: 'hello' });
    expect(r.providerName).toBe('stub');
    expect(r.hits).toHaveLength(2);
    expect(r.hits[0]?.snippet).toContain('hello');
  });

  test('searchWeb falls through when first provider is unavailable', async () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider(stubProvider({ id: 'exa', available: () => false }));
    // Keep the test independent of built-in providers such as ddg-free.
    addWebSearchProvider(stubProvider({ id: 'firecrawl' }));
    const r = await searchWeb({ query: 'x' });
    expect(r.providerName).toBe('stub');
  });

  test('providerId forces a specific provider', async () => {
    addWebSearchProvider(stubProvider({ id: 'forced', displayName: 'F' }));
    const r = await searchWeb({ query: 'x' }, { providerId: 'forced' });
    expect(r.providerName).toBe('stub');   // stub impl returns 'stub' — id vs providerName distinction
  });

  test('unknown providerId throws WebSearchUnavailableError', async () => {
    await expect(searchWeb({ query: 'x' }, { providerId: 'nope' }))
      .rejects.toThrow(WebSearchUnavailableError);
  });

  test('cascades through providers when earlier ones throw', async () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProviderFirst(stubProvider({
      id: 'exa',
      search: async () => { throw new Error('boom'); },
    }));
    addWebSearchProvider(stubProvider({ id: 'firecrawl' }));
    const r = await searchWeb({ query: 'x' });
    expect(r.providerName).toBe('stub');
  });
});

describe('WebSearch tool', () => {
  test('buildWebSearchTool returns a valid spec', () => {
    const spec = buildWebSearchTool();
    expect(spec.name).toBe('WebSearch');
    expect(spec.parameters.required).toContain('query');
  });

  test('empty query throws', async () => {
    await expect(dispatchWebSearch({ query: '' })).rejects.toThrow(/query is required/);
  });

  test('formats hits as a numbered list with URL + snippet', async () => {
    _resetWebSearchProvidersForTests();
    addWebSearchProviderFirst(stubProvider({ id: 'exa' }));
    const r = await dispatchWebSearch({ query: 'koalas' });
    expect(r.numHits).toBe(2);
    expect(r.output).toContain('2 results for "koalas"');
    expect(r.output).toContain('1. A');
    expect(r.output).toContain('https://example.com/a');
    expect(r.output).toContain('match for koalas');
    expect(r.output).toContain('2. B');
  });

  test('surfaces WebSearchUnavailableError with a clear message', async () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider(stubProvider({ id: 'unavailable', available: () => false }));
    await expect(dispatchWebSearch({ query: 'anything' }))
      .rejects.toThrow(/web-search|unavailable/i);
  });

  test('zero-hit results are labelled distinctly', async () => {
    addWebSearchProviderFirst(stubProvider({ id: 'exa',
      search: async () => ({ hits: [], providerName: 'empty', durationMs: 5 }),
    }));
    const r = await dispatchWebSearch({ query: 'nothing-here' });
    expect(r.numHits).toBe(0);
    expect(r.output).toContain('No results');
  });
});
