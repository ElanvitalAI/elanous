/** 1121 RESEARCH-ROUTING — research entry follows the question plan's structured route fields, never a sentence
 * classifier. Fixtures are shape paraphrases of the 1121 demo set (RES 20261117), not the measured question text. */
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';
import * as surfaces from '../session-runtime/index.js';
import * as deferred from '../session-runtime/tier-flip.js';
import { runResearchQuestionLadder, type ResearchQuestionLadderRunOptions } from '../auto-research/research-turn.js';
import { runCoreTurn, type RunCoreTurnOptions } from './run-core-turn.js';
import { routeResearchOutput } from '../research/output-router.js';
import { GROUNDING_UNAVAILABLE, needsGroundingFirst } from './grounding-first.js';
import { researchTurnForGrounding } from '../auto-research/research-turn.js';
import {
  decideResearchRoute, extractStreamedRouteFields, obviousLocalCommand, parseResearchRouteFields,
  RESEARCH_ROUTE_EVENTS, type ResearchRouteFields,
} from './research-route.js';

const webSearch: LLMToolSpec = { name: 'WebSearch', description: 'Search the web', parameters: { type: 'object', properties: {} } };
const read: LLMToolSpec = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } };
const evidence = { ok: true, output: 'Observed evidence from an official page.', sourceUrls: ['https://example.org/official'] };
const FACT: ResearchRouteFields = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public fact' };
const LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local file' };

/** 1121 demo shapes (Korean · a named resort/company · a time anchor · asks for dated official sources). */
const DEMO_1121_SHAPES = [
  '2026년 11월 기준 한 스키 리조트의 이번 겨울 개장 계획은 공식적으로 어떻게 발표됐나요? 날짜와 공식 URL을 인용해 주세요.',
  '지난 몇 주 동안 어느 스키 리조트가 공식적으로 알린 운영 변경 사항이 있나요? 공지 날짜와 출처 링크를 나눠 주세요.',
  '한 상장 리조트 기업의 가장 최근 공시에서 올해 실적에 관해 확인되는 내용은? 공시 날짜와 원문 URL을 알려 주세요.',
  '현재 산간 지역 기상 전망과 리조트의 제설·개장 공지를 함께 보면 개장 시점의 제약은? 자료별 날짜와 URL을 구분해 주세요.',
  '어느 리조트의 2026–27 시즌권 가격과 할인 조건은 공식 자료에서 어떻게 확인되나요? 미확인 조건은 분리하고 URL을 인용해 주세요.',
];
const KOREAN_VARIANTS = ['이번 주 서울 아파트 전세 시세는 어떻게 바뀌었어?', '그 배우 요즘 근황 좀 알려줘'];
const ENGLISH_VARIANTS = [
  'What did the ski resort announce about its 2026-27 season pass prices? Cite the official page.',
  'How have mortgage rates moved over the past two weeks?',
];
const FACT_QUESTIONS = [...DEMO_1121_SHAPES, ...KOREAN_VARIANTS, ...ENGLISH_VARIANTS];
const LOCAL_REQUESTS = [
  { kind: 'code edit', text: 'src/core-turn/research-route.ts 의 프리필터 정규식을 고쳐줘', prefilter: 'file-path-edit' },
  { kind: 'file read', text: 'README.md 파일을 읽고 요약해줘', prefilter: undefined },
  { kind: 'shell command', text: '!git status', prefilter: 'shell-line' },
] as const;

let events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
beforeEach(() => {
  events = [];
  spyOn(surfaces, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaces.resolveSessionSurfaceProfile>);
  spyOn(deferred, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools], stats: { activeCount: tools.length, deferredCount: 0,
      warmPreloaded: [], injected: false, deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
  } as unknown as ReturnType<typeof deferred.applyDeferredTools>));
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'research' || (category === 'research.turn'
      && (event === 'original-question-search-started' || event === 'external-search-gated'))) {
      events.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    }
  }) as typeof debug.log);
});
afterEach(() => mock.restore());

/** A fake plan provider: research reports the given structured route (or none) and returns evidence. */
function routedTurn(text: string, route: ResearchRouteFields | 'none', result = evidence) {
  let researchCalls = 0;
  const options: RunCoreTurnOptions = {
    runResearch: async (_request, _signal, _admit, _routing, hooks) => {
      researchCalls += 1;
      if (route !== 'none') hooks?.onRoute?.(route);
      return result;
    },
  };
  const run = runCoreTurn({
    sessionId: 'research-route-test', messages: [{ role: 'user', content: text }], userText: text,
    tools: [webSearch, read], dispatchTool: async () => null, signal: new AbortController().signal,
  }, options);
  return { run, researchCalls: () => researchCalls };
}
const routeEvents = () => events.filter(entry => entry.event === 'route').map(entry => entry.data);

