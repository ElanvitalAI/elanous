/** OP #113782 (real-pin 86.1 s RED): per-angle deadline + fanout starts in parallel with the axis search.
 * Deterministic: fake workers/axes, deadlines of a few ms, ordering asserted from recorded events (no numeric bounds). */
import { expect, test } from 'bun:test';
import {
  RESEARCH_FANOUT_ANGLE_DEADLINE_MS, RESEARCH_FANOUT_ANGLE_DEADLINE_REASON,
  runResearchFanout, type ResearchFanoutWorker,
} from './research-fanout.js';
import { runResearchQuestionLadder, type ResearchQuestionLadderRunOptions } from './research-turn.js';
import { routeResearchOutput } from '../research/output-router.js';

const goodAnswer = (angleId: string) => ({ text: `Finding for ${angleId}`, sources: [{ url: `https://${angleId}.example/doc` }] });
const neverUntilAborted = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('the code default angle deadline is 25 s (not the old 90 s)', () => {
  expect(RESEARCH_FANOUT_ANGLE_DEADLINE_MS).toBe(25_000);
  expect(RESEARCH_FANOUT_ANGLE_DEADLINE_REASON).toBe('angle-deadline');
});

test('(a) a slow angle is aborted at its deadline: failed with reason angle-deadline, the other two complete', async () => {
  const aborted: string[] = [];
  const worker: ResearchFanoutWorker = async (angle, _request, signal) => {
    if (angle.id !== 'news-filings') return goodAnswer(angle.id);
    signal?.addEventListener('abort', () => aborted.push(angle.id), { once: true });
    return neverUntilAborted(signal);
  };
  const result = await runResearchFanout('question', worker, { angleDeadlineMs: 15 });
  expect(result.angles.map(({ status }) => status)).toEqual(['complete', 'failed', 'complete']);
  const failed = result.angles.filter(({ status }) => status === 'failed');
  expect(failed.map(({ angle, error }) => [angle.id, error])).toEqual([['news-filings', 'angle-deadline']]);
  expect(aborted).toEqual(['news-filings']);
  expect(result.output).toContain('### 뉴스·공시 (news-filings) · 중단(시간 제한)');
  expect(result.output).toContain('조사 중단: angle-deadline');
  expect(result.output).toContain('Finding for primary-data');
  expect(result.output).toContain('Finding for counterevidence');
});

test('(a) a worker that ignores the abort signal still cannot hold the fanout past the deadline', async () => {
  const worker: ResearchFanoutWorker = async (angle) => angle.id === 'primary-data'
    ? new Promise<never>(() => {}) : goodAnswer(angle.id);
  const result = await runResearchFanout('question', worker, { angleDeadlineMs: 15 });
  expect(result.angles.map(({ status, error }) => [status, error ?? null])).toEqual([
    ['failed', 'angle-deadline'], ['complete', null], ['complete', null],
  ]);
});

// ── research-turn level ──
const PLAN = JSON.stringify({
  route: { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public fact' },
  outputContract: {
    deliverable: 'Memo', format: 'Short memo',
    sections: [{ id: 'facts', title: 'Facts', purpose: 'State facts.' }],
    completionCriteria: ['Every claim is supported or marked uncertain.'],
  },
  questions: Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`, level: index + 1, sectionId: 'facts',
    prompt: `plan question ${index + 1}`, searchTerms: [`plan term ${index + 1}`],
  })),
});
const LOCAL_PLAN = JSON.stringify({ ...JSON.parse(PLAN), route: { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local' } });
type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;
const until = async (condition: () => boolean): Promise<void> => {
  while (!condition()) await new Promise<void>((resolve) => setImmediate(resolve));
};
function world(plan: string) {
  const events: string[] = [];
  const invokeAxes: InvokeAxes = async (axes) => {
    events.push('axes-started');
    // Axes can only finish once the fanout workers are running: serial order would never get here (red = hang).
    await until(() => events.includes('worker-started:news-filings'));
    events.push('axes-finished');
    return { plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [] })) };
  };
  const worker: ResearchFanoutWorker = async (angle, _request, signal) => {
    events.push(`worker-started:${angle.id}`);
    if (angle.id !== 'news-filings') return goodAnswer(angle.id);
    signal?.addEventListener('abort', () => events.push('worker-aborted:news-filings'), { once: true });
    return neverUntilAborted(signal);
  };
  const options: ResearchQuestionLadderRunOptions = {
    requireConfirmedRoute: true, onPartialGrounding: () => {}, allowOutputSkill: false,
    routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
    generatePreparation: async () => plan, invokeAxes,
    enableResearchFanout: true, researchFanoutWorker: worker, researchFanoutAngleDeadlineMs: 20,
    onFanoutTrace: (event) => events.push(`trace:${event}`),
  };
  return { events, options };
}

test('(b) fanout starts before the axes settle; the turn waits only for the fanout deadline, then synthesizes', async () => {
  const { events, options } = world(PLAN);
  const result = await runResearchQuestionLadder('Dated public question', options);
  const index = (name: string) => events.indexOf(name);
  const fanoutStartedBeforeAxesSettled = index('trace:fanout-started') !== -1 && index('trace:fanout-started') < index('axes-finished');
  const axesStartedAfterFanoutStarted = index('trace:fanout-started') < index('axes-started');
  const slowAngleAbortedAfterAxesFinished = index('axes-finished') < index('worker-aborted:news-filings');
  expect(fanoutStartedBeforeAxesSettled).toBe(true);
  expect(axesStartedAfterFanoutStarted).toBe(true);
  expect(slowAngleAbortedAfterAxesFinished).toBe(true);
  expect(events.filter((event) => event.startsWith('trace:'))).toEqual(['trace:fanout-started', 'trace:axes-settled']);
  // Turn result exists and carries the structured deadline stop plus the completed angles.
  expect(result.output).toContain('## Parallel research angles');
  expect(result.output).toContain('news-filings) · 중단(시간 제한)');
  expect(result.output).toContain('Finding for primary-data');
});

test('(c) unconfirmed route (plan says localOnly): the fanout is never started', async () => {
  const { events, options } = world(LOCAL_PLAN);
  await runResearchQuestionLadder('Dated public question', options);
  expect(events).toEqual([]);
});

test('(c) route missing from the plan: fanout is never started', async () => {
  const { route: _route, ...noRoute } = JSON.parse(PLAN);
  const { events, options } = world(JSON.stringify(noRoute));
  await runResearchQuestionLadder('Dated public question', options);
  expect(events).toEqual([]);
});
