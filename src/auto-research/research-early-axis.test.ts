// GROUNDING-FIRST-ANSWER-30S (RES 82685 case 5) — on a confirmation-gated turn (case 2/5 shapes: q0 never runs, #38112)
// the first citable evidence waited for the WHOLE question plan. The plan's first research question is searched off the
// stream — but (review r2 · duplicate keys) only once the plan ROOT has closed in the stream, so no later `route` key can
// overturn the verdict, with exactly one `route` and one `questions`. Privacy invariants of #38112 hold: no external
// search before a final confirmed route, plan-generated terms only, no verbatim run of the user's text.
// Fake plan stream · fake search · logical clock (the fakes set it) — no wall clock, no provider.
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { closedStreamedPlanRoot, extractStreamedRouteFields, topLevelKeys, type ResearchRouteFields } from '../core-turn/research-route.js';
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from './question-ladder-contract.js';
import { routeResearchOutput } from '../research/output-router.js';
import {
  normalizeResearchQuery, runResearchQuestionLadder, type ResearchGroundingResult, type ResearchQuestionLadderRunOptions,
} from './research-turn.js';

type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;
type GeneratePreparation = NonNullable<ResearchQuestionLadderRunOptions['generatePreparation']>;

/** A case 2/5 shape paraphrase (not the measured prompt): Korean, a named resort, asks for official dated sources. */
const request = '어느 리조트의 2026–27 시즌권 가격과 할인 조건은 공식 자료에서 어떻게 확인되나요? 미확인 조건은 분리하고 URL을 인용해 주세요.';
const FACT: ResearchRouteFields = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public fact' };
const LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local file' };
const NOT_LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: false, reason: 'general' };
const outputContract = {
  deliverable: 'A sourced answer', format: 'Short memo',
  sections: [{ id: 'facts', title: 'Facts', purpose: 'State the supported facts.' }],
  completionCriteria: ['Every claim is supported or marked uncertain.'],
};
const questions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`, level: (index + 1) as BloomResearchQuestion['level'], prompt: `Question ${index + 1}`,
  searchTerms: [`plan term ${index + 1}`], sectionId: 'facts',
}));
const planJson = (route: ResearchRouteFields | undefined, planQuestions = questions): string => JSON.stringify({
  ...(route ? { route } : {}), outputContract, questions: planQuestions,
});
/** The streamed prefix that ends right after the first question object closes. */
const throughFirstQuestion = (plan: string): string => plan.slice(0, plan.indexOf(',{"id":"q2"'));
const throughRoute = (plan: string): string => plan.slice(0, plan.indexOf('"outputContract"'));
const urlOf = (questionId: string): string => `https://example.org/${questionId}`;
const envelope = (questionId: string, source = urlOf(questionId)): ResearchEvidenceEnvelope => ({
  questionId, sourceKind: 'web-search:test', source, observedAt: '2026-11-17T00:00:00.000Z',
  content: `Evidence for ${questionId}`, outcome: 'complete', truncated: true,
});

// Logical clock milestones (ms from turn start). Only their ORDER is asserted:
// route streamed < first question streamed < plan root closed in the stream < plan call returns.
const ROUTE_STREAMED_AT = 1_000;
const FIRST_QUESTION_STREAMED_AT = 4_000;
const ROOT_CLOSED_AT = 19_000;
const PLAN_END_AT = 20_000;
let clock = 0;

let events: Array<{ event: string; data: Record<string, unknown> }> = [];
beforeEach(() => {
  clock = 0;
  events = [];
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'research.turn') events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log);
});
afterEach(() => mock.restore());

async function flush(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round++) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise<void>((resolve) => setImmediate(resolve));
}