test('fact questions (1121 shapes · Korean · English) enter research on the structured verdict: 9/9', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue(`근거 기반 답 ${evidence.sourceUrls[0]}`);
  let entered = 0;
  for (const text of FACT_QUESTIONS) {
    events = [];
    const turn = routedTurn(text, FACT);
    const result = await turn.run;
    expect(turn.researchCalls()).toBe(1);
    expect(routeEvents()).toEqual([expect.objectContaining({ route: 'entered', by: 'structured', reason: 'fresh-facts' })]);
    expect(result.finalText).toContain(evidence.sourceUrls[0]);
    entered += 1;
  }
  expect(entered).toBe(FACT_QUESTIONS.length);
});

test('local requests (code edit · file read · shell) never enter research: 0/3', async () => {
  let ordinaryCalls = 0;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages) => {
    ordinaryCalls += 1;
    expect(messages.some(message => typeof message.content === 'string' && message.content.includes(evidence.output))).toBe(false);
    return 'local answer';
  });
  for (const local of LOCAL_REQUESTS) {
    events = [];
    const turn = routedTurn(local.text, LOCAL);
    const result = await turn.run;
    expect(obviousLocalCommand(local.text)).toBe(local.prefilter);
    expect(result.finalText).toBe('local answer');
    expect(routeEvents()).toEqual([expect.objectContaining({
      route: 'skipped', by: local.prefilter ? 'prefilter' : 'structured', reason: local.prefilter ?? 'local-only',
    })]);
    // The pre-filter skips before research; a structured skip costs only the plan call it rode on.
    expect(turn.researchCalls()).toBe(local.prefilter ? 0 : 1);
  }
  expect(ordinaryCalls).toBe(LOCAL_REQUESTS.length);
});

test('a failed plan on a CONFIRMED (fast-path) entry still enters research — the safe side', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('unused');
  const turn = routedTurn(DEMO_1121_SHAPES[0]!, 'none', { ok: false, output: '', sourceUrls: [] });
  const result = await turn.run;
  expect(turn.researchCalls()).toBe(1);
  expect(routeEvents()).toEqual([expect.objectContaining({ route: 'entered', by: 'fallback', reason: 'plan-failed' })]);
  expect(result.finalText).toBe(GROUNDING_UNAVAILABLE);
});

test('the shadow heuristic disagreeing with the structured verdict emits research.route-mismatch (codes only)', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue(`답 ${evidence.sourceUrls[0]}`);
  // Cases 2·5 shape: the legacy sentence classifier would not enter; the structured verdict does.
  for (const text of [DEMO_1121_SHAPES[1]!, DEMO_1121_SHAPES[4]!]) {
    expect(needsGroundingFirst(text)).toBe(false);
    events = [];
    await routedTurn(text, FACT).run;
    const mismatch = events.filter(entry => entry.event === 'route-mismatch').map(entry => entry.data);
    expect(mismatch).toEqual([{ sessionId: 'research-route-test', structured: 'entered', heuristic: 'skipped', reason: 'fresh-facts' }]);
    for (const value of Object.values(mismatch[0]!)) expect(String(value)).not.toContain(text.slice(0, 8));
  }
  // Agreement emits nothing.
  events = [];
  await routedTurn(DEMO_1121_SHAPES[0]!, FACT).run;
  expect(events.filter(entry => entry.event === 'route-mismatch')).toEqual([]);
  expect(RESEARCH_ROUTE_EVENTS).toEqual(['route', 'route-mismatch']);
});

test('decision table: only an explicit localOnly=true skips; missing fields enter', () => {
  expect(decideResearchRoute(undefined)).toEqual({ decision: 'entered', by: 'fallback', reason: 'route-missing' });
  expect(decideResearchRoute(undefined, 'plan-failed')).toEqual({ decision: 'entered', by: 'fallback', reason: 'plan-failed' });
  expect(decideResearchRoute({ needsFreshFacts: true })).toEqual({ decision: 'entered', by: 'fallback', reason: 'local-only-missing' });
  expect(decideResearchRoute(LOCAL)).toEqual({ decision: 'skipped', by: 'structured', reason: 'local-only' });
  expect(decideResearchRoute({ localOnly: false, needsCitations: true })).toEqual({ decision: 'entered', by: 'structured', reason: 'citations' });
  expect(decideResearchRoute({ localOnly: false })).toEqual({ decision: 'entered', by: 'structured', reason: 'not-local' });
  expect(parseResearchRouteFields({ localOnly: 'true', needsFreshFacts: 1 })).toBeUndefined();
  expect(parseResearchRouteFields([])).toBeUndefined();
});

