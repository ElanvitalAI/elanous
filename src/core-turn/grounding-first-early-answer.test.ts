// GROUNDING-FIRST-ANSWER-30S — a grounding-first turn streams an early, partial-marked answer from the first
// citable evidence instead of waiting for the whole research run; no evidence still means status only.
// GROUNDING-GLM-RED (e)(f): a slow early answer never holds the turn past research that settled with citable evidence.
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';
import * as surfaces from '../session-runtime/index.js';
import * as deferred from '../session-runtime/tier-flip.js';
import { fanOutAxisEvidence } from '../research/axis-fanout.js';
import { routeResearchOutput } from '../research/output-router.js';
import {
  ORIGINAL_QUESTION_AXIS_ID, researchTurnForGrounding, runResearchQuestionLadder, type ResearchGroundingResult,
} from '../auto-research/research-turn.js';
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { runCoreTurn, type ResearchRunHooks } from './run-core-turn.js';
import { GROUNDING_PARTIAL, GROUNDING_UNAVAILABLE } from './grounding-first.js';
import { RESEARCH_EARLY_ANSWER_REASONING_EFFORT, RESEARCH_TURN_FIRST_REPLY_BUDGET_MS } from './research-policy.js';
import { CitationLedger, countVerifiedCitations } from './citation-guard.js';
import { RESEARCH_SYNTHESIS_EVIDENCE_BUDGET_CHARS } from '../auto-research/synthesis-evidence-budget.js';

beforeEach(() => {
  spyOn(surfaces, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaces.resolveSessionSurfaceProfile>);
  spyOn(deferred, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools], stats: { activeCount: tools.length, deferredCount: 0,
      warmPreloaded: [], injected: false, deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
  } as unknown as ReturnType<typeof deferred.applyDeferredTools>));
});
afterEach(() => mock.restore());

const request = '내년(2027) 미국·한국 주식 전망은 어때?';
const partialUrl = 'https://example.org/partial-source';
const fullUrl = 'https://example.org/full-source';
const unfetchedUrl = 'https://unfetched.example/invented';
const partialEvidence = { ok: false, output: 'Partial market evidence from the first settled axis.', sourceUrls: [partialUrl] };
const fullEvidence = { ok: true, output: 'Full market evidence from every axis.', sourceUrls: [partialUrl, fullUrl] };
type ResearchOutcome = { ok: boolean; output: string; sourceUrls?: string[]; error?: string };

/** Manual timer seam: nothing fires unless the test fires it, so no wall clock decides the outcome. */
function manualTimers() {
  let nextId = 0;
  const pending = new Map<number, { delayMs: number; callback: () => void }>();
  return {
    timers: {
      setTimeout: (callback: () => void, delayMs: number) => {
        nextId += 1;
        pending.set(nextId, { delayMs, callback });
        return nextId as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => { pending.delete(handle as unknown as number); },
    },
    has: (delayMs: number) => [...pending.values()].some(timer => timer.delayMs === delayMs),
    fire(delayMs: number): void {
      for (const [id, timer] of [...pending]) {
        if (timer.delayMs !== delayMs) continue;
        pending.delete(id);
        timer.callback();
      }
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise<void>(resolve => setImmediate(resolve));
}

function heldResearch() {
  let resolveResearch!: (value: ResearchOutcome) => void;
  let hooks: ResearchRunHooks | undefined;
  let calls = 0;
  const runResearch = (_request: string, _signal: AbortSignal, _admit?: unknown, _routing?: unknown, received?: ResearchRunHooks) => {
    calls += 1;
    hooks = received;
    return new Promise<ResearchOutcome>(resolve => { resolveResearch = resolve; });
  };
  return {
    runResearch,
    resolve: (value: ResearchOutcome) => resolveResearch(value),
    hooks: () => hooks,
    calls: () => calls,
  };
}

const context = (text: string, sink: { visible: string[]; replaced: string[]; status: string[] }) => ({
  sessionId: 'grounding-first-early-answer', messages: [{ role: 'user' as const, content: text }],
  userText: text, tools: [], dispatchTool: async () => null, signal: new AbortController().signal,
  callbacks: {
    onText: (_delta: string, full: string) => { sink.visible.push(full); },
    onReplaceText: (full: string) => { sink.replaced.push(full); },
    onStatus: (line: string) => { sink.status.push(line); },
  },
});

const messageText = (messages: Parameters<typeof llm.streamLLMWithTools>[0]) =>
  messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');

test('(a) citable partial evidence streams one partial-marked early answer; the full synthesis replaces it once', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    prompts.push(messageText(messages));
    const text = prompts.length === 1 ? `Early outlook from ${partialUrl} so far.\n` : `Full outlook from ${fullUrl} and ${partialUrl}\n`;
    handlers.onText(text, text);
    return text;
  });
  const pending = runCoreTurn(context(request, sink), { runResearch: research.runResearch, timers: clock.timers });
  await until(() => research.hooks() !== undefined);
  expect(prompts).toEqual([]);
  research.hooks()!.onPartialEvidence!(partialEvidence);
  await until(() => prompts.length === 1 && sink.visible.some(full => full.includes('Early outlook')));
  expect(prompts[0]).toContain(partialEvidence.output);
  expect(prompts[0]).not.toContain(fullEvidence.output);
  const early = sink.visible.at(-1)!;
  expect(early.startsWith(GROUNDING_PARTIAL)).toBe(true);
  expect(early).toContain(partialUrl);
  expect(sink.replaced).toEqual([]);
  research.resolve(fullEvidence);
  const result = await pending;
  expect(prompts.length).toBe(2);
  expect(prompts[1]).toContain(fullEvidence.output);
  expect(sink.replaced.length).toBe(1);
  expect(sink.replaced[0]).toBe(result.finalText);
  expect(result.finalText).toContain(fullUrl);
  expect(result.finalText).not.toContain(GROUNDING_PARTIAL);
  expect(sink.status.some(line => line.startsWith('근거 수집 중'))).toBe(false);
});

