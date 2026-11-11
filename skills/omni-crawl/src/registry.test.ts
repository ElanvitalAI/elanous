import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrawlContractExhaustedError, REGISTRY, matchingEngines, registerEngine, runCapability, runRegisteredEngine, type EngineCtx, type EngineDescriptor } from './registry.js';
import type { SearchEngine } from './types.js';
import { decideCrawl } from './router.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ctx: EngineCtx = { limit: 5, depth: 'basic', minFavs: 0, maxItems: 5, lang: 'en' };
const result = (id: string) => ({ engine: id, query: 'fixture', items: [{ engine: id, query: 'fixture', url: `https://example.test/${id}`, text: 'fixed response' }], totalItems: 1 });
function fake(id: string, tier: EngineDescriptor['tier'], latency: number, calls: string[], options: {
  provides?: EngineDescriptor['provides']; keyEnv?: readonly string[]; conditions?: EngineDescriptor['conditions']; empty?: boolean; supportsTimeRange?: boolean;
} = {}): EngineDescriptor {
  return { id, capability: 'web-search', provides: options.provides ?? ['search.web@1'], tier, latency,
    keyEnv: options.keyEnv ?? [], conditions: options.conditions, supportsTimeRange: options.supportsTimeRange, available: () => true,
    run: async (query, context) => { calls.push(`${id}:${query}:${context.socialSite ?? '-'}`); return options.empty ? null : result(id); } };
}

test('contract matching ranks free before BYOK and invokes paid fallback only after empty free output', async () => {
  const calls: string[] = [];
  const free = fake('ddg', 'free', 20, calls);
  const tavily = fake('tavily', 'byok', 10, calls, { keyEnv: ['TAVILY_KEY', 'TAVILY_API_KEY'] });
  const firecrawl = fake('firecrawl', 'byok', 30, calls, { keyEnv: ['FIRECRAWL_API_KEY'] });
  const providers = [firecrawl, tavily, free];
  const env = { TAVILY_API_KEY: 'fixture', FIRECRAWL_API_KEY: 'fixture' };
  assert.deepEqual(matchingEngines({ contract: 'search.web@1' }, providers, env).map(item => item.id), ['ddg', 'tavily', 'firecrawl']);
  assert.equal((await runCapability({ contract: 'search.web@1' }, 'query', ctx, providers, env)).provider, 'ddg');
  assert.deepEqual(calls, ['ddg:query:-']);
  calls.length = 0;
  const picked = await runCapability({ contract: 'search.web@1' }, 'query', ctx, [firecrawl, tavily, { ...free, run: async () => { calls.push('ddg:query:-'); return null; } }], env);
  assert.equal(picked.provider, 'tavily');
  assert.deepEqual(picked.attempts, [{ provider: 'ddg', reason: 'empty' }]);
  assert.deepEqual(calls, ['ddg:query:-', 'tavily:query:-']);
});

test('social conditions reach the same supplier invocation context and --free excludes keyed suppliers', async () => {
  const calls: string[] = [];
  const reddit = fake('reddit', 'free', 5, calls, { provides: ['social.posts@1'], conditions: { socialSite: 'reddit' } });
  const x = fake('x', 'byok', 5, calls, { provides: ['social.posts@1'], keyEnv: ['XAI_API_KEY'], conditions: { socialSite: 'x' } });
  const picked = await runCapability({ contract: 'social.posts@1', conditions: { socialSite: 'x' } }, 'posts', ctx, [reddit, x], { XAI_API_KEY: 'fixture' });
  assert.equal(picked.provider, 'x');
  assert.deepEqual(calls, ['x:posts:x']);
  assert.deepEqual(matchingEngines({ contract: 'social.posts@1', conditions: { socialSite: 'x' }, freeOnly: true }, [reddit, x], { XAI_API_KEY: 'fixture' }), []);
});

test('a contract with no eligible key reports explicit exhaustion and no attempts', async () => {
  const keyed = fake('keyed', 'byok', 1, [], { keyEnv: ['MISSING_TEST_KEY'] });
  let error: unknown;
  try { await runCapability({ contract: 'search.web@1' }, 'query', ctx, [keyed], {}); }
  catch (caught) { error = caught; }
  assert.ok(error instanceof CrawlContractExhaustedError);
  assert.equal(error.contract, 'search.web@1');
  assert.deepEqual(error.attempts, []);
});

test('blank scrape content falls through to the next supplier', async () => {
  const calls: string[] = [];
  const blank = { ...fake('jina', 'free', 1, calls, { provides: ['scrape.url@1'] }),
    run: async () => { calls.push('jina'); return { ...result('jina'), items: [{ ...result('jina').items[0]!, text: '  ' }] }; } };
  const filled = fake('readability', 'free', 2, calls, { provides: ['scrape.url@1'] });
  const picked = await runCapability({ contract: 'scrape.url@1' }, 'https://example.test', ctx, [filled, blank], {});
  assert.equal(picked.provider, 'readability');
  assert.deepEqual(picked.attempts, [{ provider: 'jina', reason: 'empty' }]);
  assert.deepEqual(calls, ['jina', 'readability:https://example.test:-']);
});

