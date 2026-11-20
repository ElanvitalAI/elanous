// OP #114412 RESEARCH-LATENCY-BUDGET — the research turn has its own time budget (code default), with no caller-supplied
// turnDeadlineMs: the research phase stops at budget − synthesis reserve and synthesizes from the evidence so far.
// Fake clock + manual timers; assertions are exact structured values and event ORDER (NUMGUARD: no numeric bounds).
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import * as llmModule from '../llm.js';
import { debug } from '../debug/log.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { RESEARCH_TURN_BUDGET_MS, RESEARCH_TURN_SYNTHESIS_RESERVE_MS } from './research-policy.js';
import { runCoreTurn } from './run-core-turn.js';
import type { ResearchQuestionLadderRunOptions } from '../auto-research/research-turn.js';

const tool: LLMToolSpec = {
  name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} },
};
const BUDGET = RESEARCH_TURN_BUDGET_MS;
const RESERVE = RESEARCH_TURN_SYNTHESIS_RESERVE_MS;
const RESEARCH_DEADLINE = BUDGET - RESERVE;
const PARTIAL_EVIDENCE = 'partial source evidence';
const REQUEST = 'Research recent battery policy updates using current sources.';

function createManualTimers() {
  const scheduled: Array<{ delayMs: number; callback: () => void; handle: ReturnType<typeof setTimeout>; cleared: boolean }> = [];
  const waiters = new Map<number, Array<() => void>>();
  return {
    timers: {
      setTimeout(callback: () => void, delayMs: number) {
        const entry = { delayMs, callback, handle: globalThis.setTimeout(() => {}, RESERVE), cleared: false };
        scheduled.push(entry);
        for (const resolve of waiters.get(delayMs) ?? []) resolve();
        waiters.delete(delayMs);
        return entry.handle;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        const entry = scheduled.find(timer => timer.handle === handle);
        if (entry) entry.cleared = true;
        globalThis.clearTimeout(handle);
      },
    },
    fire(delayMs: number) {
      const entry = scheduled.find(timer => timer.delayMs === delayMs && !timer.cleared);
      if (!entry) throw new Error(`no active timer for ${delayMs}ms`);
      entry.callback();
    },
    waitFor(delayMs: number) {
      if (scheduled.some(timer => timer.delayMs === delayMs && !timer.cleared)) return Promise.resolve();
      return new Promise<void>(resolve => { waiters.set(delayMs, [...(waiters.get(delayMs) ?? []), resolve]); });
    },
  };
}

beforeEach(() => {
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools],
    stats: {
      activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false,
      deferredNames: [], unhydratableNames: [], unhydratableCount: 0,
    },
  } as unknown as ReturnType<typeof deferredModule.applyDeferredTools>));
});

afterEach(() => mock.restore());


type Recorded = { kind: 'research.turn' | 'research.stop'; event: string; data: Record<string, unknown>; clock: number };

async function runBudgetTurn(mode: 'slow-axis' | 'fast', turnOptions: { researchTurnBudgetMs?: number } = {}) {
  const manual = createManualTimers();
  const startClock = RESERVE; // 출처: test fixture — an arbitrary non-zero fake clock origin
  let clock = startClock;
  const recorded: Recorded[] = [];
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (category === 'research.turn' || category === 'research.stop') {
      recorded.push({ kind: category, event, data: data as Record<string, unknown>, clock });
    }
  });
  let startedResearch!: () => void;
  const researchStarted = new Promise<void>(resolve => { startedResearch = resolve; });
  let ladderOptions: ResearchQuestionLadderRunOptions | undefined;
  let modelCalls = 0;
  let synthesisSawEvidence = false;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onText?.('Provisional answer', 'Provisional answer');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'Provisional answer', phase: 'final_answer' }]);
      return 'Provisional answer';
    }
    synthesisSawEvidence = messages.some(message => message.role === 'user' && typeof message.content === 'string'
      && message.content.includes(PARTIAL_EVIDENCE));
    handlers.onText?.('Synthesized answer', 'Synthesized answer');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'Synthesized answer', phase: 'final_answer' }]);
    return 'Synthesized answer';
  });
  const pending = runCoreTurn({
    sessionId: 'research-latency-budget',
    messages: [{ role: 'user', content: REQUEST }],
    tools: [tool], dispatchTool: async () => null, signal: new AbortController().signal, userText: REQUEST,
  }, {
    now: () => clock,
    timers: manual.timers,
    ...turnOptions,
    researchQuestionLadderRunner: async (_request, options) => {
      ladderOptions = options;
      startedResearch();
      if (mode === 'fast') {
        options.onPhaseTiming?.({ axisMs: 0, fanoutMs: 0 });
        return { ok: true, output: PARTIAL_EVIDENCE, sourceUrls: [] } as never;
      }
      // Slow axis: nothing settles on its own; only the research-phase abort ends it, with the evidence collected so far.
      return new Promise(resolve => options.signal!.addEventListener('abort', () => {
        options.onPhaseTiming?.({ axisMs: clock - startClock });
        resolve({ ok: false, output: PARTIAL_EVIDENCE, sourceUrls: [], error: 'research stopped by its deadline' } as never);
      }, { once: true }));
    },
  });
  await researchStarted;
  if (mode === 'slow-axis') {
    await manual.waitFor(RESEARCH_DEADLINE);
    clock = startClock + RESEARCH_DEADLINE;
    manual.fire(RESEARCH_DEADLINE);
  }
  const result = await pending;
  return { result, recorded, startClock, ladderOptions, modelCalls, synthesisSawEvidence };
}

