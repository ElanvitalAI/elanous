/** Versioned web collection contracts over the existing omni-crawl adapters. */
import type { CrawlResult } from '../../skills/omni-crawl/src/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { searchDdg, fetchJina, fetchDirectReadable } from '../../skills/omni-crawl/src/free.js';
import { searchTavily, extractTavily } from '../../skills/omni-crawl/src/tavily.js';
import { searchFirecrawl, scrapeFirecrawl, crawlSiteFirecrawl } from '../../skills/omni-crawl/src/firecrawl.js';
import { searchGrok } from '../../skills/omni-crawl/src/grok-search.js';
import { searchApifyTweets } from '../../skills/omni-crawl/src/apify.js';
import { buildExaWebSearchProvider } from '../web-search/exa.js';
import { validatePublicHttpUrl } from '../../skills/omni-crawl/src/url-safety.js';
import { searchRedditPublicPosts } from './reddit.js';

export const CRAWL_CONTRACTS = [
  'search.web@1', 'search.news@1', 'scrape.url@1', 'crawl.site@1',
  'extract.structured@1', 'social.posts@1', 'research.deep@1',
] as const;
export type CrawlContract = typeof CRAWL_CONTRACTS[number];
export type CrawlTier = 'free' | 'byok' | 'paid';
export interface CrawlContext { limit?: number; allowPrivate?: boolean; socialSite?: 'x' | 'reddit' }
export interface CrawlProvider {
  id: string;
  provides: readonly CrawlContract[];
  tier: CrawlTier;
  /** Expected milliseconds, used only for stable ranking within a tier. */
  latency: number;
  keyEnv: readonly string[];
  conditions?: Readonly<Record<string, unknown>>;
  available(): boolean;
  run(query: string, context: CrawlContext, contract: CrawlContract): Promise<CrawlResult | null>;
}

function result(id: string, query: string, title: string, content: string): CrawlResult {
  return { engine: id, query, items: [{ engine: id, query, url: query, text: content, metadata: { title } }], totalItems: 1 };
}
const keyed = (...names: string[]) => names.some(name => Boolean(process.env[name]?.trim()));
const execFileAsync = promisify(execFile);
const deepScript = fileURLToPath(new URL('../../skills/omni-crawl/scripts/main.ts', import.meta.url));
async function runExistingDeepResearch(query: string): Promise<CrawlResult | null> {
  const { stdout } = await execFileAsync(process.execPath, [deepScript, query, '--mode', 'deep', '--json', '--no-save'], { timeout: 180_000, maxBuffer: 12_000_000 });
  const start = stdout.indexOf('---BEGIN_OMNI_CRAWL_JSON---');
  const end = stdout.indexOf('---END_OMNI_CRAWL_JSON---', start);
  if (start < 0 || end < 0) throw new Error('omni-crawl deep output has no JSON markers');
  const payload = JSON.parse(stdout.slice(start + '---BEGIN_OMNI_CRAWL_JSON---'.length, end)) as { results: Array<{ items: Array<{ url?: string; title?: string; text: string }> }> };
  const items = payload.results.flatMap(entry => entry.items.map(item => ({ engine: 'omni-crawl-deep', query, url: item.url, text: item.text, metadata: { title: item.title } })));
  return { engine: 'omni-crawl-deep', query, items, totalItems: items.length };
}
const page = (id: string, fn: (url: string, options: { allowPrivate?: boolean }) => Promise<{ title: string; content: string } | null>) =>
  async (url: string, context: CrawlContext): Promise<CrawlResult | null> => {
    const data = await fn(url, { allowPrivate: context.allowPrivate });
    return data ? result(id, url, data.title, data.content) : null;
  };