/** GROUNDING-PARTIAL-PREFIX-HONEST: the early answer is only the answer while research still runs. The 일부 검색이
 * 불완전 header is shown solely from the structured search state (ok / error / failedEvidenceCount / sources). */
async function runEarlyAnswerWith(partial: Record<string, unknown>) {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'research.turn') events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  });
  let calls = 0;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    calls += 1;
    const text = calls === 1 ? `Early outlook from ${partialUrl} so far.\n` : `Full outlook from ${fullUrl}\n`;
    handlers.onText(text, text);
    return text;
  });
  const pending = runCoreTurn(context(request, sink), { runResearch: research.runResearch, timers: manualTimers().timers });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!(partial as never);
  await until(() => events.some(entry => entry.event === 'grounding-first-early-answer-ready'));
  const early = sink.visible.at(-1)!;
  const first = sink.visible[0]!;
  research.resolve(fullEvidence);
  await pending;
  return { early, first, events };
}

test('(a2) healthy partial evidence (ok, source, no error): the early answer has no incomplete-search header', async () => {
  const { early, first, events } = await runEarlyAnswerWith({ ok: true, output: partialEvidence.output, sourceUrls: [partialUrl] });
  expect(early.includes(GROUNDING_PARTIAL)).toBe(false);
  expect(first).toContain('Early outlook');
  expect(early).toContain(partialUrl);
  expect(events.find(entry => entry.event === 'grounding-partial-prefix')?.data).toMatchObject({ shown: false, reason: 'healthy' });
});

test('(a3) the real in-progress snapshot (still collecting, no failed evidence) is not a failure: no header', async () => {
  const { early, events } = await runEarlyAnswerWith({
    ok: false, output: partialEvidence.output, sourceUrls: [partialUrl],
    error: 'partial evidence: research is still collecting', collecting: true, failedEvidenceCount: 0,
  });
  expect(early.includes(GROUNDING_PARTIAL)).toBe(false);
  expect(events.find(entry => entry.event === 'grounding-partial-prefix')?.data).toMatchObject({ shown: false, reason: 'healthy' });
});

test('(a4) a structured shortfall still shows the header: failed evidence, a real error, or a non-ok partial', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ok: false, output: partialEvidence.output, sourceUrls: [partialUrl], collecting: true, failedEvidenceCount: 1 }, 'search-failed'],
    [{ ok: true, output: partialEvidence.output, sourceUrls: [partialUrl], error: 'axis search timed out' }, 'search-error'],
    [{ ok: false, output: partialEvidence.output, sourceUrls: [partialUrl] }, 'not-ok'],
  ];
  for (const [partial, reason] of cases) {
    mock.restore();
    const { early, first, events } = await runEarlyAnswerWith(partial);
    expect(first).toBe(GROUNDING_PARTIAL + '\n\n');
    expect(early.startsWith(GROUNDING_PARTIAL)).toBe(true);
    expect(events.find(entry => entry.event === 'grounding-partial-prefix')?.data).toMatchObject({ shown: true, reason });
  }
});

test('(a5) a search-failed shortfall with structured failedAxes names the axis; without failedAxes the fixed header stays', async () => {
  const named = await runEarlyAnswerWith({
    ok: false, output: partialEvidence.output, sourceUrls: [partialUrl], collecting: true, failedEvidenceCount: 1, failedAxes: ['환율 전망 축'],
  });
  expect(named.first).toContain('환율 전망 축');
  expect(named.early.includes(GROUNDING_PARTIAL)).toBe(false);
  mock.restore();
  const healthy = await runEarlyAnswerWith({
    ok: false, output: partialEvidence.output, sourceUrls: [partialUrl], collecting: true, failedEvidenceCount: 0, failedAxes: [],
  });
  expect(healthy.early.includes('환율 전망 축')).toBe(false);
  expect(healthy.early.includes(GROUNDING_PARTIAL)).toBe(false);
});

