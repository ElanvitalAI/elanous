// 1121 FIRST-ANSWER-30S — the grounding-first early answer is short (Bloom L1·L2), cited and capped; deep Bloom L4·L5
// runs only AFTER it (the synthesis), and a default research entry alone no longer makes a web-tool turn deep.
// Fake model · fake plan · fake search · fake clock only (zero real calls).
// 출처: REHEARSAL-0328 U2/U2b (seat-state/UX/evidence/20261117/REHEARSAL-0328/U2/nexus-debug.jsonl).
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';
import * as surfaces from '../session-runtime/index.js';
import * as deferred from '../session-runtime/tier-flip.js';
import {
  researchTurnForGrounding, runResearchQuestionLadder, type ResearchQuestionLadderRunOptions,
} from '../auto-research/research-turn.js';
import { routeResearchOutput } from '../research/output-router.js';
import { runCoreTurn, type ResearchRunHooks } from './run-core-turn.js';
import type { ResearchRouteFields } from './research-route.js';
import {
  RESEARCH_EARLY_ANSWER_INSTRUCTION, RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS, RESEARCH_EARLY_ANSWER_REASONING_EFFORT,
  RESEARCH_TURN_SHALLOW_BUDGET_MS,
} from './research-policy.js';

const webSearch: LLMToolSpec = { name: 'WebSearch', description: 'Search the web', parameters: { type: 'object', properties: {} } };
const read: LLMToolSpec = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } };
const FACT: ResearchRouteFields = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public fact' };
const LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local fact' };
const NOT_LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: false, reason: 'general knowledge' };
const partialUrl = 'https://news.example/q0-outlook';
const fullUrl = 'https://news.example/full-outlook';
const partialEvidence = { ok: false, output: 'Partial outlook evidence from the original-question search.', sourceUrls: [partialUrl] };
const fullEvidence = { ok: true, output: 'Full outlook evidence from every axis.', sourceUrls: [partialUrl, fullUrl] };
/** The two CROWN demo sentences (verbatim) and the DEMO-1121-NORTH-STAR 2027 variant. */
const DEMO_SENTENCES = ['11~12월 미국·한국 주식 전망은 어때?', '젠슨황 스캔들 최근 소식은 뭐야?', '내년(2027) 미국·한국 주식 전망은 어때?'];
/** 출처: GROUNDING-FIRST-ANSWER-30S 칸의 완료선 — 첫 답(출처 1개 이상)은 30초 안. */
const FIRST_ANSWER_BUDGET_MS = 30_000;
const DEEP_MARKER = '3–5 short questions';

let events: Array<{ event: string; data: Record<string, unknown> }> = [];
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
    if (category === 'research' || category === 'research.turn') events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log);
});
afterEach(() => mock.restore());

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise<void>(resolve => setImmediate(resolve));
}
const text = (messages: Parameters<typeof llm.streamLLMWithTools>[0]) =>
  messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
const named = (event: string) => events.filter(entry => entry.event === event).map(entry => entry.data);

function heldResearch() {
  let resolveResearch!: (value: { ok: boolean; output: string; sourceUrls?: string[]; error?: string }) => void;
  let hooks: ResearchRunHooks | undefined;
  const runResearch = (_request: string, _signal: AbortSignal, _admit?: unknown, _routing?: unknown, received?: ResearchRunHooks) => {
    hooks = received;
    return new Promise<{ ok: boolean; output: string; sourceUrls?: string[]; error?: string }>(resolve => { resolveResearch = resolve; });
  };
  return { runResearch, resolve: (value: Parameters<typeof resolveResearch>[0]) => resolveResearch(value), hooks: () => hooks };
}

