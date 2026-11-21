// g6 — simulation device for the webchat question «2027년 국내 증시 전망을 시세·수급·X·레딧 여론까지 출처와 함께 세 줄로».
// g5 regression (demo server 11-21 06:41Z): the pack was only an instruction (0 KnowledgeQuery calls), X·Reddit relied on a
// lucky Firecrawl hit (0/2 publishers), and 4/9 KIS calls failed in the same tick. Here every leg is a fake: web axes
// (firecrawl), the social step (grok ⊕ web), market-data (fixed fetcher) and the pack (13 large cards). Expected values are
// literals, independent of the product constants.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { createEodhdDeclarations } from '../graph-runner/capability-providers/market-data/eodhd.js';
import { createKisDeclarations } from '../graph-runner/capability-providers/market-data/kis.js';
import { marketDataRegistry } from '../graph-runner/capability-providers/market-data/registry.js';
import { routeResearchOutput } from '../research/output-router.js';
import { parseResearchRouteFields } from '../core-turn/research-route.js';
import { buildMarketDataInstruction } from '../core-turn/research-policy.js';
import type { BloomResearchQuestion } from './question-ladder-contract.js';
import { researchTurnForGrounding, runResearchQuestionLadder, type ResearchQuestionLadderRunOptions } from './research-turn.js';

const REQUEST = '2027년 국내 증시 전망을 시세·수급·X·레딧 여론까지 출처와 함께 세 줄로 알려 줘.';
const outputContract = {
  deliverable: 'Three-line outlook', format: 'Short memo',
  sections: [{ id: 'facts', title: 'Facts', purpose: 'State the supported facts.' }],
  completionCriteria: ['Every claim is supported or marked uncertain.'],
};
const questions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`, level: (index + 1) as BloomResearchQuestion['level'], prompt: `Question ${index + 1}`,
  searchTerms: [`plan term ${index + 1}`], sectionId: 'facts',
}));
const route = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'outlook',
  topic: 'market', symbols: ['069500', '005930', '000660', 'SPY', 'SOXX'], socialQuery: 'KOSPI 2027 outlook Korean stocks' };
const plan = (extra: Record<string, unknown> = {}) => JSON.stringify({ route: { ...route, ...extra }, outputContract, questions });

const NOW = Date.UTC(2026, 10, 21, 6, 41, 0);
const eodhdFetch = async (url: string) => {
  const path = new URL(url).pathname;
  if (path.includes('/real-time/')) return { ok: true, json: async () => ({ code: decodeURIComponent(path.split('/').pop()!), timestamp: 1_795_243_000, close: 251.4 }) };
  return { ok: true, json: async () => [{ date: '2026-11-20', open: 250, high: 252, low: 249, close: 251.4, volume: 1234 }] };
};

/** 13 cards of 3,000 chars each — a pack far larger than the context the step may add. */
const BIG_CARDS = Array.from({ length: 13 }, (_, index) => ({
  id: `card-${String(index + 1).padStart(2, '0')}`, title: `섹터 지도 ${index + 1}`,
  body: `반도체·메모리 005930.KO 삼성전자 ↔ SOXX.US NVDA.US ${'가'.repeat(3_000)}`,
  ref: `pack:conatus-solution@0.1.0#card-${String(index + 1).padStart(2, '0')}`,
}));

let events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
let axisCalls: string[] = [];
let socialCalls: Array<{ query: string; allow_domains: string[] }> = [];
let packCalls: Array<{ question: string; pack_id: string }> = [];
beforeEach(() => {
  events = []; axisCalls = []; socialCalls = []; packCalls = [];
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    events.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log);
});
afterEach(() => { spyOn(debug, 'log').mockRestore(); });