test('(b) no citable evidence by the soft deadline: one honest elapsed-time status, no model answer', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  let now = 0;
  const model = spyOn(llm, 'streamLLMWithTools').mockResolvedValue('ungrounded claim');
  const pending = runCoreTurn(context(request, sink), {
    runResearch: research.runResearch, timers: clock.timers, now: () => now,
  });
  await until(() => clock.has(RESEARCH_TURN_FIRST_REPLY_BUDGET_MS));
  // Evidence without a structured source URL does not open the early answer.
  research.hooks()!.onPartialEvidence!({ ok: false, output: 'uncited text', sourceUrls: [] });
  now = RESEARCH_TURN_FIRST_REPLY_BUDGET_MS;
  clock.fire(RESEARCH_TURN_FIRST_REPLY_BUDGET_MS);
  expect(sink.status.filter(line => line.startsWith('근거 수집 중'))).toEqual([
    `근거 수집 중 · ${Math.round(RESEARCH_TURN_FIRST_REPLY_BUDGET_MS / 1000)}초 경과`,
  ]);
  expect(model).not.toHaveBeenCalled();
  expect(sink.visible).toEqual([]);
  research.resolve({ ok: false, output: '', error: 'no search provider' });
  const result = await pending;
  expect(model).not.toHaveBeenCalled();
  expect(result.finalText).toBe(GROUNDING_UNAVAILABLE);
  expect(sink.visible).toEqual([GROUNDING_UNAVAILABLE]);
});

test('(c) the early answer never shows a URL the turn did not fetch, and stays when the final run has no evidence', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  let modelCalls = 0;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    let full = '';
    for (const delta of ['Early view per ', `${partialUrl} and `, `${unfetchedUrl} `, 'done.\n']) {
      full += delta;
      handlers.onText(delta, full);
    }
    return full;
  });
  const pending = runCoreTurn(context(request, sink), { runResearch: research.runResearch, timers: clock.timers });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!(partialEvidence);
  await until(() => modelCalls === 1 && sink.visible.some(full => full.includes('done.')));
  research.resolve({ ok: false, output: '', error: 'research aborted' });
  const result = await pending;
  expect(modelCalls).toBe(1);
  for (const shown of [...sink.visible, ...sink.replaced, result.finalText]) expect(shown).not.toContain(unfetchedUrl);
  expect(result.finalText.startsWith(GROUNDING_PARTIAL)).toBe(true);
  expect(result.finalText).toContain(partialUrl);
  expect(result.finalText).not.toBe(GROUNDING_UNAVAILABLE);
});

test('a timed-out plan synthesizes completed social and web evidence instead of keeping the early answer', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const firecrawlUrl = 'https://news.example/market-2027';
  const grokUrl = 'https://x.com/market/post/27';
  const redditUrl = 'https://www.reddit.com/r/stocks/comments/2027/market_outlook/';
  const boundedEvidence = `Firecrawl market source ${firecrawlUrl}; Grok market source ${grokUrl}; Reddit investors expect volatility ${redditUrl}`;
  const partial = {
    ok: false, collecting: true, output: boundedEvidence + ' UNBOUNDED_EVIDENCE'.repeat(5_000),
    synthesisOutput: boundedEvidence,
    sourceUrls: [firecrawlUrl, grokUrl, redditUrl],
    sourceUsage: { firecrawl: 1, grok: 2, market: 0 },
    sourceAttribution: { [firecrawlUrl]: ['firecrawl' as const], [grokUrl]: ['grok' as const], [redditUrl]: ['grok' as const] },
  };
  const prompts: string[] = [];
  let usage: unknown;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    const prompt = messageText(messages);
    prompts.push(prompt);
    const answer = prompts.length === 1
      ? `레딧 여론은 미확인입니다. ${firecrawlUrl}`
      : `레딧 투자자들은 변동성을 예상합니다. ${redditUrl} 시장 근거: ${firecrawlUrl} ${grokUrl}`;
    handlers.onText(answer, answer);
    return answer;
  });
  const base = context(request, sink);
  const pending = runCoreTurn({ ...base, callbacks: {
    ...base.callbacks, onResearchSourceUsage: value => { usage = value; },
  } }, { runResearch: research.runResearch, timers: clock.timers,
    researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0 });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!(partial);
  await until(() => prompts.length === 1 && sink.visible.some(value => value.includes('미확인')));
  expect(clock.has(250)).toBe(true);
  clock.fire(250);
  research.resolve({ ok: false, output: `Firecrawl market source ${firecrawlUrl}`, sourceUrls: [firecrawlUrl],
    error: 'research stopped by its deadline' });
  const result = await pending;
  expect(prompts.length).toBe(2);
  expect(prompts[1]).toContain(redditUrl);
  expect(prompts[1]).not.toContain('UNBOUNDED_EVIDENCE');
  expect(result.finalText).toContain('레딧 투자자들은 변동성을 예상');
  expect(result.finalText).toContain(redditUrl);
  expect(sink.replaced.at(-1)).toBe(result.finalText);
  expect(usage).toEqual(partial.sourceUsage);
});

