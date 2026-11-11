#!/usr/bin/env bun
// omni-crawl — 통합 검색/크롤링 (2026-07-06 재편: tavily+firecrawl REST+grok 역할분담)
//
// CLI 계약 (asset-attractiveness·research-bridge가 의존 — 절대 유지):
//   bun main.ts "<query>" [--engine e1,e2] [--print] → exit 0 + 마크다운 마커
import { parseArgs } from 'node:util';
import { initEnv } from '../src/env.js';
import { decideCrawl } from '../src/router.js';
import { searchGrok } from '../src/grok-search.js';
import { searchFirecrawl, searchDeveloperFirecrawl, creditUsageFirecrawl } from '../src/firecrawl.js';
import { searchTavily, usageTavily } from '../src/tavily.js';
import { searchDdg } from '../src/free.js';
import { chromeAvailable } from '../src/capture.js';
import { runRegisteredEngine, runCapability, type ContractRequest, type EngineCtx } from '../src/registry.js';
import { renderMarkdown, saveMarkdown, renderSourcesSection } from '../src/render.js';
import type { CrawlResult, CrawlItem, SearchEngine } from '../src/types.js';
import { writeStdoutJson } from '../src/stdout-json.js';

initEnv();

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    message:    { type: 'string', short: 'm' },
    engine:     { type: 'string' },           // comma: tavily,firecrawl,grok-x,apify,...
    mode:       { type: 'string' },           // auto | deep
    depth:      { type: 'string' },           // tavily: basic | advanced
    limit:      { type: 'string' },           // 검색 결과 수 (기본 5)
    'time-range': { type: 'string' },         // tavily: day|week|month|year / firecrawl tbs 매핑
    'min-favs': { type: 'string' },
    'max-items':{ type: 'string' },
    lang:       { type: 'string' },
    save:       { type: 'boolean', default: false },
    'no-save':  { type: 'boolean', default: false },
    print:      { type: 'boolean', default: false },
    json:       { type: 'boolean', default: false },   // 파이프라인용 구조화 출력
    free:       { type: 'boolean', default: false },   // 무료 티어 강제 (ddg/jina/capture)
    'allow-private': { type: 'boolean', default: false }, // SSRF 가드 opt-out (내부 타깃)
    health:     { type: 'boolean', default: false },   // 전 엔진 라이브 진단
    'dry-run':  { type: 'boolean', default: false },
    'self-test':{ type: 'boolean', default: false },
    help:       { type: 'boolean', short: 'h', default: false },
  },
});

if (flags.help) { printHelp(); process.exit(0); }
if (flags['self-test']) { runSelfTest(); process.exit(0); }
if (flags.health) { runHealth().then(ok => process.exit(ok ? 0 : 1)); }
else {
  const query = positionals.join(' ').trim();
  if (!query) { console.error('Error: 검색 키워드를 입력해주세요.'); printHelp(); process.exit(1); }
  main(query).catch(err => { console.error(`Error: ${err.message}`); process.exit(1); });
}

