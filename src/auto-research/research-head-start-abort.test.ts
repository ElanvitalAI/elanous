// #38331 follow-up (GROUNDING-FIRST-ANSWER-30S) — a head-start search (q0 on the fast path, or the first plan question on a
// confirmation-gated turn) can outlive its turn: runResearchQuestionLadder's `finally` aborts it with
// Error('research turn settled'). Before this fix the production searcher (research/axis-fanout.ts lazy probe) started its
// provider probe and THEN threw on the already-aborted signal, leaving the probe's rejection with no handler — the
// «Unhandled error: research turn settled» seen in the chat test. Every cell below goes through the outermost entry
// (runResearchQuestionLadder) with a fake search and a fake deadline clock (createDeadlineSignal) — no provider, no network.
//
// Case table (rule 9 · one test per cell): which promise × when it stops × how it ends.
//   when ∈ running (not stopped) · turn-settled (plan failed, turn returned) · caller-aborted · deadline (fake clock)
//   ends ∈ result · real-error · abort-error (running: an abort-SHAPED provider error, not a stop)
//   stopped × result | abort-error → `head-start-aborted` {target, reason, phase} · no failure event
//   stopped × real-error            → `*-search-failed` level error · code · afterStop = reason (never hidden)
//   running × result                → settled event · evidence merged (normal path unchanged)
//   running × real-error | abort    → `*-search-failed` level error · code · afterStop null
//   + production searcher × turn-settled (root cause) for both promises · + privacy (localOnly · duplicate route)
//   review r2 cells (both promises · one test each):
//   stop SEQUENCES (MF2) settled→caller · caller→settled · deadline→settled → `head-start-aborted` records the FIRST stop
//   observer throws (MF1) started · settled · aborted · failed → one `head-start-observer-failed` {observer} · turn goes on
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { ResearchRouteFields } from '../core-turn/research-route.js';
import { invokeResearchAxes } from '../research-bridge/invoke.js';
import { createResearchAxisSearcher } from '../research/axis-fanout.js';
import { routeResearchOutput } from '../research/output-router.js';
import { addWebSearchProvider, _resetWebSearchProvidersForTests } from '../web-search/index.js';
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from './question-ladder-contract.js';
import {
  ORIGINAL_QUESTION_AXIS_ID, runResearchQuestionLadder,
  type HeadStartStopReason, type ResearchQuestionLadderRunOptions,
} from './research-turn.js';

type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;
type GeneratePreparation = NonNullable<ResearchQuestionLadderRunOptions['generatePreparation']>;
type AxisResult = Awaited<ReturnType<InvokeAxes>>;
/** Wire value pinned here on purpose: alerts match this code string, so renaming it is a contract change. */
const HEAD_START_FAILED_CODE = 'RESEARCH_HEAD_START_FAILED';

const request = '이번 주 어느 리조트의 시즌권 가격은 공식 자료에서 어떻게 확인되나요? URL 을 인용해 주세요.';
const FACT: ResearchRouteFields = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public fact' };
const LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local file' };
const outputContract = {
  deliverable: 'A sourced answer', format: 'Short memo',
  sections: [{ id: 'facts', title: 'Facts', purpose: 'State the supported facts.' }],
  completionCriteria: ['Every claim is supported or marked uncertain.'],
};
const questions: BloomResearchQuestion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`, level: (index + 1) as BloomResearchQuestion['level'], prompt: `Question ${index + 1}`,
  searchTerms: [`plan term ${index + 1}`], sectionId: 'facts',
}));
const planJson = (route: ResearchRouteFields | undefined): string => JSON.stringify({ ...(route ? { route } : {}), outputContract, questions });
const HEAD_START_URL = 'https://example.org/head-start';
const envelope = (questionId: string, source = `https://example.org/${questionId}`): ResearchEvidenceEnvelope => ({
  questionId, sourceKind: 'web-search:test', source, observedAt: '2026-11-18T00:00:00.000Z',
  content: `Evidence for ${questionId}`, outcome: 'complete', truncated: true,
});
const resultFor = (axes: readonly BloomResearchQuestion[], source?: string): AxisResult => ({
  plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
  axes: axes.map((axis) => ({ questionId: axis.id, evidence: [envelope(axis.id, source)] })),
});