test('CROWN demo sentences (+2027): first answer ≤30s (fake clock) · cited · light instruction · capped · deep only after', async () => {
  const calls: Array<{ prompt: string; maxTokens?: number; maxTokensExplicit?: boolean; reasoningEffort?: string }> = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    calls.push({ prompt: text(messages), maxTokens: options?.maxTokens, maxTokensExplicit: options?.maxTokensExplicit, reasoningEffort: options?.reasoningEffort });
    const reply = calls.length === 1 ? `첫 답: 근거에 따르면 방향은 엇갈립니다 (${partialUrl}).\n` : `보강 답 (${fullUrl}).\n`;
    handlers.onText(reply, reply);
    return reply;
  });
  for (const request of DEMO_SENTENCES) {
    events = [];
    calls.length = 0;
    let clock = 0;
    const research = heldResearch();
    const pending = runCoreTurn({
      sessionId: 'first-answer-30s', messages: [{ role: 'user', content: request }], userText: request,
      tools: [read, webSearch], dispatchTool: async () => null, signal: new AbortController().signal,
    }, { runResearch: research.runResearch, now: () => clock });
    await until(() => research.hooks() !== undefined);
    // q0 evidence lands at +2.5s (U2b measured), the route right after.
    clock = 2_500;
    research.hooks()!.onRoute?.(FACT);
    research.hooks()!.onPartialEvidence!(partialEvidence);
    await until(() => named('first-cited-text').length === 1);

    const firstCited = named('first-cited-text')[0]!;
    expect(firstCited.stage).toBe('early-answer');
    expect(typeof firstCited.citations).toBe('number');
    expect(firstCited.citations).not.toBe(0); // 칸 완료선 «출처 1개 이상»
    expect(firstCited.elapsedMs as number).toBeLessThanOrEqual(FIRST_ANSWER_BUDGET_MS); // 출처: FIRST_ANSWER_BUDGET_MS 위 주석
    expect(calls).toHaveLength(1);
    const early = calls[0]!;
    expect(early.prompt).toContain(RESEARCH_EARLY_ANSWER_INSTRUCTION);
    expect(early.prompt).toContain(partialEvidence.output);
    expect(early.prompt).not.toContain(DEEP_MARKER);
    expect(early.prompt).not.toContain('<research-answer-guidance>');
    expect(early.maxTokens).toBe(RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS);
    expect(early.maxTokensExplicit).toBe(true);
    expect(early.reasoningEffort).toBe(RESEARCH_EARLY_ANSWER_REASONING_EFFORT);

    clock = 120_000;
    research.resolve(fullEvidence);
    const result = await pending;
    expect(calls).toHaveLength(2);
    // Deep (Bloom L4·L5) is the continuation: present in the synthesis, after the first answer.
    expect(calls[1]!.prompt).toContain(DEEP_MARKER);
    expect(calls[1]!.prompt).toContain(fullEvidence.output);
    expect(result.finalText).toContain(fullUrl);
  }
});

test('the news sentence (no analysis word) gets deep only from the structured route, and only in the synthesis', async () => {
  const request = DEMO_SENTENCES[1]!;
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    prompts.push(text(messages));
    const reply = prompts.length === 1 ? `첫 답 (${partialUrl}).\n` : `보강 답 (${fullUrl}).\n`;
    handlers.onText(reply, reply);
    return reply;
  });
  const research = heldResearch();
  const pending = runCoreTurn({
    sessionId: 'first-answer-route-deep', messages: [{ role: 'user', content: request }], userText: request,
    tools: [read, webSearch], dispatchTool: async () => null, signal: new AbortController().signal,
  }, { runResearch: research.runResearch });
  await until(() => research.hooks() !== undefined);
  expect(named('deep-bloom-skipped')).toEqual([expect.objectContaining({ reason: 'no-deep-signal' })]);
  research.hooks()!.onRoute?.(FACT);
  research.hooks()!.onPartialEvidence!(partialEvidence);
  await until(() => prompts.length === 1);
  research.resolve(fullEvidence);
  await pending;
  expect(prompts[0]).not.toContain(DEEP_MARKER);
  expect(prompts[1]).toContain(DEEP_MARKER);
  expect(named('deep-bloom-applied')).toEqual([expect.objectContaining({ trigger: 'structured-route', stage: 'continuation' })]);
});

