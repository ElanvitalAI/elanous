import { expect, test } from 'bun:test';
import { CRAWL_CONTRACTS, CRAWL_PROVIDERS, crawlResultUsable, executeCrawlCapability, matchingCrawlProviders, type CrawlProvider } from './contracts.js';
import { createCrawlGraphRegistry } from './graph-registry.js';
import { CrawlContractExhaustedError, extractScrapViaGraph } from './graph-extract.js';
import { runGraph } from '../graph-runner/runner.js';
import { dispatchGraphContract } from '../graph-runner/capabilities.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const result = (provider: string, query: string) => ({ engine: provider, query, items: [{ engine: provider, query, url: query, text: `${provider} fixture`, metadata: { title: `${provider} title` } }], totalItems: 1 });
const provider = (id: string, tier: 'free' | 'byok', run: CrawlProvider['run']): CrawlProvider =>
  ({ id, provides: ['scrape.url@1', 'extract.structured@1'], tier, latency: 1, keyEnv: tier === 'free' ? [] : ['TEST_KEY'], available: () => true, run });

test('fixed response simulation selects free, then BYOK only after empty free results', async () => {
  const calls: string[] = [];
  const free = provider('jina', 'free', async query => { calls.push('jina'); return result('jina', query); });
  const paid = provider('firecrawl', 'byok', async query => { calls.push('firecrawl'); return result('firecrawl', query); });
  const first = await executeCrawlCapability('scrape.url@1', 'https://example.test/a', {}, [paid, free]);
  expect(first.provider.id).toBe('jina');
  expect(calls).toEqual(['jina']);
  calls.length = 0;
  const empty = provider('jina', 'free', async () => { calls.push('jina'); return null; });
  const second = await executeCrawlCapability('scrape.url@1', 'https://example.test/a', {}, [paid, empty]);
  expect(second.provider.id).toBe('firecrawl');
  expect(calls).toEqual(['jina', 'firecrawl']);
});

test('empty extract text falls through to BYOK in the operational requires graph', async () => {
  const calls: string[] = [];
  const empty = provider('empty-free', 'free', async query => {
    calls.push('free');
    return { engine: 'empty-free', query, items: [{ engine: 'empty-free', query, text: '   ' }], totalItems: 1 };
  });
  const paid = { ...provider('filled-byok', 'byok', async query => {
    calls.push('byok');
    return result('filled-byok', query);
  }), keyEnv: [] };
  const extracted = await extractScrapViaGraph({ url: 'https://example.test/article' }, { providers: [paid, empty] });
  expect(extracted).toMatchObject({ provider: 'filled-byok', title: 'filled-byok title' });
  expect(calls).toEqual(['free', 'byok']);
});

test('short X and YouTube access interstitials fall through to another free adapter', async () => {
  const blocked = provider('jina-fixture', 'free', async query => ({ engine: 'jina-fixture', query,
    items: [{ engine: 'jina-fixture', query, text: 'Access denied. Please enable JavaScript.', metadata: { title: 'Access denied' } }], totalItems: 1 }));
  const readable = { ...provider('readability-fixture', 'free', async query => result('readability-fixture', query)), latency: 2 };
  for (const url of ['https://x.com/lecture/status/1', 'https://www.youtube.com/watch?v=fixture']) {
    const extracted = await extractScrapViaGraph({ url }, { providers: [readable, blocked] });
    expect(extracted.provider).toBe('readability-fixture');
  }
});

test('an article about access denial is still valid extraction content', () => {
  expect(crawlResultUsable('extract.structured@1', {
    engine: 'fixture', query: 'https://example.test/article', totalItems: 1,
    items: [{ engine: 'fixture', query: 'https://example.test/article', text: 'This article examines the history of internet censorship.',
      metadata: { title: 'Access denied: the history of internet censorship' } }],
  })).toBe(true);
  expect(crawlResultUsable('extract.structured@1', {
    engine: 'fixture', query: 'https://example.test/block', totalItems: 1,
    items: [{ engine: 'fixture', query: 'https://example.test/block', text: 'Access denied' }],
  })).toBe(false);
});

