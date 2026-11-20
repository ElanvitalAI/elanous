/** OP #114412 RESEARCH-LATENCY-BUDGET — axis phase: per-fetch cap and the research-phase deadline. Deterministic: the only
 * real waits are tens of ms; assertions are exact structured values (no numeric bounds). */
import { expect, test } from 'bun:test';
import { AXIS_FETCH_CAP_REASON, AXIS_RESEARCH_DEADLINE_REASON, fanOutAxisEvidence, RESEARCH_AXIS_FETCH_CAP_MS } from './axis-fanout.js';
import type { BloomResearchQuestion } from '../auto-research/question-ladder-contract.js';

const axes = [
  { id: 'a1', level: 1, prompt: 'first axis', searchTerms: ['first query'] },
  { id: 'a2', level: 1, prompt: 'second axis', searchTerms: ['second query'] },
  { id: 'a3', level: 3, prompt: 'third axis', searchTerms: ['third query'] },
] as BloomResearchQuestion[];
const hit = (id: string) => [{ url: `https://example.org/${id}`, title: id, snippet: `snippet ${id}` }];
const untilAborted = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});
// 출처: test fixture — a tiny cap so the capped fetch ends in tens of ms of real time (the production default is the named constant).
const TINY_CAP_MS = 15;

test('the per-fetch cap is a named code default', () => {
  expect(typeof RESEARCH_AXIS_FETCH_CAP_MS).toBe('number');
});

test('(b) a slow fetch on one axis is capped and recorded as failed evidence fetch-cap; the other axes complete', async () => {
  const fetchPage = async (url: string, _question: BloomResearchQuestion, signal?: AbortSignal) => {
    if (url.endsWith('/a2')) return untilAborted(signal); // never answers on its own: only the cap can end it
    return { url, output: `page body ${url}` };
  };
  const result = await fanOutAxisEvidence(axes, {
    search: async query => hit(axes.find(axis => axis.searchTerms[0] === query)!.id),
    fetchPage,
    fetchCapMs: TINY_CAP_MS,
  });
  const summary = result.axes.map(axis => ({
    id: axis.questionId,
    fetch: axis.evidence.filter(item => item.sourceKind === 'web-fetch').map(item => [item.outcome, item.failureReason ?? null]),
    search: axis.evidence.filter(item => item.sourceKind.startsWith('web-search')).map(item => item.outcome),
  }));
  expect(summary).toEqual([
    { id: 'a1', fetch: [['complete', null]], search: ['complete'] },
    { id: 'a2', fetch: [['failed', AXIS_FETCH_CAP_REASON]], search: ['complete'] },
    { id: 'a3', fetch: [['complete', null]], search: ['complete'] },
  ]);
  const failed = result.axes[1]!.evidence.find(item => item.failureReason === AXIS_FETCH_CAP_REASON)!;
  expect(failed.source).toBe('https://example.org/a2');
  expect(failed.truncated).toBe(false);
});

test('(a) the research-phase deadline ends collection: settled axes keep their evidence, the hung axis is failed evidence research-deadline', async () => {
  const controller = new AbortController();
  const search = async (query: string, signal?: AbortSignal) => {
    if (query === 'second query') return untilAborted(signal); // a searcher that never resolves until aborted
    return hit(axes.find(axis => axis.searchTerms[0] === query)!.id);
  };
  const pending = fanOutAxisEvidence(axes, { search, signal: controller.signal });
  // Let the two fast axes settle, then fire the research-phase deadline.
  await new Promise<void>(resolve => setTimeout(resolve, TINY_CAP_MS));
  controller.abort(new Error('Research wall-clock budget reached'));
  const result = await pending;
  expect(result.axes.map(axis => [axis.questionId, axis.evidence.map(item => item.outcome)])).toEqual([
    ['a1', ['complete']],
    ['a2', ['failed']],
    ['a3', ['complete']],
  ]);
  expect(result.axes[1]!.error).toContain(AXIS_RESEARCH_DEADLINE_REASON);
});

test('(a) a searcher that ignores the signal still does not hold the phase past the deadline', async () => {
  const controller = new AbortController();
  const never = new Promise<never>(() => { /* never settles, ignores the signal */ });
  const pending = fanOutAxisEvidence(axes, { search: () => never, signal: controller.signal });
  controller.abort(new Error('Research wall-clock budget reached'));
  const result = await pending;
  expect(result.axes.map(axis => axis.evidence.map(item => item.outcome))).toEqual([['failed'], ['failed'], ['failed']]);
});

test('(d) a fast turn is unchanged: no cap, no deadline marks', async () => {
  const result = await fanOutAxisEvidence(axes, {
    search: async query => hit(axes.find(axis => axis.searchTerms[0] === query)!.id),
    fetchPage: async url => ({ url, output: `body ${url}` }),
    signal: new AbortController().signal,
  });
  expect(result.axes.flatMap(axis => axis.evidence.map(item => item.failureReason ?? null))).toEqual([null, null, null, null, null, null]);
  expect(result.axes.flatMap(axis => axis.evidence.map(item => item.outcome))).toEqual(['complete', 'complete', 'complete', 'complete', 'complete', 'complete']);
});