test('the route object is read off the plan stream as soon as it closes, braces inside strings included', () => {
  const head = '{"route":{"needsFreshFacts":false,"needsCitations":false,"localOnly":true,"reason":"a {b} \\"c\\""}';
  expect(extractStreamedRouteFields(head.slice(0, -3))).toBeUndefined();
  expect(extractStreamedRouteFields(`${head},"outputContract":{"sec`)).toEqual({
    needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'a {b} "c"',
  });
});

test('the pre-filter is only obvious local commands: fact questions, URLs and document paths are never pre-filtered', () => {
  expect(obviousLocalCommand('/help')).toBe('slash-command');
  expect(obviousLocalCommand('!ls -la')).toBe('shell-line');
  expect(obviousLocalCommand('fix the timeout in src/core-turn/run-core-turn.ts')).toBe('file-path-edit');
  for (const text of [
    ...FACT_QUESTIONS,
    'https://example.org/news/2026/item.json 내용을 수정해서 요약해줘',
    'docs/research-report.md 에 최신 금리 조사를 추가해줘',
    'src/core-turn/run-core-turn.ts 는 무슨 일을 해?',
    '/Users/me 아래에 뭐가 있지',
  ]) expect(obviousLocalCommand(text)).toBeUndefined();
});

test('the plan call reports its structured route from the stream, before the full plan parses', async () => {
  const seen: Array<ResearchRouteFields | undefined> = [];
  await runResearchQuestionLadder('README.md 파일을 읽고 요약해줘', {
    onRoute: fields => seen.push(fields),
    generatePreparation: async (_prompt, _signal, onChunk) => {
      onChunk?.('{"route":{"needsFreshFacts":false,"needsCitations":false,"localOnly":true,"reason":"file"},"outputContract":');
      return 'not json at all';
    },
  });
  expect(seen).toEqual([{ needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'file' }]);
});

test('a plan without a route field reports it missing; an unparseable plan reports nothing (caller enters)', async () => {
  const missing: Array<ResearchRouteFields | undefined> = [];
  await runResearchQuestionLadder('question', {
    onRoute: fields => missing.push(fields),
    generatePreparation: async () => JSON.stringify({ outputContract: {}, questions: [] }),
  });
  expect(missing).toEqual([undefined]);
  const broken: Array<ResearchRouteFields | undefined> = [];
  const result = await runResearchQuestionLadder('question', {
    onRoute: fields => broken.push(fields),
    generatePreparation: async () => 'not json',
  });
  expect(broken).toEqual([]);
  expect(result.ok).toBe(false);
});

// ── q0 privacy gate (review #38087 must-fix): the user's raw words reach an external search only after the route. ──
const ERROR_LOG_REQUEST = "이 에러 로그 보고 버그 고쳐줘: TypeError: Cannot read properties of undefined (reading 'id')\n    at handler (index:12)\nconfig: retries=3 region=ap-northeast-2 workspace=internal-billing";
type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise<void>((resolve) => setImmediate(resolve));
}
const q0Started = () => events.filter(entry => entry.event === 'original-question-search-started').map(entry => entry.data);
function countingAxes(): { invokeAxes: InvokeAxes; queries: string[][] } {
  const queries: string[][] = [];
  const invokeAxes: InvokeAxes = async (axes) => {
    queries.push(axes.flatMap(axis => axis.searchTerms));
    return { plan: [], axes: axes.map(axis => ({ questionId: axis.id, evidence: [] })) };
  };
  return { invokeAxes, queries };
}
const gatedOptions = (invokeAxes: InvokeAxes, extra: Partial<ResearchQuestionLadderRunOptions> = {}): ResearchQuestionLadderRunOptions => ({
  originalQuestionSearch: true, requireConfirmedRoute: true, onPartialGrounding: () => {},
  invokeAxes, enableResearchFanout: false, allowOutputSkill: false,
  routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }), ...extra,
});

