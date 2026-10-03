import type { SearchEngine, CrawlDecision, RunMode } from './types.js';

/** tavily 상시 사용 스위치(공식 결정 2026-09-10 **기본 ON** · `OMNI_CRAWL_TAVILY=0` 으로 끈다).
 *
 *  ⛔ 2026-08-06 엔 비용 때문에 기본 OFF(= ddg 1순위)였는데, **DDG HTML 이 차단되면
 *  웹 검색 축이 통째로 0건**이 된다(폴백 체인의 `wantedWeb` 이 ddg 를 세지 않아 보충도 안 걸림).
 *  무료는 «돈 떨어졌을 때의 안전망»이지 1순위가 아니다 — `types.ts` 의 "tavily 1순위" 주석과
 *  `applyWebFallback` 의 "유료가 1순위·기본" 원칙으로 되돌린다. ddg 는 **폴백/`--free`/`--engine ddg` 전용**.
 *
 *  ⛔ `scripts/main.ts` 에서 import 하지 않고 여기서 다시 읽는다 — 순환 import 를 만들지 않기 위함이고,
 *  판정식은 **한 줄로 같다**(둘이 갈리면 라우팅과 실행이 어긋난다). */
function tavilyOn(): boolean { return (process.env.OMNI_CRAWL_TAVILY ?? '').trim() !== '0'; }
/** 기본 웹 검색 엔진 이름. ddg 는 여기서 절대 1순위가 되지 않는다(폴백 전용). */
function webEngine(): 'tavily' | 'ddg' { return tavilyOn() ? 'tavily' : 'ddg'; }

export interface RouterInput {
  intentText: string;
  forceEngines?: string;    // comma-separated
  forceMode?: string;       // --mode auto|deep
  forceFree?: boolean;      // --free (무료 티어 강제)
  query: string;
}

/**
 * 역할기반 라우팅 (2026-07-06 재편 — 구독 3종 역할 분담):
 *
 *   일반 웹 검색  → tavily        (공식 결정 2026-09-10 기본 ON · ddg 는 폴백 전용 · OMNI_CRAWL_TAVILY=0 로 역전)
 *   뉴스          → firecrawl(sources:news)
 *   크롤/스크랩   → firecrawl     (Standard 100k·풀본문·maxAge 캐시)
 *   커뮤니티/여론 → grok          (X/레딧 유일 커버 — 여기만 사용)
 *   트윗 벌크     → apify         (정량·좋아요 필터)
 *   딥 리서치     → deep 모드     (다각도 tavily + firecrawl 풀스크랩 + grok 합성)
 *
 * 비용 원칙: grok($0.03/콜)은 커뮤니티 유니크 커버리지에만. 무료 ddg 는 유료 공백 시의 안전망.
 */