/** Registration order has no ranking effect; selection uses declared tier and latency. */
export const CRAWL_PROVIDERS: readonly CrawlProvider[] = [
  { id: 'reddit-json', provides: ['social.posts@1'], tier: 'free', latency: 10000, keyEnv: [], conditions: { socialSite: 'reddit' }, available: () => true,
    run: (query, context) => searchRedditPublicPosts(query, { limit: context.limit }) },
  { id: 'ddg', provides: ['search.web@1', 'search.news@1', 'social.posts@1'], tier: 'free', latency: 15000, keyEnv: [], available: () => true,
    run: (query, context, contract) => searchDdg(contract === 'search.news@1' ? `${query} news` : contract === 'social.posts@1' ? `${query} site:${context.socialSite === 'reddit' ? 'reddit.com' : 'x.com'}` : query, { maxResults: context.limit ?? 5 }) },
  { id: 'jina-reader', provides: ['scrape.url@1', 'extract.structured@1'], tier: 'free', latency: 25000, keyEnv: [], available: () => true,
    run: (url, context) => page('jina-reader', fetchJina)(url, context) },
  { id: 'local-readability', provides: ['scrape.url@1', 'extract.structured@1'], tier: 'free', latency: 30000, keyEnv: [], available: () => true,
    run: (url, context) => page('local-readability', fetchDirectReadable)(url, context) },
  { id: 'tavily', provides: ['search.web@1', 'search.news@1', 'scrape.url@1'], tier: 'byok', latency: 10000, keyEnv: ['TAVILY_KEY', 'TAVILY_API_KEY'], available: () => keyed('TAVILY_KEY', 'TAVILY_API_KEY'),
    run: async (query, context, contract) => {
      if (contract === 'scrape.url@1') {
        if (await validatePublicHttpUrl(query, { action: 'fetch', allowPrivate: context.allowPrivate })) return null;
        const item = (await extractTavily([query]))[0];
        return item ? result('tavily', item.url, item.url, item.content) : null;
      }
      return searchTavily(query, { depth: 'basic', topic: contract === 'search.news@1' ? 'news' : undefined, maxResults: context.limit ?? 5 });
    } },
  { id: 'firecrawl', provides: ['search.web@1', 'search.news@1', 'scrape.url@1', 'crawl.site@1', 'extract.structured@1'], tier: 'byok', latency: 20000, keyEnv: ['FIRECRAWL_API_KEY'], available: () => keyed('FIRECRAWL_API_KEY'),
    run: async (query, context, contract) => {
      if (contract === 'scrape.url@1' || contract === 'extract.structured@1') {
        const item = await scrapeFirecrawl(query);
        return item ? result('firecrawl', query, item.title, item.content) : null;
      }
      if (contract === 'crawl.site@1') {
        if (await validatePublicHttpUrl(query, { action: 'crawl', allowPrivate: context.allowPrivate })) return null;
        const docs = await crawlSiteFirecrawl(query, { limit: context.limit ?? 10 });
        return { engine: 'firecrawl', query, items: docs.map(doc => ({ engine: 'firecrawl', query, url: doc.url, text: doc.content, metadata: { title: doc.title } })), totalItems: docs.length };
      }
      return searchFirecrawl(query, { limit: context.limit ?? 5, sources: contract === 'search.news@1' ? ['news'] : undefined });
    } },
  { id: 'exa', provides: ['search.web@1'], tier: 'byok', latency: 4500, keyEnv: ['EXA_API_KEY'], available: () => buildExaWebSearchProvider().available(),
    run: async (query, context) => {
      const response = await buildExaWebSearchProvider().search({ query, limit: context.limit ?? 5 });
      return { engine: 'exa', query, items: response.hits.map(hit => ({ engine: 'exa', query, url: hit.url, text: hit.snippet, metadata: { title: hit.title } })), totalItems: response.hits.length };
    } },
  { id: 'grok', provides: ['search.web@1', 'social.posts@1'], tier: 'byok', latency: 20000, keyEnv: ['XAI_API_KEY'], available: () => keyed('XAI_API_KEY'),
    run: (query, context, contract) => searchGrok({ query, mode: contract === 'social.posts@1' ? context.socialSite === 'reddit' ? 'reddit' : 'x' : 'web' }) },
  { id: 'apify', provides: ['social.posts@1'], tier: 'byok', latency: 30000, keyEnv: ['APIFY_TOKEN'], conditions: { socialSite: 'x' }, available: () => keyed('APIFY_TOKEN'),
    run: (query, context) => context.socialSite === 'reddit' ? Promise.resolve(null) : searchApifyTweets({ query, maxItems: context.limit ?? 20 }) },
  { id: 'omni-crawl-deep', provides: ['research.deep@1'], tier: 'byok', latency: 180000, keyEnv: ['TAVILY_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY', 'XAI_API_KEY'],
    available: () => keyed('TAVILY_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY', 'XAI_API_KEY'), run: query => runExistingDeepResearch(query) },
];

const tierRank: Record<CrawlTier, number> = { free: 0, byok: 1, paid: 2 };
export function matchingCrawlProviders(requires: CrawlContract, providers: readonly CrawlProvider[] = CRAWL_PROVIDERS, context: CrawlContext = {}): CrawlProvider[] {
  if (!(CRAWL_CONTRACTS as readonly string[]).includes(requires)) throw new Error(`unknown crawl contract: ${requires}`);
  return providers.filter(provider => provider.provides.includes(requires) && provider.available()
    && (!provider.conditions || Object.entries(provider.conditions).every(([key, expected]) => context[key as keyof CrawlContext] === expected)))
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || a.latency - b.latency || a.id.localeCompare(b.id));
}

export function crawlResultUsable(requires: CrawlContract, output: CrawlResult | null): output is CrawlResult {
  if (!output) return false;
  if (requires === 'extract.structured@1' || requires === 'scrape.url@1')
    return output.items.some(item => {
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!text) return false;
      // Match short blocker messages in the body itself; article titles may legitimately discuss access denial.
      return !(text.length < 300 && /^(?:access denied(?:\.(?:\s|$)|$)|403 forbidden(?:\s|$)|just a moment(?:\s|$)|please enable javascript(?:\s|$)|robot check(?:\s|$)|you have been blocked(?:\s|$))/i.test(text));
    });
  return output.totalItems > 0 || Boolean(output.rawText?.trim());
}

export async function executeCrawlCapability(requires: CrawlContract, query: string, context: CrawlContext = {}, providers: readonly CrawlProvider[] = CRAWL_PROVIDERS): Promise<{ provider: CrawlProvider; result: CrawlResult }> {
  const failures: string[] = [];
  for (const provider of matchingCrawlProviders(requires, providers, context)) {
    try {
      const output = await provider.run(query, context, requires);
      if (crawlResultUsable(requires, output)) return { provider, result: output };
      failures.push(`${provider.id}: empty`);
    } catch (error) { failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  throw new Error(`crawl contract ${requires} unavailable: ${failures.join('; ') || 'no available provider'}`);
}
