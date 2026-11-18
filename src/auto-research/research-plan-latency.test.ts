// 1121 PLAN-LATENCY — ① the question-plan call asks for low reasoning effort; ② the original question is searched while the
// plan is still generated, its evidence reaches the early-answer seam first, the plan's identical query is not searched
// twice, and the search never outlives its budget, its parent, or the run. Deferred promises only — no wall clock.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { LLMOpts, LLMProvider } from '../llm.js';
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from './question-ladder-contract.js';
import { routeResearchOutput } from '../research/output-router.js';
import {
  ORIGINAL_QUESTION_AXIS_ID, RESEARCH_QUESTION_PLAN_REASONING_EFFORT, normalizeResearchQuery, runResearchQuestionLadder,
  type ResearchGroundingResult, type ResearchQuestionLadderRunOptions,
} from './research-turn.js';

type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;

// streamLLM fences injected providers off when an explicit fake switch is on (gate pods set one globally).
// This file asserts what the injected provider receives, so it clears only those switches for its own duration.
const FAKE_SWITCHES = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE'] as const;
const savedSwitches = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of FAKE_SWITCHES) { savedSwitches.set(name, process.env[name]); delete process.env[name]; }
});
afterEach(() => {
  for (const [name, value] of savedSwitches) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const request = '용평리조트 2026–27 겨울 시즌 개장 계획은?';
const outputContract = {
  deliverable: 'A sourced research memo', format: 'Short memo',
  sections: [{ id: 'causes', title: 'Causes', purpose: 'Explain the supported causes.' }],
  completionCriteria: ['Each required section is supported by evidence or explicitly marked uncertain.'],
};
// q1 repeats the user's question (different case/spacing) — the plan often does exactly this.
const questions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`, level: (index + 1) as BloomResearchQuestion['level'], prompt: `Question q${index + 1}`,
  searchTerms: index === 0 ? [`  ${request.toUpperCase()}  `, 'term-q1'] : [`term-q${index + 1}`],
  sectionId: 'causes',
}));
const urlA = 'https://www.example.org/opening';
const urlB = 'https://news.example.net/opening';
const envelope = (questionId: string, source: string): ResearchEvidenceEnvelope => ({
  questionId, sourceKind: 'web-search:test', source, observedAt: '2026-11-17T00:00:00.000Z',
  content: `Evidence from ${source}`, outcome: 'complete', truncated: true,
});
const noOutputSkills: ResearchQuestionLadderRunOptions['routeOutput'] = (input) => routeResearchOutput({ ...input, skills: [] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('① the question-plan call asks the active provider for low reasoning effort', async () => {
  const seen: Array<{ usageSite?: string; reasoningEffort?: LLMOpts['reasoningEffort'] }> = [];
  const provider: LLMProvider = {
    name: 'glm', defaultModel: 'glm-5.3', available: () => true,
    async *streamChat(_messages, options) {
      seen.push({ usageSite: options?.usageSite, reasoningEffort: options?.reasoningEffort });
      yield { type: 'text', delta: JSON.stringify({ outputContract, questions }) };
    },
    async *chat(_messages, options) {
      seen.push({ usageSite: options?.usageSite, reasoningEffort: options?.reasoningEffort });
      yield JSON.stringify({ outputContract, questions });
    },
  };
  const result = await runResearchQuestionLadder(request, {
    initialProvider: provider, enableResearchFanout: false, routeOutput: noOutputSkills, allowOutputSkill: false,
    invokeAxes: async (axes) => ({ plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [
      envelope(axis.id, `https://example.com/${axis.id}`), envelope(axis.id, `https://example.net/${axis.id}`),
    ] })) }),
  });
  expect(result.ladder.questions.map((question) => question.id)).toEqual(questions.map((question) => question.id));
  expect(RESEARCH_QUESTION_PLAN_REASONING_EFFORT).toBe('low');
  expect(seen).toEqual([{ usageSite: 'research-turn-preparation', reasoningEffort: RESEARCH_QUESTION_PLAN_REASONING_EFFORT }]);
});