type Logged = { event: string; data: Record<string, unknown>; level?: string };
let logged: Logged[] = [];
let unhandled: unknown[] = [];
let fetchCalls = 0;
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
beforeEach(() => {
  logged = [];
  unhandled = [];
  fetchCalls = 0;
  process.on('unhandledRejection', onUnhandled);
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown, opts?: { level?: string }) => {
    if (category === 'research.turn') logged.push({ event, data: (data ?? {}) as Record<string, unknown>, ...(opts?.level ? { level: opts.level } : {}) });
  }) as typeof debug.log);
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    fetchCalls += 1;
    throw new Error('network is not allowed in this test');
  }) as unknown as typeof fetch);
  _resetWebSearchProvidersForTests(false);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  _resetWebSearchProvidersForTests();
  mock.restore();
});

async function flush(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round++) await new Promise<void>((resolve) => setImmediate(resolve));
}
const named = (event: string): Logged[] => logged.filter((entry) => entry.event === event);
const aborted = () => named('head-start-aborted').map((entry) => entry.data);
const failedEvent = (target: Target): string => target === 'original-question' ? 'original-question-search-failed' : 'early-axis-search-failed';

type Target = 'original-question' | 'early-axis';
type When = 'running' | HeadStartStopReason;
type Ends = 'result' | 'real-error' | 'abort-error';

/** Plan for one cell: running → a valid plan; turn-settled → a plan that fails to parse (the turn returns, then its
 * `finally` aborts the head start); caller-aborted / deadline → the caller's signal / the fake clock fires, then the plan. */
function harness(target: Target, when: When) {
  const caller = new AbortController();
  const clock = new AbortController();
  let release!: () => void;
  const turnSettled = new Promise<void>((resolve) => { release = resolve; });
  const plan = planJson(FACT);
  const final = when === 'turn-settled' ? 'not json' : plan;
  const generatePreparation: GeneratePreparation = async (_prompt, _signal, onChunk) => {
    // The early head start acts only on a CLOSED streamed plan root (#38166 review r2).
    if (target === 'early-axis') { onChunk?.(plan); await flush(); }
    if (when === 'caller-aborted') caller.abort(new Error('caller cancelled'));
    if (when === 'deadline') clock.abort(new DOMException('research turn deadline', 'TimeoutError'));
    return final;
  };
  const options = (invokeAxes: InvokeAxes): ResearchQuestionLadderRunOptions => ({
    originalQuestionSearch: true, onPartialGrounding: () => {},
    ...(target === 'early-axis' ? { requireConfirmedRoute: true } : {}),
    ...(when === 'caller-aborted' ? { signal: caller.signal } : {}),
    createDeadlineSignal: () => clock.signal,
    invokeAxes, generatePreparation, enableResearchFanout: false, allowOutputSkill: false,
    routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
  });
  /** Waits until the head start may end: at once while running, after the turn returned, or on its own abort. */
  const waitForStop = async (signal: AbortSignal | undefined): Promise<void> => {
    if (when === 'running') return;
    if (when === 'turn-settled') { await turnSettled; return; }
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
  };
  const run = async (invokeAxes: InvokeAxes) => {
    const result = await runResearchQuestionLadder(request, options(invokeAxes));
    release();
    return result;
  };
  return { run, waitForStop };
}

