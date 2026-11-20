/** OP #114563 (RES 61266 timeline: fanout ran 40 s with 0 complete after the axes were done): the fanout is supplementary.
 * After the axes settle the ladder waits at most the post-axes grace, then cuts the running angles ('post-axes-grace').
 * Ordering is asserted from recorded events; deadlines are injected (a few ms). */
import { expect, test } from 'bun:test';
import {
  RESEARCH_FANOUT_POST_AXES_GRACE_MS, RESEARCH_FANOUT_POST_AXES_GRACE_REASON, type ResearchFanoutWorker,
} from './research-fanout.js';
import { runResearchQuestionLadder, type ResearchQuestionLadderRunOptions } from './research-turn.js';
import { routeResearchOutput } from '../research/output-router.js';

const good = (angleId: string) => ({ text: `Finding for ${angleId}`, sources: [{ url: `https://${angleId}.example/doc` }] });
const untilAborted = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});
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
type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;

function world(worker: ResearchFanoutWorker, graceMs: number, finishAxesBeforeFanout = false) {
  const events: string[] = [];
  const invokeAxes: InvokeAxes = async (axes) => {
    if (finishAxesBeforeFanout) await new Promise<void>((resolve) => setTimeout(resolve, 60));
    events.push('axes-finished');
    return { plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: [] })) };
  };
  const options: ResearchQuestionLadderRunOptions = {
    requireConfirmedRoute: true, onPartialGrounding: () => {}, allowOutputSkill: false,
    routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
    generatePreparation: async () => PLAN, invokeAxes,
    enableResearchFanout: true,
    researchFanoutWorker: async (angle, request, signal) => { events.push(`worker-started:${angle.id}`); return worker(angle, request, signal); },
    researchFanoutAngleDeadlineMs: 60_000,
    researchFanoutPostAxesGraceMs: graceMs,
    onFanoutTrace: (event) => events.push(`trace:${event}`),
  };
  return { events, options };
}

test('the post-axes grace is a named code default with a structured reason', () => {
  expect(typeof RESEARCH_FANOUT_POST_AXES_GRACE_MS).toBe('number');
  expect(RESEARCH_FANOUT_POST_AXES_GRACE_REASON).toBe('post-axes-grace');
});

test('slow fanout + fast axes: the turn returns after axes + grace, running angles marked post-axes-grace, finished ones kept', async () => {
  const { events, options } = world(async (angle, _r, signal) => {
    if (angle.id === 'primary-data') return good(angle.id);
    signal?.addEventListener('abort', () => events.push(`worker-aborted:${angle.id}`), { once: true });
    return untilAborted(signal);
  }, 20, true);
  const result = await runResearchQuestionLadder('Dated public question', options);
  const axesDone = events.indexOf('axes-finished');
  const abortedAfterAxes = events.indexOf('worker-aborted:news-filings') > axesDone;
  expect(abortedAfterAxes).toBe(true);
  expect(events.filter((event) => event.startsWith('worker-aborted'))).toEqual(['worker-aborted:news-filings', 'worker-aborted:counterevidence']);
  expect(result.output).toContain('news-filings) · 중단(시간 제한)');
  expect(result.output).toContain('조사 중단: post-axes-grace');
  expect(result.output).toContain('Finding for primary-data');
});

test('fast fanout: nothing is cut and no angle carries a timing', async () => {
  const { events, options } = world(async (angle) => good(angle.id), 60_000, true);
  const result = await runResearchQuestionLadder('Dated public question', options);
  expect(events.some((event) => event.startsWith('worker-aborted'))).toBe(false);
  expect(result.output).not.toContain('post-axes-grace');
  for (const id of ['primary-data', 'news-filings', 'counterevidence']) expect(result.output).toContain(`Finding for ${id}`);
});

test('fanout done before the axes: unchanged (all angles complete, no cut even with a tiny grace)', async () => {
  const { events, options } = world(async (angle) => good(angle.id), 1, true);
  const result = await runResearchQuestionLadder('Dated public question', options);
  expect(events.indexOf('worker-started:counterevidence') < events.indexOf('axes-finished')).toBe(true);
  expect(result.output).not.toContain('post-axes-grace');
  expect(result.output).toContain('Finding for news-filings');
});

test('no angle completed when the axes settle: the fanout ends at once (OP #114584), however long the grace is', async () => {
  const { events, options } = world(async (angle, _r, signal) => {
    signal?.addEventListener('abort', () => events.push(`worker-aborted:${angle.id}`), { once: true });
    return untilAborted(signal);
  }, 60_000);
  const result = await runResearchQuestionLadder('Dated public question', options);
  const axesDone = events.indexOf('axes-finished');
  expect(events.filter((event) => event.startsWith('worker-aborted')).length === 3).toBe(true);
  expect(events.slice(axesDone + 1).every((event) => event.startsWith('worker-aborted') || event.startsWith('trace:'))).toBe(true);
  expect(result.output).toContain('조사 중단: post-axes-grace');
});
