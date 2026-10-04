#!/usr/bin/env bun
// omni-crawl — 통합 검색/크롤링 (2026-07-06 재편: tavily+firecrawl REST+grok 역할분담)
//
// CLI 계약 (asset-attractiveness·research-bridge가 의존 — 절대 유지):
//   bun main.ts "<query>" [--engine e1,e2] [--print] → exit 0 + 마크다운 마커
import { parseArgs } from 'node:util';
import { initEnv } from '../src/env.js';
import { decideCrawl } from '../src/router.js';
import { searchGrok } from '../src/grok-search.js';
import { searchFirecrawl, searchDeveloperFirecrawl, scrapeFirecrawl, creditUsageFirecrawl, firecrawlAvailable } from '../src/firecrawl.js';
import { searchTavily, extractTavily, usageTavily, tavilyAvailable } from '../src/tavily.js';
import { searchDdg, scrapeFree } from '../src/free.js';
import { chromeAvailable } from '../src/capture.js';
import { runRegisteredEngine, type EngineCtx } from '../src/registry.js';
import { renderMarkdown, saveMarkdown, renderSourcesSection } from '../src/render.js';
import type { CrawlResult, CrawlItem, SearchEngine } from '../src/types.js';
import { writeStdoutJson } from '../src/stdout-json.js';

initEnv();

/** ⛔⭐ tavily 를 **상시 경로**에 쓸 것인가 (공식 결정 2026-09-10 · **기본 ON**).
 *
 *  이력: 2026-08-06 엔 비용(deep 1회당 advanced ×3 ≈ 6cr 고정비) 때문에 기본 OFF 로 두고
 *  무료 ddg 를 1순위로 삼았다. 그러나 **DDG HTML 차단 시 웹 검색 축이 통째로 0건**이 되고,
 *  `applyWebFallback` 의 `wantedWeb` 이 ddg 를 세지 않아 **보충조차 걸리지 않는** 구멍이 있었다
 *  (2026-09-10 실측: 연속 3회 0건 · `--health` 에서 ddg-free FAIL 확인).
 *
 *  → 무료는 «돈 떨어졌을 때의 안전망»이지 1순위가 아니다. `types.ts` 의 "tavily 1순위" 주석과
 *    `applyWebFallback` 의 "유료가 1순위·기본" 원칙으로 되돌린다.
 *    **ddg 는 폴백 / `--free` / `--engine ddg` 전용**이 된다.
 *
 *  끄기(= 옛 동작으로 역전, ddg 1순위): `.env` 또는 셸에 `OMNI_CRAWL_TAVILY=0`.
 */
export function tavilyEnabled(): boolean {
  return (process.env.OMNI_CRAWL_TAVILY ?? '').trim() !== '0';
}

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
  if (decision.mode !== 'deep' || decision.engines.length) console.log(`엔진:   ${decision.engines.join(', ') || '(deep 오케스트레이션)'}`);
  console.log(`이유:   ${decision.reason}`);
  if (decision.digestAfter) console.log(`연계:   → omni-digest (${decision.digestFormat})`);
  console.log('');

  if (flags['dry-run']) { await writeStdoutJson(JSON.stringify(decision, null, 2) + '\n'); return; }

  let results: CrawlResult[] = [];
  if (decision.mode === 'deep' && !decision.engines.length) {
    results = await runDeep(query);
  } else {
    // Run engines in parallel (allSettled 격리)
    const tasks = decision.engines.map(engine => runEngine(engine, query));
    const settled = await Promise.allSettled(tasks);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results.push(s.value);
      else if (s.status === 'rejected') console.log(`  ⚠ 엔진 실패: ${s.reason?.message || s.reason}`);
    }
    // ── 폴백 체인: 웹 검색 축이 완전 공백이면 반대 엔진으로 1회 보충 ──
    results = await applyWebFallback(decision.engines, results, query);
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