/** Fake search: the FIRST call is the head start (q0 starts before the plan; the early axis at root close). */
function cellSearch(target: Target, when: When, ends: Ends, waitForStop: (signal?: AbortSignal) => Promise<void>) {
  let calls = 0;
  let headStartDone!: () => void;
  const done = new Promise<void>((resolve) => { headStartDone = resolve; });
  const invokeAxes: InvokeAxes = async (axes, signal) => {
    calls += 1;
    if (calls > 1) return resultFor(axes);
    try {
      expect(axes[0]!.id).toBe(target === 'original-question' ? ORIGINAL_QUESTION_AXIS_ID : questions[0]!.id);
      await waitForStop(signal);
      if (ends === 'real-error') throw new Error('provider down for plan term 1 at https://secret.example/key');
      if (ends === 'abort-error') {
        // A stopped head start rejects with its stop reason; a running one can only meet an abort-SHAPED provider error.
        throw when === 'running' ? Object.assign(new Error('provider timed out'), { name: 'TimeoutError' }) : signal!.reason;
      }
      return resultFor(axes, HEAD_START_URL);
    } finally {
      headStartDone();
    }
  };
  return { invokeAxes, done };
}

const cells: Array<[Target, When, Ends]> = [];
for (const target of ['original-question', 'early-axis'] as const) {
  for (const when of ['running', 'turn-settled', 'caller-aborted', 'deadline'] as const) {
    for (const ends of ['result', 'real-error', 'abort-error'] as const) cells.push([target, when, ends]);
  }
}

for (const [target, when, ends] of cells) {
  test(`cell · ${target} × ${when} × ${ends}`, async () => {
    const { run, waitForStop } = harness(target, when);
    const { invokeAxes, done } = cellSearch(target, when, ends, waitForStop);
    const result = await run(invokeAxes);
    await done;
    await flush();
    expect(unhandled).toEqual([]);
    expect(fetchCalls).toBe(0);
    const failures = named(failedEvent(target));
    if (when !== 'running' && ends !== 'real-error') {
      // Expected stop: swallowed, observed once, never a warning or an error.
      expect(aborted()).toEqual([expect.objectContaining({ target, reason: when, phase: ends === 'result' ? 'result' : 'error' })]);
      expect(failures).toEqual([]);
      expect(named(target === 'original-question' ? 'original-question-search-settled' : 'early-axis-search-settled')).toEqual([]);
      return;
    }
    expect(aborted()).toEqual([]);
    if (ends === 'result') {
      // Normal path unchanged: settled once, the head-start evidence is merged into the answer's ladder.
      expect(failures).toEqual([]);
      expect(named(target === 'original-question' ? 'original-question-search-settled' : 'early-axis-search-settled').length).toBe(1);
      expect(result.ladder.evidence.some((item) => item.source === HEAD_START_URL)).toBe(true);
      expect(result.output).not.toBe('');
      return;
    }
    // A real failure is never hidden: one error-level event with a code, value-free (no query, no URL).
    expect(failures.map((entry) => entry.level)).toEqual(['error']);
    expect(failures[0]!.data).toEqual(expect.objectContaining({
      target, code: HEAD_START_FAILED_CODE,
      reason: ends === 'real-error' ? 'search-error' : 'TimeoutError',
      afterStop: when === 'running' ? null : when,
    }));
    expect(JSON.stringify(failures)).not.toContain('secret.example');
    expect(JSON.stringify(failures)).not.toContain('plan term 1');
  });
}

