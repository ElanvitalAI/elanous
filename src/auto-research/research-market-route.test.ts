// DEMO-RESEARCH-MARKET-DATA — the research turn calls market-data capability nodes first when the PLAN's route says
// topic "market"; any other turn is byte-for-byte the old path (zero market-data calls, zero events).
// Fake plan · fake web axes · fixed fetcher · injected credential/registry — no network, no host key.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as llmModule from '../llm.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { runCoreTurn } from '../core-turn/run-core-turn.js';
import { debug } from '../debug/log.js';
import { createEodhdDeclarations } from '../graph-runner/capability-providers/market-data/eodhd.js';
import { marketDataRegistry } from '../graph-runner/capability-providers/market-data/registry.js';
import { routeResearchOutput } from '../research/output-router.js';
import type { BloomResearchQuestion } from './question-ladder-contract.js';
import { researchTurnForGrounding, runResearchQuestionLadder, type ResearchQuestionLadderRunOptions } from './research-turn.js';

const outputContract = {
  deliverable: 'A sourced answer', format: 'Short memo',
  sections: [{ id: 'facts', title: 'Facts', purpose: 'State the supported facts.' }],
  completionCriteria: ['Every claim is supported or marked uncertain.'],
};
const questions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`, level: (index + 1) as BloomResearchQuestion['level'], prompt: `Question ${index + 1}`,
  searchTerms: [`plan term ${index + 1}`], sectionId: 'facts',
}));
const route = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'prices' };
const plan = (extra: Record<string, unknown> | undefined) => JSON.stringify({
  route: extra === undefined ? route : { ...route, ...extra }, outputContract, questions,
});

let eodhdFetches = 0;
const fetcher = async (url: string) => {
  eodhdFetches++;
  const path = new URL(url).pathname;
  if (path.includes('/real-time/')) return { ok: true, json: async () => ({ code: decodeURIComponent(path.split('/').pop()!), timestamp: 1_763_600_000, close: 70500 }) };
  return { ok: true, json: async () => [{ date: '2026-11-19', open: 70100, high: 71500, low: 70000, close: 70500, volume: 9876543 }] };
};
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const marketData = (key: string | undefined) => ({
  registry: marketDataRegistry(createEodhdDeclarations({ fetcher, lookupSecret: async () => key })), now: () => NOW,
});

let events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
let webCalls = 0;
beforeEach(() => {
  eodhdFetches = 0; webCalls = 0; events = [];
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    events.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log);
});
afterEach(() => { spyOn(debug, 'log').mockRestore(); });

const run = (planText: string, extra: Partial<ResearchQuestionLadderRunOptions> = {}) => runResearchQuestionLadder('삼성전자 지금 시세와 수급 어때?', {
  generatePreparation: async () => planText,
  invokeAxes: async (axes) => {
    webCalls++;
    return {
      plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map((host) => ({
        questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`,
        content: `web snippet says target price 99,999 for ${axis.id}`, outcome: 'complete' as const, truncated: false,
      })) })),
    };
  },
  enableResearchFanout: false, allowOutputSkill: false,
  routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }), ...extra,
});
const marketEvents = () => events.filter((entry) => entry.category === 'research.market-data');

test('topic market: market-data nodes are called, events recorded, numbers carry a market-data source, web is kept', async () => {
  const result = await run(plan({ topic: 'market', symbols: ['005930'] }), { marketData: marketData('injected-test-key') });
  expect(eodhdFetches).toBeGreaterThan(0);
  expect(marketEvents().map((entry) => entry.event)).toContain('complete');
  expect(marketEvents().every((entry) => typeof entry.data.provider === 'string' && typeof entry.data.contract === 'string'
    && typeof entry.data.durationMs === 'number')).toBe(true);
  const market = result.ladder.evidence.filter((item) => item.sourceKind.startsWith('market-data:'));
  expect(market.length).toBeGreaterThan(0);
  expect(market.map((item) => item.content).join('\n')).toContain('70500');
  expect(result.ladder.evidence.some((item) => item.sourceKind === 'web-search:test')).toBe(true);
  expect(webCalls).toBe(1);
  expect(result.output).toContain('## Market data (market-data capability)');
  expect(result.output).toContain('숫자는 market-data evidence 에서만 인용');
  const grounding = researchTurnForGrounding(result);
  expect(grounding.marketData?.evidenceTexts.join('\n')).toContain('70500');
  expect(JSON.stringify(events)).not.toContain('injected-test-key');
});

