/** OP #113993 (RES WEBCHAT-A2DF-MK-113947: all angles cut at the 25 s deadline, completeCount=0/3): when nothing completed
 * at the deadline, wait for the FASTEST single angle only, never beyond the grace. Ordering is asserted from recorded events and
 * structural timing values; there are no numeric bounds. */
import { expect, test } from 'bun:test';
import {
  RESEARCH_FANOUT_FIRST_RESULT_GRACE_MS, runResearchFanout, type ResearchFanoutWorker,
} from './research-fanout.js';

const good = (angleId: string) => ({ text: `Finding for ${angleId}`, sources: [{ url: `https://${angleId}.example/doc` }] });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const untilAborted = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const DEADLINE = 10;
const LONG_GRACE = 60_000;

test('the grace is a named code default', () => {
  expect(typeof RESEARCH_FANOUT_FIRST_RESULT_GRACE_MS).toBe('number');
});

test('every angle past the deadline: the first one to complete in the grace is kept, the others are cut at that moment', async () => {
  const events: string[] = [];
  const worker: ResearchFanoutWorker = async (angle, _request, signal) => {
    if (angle.id === 'primary-data') {
      await sleep(DEADLINE * 4);
      events.push('complete:primary-data');
      return good(angle.id);
    }
    signal?.addEventListener('abort', () => events.push(`aborted:${angle.id}`), { once: true });
    return untilAborted(signal);
  };
  const result = await runResearchFanout('question', worker, { angleDeadlineMs: DEADLINE, firstResultGraceMs: LONG_GRACE });
  expect(result.angles.map(({ status }) => status)).toEqual(['complete', 'failed', 'failed']);
  expect(result.angles.map(({ angle, timing }) => [angle.id, timing])).toEqual([
    ['primary-data', 'grace-late'], ['news-filings', 'angle-deadline'], ['counterevidence', 'angle-deadline'],
  ]);
  expect(events).toEqual(['complete:primary-data', 'aborted:news-filings', 'aborted:counterevidence']);
  expect(result.output).toContain('Finding for primary-data');
});

test('nothing completes inside the grace: every angle is cut with angle-deadline and the fanout ends', async () => {
  const worker: ResearchFanoutWorker = async (_angle, _request, signal) => untilAborted(signal);
  const result = await runResearchFanout('question', worker, { angleDeadlineMs: DEADLINE, firstResultGraceMs: DEADLINE });
  expect(result.angles.map(({ status, error, timing }) => [status, error, timing])).toEqual([
    ['failed', 'angle-deadline', 'angle-deadline'], ['failed', 'angle-deadline', 'angle-deadline'], ['failed', 'angle-deadline', 'angle-deadline'],
  ]);
});

test('an angle that completed before the deadline means no grace: the rest are cut at the deadline', async () => {
  const worker: ResearchFanoutWorker = async (angle, _request, signal) => (angle.id === 'counterevidence' ? good(angle.id) : untilAborted(signal));
  // A huge grace would hang this test if it were (wrongly) opened.
  const result = await runResearchFanout('question', worker, { angleDeadlineMs: DEADLINE, firstResultGraceMs: LONG_GRACE });
  expect(result.angles.map(({ status, timing }) => [status, timing])).toEqual([
    ['failed', 'angle-deadline'], ['failed', 'angle-deadline'], ['complete', undefined],
  ]);
});

test('every angle completing in time carries no timing mark', async () => {
  const worker: ResearchFanoutWorker = async angle => good(angle.id);
  const result = await runResearchFanout('question', worker, { angleDeadlineMs: LONG_GRACE, firstResultGraceMs: LONG_GRACE });
  expect(result.angles.map(({ timing }) => timing)).toEqual([undefined, undefined, undefined]);
});

test('an angle that returns without sources after the deadline does not end the grace', async () => {
  const events: string[] = [];
  const worker: ResearchFanoutWorker = async (angle, _request, signal) => {
    if (angle.id === 'primary-data') { await sleep(DEADLINE * 3); events.push('empty:primary-data'); return { text: 'no sources', sources: [] }; }
    if (angle.id === 'news-filings') { await sleep(DEADLINE * 8); events.push('complete:news-filings'); return good(angle.id); }
    return untilAborted(signal);
  };
  const result = await runResearchFanout('question', worker, { angleDeadlineMs: DEADLINE, firstResultGraceMs: LONG_GRACE });
  expect(events).toEqual(['empty:primary-data', 'complete:news-filings']);
  expect(result.angles.map(({ status, timing }) => [status, timing])).toEqual([
    ['failed', undefined], ['complete', 'grace-late'], ['failed', 'angle-deadline'],
  ]);
});
