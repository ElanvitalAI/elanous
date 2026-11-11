/* ── Search engines ── */
import type { ContractRequest } from './registry.js';

export type SearchEngine =
  // 웹 검색 (일반·뉴스) — tavily 1순위
  | 'tavily' | 'tavily-news'
  // 크롤/스크랩/추출 — firecrawl REST
  | 'firecrawl' | 'fc-news' | 'fc-agent' | 'fc-map' | 'fc-crawl' | 'fc-scrape'
  // 개발자 인덱스 (README·문서·이슈·PR 아티팩트 — 코딩 질문 1차 출처)
  | 'fc-dev'
  // 커뮤니티 — grok (X/레딧 유일 커버)
  | 'grok-x' | 'grok-web' | 'grok-reddit' | 'grok-community' | 'grok-both'
  // X 트윗 벌크 (정량·필터)
  | 'apify'
  // 무료 티어 (키 불필요 — 유료 공백/--free 시 발동)
  | 'ddg' | 'ddg-social' | 'jina-reader' | 'local-readability'
  // web_capture (스크린샷 아티팩트)
  | 'capture'
  | 'all';

/* ── Run mode ── */

/** auto = 역할기반 라우팅 · deep = 다각도 검색+풀스크랩+커뮤니티 합성 파이프라인 */
export type RunMode = 'auto' | 'deep';

/* ── Grok search mode (검색 전용, 채팅은 omni-llm) ── */

export type GrokSearchMode = 'x' | 'web' | 'reddit' | 'community' | 'both';

/* ── Crawl result item ── */

export interface CrawlItem {
  engine: string;
  query: string;
  url?: string;
  author?: string;
  text: string;
  likes?: number;
  date?: string;
  metadata?: Record<string, any>;
}

/* ── Crawl result ── */

export interface CrawlResult {
  engine: string;
  query: string;
  items: CrawlItem[];
  rawText?: string;           // Grok/Tavily summary text
  annotations?: string[];     // Grok source URLs
  totalItems: number;
  /** 비용 가시성 (예: "tavily 2cr", "grok $0.03") — 파이프라인 예산 모니터링 */
  costNote?: string;
}

/* ── Route decision ── */

export interface CrawlDecision {
  engines: SearchEngine[];
  /** Auto routes select a capability contract; --engine keeps explicit engine IDs. */
  requires?: ContractRequest[];
  query: string;
  reason: string;
  mode: RunMode;
  /** Pass to omni-digest after crawl? */
  digestAfter: boolean;
  digestFormat?: string;
  /** Auto-save to Obsidian (intent에 "저장/save/obsidian" 키워드 감지 시) */
  saveAfter: boolean;
}

/* ── Pipeline result ── */

export interface PipelineResult {
  results: CrawlResult[];
  markdown: string;
  savedPath: string | null;
  signals: string[];
}
