import type { SearchEngine, CrawlDecision, RunMode } from './types.js';
import type { ContractRequest } from './registry.js';

export interface RouterInput {
  intentText: string;
  forceEngines?: string;
  forceMode?: string;
  forceFree?: boolean;
  query: string;
}

/** Intent chooses required abilities. Supplier names are reserved for explicit --engine. */
export function decideCrawl(input: RouterInput): CrawlDecision {
  const rawText = (input.intentText || '').trim();
  const url = (() => { try { const value = new URL(input.query); return value.protocol === 'http:' || value.protocol === 'https:'; } catch { return false; } })();
  // The URL is data. Only words outside it may express an explicit operation.
  const text = url ? rawText.split(input.query).join(' ').trim() : rawText;
  const reasons: string[] = [];
  const engines: SearchEngine[] = [];
  const requires: ContractRequest[] = [];
  let mode: RunMode = 'auto';
  if (input.forceMode === 'deep' || /딥\s*리서치|deep\s*research|심층\s*(분석|리서치|조사)|종합\s*리포트|보고서\s*수준/i.test(text)) {
    mode = 'deep';
    reasons.push('deep research');
  }

  if (input.forceEngines) {
    engines.push(...input.forceEngines.split(',').map(e => e.trim()).filter(Boolean) as SearchEngine[]);
    reasons.push(`--engine ${input.forceEngines}`);
  } else if (mode !== 'deep') {
    const add = (contract: ContractRequest['contract'], conditions?: ContractRequest['conditions']) =>
      requires.push({ contract, ...(conditions ? { conditions } : {}), ...(input.forceFree ? { freeOnly: true } : {}) });
    if (/스크린샷|screenshot|캡처(?!\s*금지)|capture|화면\s*(?:저장|이미지)/i.test(text)) add('capture.url@1');
    else if (/agent|추출|extract|데이터\s*수집|자동\s*수집/i.test(text)) add('extract.agent@1');
    else if (/사이트맵|sitemap|url\s*목록|구조\s*파악|\bmap\b/i.test(text)) add('map.site@1');
    else if (/사이트\s*전체|전체\s*크롤|whole\s*site|크롤링\s*전체/i.test(text)) add('crawl.site@1');
    else if (/이슈|issue|풀\s*리퀘스트|pull\s*request|버그\s*(?:리포트|수정|픽스)|스택\s*트레이스|stack\s*trace|traceback|라이브러리|library|레포지토리|repository|깃허브|github|공식\s*문서|API\s*(?:스펙|레퍼런스)|how\s+do\s+i|에러\s*메시지|error\s*message|개발자\s*(?:검색|인덱스)|dev[\s-]*index/i.test(text)) add('search.developer@1');
    else if (url) add('scrape.url@1');
    else if (/전체|all|모두|종합/i.test(text)) {
      add('search.web@1');
      add('social.posts@1', { socialSite: 'x' });
      add('social.posts@1', { socialSite: 'reddit' });
    } else if (/커뮤니티|community/i.test(text)) add('social.posts@1', { socialSite: 'community' });
    else {
      if (/X\s*검색|X에서|X\s*반응|트위터\s*검색|트윗|tweet|apify/i.test(text)) add('social.posts@1', { socialSite: 'x' });
      if (/레딧|reddit/i.test(text)) add('social.posts@1', { socialSite: 'reddit' });
      if (/뉴스|news|속보|기사/i.test(text)) add('search.news@1');
      if (/크롤|crawl|스크랩|scrape|풀\s*본문|본문\s*전체|pdf/i.test(text)) add('scrape.url@1');
      if (/반응|여론|실시간/i.test(text) && !requires.length) add('social.posts@1', { socialSite: 'community' });
    }
    if (!requires.length) add('search.web@1');
    reasons.push(...requires.map(r => r.contract + (r.conditions?.socialSite ? `:${r.conditions.socialSite}` : '')));
  }

  const digestAfter = /요약|digest|정리|분석|obsidian|저장/i.test(text);
  if (digestAfter) reasons.push('→ omni-digest');
  const digestFormat = /간단|짧게|essential|brief/i.test(text) ? 'essential'
    : /상세|깊게|rich(?!-card)/i.test(text) ? 'rich' : 'rich-cards';
  const saveAfter = /저장|save|obsidian/i.test(text);
  return { engines, requires, query: input.query, reason: reasons.join(', '), mode,
    digestAfter, digestFormat: digestAfter ? digestFormat : undefined, saveAfter };
}