test('deadline merges Reddit summary and Grok attribution even when final and partial URLs match', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const redditUrl = 'https://www.reddit.com/r/stocks/comments/same/url/';
  const summary = 'Grok search-level synthesis: investors split on AI risk.';
  const excerpt = 'Original Reddit post excerpt: earnings uncertainty is the top comment.';
  const prompts: string[] = [];
  let usage: unknown;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    const prompt = messageText(messages); prompts.push(prompt);
    const answer = prompts.length === 1 ? '레딧 미확인' : `검색 요약에 따르면 의견이 갈린다. ${redditUrl}`;
    handlers.onText(answer, answer); return answer;
  });
  const base = context('2027 증시 레딧 여론은?', sink);
  const pending = runCoreTurn({ ...base, callbacks: { ...base.callbacks,
    onResearchSourceUsage: value => { usage = value; } } }, { runResearch: research.runResearch, timers: clock.timers,
    researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0 });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!({ ok: false, output: `Reddit hit ${redditUrl}`, sourceUrls: [redditUrl],
    sourceAttribution: { [redditUrl]: ['grok'] }, sourceUsage: { firecrawl: 0, grok: 1, market: 0 },
    redditSnippets: [{ url: redditUrl, snippet: summary, kind: 'provider-synthesis', sourceKind: 'search-summary:grok' }] });
  await until(() => prompts.length === 1);
  clock.fire(250);
  research.resolve({ ok: false, output: `Reddit hit ${redditUrl}`, sourceUrls: [redditUrl],
    sourceAttribution: { [redditUrl]: ['firecrawl'] }, sourceUsage: { firecrawl: 1, grok: 0, market: 0 },
    redditSnippets: [{ url: redditUrl, snippet: excerpt, kind: 'source-excerpt', sourceKind: 'web-search:firecrawl' }],
    error: 'research stopped by its deadline' } as ResearchGroundingResult);
  const result = await pending;
  expect(prompts[1]).toContain(summary);
  expect(prompts[1]).toContain(excerpt);
  expect(prompts[1]).toContain('"kind":"provider-synthesis"');
  expect(prompts[1]).toContain('"kind":"source-excerpt"');
  expect(prompts[1]).toContain('"sourceKind":"web-search:firecrawl"');
  expect(prompts[1]).not.toContain('1 verified sources');
  expect(result.finalText).toContain(redditUrl);
  expect(usage).toEqual({ firecrawl: 1, grok: 1, market: 0 });
});

test('deadline merges distinct excerpts at the same URL even with identical attribution', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    prompts.push(messageText(messages));
    const answer = `Source ${partialUrl}`; handlers.onText(answer, answer); return answer;
  });
  const pending = runCoreTurn(context(request, sink), { runResearch: research.runResearch, timers: clock.timers,
    researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0 });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!({ ok: false, output: `Partial excerpt says AI risk ${partialUrl}`,
    sourceUrls: [partialUrl], sourceAttribution: { [partialUrl]: ['grok'] } });
  await until(() => prompts.length === 1);
  clock.fire(250);
  research.resolve({ ok: false, output: `Final excerpt says earnings growth ${partialUrl}`,
    sourceUrls: [partialUrl], sourceAttribution: { [partialUrl]: ['grok'] },
    error: 'research stopped by its deadline' } as ResearchGroundingResult);
  await pending;
  expect(prompts[1]).toContain('Partial excerpt says AI risk');
  expect(prompts[1]).toContain('Final excerpt says earnings growth');
});

test('an X-only sentiment request does not receive Reddit instructions', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const xUrl = 'https://x.com/example/status/27';
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    prompts.push(messageText(messages));
    const answer = `X sample ${xUrl}`; handlers.onText(answer, answer); return answer;
  });
  const pending = runCoreTurn(context('2027년 미국 증시에 대한 X 여론은?', sink), { runResearch: research.runResearch,
    timers: clock.timers, researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0 });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!({ ok: false, output: `X discussion ${xUrl}`, sourceUrls: [xUrl] });
  await until(() => prompts.length === 1);
  clock.fire(250);
  research.resolve({ ok: false, output: '', error: 'research stopped by its deadline' });
  await pending;
  expect(prompts[1]).not.toContain('Reddit sample summary');
  expect(prompts[1]).toContain('X sample summary');
});