test('q0 gate: a pasted error-log fix request sends nothing out when the route says localOnly', async () => {
  const { invokeAxes, queries } = countingAxes();
  await runResearchQuestionLadder(ERROR_LOG_REQUEST, gatedOptions(invokeAxes, {
    generatePreparation: async (_prompt, _signal, onChunk) => {
      onChunk?.(`{"route":${JSON.stringify(LOCAL)},"outputContract":`);
      return 'not json';
    },
  }));
  expect(q0Started()).toEqual([]);
  expect(queries).toEqual([]);
});

test('q0 gate: a pasted error-log fix request sends nothing out while the route has not arrived', async () => {
  const { invokeAxes, queries } = countingAxes();
  const parent = new AbortController();
  let planStarted = false;
  const pending = runResearchQuestionLadder(ERROR_LOG_REQUEST, gatedOptions(invokeAxes, {
    signal: parent.signal,
    generatePreparation: (_prompt, signal) => new Promise<string>((_resolve, reject) => {
      planStarted = true;
      signal!.addEventListener('abort', () => reject(new Error('plan aborted')), { once: true });
    }),
  }));
  await until(() => planStarted);
  expect(q0Started()).toEqual([]);
  parent.abort(new Error('turn left research'));
  await pending;
  expect(q0Started()).toEqual([]);
  expect(queries).toEqual([]);
});

test('q0 gate: an old-detector fact question (fast path) searches at once, before the route', async () => {
  const { invokeAxes, queries } = countingAxes();
  let seenBeforePlan: unknown[] = [];
  await runResearchQuestionLadder(DEMO_1121_SHAPES[0]!, gatedOptions(invokeAxes, {
    requireConfirmedRoute: false,
    generatePreparation: async () => { await until(() => queries.length > 0); seenBeforePlan = q0Started(); return 'not json'; },
  }));
  expect(seenBeforePlan).toEqual([expect.objectContaining({ gate: 'fast-path', beforePlan: true })]);
});

test('🔴 ROUTE-PRIVACY: a case 2/5 shape (not fast path) never sends its raw question, even once the route enters', async () => {
  for (const text of [DEMO_1121_SHAPES[1]!, DEMO_1121_SHAPES[4]!]) {
    events = [];
    const { invokeAxes, queries } = countingAxes();
    await runResearchQuestionLadder(text, gatedOptions(invokeAxes, {
      generatePreparation: async (_prompt, _signal, onChunk) => {
        onChunk?.(`{"route":${JSON.stringify(FACT)},"outputContract":`);
        return 'not json';
      },
    }));
    expect(q0Started()).toEqual([]);
    expect(queries).toEqual([]);
    expect(withheld()[0]).toMatchObject({ target: 'original-question', gate: 'withheld-raw-text' });
  }
});