// ── Deep research 파이프라인 (자체 합성 — Tavily Research 엔드포인트 미사용·비용 예측성) ──
//
// 1) 다각도 tavily advanced ×3 (사실/전망/리스크 각도) 병렬
// 2) URL dedup → 상위 K=5 를 firecrawl 풀스크랩 (maxAge 2h 캐시)
// 3) grok-community 1콜 (X+레딧 여론 각도)
// 카버당 비용: tavily ~6cr + firecrawl ~5cr + grok ~$0.03 — 예측 가능.
/** deep 모드에서 개발자 인덱스를 낄지 판정. 금융/일반 주제에 2cr 를 태우지 않기 위한 게이트. */
function looksTechnical(q: string): boolean {
  return /\b(api|sdk|cli|library|framework|npm|pip|cargo|docker|kubernetes|rust|python|typescript|javascript|golang|react|next\.js|postgres|redis|error|exception|traceback|deprecat|regression|breaking\s*change)\b|라이브러리|프레임워크|에러|예외|버그|이슈|마이그레이션|구현체/i.test(q);
}

async function runDeep(query: string): Promise<CrawlResult[]> {
  console.log('  [deep] 다각도 검색 → 풀스크랩 → 커뮤니티 합성');
  const angles = [
    { q: query, label: 'core' },
    { q: `${query} 분석 전망 outlook analysis`, label: 'outlook' },
    { q: `${query} 리스크 문제점 비판 risk criticism`, label: 'risk' },
  ];

  const results: CrawlResult[] = [];

  // 1) 다각도 검색 + grok-community 동시 발사
  // ⛔⭐ 2026-08-06 (공식 결정) — tavily 각도 검색은 **기본 OFF**(deep 1회당 advanced ×3 ≈ 6cr 고정비).
  //    켜기: `.env` 또는 셸에 `OMNI_CRAWL_TAVILY=1`. 끄면 아래 `!gotTavily` 분기가 **이미 있는**
  //    ddg 무료 각도 검색을 대신 돌린다(별도 배선 불필요).
  const searchTasks: Array<Promise<CrawlResult | null>> = [
    ...(tavilyEnabled() ? angles.map(a =>
      searchTavily(a.q, { depth: 'advanced', maxResults: 5, chunksPerSource: 3, timeRange: flags['time-range'] })
        .then(r => ({ ...r, engine: `tavily:${a.label}` }))
        .catch(e => { console.log(`  [deep] tavily(${a.label}) 실패: ${e.message?.slice(0, 80)}`); return null; }),
    ) : []),
    searchGrok({ query, mode: 'community' })
      .catch(e => { console.log(`  [deep] grok-community 실패: ${e.message?.slice(0, 80)}`); return null; }),
    // 기술 주제면 개발자 인덱스 1콜 추가(실측 ~2cr) — 패시지가 곧 인용이라 풀스크랩 콜을 아낀다.
    ...(looksTechnical(query) ? [
      searchDeveloperFirecrawl(query, { k: 10, passages: 2 })
        .catch(e => { console.log(`  [deep] fc-dev 실패: ${e.message?.slice(0, 80)}`); return null; }),
    ] : []),
  ];
  const settled = await Promise.all(searchTasks);
  for (const r of settled) if (r) results.push(r as CrawlResult);

  // 1-b) tavily 축이 비면(기본 OFF · 키 없음 · 장애) ddg 무료가 각도 검색을 담당한다.
  const gotTavily = results.some(r => r.engine.startsWith('tavily') && r.totalItems > 0);
  if (!gotTavily) {
    console.log('  [deep] ddg 무료 티어로 각도 검색');
    const ddgResults = await Promise.all(angles.map(a =>
      searchDdg(a.q, { maxResults: 5 }).then(r => ({ ...r, engine: `ddg:${a.label}` })).catch(() => null)));
    for (const r of ddgResults) if (r && r.totalItems > 0) results.push(r as CrawlResult);
  }

  // 2) 검색 히트에서 상위 URL 추출 → firecrawl 풀스크랩 (병렬·캐시 2h)
  const seen = new Set<string>();
  const topUrls: string[] = [];
  for (const r of results) {
    if (!r.engine.startsWith('tavily') && !r.engine.startsWith('ddg')) continue;
    for (const it of r.items) {
      if (!it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      topUrls.push(it.url);
      if (topUrls.length >= 5) break;
    }
    if (topUrls.length >= 5) break;
  }
  if (topUrls.length) {
    console.log(`  [deep] 상위 ${topUrls.length}개 URL 풀스크랩 (firecrawl·캐시 2h)`);
    const scraped = await Promise.all(topUrls.map(u =>
      scrapeFirecrawl(u, { maxAge: 2 * 3600_000 }).catch(() => null),
    ));
    const items: CrawlItem[] = [];
    for (let i = 0; i < scraped.length; i++) {
      const s = scraped[i];
      if (!s) continue;
      items.push({
        engine: 'fc-deep', query, url: topUrls[i],
        text: s.content.slice(0, 6000),
        metadata: { title: s.title, fullLength: s.content.length },
      });
    }
    // 스크랩 실패분: tavily extract(기본 OFF) → jina 무료 스크랩
    let missed = topUrls.filter((_, i) => !scraped[i]);
    const extractedUrls = new Set<string>();
    if (missed.length && tavilyEnabled() && tavilyAvailable()) {
      try {
        const ext = await extractTavily(missed);
        for (const e of ext) { items.push({ engine: 'fc-deep', query, url: e.url, text: e.content.slice(0, 6000), metadata: { via: 'tavily-extract' } }); extractedUrls.add(e.url); }
      } catch { /* fail-soft */ }
    }
    missed = missed.filter(u => !extractedUrls.has(u));
    if (missed.length) {
      console.log(`  [deep] 잔여 ${missed.length}개 → jina 무료 스크랩`);
      const freeScraped = await Promise.all(missed.map(u => scrapeFree(u, { allowPrivate: flags['allow-private'] }).catch(() => null)));
      for (let i = 0; i < freeScraped.length; i++) {
        const s = freeScraped[i];
        if (s) items.push({ engine: 'fc-deep', query, url: missed[i], text: s.content.slice(0, 6000), metadata: { via: s.method, title: s.title } });
      }
    }
    if (items.length) results.push({ engine: 'deep-fullscrape', query, items, totalItems: items.length, costNote: `firecrawl ~${scraped.filter(Boolean).length}cr + 무료` });
  }

  return results;
}

// ── 폴백 체인: tavily ↔ firecrawl → (최후) ddg 무료 (웹 검색 축 공백 방지) ──
//
// 원칙: 유료(tavily/firecrawl)가 1순위·기본. 유료가 공백/미가용일 때만 무료(ddg)로 강등.
// "품질 동일 시 무료, 아니면 유료 우선" — 무료는 돈 떨어졌을 때의 안전망.
async function applyWebFallback(engines: SearchEngine[], results: CrawlResult[], query: string): Promise<CrawlResult[]> {
  // ⛔ ddg 도 «웹 검색 축»으로 센다(공식 결정 2026-09-10). 종전엔 ddg 가 빠져 있어서
  //    ddg 1순위로 돌던 시절 DDG 가 0건이면 **보충이 아예 안 걸렸다** — 그 구멍을 막는다.
  const wantedWeb = engines.some(e => e === 'tavily' || e === 'tavily-news' || e === 'firecrawl' || e === 'fc-news' || e === 'ddg');
  if (!wantedWeb) return results;
  const triedDdg = engines.includes('ddg');
  const gotWeb = () => results.some(r => /^(tavily|firecrawl|ddg)/.test(r.engine) && r.totalItems > 0);
  if (gotWeb()) return results;

  // 1순위 실패 → 반대 유료 엔진 1회
  const triedTavily = engines.includes('tavily') || engines.includes('tavily-news');
  try {
    if (triedDdg) {
      // ddg 1순위(OMNI_CRAWL_TAVILY=0)가 공백 → 유료로 «승격» 보충
      if (tavilyAvailable()) {
        console.log('  [fallback] ddg 공백 → tavily 검색 승격');
        const fb = await searchTavily(query, { depth: 'basic', maxResults: 5 });
        if (fb.totalItems > 0) results.push(fb);
      }
      if (!gotWeb() && firecrawlAvailable()) {
        console.log('  [fallback] ddg 공백 → firecrawl 검색 승격');
        const fb = await searchFirecrawl(query, { limit: 5 });
        if (fb.totalItems > 0) results.push(fb);
      }
    } else if (triedTavily && firecrawlAvailable()) {
      console.log('  [fallback] tavily 공백 → firecrawl 검색 보충');
      const fb = await searchFirecrawl(query, { limit: 5 });
      if (fb.totalItems > 0) results.push(fb);
    } else if (!triedTavily && tavilyAvailable()) {
      console.log('  [fallback] firecrawl 공백 → tavily 검색 보충');
      const fb = await searchTavily(query, { depth: 'basic', maxResults: 5 });
      if (fb.totalItems > 0) results.push(fb);
    }
  } catch (e: any) {
    console.log(`  [fallback] 보충 실패: ${e.message?.slice(0, 80)}`);
  }

  // 유료 양쪽 다 공백/미가용 → 무료 ddg 최후 보충 (죽지 않게).
  // 단 이미 ddg 로 돌아서 0건이었다면 같은 엔진을 재시도하지 않는다(차단 상태면 무의미).
  if (!gotWeb() && !triedDdg) {
    try {
      console.log('  [fallback] 유료 웹 검색 공백 → ddg 무료 티어 강등');
      const fb = await searchDdg(query, { maxResults: 5 });
      if (fb.totalItems > 0) results.push(fb);
    } catch (e: any) {
      console.log(`  [fallback] ddg 보충 실패: ${e.message?.slice(0, 80)}`);
    }
  }
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

  // ⛔ 기대값은 **tavily 스위치를 따라간다**(공식 결정 2026-08-06 기본 OFF). 스위치를 뒤집고도
  //    자기테스트를 안 고쳐 3건이 상시 FAIL 로 남아 있었다 — 신호가 죽어 있던 자리다.
  const WEB = (process.env.OMNI_CRAWL_TAVILY ?? '').trim() !== '0' ? 'tavily' : 'ddg';
  const NEWS = WEB === 'tavily' ? ['tavily-news', 'fc-news'] : ['fc-news'];

  const cases: Array<{ text: string; expectEngines: string[]; expectDigest: boolean; expectMode?: string; free?: boolean }> = [
    { text: 'AI 트렌드', expectEngines: [WEB], expectDigest: false },
    { text: 'X에서 AI 검색', expectEngines: ['grok-x'], expectDigest: false },
    { text: '레딧 반응', expectEngines: ['grok-reddit'], expectDigest: false },
    { text: '트윗 검색', expectEngines: ['apify'], expectDigest: false },
    { text: '삼성전자 뉴스', expectEngines: NEWS, expectDigest: false },
    { text: '웹 크롤 요약', expectEngines: ['firecrawl'], expectDigest: true },
    { text: '커뮤니티 반응 정리', expectEngines: ['grok-community'], expectDigest: true },
    { text: '전체 검색', expectEngines: [WEB, 'apify', 'grok-x', 'firecrawl'], expectDigest: false },
    { text: 'pydantic 라이브러리 사용법', expectEngines: ['fc-dev'], expectDigest: false },
    { text: 'tokio 이슈 확인', expectEngines: ['fc-dev'], expectDigest: false },
    { text: 'axum 에러 메시지 정리', expectEngines: ['fc-dev'], expectDigest: true },
    { text: '데이터 추출', expectEngines: ['fc-agent'], expectDigest: false },
    { text: '사이트맵 파악', expectEngines: ['fc-map'], expectDigest: false },
    { text: '딥리서치 해줘', expectEngines: [], expectDigest: false, expectMode: 'deep' },
    { text: '이 페이지 스크린샷', expectEngines: ['capture'], expectDigest: false },
    { text: 'AI 트렌드', expectEngines: ['ddg'], expectDigest: false, free: true },
    { text: '삼성전자 스크린샷', expectEngines: ['capture'], expectDigest: false, free: true },
  ];

  for (const tc of cases) {
    const r = decideCrawl({ intentText: tc.text, query: 'test', forceFree: tc.free });
    const engOk = JSON.stringify([...r.engines].sort()) === JSON.stringify([...tc.expectEngines].sort());
    const digOk = r.digestAfter === tc.expectDigest;
    const modeOk = !tc.expectMode || r.mode === tc.expectMode;
    if (engOk && digOk && modeOk) {
      console.log(`  PASS: "${tc.text}" → [${r.engines}] mode=${r.mode} digest=${r.digestAfter}`);
      passed++;
    } else {
      console.log(`  FAIL: "${tc.text}"`);
      console.log(`    expect: [${tc.expectEngines}] mode=${tc.expectMode ?? 'auto'} digest=${tc.expectDigest}`);
      console.log(`    got:    [${r.engines}] mode=${r.mode} digest=${r.digestAfter}`);
      failed++;
    }
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
omni-crawl — 통합 검색/크롤링 (tavily + firecrawl REST + grok + apify 역할분담)

사용법: bun scripts/main.ts "<검색어>" [OPTIONS]
       bun scripts/main.ts --health          # 전 엔진 라이브 진단

역할:  일반 웹=tavily · 뉴스=tavily-news+fc-news · 크롤/스크랩=firecrawl(REST)
       커뮤니티/X/레딧=grok · 트윗 벌크=apify · 딥리서치=--mode deep
       무료 폴백=ddg 검색·jina 스크랩(키 불필요) · 스크린샷=capture(로컬 Chrome)

비용:  유료(tavily/firecrawl/grok/apify)가 1순위·기본. 유료 공백/키없음/--free 시
       무료(ddg/jina)로 자동 강등 — "품질 동일 시 무료, 아니면 유료 우선".

옵션:
  --message, -m <text>   의도 힌트 (역할 자동 라우팅)
  --engine <engines>     엔진 강제 (쉼표): tavily, tavily-news, firecrawl, fc-news, fc-dev,
                         fc-crawl, fc-agent, fc-map, grok-x/web/reddit/community, apify,
                         ddg(무료 검색), capture(스크린샷)
  --free                 무료 티어 강제 (ddg 검색 / jina 스크랩 / capture)
  --mode <auto|deep>     deep = 다각도 tavily + firecrawl 풀스크랩 + grok 합성 + Sources 인용
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
  bun scripts/main.ts "Samsung HBM4 경쟁력" --print                # tavily 기본
  bun scripts/main.ts "삼성전자 뉴스" --time-range day --print      # 뉴스 (오늘)
  bun scripts/main.ts "SK하이닉스 전망" --mode deep --print          # 딥리서치+인용
  bun scripts/main.ts "AI 트렌드" --free --print                    # 무료 티어(ddg)
  bun scripts/main.ts "https://news.samsung.com" --engine capture   # 스크린샷
  bun scripts/main.ts "bitcoin outlook" --engine apify --min-favs 50 --print
  bun scripts/main.ts "https://news.samsung.com" --engine fc-crawl  # 사이트 크롤
  bun scripts/main.ts "NVDA earnings" --json                        # 파이프라인 소비
`);
}