test('deadline merger bounds the whole synthesis evidence with long source URLs and raw output', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const extraUrls = Array.from({ length: 100 }, (_, index) => `https://publisher.example/${index}/${'long-segment'.repeat(35)}`);
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    const prompt = messageText(messages); prompts.push(prompt);
    const answer = `Observed ${partialUrl}`; handlers.onText(answer, answer); return answer;
  });
  const pending = runCoreTurn(context(request, sink), { runResearch: research.runResearch, timers: clock.timers,
    researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0 });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!({ ok: false, output: `Partial ${partialUrl} ${'x'.repeat(100_000)}`,
    sourceUrls: [partialUrl] });
  await until(() => prompts.length === 1);
  clock.fire(250);
  research.resolve({ ok: false, output: 'Final ' + 'y'.repeat(100_000),
    sourceUrls: extraUrls, error: 'research stopped by its deadline' });
  await pending;
  const evidence = prompts[1]!.split('<bloom-research>\n')[1]!.split('\n</bloom-research>')[0]!;
  expect(evidence.length).toBeLessThanOrEqual(RESEARCH_SYNTHESIS_EVIDENCE_BUDGET_CHARS);
  expect(evidence).toContain(partialUrl);
});

test('a hung research promise uses its partial snapshot once and retains its bounded tail', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    prompts.push(messageText(messages));
    const answer = `Observed ${partialUrl}`; handlers.onText(answer, answer); return answer;
  });
  const pending = runCoreTurn(context(request, sink), { runResearch: research.runResearch, timers: clock.timers,
    researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0 });
  await until(() => research.hooks() !== undefined);
  const bounded = `HEAD ${partialUrl} ` + 'x'.repeat(19_000) + ' BOUNDED_TAIL_MARKER';
  research.hooks()!.onPartialEvidence!({ ok: false, output: bounded, synthesisOutput: bounded, sourceUrls: [partialUrl] });
  await until(() => prompts.length === 1);
  clock.fire(250);
  await until(() => clock.has(50));
  clock.fire(50);
  await pending;
  expect(prompts[1]).toContain('BOUNDED_TAIL_MARKER');
  expect(prompts[1]!.match(/BOUNDED_TAIL_MARKER/g)).toHaveLength(1);
});

/** A slow provider (GLM 11-17 shape): the early-answer stream shows a first delta, then waits until its own signal aborts. */
function slowEarlyAnswerModel(prompts: string[], earlySignals: AbortSignal[]) {
  let releaseEarly: (() => void) | undefined;
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers, options) => {
    prompts.push(messageText(messages));
    if (prompts.length === 1) {
      const signal = options?.signal ?? new AbortController().signal;
      earlySignals.push(signal);
      const delta = `Early outlook from ${partialUrl} `;
      handlers.onText(delta, delta);
      await new Promise<void>(resolve => {
        releaseEarly = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (signal.aborted) throw new DOMException('early answer aborted', 'AbortError');
      const rest = 'finished.\n';
      handlers.onText(rest, delta + rest);
      return delta + rest;
    }
    const text = `Full outlook from ${fullUrl} and ${partialUrl}\n`;
    handlers.onText(text, text);
    return text;
  });
  return { releaseEarly: () => releaseEarly?.() };
}

test('(e) research that settles with citable evidence preempts a still-streaming early answer and reaches the full synthesis', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const prompts: string[] = [];
  const earlySignals: AbortSignal[] = [];
  slowEarlyAnswerModel(prompts, earlySignals);
  const parent = new AbortController();
  const pending = runCoreTurn({ ...context(request, sink), signal: parent.signal }, { runResearch: research.runResearch, timers: clock.timers });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!(partialEvidence);
  await until(() => earlySignals.length === 1);
  expect(earlySignals[0]!.aborted).toBe(false);
  research.resolve(fullEvidence);
  const result = await pending;
  expect(earlySignals[0]!.aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
  expect(prompts[1]).toContain(fullEvidence.output);
  expect(result.stopReason).not.toBe('aborted');
  expect(result.finalText).not.toBe(GROUNDING_UNAVAILABLE);
  expect(result.finalText).toContain(fullUrl);
  expect(sink.replaced.at(-1)).toBe(result.finalText);
});

test('deadline partial evidence preempts a slow early answer before the synthesis reserve is consumed', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const prompts: string[] = [];
  const earlySignals: AbortSignal[] = [];
  const model = slowEarlyAnswerModel(prompts, earlySignals);
  const pending = runCoreTurn(context(request, sink), { runResearch: research.runResearch,
    timers: clock.timers, researchWallClockBudgetMs: 250, researchTurnBudgetMs: 1_000, synthesisReservationMs: 0 });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!(partialEvidence);
  await until(() => earlySignals.length === 1);
  expect(clock.has(250)).toBe(true);
  clock.fire(250);
  research.resolve({ ok: false, output: '', error: 'research stopped by its deadline' });
  await new Promise<void>(resolve => setImmediate(resolve));
  const preempted = earlySignals[0]!.aborted;
  if (!preempted) model.releaseEarly();
  const result = await pending;
  expect(preempted).toBe(true);
  expect(prompts.length).toBe(2);
  expect(result.finalText).toContain(partialUrl);
  expect(sink.replaced.at(-1)).toBe(result.finalText);
});