test('topic market without a key: skipped is recorded and the output says the source was not obtained', async () => {
  const result = await run(plan({ topic: 'market', symbols: ['005930'] }), { marketData: marketData(undefined) });
  expect(eodhdFetches).toBe(0);
  expect(marketEvents().map((entry) => entry.event)).toContain('skipped');
  expect(marketEvents().some((entry) => entry.data.reason === 'credential-missing')).toBe(true);
  expect(marketEvents().filter((entry) => entry.event === 'checked').length).toBe(2);
  expect(marketEvents().filter((entry) => entry.event === 'started').length).toBe(0);
  expect(result.output).toContain('시세·수급 출처를 확보하지 못함 — 숫자 추정 금지');
  expect(result.output).toContain('시세 공급자 2곳 검사 · 실제 호출 0곳 · 실패 이유: eodhd-kr-quote/credential-missing');
  expect(researchTurnForGrounding(result).marketData).toEqual({
    evidenceTexts: [], summary: expect.stringContaining('시세 공급자 2곳 검사 · 실제 호출 0곳 · 실패 이유:'),
  });
});

test('missing market key reaches the final core-turn answer as checked providers with zero actual calls', async () => {
  const research = await run(plan({ topic: 'market', symbols: ['005930'] }), { marketData: marketData(undefined) });
  let modelCalls = 0;
  const model = spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async () => {
    modelCalls++;
    return modelCalls === 1 ? '첫 답' : '웹 게시물은 70,500원을 제시한다. https://example.org/q1';
  });
  const tools: LLMToolSpec[] = ['Read', 'WebSearch', 'OmniSearch', 'WebFetch'].map((name) => ({
    name, description: name, parameters: { type: 'object', properties: {} },
  }));
  try {
    const request = '삼성전자 주가와 수급 변화를 조사해 비교해 줘';
    const result = await runCoreTurn({
      sessionId: 'market-no-key-final-summary', messages: [{ role: 'user', content: request }],
      tools, dispatchTool: async () => null, signal: new AbortController().signal, userText: request,
    }, { runResearch: async () => researchTurnForGrounding(research) });
    expect(modelCalls).toBe(2);
    expect(result.finalText).toContain('시세 공급자 2곳 검사 · 실제 호출 0곳 · 실패 이유:');
    expect(result.finalText).toContain('시세·수급 출처를 확보하지 못함');
    expect(result.finalText).toContain('미검증 숫자');
    expect(eodhdFetches).toBe(0);
  } finally { model.mockRestore(); }
});

test('collector exception is visible in the product answer and log; empty symbols are a separate no-attempt', async () => {
  const failed = await run(plan({ topic: 'market', symbols: ['005930'] }), {
    marketData: { registry: marketDataRegistry([]), now: () => { throw new Error('secret-looking collector error'); } },
  });
  expect(marketEvents().some((entry) => entry.event === 'failed' && entry.data.reason === 'collector-error')).toBe(true);
  expect(failed.output).toContain('시세 공급자 0곳 검사 · 실제 호출 0곳 · 실패 이유: none/collector-error');
  expect(JSON.stringify([failed.output, marketEvents()])).not.toContain('secret-looking');

  events = [];
  const noSymbols = await run(plan({ topic: 'market', symbols: [] }), {
    marketData: { registry: marketDataRegistry([]), now: () => NOW },
  });
  expect(marketEvents().some((entry) => entry.event === 'no-attempt' && entry.data.reason === 'no-symbols')).toBe(true);
  expect(noSymbols.output).toContain('시세 공급자 0곳 검사 · 실제 호출 0곳 · 실패 이유: no-symbols');
});

test('regression: no topic, general, or an unknown topic leaves the turn untouched (zero market-data calls and events)', async () => {
  for (const extra of [undefined, { topic: 'general' }, { topic: 'weather' }, { topic: 'general', symbols: ['005930'] }]) {
    eodhdFetches = 0; events = [];
    const result = await run(plan(extra), { marketData: marketData('injected-test-key') });
    expect(eodhdFetches).toBe(0);
    expect(marketEvents()).toEqual([]);
    expect(result.output).not.toContain('Market data (market-data capability)');
    expect(result.marketRequested).toBeUndefined();
    expect(result.ladder.evidence.every((item) => item.sourceKind === 'web-search:test')).toBe(true);
    expect(researchTurnForGrounding(result).marketData).toBeUndefined();
  }
});
