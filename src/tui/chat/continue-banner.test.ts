import { expect, test } from 'bun:test';
import { DEFAULT_SEAT_CAP_CONTINUE_LIMIT } from '../input/goal-continue.js';
import { CONTINUE_REASON, continueBanner, dimContinueBanner, isContinueBanner } from './continue-banner.js';

test('goal-continue reads as calm English per reason, with no internal names', () => {
  expect(continueBanner('goal-continue', CONTINUE_REASON.turnLimit(1, DEFAULT_SEAT_CAP_CONTINUE_LIMIT)))
    .toBe(`↻ Continuing (turn limit reached · 1/${DEFAULT_SEAT_CAP_CONTINUE_LIMIT})`);
  expect(continueBanner('goal-continue', CONTINUE_REASON.nextStep)).toBe('↻ Continuing (next step)');
  expect(continueBanner('goal-continue', CONTINUE_REASON.remainingPlan)).toBe('↻ Continuing (remaining plan)');
  expect(continueBanner('goal-continue')).toBe('↻ Continuing');
  for (const line of [continueBanner('goal-continue', CONTINUE_REASON.turnLimit(2, 5)), continueBanner('scheduled', 'x')])
    expect(line).not.toMatch(/goal-continue|seat|cap|exhausted|자동|[가-힣]/u);
});

test('other origins say what woke the turn; unknown ones say Resuming', () => {
  expect(continueBanner('scheduled', 'SPWAKE review')).toBe('↻ Resuming (scheduled check)');
  expect(continueBanner('msg-wake')).toBe('↻ Resuming (new message)');
  expect(continueBanner('child-complete')).toBe('↻ Resuming (delegated work finished)');
  expect(continueBanner('autowake')).toBe('↻ Resuming (remaining work)');
  expect(continueBanner('self-pull')).toBe('↻ Resuming (next cell)');
  expect(continueBanner('something-new')).toBe('↻ Resuming');
});

test('continue lines are dimmed; other lines are left alone', () => {
  expect(dimContinueBanner('↻ Continuing (next step)')).toBe('\x1b[2m↻ Continuing (next step)\x1b[22m');
  expect(dimContinueBanner('⏸ Seat turn cap reached 5 times in a row')).toBe('⏸ Seat turn cap reached 5 times in a row');
  expect(isContinueBanner('> ↻ Continuing')).toBe(false);
});