type SearchCall = { terms: string[]; at: number; signal?: AbortSignal };
function fakeSearch(byQuestion: (questionId: string) => ResearchEvidenceEnvelope[] = (id) => [envelope(id)]) {
  const calls: SearchCall[] = [];
  // Each question finds its evidence once: later gap follow-ups for the same question add nothing.
  const answered = new Set<string>();
  const invokeAxes: InvokeAxes = async (axes, signal, _admit, onAxisEvidence) => {
    calls.push({ terms: axes.flatMap((axis) => axis.searchTerms), at: clock, ...(signal ? { signal } : {}) });
    const groups = axes.map((axis) => {
      const evidence = answered.has(axis.id) ? [] : byQuestion(axis.id);
      answered.add(axis.id);
      return { questionId: axis.id, evidence };
    });
    for (const group of groups) onAxisEvidence?.(group.questionId, group.evidence);
    return {
      plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
      axes: groups,
    };
  };
  return { invokeAxes, calls };
}

/** Fake plan stream: each step sets the logical clock, streams a prefix, then lets the run react before the next step. */
function streamedPlan(steps: Array<{ at: number; text: string }>, final: string, finalAt = PLAN_END_AT): GeneratePreparation {
  return async (_prompt, _signal, onChunk) => {
    for (const step of steps) {
      clock = step.at;
      onChunk?.(step.text);
      await flush();
    }
    clock = finalAt;
    return final;
  };
}

const gated = (invokeAxes: InvokeAxes, generatePreparation: GeneratePreparation,
  extra: Partial<ResearchQuestionLadderRunOptions> = {}): ResearchQuestionLadderRunOptions => ({
  originalQuestionSearch: true, requireConfirmedRoute: true, onPartialGrounding: () => {},
  invokeAxes, generatePreparation, enableResearchFanout: false, allowOutputSkill: false,
  routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }), ...extra,
});
const sentTerms = (calls: SearchCall[]): string[] => calls.flatMap((call) => call.terms);
const withheld = () => events.filter((entry) => entry.event === 'external-search-gated').map((entry) => entry.data);
const earlyStarted = () => events.filter((entry) => entry.event === 'early-axis-search-started').map((entry) => entry.data);

/** Stream steps of a plan: route, first question, then the whole root (closed) before the plan call returns. */
const fullStream = (plan: string): Array<{ at: number; text: string }> => [
  { at: ROUTE_STREAMED_AT, text: throughRoute(plan) },
  { at: FIRST_QUESTION_STREAMED_AT, text: throughFirstQuestion(plan) },
  { at: ROOT_CLOSED_AT, text: plan },
];

test('closed plan root: undefined while open; keys in order with duplicates; nested keys never count', () => {
  const plan = planJson(FACT, [{ ...questions[0]!, prompt: 'a {brace} "quoted" }' }, ...questions.slice(1)]);
  expect(closedStreamedPlanRoot(throughFirstQuestion(plan))).toBeUndefined();
  expect(closedStreamedPlanRoot(plan.slice(0, -1))).toBeUndefined();
  expect(closedStreamedPlanRoot(plan)?.keys).toEqual(['route', 'outputContract', 'questions']);
  const duplicate = `${plan.slice(0, -1)},"route":${JSON.stringify(LOCAL)}}`;
  expect(topLevelKeys(duplicate)).toEqual(['route', 'outputContract', 'questions', 'route']);
  const nested = JSON.stringify({ outputContract: { ...outputContract, route: FACT, questions: [questions[1]] } });
  expect(topLevelKeys(nested)).toEqual(['outputContract']);
  expect(extractStreamedRouteFields(nested)).toBeUndefined();
});

