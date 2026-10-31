import { expect, test } from 'bun:test';
import { buildExaWebSearchProvider } from './exa.js';
import { _resetWebSearchProvidersForTests, getAvailableResearchWebSearchProviders, getAvailableWebSearchProviders } from './index.js';

test('Exa prefers EXA_API_KEY, normalizes results, and forwards AbortSignal', async () => {
  let receivedSignal: AbortSignal | undefined;
  let cacheRead = false;
  const provider = buildExaWebSearchProvider({
    getEnv: (name) => name === 'EXA_API_KEY' ? 'environment-secret' : undefined,
    readFile: () => { cacheRead = true; return 'cache-secret'; },
    homeDir: () => '/home/tester',
    fetch: async (_url, init) => {
      receivedSignal = init?.signal ?? undefined;
      expect(init?.headers).toMatchObject({ 'x-api-key': 'environment-secret' });
      return new Response(JSON.stringify({ results: [{
        url: 'https://exa.example/result', title: 'Exa result', highlights: ['one', 'two'], score: 0.9,
        publishedDate: '2026-10-30T00:00:00.000Z',
      }] }), { status: 200 });
    },
  });
  const controller = new AbortController();

  const result = await provider.search({ query: 'HBM4', limit: 3 }, controller.signal);

  expect(provider.available()).toBe(true);
  expect(cacheRead).toBe(false);
  expect(receivedSignal).toBe(controller.signal);
  expect(result).toMatchObject({
    providerName: 'exa',
    hits: [{ url: 'https://exa.example/result', title: 'Exa result', snippet: 'one\ntwo', score: 0.9 }],
  });
  expect(result.hits[0]!.publishedAt).toBe(Date.parse('2026-10-30T00:00:00.000Z'));
});

test('Exa falls back to ~/.cache/exa_api_key without returning the key in configuration errors', async () => {
  let cachePath = '';
  const cached = buildExaWebSearchProvider({
    getEnv: () => undefined,
    homeDir: () => '/home/tester',
    readFile: (path) => { cachePath = path; return 'cache-secret\n'; },
  });
  const missing = buildExaWebSearchProvider({
    getEnv: () => undefined,
    readFile: () => { throw new Error('not found'); },
    homeDir: () => '/home/tester',
  });

  expect(cached.available()).toBe(true);
  expect(cachePath).toBe('/home/tester/.cache/exa_api_key');
  await expect(missing.search({ query: 'topic' })).rejects.toThrow('Exa API key not configured');
});

test('Exa is available to general and research WebSearch routing', () => {
  const previous = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = 'test-only-exa-key';
  _resetWebSearchProvidersForTests();
  try {
    expect(getAvailableWebSearchProviders().some(provider => provider.id === 'exa')).toBe(true);
    expect(getAvailableResearchWebSearchProviders()).toContainEqual(expect.objectContaining({ id: 'exa' }));
  } finally {
    if (previous === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = previous;
    _resetWebSearchProvidersForTests();
  }
});