// ── Root cause: the PRODUCTION searcher reached after the turn settled (both head starts · symmetry) ──
for (const target of ['original-question', 'early-axis'] as const) {
  test(`root cause · ${target} reaching the production searcher after the turn settled leaves no unhandled rejection`, async () => {
    let providerCalls = 0;
    addWebSearchProvider({
      id: 'ddg', displayName: 'fake ddg', available: () => true,
      search: async () => { providerCalls += 1; return { providerName: 'fake ddg', durationMs: 1, hits: [] }; },
    });
    const { run, waitForStop } = harness(target, 'turn-settled');
    let searched!: () => void;
    const settled = new Promise<void>((resolve) => { searched = resolve; });
    const invokeAxes: InvokeAxes = async (axes, signal, admitToolCall, onAxisEvidence) => {
      await waitForStop(signal);
      try {
        // The real entry (research-bridge → axis-fanout → lazy searcher): only the moment it is reached is controlled.
        return await invokeResearchAxes(axes, { ...(signal ? { signal } : {}), ...(admitToolCall ? { admitToolCall } : {}),
          ...(onAxisEvidence ? { onAxisEvidence } : {}) });
      } finally {
        searched();
      }
    };
    const result = await run(invokeAxes);
    await settled;
    await flush();
    expect(unhandled).toEqual([]);
    expect(result.ok).toBe(false);
    expect(providerCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(aborted()).toEqual([expect.objectContaining({ target, reason: 'turn-settled', phase: 'result' })]);
  });
}

test('root cause · the lazy searcher rejects an already-aborted call before probing; no orphaned probe', async () => {
  const stop = new AbortController();
  stop.abort(new Error('research turn settled'));
  const search = createResearchAxisSearcher();
  await expect(search('plan term 1', stop.signal)).rejects.toThrow('research turn settled');
  await flush();
  expect(unhandled).toEqual([]);
  expect(fetchCalls).toBe(0);
});

// ── Privacy contracts still hold (#38112 · #38166) ──
test('privacy · a localOnly route sends zero external calls and starts no head start', async () => {
  let calls = 0;
  const invokeAxes: InvokeAxes = async (axes) => { calls += 1; return resultFor(axes); };
  const plan = planJson(LOCAL);
  const result = await runResearchQuestionLadder(request, {
    originalQuestionSearch: true, requireConfirmedRoute: true, onPartialGrounding: () => {},
    createDeadlineSignal: () => new AbortController().signal,
    invokeAxes, generatePreparation: async (_prompt, _signal, onChunk) => { onChunk?.(plan); await flush(); return plan; },
    enableResearchFanout: false, allowOutputSkill: false,
    routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
  });
  await flush();
  expect(calls).toBe(0);
  expect(fetchCalls).toBe(0);
  expect(result.ok).toBe(false);
  expect(named('early-axis-search-started')).toEqual([]);
  expect(aborted()).toEqual([]);
  expect(unhandled).toEqual([]);
});

test('privacy · a duplicate top-level route confirms nothing: zero external calls either order', async () => {
  for (const [first, last] of [[FACT, LOCAL], [LOCAL, FACT]] as const) {
    logged = [];
    let calls = 0;
    const invokeAxes: InvokeAxes = async (axes) => { calls += 1; return resultFor(axes); };
    const plan = `${planJson(first).slice(0, -1)},"route":${JSON.stringify(last)}}`;
    const result = await runResearchQuestionLadder(request, {
      originalQuestionSearch: true, requireConfirmedRoute: true, onPartialGrounding: () => {},
      createDeadlineSignal: () => new AbortController().signal,
      invokeAxes, generatePreparation: async (_prompt, _signal, onChunk) => { onChunk?.(plan); await flush(); return plan; },
      enableResearchFanout: false, allowOutputSkill: false,
      routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
    });
    await flush();
    expect(calls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(result.ok).toBe(false);
    expect(aborted()).toEqual([]);
  }
  expect(unhandled).toEqual([]);
});

// ── Review r2 MF1 · every head-start observer is guarded: started · settled · aborted · failed (both head starts) ──
const observerCells: Array<{ observer: 'started' | 'settled' | 'aborted' | 'failed'; when: When; ends: Ends }> = [
  { observer: 'started', when: 'running', ends: 'result' },
  { observer: 'settled', when: 'running', ends: 'result' },
  { observer: 'aborted', when: 'turn-settled', ends: 'result' },
  { observer: 'failed', when: 'turn-settled', ends: 'real-error' },
];
const observerEvent = (target: Target, observer: string): string => observer === 'aborted' ? 'head-start-aborted'
  : `${target === 'original-question' ? 'original-question-search' : 'early-axis-search'}-${observer}`;
for (const target of ['original-question', 'early-axis'] as const) {
  for (const { observer, when, ends } of observerCells) {
    test(`observer failure · ${target} × ${observer}: a throwing log sink is one observer-failed event; the turn goes on`, async () => {
      mock.restore();
      spyOn(globalThis, 'fetch').mockImplementation((async () => {
        fetchCalls += 1;
        throw new Error('network is not allowed in this test');
      }) as unknown as typeof fetch);
      spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown, opts?: { level?: string }) => {
        if (category !== 'research.turn') return;
        if (event === observerEvent(target, observer)) throw new Error('log sink down');
        logged.push({ event, data: (data ?? {}) as Record<string, unknown>, ...(opts?.level ? { level: opts.level } : {}) });
      }) as typeof debug.log);
      const { run, waitForStop } = harness(target, when);
      const { invokeAxes, done } = cellSearch(target, when, ends, waitForStop);
      const result = await run(invokeAxes);
      await done;
      await flush();
      expect(unhandled).toEqual([]);
      const observed = named('head-start-observer-failed');
      expect(observed.map((entry) => entry.level)).toEqual(['error']);
      expect(observed[0]!.data).toEqual(expect.objectContaining({ target, observer, code: HEAD_START_FAILED_CODE, reason: 'search-error' }));
      if (when === 'running') {
        // The search and the turn are untouched by the failed observer: evidence merged, an answer produced.
        expect(result.ladder.evidence.some((item) => item.source === HEAD_START_URL)).toBe(true);
        expect(result.output).not.toBe('');
      }
    });
  }
}