test('🎯 head start: the first question is searched when the plan root closes in the stream, not when the call returns', async () => {
  const plan = planJson(FACT);
  const run = async (steps: Array<{ at: number; text: string }>) => {
    const { invokeAxes, calls } = fakeSearch();
    await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(steps, plan)));
    return calls;
  };
  // Root never seen closed in the stream → first search when the plan call returns.
  const before = await run(fullStream(plan).slice(0, 2));
  expect(before[0]!.at).toBe(PLAN_END_AT);
  events = [];
  const after = await run(fullStream(plan));
  // Route and first question alone never dispatch (a later duplicate `route` could still arrive).
  expect(after.some((call) => call.at < ROOT_CLOSED_AT)).toBe(false);
  expect(after[0]).toEqual(expect.objectContaining({ at: ROOT_CLOSED_AT, terms: questions[0]!.searchTerms }));
  expect(earlyStarted()).toEqual([expect.objectContaining({ beforePlan: true, termCount: questions[0]!.searchTerms.length })]);
  const all = sentTerms(after.slice(0, 2)).map(normalizeResearchQuery);
  expect(new Set(all).size).toBe(all.length);
  expect(after[1]!.terms).toEqual(questions.slice(1).flatMap((question) => question.searchTerms));
});

test('🎯 the head-start evidence reaches the early-answer seam before the plan call returns, cited once per question', async () => {
  const plan = planJson(FACT);
  const partials: Array<{ partial: ResearchGroundingResult; at: number }> = [];
  // q2's axis independently finds q1's URL: per-question attribution keeps it on BOTH q1 and q2, once each.
  const { invokeAxes } = fakeSearch((id) => id === 'q1' ? [envelope(id), envelope(id, urlOf('q1-extra'))]
    : id === 'q2' ? [envelope(id, urlOf('q1')), envelope(id)] : [envelope(id)]);
  const result = await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan),
    { onPartialGrounding: (partial) => partials.push({ partial, at: clock }) }));
  expect(partials[0]!.at).toBe(ROOT_CLOSED_AT);
  expect(partials[0]!.partial.ok).toBe(false);
  expect(partials[0]!.partial.sourceUrls).toEqual([urlOf('q1'), urlOf('q1-extra')]);
  expect(result.ladder.evidence.filter((item) => item.source === urlOf('q1')).map((item) => item.questionId)).toEqual(['q1', 'q2']);
  expect(new Set(result.ladder.evidence.map((item) => item.questionId))).toEqual(new Set(questions.map((question) => question.id)));
});

// ── 🔴 #38112 privacy invariants ──
test('🔴 privacy: a route that does not confirm entry dispatches nothing, streamed or final', async () => {
  for (const route of [LOCAL, NOT_LOCAL, undefined]) {
    events = [];
    const plan = planJson(route);
    const { invokeAxes, calls } = fakeSearch();
    await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan)));
    expect(calls).toEqual([]);
    expect(earlyStarted()).toEqual([]);
    expect(withheld().map((entry) => entry.target)).toContain('original-question');
  }
});

test('🔴 review r2: duplicate top-level `route` (entering first, localOnly last) sends ZERO external calls', async () => {
  for (const [first, last] of [[FACT, LOCAL], [LOCAL, FACT]] as const) {
    events = [];
    // Valid JSON; JSON.parse keeps the LAST `route`, a streamed reader sees the FIRST.
    const plan = `${planJson(first).slice(0, -1)},"route":${JSON.stringify(last)}}`;
    const { invokeAxes, calls } = fakeSearch();
    const result = await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan([
      { at: ROUTE_STREAMED_AT, text: throughRoute(plan) },
      { at: FIRST_QUESTION_STREAMED_AT, text: throughFirstQuestion(plan) },
      { at: ROOT_CLOSED_AT, text: plan },
    ], plan)));
    expect(calls).toEqual([]);
    expect(earlyStarted()).toEqual([]);
    expect(result.ok).toBe(false);
    expect(withheld().map((entry) => entry.target)).toContain('axes');
  }
});

test('🔴 review r2: duplicate top-level `questions` gets no head start; the fanout uses the parsed (last) questions', async () => {
  const decoy = questions.map((question) => ({ ...question, searchTerms: [`decoy ${question.id}`] }));
  const plan = `${JSON.stringify({ route: FACT, outputContract, questions: decoy }).slice(0, -1)},"questions":${JSON.stringify(questions)}}`;
  const { invokeAxes, calls } = fakeSearch();
  await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan)));
  expect(earlyStarted()).toEqual([]);
  expect(calls[0]!.at).toBe(PLAN_END_AT);
  expect(sentTerms(calls)).not.toContain('decoy q1');
});