const run = (planText: string, extra: Partial<ResearchQuestionLadderRunOptions> = {}, request = REQUEST) => runResearchQuestionLadder(request, {
  generatePreparation: async () => planText,
  invokeAxes: async (axes) => {
    for (const axis of axes) axisCalls.push(axis.id);
    return {
      plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: [{
        questionId: axis.id, sourceKind: 'web-search:firecrawl', source: `https://news.example.kr/${axis.id}`,
        content: `firecrawl snippet ${axis.id}`, outcome: 'complete' as const, truncated: true,
      }] })),
    };
  },
  marketData: { registry: marketDataRegistry(createEodhdDeclarations({ fetcher: eodhdFetch, lookupSecret: async () => 'injected-test-key' })), now: () => NOW },
  social: { search: async (args) => {
    socialCalls.push({ query: args.query, allow_domains: args.allow_domains });
    const host = args.allow_domains[0];
    return { hits: [
      { url: `https://${host}/post/grok-1`, title: `${host} post`, snippet: 'KOSPI bulls vs bears', engine: 'grok' },
      { url: `https://${host}/post/fc-1`, title: `${host} thread`, snippet: 'valuation discount', engine: 'firecrawl' },
      { url: 'https://unrelated.example.com/a', title: 'off-platform', snippet: 'ignored', engine: 'firecrawl' },
    ] };
  } },
  knowledgePack: { query: async (args) => { packCalls.push(args); return { pack_hits: BIG_CARDS }; } },
  enableResearchFanout: false, allowOutputSkill: false,
  routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }), ...extra,
});

test('outlook, US leading-signal and sector questions all pass through pack, X, Reddit and sourced market evidence', async () => {
  const cases = [
    '2027년 국내 증시 전망을 시세·수급·X·레딧 여론까지 출처와 함께 세 줄로 알려 줘.',
    '내일 한국 반도체 장을 미국 쪽에서 미리 볼 신호는?',
    '한국 반도체 섹터와 미국 ETF·주요 종목의 연결 근거는?',
  ];
  for (const request of cases) {
    axisCalls = []; socialCalls = []; packCalls = []; events = [];
    let preparation = '';
    const result = await run(plan({ socialQuery: 'Korean semiconductor US leading indicators sector sentiment' }), {
      generatePreparation: async (prompt) => { preparation = prompt; return plan({ socialQuery: 'Korean semiconductor US leading indicators sector sentiment' }); },
    }, request);
    expect(preparation).toContain('socialQuery');
    expect(preparation).toContain('market signals and sector context');
    expect(preparation).toContain('up to twelve tickers');
    expect(preparation).toContain('SPY QQQ SOXX NVDA MU AVGO');
    expect(axisCalls).toHaveLength(6);
    expect(socialCalls).toHaveLength(2);
    expect(packCalls).toHaveLength(1);
    expect(result.output).toContain('https://x.com/post/grok-1');
    expect(result.output).toContain('KOSPI bulls vs bears');
    expect(result.output).toContain('https://reddit.com/post/grok-1');
    expect(result.output).toContain('eodhd:market.quote@1:SOXX');
    expect(result.output).toContain('pack:conatus-solution@0.1.0#card-01');
    for (const [category, event] of [['research.social', 'complete'], ['research.pack', 'complete'], ['research.market-data', 'complete']]) {
      expect(events.some((entry) => entry.category === category && entry.event === event)).toBe(true);
    }
  }
});

test('the X step carries the fetched post body and its own URL, while the index quote retains its provider', async () => {
  const result = await run(plan(), {
    social: {
      search: async ({ allow_domains }) => ({ hits: [{ url: `https://${allow_domains[0]}/post/1`, title: 'short title', snippet: 'search teaser', engine: 'grok' }] }),
      fetchPost: async (url) => ({ url, body: 'Full X post body: semiconductor overnight signal from US index futures.' }),
    },
  });
  expect(result.output).toContain('Full X post body: semiconductor overnight signal from US index futures.');
  expect(result.output).toContain('https://x.com/post/1');
  expect(result.output).toContain('eodhd:market.quote@1:SPY');
});