async function main(query: string) {
  const intentText = [flags.message, query].filter(Boolean).join(' ');
  const decision = decideCrawl({ intentText, forceEngines: flags.engine, forceMode: flags.mode, forceFree: flags.free, query });

  console.log('━'.repeat(60));
  console.log('OmniCrawl');
  console.log('━'.repeat(60));
  console.log(`쿼리:   ${query}`);
  console.log(`모드:   ${decision.mode}`);
  if (decision.mode !== 'deep' || decision.engines.length)
    console.log(`능력:   ${decision.engines.join(', ') || decision.requires?.map(r => r.contract).join(', ') || '(deep 오케스트레이션)'}`);
  console.log(`이유:   ${decision.reason}`);
  if (decision.digestAfter) console.log(`연계:   → omni-digest (${decision.digestFormat})`);
  console.log('');

  if (flags['dry-run']) { await writeStdoutJson(JSON.stringify(decision, null, 2) + '\n'); return; }

  let results: CrawlResult[] = [];
  if (decision.mode === 'deep' && !decision.engines.length) {
    results = await runDeep(query);
  } else {
    // Explicit --engine keeps the legacy ID path; automatic routes select contracts.
    const tasks = decision.engines.length
      ? decision.engines.map(engine => runEngine(engine, query))
      : (decision.requires ?? []).map(async requirement => {
        const selected = await runCapability(requirement, query, engineCtx());
        console.log(`  [${requirement.contract}] ${selected.provider}${selected.attempts.length ? ` · 앞선 시도 ${selected.attempts.map(a => `${a.provider}:${a.reason}`).join(', ')}` : ''}`);
        return selected.result;
      });
    const settled = await Promise.allSettled(tasks);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results.push(s.value);
      else if (s.status === 'rejected') console.log(`  ⚠ 엔진 실패: ${s.reason?.message || s.reason}`);
    }
  }

  // ── URL dedup (엔진 간 중복 제거 — 반복 파이프라인 노이즈 감소) ──
  // deep-fullscrape(풀본문)를 앞으로: 같은 URL이면 스니펫이 아니라 풀본문이 살아남아야 함.
  results = [...results].sort((a, b) =>
    (a.engine === 'deep-fullscrape' ? 0 : 1) - (b.engine === 'deep-fullscrape' ? 0 : 1));
  results = dedupByUrl(results);

  let markdown = renderMarkdown(results, query);
  // deep 모드: 인용 강제 Sources 섹션 추가 (deer-flow 인용 규율 이식)
  if (decision.mode === 'deep') markdown += '\n' + renderSourcesSection(results);
  const totalItems = results.reduce((s, r) => s + r.totalItems, 0);
  const costs = results.map(r => r.costNote).filter(Boolean);
  console.log(`\n총 ${totalItems}건 수집 (${results.length}개 엔진${costs.length ? ` · 비용: ${costs.join(' + ')}` : ''})\n`);

  let savedPath: string | null = null;
  const shouldSave = (flags.save || decision.saveAfter) && !flags['no-save'];
  if (shouldSave) {
    savedPath = await saveMarkdown(markdown, query);
    if (savedPath) console.log(`저장: ${savedPath}`);
    else console.log('⚠ OBSIDIAN_VAULT_ROOT 미설정 — 저장 건너뜀');
  }

  console.log('━'.repeat(60));

  if (flags.json) {
    // 파이프라인용 구조화 출력 (Conatus 등 기계 소비)
    const payload = {
      query, mode: decision.mode, engines: results.map(r => r.engine),
      totalItems, costs, savedPath,
      results: results.map(r => ({
        engine: r.engine, totalItems: r.totalItems, summary: r.rawText || null,
        items: r.items.map(i => ({ url: i.url, title: i.metadata?.title, text: i.text.slice(0, 2000), date: i.date, author: i.author })),
      })),
    };
    console.log('\n---BEGIN_OMNI_CRAWL_JSON---');
    await writeStdoutJson(JSON.stringify(payload, null, 2) + '\n');
    console.log('---END_OMNI_CRAWL_JSON---');
  }

  if (flags.print) {
    console.log('\n---BEGIN_OMNI_CRAWL_MARKDOWN---\n');
    console.log(markdown);
    console.log('\n---END_OMNI_CRAWL_MARKDOWN---\n');
  }

  if (decision.digestAfter) {
    console.log(`\n---SIGNAL: digestRequested=true format=${decision.digestFormat || 'rich-cards'}---`);
  }

  console.log('━'.repeat(60));
}

// ── Deep research composes contracted abilities; no supplier ID is selected here. ──
function looksTechnical(q: string): boolean {
  return /\b(api|sdk|cli|library|framework|npm|pip|cargo|docker|kubernetes|rust|python|typescript|javascript|golang|react|next\.js|postgres|redis|error|exception|traceback|deprecat|regression|breaking\s*change)\b|라이브러리|프레임워크|에러|예외|버그|이슈|마이그레이션|구현체/i.test(q);
}