// ── Review r2 MF2 · consecutive stops: the FIRST stop that fired is recorded, whatever fires after it ──
type Sequence = [HeadStartStopReason, HeadStartStopReason];
const sequences: Sequence[] = [['turn-settled', 'caller-aborted'], ['caller-aborted', 'turn-settled'], ['deadline', 'turn-settled']];
for (const target of ['original-question', 'early-axis'] as const) {
  for (const [first, then] of sequences) {
    test(`stop sequence · ${target}: ${first} then ${then} records ${first}`, async () => {
      const caller = new AbortController();
      const clock = new AbortController();
      const plan = planJson(FACT);
      let release!: () => void;
      const late = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      const invokeAxes: InvokeAxes = async (axes) => {
        calls += 1;
        if (calls === 1) await late; // the head start answers only after BOTH stops fired
        return resultFor(axes, HEAD_START_URL);
      };
      const result = await runResearchQuestionLadder(request, {
        originalQuestionSearch: true, onPartialGrounding: () => {},
        ...(target === 'early-axis' ? { requireConfirmedRoute: true } : {}),
        signal: caller.signal, createDeadlineSignal: () => clock.signal,
        invokeAxes, enableResearchFanout: false, allowOutputSkill: false,
        routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
        generatePreparation: async (_prompt, _signal, onChunk) => {
          if (target === 'early-axis') { onChunk?.(plan); await flush(); }
          if (first === 'caller-aborted') caller.abort(new Error('caller cancelled'));
          if (first === 'deadline') clock.abort(new DOMException('research turn deadline', 'TimeoutError'));
          return first === 'turn-settled' ? 'not json' : plan;
        },
      });
      // The turn has returned: its settle abort already fired. A later caller abort must not relabel the stop.
      if (then === 'caller-aborted') caller.abort(new Error('caller cancelled late'));
      release();
      await flush();
      expect(result.ok).toBe(false);
      expect(unhandled).toEqual([]);
      expect(fetchCalls).toBe(0);
      expect(aborted()).toEqual([expect.objectContaining({ target, reason: first, phase: 'result' })]);
    });
  }
}