test('an X fetch redirected to another owner leaves only the labeled search excerpt', async () => {
  const result = await run(plan(), {
    social: {
      search: async ({ allow_domains }) => ({ hits: [{ url: `https://${allow_domains[0]}/post/1`, title: 'X result', snippet: 'search excerpt', engine: 'grok' }] }),
      fetchPost: async () => ({ url: 'https://different.example/post/1', body: 'untrusted redirected body' }),
    },
  });
  expect(result.output).toContain('검색 발췌: X result — search excerpt');
  expect(result.output).not.toContain('untrusted redirected body');
  expect(result.output).not.toContain('different.example');
  expect(events.some((entry) => entry.category === 'research.social' && entry.event === 'post-unavailable'
    && entry.data.reason === 'redirect-or-empty')).toBe(true);
});

test('unexpected social and pack collector faults leave explicit step-failure events', async () => {
  await run(plan(), {
    social: { now: () => { throw new Error('fake social clock failure'); } },
    knowledgePack: { now: () => { throw new Error('fake pack clock failure'); }, query: async () => ({ pack_hits: BIG_CARDS }) },
  });
  expect(events.some((entry) => entry.category === 'research.social' && entry.event === 'failed'
    && entry.data.reason === 'collector-error')).toBe(true);
  expect(events.some((entry) => entry.category === 'research.pack' && entry.event === 'failed'
    && entry.data.reason === 'collector-error')).toBe(true);
});

test('Korean market question: web axes, social (X·Reddit · grok ⊕ firecrawl), market-data and the pack step ALL run', async () => {
  const result = await run(plan());
  // web axes unchanged: all six plan axes searched
  expect(axisCalls).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
  // social step: one call per platform with the plan's own query (not the user's sentence)
  expect(socialCalls).toEqual([
    { query: 'KOSPI 2027 outlook Korean stocks', allow_domains: ['x.com', 'twitter.com'] },
    { query: 'KOSPI 2027 outlook Korean stocks', allow_domains: ['reddit.com'] },
  ]);
  const social = result.ladder.evidence.filter((item) => item.sourceKind.startsWith('social-search:'));
  expect(social.map((item) => item.source).sort()).toEqual([
    'https://reddit.com/post/fc-1', 'https://reddit.com/post/grok-1', 'https://x.com/post/fc-1', 'https://x.com/post/grok-1',
  ]);
  expect(social.map((item) => item.sourceKind)).toContain('social-search:x:grok');
  expect(social.map((item) => item.sourceKind)).toContain('social-search:reddit:firecrawl');
  // market-data still runs (EODHD US tickers and KR codes)
  const market = result.ladder.evidence.filter((item) => item.sourceKind.startsWith('market-data:'));
  expect(market.map((item) => item.source)).toContain('eodhd:market.quote@1:SOXX');
  expect(market.map((item) => item.source)).toContain('eodhd:market.quote@1:005930');
  // pack step: queried once with the fixed sector-map question + KR codes (no user text)
  expect(packCalls).toEqual([{ question: '한국 섹터 미국 ETF 핵심 종목 연동 지도 069500 005930 000660', pack_id: 'pack:conatus-solution@0.1.0' }]);
  expect(result.output).toContain('## 연구 근거(코나투스) — pack:conatus-solution@0.1.0');
  expect(result.output).toContain('## Social sentiment (X · Reddit)');
  expect(result.output).toContain('## Market data (market-data capability)');
  // social links become citable source URLs
  const grounding = researchTurnForGrounding(result);
  expect(grounding.sourceUrls).toContain('https://x.com/post/grok-1');
  expect(grounding.sourceUrls).toContain('https://reddit.com/post/fc-1');
  expect(grounding.sourceUrls).not.toContain('https://unrelated.example.com/a');
  // pack evidence is NOT counted as a market-data number source
  expect(grounding.marketData?.evidenceTexts.some((text) => text.includes('섹터 지도'))).toBe(false);
});

