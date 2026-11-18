// SEARCH-PROVIDER-TOPIC-BENCH-ROUTING ① — availability probe ⊕ topic routing seam. Fake providers only: no live search,
// no credential values (fakes answer presence with a boolean), WebFetch replaced by a fake page fetcher.
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { BloomResearchQuestion } from '../auto-research/question-ladder-contract.js';
import { runResearchQuestionLadder, type ResearchQuestionLadderRunOptions } from '../auto-research/research-turn.js';
import type { ResearchRouteFields } from '../core-turn/research-route.js';
import { invokeResearchAxes } from '../research-bridge/invoke.js';
import { createResearchAxisSearcher, fanOutAxisEvidence } from '../research/axis-fanout.js';
import { routeResearchOutput } from '../research/output-router.js';
import { parseWebSearchConfig, searchProviderRoutingMode } from '../user-config.js';
import {
  _resetWebSearchProvidersForTests, addWebSearchProvider, getAvailableResearchWebSearchProvidersAsync,
  probeResearchWebSearchProvidersAsync,
} from './index.js';
import type { WebSearchProvider } from './provider.js';
import {
  runSearchWithDeadline, SEARCH_DEADLINE_CODE, SearchDeadlineError,
} from '../graph-runner/capability-providers/search-web-deadline.js';
import {
  SEARCH_PROVIDER_ROUTES, SEARCH_PROVIDER_SELECTED_EVENT, SEARCH_ROUTE_EXHAUSTED, SEARCH_ROUTING_CATEGORY,
  probeSearchProviderAvailability, probeSearchProviderReadiness, selectSearchProvider, type SearchRoutingMode,
} from './routing.js';

type Ready = boolean | 'throw' | 'hang';
interface Fake { provider: WebSearchProvider; calls: string[]; checks: string[] }

function fake(id: string, ready: Ready = true, fail?: string): Fake {
  const calls: string[] = [];
  const checks: string[] = [];
  const provider: WebSearchProvider = {
    id,
    displayName: `fake ${id}`,
    available: () => ready === true,
    availableAsync: async () => {
      checks.push(id);
      if (ready === 'throw') throw new Error('typed store read failed');
      if (ready === 'hang') return new Promise<boolean>(() => {});
      return ready === true;
    },
    async search(query) {
      calls.push(query.query);
      if (fail) throw new Error(fail);
      return {
        providerName: id, durationMs: 1,
        hits: [{ url: `https://${id}.example/${calls.length}`, title: `${id} hit`, snippet: 'dated fact' }],
      };
    },
  };
  return { provider, calls, checks };
}

let events: Array<{ category: string; event: string; data: Record<string, unknown>; level?: string }> = [];
beforeEach(() => {
  events = [];
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown, opts?: { level?: string }) => {
    events.push({ category, event, data: (data ?? {}) as Record<string, unknown>, ...(opts?.level ? { level: opts.level } : {}) });
  }) as typeof debug.log);
});
afterEach(() => {
  mock.restore();
  _resetWebSearchProvidersForTests();
});

const selected = () => events.filter(entry => entry.category === SEARCH_ROUTING_CATEGORY && entry.event === SEARCH_PROVIDER_SELECTED_EVENT);
const questions: BloomResearchQuestion[] = [
  { id: 'q1', level: 1, prompt: 'Question 1', searchTerms: ['plan term 1'] },
  { id: 'q2', level: 2, prompt: 'Question 2', searchTerms: ['plan term 2'] },
];
const fakeFetch = async (url: string) => ({ url, output: 'fake page body' });

function register(...fakes: Fake[]): void {
  _resetWebSearchProvidersForTests(false);
  for (const entry of fakes) addWebSearchProvider(entry.provider);
}

// ── availability probe ──────────────────────────────────────────────────────

test('probe: missing credential → unavailable with reason; present → available; never a key value', async () => {
  const present = fake('firecrawl', true);
  const missing = fake('tavily', false);
  const result = await probeSearchProviderAvailability(['firecrawl', 'tavily'], {
    registered: [present.provider, missing.provider],
  });
  expect(result).toEqual([
    { provider: 'firecrawl', available: true },
    { provider: 'tavily', available: false, reason: 'credential-missing' },
  ]);
});