async function safeCapability(request: ContractRequest, query: string, ctx = engineCtx()) {
  try {
    const selected = await runCapability(request, query, ctx);
    console.log(`  [${request.contract}] ${selected.provider} · ${selected.result.totalItems}건${selected.attempts.length ? ` · 앞선 시도 ${selected.attempts.map(a => `${a.provider}:${a.reason}`).join(', ')}` : ''}`);
    return selected;
  } catch {
    console.log(`  [${request.contract}] 적격 공급자 소진`);
    return null;
  }
}

async function runDeep(query: string): Promise<CrawlResult[]> {
  const freeOnly = flags.free;
  const angles = [
    { q: query, label: 'core' },
    { q: `${query} 분석 전망 outlook analysis`, label: 'outlook' },
    { q: `${query} 리스크 문제점 비판 risk criticism`, label: 'risk' },
  ];
  const searchRequest: ContractRequest = { contract: 'search.web@1', freeOnly };
  const sideRequests: ContractRequest[] = [
    { contract: 'social.posts@1', conditions: { socialSite: 'community' }, freeOnly },
    ...(looksTechnical(query) ? [{ contract: 'search.developer@1' as const, freeOnly }] : []),
  ];
  const selected = await Promise.all([
    ...angles.map(angle => safeCapability(searchRequest, angle.q, { ...engineCtx(), depth: 'advanced' })),
    ...sideRequests.map(request => safeCapability(request, query)),
  ]);
  const web = selected.slice(0, angles.length);
  const results: CrawlResult[] = selected.flatMap((item, index) => item
    ? [{ ...item.result, engine: index < angles.length ? `${item.provider}:${angles[index]!.label}` : item.provider }]
    : []);
  const topUrls = [...new Set(web.flatMap(item => item?.result.items.map(hit => hit.url).filter((url): url is string => Boolean(url)) ?? []))].slice(0, 5);
  const scraped = await Promise.all(topUrls.map(url => safeCapability({ contract: 'scrape.url@1', freeOnly }, url, { ...engineCtx(), depth: 'advanced' })));
  const items: CrawlItem[] = scraped.flatMap((selected, index) => selected
    ? selected.result.items.map(item => ({ ...item, engine: 'deep-fullscrape', query, url: item.url ?? topUrls[index],
      metadata: { ...item.metadata, via: selected.provider } }))
    : []);
  if (items.length) results.push({ engine: 'deep-fullscrape', query, items, totalItems: items.length });
  return results;
}