test('🔴 privacy: route written after the questions still confirms only once the root has closed', async () => {
  const questionsFirst = JSON.stringify({ questions, outputContract, route: FACT });
  const { invokeAxes, calls } = fakeSearch();
  await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan([
    { at: FIRST_QUESTION_STREAMED_AT, text: questionsFirst.slice(0, questionsFirst.indexOf(',{"id":"q2"')) },
    { at: ROOT_CLOSED_AT, text: questionsFirst },
  ], questionsFirst)));
  expect(calls[0]!.at).toBe(ROOT_CLOSED_AT);
});

test('🔴 privacy: the raw user question never reaches the search — head-start terms carrying it are dropped', async () => {
  const rawFirst = [{ ...questions[0]!, searchTerms: [request, 'plan term 1'] }, ...questions.slice(1)];
  const plan = planJson(FACT, rawFirst);
  const { invokeAxes, calls } = fakeSearch();
  await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan)));
  expect(calls[0]!.terms).toEqual(['plan term 1']);
  expect(sentTerms(calls)).not.toContain(request);

  events = [];
  const onlyRaw = planJson(FACT, [{ ...questions[0]!, searchTerms: [request] }, ...questions.slice(1)]);
  const second = fakeSearch();
  await runResearchQuestionLadder(request, gated(second.invokeAxes, streamedPlan(fullStream(onlyRaw), onlyRaw)));
  expect(earlyStarted()).toEqual([]);
  expect(events.some((entry) => entry.event === 'early-axis-search-skipped')).toBe(true);
  expect(second.calls[0]!.at).toBe(PLAN_END_AT);
  expect(sentTerms(second.calls)).not.toContain(request);
});

test('fast path (q0 confirmed by the caller) is unchanged: no plan-question head start', async () => {
  const plan = planJson(FACT);
  const { invokeAxes, calls } = fakeSearch();
  await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan), { requireConfirmedRoute: false }));
  expect(earlyStarted()).toEqual([]);
  expect(calls.filter((call) => call.at < PLAN_END_AT).map((call) => call.terms)).toEqual([[request]]);
});

// ── review r2 P2: a term the head start sent is skipped on every axis, and every such axis receives its evidence ──
test('review r2: an axis whose ONLY term duplicates the head-start term receives that evidence with zero extra calls', async () => {
  const shared = questions[0]!.searchTerms[0]!;
  const plan = planJson(FACT, questions.map((question) => question.id === 'q3' ? { ...question, searchTerms: [shared] } : question));
  const { invokeAxes, calls } = fakeSearch();
  const result = await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan)));
  expect(calls[0]!.terms).toEqual([shared]);
  expect(calls[1]!.terms).toEqual(questions.filter((question) => question.id !== 'q1' && question.id !== 'q3')
    .flatMap((question) => question.searchTerms));
  expect(sentTerms(calls).filter((term) => term === shared)).toEqual([shared]);
  expect(result.ladder.evidence.filter((item) => item.source === urlOf('q1')).map((item) => item.questionId).sort())
    .toEqual(['q1', 'q3']);
});

// ── 실패 경로 표 (read · write · holder dies · concurrent · restart) ──
test('failure · read: a malformed first question starts nothing early; the fanout covers the plan after it returns', async () => {
  for (const broken of [
    { ...questions[0]!, searchTerms: 'plan term 1' },
    { ...questions[0]!, level: 9 },
    { ...questions[0]!, searchTerms: [] },
  ]) {
    events = [];
    const plan = planJson(FACT, [broken as unknown as BloomResearchQuestion, ...questions.slice(1)]);
    const { invokeAxes, calls } = fakeSearch();
    await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan)));
    expect(earlyStarted()).toEqual([]);
    expect(calls.every((call) => call.at === PLAN_END_AT)).toBe(true);
  }
});

