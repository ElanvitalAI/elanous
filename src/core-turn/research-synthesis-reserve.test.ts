// 1121 SYNTHESIS-RESERVE — research stops at min(research budget, parent deadline − synthesis reservation).
// 출처: RES GROUNDING-MAIN2151-OP81990 — every number below is derived from the policy constants (NUMGUARD).
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import * as llmModule from '../llm.js';
import { debug } from '../debug/log.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import {
  RESEARCH_SYNTHESIS_RESERVATION_MS,
  RESEARCH_TURN_SHALLOW_BUDGET_MS,
  splitResearchBudget,
} from './research-policy.js';
import { runCoreTurn } from './run-core-turn.js';

const tool: LLMToolSpec = {
  name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} },
};
const RESERVE = RESEARCH_SYNTHESIS_RESERVATION_MS;
const BUDGET = RESEARCH_TURN_SHALLOW_BUDGET_MS;
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

test('split: a parent deadline inside the research budget cuts research at deadline − reservation', () => {
  const turnDeadlineMs = BUDGET;
  const split = splitResearchBudget({ researchBudgetMs: BUDGET, turnDeadlineMs, elapsedMs: 0 });
  expect(split).toEqual({ researchDeadlineMs: turnDeadlineMs - RESERVE, reservationMs: RESERVE, limitedBy: 'synthesis-reserve' });
  expect(turnDeadlineMs - split.researchDeadlineMs).toBeGreaterThanOrEqual(RESERVE);
});

test('split: time already spent before research starts is charged against the window, not the reservation', () => {
  const elapsedMs = RESERVE / 2;
  const turnDeadlineMs = BUDGET;
  const split = splitResearchBudget({ researchBudgetMs: BUDGET, turnDeadlineMs, elapsedMs });
  expect(split.researchDeadlineMs).toBe(turnDeadlineMs - elapsedMs - RESERVE);
  expect(turnDeadlineMs - (elapsedMs + split.researchDeadlineMs)).toBe(RESERVE);
});

test('split: a roomy parent deadline keeps the existing research budget', () => {
  const split = splitResearchBudget({ researchBudgetMs: BUDGET, turnDeadlineMs: BUDGET + RESERVE * 2, elapsedMs: 0 });
  expect(split).toEqual({ researchDeadlineMs: BUDGET, reservationMs: RESERVE, limitedBy: 'research-budget' });
});

test('split: unknown parent deadline keeps today\'s research budget', () => {
  expect(splitResearchBudget({ researchBudgetMs: BUDGET, elapsedMs: RESERVE }))
    .toEqual({ researchDeadlineMs: BUDGET, reservationMs: RESERVE, limitedBy: 'research-budget' });
  expect(splitResearchBudget({ researchBudgetMs: BUDGET, turnDeadlineMs: Number.POSITIVE_INFINITY, elapsedMs: 0 }).researchDeadlineMs)
    .toBe(BUDGET);
});

test('split: a tiny or already-spent window never yields a research deadline before research started', () => {
  const tiny = splitResearchBudget({ researchBudgetMs: BUDGET, turnDeadlineMs: RESERVE / 2, elapsedMs: 0 });
  expect(tiny).toEqual({ researchDeadlineMs: 0, reservationMs: RESERVE, limitedBy: 'synthesis-reserve' });
  const spent = splitResearchBudget({ researchBudgetMs: BUDGET, turnDeadlineMs: RESERVE, elapsedMs: RESERVE * 2 });
  expect(spent.researchDeadlineMs).toBe(0);
  const tinyBudget = splitResearchBudget({ researchBudgetMs: RESERVE / 2, turnDeadlineMs: BUDGET, elapsedMs: 0 });
  expect(tinyBudget).toEqual({ researchDeadlineMs: RESERVE / 2, reservationMs: RESERVE, limitedBy: 'research-budget' });
});

test('split: a caller override replaces the default reservation; a negative override counts as none', () => {
  const reservationMs = RESERVE / 3;
  expect(splitResearchBudget({ researchBudgetMs: BUDGET, turnDeadlineMs: BUDGET, elapsedMs: 0, reservationMs }).researchDeadlineMs)
    .toBe(BUDGET - reservationMs);
  expect(splitResearchBudget({ researchBudgetMs: BUDGET, turnDeadlineMs: BUDGET, elapsedMs: 0, reservationMs: -RESERVE }))
    .toEqual({ researchDeadlineMs: BUDGET, reservationMs: 0, limitedBy: 'research-budget' });
});