const withheld = () => events.filter(entry => entry.event === 'external-search-gated').map(entry => entry.data);
const validPlan = (route?: ResearchRouteFields) => JSON.stringify({
  ...(route ? { route } : {}),
  outputContract: {
    deliverable: 'A sourced answer', format: 'Short memo',
    sections: [{ id: 'facts', title: 'Facts', purpose: 'State the supported facts.' }],
    completionCriteria: ['Every claim is supported or marked uncertain.'],
  },
  questions: Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`, level: index + 1, prompt: `Question ${index + 1}`, searchTerms: [`plan term ${index + 1}`], sectionId: 'facts',
  })),
});

test('unconfirmed entry × local request: a plan slower than any deadline sends nothing to the search provider', async () => {
  const { invokeAxes, queries } = countingAxes();
  await runResearchQuestionLadder(ERROR_LOG_REQUEST, gatedOptions(invokeAxes, {
    generatePreparation: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return 'not json'; },
  }));
  expect(queries).toEqual([]);
  expect(q0Started()).toEqual([]);
  expect(withheld()).toEqual([expect.objectContaining({ target: 'original-question', gate: 'withheld-unconfirmed', reason: 'plan-failed' })]);
});

test('unconfirmed entry × local request: a failed plan sends nothing to the search provider', async () => {
  for (const plan of ['not json', JSON.stringify({ outputContract: {}, questions: [] })]) {
    events = [];
    const { invokeAxes, queries } = countingAxes();
    await runResearchQuestionLadder(ERROR_LOG_REQUEST, gatedOptions(invokeAxes, { generatePreparation: async () => plan }));
    expect(queries).toEqual([]);
    expect(q0Started()).toEqual([]);
    expect(withheld()[0]).toMatchObject({ target: 'original-question', gate: 'withheld-unconfirmed' });
  }
});

test('unconfirmed entry: a valid plan without a route dispatches no axis search either', async () => {
  const { invokeAxes, queries } = countingAxes();
  const result = await runResearchQuestionLadder(ERROR_LOG_REQUEST, gatedOptions(invokeAxes, { generatePreparation: async () => validPlan() }));
  expect(queries).toEqual([]);
  expect(result.ok).toBe(false);
  expect(result.error).toContain('unconfirmed');
  expect(withheld().map(entry => entry.target)).toEqual(['original-question', 'axes']);
});

test('confirmed entry: a route that says entered sends the plan\'s research questions only — never the raw question', async () => {
  const { invokeAxes, queries } = countingAxes();
  await runResearchQuestionLadder(DEMO_1121_SHAPES[4]!, gatedOptions(invokeAxes, {
    generatePreparation: async (_prompt, _signal, onChunk) => {
      const plan = validPlan(FACT);
      onChunk?.(plan.slice(0, plan.indexOf('"outputContract"')));
      return plan;
    },
  }));
  expect(queries[0]).toEqual(['plan term 1', 'plan term 2', 'plan term 3', 'plan term 4', 'plan term 5', 'plan term 6']);
  expect(queries.flat()).not.toContain(DEMO_1121_SHAPES[4]!);
  expect(withheld()).toEqual([expect.objectContaining({ target: 'original-question', gate: 'withheld-raw-text' })]);
});

test('q0 gate wiring: core turn holds q0 for the route except on the old high-precision fact path', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('local answer');
  const held: Array<boolean | undefined> = [];
  for (const text of [ERROR_LOG_REQUEST, DEMO_1121_SHAPES[1]!, DEMO_1121_SHAPES[4]!, DEMO_1121_SHAPES[0]!]) {
    await runCoreTurn({
      sessionId: 'q0-gate-wiring', messages: [{ role: 'user', content: text }], userText: text,
      tools: [webSearch, read], dispatchTool: async () => null, signal: new AbortController().signal,
    }, { researchQuestionLadderRunner: async (_request, options) => {
      held.push(options.requireConfirmedRoute);
      options.onRoute?.(LOCAL);
      return { ok: false, output: '', sourceUrls: [] };
    } });
  }
  expect(needsGroundingFirst(DEMO_1121_SHAPES[0]!)).toBe(true);
  expect(held).toEqual([true, true, true, undefined]);
});

// ── OP after r3: on an UNCONFIRMED entry a missing route / plan failure / budget overrun is a fallback SKIP — the turn is
// main's ordinary turn again; only a CONFIRMED entry may end in GROUNDING_UNAVAILABLE. External search stays at 0. ──
function realLadderTurn(text: string, plan: ResearchQuestionLadderRunOptions['generatePreparation'], extra: RunCoreTurnOptions = {}) {
  const { invokeAxes, queries } = countingAxes();
  const run = runCoreTurn({
    sessionId: 'unconfirmed-skip', messages: [{ role: 'user', content: text }], userText: text,
    tools: [webSearch, read], dispatchTool: async () => null, signal: new AbortController().signal,
  }, {
    ...extra,
    researchQuestionLadderRunner: async (request, options) => researchTurnForGrounding(await runResearchQuestionLadder(request, {
      ...options, generatePreparation: plan, invokeAxes, enableResearchFanout: false, allowOutputSkill: false,
      routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
    })),
  });
  return { run, queries };
}

test('unconfirmed entry × plan failure: «README 요약해줘» and «안녕» get the ordinary answer, never GROUNDING_UNAVAILABLE', async () => {
  let ordinaryCalls = 0;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async () => { ordinaryCalls += 1; return 'ordinary answer'; });
  for (const text of ['README 요약해줘', '안녕']) {
    events = [];
    ordinaryCalls = 0;
    const turn = realLadderTurn(text, async () => 'not json');
    const result = await turn.run;
    expect(result.finalText).toBe('ordinary answer');
    expect(ordinaryCalls).toBe(1);
    expect(turn.queries).toEqual([]);
    expect(routeEvents()).toEqual([expect.objectContaining({ route: 'skipped', by: 'fallback', reason: 'plan-failed' })]);
  }
});

test('unconfirmed entry × local request: a missing route and a blown budget also re-enter as the ordinary turn', async () => {
  const cases: Array<{ reason: string; plan: ResearchQuestionLadderRunOptions['generatePreparation']; extra?: RunCoreTurnOptions }> = [
    { reason: 'route-missing', plan: async () => validPlan() },
    { reason: 'budget', extra: { researchWallClockBudgetMs: 20 },
      plan: (_prompt, signal) => new Promise<string>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('plan aborted')), { once: true });
      }) },
  ];
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('ordinary answer');
  for (const entry of cases) {
    events = [];
    const turn = realLadderTurn('README.md 파일을 읽고 요약해줘', entry.plan, entry.extra);
    const result = await turn.run;
    expect(result.finalText).toBe('ordinary answer');
    expect(turn.queries).toEqual([]);
    expect(routeEvents()).toEqual([expect.objectContaining({ route: 'skipped', by: 'fallback', reason: entry.reason })]);
  }
});

test('confirmed fact entry × no evidence still ends GROUNDING_UNAVAILABLE (structured route and fast path)', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('unused');
  for (const { text, plan } of [
    { text: DEMO_1121_SHAPES[4]!, plan: (async (_prompt, _signal, onChunk) => {
      onChunk?.(`{"route":${JSON.stringify(FACT)},"outputContract":`);
      return 'not json';
    }) as ResearchQuestionLadderRunOptions['generatePreparation'] },
    { text: DEMO_1121_SHAPES[0]!, plan: (async () => 'not json') as ResearchQuestionLadderRunOptions['generatePreparation'] },
  ]) {
    events = [];
    const turn = realLadderTurn(text, plan);
    const result = await turn.run;
    expect(result.finalText).toBe(GROUNDING_UNAVAILABLE);
    expect(routeEvents()[0]).toMatchObject({ route: 'entered' });
  }
});

// ── 🔴 1121 ROUTE-PRIVACY (RES OP82528 · main 1728371e): the plan judged a local TypeError explanation entered/not-local
// and the axes sent 9 Firecrawl calls. One gate; raw text never leaves; uncertain localOnly = 0 external calls. ──
const TYPE_ERROR_REQUEST = "이 TypeError 왜 나는지 설명해줘: TypeError: Cannot read properties of undefined (reading 'id')\n    at loadUser (src/user/load.ts:42:17)\n    at async handler (src/api/route.ts:9:3)";
const RAW_RUN = "TypeError: Cannot read properties of undefined (reading 'id')";
const NOT_LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: false, reason: 'explain error' };
/** A plan that echoes the pasted stack trace into its search terms (what a misjudging plan does). */
const echoingPlan = (route: ResearchRouteFields | Record<string, unknown> | undefined) => JSON.stringify({
  ...(route ? { route } : {}),
  outputContract: {
    deliverable: 'An explanation', format: 'Short memo',
    sections: [{ id: 'facts', title: 'Facts', purpose: 'Explain the error.' }],
    completionCriteria: ['Every claim is supported or marked uncertain.'],
  },
  questions: Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`, level: index + 1, sectionId: 'facts',
    prompt: index === 0 ? `Why does ${RAW_RUN} happen?` : `JavaScript undefined property access question ${index + 1}`,
    searchTerms: index === 0 ? [RAW_RUN, 'javascript undefined property access'] : [`undefined property access ${index + 1}`],
  })),
});
function spyWorld() {
  const { invokeAxes, queries } = countingAxes();
  const fanoutRequests: string[] = [];
  const researchFanoutWorker: NonNullable<ResearchQuestionLadderRunOptions['researchFanoutWorker']> = async (angle, request) => {
    fanoutRequests.push(request);
    return { angle, status: 'complete', text: '', sources: [] } as unknown as Awaited<ReturnType<NonNullable<ResearchQuestionLadderRunOptions['researchFanoutWorker']>>>;
  };
  return { invokeAxes, queries, fanoutRequests, researchFanoutWorker };
}
const leaksRaw = (sent: string[]) => sent.some(text => text.includes(RAW_RUN) || text.includes('src/user/load.ts'));