test('(f) research that settles without citable evidence does not cut the early answer short; it is kept', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  const prompts: string[] = [];
  const earlySignals: AbortSignal[] = [];
  const model = slowEarlyAnswerModel(prompts, earlySignals);
  const pending = runCoreTurn(context(request, sink), { runResearch: research.runResearch, timers: clock.timers });
  await until(() => research.hooks() !== undefined);
  research.hooks()!.onPartialEvidence!(partialEvidence);
  await until(() => earlySignals.length === 1);
  research.resolve({ ok: false, output: '', error: 'research aborted' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(earlySignals[0]!.aborted).toBe(false);
  model.releaseEarly();
  const result = await pending;
  expect(prompts.slice(1)).toEqual([]);
  expect(result.finalText.startsWith(GROUNDING_PARTIAL)).toBe(true);
  expect(result.finalText).toContain('finished.');
  expect(result.finalText).not.toBe(GROUNDING_UNAVAILABLE);
});

test('(d) non-grounding turns get no early-answer hook and keep their single model turn', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const model = spyOn(llm, 'streamLLMWithTools').mockResolvedValue('Binary search halves a sorted range.');
  const result = await runCoreTurn(context('Explain binary search', sink), { runResearch: research.runResearch });
  expect(research.calls()).toBe(0);
  expect(model).toHaveBeenCalledTimes(1);
  expect(result.finalText).toBe('Binary search halves a sorted range.');
  expect(sink.status.some(line => line.startsWith('근거 수집 중'))).toBe(false);

  // A research (not grounding-first) turn still runs research but receives no early-answer hook.
  const researchTurn = heldResearch();
  model.mockResolvedValue('Provisional history.');
  const researchPending = runCoreTurn(context('Research the history of binary search', sink), { runResearch: researchTurn.runResearch });
  await until(() => researchTurn.calls() === 1);
  expect(researchTurn.hooks()?.onPartialEvidence).toBeUndefined();
  researchTurn.resolve({ ok: true, output: 'History evidence.', sourceUrls: [fullUrl] });
  await researchPending;
});

// The ladder contract asks for one question per Bloom level.
const ladderQuestions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`, level: (index + 1) as BloomResearchQuestion['level'], prompt: `Question q${index + 1}`,
  searchTerms: [`term-q${index + 1}`], sectionId: 'causes',
}));
const fanoutQuestions = ladderQuestions.slice(0, 2);
const ladderContract = {
  deliverable: 'A sourced research memo', format: 'Short memo',
  sections: [{ id: 'causes', title: 'Causes', purpose: 'Explain the supported causes.' }],
  completionCriteria: ['Each required section is supported by evidence or explicitly marked uncertain.'],
};
const ladderEvidence = (questionId: string, host: string): ResearchEvidenceEnvelope => ({
  questionId, sourceKind: 'web-search:test', source: `https://${host}/${questionId}`,
  observedAt: '2026-11-17T00:00:00.000Z', content: `Evidence ${questionId} from ${host}`, outcome: 'complete', truncated: true,
});

test('the research ladder hands each settled axis to onPartialGrounding as a never-ok, source-bearing snapshot', async () => {
  const partials: ResearchGroundingResult[] = [];
  await runResearchQuestionLadder('Why are bond yields rising?', {
    enableResearchFanout: false,
    routeOutput: input => routeResearchOutput({ ...input, skills: [] }),
    generateContract: async () => JSON.stringify(ladderContract),
    generate: async () => JSON.stringify({ questions: ladderQuestions }),
    onPartialGrounding: partial => partials.push(partial),
    invokeAxes: async (axes, _signal, _admit, onAxisEvidence) => {
      onAxisEvidence?.('q1', [{ ...ladderEvidence('q1', 'failed.example'), outcome: 'failed' }]);
      expect(partials).toEqual([]);
      onAxisEvidence?.('q1', [ladderEvidence('q1', 'example.org')]);
      expect(partials.length).toBe(1);
      expect(partials[0]!.ok).toBe(false);
      expect(partials[0]!.sourceUrls).toEqual(['https://example.org/q1']);
      expect(partials[0]!.output).toContain('Evidence q1 from example.org');
      expect(partials[0]!.output).not.toContain('failed.example');
      return {
        plan: axes.map(axis => ({ questionId: axis.id, tool: 'OmniSearch' as const, query: axis.searchTerms[0]! })),
        axes: axes.map(axis => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map(host => ladderEvidence(axis.id, host)) })),
      };
    },
  });
  expect(partials.length).toBe(1);
});