async function runReserveTurn(turnOptions: { turnDeadlineMs?: number; researchWallClockBudgetMs?: number }) {
  const manual = createManualTimers();
  const startClock = RESERVE;
  let clock = startClock;
  const researchEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const stopEvents: Array<Record<string, unknown>> = [];
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (category === 'research.turn') researchEvents.push({ event, data: data as Record<string, unknown> });
    if (category === 'research.stop') stopEvents.push(data as Record<string, unknown>);
  });
  let startedResearch!: () => void;
  const researchStarted = new Promise<void>(resolve => { startedResearch = resolve; });
  let synthesisClock: number | undefined;
  let synthesisSawEvidence = false;
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      handlers.onText?.('Provisional answer', 'Provisional answer');
      handlers.onTurnComplete?.([{ role: 'assistant', content: 'Provisional answer', phase: 'final_answer' }]);
      return 'Provisional answer';
    }
    synthesisClock = clock;
    synthesisSawEvidence = messages.some(message => message.role === 'user' && typeof message.content === 'string'
      && message.content.includes(PARTIAL_EVIDENCE));
    handlers.onText?.('Synthesized answer', 'Synthesized answer');
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'Synthesized answer', phase: 'final_answer' }]);
    return 'Synthesized answer';
  });
  const pending = runCoreTurn({
    sessionId: 'research-synthesis-reserve',
    messages: [{ role: 'user', content: REQUEST }],
    tools: [tool], dispatchTool: async () => null, signal: new AbortController().signal, userText: REQUEST,
  }, {
    now: () => clock,
    timers: manual.timers,
    ...turnOptions,
    runResearch: (_request, researchSignal) => {
      startedResearch();
      return new Promise(resolve => researchSignal.addEventListener('abort', () => resolve({
        ok: false, output: PARTIAL_EVIDENCE, error: 'research stopped by its deadline',
      }), { once: true }));
    },
  });
  await researchStarted;
  const split = researchEvents.find(item => item.event === 'research-budget-split')?.data;
  const researchDeadlineMs = split?.researchDeadlineMs as number;
  await manual.waitFor(researchDeadlineMs);
  clock = startClock + researchDeadlineMs;
  manual.fire(researchDeadlineMs);
  const result = await pending;
  return { result, split, stopEvents, startClock, synthesisClock, synthesisSawEvidence, modelCalls };
}

test('turn: fanout stops at parent deadline − reservation and synthesis keeps the reservation with the evidence', async () => {
  const turnDeadlineMs = BUDGET;
  const run = await runReserveTurn({ turnDeadlineMs, researchWallClockBudgetMs: BUDGET });

  expect(run.split).toMatchObject({
    turnDeadlineMs, reservationMs: RESERVE, researchBudgetMs: BUDGET,
    researchDeadlineMs: turnDeadlineMs - RESERVE, limitedBy: 'synthesis-reserve',
  });
  expect(run.stopEvents.find(event => event.reason === 'wall-clock-budget'))
    .toMatchObject({ limitMs: turnDeadlineMs - RESERVE, limitedBy: 'synthesis-reserve' });
  expect(run.stopEvents.map(event => event.reason)).toContain('forced-synthesis');
  expect(run.modelCalls).toBe(2);
  expect(run.synthesisSawEvidence).toBe(true);
  expect(turnDeadlineMs - ((run.synthesisClock as number) - run.startClock)).toBeGreaterThanOrEqual(RESERVE);
  expect(run.result.finalText).toContain('Synthesized answer');
});

test('turn: the default (deep) research budget is also cut by a parent deadline inside it', async () => {
  const turnDeadlineMs = BUDGET;
  const run = await runReserveTurn({ turnDeadlineMs });

  expect(run.split).toMatchObject({
    turnDeadlineMs, reservationMs: RESERVE, researchDeadlineMs: turnDeadlineMs - RESERVE, limitedBy: 'synthesis-reserve',
  });
  expect(run.split?.researchBudgetMs as number).toBeGreaterThan(turnDeadlineMs - RESERVE);
  expect(turnDeadlineMs - ((run.synthesisClock as number) - run.startClock)).toBeGreaterThanOrEqual(RESERVE);
});

test('turn: unknown parent deadline keeps the configured research budget and logs no reservation', async () => {
  const researchWallClockBudgetMs = RESERVE;
  const run = await runReserveTurn({ researchWallClockBudgetMs });

  expect(run.split).toMatchObject({
    turnDeadlineMs: null, reservationMs: null, researchBudgetMs: researchWallClockBudgetMs,
    researchDeadlineMs: researchWallClockBudgetMs, limitedBy: 'research-budget',
  });
  expect(run.stopEvents.find(event => event.reason === 'wall-clock-budget'))
    .toMatchObject({ limitMs: researchWallClockBudgetMs, limitedBy: 'research-budget' });
  expect(run.result.finalText).toContain('Synthesized answer');
});