const find = (recorded: Recorded[], event: string) => recorded.find(item => item.event === event);
const order = (recorded: Recorded[], ...events: string[]) => events.map(event => recorded.findIndex(item => item.event === event));

test('the turn budget and its synthesis reserve are named code defaults; the research phase is budget − reserve', () => {
  expect(RESEARCH_DEADLINE).toBe(BUDGET - RESERVE);
});

test('(a) slow axis: research ends at the research-phase deadline, stoppedBy deadline, forced synthesis from the evidence so far', async () => {
  const run = await runBudgetTurn('slow-axis');

  // The web path passes no turnDeadlineMs: the default budget engages the reservation machinery.
  expect(find(run.recorded, 'research-budget-split')?.data).toMatchObject({
    turnDeadlineMs: BUDGET, reservationMs: RESERVE, researchDeadlineMs: RESEARCH_DEADLINE, limitedBy: 'synthesis-reserve',
  });
  const stops = run.recorded.filter(item => item.kind === 'research.stop').map(item => item.data.reason);
  expect(stops.indexOf('wall-clock-budget')).toBeLessThan(stops.indexOf('forced-synthesis'));
  // Ordering on the recorded events: deadline stop → latency-budget → synthesis-started.
  const [latency, synthesis] = order(run.recorded, 'latency-budget', 'synthesis-started');
  expect(latency < synthesis).toBe(true);
  const latencyEvent = find(run.recorded, 'latency-budget')!;
  expect(latencyEvent.data).toMatchObject({
    budgetMs: BUDGET, researchDeadlineMs: RESEARCH_DEADLINE, elapsedAtResearchEnd: RESEARCH_DEADLINE,
    stoppedBy: 'deadline', axisMs: RESEARCH_DEADLINE, fanoutMs: null, synthesisStartAtMs: RESEARCH_DEADLINE,
  });
  // Synthesis starts at budget − reserve on the fake clock, i.e. the turn can end within the budget (reserve is left).
  expect(find(run.recorded, 'synthesis-started')?.clock).toBe(run.startClock + BUDGET - RESERVE);
  expect(find(run.recorded, 'synthesis-started')?.data).toMatchObject({ forced: true, researchElapsedMs: RESEARCH_DEADLINE });
  expect(run.modelCalls).toBe(2);
  expect(run.synthesisSawEvidence).toBe(true);
  expect(run.result.finalText).toContain('Synthesized answer');
});

test('(c) the ladder receives the research-phase deadline on the turn clock, so the fanout angle deadline and grace clamp to it', async () => {
  const run = await runBudgetTurn('slow-axis');
  expect(run.ladderOptions?.researchStartedAt).toBe(run.startClock);
  expect(run.ladderOptions?.researchPhaseDeadlineAt).toBe(run.startClock + RESEARCH_DEADLINE);
  expect(typeof run.ladderOptions?.researchClock).toBe('function');
});

test('(d) a fast turn is unchanged: stoppedBy completed, no wall-clock stop, no forced synthesis', async () => {
  const run = await runBudgetTurn('fast');
  const stops = run.recorded.filter(item => item.kind === 'research.stop').map(item => item.data.reason);
  expect(stops).not.toContain('wall-clock-budget');
  expect(stops).not.toContain('forced-synthesis');
  expect(find(run.recorded, 'latency-budget')?.data).toMatchObject({
    budgetMs: BUDGET, researchDeadlineMs: RESEARCH_DEADLINE, elapsedAtResearchEnd: 0, stoppedBy: 'completed',
    axisMs: 0, fanoutMs: 0, synthesisStartAtMs: 0,
  });
  expect(find(run.recorded, 'synthesis-started')?.data).toMatchObject({ forced: false });
  expect(run.result.finalText).toContain('Synthesized answer');
});

test('the turn budget is injectable: researchTurnBudgetMs replaces the default', async () => {
  const injected = RESERVE * 2; // 출처: test fixture — an injected budget: twice the reserve leaves a research phase equal to the reserve
  const run = await runBudgetTurn('fast', { researchTurnBudgetMs: injected });
  expect(find(run.recorded, 'research-budget-split')?.data).toMatchObject({
    turnDeadlineMs: injected, reservationMs: RESERVE, researchDeadlineMs: injected - RESERVE,
  });
});