test('native axis fanout reports each search call as it settles, before the slowest axis', async () => {
  const releases = new Map<string, () => void>();
  const settledAxes: string[] = [];
  const pending = fanOutAxisEvidence(fanoutQuestions, {
    search: query => new Promise(resolve => {
      releases.set(query, () => resolve([{ url: `https://example.org/${query}`, title: query, snippet: 'observed', publishedAt: 0 }]));
    }),
    onAxisEvidence: (questionId, evidence) => {
      settledAxes.push(questionId);
      expect(evidence.map(item => item.source)).toEqual([`https://example.org/term-${questionId}`]);
    },
  });
  releases.get('term-q1')!();
  await until(() => settledAxes.length === 1);
  expect(settledAxes).toEqual(['q1']);
  releases.get('term-q2')!();
  const result = await pending;
  expect(settledAxes).toEqual(['q1', 'q2']);
  expect(result.axes.map(axis => axis.evidence.map(item => item.source))).toEqual([
    ['https://example.org/term-q1'], ['https://example.org/term-q2'],
  ]);
});

test('(g) 1121 PLAN-LATENCY: original-question evidence opens the early answer while the question plan is still running', async () => {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const clock = manualTimers();
  const prompts: string[] = [];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    prompts.push(messageText(messages));
    const text = prompts.length === 1 ? `Early outlook from ${partialUrl} so far.\n` : `Full outlook from ${fullUrl} and ${partialUrl}\n`;
    handlers.onText(text, text);
    return text;
  });
  let releasePlan!: (raw: string) => void;
  let planSettled = false;
  const searched: string[][] = [];
  const seedSignals: AbortSignal[] = [];
  // The plan repeats the user's question as q1's first search term.
  const planQuestions = ladderQuestions.map(question => question.id === 'q1'
    ? { ...question, searchTerms: [request, ...question.searchTerms] } : question);
  const pending = runCoreTurn(context(request, sink), {
    timers: clock.timers,
    researchQuestionLadderRunner: async (text, researchOptions) => researchTurnForGrounding(await runResearchQuestionLadder(text, {
      ...researchOptions,
      enableResearchFanout: false,
      routeOutput: input => routeResearchOutput({ ...input, skills: [] }),
      generatePreparation: () => new Promise<string>(resolve => {
        releasePlan = raw => { planSettled = true; resolve(raw); };
      }),
      invokeAxes: async (axes, signal, _admit, onAxisEvidence) => {
        searched.push(axes.flatMap(axis => axis.searchTerms));
        if (axes.length === 1 && axes[0]!.id === ORIGINAL_QUESTION_AXIS_ID) {
          seedSignals.push(signal!);
          const evidence = [{ ...ladderEvidence(ORIGINAL_QUESTION_AXIS_ID, 'example.org'), source: partialUrl }];
          onAxisEvidence?.(ORIGINAL_QUESTION_AXIS_ID, evidence);
          return { plan: [], axes: [{ questionId: ORIGINAL_QUESTION_AXIS_ID, evidence }] };
        }
        if (searched.length > 2) return { plan: [], axes: axes.map(axis => ({ questionId: axis.id, evidence: [] })) };
        return {
          plan: [],
          axes: axes.map(axis => ({ questionId: axis.id, evidence: [
            axis.id === 'q1' ? { ...ladderEvidence('q1', 'example.org'), source: fullUrl } : ladderEvidence(axis.id, 'example.org'),
            ladderEvidence(axis.id, 'example.net'),
          ] })),
        };
      },
    })),
  });
  await until(() => prompts.length === 1 && sink.visible.some(full => full.includes('Early outlook')));
  expect(planSettled).toBe(false);
  expect(searched).toEqual([[request]]);
  expect(seedSignals[0]!.aborted).toBe(false);
  expect(prompts[0]).toContain(partialUrl);
  // GROUNDING-PARTIAL-PREFIX-HONEST: a still-collecting snapshot with no failed evidence is not an incomplete search.
  expect(sink.visible.at(-1)!.includes(GROUNDING_PARTIAL)).toBe(false);
  expect(sink.replaced).toEqual([]);

  releasePlan(JSON.stringify({ outputContract: ladderContract, questions: planQuestions }));
  const result = await pending;
  expect(searched[1]).toEqual(ladderQuestions.flatMap(question => question.searchTerms));
  expect(searched.slice(0, 2).flat().filter(query => query === request)).toEqual([request]);
  expect(prompts.length).toBe(2);
  expect(sink.replaced.length).toBe(1);
  expect(result.finalText).toContain(fullUrl);
  expect(result.finalText).not.toContain(GROUNDING_PARTIAL);
});

/** 1121 FIRST-CITED-30S fixture: fake clock, held research, fake provider whose early answer streams `earlyDeltas`
 * (each at its own fake time) before research settles with full evidence. */
