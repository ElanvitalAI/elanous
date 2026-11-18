import { expect, test } from 'bun:test';
import { eventWatchDeadlineMs } from './event-watch-deadline.js';

const NOW = 1_700_000_000_000;

test('a duration becomes now plus that many milliseconds', () => {
  expect(eventWatchDeadlineMs('600000', NOW)).toBe(NOW + 600_000);
});

test('missing, empty, zero, negative, and non-numeric values mean no deadline', () => {
  expect(eventWatchDeadlineMs(undefined, NOW)).toBeNull();
  expect(eventWatchDeadlineMs('', NOW)).toBeNull();
  expect(eventWatchDeadlineMs('  ', NOW)).toBeNull();
  expect(eventWatchDeadlineMs('0', NOW)).toBeNull();
  expect(eventWatchDeadlineMs('-1', NOW)).toBeNull();
  expect(eventWatchDeadlineMs('soon', NOW)).toBeNull();
});

test('a duration of 600000 is still in the future one tick later', () => {
  const deadline = eventWatchDeadlineMs('600000', NOW);
  expect(deadline).not.toBeNull();
  expect(NOW + 1_000 >= (deadline as number)).toBe(false);
});