test('probe: store read throw / hang / config gate / no adapter each get their own fixed reason', async () => {
  const thrower = fake('firecrawl', 'throw');
  const hanger = fake('exa', 'hang');
  const result = await probeSearchProviderAvailability(['firecrawl', 'exa', 'tavily', 'brave'], {
    registered: [thrower.provider, hanger.provider],
    isEnabled: id => (id === 'tavily' ? false : undefined),
    // 출처: R-TST36 · src/graph-runner/capability-providers/search-web-deadline.ts — smallest valid budget so the hang classifies as timeout.
    timeoutMs: 1,
  });
  expect(result).toEqual([
    { provider: 'firecrawl', available: false, reason: 'credential-check-failed' },
    { provider: 'exa', available: false, reason: 'credential-check-timeout' },
    { provider: 'tavily', available: false, reason: 'disabled' },
    { provider: 'brave', available: false, reason: 'no-adapter' },
  ]);
  expect(JSON.stringify(result)).not.toContain('typed store read failed');
});

test('probe: deadline is classified by the structured code from the original source, not by message text', async () => {
  // A real rejection from the original helper carries the code.
  // 출처: R-TST36 · search-web-deadline.ts — smallest valid budget, the work never settles.
  const real = await runSearchWithDeadline(() => new Promise<never>(() => {}), undefined, 1).catch((error: unknown) => error);
  expect(real).toBeInstanceOf(SearchDeadlineError);
  expect((real as SearchDeadlineError).code).toBe(SEARCH_DEADLINE_CODE);
  const throwing = (error: Error): WebSearchProvider => ({
    ...fake('firecrawl').provider, availableAsync: async () => { throw error; },
  });
  // Message changed, code kept → still a deadline.
  const recoded = Object.assign(new Error('a completely different wording'), { code: SEARCH_DEADLINE_CODE });
  expect((await probeSearchProviderReadiness(throwing(recoded))).reason).toBe('credential-check-timeout');
  // Same old wording, no code → not a deadline: the message never drives the classification.
  const lookalike = new Error((real as Error).message);
  expect((await probeSearchProviderReadiness(throwing(lookalike))).reason).toBe('credential-check-failed');
});

test('probe: a cancelled turn is `credential-check-cancelled`, not a store timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await probeSearchProviderReadiness(fake('firecrawl', 'hang').provider, controller.signal)).toEqual({
    provider: 'firecrawl', available: false, reason: 'credential-check-cancelled',
  });
});

test('registry probe keeps the old ready-snapshot contract and reports every routed id', async () => {
  const firecrawl = fake('firecrawl', false);
  const exa = fake('exa', true);
  const ddg = fake('ddg-free', true);
  register(firecrawl, exa, ddg);
  const probe = await probeResearchWebSearchProvidersAsync();
  const legacy = await getAvailableResearchWebSearchProvidersAsync();
  expect(probe.providers.map(provider => provider.id)).toEqual(legacy.map(provider => provider.id));
  expect(probe.providers.map(provider => provider.id)).toEqual(['exa', 'ddg-free']);
  const routedIds = [...new Set(Object.values(SEARCH_PROVIDER_ROUTES).flat())];
  for (const id of routedIds) expect(probe.availability.map(entry => entry.provider)).toContain(id);
  expect(probe.availability.find(entry => entry.provider === 'firecrawl')).toEqual({
    provider: 'firecrawl', available: false, reason: 'credential-missing',
  });
  expect(probe.availability.find(entry => entry.provider === 'brave')).toEqual({
    provider: 'brave', available: false, reason: 'no-adapter',
  });
});

// ── routing table / selection ───────────────────────────────────────────────

test('selection follows the topic list order, not registration order', () => {
  const all = ['firecrawl', 'firecrawl-dev', 'tavily', 'exa', 'brave', 'ddg-free'].map(provider => ({ provider, available: true }));
  expect(selectSearchProvider('default', all).chosen).toBe('firecrawl');
  expect(selectSearchProvider('web-news', all).chosen).toBe('tavily');
  expect(selectSearchProvider('dev-docs', all).chosen).toBe('firecrawl-dev');
  expect(selectSearchProvider('semantic', all).chosen).toBe('exa');
  expect(selectSearchProvider('default', all).fallbacks).toEqual([...SEARCH_PROVIDER_ROUTES.default.slice(1)]);
});

