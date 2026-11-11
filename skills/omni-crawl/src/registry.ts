/**
 * 프로바이더 레지스트리 — 엔진 디스패치를 switch 하드코딩에서 디스크립터 등록으로 전환
 *
 * deer-flow 의 config `use: module:function` 플러그인 패턴에 대응하는 TS 버전.
 * 신규 프로바이더 추가 = REGISTRY 에 디스크립터 1개 등록 (main.ts switch 수정 불필요).
 * 각 디스크립터는 capability(표시), provides(버전 계약), tier, keyEnv, conditions,
 * available(), run()을 선언한다. 자동 선택은 무료부터 시작해 빈 결과 때 BYOK로 진행한다.
 */

import type { CrawlResult, CrawlItem, SearchEngine } from './types.js';
import { searchTavily } from './tavily.js';
import { searchFirecrawl, searchDeveloperFirecrawl, scrapeFirecrawl, agentFirecrawl, mapFirecrawl, crawlSiteFirecrawl } from './firecrawl.js';
import { searchApifyTweets, apifyAvailable } from './apify.js';
import { searchGrok } from './grok-search.js';
import { searchDdg, fetchJina, fetchDirectReadable } from './free.js';
import { captureScreenshot } from './capture.js';
import { validatePublicHttpUrl } from './url-safety.js';

export type Capability =
  | 'web-search' | 'news' | 'community' | 'tweets'
  | 'scrape' | 'crawl' | 'map' | 'agent' | 'capture'
  | 'dev-index';

export type CrawlContract = 'search.web@1' | 'search.news@1' | 'scrape.url@1' | 'crawl.site@1'
  | 'social.posts@1'
  | 'search.developer@1' | 'map.site@1' | 'extract.agent@1' | 'capture.url@1';
export type SocialSite = 'x' | 'reddit' | 'community';

export interface EngineCtx {
  limit: number;
  depth: 'basic' | 'advanced';
  timeRange?: string;
  minFavs: number;
  maxItems: number;
  lang: string;
  allowPrivate?: boolean;
  captureFullPage?: boolean;
  socialSite?: SocialSite;
}

export interface EngineDescriptor {
  id: string;
  capability: Capability;
  provides: readonly CrawlContract[];
  tier: 'paid' | 'byok' | 'free';
  latency?: number;
  /** Alternative key names: any one is enough. */
  keyEnv: readonly string[];
  conditions?: { socialSite?: SocialSite };
  supportsTimeRange?: boolean;
  /** Non-key runtime prerequisites only. */
  available(): boolean;
  run(query: string, ctx: EngineCtx, contract?: CrawlContract): Promise<CrawlResult | null>;
}

