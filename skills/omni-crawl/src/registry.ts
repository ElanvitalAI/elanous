/**
 * 프로바이더 레지스트리 — 엔진 디스패치를 switch 하드코딩에서 디스크립터 등록으로 전환
 *
 * deer-flow 의 config `use: module:function` 플러그인 패턴에 대응하는 TS 버전.
 * 신규 프로바이더 추가 = REGISTRY 에 디스크립터 1개 등록 (main.ts switch 수정 불필요).
 * 각 디스크립터는 capability(역할) + tier(paid/free) + available() + run() 을 선언.
 *
 * tier 는 사용자 원칙("품질 동일 시 무료, 아니면 유료 우선")의 자동 폴백 근거:
 *   유료 엔진이 공백/미가용이면 같은 capability 의 free 엔진으로 강등 (main.ts).
 */

import type { CrawlResult, CrawlItem, SearchEngine } from './types.js';
import { searchTavily } from './tavily.js';
import { searchFirecrawl, searchDeveloperFirecrawl, agentFirecrawl, mapFirecrawl, crawlSiteFirecrawl } from './firecrawl.js';
import { searchApifyTweets, apifyAvailable } from './apify.js';
import { searchGrok } from './grok-search.js';
import { searchDdg } from './free.js';
import { captureScreenshot } from './capture.js';
import { validatePublicHttpUrl } from './url-safety.js';

export type Capability =
  | 'web-search' | 'news' | 'community' | 'tweets'
  | 'scrape' | 'crawl' | 'map' | 'agent' | 'capture'
  | 'dev-index';

export interface EngineCtx {
  limit: number;
  depth: 'basic' | 'advanced';
  timeRange?: string;
  minFavs: number;
  maxItems: number;
  lang: string;
  allowPrivate?: boolean;
  captureFullPage?: boolean;
}

export interface EngineDescriptor {
  id: string;
  capability: Capability;
  tier: 'paid' | 'free';
  /** 키/바이너리 등 전제조건 충족 여부 */
  available(): boolean;
  run(query: string, ctx: EngineCtx): Promise<CrawlResult | null>;
}

function tbsFromTimeRange(tr?: string): string | undefined {
  if (!tr) return undefined;
  return ({ day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' } as Record<string, string>)[tr];
}

function hasKey(name: string): boolean { return !!process.env[name]; }

// ── 디스크립터 정의 ──
const DESCRIPTORS: EngineDescriptor[] = [
  {
    id: 'tavily', capability: 'web-search', tier: 'paid',
    available: () => hasKey('TAVILY_KEY') || hasKey('TAVILY_API_KEY'),
    run: (q, c) => searchTavily(q, { depth: c.depth, maxResults: c.limit, timeRange: c.timeRange }),
  },
  {
    id: 'tavily-news', capability: 'news', tier: 'paid',
    available: () => hasKey('TAVILY_KEY') || hasKey('TAVILY_API_KEY'),
    run: (q, c) => searchTavily(q, { depth: c.depth, topic: 'news', maxResults: c.limit, timeRange: c.timeRange ?? 'week' }),
  },
  {
    id: 'firecrawl', capability: 'scrape', tier: 'paid',
    available: () => hasKey('FIRECRAWL_API_KEY'),
    run: (q, c) => searchFirecrawl(q, { limit: c.limit, scrape: true }),
  },
  {
    // 개발자 인덱스 — 패시지를 직접 주므로 스크랩 추가 콜이 필요 없다.
    id: 'fc-dev', capability: 'dev-index', tier: 'paid',
    available: () => hasKey('FIRECRAWL_API_KEY'),
    // --limit 을 그대로 존중한다(k). deep 모드는 k=10 을 명시로 넘긴다.
    run: (q, c) => searchDeveloperFirecrawl(q, { k: c.limit, passages: 2 }),
  },
  {
    id: 'fc-news', capability: 'news', tier: 'paid',
    available: () => hasKey('FIRECRAWL_API_KEY'),
    run: (q, c) => searchFirecrawl(q, { limit: c.limit, sources: ['news'], tbs: tbsFromTimeRange(c.timeRange) }),
  },
  {
    id: 'fc-crawl', capability: 'crawl', tier: 'paid',
    available: () => hasKey('FIRECRAWL_API_KEY'),
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
    id: 'fc-agent', capability: 'agent', tier: 'paid',
    available: () => hasKey('FIRECRAWL_API_KEY'),
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
    id: 'fc-map', capability: 'map', tier: 'paid',
    available: () => hasKey('FIRECRAWL_API_KEY'),
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
    id: 'apify', capability: 'tweets', tier: 'paid',
    available: apifyAvailable,
    run: (q, c) => searchApifyTweets({ query: q, minFavs: c.minFavs, maxItems: c.maxItems, lang: c.lang }),
  },
  { id: 'grok-x', capability: 'community', tier: 'paid', available: () => hasKey('XAI_API_KEY'), run: (q) => searchGrok({ query: q, mode: 'x' }) },
  { id: 'grok-web', capability: 'web-search', tier: 'paid', available: () => hasKey('XAI_API_KEY'), run: (q) => searchGrok({ query: q, mode: 'web' }) },
  { id: 'grok-reddit', capability: 'community', tier: 'paid', available: () => hasKey('XAI_API_KEY'), run: (q) => searchGrok({ query: q, mode: 'reddit' }) },
  { id: 'grok-community', capability: 'community', tier: 'paid', available: () => hasKey('XAI_API_KEY'), run: (q) => searchGrok({ query: q, mode: 'community' }) },
  // ⛔ 'both' 는 이름과 달리 «X+레딧» 이 아니라 **X+열린 웹** 이다 (grok-search.ts buildTools:
  //    community = x_search + web_search(allowed_domains:[reddit.com]) / both = x_search + web_search «무제한»).
  //    여론 축이 아니라 여론·문서 양다리라 capability 는 web-search 다 — 2026-09-06 정정
  //    (옛 'community' 오분류 · 라우터는 이 엔진을 자동 선택하지 않고 소비자 0곳이라 무영향).
  { id: 'grok-both', capability: 'web-search', tier: 'paid', available: () => hasKey('XAI_API_KEY'), run: (q) => searchGrok({ query: q, mode: 'both' }) },

  // ── 무료 티어 (키 불필요) ──
  {
    id: 'ddg', capability: 'web-search', tier: 'free',
    available: () => true,
    run: (q, c) => searchDdg(q, { maxResults: c.limit }),
  },
  // ── web_capture (스크린샷 아티팩트) ──
  {
    id: 'capture', capability: 'capture', tier: 'free',
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

/** capability 로 free 대체 엔진 찾기 (유료 공백 시 강등용). */
export function freeFallbackFor(capability: Capability): EngineDescriptor | undefined {
  for (const d of REGISTRY.values()) if (d.capability === capability && d.tier === 'free' && d.available()) return d;
  return undefined;
}

/** 레지스트리 기반 엔진 실행 (main.ts runEngine 대체). */
export async function runRegisteredEngine(engine: SearchEngine, query: string, ctx: EngineCtx): Promise<CrawlResult | null> {
  if (engine === 'all') return null;
  const d = getEngine(engine);
  if (!d) { console.log(`  ⚠ 알 수 없는 엔진: ${engine}`); return null; }
  return d.run(query, ctx);
}
