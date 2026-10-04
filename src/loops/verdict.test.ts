import { expect, test } from 'bun:test';
import { loopCronVerdict, type LoopCronVerdictInput } from './verdict.js';

const now = Date.parse('2026-10-04T12:00:00.000Z');
const entry: LoopCronVerdictInput = {
  enabled: true,
  lastRunAt: '2026-10-04T11:40:00.000Z',
  lastStatus: 'done',
  intervalMs: 10 * 60_000,
};

test('late only after more than two intervals, using supplied time', () => {
  expect(loopCronVerdict(entry, now)).toBe('alive');
  expect(loopCronVerdict(entry, now + 1)).toBe('late');
  expect(loopCronVerdict(entry, now - 1)).toBe('alive');
});

test('disabled takes precedence over failure and lateness; failed run takes precedence over lateness', () => {
  const stale = { ...entry, lastRunAt: '2026-10-04T11:00:00.000Z' };
  expect(loopCronVerdict({ ...stale, enabled: false, lastStatus: 'failed' }, now)).toBe('off');
  expect(loopCronVerdict({ ...stale, lastStatus: 'failed' }, now)).toBe('failed');
  expect(loopCronVerdict({ ...stale, lastStatus: 'error' }, now)).toBe('failed');
  expect(loopCronVerdict({ ...stale, lastStatus: 'failure' }, now)).toBe('failed');
  expect(loopCronVerdict({ ...stale, lastStatus: 'abandoned' }, now)).toBe('failed');
  expect(loopCronVerdict({ ...stale, lastStatus: 'expired' }, now)).toBe('failed');
  expect(loopCronVerdict(stale, now)).toBe('late');
});

test('calendar due instants override an irregular cron interval without inventing missed runs', () => {
  const cron = { ...entry, lastRunAt: '2026-01-09T09:00:00Z', intervalMs: 86_400_000,
    secondDueAt: '2026-01-13T09:00:00Z' };
  expect(loopCronVerdict(cron, Date.parse('2026-01-10T12:00:00Z'))).toBe('alive');
  expect(loopCronVerdict(cron, Date.parse('2026-01-12T09:01:00Z'))).toBe('alive');
  expect(loopCronVerdict(cron, Date.parse('2026-01-13T09:00:00Z'))).toBe('alive');
  expect(loopCronVerdict(cron, Date.parse('2026-01-13T09:00:00Z') + 1)).toBe('late');
  expect(loopCronVerdict({ ...cron, secondDueAt: null }, Date.parse('2026-01-20T09:00:00Z'))).toBe('alive');
});

test('daemon cron-aware stale signal is late even without a fixed interval or run history', () => {
  const cron = { ...entry, intervalMs: null, lastRunAt: null };
  expect(loopCronVerdict({ ...cron, scheduleState: 'live' }, now)).toBe('alive');
  expect(loopCronVerdict({ ...cron, scheduleState: 'firing' }, now)).toBe('alive');
  expect(loopCronVerdict({ ...cron, scheduleState: 'stale' }, now)).toBe('late');
  expect(loopCronVerdict({ ...cron, scheduleState: 'stale', lastStatus: 'error' }, now)).toBe('failed');
  expect(loopCronVerdict({ ...cron, scheduleState: 'stale', enabled: false }, now)).toBe('off');
});

test('unknown cadence or last run cannot establish lateness', () => {
  expect(loopCronVerdict({ ...entry, lastRunAt: null }, now)).toBe('alive');
  expect(loopCronVerdict({ ...entry, lastRunAt: 'invalid' }, now)).toBe('alive');
  expect(loopCronVerdict({ ...entry, intervalMs: null }, now)).toBe('alive');
  expect(loopCronVerdict({ ...entry, intervalMs: 0 }, now)).toBe('alive');
  expect(loopCronVerdict({ ...entry, intervalMs: -1 }, now)).toBe('alive');
});