test('failure · write: a head-start search that throws is logged value-free; the run completes with no resend', async () => {
  const plan = planJson(FACT);
  const { invokeAxes: fanout, calls } = fakeSearch();
  let headStartCalls = 0;
  const invokeAxes: InvokeAxes = async (axes, signal, admit, onAxisEvidence) => {
    if (clock < PLAN_END_AT) { headStartCalls += 1; throw new Error(`provider down for ${axes[0]!.searchTerms[0]} at https://secret.example/key`); }
    return fanout(axes, signal, admit, onAxisEvidence);
  };
  const result = await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan)));
  expect(headStartCalls).toBe(1);
  const failed = events.filter((entry) => entry.event === 'early-axis-search-failed').map((entry) => entry.data);
  expect(failed).toEqual([expect.objectContaining({ reason: 'search-error' })]);
  expect(JSON.stringify(failed)).not.toContain('secret.example');
  expect(JSON.stringify(failed)).not.toContain(questions[0]!.searchTerms[0]!);
  expect(calls[0]!.terms).toEqual(questions.slice(1).flatMap((question) => question.searchTerms));
  expect(result.output).not.toBe('');
});

test('failure · holder dies: a plan that fails after the head start aborts that search and dispatches nothing more', async () => {
  const plan = planJson(FACT);
  const signals: AbortSignal[] = [];
  const invokeAxes: InvokeAxes = (axes, signal) => {
    signals.push(signal!);
    return new Promise((resolve) => signal!.addEventListener('abort', () => resolve({
      plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [] })),
    }), { once: true }));
  };
  const result = await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), 'not json')));
  expect(result.ok).toBe(false);
  expect(signals.length).toBe(1);
  expect(signals[0]!.aborted).toBe(true);
});

test('failure · holder dies late: a head-start result that lands after the run failed never reaches the seam', async () => {
  const plan = planJson(FACT);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const partials: ResearchGroundingResult[] = [];
  const invokeAxes: InvokeAxes = async (axes, _signal, _admit, onAxisEvidence) => {
    await held; // ignores its abort signal on purpose: a provider that answers late anyway
    onAxisEvidence?.(axes[0]!.id, [envelope(axes[0]!.id)]);
    return { plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [envelope(axis.id)] })) };
  };
  const result = await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), 'not json'),
    { onPartialGrounding: (partial) => partials.push(partial) }));
  expect(result.ok).toBe(false);
  release();
  await flush();
  expect(partials).toEqual([]);
});

test('failure · concurrent: a head start still running when the fanout ends is awaited and merged, not duplicated', async () => {
  const plan = planJson(FACT);
  let releaseHeadStart!: () => void;
  const headStartGate = new Promise<void>((resolve) => { releaseHeadStart = resolve; });
  const { invokeAxes: fanout, calls } = fakeSearch();
  let headStartStarted = false;
  const invokeAxes: InvokeAxes = async (axes, signal, admit, onAxisEvidence) => {
    if (!headStartStarted) { headStartStarted = true; await headStartGate; }
    return fanout(axes, signal, admit, onAxisEvidence);
  };
  const pending = runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan)));
  await until(() => calls.length === 1); // the fanout (q2..q6) finished while the head start is still held
  releaseHeadStart();
  const result = await pending;
  expect(calls.slice(0, 2).map((call) => call.terms)).toEqual([
    questions.slice(1).flatMap((question) => question.searchTerms), questions[0]!.searchTerms,
  ]);
  expect(result.ladder.evidence.filter((item) => item.source === urlOf('q1')).length).toBe(1);
});

test('failure · restart: a second run starts its own head start; no state leaks from the first run', async () => {
  const runOnce = async () => {
    const plan = planJson(FACT);
    const partials: ResearchGroundingResult[] = [];
    const { invokeAxes, calls } = fakeSearch();
    await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan),
      { onPartialGrounding: (partial) => partials.push(partial) }));
    return { calls, partials };
  };
  const first = await runOnce();
  events = [];
  const second = await runOnce();
  expect(earlyStarted().length).toBe(1);
  expect(second.calls[0]!.at).toBe(ROOT_CLOSED_AT);
  expect(second.partials[0]!.sourceUrls).toEqual(first.partials[0]!.sourceUrls);
});