test('contract exhaustion reports every attempted supplier with safe failure codes', async () => {
  const empty = provider('empty-free', 'free', async () => null);
  const broken = { ...provider('broken-byok', 'byok', async () => { throw new Error('secret-bearing detail'); }), keyEnv: [] };
  let failure: unknown;
  try { await extractScrapViaGraph({ url: 'https://example.test/article' }, { providers: [broken, empty] }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(CrawlContractExhaustedError);
  expect((failure as CrawlContractExhaustedError).attempts).toEqual([
    { provider: 'empty-free-extract-structured-1', reason: 'empty' },
    { provider: 'broken-byok-extract-structured-1', reason: 'provider-error' },
  ]);
  expect(String(failure)).not.toContain('secret-bearing');
});

test('ineligible BYOK-only extraction reports an exhausted contract with no attempts', async () => {
  const previous = process.env.CRAWL_MISSING_TEST_KEY;
  delete process.env.CRAWL_MISSING_TEST_KEY;
  try {
    const keyed = { ...provider('keyed-only', 'byok', async query => result('keyed-only', query)),
      keyEnv: ['CRAWL_MISSING_TEST_KEY'] };
    await expect(extractScrapViaGraph({ url: 'https://example.test/article' }, { providers: [keyed] }))
      .rejects.toMatchObject({ name: 'CrawlContractExhaustedError', contractId: 'extract.structured@1', attempts: [] });
  } finally {
    if (previous === undefined) delete process.env.CRAWL_MISSING_TEST_KEY;
    else process.env.CRAWL_MISSING_TEST_KEY = previous;
  }
});

test('graph supplier reads the same node-overridden social input used for condition matching', async () => {
  const calls: string[] = [];
  const social = (site: 'reddit' | 'x'): CrawlProvider => ({
    id: `${site}-fixture`, provides: ['social.posts@1'], tier: 'free', latency: 1,
    keyEnv: [], conditions: { socialSite: site }, available: () => true,
    run: async (query, context) => {
      calls.push(`${site}:${query}:${context.socialSite}`);
      return result(site, `https://${site}.example.test/post`);
    },
  });
  const output = await dispatchGraphContract('social.posts@1', {
    graphId: 'social-contract', runId: 'run', nodeId: 'posts', outputs: {},
    input: { query: 'shared', socialSite: 'reddit' },
    nodeInput: { query: 'overridden', socialSite: 'x' },
  }, createCrawlGraphRegistry([social('reddit'), social('x')]));
  expect(output).toMatchObject({ ok: true, evidence: { provider: 'x-fixture' } });
  expect(calls).toEqual(['x:overridden:x']);
});

test('alternative key variables register one provider and invoke it once', async () => {
  const beforeA = process.env.CRAWL_TEST_KEY_A;
  const beforeB = process.env.CRAWL_TEST_KEY_B;
  process.env.CRAWL_TEST_KEY_A = 'fixture-a';
  process.env.CRAWL_TEST_KEY_B = 'fixture-b';
  try {
    let calls = 0;
    const keyed = { ...provider('multi-key', 'byok', async query => { calls++; return result('multi-key', query); }),
      keyEnv: ['CRAWL_TEST_KEY_A', 'CRAWL_TEST_KEY_B'] };
    const registry = createCrawlGraphRegistry([keyed]);
    expect(registry.providers.filter(item => item.provides.includes('extract.structured@1'))).toHaveLength(1);
    expect((await extractScrapViaGraph({ url: 'https://example.test/article' }, { providers: [keyed] })).provider).toBe('multi-key');
    expect(calls).toBe(1);
  } finally {
    if (beforeA === undefined) delete process.env.CRAWL_TEST_KEY_A; else process.env.CRAWL_TEST_KEY_A = beforeA;
    if (beforeB === undefined) delete process.env.CRAWL_TEST_KEY_B; else process.env.CRAWL_TEST_KEY_B = beforeB;
  }
});

test('every contract is declared and keyless adapters rank ahead of BYOK', () => {
  for (const contract of CRAWL_CONTRACTS) expect(CRAWL_PROVIDERS.some(item => item.provides.includes(contract))).toBe(true);
  for (const provider of CRAWL_PROVIDERS) {
    expect(['free', 'byok', 'paid']).toContain(provider.tier);
    expect(Number.isFinite(provider.latency)).toBe(true);
    if (provider.tier === 'free') expect(provider.keyEnv).toEqual([]);
    else expect(provider.keyEnv).not.toEqual([]);
  }
  const listed = matchingCrawlProviders('scrape.url@1', [
    provider('paid', 'byok', async () => null), provider('free', 'free', async () => null),
  ]);
  expect(listed.map(item => item.id)).toEqual(['free', 'paid']);
});

test('KAIST web, X and YouTube scraps extract through the same required contract', async () => {
  const seen: string[] = [];
  const fake = provider('fixture', 'free', async query => { seen.push(query); return result('fixture', query); });
  for (const url of ['https://example.test/article', 'https://x.com/user/status/1', 'https://www.youtube.com/watch?v=abc']) {
    const extracted = await extractScrapViaGraph({ url }, { providers: [fake] });
    expect(extracted).toMatchObject({ url, title: 'fixture title', provider: 'fixture' });
  }
  expect(seen).toHaveLength(3);
  const registry = createCrawlGraphRegistry([fake]);
  expect(registry.contracts['extract.structured@1']).toBeDefined();
  expect(registry.providers.find(item => item.provides.includes('extract.structured@1'))).toMatchObject({
    tier: 'free', latency: 1, keyEnv: [],
  });
});

test('KAIST graph requires extract.structured@1 and consumes the registered crawl contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crawl-contract-graph-'));
  try {
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    const graph = join(root, 'graph.yaml');
    writeFileSync(graph, `graph_id: kaist-crawl-contract\nversion: 1\nentry_node: extract\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: extract, kind: capability, recipe: none, requires: extract.structured@1, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: extract, on: outcome, map: { done: done, failed: failed } }\n`);
    const fake = provider('fixture', 'free', async query => result('fixture', query));
    const capabilityProviders = createCrawlGraphRegistry([fake]);
    for (const url of ['https://example.test/article', 'https://x.com/user/status/1', 'https://www.youtube.com/watch?v=abc']) {
      const state = await runGraph(graph, { input: { url }, quiet: true, deps: { root: join(root, crypto.randomUUID()), capabilityProviders } });
      expect(state.status).toBe('done');
      expect(JSON.parse(state.nodes[0]!.output as string)).toMatchObject({ result: { url, provider: 'fixture' }, evidence: { provider: 'fixture' } });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
