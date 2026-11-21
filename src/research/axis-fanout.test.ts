import { describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchAxisSearcher, fanOutAxisEvidence, planAxisToolCalls, RESEARCH_SEARCH_BUDGET_MS } from './axis-fanout.js';
import { invokeResearchAxes, setResearchInvoker } from '../research-bridge/invoke.js';
import type { BloomResearchQuestion } from '../auto-research/question-ladder-contract.js';
import type { WebSearchProvider } from '../web-search/provider.js';
import { addWebSearchProvider, _resetWebSearchProvidersForTests } from '../web-search/index.js';
import { debug } from '../debug/log.js';

const axes = [
  { id: 'us-rate', level: 1, prompt: '미국 10년물 금리는?', requestedWindow: '2026-10', searchTerms: ['US 10 year Treasury yield October 2026'] },
  { id: 'kr-rate', level: 1, prompt: '한국 10년물 금리는?', searchTerms: ['Korea 10 year government bond yield October 2026'] },
  { id: 'spread', level: 3, prompt: '양국 금리차는?', searchTerms: ['US Korea 10 year bond spread October 2026'] },
] as BloomResearchQuestion[];

describe('research axis fanout', () => {
  it('bounds the total paid-engine fanout below the 15s dead-search ceiling', () => {
    expect(RESEARCH_SEARCH_BUDGET_MS).toBeLessThanOrEqual(15_000);
    expect(RESEARCH_SEARCH_BUDGET_MS).toBe(14_500);
  });

  it('각 축의 질문 ID와 검색어를 독립 도구 호출 계획으로 남긴다', () => {
    expect(planAxisToolCalls(axes)).toEqual([
      { questionId: 'us-rate', tool: 'OmniSearch', query: axes[0]!.searchTerms[0] },
      { questionId: 'kr-rate', tool: 'OmniSearch', query: axes[1]!.searchTerms[0] },
      { questionId: 'spread', tool: 'OmniSearch', query: axes[2]!.searchTerms[0] },
    ]);
  });

  it('세 축을 병렬 호출하고 결과를 축별 출처·날짜·수치 원문에 묶는다', async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const search = (query: string) => new Promise<{ url: string; title: string; snippet: string; publishedAt: number }[]>(resolve => {
      started.push(query);
      releases.set(query, () => resolve([{ url: `https://example.org/${started.indexOf(query)}`, title: query,
        snippet: '10Y yield 4.12% on 2026-10-25', publishedAt: Date.parse('2026-10-25T00:00:00Z') }]));
    });
    const pending = fanOutAxisEvidence(axes, {
      search,
      now: () => Date.parse('2026-11-01T12:34:56.000Z'),
    });
    expect(started).toEqual(axes.map(axis => axis.searchTerms[0]));
    for (const release of releases.values()) release();
    const result = await pending;
    expect(result.plan).toHaveLength(3);
    expect(result.axes.map(axis => axis.questionId)).toEqual(axes.map(axis => axis.id));
    for (const axis of result.axes) {
      expect(axis.evidence).toHaveLength(1);
      expect(axis.evidence[0]!.questionId).toBe(axis.questionId);
      expect(axis.evidence[0]!.source).toMatch(/^https:\/\/example\.org\//);
      expect(axis.evidence[0]!.publishedAt).toBe('2026-10-25T00:00:00.000Z');
      expect(axis.evidence[0]!.observedAt).toBe('2026-11-01T12:34:56.000Z');
      expect(axis.evidence[0]!.units).toBeUndefined();
      expect(axis.evidence[0]!.outcome).toBe('complete');
      expect(axis.evidence[0]!.truncated).toBe(true);
      expect(axis.evidence[0]!.content).toContain('4.12%');
    }
    expect(result.axes[0]!.evidence[0]!.requestedWindow).toBe('2026-10');
  });

  it('한 축 검색 실패를 다른 축의 근거와 섞지 않고 부분 실패로 기록한다', async () => {
    const result = await fanOutAxisEvidence(axes, { search: async query => {
      if (query.startsWith('Korea')) throw new Error('provider unavailable');
      return [{ url: 'https://example.org/source', title: 'rates', snippet: '4.12%', publishedAt: 0 }];
    } });
    expect(result.axes[0]!.evidence[0]!.questionId).toBe('us-rate');
    expect(result.axes[1]!.evidence).toHaveLength(1);
    expect(result.axes[1]!.evidence[0]).toMatchObject({
      questionId: 'kr-rate', sourceKind: 'search-query', outcome: 'failed', content: 'provider unavailable',
    });
    expect(result.axes[1]!.error).toContain('provider unavailable');
    expect(result.axes[2]!.evidence[0]!.questionId).toBe('spread');
  });

  it('bridge의 조사 축 경로는 통짜 skill invoker를 부르지 않는다', async () => {
    let skillCalls = 0;
    setResearchInvoker(async () => { skillCalls++; return { ok: true, output: 'wrong path' }; });
    try {
      const result = await invokeResearchAxes(axes, { search: async () => [] });
      expect(result.plan).toHaveLength(3);
      expect(result.axes).toHaveLength(3);
      expect(skillCalls).toBe(0);
    } finally {
      setResearchInvoker(null);
    }
  });

  it('bridge axis invocation forwards shared tool admission to production fanout', async () => {
    const admitted: string[] = [];
    const searched: string[] = [];
    const result = await invokeResearchAxes(axes, {
      search: async query => { searched.push(query); return []; },
      admitToolCall: toolName => {
        admitted.push(toolName);
        return admitted.length === 1;
      },
    });

    expect(admitted).toEqual(['OmniSearch', 'OmniSearch', 'OmniSearch']);
    expect(searched).toEqual([axes[0]!.searchTerms[0]]);
    expect(result.axes[0]!.evidence[0]!.outcome).toBe('partial');
    expect(result.axes[1]!.evidence[0]!.content).toContain('research tool budget reached');
    expect(result.axes[2]!.evidence[0]!.content).toContain('research tool budget reached');
  });

  it('fetches one top native search result per axis with WebFetch and preserves fetch provenance', async () => {
    const question = { ...axes[0]!, searchTerms: ['rate term one', 'rate term two'] };
    const admitted: string[] = [];
    const fetched: string[] = [];
    const result = await fanOutAxisEvidence([question], {
      search: async (query) => [{ url: `https://example.org/${query.endsWith('one') ? 'one' : 'two'}`, title: 'Rates', snippet: '4.12%', publishedAt: 0 }],
      fetchPage: async (url, receivedQuestion) => {
        fetched.push(url);
        expect(receivedQuestion.id).toBe(question.id);
        return { url: 'https://example.org/final-source', output: '# Primary source\nThe current yield is 4.12%.' };
      },
      admitToolCall: (name) => { admitted.push(name); return true; },
    });

    expect(admitted.filter(name => name === 'OmniSearch')).toHaveLength(2);
    expect(admitted.filter(name => name === 'WebFetch')).toHaveLength(1);
    expect(fetched).toHaveLength(1);
    expect(result.axes[0]!.evidence).toContainEqual(expect.objectContaining({
      questionId: question.id,
      sourceKind: 'web-fetch',
      source: 'https://example.org/final-source',
      content: '# Primary source\nThe current yield is 4.12%.',
      outcome: 'complete',
    }));
  });

  it('carries a search publisher date to the fetched source only when the URL is the same', async () => {
    const question = { ...axes[0]!, searchTerms: ['dated source'] };
    const result = await fanOutAxisEvidence([question], {
      now: () => Date.parse('2026-11-01T12:34:56.000Z'),
      search: async () => [{
        url: 'https://example.org/published-source', title: 'dated source', snippet: 'Source claim',
        publishedAt: Date.parse('2026-10-30T00:00:00.000Z'),
      }],
      fetchPage: async (url) => ({ url, output: 'Full source claim.' }),
    });

    expect(result.axes[0]!.evidence).toContainEqual(expect.objectContaining({
      sourceKind: 'web-fetch', source: 'https://example.org/published-source',
      publishedAt: '2026-10-30T00:00:00.000Z', observedAt: '2026-11-01T12:34:56.000Z',
    }));
  });

  it('does not transfer a search publisher date to a fetched page with a different URL', async () => {
    const question = { ...axes[0]!, searchTerms: ['redirected source'] };
    const result = await fanOutAxisEvidence([question], {
      search: async () => [{
        url: 'https://example.org/redirect', title: 'dated source', snippet: 'Source claim',
        publishedAt: Date.parse('2026-10-30T00:00:00.000Z'),
      }],
      fetchPage: async () => ({ url: 'https://example.net/replacement', output: 'Different source claim.' }),
    });

    const fetchedEvidence = result.axes[0]!.evidence.find(item => item.sourceKind === 'web-fetch');
    expect(fetchedEvidence).toMatchObject({ source: 'https://example.net/replacement' });
    expect(fetchedEvidence).not.toHaveProperty('publishedAt');
  });

  it('검색 제공자·URL·확인일을 보존하되 없는 게시일·수치 단위는 만들지 않는다', async () => {
    const result = await fanOutAxisEvidence([axes[0]!], {
      now: () => Date.parse('2026-11-01T12:34:56.000Z'),
      search: async () => [{
        url: 'https://example.org/?a=1&amp;b=2', title: 'yield data', snippet: 'change in percent', engine: 'firecrawl',
      }],
    });
    expect(result.axes[0]!.evidence[0]).toMatchObject({
      sourceKind: 'web-search:firecrawl', source: 'https://example.org/?a=1&amp;b=2',
      requestedWindow: '2026-10',
    });
    expect(result.axes[0]!.evidence[0]!.observedAt).toBe('2026-11-01T12:34:56.000Z');
    expect(result.axes[0]!.evidence[0]!.publishedAt).toBeUndefined();
    expect(result.axes[0]!.evidence[0]!.units).toBeUndefined();
  });

  it('빠른 검색의 확인일은 느린 다른 축이 날짜 경계를 넘겨도 바뀌지 않는다', async () => {
    const fast = { ...axes[0]!, searchTerms: ['fast source'] };
    const slow = { ...axes[1]!, searchTerms: ['slow source'] };
    let clock = Date.parse('2026-11-01T23:59:59.000Z');
    let releaseSlow!: (hits: { url: string; title: string; snippet: string }[]) => void;
    const slowResult = new Promise<{ url: string; title: string; snippet: string }[]>(resolve => {
      releaseSlow = resolve;
    });
    const pending = fanOutAxisEvidence([fast, slow], {
      now: () => clock,
      search: async query => query === 'fast source'
        ? [{ url: 'https://example.org/fast', title: 'fast', snippet: 'fast evidence' }]
        : slowResult,
    });

    await Promise.resolve();
    await Promise.resolve();
    clock = Date.parse('2026-11-02T00:00:01.000Z');
    releaseSlow([{ url: 'https://example.org/slow', title: 'slow', snippet: 'slow evidence' }]);
    const result = await pending;

    expect(result.axes[0]!.evidence[0]!.observedAt).toBe('2026-11-01T23:59:59.000Z');
    expect(result.axes[1]!.evidence[0]!.observedAt).toBe('2026-11-02T00:00:01.000Z');
  });

  it('같은 축의 검색어 둘 중 하나가 실패해도 성공 근거와 실패 봉투를 함께 남긴다', async () => {
    const question = { ...axes[0]!, searchTerms: ['primary rate', 'alternate rate'] };
    const result = await fanOutAxisEvidence([question], { search: async query => {
      if (query.startsWith('primary')) throw new Error('primary unavailable');
      return [{ url: 'https://example.org/alternate', title: 'alternate', snippet: '4.12%' }];
    } });
    expect(result.plan.map(call => call.query)).toEqual(['primary rate', 'alternate rate']);
    expect(result.axes[0]!.evidence.map(item => item.outcome)).toEqual(['failed', 'complete']);
    expect(result.axes[0]!.error).toBe('primary unavailable');
    expect(result.axes[0]!.evidence[1]!.source).toBe('https://example.org/alternate');
  });

  it('0·NaN·범위 밖 publishedAt은 게시일로 승격하지 않고 다른 축 결과를 보존한다', async () => {
    const times = [0, Number.NaN, 1e30];
    const result = await fanOutAxisEvidence(axes, { search: async query => [{
      url: 'https://example.org/rate', title: 'yield', snippet: '4.12%',
      publishedAt: times[axes.findIndex(axis => axis.searchTerms[0] === query)]!,
    }] });
    expect(result.axes).toHaveLength(3);
    expect(result.axes.map(axis => axis.evidence.length)).toEqual([1, 1, 1]);
    for (const axis of result.axes) expect(axis.evidence[0]!.publishedAt).toBeUndefined();
  });

  it('검색어가 없거나 결과 0건이어도 이유를 축별 봉투로 남긴다', async () => {
    const empty = { ...axes[0]!, searchTerms: [] };
    const result = await fanOutAxisEvidence([empty, axes[1]!], { search: async () => [] });
    expect(result.axes[0]!.evidence[0]).toMatchObject({ questionId: 'us-rate', outcome: 'failed' });
    expect(result.axes[1]!.evidence[0]).toMatchObject({ questionId: 'kr-rate', outcome: 'partial' });
  });

  it('제공자 일부가 실패해도 같은 호출의 다른 제공자 히트는 보존한다', async () => {
    const result = await fanOutAxisEvidence([axes[0]!], { search: async () => ({
      hits: [{ url: 'https://example.org/ok', title: 'rate', snippet: '4.12%' }],
      errors: ['firecrawl: timeout'],
    }) });
    expect(result.axes[0]!.evidence.map(item => item.outcome)).toEqual(['complete', 'failed']);
    expect(result.axes[0]!.error).toContain('firecrawl: timeout');
  });

  it('일반 다축 검색은 Grok을 생략하고 설정된 Firecrawl을 먼저 호출한다', async () => {
    const calls: string[] = [];
    const provider = (id: string): WebSearchProvider => ({
      id, displayName: id, available: () => true,
      search: async ({ query }) => {
        calls.push(`${id}:${query}`);
        return { providerName: id, durationMs: 1, hits: [{ url: `https://example.org/${id}`, title: id, snippet: query }] };
      },
    });
    const search = createResearchAxisSearcher([provider('grok'), provider('firecrawl'), provider('ddg-free')]);
    const results = await Promise.all([search('first axis'), search('second axis')]);
    expect(calls.map(call => call.split(':')[0]).sort()).toEqual(['firecrawl', 'firecrawl']);
    expect(results.flatMap(result => Array.isArray(result) ? result : result.hits).map(hit => hit.engine).sort())
      .toEqual(['firecrawl', 'firecrawl']);
  });

  it('최신·여론 질문도 Grok 없이 Exa/Firecrawl만 호출한다', async () => {
    const calls: string[] = [];
    const provider = (id: string): WebSearchProvider => ({
      id, displayName: id, available: () => true,
      search: async ({ query }) => {
        calls.push(`${id}:${query}`);
        return { providerName: id, durationMs: 1, hits: [{ url: `https://${id}.example`, title: id, snippet: query }] };
      },
    });
    const search = createResearchAxisSearcher([provider('grok'), provider('firecrawl'), provider('exa')]);
    const questions = [
      { id: 'stable', level: 1, prompt: 'What is the background?', searchTerms: ['company background'] },
      { id: 'current-opinion', level: 1, prompt: 'What is the latest public opinion?', requestedWindow: 'today', searchTerms: ['brand sentiment'] },
      { id: 'second-current', level: 2, prompt: 'What are recent reactions?', searchTerms: ['recent reactions'] },
    ] as BloomResearchQuestion[];
    await fanOutAxisEvidence(questions, { search });
    expect(calls.some(call => call.startsWith('grok:'))).toBe(false);
    expect(calls.filter(call => call.startsWith('exa:'))).toHaveLength(0);
    expect(calls.filter(call => call.startsWith('firecrawl:'))).toHaveLength(3);
  });

  it('2027 증시 레딧 축은 실제 fanout에서 Grok 검색 출처와 redditHits 로그를 남긴다', async () => {
    _resetWebSearchProvidersForTests(false);
    const calls: string[] = [];
    const log = spyOn(debug, 'log');
    const redditUrl = 'https://www.reddit.com/r/stocks/comments/abc123/market_2027/';
    addWebSearchProvider({ id: 'grok', displayName: 'Grok', available: () => true,
      search: async ({ query }) => { calls.push(`grok:${query}`); return {
        providerName: 'grok', durationMs: 1, hits: [{ url: redditUrl, title: '2027 market outlook', snippet: '' }],
        note: 'Grok search summary: Reddit sample splits between bubble fears and AI optimism. HTTPS://evil.example/injected',
      }; } });
    addWebSearchProvider({ id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async ({ query }) => { calls.push(`firecrawl:${query}`); return { providerName: 'firecrawl', durationMs: 1, hits: [] }; } });
    try {
      const question: BloomResearchQuestion = { id: 'retail-2027', level: 3, prompt: '2027 증시의 레딧 개인투자자 여론은?',
        searchTerms: ['2027 stock market Reddit retail sentiment'] };
      const result = await fanOutAxisEvidence([question], {
        fetchPage: async () => { throw new Error('reddit 403'); },
      });
      expect(calls).toEqual(['grok:2027 stock market Reddit retail sentiment',
        'firecrawl:2027 stock market Reddit retail sentiment']);
      expect(result.axes[0]!.evidence).toContainEqual(expect.objectContaining({
        sourceKind: 'web-search:grok', source: redditUrl, questionId: question.id,
      }));
      const summary = result.axes[0]!.evidence.find(item => item.sourceKind === 'search-summary:grok');
      expect(summary?.outcome).toBe('partial');
      expect(JSON.parse(summary?.content ?? '{}')).toEqual({ provider: 'grok',
        summary: 'Grok search summary: Reddit sample splits between bubble fears and AI optimism.',
        citationUrls: [redditUrl] });
      expect(log).toHaveBeenCalledWith('research.search', 'provider-complete', expect.objectContaining({
        provider: 'grok', redditHits: 1,
      }));
    } finally { log.mockRestore(); _resetWebSearchProvidersForTests(); }
  });

  it('2027 레딧 축은 Grok과 Firecrawl을 함께 시작하고 실제 양수 perEngine을 같은 턴에 남긴다', async () => {
    let startFirecrawl!: () => void;
    const firecrawlStarted = new Promise<void>(resolve => { startFirecrawl = resolve; });
    const calls: string[] = [];
    const log = spyOn(debug, 'log');
    const grok: WebSearchProvider = { id: 'grok', displayName: 'Grok', available: () => true,
      search: async () => {
        calls.push('grok');
        await Promise.race([firecrawlStarted, new Promise<void>(resolve => setTimeout(resolve, 100))]);
        return { providerName: 'grok', durationMs: 1, hits: [
          { url: 'https://www.reddit.com/r/stocks/comments/2027/', title: 'Reddit 2027', snippet: 'Retail opinion' },
        ] };
      } };
    const firecrawl: WebSearchProvider = { id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async () => {
        calls.push('firecrawl'); startFirecrawl();
        return { providerName: 'firecrawl', durationMs: 1, hits: [
          { url: 'https://example.org/2027-outlook', title: '2027 outlook', snippet: 'Research' },
        ] };
      } };
    try {
      const question: BloomResearchQuestion = { id: 'dual-2027', level: 3,
        prompt: '2027 증시 전망과 레딧 여론은?', searchTerms: ['2027 stock market Reddit outlook'] };
      const result = await fanOutAxisEvidence([question], {
        search: createResearchAxisSearcher([grok, firecrawl]),
        fetchPage: async url => ({ url, output: 'Source text' }),
      });
      expect(calls).toEqual(['grok', 'firecrawl']);
      expect(result.axes[0]!.evidence).toContainEqual(expect.objectContaining({
        sourceKind: 'web-search:grok', source: 'https://www.reddit.com/r/stocks/comments/2027/',
      }));
      expect(result.axes[0]!.evidence).toContainEqual(expect.objectContaining({
        sourceKind: 'web-search:firecrawl', source: 'https://example.org/2027-outlook',
      }));
      expect(log).toHaveBeenCalledWith('research.search', 'social-parallel-complete', expect.objectContaining({
        perEngine: { grok: expect.objectContaining({ hits: 1 }), firecrawl: expect.objectContaining({ hits: 1 }) },
      }));
    } finally { log.mockRestore(); }
  });

  it('12초 Grok Reddit 축은 채택하고 일반 축의 첫 근거는 그보다 먼저 전달한다', async () => {
    const arrivals: string[] = [];
    const grok: WebSearchProvider = { id: 'grok', displayName: 'Grok', available: () => true,
      search: async (_query, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ providerName: 'grok', durationMs: 12_000, hits: [
          { url: 'https://www.reddit.com/r/stocks/comments/slow_real/', title: '2027 discussion', snippet: 'Retail views' },
        ] }), 12_000);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      }) };
    const web: WebSearchProvider = { id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async () => ({ providerName: 'firecrawl', durationMs: 1, hits: [
        { url: 'https://example.org/market', title: 'Market', snippet: 'Outlook' },
      ] }) };
    const questions: BloomResearchQuestion[] = [
      { id: 'social', level: 3, prompt: '2027 증시 레딧 여론은?', searchTerms: ['2027 stock market Reddit sentiment'] },
      { id: 'market', level: 1, prompt: '2027 증시 전망은?', searchTerms: ['2027 stock market outlook'] },
    ];
    const result = await fanOutAxisEvidence(questions, {
      search: createResearchAxisSearcher([grok, web]), fetchPage: async (url) => ({ url, output: 'Source text' }),
      onAxisEvidence: id => { arrivals.push(id); },
    });
    expect(arrivals[0]).toBe('market');
    expect(result.axes[0]!.evidence).toContainEqual(expect.objectContaining({
      sourceKind: 'web-search:grok', source: 'https://www.reddit.com/r/stocks/comments/slow_real/',
    }));
  }, { timeout: 20_000 });

  it('무응답 Grok 뒤에도 전체 소셜 마감 전에 DDG Reddit 근거를 채택한다', async () => {
    const calls: string[] = [];
    const grok: WebSearchProvider = { id: 'grok', displayName: 'Grok', available: () => true,
      search: async () => { calls.push('grok'); return new Promise(() => undefined); } };
    const ddg: WebSearchProvider = { id: 'ddg-free', displayName: 'DDG', available: () => true,
      search: async () => { calls.push('ddg-free'); return { providerName: 'ddg-free', durationMs: 1, hits: [
        { url: 'https://www.reddit.com/r/stocks/comments/fallback/', title: 'Reddit 2027', snippet: 'Retail views' },
      ] }; } };
    const question: BloomResearchQuestion = { id: 'retail-2027-stuck', level: 3,
      prompt: '2027 증시 레딧 여론은?', searchTerms: ['2027 stock market Reddit sentiment'] };
    const result = await fanOutAxisEvidence([question], {
      search: createResearchAxisSearcher([grok, ddg]),
      fetchPage: async url => ({ url, output: 'Reddit discussion' }),
    });
    expect(calls).toEqual(['grok', 'ddg-free']);
    expect(result.axes[0]!.evidence).toContainEqual(expect.objectContaining({
      sourceKind: 'web-search:ddg-free', source: 'https://www.reddit.com/r/stocks/comments/fallback/',
    }));
  }, { timeout: 35_000 });

  it('레딧을 질문에서만 명시해도 Grok을 쓰고 위장 호스트는 0건으로 세어 웹 폴백한다', async () => {
    const calls: string[] = [];
    const provider = (id: string, url: string): WebSearchProvider => ({ id, displayName: id, available: () => true,
      search: async () => { calls.push(id); return { providerName: id, durationMs: 1,
        hits: [{ url, title: 'source', snippet: 'public views' }] }; } });
    const log = spyOn(debug, 'log');
    try {
      const search = createResearchAxisSearcher([
        provider('grok', 'https://reddit.com.evil.example/r/stocks'),
        provider('firecrawl', 'https://www.reddit.com/r/stocks/comments/real/'),
      ]);
      const result = await search('2027 market outlook', undefined, { questionPrompt: '레딧 여론은?' });
      expect(calls).toEqual(['grok', 'firecrawl']);
      expect((Array.isArray(result) ? result : result.hits).map(hit => hit.url)).toEqual([
        'https://www.reddit.com/r/stocks/comments/real/',
      ]);
      expect(log).toHaveBeenCalledWith('research.search', 'provider-complete', expect.objectContaining({
        provider: 'grok', redditHits: 0,
      }));
    } finally { log.mockRestore(); }
  });

  it('명시 X 여론 축은 Grok X 링크를 쓰고 일반 증시 축은 Firecrawl을 유지한다', async () => {
    const calls: string[] = [];
    const provider = (id: string, url: string): WebSearchProvider => ({ id, displayName: id, available: () => true,
      search: async () => { calls.push(id); return { providerName: id, durationMs: 1,
        hits: [{ url, title: 'source', snippet: 'public views' }] }; } });
    const search = createResearchAxisSearcher([
      provider('grok', 'https://x.com/market/status/123'),
      provider('firecrawl', 'https://example.org/market'),
    ]);
    const x = await search('2027 stock market X reactions');
    const generic = await search('2027 stock market outlook');
    expect(calls).toEqual(['grok', 'firecrawl', 'firecrawl']);
    expect((Array.isArray(x) ? x : x.hits)[0]).toMatchObject({ engine: 'grok', url: 'https://x.com/market/status/123' });
    expect((Array.isArray(generic) ? generic : generic.hits)[0]).toMatchObject({ engine: 'firecrawl' });
  });

  it('Grok 구독 검색이 멈춰도 공유 예산 일부만 쓰고 Reddit 웹 검색으로 폴백한다', async () => {
    const calls: string[] = [];
    const grok: WebSearchProvider = { id: 'grok-social', displayName: 'Grok social', available: () => true,
      search: async (_query, signal) => { calls.push('grok-social'); await new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }); return { providerName: 'grok-social', durationMs: 0, hits: [] }; } };
    const web: WebSearchProvider = { id: 'ddg-free', displayName: 'DDG', available: () => true,
      search: async () => { calls.push('ddg-free'); return { providerName: 'ddg-free', durationMs: 1,
        hits: [{ url: 'https://www.reddit.com/r/stocks/comments/fallback/', title: 'Reddit', snippet: 'view' }] }; } };
    const search = createResearchAxisSearcher([grok, web], Date.now, undefined, { socialGrokBudgetMs: 10 });
    const result = await search('2027 stock market Reddit views');
    expect(calls).toEqual(['grok-social', 'ddg-free']);
    expect((Array.isArray(result) ? result : result.hits)[0]).toMatchObject({ engine: 'ddg-free' });
  });

  it('Grok 403의 내부 팀 식별자를 조사 축 오류 봉투에 싣지 않는다', async () => {
    const log = spyOn(debug, 'log');
    const grok: WebSearchProvider = { id: 'grok', displayName: 'Grok', available: () => true,
      search: async () => { throw new Error('grok responses 403: permission-denied team private-team-id'); } };
    const web: WebSearchProvider = { id: 'ddg-free', displayName: 'DDG', available: () => true,
      search: async () => ({ providerName: 'ddg-free', durationMs: 1, hits: [
        { url: 'https://www.reddit.com/r/stocks/comments/fallback/', title: 'Reddit', snippet: 'view' },
      ] }) };
    const search = createResearchAxisSearcher([grok, web]);
    try {
      const result = await search('2027 stock market Reddit views');
      expect(Array.isArray(result)).toBe(false);
      if (Array.isArray(result)) return;
      expect(result.errors).toEqual(['grok: grok credential or quota unavailable']);
      expect(JSON.stringify(result)).not.toContain('private-team-id');
      expect(result.hits[0]?.engine).toBe('ddg-free');
      expect(log).toHaveBeenCalledWith('research.search', 'social-parallel-complete', expect.objectContaining({
        perEngine: {
          grok: expect.objectContaining({ hits: 0, error: 'grok credential or quota unavailable' }),
          'ddg-free': expect.objectContaining({ hits: 1 }),
        },
      }));
    } finally { log.mockRestore(); }
  });

  it('research abort signal reaches each queued axis search', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const pending = fanOutAxisEvidence([axes[0]!], {
      signal: controller.signal,
      search: async (_query, signal) => {
        received = signal;
        return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
      },
    });
    controller.abort();
    await pending;
    expect(received).toBe(controller.signal);
  });

  it('shared tool admission caps dispatched OmniSearch calls and retains denied axes as failure evidence', async () => {
    let admitted = 0;
    let searched = 0;
    const result = await fanOutAxisEvidence(axes, {
      admitToolCall: name => { expect(name).toBe('OmniSearch'); if (admitted >= 2) return false; admitted += 1; return true; },
      search: async query => { searched += 1; return [{ title: query, url: `https://example.org/${query}`, snippet: 'evidence' }]; },
    });

    expect(admitted).toBe(2);
    expect(searched).toBe(2);
    expect(result.plan).toHaveLength(3);
    expect(result.axes.flatMap(axis => axis.evidence).some(item => item.content.includes('research tool budget reached'))).toBe(true);
  });

  it('일반 금리 축은 무료 DDG 성공 뒤 다른 공급자를 호출하지 않는다', async () => {
    _resetWebSearchProvidersForTests(false);
    const calls: string[] = [];
    for (const id of ['grok', 'grok-api', 'exa', 'firecrawl', 'tavily', 'ddg']) {
      addWebSearchProvider({
        id, displayName: id, available: () => true,
        search: async () => {
          calls.push(id);
          return { providerName: id, durationMs: 1, hits: [{ url: `https://${id}.example`, title: id, snippet: 'axis evidence' }] };
        },
      });
    }
    try {
      const result = await fanOutAxisEvidence([axes[0]!]);
      expect(calls).toEqual(['firecrawl']);
      expect(result.axes[0]!.evidence.map(item => item.sourceKind)).toEqual(['web-search:firecrawl']);
    } finally {
      _resetWebSearchProvidersForTests();
    }
  });

  it('Firecrawl 공백 뒤 Exa 성공 시 DDG 폴백은 호출하지 않는다', async () => {
    const calls: string[] = [];
    const provider = (id: string, search: WebSearchProvider['search']): WebSearchProvider => ({
      id, displayName: id, available: () => true, search,
    });
    const search = createResearchAxisSearcher([
      provider('exa', async () => {
        calls.push('exa');
        return { providerName: 'exa', durationMs: 1, hits: [{ url: 'https://exa.example', title: 'Exa', snippet: 'primary' }] };
      }),
      provider('firecrawl', async () => {
        calls.push('firecrawl');
        return { providerName: 'firecrawl', durationMs: 1, hits: [] };
      }),
      provider('ddg-free', async () => {
        calls.push('ddg-free');
        return { providerName: 'ddg-free', durationMs: 1, hits: [] };
      }),
    ]);

    const result = await search('latest public opinion topic');

    expect(calls).toEqual(['firecrawl', 'exa']);
    expect(Array.isArray(result) ? result : result.hits).toMatchObject([
      { url: 'https://exa.example', engine: 'exa' },
    ]);
  });

  it('기본 registry의 test 격리 research 진입점은 DDG provenance와 fallback 로그를 남긴다', () => {
    const root = mkdtempSync(join(tmpdir(), 'axis-fanout-default-registry-'));
    const home = join(root, 'home');
    mkdirSync(home);
    const stateRoot = join(root, 'state');
    const script = `
      const { applyIsolatedRoot } = await import(${JSON.stringify(join(process.cwd(), 'src/cli/test-state-dir-flag.ts'))});
      applyIsolatedRoot(process.env.TEST_INSTANCE_ROOT);
      const { debug } = await import(${JSON.stringify(join(process.cwd(), 'src/debug/log.ts'))});
      const events = [];
      debug.log = (category, event, data) => events.push({ category, event, data });
      const { withFakeFetchDevice } = await import(${JSON.stringify(join(process.cwd(), 'src/ux-sim/fake-fetch.ts'))});
      const { getAvailableResearchWebSearchProviders } = await import(${JSON.stringify(join(process.cwd(), 'src/web-search/index.ts'))});
      const providers = getAvailableResearchWebSearchProviders();
      if (providers.some(provider => ['exa', 'firecrawl'].includes(provider.id))) throw new Error('paid provider unexpectedly available');
      const { invokeResearchAxes } = await import(${JSON.stringify(join(process.cwd(), 'src/research-bridge/invoke.ts'))});
      await withFakeFetchDevice([{ url: 'https://html.duckduckgo.com/html/', method: 'POST', response: () => new Response('<div class="result"><a class="result__a" href="https://example.org/ddg">DDG fallback result</a><a class="result__snippet">public snippet</a></div>', { status: 200 }) }], async device => {
        const result = await invokeResearchAxes([{ id: 'ddg-default', level: 1, prompt: 'Find a public source.', searchTerms: ['public research source'] }], {
          fetchPage: async url => ({ url, output: 'fetched test page' }),
        });
        const evidence = result.axes.flatMap(axis => axis.evidence);
        console.log('AXIS_ENTRYPOINT_RESULT=' + JSON.stringify({
          providerIds: providers.map(provider => provider.id),
          sourceKinds: evidence.map(item => item.sourceKind),
          fallbackLog: events.some(event => event.category === 'research.search' && event.event === 'provider-preflight' && event.data.keylessFallback === 'ddg-free'),
          providerLog: events.some(event => event.category === 'research.search' && event.event === 'provider-complete' && event.data.provider === 'ddg-free'),
          fetchCalls: device.calls(),
        }));
      });
    `;
    try {
      const child = spawnSync('bun', ['-e', script], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          TMPDIR: root,
          NODE_ENV: 'test',
          TEST_INSTANCE_ROOT: stateRoot,
        },
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (child.status !== 0) throw new Error(child.stderr || child.stdout);
      expect(child.status).toBe(0);
      const line = child.stdout.split('\n').find(item => item.startsWith('AXIS_ENTRYPOINT_RESULT='));
      expect(line).toBeDefined();
      const result = JSON.parse(line!.slice('AXIS_ENTRYPOINT_RESULT='.length));
      expect(result.providerIds).toContain('ddg-free');
      expect(result.sourceKinds).toContain('web-search:ddg-free');
      expect(result.fallbackLog).toBe(true);
      expect(result.providerLog).toBe(true);
      expect(result.fetchCalls).toMatchObject([{ url: 'https://html.duckduckgo.com/html/', method: 'POST', routeId: 'route-1', status: 200 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('무료 DDG만 있으면 이를 쓰고 화면·로그에 출처를 남긴다', async () => {
    const calls: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const ddg: WebSearchProvider = {
      id: 'ddg-free', displayName: 'DuckDuckGo (keyless)', available: () => true,
      search: async ({ query }) => {
        calls.push('ddg-free');
        return { providerName: 'ddg-free', durationMs: 1,
          hits: [{ url: 'https://example.org/ddg', title: query, snippet: 'public result' }] };
      },
    };
    try {
      const result = await fanOutAxisEvidence([axes[0]!], {
        search: createResearchAxisSearcher([ddg]),
      });
      expect(calls).toEqual(['ddg-free']);
      expect(result.axes[0]!.evidence[0]).toMatchObject({
        sourceKind: 'web-search:ddg-free', source: 'https://example.org/ddg', outcome: 'complete',
      });
      expect(log).toHaveBeenCalledWith('research.search', 'provider-preflight', expect.objectContaining({
        allowed: ['ddg-free'], keylessFallback: 'ddg-free',
      }));
      expect(log).toHaveBeenCalledWith('research.search', 'provider-complete', expect.objectContaining({
        provider: 'ddg-free', hits: 1,
      }));
    } finally {
      log.mockRestore();
    }
  });

  it('Firecrawl·Exa 실패 뒤 무료 DDG로 폴백하며 Grok은 호출하지 않는다', async () => {
    const calls: string[] = [];
    const provider = (id: string, search: WebSearchProvider['search']): WebSearchProvider => ({
      id, displayName: id, available: () => true, search,
    });
    const search = createResearchAxisSearcher([
      provider('grok', async () => { calls.push('grok'); return { providerName: 'grok', durationMs: 1, hits: [] }; }),
      provider('exa', async () => {
        calls.push('exa');
        throw new Error('Exa unavailable');
      }),
      provider('firecrawl', async () => {
        calls.push('firecrawl');
        throw new Error('Firecrawl unavailable');
      }),
      provider('ddg-free', async () => { calls.push('ddg-free'); return { providerName: 'ddg-free', durationMs: 1, hits: [] }; }),
    ]);

    const result = await search('latest public opinion topic');

    expect(calls).toEqual(['firecrawl', 'exa', 'ddg-free']);
    expect(Array.isArray(result) ? [] : result.hits).toEqual([]);
  });

  it('한 축의 Firecrawl timeout 뒤에도 다음 축을 실제로 검색한다', async () => {
    const calls: string[] = [];
    const firecrawl: WebSearchProvider = {
      id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async ({ query }) => {
        calls.push(query);
        if (calls.length === 1) throw new DOMException('one axis timed out', 'TimeoutError');
        return { providerName: 'firecrawl', durationMs: 1,
          hits: [{ url: 'https://example.org/second-axis', title: 'second axis', snippet: 'measured source' }] };
      },
    };

    const result = await fanOutAxisEvidence(axes.slice(0, 2), {
      search: createResearchAxisSearcher([firecrawl]),
    });

    expect(calls).toEqual(axes.slice(0, 2).map(axis => axis.searchTerms[0]));
    expect(result.axes[0]!.error).toContain('timed out');
    expect(result.axes[1]!.evidence).toContainEqual(expect.objectContaining({
      sourceKind: 'web-search:firecrawl', source: 'https://example.org/second-axis', outcome: 'complete',
    }));
  });

  it('연속 두 번의 Firecrawl 실패 뒤에만 세 번째 축을 breaker로 건너뛴다', async () => {
    const calls: string[] = [];
    const firecrawl: WebSearchProvider = {
      id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async ({ query }) => {
        calls.push(query);
        throw new DOMException('axis timed out', 'TimeoutError');
      },
    };

    const result = await fanOutAxisEvidence(axes, { search: createResearchAxisSearcher([firecrawl]) });

    expect(calls).toEqual(axes.slice(0, 2).map(axis => axis.searchTerms[0]));
    expect(result.axes[2]!.evidence).toContainEqual(expect.objectContaining({
      outcome: 'failed', content: 'no healthy research search provider',
    }));
  });

  for (const [label, failure] of [
    ['quota', () => new Error('provider quota exhausted')],
    ['blocked', () => Object.assign(new Error('provider blocked request'), { reason: 'blocked' })],
  ] as const) {
    it(`${label} 한 번이면 다음 축에서 같은 공급자 재요청 0`, async () => {
      const calls: string[] = [];
      const firecrawl: WebSearchProvider = {
        id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
        search: async ({ query }) => { calls.push(query); throw failure(); },
      };

      const result = await fanOutAxisEvidence(axes.slice(0, 2), { search: createResearchAxisSearcher([firecrawl]) });

      expect(calls).toEqual([axes[0]!.searchTerms[0]]);
      expect(result.axes[1]!.evidence).toContainEqual(expect.objectContaining({
        outcome: 'failed', content: 'no healthy research search provider',
      }));
    });
  }

  it('성공한 축이 있으면 Firecrawl의 연속 실패 횟수를 다시 센다', async () => {
    const calls: string[] = [];
    const firecrawl: WebSearchProvider = {
      id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async ({ query }) => {
        calls.push(query);
        if (calls.length === 1 || calls.length === 3) throw new DOMException('axis timed out', 'TimeoutError');
        return { providerName: 'firecrawl', durationMs: 1,
          hits: [{ url: `https://example.org/axis-${calls.length}`, title: 'axis', snippet: 'source' }] };
      },
    };
    const extra = { ...axes[0]!, id: 'fourth', searchTerms: ['fourth axis'] };
    const questions = [...axes, extra];

    const result = await fanOutAxisEvidence(questions, { search: createResearchAxisSearcher([firecrawl]) });

    expect(calls).toEqual(questions.map(axis => axis.searchTerms[0]));
    expect(result.axes[3]!.evidence).toContainEqual(expect.objectContaining({
      sourceKind: 'web-search:firecrawl', source: 'https://example.org/axis-4', outcome: 'complete',
    }));
  });

  it('남은 연구 예산이 없을 때는 breaker 대신 예산 소진 이유를 남긴다', async () => {
    let clock = 0;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const firecrawl: WebSearchProvider = {
      id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async () => {
        clock = 11;
        return { providerName: 'firecrawl', durationMs: 1, hits: [] };
      },
    };
    try {
      const search = createResearchAxisSearcher([firecrawl], () => clock, 10);
      const result = await fanOutAxisEvidence(axes.slice(0, 2), { search });
      expect(result.axes[1]!.budgetExhausted).toBe(true);
      expect(log).toHaveBeenCalledWith('research.search', 'provider-skipped', expect.objectContaining({
        provider: 'firecrawl', reason: 'research-budget-exhausted',
      }));
      expect(log).not.toHaveBeenCalledWith('research.search', 'provider-skipped', expect.objectContaining({
        provider: 'firecrawl', reason: 'breaker-open',
      }));
    } finally {
      log.mockRestore();
    }
  });

  it('Grok timeout은 research axis 경로에서 발생하지 않는다', async () => {
    let grokCalls = 0;
    let firecrawlCalls = 0;
    const grok: WebSearchProvider = {
      id: 'grok', displayName: 'Grok', available: () => true,
      search: async () => { grokCalls += 1; throw new DOMException('timed out', 'TimeoutError'); },
    };
    const firecrawl: WebSearchProvider = {
      id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async ({ query }) => {
        firecrawlCalls += 1;
        return { providerName: 'firecrawl', durationMs: 1,
          hits: [{ url: 'https://example.org/source', title: query, snippet: 'evidence' }] };
      },
    };
    const exa: WebSearchProvider = { id: 'exa', displayName: 'Exa', available: () => true,
      search: async () => ({ providerName: 'exa', durationMs: 1, hits: [{ url: 'https://example.org/exa', title: 'exa', snippet: 'ok' }] }) };
    const search = createResearchAxisSearcher([grok, firecrawl, exa]);
    const result = await search('latest public opinion');
    expect(grokCalls).toBe(0);
    expect(firecrawlCalls).toBe(1);
    expect((Array.isArray(result) ? result : result.hits).map(hit => hit.engine)).toEqual(['firecrawl']);
  });

  it('Firecrawl 기본 검색도 14.5초 예산과 부모 signal을 유지한다', async () => {
    const calls: string[] = [];
    const exa: WebSearchProvider = {
      id: 'exa', displayName: 'Exa', available: () => true,
      search: async (_query, signal) => new Promise(resolve => {
        signal?.addEventListener('abort', () => resolve({ providerName: 'exa', durationMs: 4_500, hits: [] }), { once: true });
      }),
    };
    const firecrawl: WebSearchProvider = {
      id: 'firecrawl', displayName: 'Firecrawl', available: () => true,
      search: async (_query, signal) => {
        calls.push('firecrawl');
        expect(signal).toBeInstanceOf(AbortSignal);
        return { providerName: 'firecrawl', durationMs: 1, hits: [{ url: 'https://firecrawl.example', title: 'fallback', snippet: 'ok' }] };
      },
    };
    const search = createResearchAxisSearcher([exa, firecrawl]);
    const started = Date.now();
    const result = await search('topic');
    expect(Date.now() - started).toBeLessThan(RESEARCH_SEARCH_BUDGET_MS);
    expect(calls).toEqual(['firecrawl']);
    expect(Array.isArray(result) ? result : result.hits).toMatchObject([{ engine: 'firecrawl' }]);
  });

  it('fixed search hits retain publisher date separately from the date we checked the source', async () => {
    const result = await fanOutAxisEvidence([axes[0]!], {
      now: () => Date.parse('2026-11-01T12:34:56.000Z'),
      search: async () => [{
        url: 'https://example.org/yield-report',
        title: 'Treasury yield report',
        snippet: 'The 10-year yield closed at 4.12%.',
        publishedAt: Date.parse('2026-10-30T00:00:00.000Z'),
      }],
    });

    expect(result.axes[0]!.evidence[0]).toMatchObject({
      source: 'https://example.org/yield-report',
      publishedAt: '2026-10-30T00:00:00.000Z',
      observedAt: '2026-11-01T12:34:56.000Z',
    });
  });
});
