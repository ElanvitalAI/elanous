import { expect, test } from 'bun:test';
import { searchRedditPublicPosts } from './reddit.js';
import { CRAWL_PROVIDERS, executeCrawlCapability, matchingCrawlProviders, type CrawlProvider } from './contracts.js';
import { createCrawlGraphRegistry } from './graph-registry.js';
import { dispatchGraphContract } from '../graph-runner/capabilities.js';

test('public Reddit JSON maps posts to attributed social items without a key', async () => {
  let requested = '';
  const fetchFn = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return Response.json({ data: { children: [
      { data: { title: 'Release discussion', selftext: 'Public feedback', permalink: '/r/programming/comments/abc123/release/', author: 'reader', score: 12, created_utc: 1700000000 } },
      { data: { title: 'Invalid offsite', permalink: 'https://attacker.test/' } },
    ] } });
  }) as typeof fetch;
  const output = await searchRedditPublicPosts('release notes', { fetchFn });
  expect(new URL(requested).hostname).toBe('www.reddit.com');
  expect(new URL(requested).searchParams.get('q')).toBe('release notes');
  expect(output).toMatchObject({ engine: 'reddit-json', totalItems: 1,
    items: [{ url: 'https://www.reddit.com/r/programming/comments/abc123/release/', author: 'reader', likes: 12, text: 'Release discussion\n\nPublic feedback' }] });
});

test('Reddit selects public JSON first, then free DDG when JSON is unavailable', async () => {
  const calls: string[] = [];
  const fakeReddit: CrawlProvider = { id: 'reddit-json', provides: ['social.posts@1'], tier: 'free', latency: 10, keyEnv: [],
    conditions: { socialSite: 'reddit' }, available: () => true, run: async () => { calls.push('reddit'); throw new Error('HTTP 403'); } };
  const fakeDdg: CrawlProvider = { id: 'ddg', provides: ['social.posts@1'], tier: 'free', latency: 20, keyEnv: [], available: () => true,
    run: async query => { calls.push('ddg'); return { engine: 'ddg', query, items: [{ engine: 'ddg', query, url: 'https://reddit.com/r/test/comments/abc/post/', text: 'public post' }], totalItems: 1 }; } };
  const result = await executeCrawlCapability('social.posts@1', 'release', { socialSite: 'reddit' }, [fakeDdg, fakeReddit]);
  expect(result.provider.id).toBe('ddg');
  expect(calls).toEqual(['reddit', 'ddg']);
  expect(matchingCrawlProviders('social.posts@1', CRAWL_PROVIDERS, { socialSite: 'reddit' })[0]?.id).toBe('reddit-json');
  expect(matchingCrawlProviders('social.posts@1', CRAWL_PROVIDERS, { socialSite: 'x' }).some(item => item.id === 'reddit-json')).toBe(false);
  calls.length = 0;
  const graphResult = await dispatchGraphContract('social.posts@1', {
    graphId: 'social-sim', runId: 'run', nodeId: 'collect', input: { query: 'release', socialSite: 'reddit' }, outputs: {},
  }, createCrawlGraphRegistry([fakeDdg, fakeReddit]));
  expect(graphResult).toMatchObject({ ok: true, result: { engine: 'ddg' }, evidence: { provider: 'ddg' } });
  expect(calls).toEqual(['reddit', 'ddg']);
});