test('unavailable providers are skipped with reasons and the event carries them (no query text)', () => {
  const search = createResearchAxisSearcher([fake('exa').provider, fake('ddg-free').provider], Date.now, undefined, {
    mode: 'on',
    availability: [{ provider: 'firecrawl', available: false, reason: 'credential-missing' }],
  });
  expect(typeof search).toBe('function');
  expect(selected().map(entry => entry.data)).toEqual([{
    topic: 'default', mode: 'on', chosen: 'exa', legacy: 'exa', divergent: false, fallbacks: ['ddg-free'],
    skipped: [
      { provider: 'firecrawl', reason: 'credential-missing' },
      { provider: 'tavily', reason: 'not-ready' },
      { provider: 'brave', reason: 'not-ready' },
    ],
  }]);
});

test('all routed providers unavailable → loud SEARCH_ROUTE_EXHAUSTED through the search tool entry, warn event, zero calls', async () => {
  const firecrawl = fake('firecrawl', false);
  register(firecrawl);
  const result = await fanOutAxisEvidence(questions, { searchRoutingMode: 'on', fetchPage: fakeFetch });
  expect(firecrawl.calls).toEqual([]);
  for (const axis of result.axes) {
    expect(axis.error?.startsWith(SEARCH_ROUTE_EXHAUSTED)).toBe(true);
    expect(axis.evidence.map(envelope => envelope.outcome)).toEqual(['failed']);
  }
  expect(selected().map(entry => [entry.data.chosen, entry.level])).toEqual([[null, 'warn']]);
});

// ── shadow vs on ────────────────────────────────────────────────────────────

/** Legacy order for [exa, tavily, ddg-free] is exa → tavily → ddg; the default route is tavily → exa → ddg. */
async function runThroughEntry(mode: SearchRoutingMode, exaFail?: string) {
  const exa = fake('exa', true, exaFail);
  const tavily = fake('tavily');
  const ddg = fake('ddg-free');
  register(exa, tavily, ddg);
  const result = await invokeResearchAxes([questions[0]!], { searchRoutingMode: mode, fetchPage: fakeFetch });
  return { result, exa, tavily, ddg };
}

test('shadow: routed choice is computed and recorded, but the call still goes to the legacy provider', async () => {
  const { exa, tavily, ddg } = await runThroughEntry('shadow');
  expect(exa.calls).toEqual(['plan term 1']);
  expect(tavily.calls).toEqual([]);
  expect(ddg.calls).toEqual([]);
  expect(selected().map(entry => entry.data)).toEqual([expect.objectContaining({
    mode: 'shadow', chosen: 'tavily', legacy: 'exa', divergent: true,
  })]);
});

test('shadow: zero behaviour change — same provider cascade and same returned fields as the legacy order', async () => {
  const { result, exa, tavily, ddg } = await runThroughEntry('shadow', 'exa 503');
  // Legacy cascade: exa fails → tavily serves; ddg never called.
  expect([exa.calls.length, tavily.calls.length, ddg.calls.length]).toEqual([1, 1, 0]);
  expect(result.axes[0]!.evidence.map(envelope => [envelope.sourceKind, envelope.source, envelope.outcome])).toEqual([
    ['web-fetch', 'https://tavily.example/1', 'complete'],
    ['web-search:tavily', 'https://tavily.example/1', 'complete'],
    ['search-query', 'plan term 1', 'failed'],
  ]);
  expect(result.axes[0]!.error).toBe('exa: exa 503');
});

test('on: the call goes to the routed provider', async () => {
  const { exa, tavily } = await runThroughEntry('on');
  expect(tavily.calls).toEqual(['plan term 1']);
  expect(exa.calls).toEqual([]);
  expect(selected().map(entry => entry.data.chosen)).toEqual(['tavily']);
});

test('absent / unknown config → shadow; only an explicit `on` turns routing on', () => {
  for (const mode of ['ON', true, 'live', 1]) {
    const parsed = parseWebSearchConfig({ routing: { mode } });
    expect(parsed?.routing).toBeUndefined();
    expect(searchProviderRoutingMode({ webSearch: parsed })).toBe('shadow');
  }
  expect(parseWebSearchConfig({ routing: { mode: 'on' } })?.routing).toEqual({ mode: 'on' });
  expect(searchProviderRoutingMode({})).toBe('shadow');
  expect(searchProviderRoutingMode({ webSearch: { routing: {} } })).toBe('shadow');
  expect(searchProviderRoutingMode({ webSearch: { routing: { mode: 'on' } } })).toBe('on');
});

