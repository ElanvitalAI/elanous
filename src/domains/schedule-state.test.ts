import { describe, expect, test } from 'bun:test';
import type { ScheduleRow } from './schedule-registry.js';
import { computeScheduleState, displayName, findDuplicates, listLaunchdElanous, nextRuns } from './schedule-state.js';

const now = new Date('2026-09-28T12:00:00.000Z');
const line = '*/10 * * * * bun scripts/cron-run.ts scripts/agent-mission.ts review-watch';
const row: ScheduleRow = {
  id: 'one', name: 'agent-mission', source: 'crontab', cron: '*/10 * * * *', interval_ms: null,
  command: 'bun scripts/cron-run.ts scripts/agent-mission.ts review-watch', category: 'maintenance',
  domain: null, enabled: 1, last_seen: null, last_run: '2026-09-28T11:55:00.000Z', note: null,
  managed_by: 'manual', raw: line, run_via: 'crontab',
};
const state = (r: ScheduleRow, lines: string[] = [line], triggerRegistered = false) => computeScheduleState({
  row: r, crontabLines: lines, triggerRegistered, launchdLoaded: false, now,
  nextRuns: nextRuns(r.cron!, now, 5),
});

describe('real firing ownership, not registry.enabled', () => {
  test('active crontab and recent fire = firing', () => expect(state(row)).toBe('firing'));
  test('active crontab and >two missed periods = stale', () =>
    expect(state({ ...row, last_run: '2026-09-28T11:20:00.000Z' })).toBe('stale'));
  test('owned but never recorded = live (no-history), not stale', () =>
    expect(state({ ...row, last_run: null })).toBe('live'));
  test('weekday schedule is live on Monday before the first due fire after a normal Friday fire', () => {
    const friday = new Date('2026-09-25T09:00:00.000Z');
    const monday = new Date('2026-09-28T08:00:00.000Z');
    const weekday = { ...row, cron: '0 9 * * 1-5', last_run: friday.toISOString() };
    const weekdayLine = `0 9 * * 1-5 ${weekday.command}`;
    expect(computeScheduleState({ row: weekday, crontabLines: [weekdayLine], triggerRegistered: false,
      launchdLoaded: false, now: monday, timeZone: 'UTC', nextRuns: nextRuns(weekday.cron, monday, 5, { timeZone: 'UTC' }) }))
      .toBe('live');
  });
  test('weekday schedule becomes stale only after more than two actual due fires are missed', () => {
    const friday = new Date('2026-09-25T09:00:00.000Z');
    const tuesday = new Date('2026-09-29T10:00:00.000Z');
    const wednesday = new Date('2026-09-30T10:00:00.000Z');
    const weekday = { ...row, cron: '0 9 * * 1-5', last_run: friday.toISOString() };
    const weekdayLine = `0 9 * * 1-5 ${weekday.command}`;
    const evaluate = (at: Date) => computeScheduleState({ row: weekday, crontabLines: [weekdayLine],
      triggerRegistered: false, launchdLoaded: false, now: at, timeZone: 'UTC',
      nextRuns: nextRuns(weekday.cron, at, 5, { timeZone: 'UTC' }) });
    expect(evaluate(tuesday)).toBe('live');
    expect(evaluate(wednesday)).toBe('stale');
  });
  test('daemon trigger remains live when registry enabled=0', () =>
    expect(['live', 'firing']).toContain(state({ ...row, enabled: 0, run_via: 'trigger' }, [], true)));
  test('active daemon subscription wins over stale crontab run_via and missing crontab line', () =>
    expect(state({ ...row, enabled: 0, run_via: 'crontab' }, [], true)).toBe('firing'));
  test('no owner = off, even when registry enabled=1', () => expect(state(row, [])).toBe('off'));
  test('same command on two live owners flags both copies', () => {
    const a = { command: row.command, state: 'firing' as const, flags: [] as string[] };
    const b = { command: row.command, state: 'live' as const, flags: [] as string[] };
    findDuplicates([a, b]);
    expect(a.flags).toContain('duplicate');
    expect(b.flags).toContain('duplicate');
  });
  test('disabled history is not a duplicate', () => {
    const a = { command: row.command, state: 'firing' as const, flags: [] as string[] };
    const b = { command: row.command, state: 'off' as const, flags: [] as string[] };
    findDuplicates([a, b]);
    expect(a.flags).not.toContain('duplicate');
  });
  test('five future cron instants and human-readable names', () => {
    expect(nextRuns('*/10 * * * *', now, 5)).toHaveLength(5);
    expect(displayName('cd /repo && OPENROUTER_API_KEY=abc bun bin/elanous.mjs harness drafts sweep >> /tmp/log 2>&1')).toBe('harness drafts sweep');
    expect(displayName(row.command!)).toBe('scripts/agent-mission.ts review-watch');
    expect(displayName('cd /repo && bun bin/elanous.mjs agent-mission review-watch')).toBe('agent-mission review-watch');
  });
  test('hourly cron returns five chronological instants', () => {
    expect(nextRuns('0 * * * *', new Date('2026-09-28T12:01:00Z'), 5, { timeZone: 'UTC' }))
      .toEqual(['2026-09-28T13:00:00.000Z', '2026-09-28T14:00:00.000Z',
        '2026-09-28T15:00:00.000Z', '2026-09-28T16:00:00.000Z', '2026-09-28T17:00:00.000Z']);
  });
  test('daily schedule returns chronological five even across local midnight', () => {
    expect(nextRuns('0 0 * * *', new Date('2026-09-28T15:59:00Z'), 5, { timeZone: 'Asia/Seoul' }))
      .toEqual(['2026-09-29T15:00:00.000Z', '2026-09-30T15:00:00.000Z',
        '2026-10-01T15:00:00.000Z', '2026-10-02T15:00:00.000Z', '2026-10-03T15:00:00.000Z']);
  });
  test('sparse annual cron returns five exact instants without minute scanning', () => {
    const start = performance.now();
    expect(nextRuns('0 0 1 1 *', new Date('2026-01-01T00:00:01Z'), 5, { timeZone: 'UTC' })).toEqual([
      '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z',
      '2029-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z',
      '2031-01-01T00:00:00.000Z',
    ]);
    expect(performance.now() - start).toBeLessThan(1500);
  });
  test('leap day still returns five future occurrences', () => {
    expect(nextRuns('0 0 29 2 *', new Date('2026-01-01T00:00:00Z'), 5, { timeZone: 'UTC' })).toEqual([
      '2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z',
      '2036-02-29T00:00:00.000Z', '2040-02-29T00:00:00.000Z',
      '2044-02-29T00:00:00.000Z',
    ]);
  });
  test('impossible date terminates in bounded calendar checks', () => {
    const start = performance.now();
    expect(nextRuns('0 0 30 2 *', now, 5, { timeZone: 'UTC' })).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1500);
  });
  test('DST gap is skipped and fall-back repeated hour yields both instants', () => {
    expect(nextRuns('30 2 * * *', new Date('2026-03-08T06:00:00Z'), 1, { timeZone: 'America/New_York' }))
      .toEqual(['2026-03-09T06:30:00.000Z']);
    expect(nextRuns('30 1 * * *', new Date('2026-11-01T04:00:00Z'), 2, { timeZone: 'America/New_York' }))
      .toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  });
  test('launchctl list only exposes elanous labels with pid and exit', () => {
    expect(listLaunchdElanous({ run: () => 'PID\tStatus\tLabel\n123\t0\tcom.elanous.nexus\n-\t2\tcom.other.job\n-\t1\tcom.elanous.worker' }))
      .toEqual([{ label: 'com.elanous.nexus', pid: 123, lastExit: 0 }, { label: 'com.elanous.worker', pid: null, lastExit: 1 }]);
  });
});
