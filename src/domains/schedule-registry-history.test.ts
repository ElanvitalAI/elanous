import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { inventoryCrontab, listSchedules, markResult, openSchedulesDb } from './schedule-registry.js';
import { listScheduleRuns } from './schedule-runs.js';

const line = '0 8 * * * cd /r && bun scripts/daily-report.ts';

describe('schedule registry run history', () => {
  test('fresh and legacy databases create history and preserve repeated-open schema', () => {
    const fresh = openSchedulesDb(':memory:');
    try {
      expect(fresh.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_runs'`).get()).toEqual({ name: 'schedule_runs' });
      expect(fresh.query(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_schedule_runs_schedule_fired'`).get())
        .toEqual({ name: 'idx_schedule_runs_schedule_fired' });
    } finally { fresh.close(); }

    const dir = mkdtempSync(join(tmpdir(), 'schedule-history-'));
    const path = join(dir, 'schedules.db');
    try {
      const legacy = new Database(path);
      legacy.run(`CREATE TABLE schedule_registry (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
        category TEXT NOT NULL
      )`);
      legacy.run(`INSERT INTO schedule_registry (id, name, source, category)
        VALUES ('legacy', 'saved name', 'crontab', 'maintenance')`);
      legacy.close();
      const migrated = openSchedulesDb(path);
      expect(migrated.query(`SELECT name FROM sqlite_master WHERE name='schedule_runs'`).get()).toEqual({ name: 'schedule_runs' });
      expect(migrated.query(`SELECT name FROM schedule_registry WHERE id='legacy'`).get()).toEqual({ name: 'saved name' });
      migrated.close();
      const reopened = openSchedulesDb(path);
      expect(reopened.query(`SELECT name FROM sqlite_master WHERE name='idx_schedule_runs_schedule_fired'`).get())
        .toEqual({ name: 'idx_schedule_runs_schedule_fired' });
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('markResult writes chronological snapshots and keeps last_* aligned', () => {
    const db = openSchedulesDb(':memory:');
    try {
      inventoryCrontab(db, { crontab: line });
      const id = listSchedules(db)[0]!.id;
      markResult(db, id, { at: '2026-09-01T00:00:00Z', status: 'error', exit: 9, durationMs: 50, via: 'crontab', error: 'failed', runId: 'run-a' });
      markResult(db, id, { at: '2026-09-02T00:00:00Z', status: 'ok', exit: 0, durationMs: 100, via: 'manual', runId: 'run-b' });
      // 이력 행은 골 명세의 칸(schedule_id·fired_at·status·exit·duration_ms·via·run_id·log_ref)만 — 이름·오류는 레지스트리 행에 있다.
      expect(listScheduleRuns(db, id).map(({ schedule_id, status, exit, duration_ms, via, run_id }) =>
        ({ schedule_id, status, exit, duration_ms, via, run_id }))).toEqual([
        { schedule_id: id, status: 'ok', exit: 0, duration_ms: 100, via: 'manual', run_id: 'run-b' },
        { schedule_id: id, status: 'error', exit: 9, duration_ms: 50, via: 'crontab', run_id: 'run-a' },
      ]);
      expect(listSchedules(db)[0]).toMatchObject({ last_run: '2026-09-02T00:00:00Z', last_status: 'ok', last_exit: 0,
        last_duration_ms: 100, last_via: 'manual', last_error: null });
    } finally { db.close(); }
  });

  test('history insertion failure logs id and error without losing last_* update', () => {
    const db = openSchedulesDb(':memory:');
    const originalLog = debug.log;
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    try {
      inventoryCrontab(db, { crontab: line });
      const id = listSchedules(db)[0]!.id;
      db.run(`CREATE TRIGGER fail_schedule_history BEFORE INSERT ON schedule_runs BEGIN SELECT RAISE(FAIL, 'history refused'); END`);
      debug.log = ((category: string, event: string, data?: unknown) => {
        events.push({ category, event, data });
      }) as typeof debug.log;
      expect(() => markResult(db, id, { at: '2026-09-03T00:00:00Z', status: 'error', exit: 7, durationMs: 13, via: 'tick', error: 'timeout' })).not.toThrow();
      expect(listScheduleRuns(db, id)).toEqual([]);
      expect(listSchedules(db)[0]).toMatchObject({ last_run: '2026-09-03T00:00:00Z', last_status: 'error', last_exit: 7,
        last_duration_ms: 13, last_via: 'tick', last_error: 'timeout' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ category: 'schedule.registry', event: 'run-history-write-failed', data: { id } });
      expect(String((events[0]!.data as { error: string }).error)).toContain('history refused');
    } finally { debug.log = originalLog; db.close(); }
  });

  test('reinventory preserves customized name until effective command changes', () => {
    const db = openSchedulesDb(':memory:');
    try {
      inventoryCrontab(db, { crontab: line });
      const id = listSchedules(db)[0]!.id;
      db.run(`UPDATE schedule_registry SET name = 'my own label' WHERE id = ?`, [id]);
      inventoryCrontab(db, { crontab: line });
      expect(listSchedules(db)[0]!.name).toBe('my own label');
      const wrapped = '0 8 * * * cd /r && bun scripts/cron-run.ts scripts/daily-report.ts';
      inventoryCrontab(db, { crontab: wrapped });
      expect(listSchedules(db)[0]).toMatchObject({ id, name: 'daily-report' });
      markResult(db, id, { at: '2026-09-04T00:00:00Z', status: 'ok' });
      db.run(`UPDATE schedule_registry SET name = 'renamed later' WHERE id = ?`, [id]);
      expect(listScheduleRuns(db, id)[0]!.schedule_id).toBe(id);
    } finally { db.close(); }
  });
});