test('🔴 local TypeError explanation × plan misjudges entered/not-local → 0 external calls, ordinary answer', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('ordinary answer');
  const world = spyWorld();
  const result = await runCoreTurn({
    sessionId: 'route-privacy-typeerror', messages: [{ role: 'user', content: TYPE_ERROR_REQUEST }], userText: TYPE_ERROR_REQUEST,
    tools: [webSearch, read], dispatchTool: async () => null, signal: new AbortController().signal,
  }, {
    researchQuestionLadderRunner: async (request, options) => researchTurnForGrounding(await runResearchQuestionLadder(request, {
      ...options, generatePreparation: async () => echoingPlan(NOT_LOCAL), invokeAxes: world.invokeAxes,
      researchFanoutWorker: world.researchFanoutWorker, allowOutputSkill: false,
      routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
    })),
  });
  expect(world.queries).toEqual([]);
  expect(world.fanoutRequests).toEqual([]);
  expect(result.finalText).toBe('ordinary answer');
  expect(routeEvents()).toEqual([expect.objectContaining({ route: 'skipped', by: 'structured', reason: 'not-local' })]);
});

test('🔴 even a plan that wrongly says fresh-facts: axes and fanout get plan questions only, never raw user text', async () => {
  const world = spyWorld();
  await runResearchQuestionLadder(TYPE_ERROR_REQUEST, gatedOptions(world.invokeAxes, {
    generatePreparation: async () => echoingPlan(FACT),
    enableResearchFanout: true, researchFanoutWorker: world.researchFanoutWorker,
  }));
  const sent = [...world.queries.flat(), ...world.fanoutRequests];
  // q1's raw stack-trace term is dropped; its raw-free term and q2–q6 go out. Every fanout angle gets plan questions.
  expect(world.queries[0]).toEqual(['javascript undefined property access',
    ...[2, 3, 4, 5, 6].map(index => `undefined property access ${index}`)]);
  expect(new Set(world.fanoutRequests)).toEqual(new Set([[2, 3, 4, 5, 6]
    .map(index => `JavaScript undefined property access question ${index}`).join('\n')]));
  expect(leaksRaw(sent)).toBe(false);
  expect(world.queries.flat()).toContain('javascript undefined property access');
  expect(q0Started()).toEqual([]);
});