// ── symmetry: first call, retry and fallback share one gate ───────────────

test('on: a provider unavailable at probe time is never reached on fallback; breaker skip emits an event', async () => {
  const firecrawl = fake('firecrawl', false);
  const tavily = fake('tavily', true, 'quota exceeded 429');
  const ddg = fake('ddg-free');
  register(firecrawl, tavily, ddg);
  await invokeResearchAxes(questions, { searchRoutingMode: 'on', fetchPage: fakeFetch });
  expect(firecrawl.calls).toEqual([]);
  // Quota opens tavily's breaker on its first failure; every later axis skips it with a recorded reason.
  expect(tavily.calls).toEqual(['plan term 1']);
  expect(ddg.calls.sort()).toEqual(['plan term 1', 'plan term 2']);
  expect(events.filter(entry => entry.category === 'research.search' && entry.event === 'provider-skipped')
    .map(entry => entry.data)).toContainEqual({ provider: 'tavily', reason: 'breaker-open' });
});

// ── outermost user path: the research turn's search call ──────────────────

const outputContract = {
  deliverable: 'A sourced answer', format: 'Short memo',
  sections: [{ id: 'facts', title: 'Facts', purpose: 'State the supported facts.' }],
  completionCriteria: ['Every claim is supported or marked uncertain.'],
};
const planQuestions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`, level: (index + 1) as BloomResearchQuestion['level'], prompt: `Question ${index + 1}`,
  searchTerms: [`plan term ${index + 1}`], sectionId: 'facts',
}));
const FACT: ResearchRouteFields = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public fact' };
const LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local file' };

function researchTurn(route: ResearchRouteFields, mode: SearchRoutingMode): ResearchQuestionLadderRunOptions {
  return {
    requireConfirmedRoute: true,
    enableResearchFanout: false,
    allowOutputSkill: false,
    generatePreparation: async () => JSON.stringify({ route, outputContract, questions: planQuestions }),
    routeOutput: input => routeResearchOutput({ ...input, skills: [] }),
    gapFollowup: async () => ({ rounds: 0, timeBudgetMs: 0, classifications: [], followups: [], followupEvidence: [] }),
    // Production invoker shape (invokeProductionResearchAxes) with only the routing mode and page fetch injected.
    invokeAxes: (axes, signal, admitToolCall, onAxisEvidence) => invokeResearchAxes(axes, {
      ...(signal ? { signal } : {}), ...(admitToolCall ? { admitToolCall } : {}),
      ...(onAxisEvidence ? { onAxisEvidence } : {}), fetchPage: fakeFetch, searchRoutingMode: mode,
    }),
  };
}

test('research turn (on): plan questions are searched on the routed provider', async () => {
  const exa = fake('exa');
  const tavily = fake('tavily');
  register(exa, tavily);
  await runResearchQuestionLadder('공식 자료로 이번 주 발표된 가격을 확인해 주세요.', researchTurn(FACT, 'on'));
  expect(tavily.calls).toContain('plan term 1');
  expect(exa.calls).toEqual([]);
  expect(selected().map(entry => [entry.data.mode, entry.data.chosen])).toContainEqual(['on', 'tavily']);
  for (const entry of selected()) expect(entry.data).toMatchObject({ mode: 'on', chosen: 'tavily' });
});

test('research turn (shadow): plan questions still go to the legacy provider', async () => {
  const exa = fake('exa');
  const tavily = fake('tavily');
  register(exa, tavily);
  await runResearchQuestionLadder('공식 자료로 이번 주 발표된 가격을 확인해 주세요.', researchTurn(FACT, 'shadow'));
  expect(exa.calls).toContain('plan term 1');
  expect(tavily.calls).toEqual([]);
});

test('research turn localOnly (#38112 · #38166): no probe, no selection, no external call — in either mode', async () => {
  for (const mode of ['shadow', 'on'] as const) {
    events = [];
    const exa = fake('exa');
    const tavily = fake('tavily');
    register(exa, tavily);
    await runResearchQuestionLadder('이 저장소의 로컬 파일을 정리해 주세요.', researchTurn(LOCAL, mode));
    expect([...exa.calls, ...tavily.calls]).toEqual([]);
    expect([...exa.checks, ...tavily.checks]).toEqual([]);
    expect(selected()).toEqual([]);
  }
});