test('a 13-card pack of 3,000-char cards is truncated to 4 cards and at most 2,400 chars of card text', async () => {
  const result = await run(plan());
  const pack = result.ladder.evidence.filter((item) => item.sourceKind === 'knowledge-pack');
  expect(pack.map((item) => item.source)).toEqual([
    'pack:conatus-solution@0.1.0#card-01', 'pack:conatus-solution@0.1.0#card-02',
    'pack:conatus-solution@0.1.0#card-03', 'pack:conatus-solution@0.1.0#card-04',
  ]);
  expect(pack.every((item) => Array.from(item.content).length <= 600 && item.truncated)).toBe(true);
  expect(pack.reduce((sum, item) => sum + Array.from(item.content).length, 0)).toBeLessThanOrEqual(2_400);
  const start = result.output.indexOf('## 연구 근거(코나투스)');
  const section = result.output.slice(start, result.output.indexOf('\n## ', start + 1) === -1 ? undefined : result.output.indexOf('\n## ', start + 1));
  expect(section).toContain('(팩 카드 13장 중 관련도 상위 4장만 실음');
  expect(section.length).toBeLessThan(3_200);
  expect(result.output).not.toContain('가'.repeat(700));
  const complete = events.find((entry) => entry.category === 'research.pack' && entry.event === 'complete');
  expect(complete?.data).toMatchObject({ hitCount: 13, cardCount: 4, truncated: true });
});

test('no installed pack or an empty one: no pack section, everything else unchanged', async () => {
  for (const answer of [{ reason: 'pack-not-installed' }, { pack_hits: [] }]) {
    axisCalls = []; socialCalls = []; events = [];
    const result = await run(plan(), { knowledgePack: { query: async () => answer } });
    expect(result.output).not.toContain('연구 근거(코나투스)');
    expect(result.ladder.evidence.some((item) => item.sourceKind === 'knowledge-pack')).toBe(false);
    expect(axisCalls).toHaveLength(6);
    expect(socialCalls).toHaveLength(2);
    expect(result.ladder.evidence.some((item) => item.sourceKind.startsWith('market-data:'))).toBe(true);
  }
});

test('a hanging pack store is cut by its own timeout and does not hold the turn', async () => {
  const result = await run(plan(), { knowledgePack: { query: () => new Promise(() => {}), timeoutMs: 20 } });
  expect(result.output).not.toContain('연구 근거(코나투스)');
  expect(events.some((entry) => entry.category === 'research.pack' && entry.event === 'skipped' && entry.data.reason === 'timeout')).toBe(true);
  expect(result.ladder.evidence.some((item) => item.sourceKind.startsWith('social-search:'))).toBe(true);
});

test('no social query in the route → no social step; a US-only market route → no pack step', async () => {
  await run(plan({ socialQuery: undefined, symbols: ['NVDA', 'SPY'] }));
  expect(socialCalls).toEqual([]);
  expect(packCalls).toEqual([]);
  expect(axisCalls).toHaveLength(6);
});

test('Korean market signal route still invokes X and Reddit when the planner omits socialQuery', async () => {
  const result = await run(plan({ socialQuery: undefined }), {}, '내일 한국 반도체 장을 미국 쪽에서 미리 볼 신호는?');
  expect(socialCalls).toEqual([
    { query: 'Korea market US leading signals sector X Reddit 069500 005930 000660', allow_domains: ['x.com', 'twitter.com'] },
    { query: 'Korea market US leading signals sector X Reddit 069500 005930 000660', allow_domains: ['reddit.com'] },
  ]);
  expect(packCalls).toHaveLength(1);
  expect(result.output).toContain('https://x.com/post/grok-1');
  expect(result.output).toContain('https://reddit.com/post/grok-1');
  expect(result.output).toContain('eodhd:market.quote@1:SPY');
});

test('route parser keeps the plan-written social query (trimmed, ≤120 chars) and drops a non-string', () => {
  expect(parseResearchRouteFields({ socialQuery: '  KOSPI   outlook  ' })).toEqual({ socialQuery: 'KOSPI outlook' });
  expect(parseResearchRouteFields({ socialQuery: 'x'.repeat(300) })?.socialQuery).toHaveLength(120);
  expect(parseResearchRouteFields({ socialQuery: 7, needsFreshFacts: true })).toEqual({ needsFreshFacts: true });
});