test('🔴 one gate: q0 withheld (local-only · not-local · uncertain localOnly) ⇒ axes and fanout withheld too', async () => {
  for (const route of [LOCAL, NOT_LOCAL, { needsFreshFacts: true, needsCitations: true }, { localOnly: 'false', needsFreshFacts: true }, undefined]) {
    events = [];
    const world = spyWorld();
    await runResearchQuestionLadder(TYPE_ERROR_REQUEST, gatedOptions(world.invokeAxes, {
      generatePreparation: async () => echoingPlan(route),
      enableResearchFanout: true, researchFanoutWorker: world.researchFanoutWorker,
    }));
    expect(world.queries).toEqual([]);
    expect(world.fanoutRequests).toEqual([]);
    expect(withheld().map(entry => entry.target)).toEqual(['original-question', 'axes']);
  }
});

test('positive: a fact question on the fast path still sends q0 at once, then plan terms', async () => {
  const world = spyWorld();
  await runResearchQuestionLadder(DEMO_1121_SHAPES[0]!, gatedOptions(world.invokeAxes, {
    requireConfirmedRoute: false, generatePreparation: async () => validPlan(FACT),
  }));
  expect(world.queries[0]).toEqual([DEMO_1121_SHAPES[0]!]);
  expect(world.queries.flat()).toContain('plan term 1');
});

// ── CROWN demo questions × the real structured route (TC 11-17). The two sentences are copied verbatim from the old
// detector test (grounding-first.test.ts:27), which until now was their only pin. Fake model · fake search only. ──
const TIMELY_DEMO_QUESTIONS = ['11~12월 미국·한국 주식 전망은 어때?', '젠슨황 스캔들 최근 소식은 뭐야?'] as const;
const SEARCH_DOWN = { ok: false, output: '', error: 'no search provider' };
/** A plan stream that closes only its `route` object, then fails to parse (no axes, no synthesis call). */
const routeOnlyPlan = (route: ResearchRouteFields): ResearchQuestionLadderRunOptions['generatePreparation'] =>
  async (_prompt, _signal, onChunk) => { onChunk?.(`{"route":${JSON.stringify(route)},"outputContract":`); return 'not json'; };
const duplicateRoutePlan = (first: ResearchRouteFields, last: ResearchRouteFields): string =>
  `${validPlan(first).slice(0, -1)},"route":${JSON.stringify(last)}}`;

test('CROWN demo questions enter research on the structured fresh-facts verdict and answer with the evidence URL', async () => {
  // The fake model answers from its INPUT: only a call that received the search evidence yields the grounded marker.
  const GROUNDED = 'answer-from-evidence';
  const sawEvidence: boolean[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages) => {
    const seen = messages.some(message => typeof message.content === 'string' && message.content.includes(evidence.output));
    sawEvidence.push(seen);
    return seen ? GROUNDED : 'answer-without-evidence';
  });
  for (const text of TIMELY_DEMO_QUESTIONS) {
    events = [];
    const turn = routedTurn(text, FACT);
    const result = await turn.run;
    expect(turn.researchCalls()).toBe(1);
    expect(routeEvents()).toEqual([expect.objectContaining({ route: 'entered', by: 'structured', reason: 'fresh-facts' })]);
    expect(result.finalText).toContain(GROUNDED);
    expect(result.finalText).toContain(evidence.sourceUrls[0]);
  }
  expect(sawEvidence).toEqual(TIMELY_DEMO_QUESTIONS.map(() => true));
});

