import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { deriveScheduleName, ensureScheduleRunsSchema, listScheduleRuns, recordScheduleRun } from './schedule-runs.js';

describe('schedule run history (in-memory schedules.db)', () => {
  test('schema and index creation is repeatable', () => {
    const db = new Database(':memory:');
    try {
      ensureScheduleRunsSchema(db);
      ensureScheduleRunsSchema(db);
      expect(db.query(`SELECT name FROM sqlite_master WHERE name IN ('schedule_runs', 'idx_schedule_runs_schedule_fired') ORDER BY name`).all())
        .toEqual([{ name: 'idx_schedule_runs_schedule_fired' }, { name: 'schedule_runs' }]);
      expect(listScheduleRuns(db, 'missing')).toEqual([]);
    } finally { db.close(); }
  });

  test('append keeps every result field and isolates two schedules with the same name', () => {
    const db = new Database(':memory:');
    try {
      ensureScheduleRunsSchema(db);
      recordScheduleRun(db, 'morning-id', { at: '2026-09-28T08:00:00.000Z', status: 'error', exit: 7, durationMs: 133, via: 'crontab', runId: 'run-1', logRef: 'logs.db:42' });
      recordScheduleRun(db, 'evening-id', { at: '2026-09-28T08:00:00.000Z', status: 'ok', exit: 0, via: 'manual' });
      const rows = listScheduleRuns(db, 'morning-id');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ id: expect.any(Number), schedule_id: 'morning-id', fired_at: '2026-09-28T08:00:00.000Z', status: 'error', exit: 7, duration_ms: 133, via: 'crontab', run_id: 'run-1', log_ref: 'logs.db:42' });
      expect(listScheduleRuns(db, 'evening-id')[0]).toMatchObject({ status: 'ok', exit: 0, duration_ms: null, via: 'manual', run_id: null, log_ref: null });
    } finally { db.close(); }
  });

  test('omitted via remains unknown, never an asserted tick', () => {
    const db = new Database(':memory:');
    try {
      ensureScheduleRunsSchema(db);
      recordScheduleRun(db, 'a', { at: '2026-09-28T00:00:00Z', status: 'ok' });
      recordScheduleRun(db, 'a', { at: '2026-09-28T00:01:00Z', status: 'ok', via: 'tick' });
      expect(listScheduleRuns(db, 'a').map(r => r.via)).toEqual(['tick', 'unknown']);
    } finally { db.close(); }
  });

  test('equal-time pages use the id tie-breaker without skipping rows', () => {
    const db = new Database(':memory:');
    try {
      ensureScheduleRunsSchema(db);
      for (let n = 0; n < 5; n++) recordScheduleRun(db, 'a', { at: '2026-09-28T01:00:00Z', status: `same-${n}` });
      recordScheduleRun(db, 'a', { at: '2026-09-28T00:00:00Z', status: 'earlier' });
      recordScheduleRun(db, 'b', { at: '2026-09-28T01:00:00Z', status: 'other-schedule' });
      const expected = listScheduleRuns(db, 'a');
      const seen: typeof expected = [];
      while (seen.length < expected.length) {
        const last = seen.at(-1);
        const page = listScheduleRuns(db, 'a', { limit: 2,
          ...(last ? { cursor: { firedAt: last.fired_at, id: last.id } } : {}) });
        expect(page.length).toBeGreaterThan(0);
        seen.push(...page);
      }
      expect(seen).toEqual(expected);
      expect(listScheduleRuns(db, 'a', { cursor: { firedAt: expected[1]!.fired_at, id: expected[1]!.id }, limit: 2 }))
        .toEqual(expected.slice(2, 4));
      expect(listScheduleRuns(db, 'a', { before: '2026-09-28T01:00:00Z', cursor: { firedAt: expected[0]!.fired_at, id: expected[0]!.id } }))
        .toEqual(expected.slice(5));
      expect(() => listScheduleRuns(db, 'a', { cursor: { firedAt: '2026-09-28T01:00:00Z', id: 0 } })).toThrow(RangeError);
    } finally { db.close(); }
  });

  test('before is exclusive; limit and equal-time ordering are deterministic', () => {
    const db = new Database(':memory:');
    try {
      ensureScheduleRunsSchema(db);
      for (const at of ['2026-09-28T00:00:00.000Z', '2026-09-28T01:00:00.000Z', '2026-09-28T01:00:00.000Z', '2026-09-28T02:00:00.000Z']) {
        recordScheduleRun(db, 'a', { at, status: 'ok' });
      }
      const rows = listScheduleRuns(db, 'a');
      expect(rows.map(r => r.fired_at)).toEqual(['2026-09-28T02:00:00.000Z', '2026-09-28T01:00:00.000Z', '2026-09-28T01:00:00.000Z', '2026-09-28T00:00:00.000Z']);
      expect(rows[1]!.id).toBeGreaterThan(rows[2]!.id);
      expect(listScheduleRuns(db, 'a', { limit: 1 })).toEqual([rows[0]]);
      expect(listScheduleRuns(db, 'a', { before: '2026-09-28T02:00:00.000Z' })).toEqual(rows.slice(1));
      expect(listScheduleRuns(db, 'a', { before: '2026-09-28T01:00:00.000Z' })).toEqual(rows.slice(3));
      expect(listScheduleRuns(db, 'a', { before: '2026-09-28T10:00:00+09:00' })).toEqual(rows.slice(3));
      expect(() => listScheduleRuns(db, 'a', { limit: 0 })).toThrow(RangeError);
      expect(() => listScheduleRuns(db, 'a', { before: 'not-iso' })).toThrow(RangeError);
    } finally { db.close(); }
  });

  test('normalizes offset timestamps before comparison and rejects invalid record times', () => {
    const db = new Database(':memory:');
    try {
      ensureScheduleRunsSchema(db);
      recordScheduleRun(db, 'offset', { at: '2026-09-28T09:00:00+09:00', status: 'same' });
      recordScheduleRun(db, 'offset', { at: '2026-09-28T00:00:00.000Z', status: 'same-utc' });
      recordScheduleRun(db, 'offset', { at: '2026-09-28T00:30:00-01:00', status: 'later' });
      expect(listScheduleRuns(db, 'offset').map(row => [row.fired_at, row.status])).toEqual([
        ['2026-09-28T01:30:00.000Z', 'later'],
        ['2026-09-28T00:00:00.000Z', 'same-utc'],
        ['2026-09-28T00:00:00.000Z', 'same'],
      ]);
      expect(listScheduleRuns(db, 'offset', { before: '2026-09-28T09:01:00+09:00' }).map(row => row.status))
        .toEqual(['same-utc', 'same']);
      expect(listScheduleRuns(db, 'offset', { before: '2026-09-28T09:00:00+09:00' })).toEqual([]);
      expect(() => recordScheduleRun(db, 'offset', { at: 'not-iso', status: 'invalid' })).toThrow(RangeError);
      for (const invalid of ['2026-02-30T00:00:00Z', '2026-02-30T09:00:00+09:00', '2025-02-29T00:00:00Z', '2026-04-31T00:00:00Z']) {
        expect(() => recordScheduleRun(db, 'offset', { at: invalid, status: 'invalid' })).toThrow(RangeError);
        expect(() => listScheduleRuns(db, 'offset', { before: invalid })).toThrow(RangeError);
        expect(() => listScheduleRuns(db, 'offset', { cursor: { firedAt: invalid, id: 1 } })).toThrow(RangeError);
      }
      recordScheduleRun(db, 'leap', { at: '2024-02-29T00:00:00Z', status: 'ok' });
      expect(listScheduleRuns(db, 'leap', { before: '2024-02-29T00:00:01Z' })).toHaveLength(1);
      expect(listScheduleRuns(db, 'offset')).toHaveLength(3);
    } finally { db.close(); }
  });

  test('retains the actual newest 500 when offset timestamps arrive out of order', () => {
    const db = new Database(':memory:');
    try {
      ensureScheduleRunsSchema(db);
      for (let n = 0; n < 500; n++) {
        recordScheduleRun(db, 'offset', { at: new Date(Date.UTC(2026, 8, 28, 0, n)).toISOString(), status: 'base' });
      }
      recordScheduleRun(db, 'offset', { at: '2026-09-28T00:00:00-12:00', status: 'newest' });
      recordScheduleRun(db, 'offset', { at: '2026-09-28T23:00:00+14:00', status: 'second' });
      const rows = listScheduleRuns(db, 'offset', { limit: 500 });
      expect(rows).toHaveLength(500);
      expect(rows.slice(0, 2).map(row => [row.fired_at, row.status])).toEqual([
        ['2026-09-28T12:00:00.000Z', 'newest'],
        ['2026-09-28T09:00:00.000Z', 'second'],
      ]);
      expect(rows.at(-1)!.fired_at).toBe('2026-09-28T00:02:00.000Z');
    } finally { db.close(); }
  });

  test('retains newest 500 per schedule, even when inserts arrive out of time order', () => {
    const db = new Database(':memory:');
    try {
      ensureScheduleRunsSchema(db);
      recordScheduleRun(db, 'b', { at: '2026-09-01T00:00:00.000Z', status: 'ok' });
      for (let n = 0; n < 501; n++) {
        recordScheduleRun(db, 'a', { at: new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString(), status: 'ok' });
      }
      recordScheduleRun(db, 'a', { at: '2020-01-01T00:00:00.000Z', status: 'error' });
      const rows = listScheduleRuns(db, 'a', { limit: 500 });
      expect(rows).toHaveLength(500);
      expect(rows[0]!.fired_at).toBe(new Date(Date.UTC(2026, 8, 1, 0, 500)).toISOString());
      expect(rows.at(-1)!.fired_at).toBe(new Date(Date.UTC(2026, 8, 1, 0, 1)).toISOString());
      expect(listScheduleRuns(db, 'b')).toHaveLength(1);
    } finally { db.close(); }
  });
});

test('deriveScheduleName removes launchers and identifies the human task', () => {
  expect(deriveScheduleName('cd /repo && ENV=prod /usr/bin/bun bin/elanous.mjs harness drafts sweep --once')).toBe('harness drafts sweep');
  expect(deriveScheduleName('cd /repo && bun bin/elanous.mjs agent-mission review-watch --once')).toBe('agent-mission review-watch');
  expect(deriveScheduleName('bun scripts/botlab/bot-routine.ts investor --once')).toBe('bot-routine investor');
  expect(deriveScheduleName('cd /repo && bun scripts/cron-run.ts --schedule-id abc scripts/morning.ts')).toBe('morning');
  expect(deriveScheduleName('cd /repo && bun run scripts/morning.ts')).toBe('morning');
  expect(deriveScheduleName('bun scripts/cron-run.ts --schedule-id abc bun run scripts/morning.ts')).toBe('morning');
  expect(deriveScheduleName('bun scripts/cron-run.ts --shell bash --schedule-id abc /x/backup.sh')).toBe('backup');
  expect(deriveScheduleName('cd /repo && bash /x/backup.sh --source cron')).toBe('backup');
});