test('a non-time-sensitive web-tool turn is not deep: shallow budget, no Bloom instruction, ordinary answer', async () => {
  const request = '서울에서 부산까지 KTX 로 대략 몇 시간 걸려?';
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages) => { prompts.push(text(messages)); return 'ordinary answer'; });
  const result = await runCoreTurn({
    sessionId: 'first-answer-not-deep', messages: [{ role: 'user', content: request }], userText: request,
    tools: [read, webSearch], dispatchTool: async () => null, signal: new AbortController().signal,
  }, { runResearch: async (_request, _signal, _admit, _routing, hooks) => {
    hooks?.onRoute?.(NOT_LOCAL);
    return { ok: false, output: '', error: 'research route unconfirmed: external search withheld' };
  } });
  expect(result.finalText).toBe('ordinary answer');
  expect(named('research-budget-split')[0]).toMatchObject({ researchBudgetMs: RESEARCH_TURN_SHALLOW_BUDGET_MS });
  expect(named('deep-bloom-applied')).toEqual([]);
  expect(prompts.some(prompt => prompt.includes(DEEP_MARKER))).toBe(false);
});

/** Real ladder with a fake plan stream and counting (fake) search. */
function realLadderTurn(request: string, plan: string) {
  const queries: string[][] = [];
  const invokeAxes: NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']> = async (axes) => {
    queries.push(axes.flatMap(axis => axis.searchTerms));
    return { plan: [], axes: axes.map(axis => ({ questionId: axis.id, evidence: [] })) };
  };
  const run = runCoreTurn({
    sessionId: 'first-answer-real-ladder', messages: [{ role: 'user', content: request }], userText: request,
    tools: [read, webSearch], dispatchTool: async () => null, signal: new AbortController().signal,
  }, {
    researchQuestionLadderRunner: async (text, options) => researchTurnForGrounding(await runResearchQuestionLadder(text, {
      ...options,
      generatePreparation: async (_prompt, _signal, onChunk) => { onChunk?.(plan); return plan; },
      invokeAxes, enableResearchFanout: false, allowOutputSkill: false,
      routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
    })),
  });
  return { run, queries };
}
const validPlan = (route: ResearchRouteFields) => JSON.stringify({
  route,
  outputContract: {
    deliverable: 'A sourced answer', format: 'Short memo',
    sections: [{ id: 'facts', title: 'Facts', purpose: 'State the supported facts.' }],
    completionCriteria: ['Every claim is supported or marked uncertain.'],
  },
  questions: Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`, level: index + 1, prompt: `Question ${index + 1}`, searchTerms: [`plan term ${index + 1}`], sectionId: 'facts',
  })),
});
/** A request the old grounding detector does not match, so entry needs the plan's confirmation (no q0 head start). */
const CONFIRMATION_GATED = '엔비디아 다음 분기 어떻게 될까?';

test('localOnly: 0 external search calls and no deep continuation', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('ordinary answer');
  const turn = realLadderTurn(CONFIRMATION_GATED, validPlan(LOCAL));
  const result = await turn.run;
  expect(turn.queries).toEqual([]);
  expect(named('original-question-search-started')).toEqual([]);
  expect(named('deep-bloom-applied')).toEqual([]);
  expect(result.finalText).toBe('ordinary answer');
});

test('duplicate route (FACT then LOCAL): nothing is confirmed for search — 0 external calls, no deep continuation', async () => {
  spyOn(llm, 'streamLLMWithTools').mockResolvedValue('ordinary answer');
  const plan = `${validPlan(FACT).slice(0, -1)},"route":${JSON.stringify(LOCAL)}}`;
  const turn = realLadderTurn(CONFIRMATION_GATED, plan);
  await turn.run;
  expect(turn.queries).toEqual([]);
  expect(named('original-question-search-started')).toEqual([]);
  expect(named('early-axis-search-started')).toEqual([]);
  expect(named('deep-bloom-applied')).toEqual([]);
});