test('CROWN demo questions take the fast path: q0 (the question itself) is searched before the plan resolves', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('unused');
  for (const text of TIMELY_DEMO_QUESTIONS) {
    events = [];
    expect(needsGroundingFirst(text)).toBe(true);
    let seenBeforePlan: unknown[] = [];
    let held: boolean | undefined = false;
    const { invokeAxes, queries } = countingAxes();
    await runCoreTurn({
      sessionId: 'demo-fast-path', messages: [{ role: 'user', content: text }], userText: text,
      tools: [webSearch, read], dispatchTool: async () => null, signal: new AbortController().signal,
    }, { researchQuestionLadderRunner: async (request, options) => {
      held = options.requireConfirmedRoute;
      return researchTurnForGrounding(await runResearchQuestionLadder(request, {
        ...options, invokeAxes, enableResearchFanout: false, allowOutputSkill: false,
        routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
        generatePreparation: async (_prompt, _signal, onChunk) => {
          onChunk?.(`{"route":${JSON.stringify(FACT)},"outputContract":`);
          await until(() => queries.length > 0);
          seenBeforePlan = q0Started();
          return 'not json';
        },
      }));
    } });
    expect(held).toBeUndefined();
    expect(seenBeforePlan).toEqual([expect.objectContaining({ gate: 'fast-path', beforePlan: true })]);
    expect(queries).toEqual([[text]]);
    expect(routeEvents()).toEqual([expect.objectContaining({ route: 'entered', by: 'structured', reason: 'fresh-facts' })]);
  }
});

test('CROWN demo questions × search down: GROUNDING_UNAVAILABLE and the model is never called', async () => {
  let modelCalls = 0;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async () => { modelCalls += 1; return 'unused'; });
  for (const text of TIMELY_DEMO_QUESTIONS) {
    events = [];
    const turn = routedTurn(text, FACT, SEARCH_DOWN as unknown as typeof evidence);
    const result = await turn.run;
    expect(turn.researchCalls()).toBe(1);
    expect(result.finalText).toBe(GROUNDING_UNAVAILABLE);
  }
  expect(modelCalls).toBe(0);
});

test('CROWN demo questions × localOnly route: skipped/structured/local-only, ordinary answer', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('ordinary answer');
  for (const text of TIMELY_DEMO_QUESTIONS) {
    events = [];
    const result = await realLadderTurn(text, routeOnlyPlan(LOCAL)).run;
    expect(result.finalText).toBe('ordinary answer');
    expect(routeEvents()).toEqual([expect.objectContaining({ route: 'skipped', by: 'structured', reason: 'local-only' })]);
  }
});

// TODO(TC 11-17 · not fixed here): on the CORE TURN these two sentences take the fast path (old detector · requireConfirmedRoute
// unset), so q0 sends the raw question before any route arrives, and a duplicate route is read from the stream's FIRST
// `route` (entered) with routeConfirmed never re-gated. Both todos run on fake model · fake plan · fake search only, so
// `bun test --todo` makes zero real calls.
test.todo('CROWN demo questions × localOnly route on the core turn (fast path): 0 external search calls', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('ordinary answer');
  for (const text of TIMELY_DEMO_QUESTIONS) {
    events = [];
    const turn = realLadderTurn(text, routeOnlyPlan(LOCAL));
    await turn.run;
    expect(turn.queries).toEqual([]);
  }
});

test.todo('CROWN demo questions × duplicate route on the core turn (fast path): nothing confirmed, 0 external calls', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('ordinary answer');
  for (const text of TIMELY_DEMO_QUESTIONS) {
    events = [];
    const plan = duplicateRoutePlan(FACT, LOCAL);
    const turn = realLadderTurn(text, async (_prompt, _signal, onChunk) => { onChunk?.(plan); return plan; });
    await turn.run;
    expect(turn.queries).toEqual([]);
    expect(routeEvents()).not.toContainEqual(expect.objectContaining({ route: 'entered', by: 'structured' }));
  }
});