function tbsFromTimeRange(tr?: string): string | undefined {
  if (!tr) return undefined;
  return ({ day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' } as Record<string, string>)[tr];
}

function pageResult(id: string, url: string, page: { title: string; content: string } | null): CrawlResult | null {
  return page ? { engine: id, query: url, items: [{ engine: id, query: url, url, text: page.content, metadata: { title: page.title } }], totalItems: 1 } : null;
}

// ── 디스크립터 정의 ──
const DESCRIPTORS: EngineDescriptor[] = [
  {
    id: 'tavily', capability: 'web-search', provides: ['search.web@1'], tier: 'byok', latency: 10_000, keyEnv: ['TAVILY_KEY', 'TAVILY_API_KEY'],
    available: () => true,
    run: (q, c) => searchTavily(q, { depth: c.depth, maxResults: c.limit, timeRange: c.timeRange }),
  },
  {
    id: 'tavily-news', capability: 'news', provides: ['search.news@1'], tier: 'byok', latency: 10_000, keyEnv: ['TAVILY_KEY', 'TAVILY_API_KEY'], supportsTimeRange: true,
    available: () => true,
    run: (q, c) => searchTavily(q, { depth: c.depth, topic: 'news', maxResults: c.limit, timeRange: c.timeRange ?? 'week' }),
  },
  {
    id: 'firecrawl', capability: 'scrape', provides: ['search.web@1'], tier: 'byok', latency: 20_000, keyEnv: ['FIRECRAWL_API_KEY'],
    available: () => true,
    run: (q, c) => searchFirecrawl(q, { limit: c.limit, scrape: true }),
  },
  {
    id: 'fc-scrape', capability: 'scrape', provides: ['scrape.url@1'], tier: 'byok', latency: 20_000, keyEnv: ['FIRECRAWL_API_KEY'],
    available: () => true,
    run: async (url, c) => {
      if (await validatePublicHttpUrl(url, { action: 'fetch', allowPrivate: c.allowPrivate })) return null;
      return pageResult('fc-scrape', url, await scrapeFirecrawl(url, { maxAge: c.depth === 'advanced' ? 2 * 3600_000 : undefined }));
    },
  },
  {
    // 개발자 인덱스 — 패시지를 직접 주므로 스크랩 추가 콜이 필요 없다.
    id: 'fc-dev', capability: 'dev-index', provides: ['search.developer@1'], tier: 'byok', latency: 20_000, keyEnv: ['FIRECRAWL_API_KEY'],
    available: () => true,
    // --limit 을 그대로 존중한다(k). deep 모드는 k=10 을 명시로 넘긴다.
    run: (q, c) => searchDeveloperFirecrawl(q, { k: c.limit, passages: 2 }),
  },
  {
    id: 'fc-news', capability: 'news', provides: ['search.news@1'], tier: 'byok', latency: 20_000, keyEnv: ['FIRECRAWL_API_KEY'], supportsTimeRange: true,
    available: () => true,
    run: (q, c) => searchFirecrawl(q, { limit: c.limit, sources: ['news'], tbs: tbsFromTimeRange(c.timeRange) }),
  },
  {
    id: 'fc-crawl', capability: 'crawl', provides: ['crawl.site@1'], tier: 'byok', latency: 30_000, keyEnv: ['FIRECRAWL_API_KEY'],
    available: () => true,
    run: async (q, c) => {
      const err = await validatePublicHttpUrl(q, { action: 'crawl', allowPrivate: c.allowPrivate });
      if (err) { console.log(`  [fc-crawl] 차단: ${err}`); return null; }
      const docs = await crawlSiteFirecrawl(q, { limit: 10 });
      return {
        engine: 'fc-crawl', query: q,
        items: docs.map((d): CrawlItem => ({ engine: 'fc-crawl', query: q, url: d.url, text: d.content.slice(0, 4000), metadata: { title: d.title } })),
        totalItems: docs.length,
      };
    },
  },
  {
    id: 'fc-agent', capability: 'agent', provides: ['extract.agent@1'], tier: 'byok', latency: 120_000, keyEnv: ['FIRECRAWL_API_KEY'],
    available: () => true,
    run: async (q) => {
      const result = agentFirecrawl(q, { timeout: 120 });
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      return {
        engine: 'fc-agent', query: q,
        items: [{ engine: 'fc-agent', query: q, text, metadata: { status: result.status, steps: result.totalSteps } }],
        totalItems: 1,
      };
    },
  },
  {
    id: 'fc-map', capability: 'map', provides: ['map.site@1'], tier: 'byok', latency: 30_000, keyEnv: ['FIRECRAWL_API_KEY'],
    available: () => true,
    run: async (q, c) => {
      const err = await validatePublicHttpUrl(q, { action: 'map', allowPrivate: c.allowPrivate });
      if (err) { console.log(`  [fc-map] 차단: ${err}`); return null; }
      const urls = await mapFirecrawl(q, { limit: 50 });
      return {
        engine: 'fc-map', query: q,
        items: urls.map((url): CrawlItem => ({ engine: 'fc-map', query: q, url, text: url })),
        totalItems: urls.length,
      };
    },
  },
  {
    id: 'apify', capability: 'tweets', provides: ['social.posts@1'], tier: 'byok', latency: 30_000, keyEnv: ['APIFY_TOKEN'], conditions: { socialSite: 'x' },
    available: apifyAvailable,
    run: (q, c) => searchApifyTweets({ query: q, minFavs: c.minFavs, maxItems: c.maxItems, lang: c.lang }),
  },
  { id: 'grok-x', capability: 'community', provides: ['social.posts@1'], tier: 'byok', latency: 20_000, keyEnv: ['XAI_API_KEY'], conditions: { socialSite: 'x' }, available: () => true, run: (q) => searchGrok({ query: q, mode: 'x' }) },
  { id: 'grok-web', capability: 'web-search', provides: ['search.web@1'], tier: 'byok', latency: 20_000, keyEnv: ['XAI_API_KEY'], available: () => true, run: (q) => searchGrok({ query: q, mode: 'web' }) },
  { id: 'grok-reddit', capability: 'community', provides: ['social.posts@1'], tier: 'byok', latency: 20_000, keyEnv: ['XAI_API_KEY'], conditions: { socialSite: 'reddit' }, available: () => true, run: (q) => searchGrok({ query: q, mode: 'reddit' }) },
  { id: 'grok-community', capability: 'community', provides: ['social.posts@1'], tier: 'byok', latency: 20_000, keyEnv: ['XAI_API_KEY'], conditions: { socialSite: 'community' }, available: () => true, run: (q) => searchGrok({ query: q, mode: 'community' }) },
  // ⛔ 'both' 는 이름과 달리 «X+레딧» 이 아니라 **X+열린 웹** 이다 (grok-search.ts buildTools:
  //    community = x_search + web_search(allowed_domains:[reddit.com]) / both = x_search + web_search «무제한»).
  //    여론 축이 아니라 여론·문서 양다리라 capability 는 web-search 다 — 2026-09-06 정정
  //    (옛 'community' 오분류 · 라우터는 이 엔진을 자동 선택하지 않고 소비자 0곳이라 무영향).
  { id: 'grok-both', capability: 'web-search', provides: [], tier: 'byok', latency: 20_000, keyEnv: ['XAI_API_KEY'], available: () => true, run: (q) => searchGrok({ query: q, mode: 'both' }) },

  // ── 무료 티어 (키 불필요) ──
  {
    id: 'ddg', capability: 'web-search', provides: ['search.web@1', 'search.news@1'], tier: 'free', latency: 15_000, keyEnv: [],
    available: () => true,
    run: (q, c, contract) => searchDdg(contract === 'search.news@1' ? `${q} news` : q, { maxResults: c.limit }),
  },
  {
    id: 'ddg-social', capability: 'community', provides: ['social.posts@1'], tier: 'free', latency: 15_000, keyEnv: [],
    available: () => true,
    run: (q, c) => searchDdg(`${q} ${c.socialSite === 'reddit' ? 'site:reddit.com' : c.socialSite === 'x' ? 'site:x.com' : '(site:x.com OR site:reddit.com)'}`, { maxResults: c.limit }),
  },
  {
    id: 'jina-reader', capability: 'scrape', provides: ['scrape.url@1'], tier: 'free', latency: 25_000, keyEnv: [],
    available: () => true,
    run: async (url, c) => pageResult('jina-reader', url, await fetchJina(url, { allowPrivate: c.allowPrivate })),
  },
  {
    id: 'local-readability', capability: 'scrape', provides: ['scrape.url@1'], tier: 'free', latency: 30_000, keyEnv: [],
    available: () => true,
    run: async (url, c) => pageResult('local-readability', url, await fetchDirectReadable(url, { allowPrivate: c.allowPrivate })),
  },
  // ── web_capture (스크린샷 아티팩트) ──
  {
    id: 'capture', capability: 'capture', provides: ['capture.url@1'], tier: 'free', latency: 10_000, keyEnv: [],
    available: () => true,
    run: async (q, c) => {
      const shot = await captureScreenshot(q, { fullPage: c.captureFullPage ?? true, allowPrivate: c.allowPrivate });
      if (!shot) return { engine: 'capture', query: q, items: [], totalItems: 0 };
      return {
        engine: 'capture', query: q,
        items: [{ engine: 'capture', query: q, url: q, text: `스크린샷 저장: ${shot.path}`, metadata: { title: `📸 ${q}`, path: shot.path, method: shot.method, bytes: shot.bytes } }],
        totalItems: 1,
        costNote: 'capture 무료(로컬 Chrome)',
      };
    },
  },
];

export const REGISTRY = new Map<string, EngineDescriptor>(DESCRIPTORS.map(d => [d.id, d]));

/** 신규 프로바이더 등록점 (예: exa/brave/serper 추가 시 여기로). */
export function registerEngine(d: EngineDescriptor): void { REGISTRY.set(d.id, d); }

export function getEngine(id: string): EngineDescriptor | undefined { return REGISTRY.get(id); }

/** Legacy free lookup for callers that still use the old capability labels. */
export function freeFallbackFor(capability: Capability): EngineDescriptor | undefined {
  for (const d of REGISTRY.values()) if (d.capability === capability && d.tier === 'free' && d.available()) return d;
  return undefined;
}

export interface ContractRequest { contract: CrawlContract; conditions?: { socialSite?: SocialSite }; freeOnly?: boolean; timeRange?: string }
export interface ContractAttempt { provider: string; reason: 'empty' | 'provider-error' }
export class CrawlContractExhaustedError extends Error {
  constructor(readonly contract: CrawlContract, readonly attempts: readonly ContractAttempt[]) {
    super(`crawl contract ${contract} exhausted`);
    this.name = 'CrawlContractExhaustedError';
  }
}

const tierOrder = { free: 0, byok: 1, paid: 2 } as const;
export function matchingEngines(
  request: ContractRequest,
  descriptors: readonly EngineDescriptor[] = [...REGISTRY.values()],
  env: Readonly<Record<string, string | undefined>> = process.env,
): EngineDescriptor[] {
  return descriptors.filter(d => d.provides.includes(request.contract)
    && (request.contract !== 'search.news@1' || !request.timeRange || d.supportsTimeRange === true)
    && (!request.freeOnly || d.tier === 'free')
    && (!d.keyEnv.length || d.keyEnv.some(name => Boolean(env[name]?.trim())))
    && (!d.conditions || Object.entries(d.conditions).every(([key, expected]) =>
      request.conditions?.[key as keyof NonNullable<ContractRequest['conditions']>] === expected))
    && d.available())
    .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]
      || (a.latency ?? Number.POSITIVE_INFINITY) - (b.latency ?? Number.POSITIVE_INFINITY)
      || a.id.localeCompare(b.id));
}