async function runFirstCitedTurn(options: {
  reasoningEffort?: 'high'; earlyDeltas?: Array<[atMs: number, delta: string]>; noPartialEvidence?: boolean;
} = {}) {
  const sink = { visible: [] as string[], replaced: [] as string[], status: [] as string[] };
  const research = heldResearch();
  const clock = manualTimers();
  let now = 0;
  const efforts: Array<string | undefined> = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'research.turn') events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  });
  const earlyDeltas = options.earlyDeltas ?? [[1_000, `Early outlook from ${partialUrl} so far.\n`]];
  spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers, streamOptions) => {
    efforts.push(streamOptions?.reasoningEffort);
    if (messageText(messages).includes('<partial-research>')) {
      let full = '';
      for (const [atMs, delta] of earlyDeltas) {
        now = atMs;
        full += delta;
        handlers.onText(delta, full);
      }
      return full;
    }
    now = 60_000;
    const text = `Full outlook from ${fullUrl} and ${partialUrl}\n`;
    handlers.onText(text, text);
    return text;
  });
  const pending = runCoreTurn({ ...context(request, sink), ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) },
    { runResearch: research.runResearch, timers: clock.timers, now: () => now });
  await until(() => research.hooks() !== undefined);
  if (!options.noPartialEvidence) {
    research.hooks()!.onPartialEvidence!(partialEvidence);
    await until(() => events.some(entry => entry.event === 'grounding-first-early-answer-ready'));
  }
  research.resolve(fullEvidence);
  const result = await pending;
  return { sink, efforts, events, result };
}

test('(h) 1121 FIRST-CITED-30S: the early answer asks for the light reasoning effort; synthesis effort is unchanged', async () => {
  const { efforts, events } = await runFirstCitedTurn();
  expect(RESEARCH_EARLY_ANSWER_REASONING_EFFORT).toBe('low');
  expect(efforts).toEqual([RESEARCH_EARLY_ANSWER_REASONING_EFFORT, undefined]);
  expect(events.find(entry => entry.event === 'grounding-first-early-answer-started')?.data.reasoningEffort)
    .toBe(RESEARCH_EARLY_ANSWER_REASONING_EFFORT);
});

test('(h2) an explicit caller reasoning effort still wins for the early answer', async () => {
  const { efforts } = await runFirstCitedTurn({ reasoningEffort: 'high' });
  expect(efforts).toEqual(['high', 'high']);
});

test('(i) first-cited-text: the status prefix and uncited or unfetched text do not count; logged once at the first verified citation', async () => {
  const { sink, events, result } = await runFirstCitedTurn({
    earlyDeltas: [
      [5_000, 'Early outlook so far, '],
      [6_000, `per ${unfetchedUrl} `],
      [7_000, `and ${partialUrl}\n`],
    ],
  });
  // The first visible text is the status prefix alone: no citation, no first-cited event at that moment.
  expect(sink.visible[0]).toBe(GROUNDING_PARTIAL + '\n\n');
  const cited = events.filter(entry => entry.event === 'first-cited-text');
  expect(cited.length).toBe(1);
  expect(cited[0]!.data).toMatchObject({ stage: 'early-answer', citations: 1, elapsedMs: 7_000, sinceResearchStartMs: 7_000 });
  for (const shown of [...sink.visible, ...sink.replaced, result.finalText]) expect(shown).not.toContain(unfetchedUrl);
  expect(result.finalText).toContain(fullUrl);
});

test('(j) an uncited early answer becomes cited when its guarded replacement adds the fetched sources', async () => {
  const { sink, events } = await runFirstCitedTurn({ earlyDeltas: [[3_000, 'Early outlook, still checking sources.\n']] });
  const cited = events.filter(entry => entry.event === 'first-cited-text');
  expect(cited.length).toBe(1);
  expect(cited[0]!.data).toMatchObject({ stage: 'early-answer', citations: 1, elapsedMs: 3_000 });
  expect(sink.replaced[0]).toContain(partialUrl);
});

test('(k) without an early answer the first cited text is the synthesis', async () => {
  const { efforts, events } = await runFirstCitedTurn({ noPartialEvidence: true });
  expect(efforts).toEqual([undefined]);
  expect(events.some(entry => entry.event === 'grounding-first-early-answer-started')).toBe(false);
  const cited = events.filter(entry => entry.event === 'first-cited-text');
  expect(cited.length).toBe(1);
  expect(cited[0]!.data).toMatchObject({ stage: 'synthesis', citations: 2, elapsedMs: 60_000 });
});

test('countVerifiedCitations counts distinct fetched URLs only (user-typed and unfetched URLs do not count)', () => {
  const ledger = new CitationLedger();
  ledger.addFetched({ sourceUrls: [partialUrl] });
  ledger.addUserText(`see ${fullUrl}`);
  expect(countVerifiedCitations(GROUNDING_PARTIAL, ledger)).toBe(0);
  expect(countVerifiedCitations(`${fullUrl} ${unfetchedUrl}`, ledger)).toBe(0);
  expect(countVerifiedCitations(`${partialUrl} and again ${partialUrl}.`, ledger)).toBe(1);
});