test('② original-question evidence reaches onPartialGrounding before a slow plan finishes, and is not searched twice', async () => {
  const plan = deferred<string>();
  let planSettled = false;
  const partials: Array<{ partial: ResearchGroundingResult; planSettled: boolean }> = [];
  const searched: string[][] = [];
  const invokeAxes: InvokeAxes = async (axes, _signal, _admit, onAxisEvidence) => {
    searched.push(axes.flatMap((axis) => axis.searchTerms));
    if (axes.length === 1 && axes[0]!.id === ORIGINAL_QUESTION_AXIS_ID) {
      const evidence = [envelope(ORIGINAL_QUESTION_AXIS_ID, urlA), envelope(ORIGINAL_QUESTION_AXIS_ID, urlB)];
      onAxisEvidence?.(ORIGINAL_QUESTION_AXIS_ID, evidence);
      return { plan: [], axes: [{ questionId: ORIGINAL_QUESTION_AXIS_ID, evidence }] };
    }
    // Later gap follow-ups (if any) add nothing, so the assertions below only see the seed and the plan's axes.
    if (searched.length > 2) return { plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [] })) };
    // q2 independently finds urlA: the merged ledger must cite it once.
    return {
      plan: [],
      axes: axes.map((axis) => ({ questionId: axis.id, evidence: [
        envelope(axis.id, axis.id === 'q2' ? urlA : `https://example.com/${axis.id}`), envelope(axis.id, `https://example.net/${axis.id}`),
      ] })),
    };
  };
  const pending = runResearchQuestionLadder(request, {
    originalQuestionSearch: true,
    onPartialGrounding: (partial) => partials.push({ partial, planSettled }),
    generatePreparation: () => plan.promise.finally(() => { planSettled = true; }),
    invokeAxes, enableResearchFanout: false, routeOutput: noOutputSkills, allowOutputSkill: false,
  });

  await until(() => partials.length > 0);
  expect(partials[0]!.planSettled).toBe(false);
  expect(partials[0]!.partial.ok).toBe(false);
  expect(partials[0]!.partial.sourceUrls).toEqual([urlA, urlB]);
  expect(searched).toEqual([[request]]);

  plan.resolve(JSON.stringify({ outputContract, questions }));
  const result = await pending;

  const allQueries = searched.slice(0, 2).flat().map(normalizeResearchQuery);
  expect(new Set(allQueries).size).toBe(allQueries.length);
  expect(searched[1]).toEqual(['term-q1', 'term-q2', 'term-q3', 'term-q4', 'term-q5', 'term-q6']);
  // Per-question attribution (review #38166 r3): q1's seed result stays on q1 even though q2 found urlA independently.
  expect(result.ladder.evidence.filter((item) => item.source === urlA).map((item) => item.questionId)).toEqual(['q1', 'q2']);
  expect(result.ladder.evidence.filter((item) => item.source === urlB).map((item) => item.questionId)).toEqual(['q1']);
  expect(result.ladder.evidence.some((item) => item.questionId === ORIGINAL_QUESTION_AXIS_ID)).toBe(false);
});

for (const stop of ['parent abort', 'research deadline'] as const) {
  test(`② the original-question search is aborted by the ${stop} while the plan is still running`, async () => {
    const parent = new AbortController();
    const deadline = new AbortController();
    const seedSignals: AbortSignal[] = [];
    let planStarted = false;
    const invokeAxes: InvokeAxes = (axes, signal) => {
      seedSignals.push(signal!);
      return new Promise((resolve) => signal!.addEventListener('abort', () => resolve({
        plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [] })),
      }), { once: true }));
    };
    const pending = runResearchQuestionLadder(request, {
      originalQuestionSearch: true, onPartialGrounding: () => {},
      signal: parent.signal, createDeadlineSignal: () => deadline.signal,
      generatePreparation: (_prompt, signal) => new Promise<string>((_resolve, reject) => {
        planStarted = true;
        if (signal!.aborted) { reject(new Error('plan aborted')); return; }
        signal!.addEventListener('abort', () => reject(new Error('plan aborted')), { once: true });
      }),
      invokeAxes, enableResearchFanout: false, routeOutput: noOutputSkills, allowOutputSkill: false,
    });
    // Abort only once the plan call is actually in flight (the plan first loads its prompt context).
    await until(() => seedSignals.length === 1 && planStarted);
    expect(seedSignals[0]!.aborted).toBe(false);
    (stop === 'parent abort' ? parent : deadline).abort(new Error(stop));
    // Propagated by the abort itself — not by the run settling afterwards.
    expect(seedSignals[0]!.aborted).toBe(true);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(seedSignals.length).toBe(1);
  });
}

test('② a run that settles (plan failure) stops its still-running original-question search', async () => {
  const seedSignals: AbortSignal[] = [];
  const result = await runResearchQuestionLadder(request, {
    originalQuestionSearch: true, onPartialGrounding: () => {},
    generatePreparation: async () => 'not json',
    invokeAxes: (axes, signal) => {
      seedSignals.push(signal!);
      return new Promise((resolve) => signal!.addEventListener('abort', () => resolve({
        plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [] })),
      }), { once: true }));
    },
    enableResearchFanout: false, routeOutput: noOutputSkills, allowOutputSkill: false,
  });
  expect(result.ok).toBe(false);
  expect(seedSignals.length).toBe(1);
  expect(seedSignals[0]!.aborted).toBe(true);
});

test('② without the opt-in, research starts no search before the plan (old contract)', async () => {
  const plan = deferred<string>();
  const searched: string[][] = [];
  const pending = runResearchQuestionLadder(request, {
    onPartialGrounding: () => {},
    generatePreparation: () => plan.promise,
    invokeAxes: async (axes) => {
      searched.push(axes.flatMap((axis) => axis.searchTerms));
      return { plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [envelope(axis.id, `https://example.com/${axis.id}`)] })) };
    },
    enableResearchFanout: false, routeOutput: noOutputSkills, allowOutputSkill: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(searched).toEqual([]);
  plan.resolve(JSON.stringify({ outputContract, questions }));
  await pending;
  expect(searched[0]).toContain(`  ${request.toUpperCase()}  `);
});
