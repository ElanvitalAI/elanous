import { describe, expect, it } from 'bun:test';
import { fanOutAxisEvidence, planAxisToolCalls } from './axis-fanout.js';
import { invokeResearchAxes, setResearchInvoker } from '../research-bridge/invoke.js';
import type { BloomResearchQuestion } from '../auto-research/question-ladder-contract.js';

const axes = [
  { id: 'us-rate', level: 1, prompt: '미국 10년물 금리는?', requestedWindow: '2026-10', searchTerms: ['US 10 year Treasury yield October 2026'] },
  { id: 'kr-rate', level: 1, prompt: '한국 10년물 금리는?', searchTerms: ['Korea 10 year government bond yield October 2026'] },
  { id: 'spread', level: 3, prompt: '양국 금리차는?', searchTerms: ['US Korea 10 year bond spread October 2026'] },
] as BloomResearchQuestion[];

describe('research axis fanout', () => {
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
    const pending = fanOutAxisEvidence(axes, { search });
    expect(started).toEqual(axes.map(axis => axis.searchTerms[0]));
    for (const release of releases.values()) release();
    const result = await pending;
    expect(result.plan).toHaveLength(3);
    expect(result.axes.map(axis => axis.questionId)).toEqual(axes.map(axis => axis.id));
    for (const axis of result.axes) {
      expect(axis.evidence).toHaveLength(1);
      expect(axis.evidence[0]!.questionId).toBe(axis.questionId);
      expect(axis.evidence[0]!.source).toMatch(/^https:\/\/example\.org\//);
      expect(axis.evidence[0]!.observedAt).toContain('2026-10-25');
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

  it('검색 제공자와 원문 URL을 보존하되 없는 관측일·수치 단위는 만들지 않는다', async () => {
    const result = await fanOutAxisEvidence([axes[0]!], { search: async () => [{
      url: 'https://example.org/?a=1&amp;b=2', title: 'yield data', snippet: 'change in percent', engine: 'firecrawl',
    }] });
    expect(result.axes[0]!.evidence[0]).toMatchObject({
      sourceKind: 'web-search:firecrawl', source: 'https://example.org/?a=1&amp;b=2',
      requestedWindow: '2026-10',
    });
    expect(result.axes[0]!.evidence[0]!.observedAt).toBeUndefined();
    expect(result.axes[0]!.evidence[0]!.units).toBeUndefined();
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

  it('0·NaN·범위 밖 publishedAt은 관측일로 승격하지 않고 다른 축 결과를 보존한다', async () => {
    const times = [0, Number.NaN, 1e30];
    const result = await fanOutAxisEvidence(axes, { search: async query => [{
      url: 'https://example.org/rate', title: 'yield', snippet: '4.12%',
      publishedAt: times[axes.findIndex(axis => axis.searchTerms[0] === query)]!,
    }] });
    expect(result.axes).toHaveLength(3);
    expect(result.axes.map(axis => axis.evidence.length)).toEqual([1, 1, 1]);
    for (const axis of result.axes) expect(axis.evidence[0]!.observedAt).toBeUndefined();
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
});