test('explicit engine ID still dispatches its registered adapter', async () => {
  const calls: string[] = [];
  const descriptor = fake('fixture-engine', 'free', 1, calls);
  registerEngine(descriptor);
  try {
    const output = await runRegisteredEngine('fixture-engine' as SearchEngine, 'pinned', ctx);
    assert.equal(output?.engine, 'fixture-engine');
    assert.deepEqual(calls, ['fixture-engine:pinned:-']);
  } finally { REGISTRY.delete('fixture-engine'); }
});

test('dated news excludes DDG and only invokes a supplier that honors time range', async () => {
  const calls: string[] = [];
  const ddg = fake('ddg', 'free', 1, calls, { provides: ['search.news@1'] });
  const tavilyBase = fake('tavily-news', 'byok', 2, calls, { provides: ['search.news@1'], keyEnv: ['TAVILY_KEY'], supportsTimeRange: true });
  const tavily = { ...tavilyBase, run: async (query: string, context: EngineCtx) => {
    calls.push(`tavily-news:${query}:${context.timeRange}`);
    return result('tavily-news');
  } };
  const request = { contract: 'search.news@1' as const, timeRange: 'day' };
  assert.deepEqual(matchingEngines(request, [ddg, tavily], { TAVILY_KEY: 'fixture' }).map(item => item.id), ['tavily-news']);
  const picked = await runCapability(request, 'today', ctx, [ddg, tavily], { TAVILY_KEY: 'fixture' });
  assert.equal(picked.provider, 'tavily-news');
  assert.deepEqual(calls, ['tavily-news:today:day']);
});

test('plain-text scrape adapters do not claim structured extraction', () => {
  assert.equal([...REGISTRY.values()].some(item => (item.provides as readonly string[]).includes('extract.structured@1')), false);
});

test('automatic CLI routes use real DDG and Jina adapters with only fetch responses fixed', async () => {
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('duckduckgo.com')) return new Response('<a class="result__a" href="https://example.com/news">Example</a><a class="result__snippet">Fixed snippet</a>', { status: 200 });
    if (url.includes('r.jina.ai')) return new Response('Title: Example article\nMarkdown Content:\nA fixed article body with more than thirty characters for extraction.', { status: 200 });
    throw new Error(`unexpected fetch target: ${url}`);
  }) as typeof fetch;
  try {
    const webRoute = decideCrawl({ intentText: 'AI trend', query: 'AI trend' });
    assert.equal(webRoute.requires?.[0]?.contract, 'search.web@1');
    const web = await runCapability(webRoute.requires![0]!, 'AI trend', ctx, [REGISTRY.get('ddg')!], {});
    assert.equal(web.provider, 'ddg');
    assert.equal(web.result.items[0]?.url, 'https://example.com/news');

    const url = 'https://example.com/article';
    const pageRoute = decideCrawl({ intentText: url, query: url });
    assert.equal(pageRoute.requires?.[0]?.contract, 'scrape.url@1');
    const page = await runCapability(pageRoute.requires![0]!, url, { ...ctx, allowPrivate: true }, [REGISTRY.get('jina-reader')!], {});
    assert.equal(page.provider, 'jina-reader');
    assert.equal(page.result.items[0]?.metadata?.title, 'Example article');
    assert.deepEqual(fetched, ['https://html.duckduckgo.com/html/', `https://r.jina.ai/${url}`]);
  } finally { globalThis.fetch = originalFetch; }
});

test('URL-only input executes the real CLI scrape path with fixed HTTP and JSON markers', () => {
  const main = fileURLToPath(new URL('../scripts/main.ts', import.meta.url));
  const preload = fileURLToPath(new URL('./test-fetch-preload.ts', import.meta.url));
  const child = spawnSync(process.execPath, [`--preload=${preload}`, main, 'https://example.com/article', '--allow-private', '--json', '--no-save'],
    { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /---BEGIN_OMNI_CRAWL_JSON---/);
  assert.match(child.stdout, /---END_OMNI_CRAWL_JSON---/);
  const json = child.stdout.split('---BEGIN_OMNI_CRAWL_JSON---')[1]!.split('---END_OMNI_CRAWL_JSON---')[0]!;
  const payload = JSON.parse(json) as { results: { engine: string; items: { title?: string }[] }[] };
  assert.equal(payload.results[0]?.engine, 'jina-reader');
  assert.equal(payload.results[0]?.items[0]?.title, 'CLI fixture');
  const github = spawnSync(process.execPath, [main, 'https://github.com/example/repo', '--dry-run'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(github.status, 0, github.stderr);
  assert.match(github.stdout, /"contract": "scrape\.url@1"/);
  assert.doesNotMatch(github.stdout, /search\.developer@1/);
});