export function decideCrawl(input: RouterInput): CrawlDecision {
  const text = (input.intentText || '').trim();
  const reasons: string[] = [];
  let engines: SearchEngine[] = [];
  let digestAfter = false;
  let digestFormat: string | undefined;
  let mode: RunMode = 'auto';

  // Mode: 명시 플래그 > 인텐트 감지
  if (input.forceMode === 'deep') { mode = 'deep'; reasons.push('--mode deep'); }
  else if (/딥\s*리서치|deep\s*research|심층\s*(분석|리서치|조사)|종합\s*리포트|보고서\s*수준/i.test(text)) {
    mode = 'deep'; reasons.push('딥리서치 인텐트');
  }

  // Force engines (deep 모드에서도 존중 — 파이프라인 강제 지정용)
  if (input.forceEngines) {
    engines = input.forceEngines.split(',').map(e => e.trim()) as SearchEngine[];
    reasons.push(`--engine ${input.forceEngines}`);
  } else if (input.forceFree && mode !== 'deep') {
    // --free: 무료 티어 강제 (품질 동일 시 무료 원칙 — 명시 opt-in). 캡처 인텐트는 예외.
    if (/스크린샷|screenshot|캡처|capture|화면\s*저장/i.test(text)) { engines = ['capture']; reasons.push('web_capture (스크린샷)'); }
    else { engines = ['ddg']; reasons.push('--free: ddg 무료 검색'); }
  } else if (mode === 'deep') {
    // deep 모드는 main.ts 오케스트레이션이 엔진 시퀀스를 소유
    engines = [];
  } else {
    // 역할 감지 (구체 → 일반 순서)
    if (/스크린샷|screenshot|캡처(?!\s*금지)|화면\s*저장|페이지\s*이미지/i.test(text)) { engines.push('capture'); reasons.push('web_capture (스크린샷)'); }
    else if (/agent|추출|extract|데이터\s*수집|자동\s*수집/i.test(text)) { engines.push('fc-agent'); reasons.push('firecrawl agent 데이터 추출'); }
    else if (/사이트맵|sitemap|url\s*목록|구조\s*파악|\bmap\b/i.test(text)) { engines.push('fc-map'); reasons.push('firecrawl map URL 탐색'); }
    else if (/사이트\s*전체|전체\s*크롤|whole\s*site|크롤링\s*전체/i.test(text)) { engines.push('fc-crawl'); reasons.push('firecrawl 사이트 크롤'); }
    // 개발자 질문(라이브러리 동작·에러 의미·버그 수정 여부)은 «아티팩트»가 1차 출처다.
    // 블로그가 서술한 동작보다 그 동작을 «정의한» README/문서/이슈/PR 패시지가 강한 답.
    else if (/이슈|issue|풀\s*리퀘스트|pull\s*request|버그\s*(리포트|수정|픽스)|스택\s*트레이스|stack\s*trace|traceback|라이브러리|library|레포지토리|repository|깃허브|github|공식\s*문서|API\s*(스펙|레퍼런스)|how\s+do\s+i|에러\s*메시지|error\s*message|개발자\s*(검색|인덱스)|dev[\s-]*index/i.test(text)) { engines.push('fc-dev'); reasons.push('개발자 인덱스(fc-dev)'); }
    else if (/전체|all|모두|종합/i.test(text)) { engines = [webEngine(), 'apify', 'grok-x', 'firecrawl']; reasons.push('전체 검색'); }
    else if (/커뮤니티|community/i.test(text)) { engines.push('grok-community'); reasons.push('커뮤니티 검색(grok)'); }
    else {
      if (/X\s*검색|X에서|X\s*반응|트위터\s*검색/i.test(text)) { engines.push('grok-x'); reasons.push('Grok X 검색'); }
      if (/트윗|tweet|apify/i.test(text)) { engines.push('apify'); reasons.push('X 트윗 벌크(apify)'); }
      if (/레딧|reddit/i.test(text)) { engines.push('grok-reddit'); reasons.push('레딧 검색(grok)'); }
      if (/뉴스|news|속보|기사/i.test(text)) {
        if (tavilyOn()) engines.push('tavily-news');
        engines.push('fc-news');
        reasons.push(tavilyOn() ? '뉴스: tavily-news + firecrawl(news)' : '뉴스: firecrawl(news)');
      }
      if (/크롤|crawl|스크랩|scrape|풀\s*본문|본문\s*전체|pdf/i.test(text)) { engines.push('firecrawl'); reasons.push('firecrawl 크롤/스크랩'); }
      if (/반응|여론|실시간/i.test(text) && engines.length === 0) { engines.push('grok-community'); reasons.push('커뮤니티 검색(grok)'); }
    }

    // ⛔⭐ 기본 웹 검색 엔진은 **스위치가 정한다**(공식 결정 2026-08-06 · 기본 OFF = 무료 ddg).
    //   ⚠️ 레지스트리에서 지우지 않았으므로 `--engine tavily` 명시 호출은 스위치와 무관하게 돈다
    //   (asset-attractiveness · research-bridge 의 CLI 계약 보존).
    if (engines.length === 0) { engines = [webEngine()]; reasons.push(`기본: ${webEngine()}`); }
  }

  // Digest after crawl?
  if (/요약|digest|정리|분석|obsidian|저장/i.test(text)) {
    digestAfter = true;
    reasons.push('→ omni-digest 연계');
    if (/간단|짧게|essential|brief/i.test(text)) digestFormat = 'essential';
    else if (/상세|깊게|rich(?!-card)/i.test(text)) digestFormat = 'rich';
    else digestFormat = 'rich-cards';
  }

  // Auto-save to Obsidian?
  const saveAfter = /저장|save|obsidian/i.test(text);
  if (saveAfter) reasons.push('→ Obsidian 저장');

  return { engines, query: input.query, reason: reasons.join(', '), mode, digestAfter, digestFormat, saveAfter };
}