// ── review r3 mf2: per-question attribution — a URL another axis already holds still reaches the target axis ──
const duplicatesWithinAnAxis = (evidence: readonly ResearchEvidenceEnvelope[]): string[] => {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const item of evidence) {
    const key = `${item.questionId} ${item.source}`;
    if (seen.has(key)) repeated.push(key);
    seen.add(key);
  }
  return repeated;
};

test('review r3: a non-target axis already holding the URL does not take the head-start question\'s only result', async () => {
  const plan = planJson(FACT);
  // The head start (q1) finds ONLY urlOf('q1') (returned twice, to probe in-axis dedupe); q4 found the same URL itself.
  const { invokeAxes } = fakeSearch((id) => id === 'q1' ? [envelope(id), envelope(id)]
    : id === 'q4' ? [envelope(id, urlOf('q1')), envelope(id)] : [envelope(id)]);
  const result = await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan(fullStream(plan), plan)));
  expect(result.ladder.evidence.filter((item) => item.questionId === 'q1').map((item) => item.source)).toEqual([urlOf('q1')]);
  expect(result.ladder.evidence.filter((item) => item.source === urlOf('q1')).map((item) => item.questionId).sort())
    .toEqual(['q1', 'q4']);
  expect(duplicatesWithinAnAxis(result.ladder.evidence)).toEqual([]);
});

test('review r3: the q0 merge follows the same per-question rule (fast path)', async () => {
  const plan = planJson(FACT, questions.map((question) => question.id === 'q1' ? { ...question, searchTerms: [request] } : question));
  const seedUrl = urlOf('seed');
  const { invokeAxes } = fakeSearch((id) => id === 'q0-original' ? [envelope(id, seedUrl)]
    : id === 'q5' ? [envelope(id, seedUrl), envelope(id)] : [envelope(id)]);
  const result = await runResearchQuestionLadder(request, gated(invokeAxes, streamedPlan([], plan), { requireConfirmedRoute: false }));
  expect(result.ladder.evidence.filter((item) => item.source === seedUrl).map((item) => item.questionId).sort()).toEqual(['q1', 'q5']);
  expect(duplicatesWithinAnAxis(result.ladder.evidence)).toEqual([]);
});

// JUD (MOB-1): «while the raw-question search is held, search starts once the route is confirmed with plan entities».
// CURRENT behavior, documented as-is (ROUTE-PRIVACY: do not change here): the route is confirmed off the stream
// (gateExternalSearchByRoute), but the plan-entity search (startEarlyAxisSearch) waits for closedStreamedPlanRoot.
test('📌 current: raw question is never sent; with route confirmed + first question streamed, the plan-entity search still waits for the closed root', async () => {
  const plan = planJson(FACT);
  const { invokeAxes, calls } = fakeSearch();
  const seen: number[] = [];
  const steps = fullStream(plan).slice(0, 2);
  await runResearchQuestionLadder(request, gated(invokeAxes, async (prompt, signal, onChunk) => {
    for (const step of steps) { clock = step.at; onChunk?.(step.text); await flush(); seen.push(calls.length); }
    clock = PLAN_END_AT;
    return plan;
  }));
  // After the route AND the first question streamed (root still open) nothing was dispatched yet.
  expect(seen).toEqual([0, 0]);
  expect(calls[0]!.at).toBe(PLAN_END_AT);
  // The raw question text (or a run of it) is never an external search term, held or released.
  expect(sentTerms(calls).some((term) => term.includes(request) || request.includes(term))).toBe(false);
  expect(withheld().map((entry) => entry.target)).toContain('original-question');
});

test.todo('desired (NOT current): plan-entity search starts at route confirmation, before the plan root closes (needs a ROUTE-PRIVACY decision)', () => {});