test('answer instruction: pack cited separately as «연구 근거(코나투스)», no «call KnowledgeQuery first» line, honesty kept', () => {
  const text = buildMarketDataInstruction(['MarketQuote'])!;
  expect(text).toContain('«연구 근거(코나투스):»로 시작하는 별도 문장');
  expect(text).toContain('시세·수급 수치와 섞지 않는다');
  expect(text).toContain('ρ=0 하한');
  expect(text).toContain('«조회 불가»');
  expect(text).not.toContain('먼저 KnowledgeQuery');
});

test('KIS burst: nine concurrent calls share ONE token request; a rate-limited answer (EGW00201) is retried once', async () => {
  const paths: string[] = [];
  let quoteCalls = 0;
  const fetcher = async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith('/tokenP')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, json: async () => ({ access_token: 'fixture-token', expires_in: 3600 }) };
    }
    quoteCalls++;
    if (quoteCalls === 2) return { ok: true, json: async () => ({ rt_cd: '1', msg_cd: 'EGW00201', msg1: 'rate limit' }) };
    return { ok: true, json: async () => ({ rt_cd: '0', output: { stck_prpr: '70500' } }) };
  };
  const [quote] = createKisDeclarations({ fetcher, appKey: 'fixture-app', appSecret: 'fixture-secret', mode: 'real', rateLimitRetryMs: 0 });
  const results = await Promise.all(Array.from({ length: 9 }, () =>
    quote!.invoke({ input: { symbol: '005930', market: 'KR' } } as never)));
  expect(paths.filter((path) => path.endsWith('/tokenP'))).toHaveLength(1);
  expect(results.every((result) => (result as { ok: boolean }).ok)).toBe(true);
  expect(quoteCalls).toBe(10);
});

test('KIS token reuse follows credential rotation and the original host', async () => {
  const tokenBodies: string[] = [];
  const quoteAuth: Array<{ host: string; token: string }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const target = new URL(url);
    if (target.pathname.endsWith('/tokenP')) {
      tokenBodies.push(String(init?.body));
      return { ok: true, json: async () => ({ access_token: `token-${tokenBodies.length}`, expires_in: 3600 }) };
    }
    quoteAuth.push({ host: target.host, token: String((init?.headers as Record<string, string>)?.authorization) });
    return { ok: true, json: async () => ({ rt_cd: '0', output: { stck_prpr: '70500' } }) };
  };
  for (const [secret, mode] of [['secret-a', 'real'], ['secret-b', 'real'], ['secret-a', 'vts'], ['secret-a', 'real']] as const) {
    const [quote] = createKisDeclarations({ fetcher, appKey: 'fixture-app', appSecret: secret, mode });
    expect((await quote!.invoke({ input: { symbol: '005930', market: 'KR' } } as never) as { ok: boolean }).ok).toBe(true);
  }
  expect(tokenBodies).toHaveLength(3);
  expect(quoteAuth.map((item) => item.token)).toEqual(['Bearer token-1', 'Bearer token-2', 'Bearer token-3', 'Bearer token-1']);
  expect(quoteAuth[0]?.host).toBe(quoteAuth[1]?.host);
  expect(quoteAuth[0]?.host).not.toBe(quoteAuth[2]?.host);
});

test('KIS credential requests disallow redirects before a previous token can reach another origin', async () => {
  const redirects: Array<RequestInit['redirect']> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    redirects.push(init?.redirect);
    if (init?.redirect !== 'error') throw new Error('simulated cross-origin redirect would forward credentials');
    if (new URL(url).pathname.endsWith('/tokenP')) {
      return { ok: true, json: async () => ({ access_token: 'bound-token', expires_in: 3600 }) };
    }
    return { ok: true, json: async () => ({ rt_cd: '0', output: { stck_prpr: '70500' } }) };
  };
  const [quote] = createKisDeclarations({ fetcher, appKey: 'fixture-app', appSecret: 'fixture-secret', mode: 'real' });
  expect((await quote!.invoke({ input: { symbol: '005930', market: 'KR' } } as never) as { ok: boolean }).ok).toBe(true);
  expect(redirects).toEqual(['error', 'error']);
});