// ── URL dedup (엔진 순서 우선 — 앞 엔진 결과 유지) ──
function dedupByUrl(results: CrawlResult[]): CrawlResult[] {
  const seen = new Set<string>();
  return results.map(r => {
    const items = r.items.filter(it => {
      if (!it.url) return true;               // URL 없는 항목(요약 등)은 유지
      const key = it.url.replace(/[?#].*$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // rawText 기반 엔진(grok 계열)은 items가 항상 [] 이므로 자체 계산한 totalItems(=annotations 수)를 보존한다.
    return { ...r, items, totalItems: r.rawText ? r.totalItems : items.length };
  }).filter(r => r.totalItems > 0 || r.rawText);
}

function engineCtx(): EngineCtx {
  return {
    limit: flags.limit ? Number(flags.limit) : 5,
    depth: (flags.depth === 'advanced' ? 'advanced' : 'basic'),
    timeRange: flags['time-range'],
    minFavs: flags['min-favs'] ? Number(flags['min-favs']) : 30,
    maxItems: flags['max-items'] ? Number(flags['max-items']) : 100,
    lang: flags.lang || 'en',
    allowPrivate: flags['allow-private'],
  };
}

// 엔진 디스패치는 레지스트리(src/registry.ts)로 위임 — 신규 프로바이더는 등록으로 추가.
async function runEngine(engine: SearchEngine, q: string): Promise<CrawlResult | null> {
  return runRegisteredEngine(engine, q, engineCtx());
}

// ── Health (전 엔진 라이브 1콜 진단 — 간헐 고장 조기 발견) ──

async function runHealth(): Promise<boolean> {
  console.log('=== omni-crawl health (라이브 프로브) ===\n');
  /** tier: 'fallback' 은 폴백 전용 엔진 — 실패해도 전체 판정(allOk)을 깨지 않는다. */
  type Check = { name: string; tier?: 'primary' | 'fallback'; run: () => Promise<string> };
  const checks: Check[] = [
    {
      name: 'tavily', run: async () => {
        const t0 = Date.now();
        const r = await searchTavily('health check', { depth: 'basic', maxResults: 1 });
        const u = await usageTavily();
        return `${r.totalItems >= 0 ? 'OK' : '?'} ${Date.now() - t0}ms · ${u.detail}`;
      },
    },
    {
      name: 'firecrawl', run: async () => {
        const t0 = Date.now();
        const r = await searchFirecrawl('health check', { limit: 1 });
        const c = await creditUsageFirecrawl();
        if (r.totalItems === 0) throw new Error(`검색 0건 · ${c.detail}`);
        return `OK ${Date.now() - t0}ms · ${c.detail}`;
      },
    },
    {
      name: 'fc-dev', run: async () => {
        const t0 = Date.now();
        const r = await searchDeveloperFirecrawl('http client retry', { k: 1 });
        if (r.totalItems === 0) throw new Error('개발자 인덱스 0건');
        return `OK ${Date.now() - t0}ms · ${r.items[0].metadata?.kind ?? '?'} 히트`;
      },
    },
    {
      name: 'grok', run: async () => {
        const t0 = Date.now();
        const r = await searchGrok({ query: 'health check today', mode: 'web' });
        return `OK ${Date.now() - t0}ms · ${r.totalItems} sources`;
      },
    },
    {
      name: 'apify', run: async () => {
        const token = process.env.APIFY_TOKEN;
        if (!token) throw new Error('APIFY_TOKEN 미설정');
        const t0 = Date.now();
        const res = await fetch(`https://api.apify.com/v2/users/me?token=${token}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        return `OK ${Date.now() - t0}ms · plan ${d?.data?.plan?.id ?? '?'}`;
      },
    },
    {
      // 공식 결정 2026-09-10: ddg 는 **폴백 전용**(1순위 아님)이므로 실패해도 전체 판정을 깨지 않는다.
      //   DDG HTML 차단은 상시 발생하는 정상 상태 — 유료 축이 살아 있으면 검색은 계속 돈다.
      name: 'ddg-free', tier: 'fallback', run: async () => {
        const t0 = Date.now();
        const r = await searchDdg('health check', { maxResults: 1 });
        if (r.totalItems === 0) throw new Error('검색 0건 (DDG HTML 차단 — 폴백 전용이라 무해)');
        return `OK ${Date.now() - t0}ms · 무료·키불필요 · 폴백 전용`;
      },
    },
    {
      name: 'capture', run: async () => {
        if (!chromeAvailable()) throw new Error('Chrome 미설치 (Dia CDP 폴백만 가능)');
        return `OK · headless Chrome 사용가능`;
      },
    },
  ];

  let allOk = true;
  let fallbackDown = 0;
  for (const c of checks) {
    try {
      const detail = await c.run();
      console.log(`  ✅ ${c.name.padEnd(10)} ${detail}`);
    } catch (e: any) {
      const msg = e?.message?.slice(0, 100) || 'error';
      if (c.tier === 'fallback') {
        // 폴백 엔진 장애는 «경고»지 «이상»이 아니다 — 1순위 유료 축이 살아 있으면 검색은 돈다.
        fallbackDown++;
        console.log(`  ⚠️  ${c.name.padEnd(10)} ${msg} [폴백 전용 · 검색 영향 없음]`);
      } else {
        allOk = false;
        console.log(`  ❌ ${c.name.padEnd(10)} ${msg}`);
      }
    }
  }
  const tail = fallbackDown > 0 ? ` (폴백 ${fallbackDown}건 다운 — 무해)` : '';
  console.log(`\n결과: ${allOk ? `1순위 엔진 전부 정상${tail}` : '⚠ 일부 엔진 이상 — 위 상세 확인'}`);
  return allOk;
}

// ── Self-test (라우팅 회귀) ──

function runSelfTest() {
  console.log('=== omni-crawl self-test ===\n');
  let passed = 0, failed = 0;

  const cases: Array<{ text: string; query?: string; requires: string[]; digest: boolean; mode?: string; free?: boolean; forceEngines?: string; engines?: string[] }> = [
    { text: 'AI 트렌드', requires: ['search.web@1'], digest: false },
    { text: 'https://example.com/article', query: 'https://example.com/article', requires: ['scrape.url@1'], digest: false },
    { text: 'https://github.com/example/repo', query: 'https://github.com/example/repo', requires: ['scrape.url@1'], digest: false },
    { text: '사이트맵 파악', query: 'https://example.com', requires: ['map.site@1'], digest: false },
    { text: '사이트 전체 크롤', query: 'https://example.com', requires: ['crawl.site@1'], digest: false },
    { text: '데이터 추출', query: 'https://example.com', requires: ['extract.agent@1'], digest: false },
    { text: 'X에서 AI 검색', requires: ['social.posts@1:x'], digest: false },
    { text: '레딧 반응', requires: ['social.posts@1:reddit'], digest: false },
    { text: '트윗 검색', requires: ['social.posts@1:x'], digest: false },
    { text: '삼성전자 뉴스', requires: ['search.news@1'], digest: false },
    { text: '웹 크롤 요약', requires: ['scrape.url@1'], digest: true },
    { text: '커뮤니티 반응 정리', requires: ['social.posts@1:community'], digest: true },
    { text: '전체 검색', requires: ['search.web@1', 'social.posts@1:x', 'social.posts@1:reddit'], digest: false },
    { text: 'pydantic 라이브러리 사용법', requires: ['search.developer@1'], digest: false },
    { text: 'tokio 이슈 확인', requires: ['search.developer@1'], digest: false },
    { text: 'axum 에러 메시지 정리', requires: ['search.developer@1'], digest: true },
    { text: '데이터 추출', requires: ['extract.agent@1'], digest: false },
    { text: '사이트맵 파악', requires: ['map.site@1'], digest: false },
    { text: '딥리서치 해줘', requires: [], digest: false, mode: 'deep' },
    { text: '이 페이지 스크린샷', requires: ['capture.url@1'], digest: false },
    { text: 'AI 트렌드', requires: ['search.web@1'], digest: false, free: true },
    { text: '레딧 반응', requires: ['social.posts@1:reddit'], digest: false, free: true },
    { text: '삼성전자 스크린샷', requires: ['capture.url@1'], digest: false, free: true },
    { text: 'AI 트렌드', requires: [], digest: false, forceEngines: 'tavily,firecrawl', engines: ['tavily', 'firecrawl'] },
  ];
  for (const tc of cases) {
    const r = decideCrawl({ intentText: tc.text, query: tc.query ?? 'test', forceFree: tc.free, forceEngines: tc.forceEngines });
    const got = r.requires?.map(req => req.contract + (req.conditions?.socialSite ? `:${req.conditions.socialSite}` : '')) ?? [];
    const ok = JSON.stringify(got) === JSON.stringify(tc.requires)
      && JSON.stringify(r.engines) === JSON.stringify(tc.engines ?? [])
      && r.digestAfter === tc.digest
      && (!tc.mode || r.mode === tc.mode)
      && (!tc.free || r.requires?.every(req => req.freeOnly));
    if (ok) { console.log(`  PASS: "${tc.text}" → [${got.join(', ') || r.engines.join(', ')}]`); passed++; }
    else { console.log(`  FAIL: "${tc.text}" expected ${tc.requires} got ${got} engines=${r.engines}`); failed++; }
  }

  // deep 모드의 fc-dev 게이트 — 금융/일반 주제에 2cr 를 태우지 않는지 고정한다.
  const gateCases: Array<[string, boolean]> = [
    ['axum middleware ordering in rust', true],
    ['pydantic 라이브러리 마이그레이션', true],
    ['TypeError traceback 원인', true],
    ['삼성전자 HBM4 전망', false],
    ['금리 인하 시나리오', false],
  ];
  for (const [q, expect] of gateCases) {
    const got = looksTechnical(q);
    if (got === expect) { console.log(`  PASS: looksTechnical("${q}") = ${got}`); passed++; }
    else { console.log(`  FAIL: looksTechnical("${q}") expect ${expect}, got ${got}`); failed++; }
  }

  console.log(`\n결과: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function printHelp() {
  console.log(`
omni-crawl — 계약 기반 검색/크롤링 (기존 공급자 어댑터)

사용법: bun scripts/main.ts "<검색어>" [OPTIONS]
       bun scripts/main.ts --health          # 전 엔진 라이브 진단

역할:  자동 라우팅은 search.web/news · scrape.url · social.posts 등 계약 선택
       딥리서치=--mode deep · 스크린샷=capture(로컬 Chrome)

비용:  무료(ddg/jina/로컬)가 우선. 빈 결과나 실패 뒤에만 BYOK 공급자를 시도.

옵션:
  --message, -m <text>   의도 힌트 (역할 자동 라우팅)
  --engine <engines>     엔진 강제 (쉼표): tavily, tavily-news, firecrawl, fc-news, fc-dev,
                         fc-crawl, fc-agent, fc-map, grok-x/web/reddit/community, apify,
                         ddg(무료 검색), capture(스크린샷)
  --free                 무료 티어 강제 (ddg 검색 / jina 스크랩 / capture)
  --mode <auto|deep>     deep = 다각도 계약 검색 + 계약 스크랩/소셜 합성 + Sources 인용
  --depth <basic|advanced>  tavily 검색 깊이 (advanced=2cr·근거 청크)
  --limit <n>            검색 결과 수 (기본 5)
  --time-range <r>       day|week|month|year (최신성 필터)
  --allow-private        SSRF 가드 opt-out (내부/사설 IP 타깃 허용 — 주의)
  --json                 파이프라인용 구조화 JSON 출력 (Conatus 등)
  --health               전 엔진 1콜 라이브 진단 + 크레딧 잔량 (+무료·capture)
  --min-favs/--max-items/--lang   Apify 옵션
  --save / --no-save     Obsidian 저장
  --print                마크다운 stdout 출력
  --dry-run              라우팅만 확인
  --self-test            라우팅 회귀 테스트

예시:
  bun scripts/main.ts "Samsung HBM4 경쟁력" --print                # search.web@1 무료 우선
  bun scripts/main.ts "삼성전자 뉴스" --time-range day --print      # 뉴스 (오늘)
  bun scripts/main.ts "SK하이닉스 전망" --mode deep --print          # 딥리서치+인용
  bun scripts/main.ts "AI 트렌드" --free --print                    # 무료 티어(ddg)
  bun scripts/main.ts "https://news.samsung.com" --engine capture   # 스크린샷
  bun scripts/main.ts "bitcoin outlook" --engine apify --min-favs 50 --print
  bun scripts/main.ts "https://news.samsung.com" --engine fc-crawl  # 사이트 크롤
  bun scripts/main.ts "NVDA earnings" --json                        # 파이프라인 소비
`);
}
