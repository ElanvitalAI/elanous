/** OP #114412: the fanout shares the research-phase deadline. Its angle deadline / first-result grace are clamped to the time
 * left to it. Values are derived from the named constants; assertions are exact structured values (no numeric bounds). */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import {
  clampFanoutTimings, RESEARCH_FANOUT_ANGLE_DEADLINE_MS, RESEARCH_FANOUT_FIRST_RESULT_GRACE_MS, runResearchFanout,
  type ResearchFanoutWorker,
} from './research-fanout.js';
import { debug } from '../debug/log.js';

afterEach(() => mock.restore());

const ANGLE = RESEARCH_FANOUT_ANGLE_DEADLINE_MS;
const GRACE = RESEARCH_FANOUT_FIRST_RESULT_GRACE_MS;
const untilAborted = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('no turn budget: the code defaults stand', () => {
  expect(clampFanoutTimings({ angleDeadlineMs: ANGLE, graceMs: GRACE })).toEqual({ deadlineMs: ANGLE, graceMs: GRACE });
});

test('plenty of time left: nothing is clamped', () => {
  expect(clampFanoutTimings({ angleDeadlineMs: ANGLE, graceMs: GRACE, remainingMs: ANGLE + GRACE + ANGLE }))
    .toEqual({ deadlineMs: ANGLE, graceMs: GRACE });
});

test('time left inside deadline+grace: the grace is clamped so deadline+grace equals the time left', () => {
  const remainingMs = ANGLE + GRACE / 3;
  const clamped = clampFanoutTimings({ angleDeadlineMs: ANGLE, graceMs: GRACE, remainingMs });
  expect(clamped).toEqual({ deadlineMs: ANGLE, graceMs: remainingMs - ANGLE });
  expect(clamped.deadlineMs + clamped.graceMs).toBe(remainingMs);
});

test('time left shorter than the angle deadline: deadline = time left and no grace at all', () => {
  const remainingMs = ANGLE / 2;
  expect(clampFanoutTimings({ angleDeadlineMs: ANGLE, graceMs: GRACE, remainingMs })).toEqual({ deadlineMs: remainingMs, graceMs: 0 });
});

test('time already spent: deadline 0, grace 0 (never negative)', () => {
  expect(clampFanoutTimings({ angleDeadlineMs: ANGLE, graceMs: GRACE, remainingMs: -ANGLE })).toEqual({ deadlineMs: 0, graceMs: 0 });
});

test('runResearchFanout with researchRemainingMs: angles are cut at the clamped deadline and the recorded event carries it', async () => {
  const events: Array<Record<string, unknown>> = [];
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'research.fanout' && event === 'completed') events.push(data as Record<string, unknown>);
  });
  const worker: ResearchFanoutWorker = async (_angle, _request, signal) => untilAborted(signal);
  const remainingMs = 20; // 출처: test fixture — a research phase with only this much time left (real wait, tens of ms)
  const result = await runResearchFanout('question', worker, { researchRemainingMs: remainingMs });
  expect(result.angles.map(({ error, timing }) => [error, timing])).toEqual([
    ['angle-deadline', 'angle-deadline'], ['angle-deadline', 'angle-deadline'], ['angle-deadline', 'angle-deadline'],
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ angleDeadlineMs: remainingMs, graceMs: 0 });
});
