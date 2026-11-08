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

  it('일반 다축 검색은 Grok을 생략하고 Firecrawl만 호출한다', async () => {
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
    expect(calls.filter(call => call.startsWith('exa:'))).toHaveLength(3);
    expect(calls.filter(call => call.startsWith('firecrawl:'))).toHaveLength(0);
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

  it('일반 금리 축은 Exa 성공 뒤 다른 공급자를 호출하지 않는다', async () => {
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
      expect(calls).toEqual(['exa']);
      expect(result.axes[0]!.evidence.map(item => item.sourceKind)).toEqual(['web-search:exa']);
    } finally {
      _resetWebSearchProvidersForTests();
    }
  });

  it('Exa 성공 시 웹 폴백은 즉시 멈춰 뒤 공급자를 호출하지 않는다', async () => {
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

    expect(calls).toEqual(['exa']);
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

  it('유료 provider가 없으면 DDG를 최후 폴백으로 쓰고 화면·로그에 출처를 남긴다', async () => {
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

  it('Exa 실패 뒤 Firecrawl만 폴백하며 Grok과 DDG는 호출하지 않는다', async () => {
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

    expect(calls).toEqual(['exa', 'firecrawl']);
    expect(Array.isArray(result) ? [] : result.hits).toEqual([]);
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
    expect(firecrawlCalls).toBe(0);
    expect((Array.isArray(result) ? result : result.hits).map(hit => hit.engine)).toEqual(['exa']);
  });

  it('Exa가 멈춰도 14.5초 예산 안에서 Firecrawl에 남은 시간이 전달된다', async () => {
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