/** One contract invocation; empty/error suppliers fall through once in declaration-independent order. */
export async function runCapability(
  request: ContractRequest, query: string, ctx: EngineCtx,
  descriptors: readonly EngineDescriptor[] = [...REGISTRY.values()],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ provider: string; result: CrawlResult; attempts: ContractAttempt[] }> {
  const attempts: ContractAttempt[] = [];
  const effectiveRequest = request.contract === 'search.news@1' && !request.timeRange && ctx.timeRange
    ? { ...request, timeRange: ctx.timeRange } : request;
  const mergedCtx = { ...ctx, ...request.conditions, ...(request.timeRange ? { timeRange: request.timeRange } : {}) };
  for (const d of matchingEngines(effectiveRequest, descriptors, env)) {
    try {
      const result = await d.run(query, mergedCtx, request.contract);
      const usable = result && (request.contract === 'scrape.url@1'
        ? result.items.some(item => item.text?.trim())
        : result.totalItems > 0 || Boolean(result.rawText?.trim()));
      if (usable && result)
        return { provider: d.id, result, attempts };
      attempts.push({ provider: d.id, reason: 'empty' });
    } catch {
      attempts.push({ provider: d.id, reason: 'provider-error' });
    }
  }
  throw new CrawlContractExhaustedError(request.contract, attempts);
}

/** 레지스트리 기반 엔진 실행 (main.ts runEngine 대체). */
export async function runRegisteredEngine(engine: SearchEngine, query: string, ctx: EngineCtx): Promise<CrawlResult | null> {
  if (engine === 'all') return null;
  const d = getEngine(engine);
  if (!d) { console.log(`  ⚠ 알 수 없는 엔진: ${engine}`); return null; }
  return d.run(query, ctx);
}
