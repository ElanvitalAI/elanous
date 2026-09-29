import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { LogStore } from '../../mss/logging/log-store.js';
import type { ScheduleRow } from '../../domains/schedule-registry.js';
import { handleSchedulesList, handleScheduleDetail, handleScheduleRuns, type SchedulesReadDeps } from './schedules-read.js';
import { ensureScheduleRunsSchema, recordScheduleRun } from '../../domains/schedule-runs.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { parseDashboardPath } from './dashboard.js';

const now = new Date('2026-09-28T12:00:00.000Z');
const secret = 'sk-or-v1-this-is-a-secret-value-with-long-random-chars';
const command = `bun bin/elanous.mjs harness drafts sweep OPENROUTER_API_KEY=${secret}`;
const row: ScheduleRow = { id: 'abc', name: 'drafts', source: 'crontab', cron: '*/10 * * * *',
  interval_ms: null, command, category: 'maintenance', domain: null, enabled: 0, last_seen: null,
  last_run: now.toISOString(), note: null, managed_by: 'manual', raw: `*/10 * * * * ${command}`,
  run_via: 'crontab' };
const deps: SchedulesReadDeps = {
  rows: () => [row, { ...row, id: 'off', command: 'bun scripts/off.ts', raw: null, enabled: 1 }],
  crontab: () => `*/10 * * * * ${command}`,
  launchd: () => [{ label: 'com.elanous.nexus', pid: 123, lastExit: 0 }],
  triggerIds: () => new Set(), now: () => now,
};
const meta = { bearerToken: 'owner-secret' };
const request = (path: string, token = true) => new Request(`http://remote.invalid${path}`, {
  headers: token ? { authorization: 'Bearer owner-secret' } : {},
});

describe('schedule run history API (S2)', () => {
  test('GET /:id/runs pages id-recorded fires newest first; detail prefers id history; missing table is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-runs-'));
    const path = join(dir, 'schedules.db');
    try {
      const empty = handleScheduleRuns(request('/v1/schedules/abc/runs'), 'abc', meta, { ...deps, schedulesDbPath: () => path });
      expect(empty.status).toBe(200);
      const db = new Database(path);
      ensureScheduleRunsSchema(db);
      recordScheduleRun(db, 'abc', { at: '2026-09-28T01:00:00Z', status: 'ok', exit: 0, durationMs: 10, via: 'crontab', runId: 'run-1' });
      recordScheduleRun(db, 'abc', { at: '2026-09-28T02:00:00Z', status: 'error', exit: 1, durationMs: 20, via: 'tick' });
      recordScheduleRun(db, 'other', { at: '2026-09-28T03:00:00Z', status: 'ok', via: 'tick' });
      db.close();
      const d = { ...deps, schedulesDbPath: () => path };
      expect(handleScheduleRuns(request('/v1/schedules/abc/runs', false), 'abc', meta, d).status).toBe(401);
      expect(handleScheduleRuns(request('/v1/schedules/..%2Fx/runs'), '../x', meta, d).status).toBe(400);
      return Promise.all([
        handleScheduleRuns(request('/v1/schedules/abc/runs'), 'abc', meta, d).json(),
        handleScheduleRuns(request('/v1/schedules/abc/runs?before=2026-09-28T02:00:00Z&limit=5'), 'abc', meta, d).json(),
        handleScheduleRuns(request('/v1/schedules/abc/runs?limit=0'), 'abc', meta, d).json(),
        handleScheduleDetail(request('/v1/schedules/abc'), 'abc', meta, d).json(),
        empty.json(),
      ]).then(([all, paged, bad, detail, none]) => {
        expect(all.runs.map((r: { at: string }) => r.at)).toEqual(['2026-09-28T02:00:00.000Z', '2026-09-28T01:00:00.000Z']);
        expect(all.runs[1]).toMatchObject({ status: 'ok', matchedBy: 'id', runId: 'run-1' });
        expect(paged.runs.map((r: { at: string }) => r.at)).toEqual(['2026-09-28T01:00:00.000Z']);
        expect(bad.error).toBe('bad_request');
        expect(detail.runs[0]).toMatchObject({ matchedBy: 'id' });
        expect(none.runs).toEqual([]);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('schedule read API', () => {
  test('owner-only inventory is based on actual crontab and launchd; off excluded by default', async () => {
    expect(handleSchedulesList(request('/v1/schedules', false), meta, deps).status).toBe(401);
    const res = handleSchedulesList(request('/v1/schedules'), meta, deps);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(`OPENROUTER_API_KEY=${secret}`);
    const body = JSON.parse(text);
    expect(body.count).toBe(2);
    expect(body.schedules[0]).toMatchObject({ id: 'abc', state: 'firing', registryEnabled: false });
    // 레지스트리 메타 — PWA Schedules 탭이 대시보드 경로 없이 실행 주체·분류로 그린다.
    expect(body.schedules[0]).toMatchObject({ runVia: 'crontab', category: 'maintenance', domain: null, note: null });
    expect(body.schedules[1]).toMatchObject({ runVia: 'launchd' });
    expect(body.schedules[0].command).toContain('OPENROUTER_API_KEY=***');
    expect(body.schedules[0].next).toHaveLength(5);
    expect(body.schedules[1]).toMatchObject({ source: 'launchd', pid: 123, lastExit: 0, state: 'live' });
    expect(JSON.parse(await handleSchedulesList(request('/v1/schedules?includeOff=1'), meta, deps).text()).count).toBe(3);
  });
  test('detail reads the exact registry name and newest 50 from the actual log DB, beyond 10,000 unrelated runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-read-'));
    const path = join(dir, 'logs.db');
    const base = now.getTime() - 3_600_000;
    try {
      new LogStore(path).close();
      const db = new Database(path);
      try {
        const insert = db.prepare(`INSERT INTO logs
          (ts, ts_ms, level, instance, host_id, surface, category, event, session_id, trace_id, data)
          VALUES (?, ?, 'info', 'test', '', 'scheduler', 'schedule.run', ?, NULL, NULL, ?)`);
        const put = (time: number, name: string, index: number) =>
          insert.run(new Date(time).toISOString(), time, name,
            JSON.stringify({ status: 'ok', exit: index, ms: 21, via: 'crontab' }));
        db.transaction(() => {
          for (let i = 0; i < 60; i++) put(base + i * 1000, 'drafts', i);
          for (let i = 0; i < 20; i++) put(base + 70_000 + i * 1000, 'drafts-extra', i);
          for (let i = 0; i < 10_050; i++) put(base + 100_000 + i * 1000, 'other-job', i);
        })();
      } finally { db.close(); }
      const actualDeps = { ...deps, logsPath: () => path };
      expect(handleScheduleDetail(request('/v1/schedules/abc', false), 'abc', meta, actualDeps).status).toBe(401);
      const body = await handleScheduleDetail(request('/v1/schedules/abc'), 'abc', meta, actualDeps).json() as any;
      expect(body.schedule.id).toBe('abc');
      expect(body.runs).toHaveLength(50);
      expect(body.runs.map((run: any) => run.exit)).toEqual(Array.from({ length: 50 }, (_, i) => 59 - i));
      expect(body.runs[0]).toEqual({ at: new Date(base + 59_000).toISOString(), status: 'ok',
        exit: 59, durationMs: 21, via: 'crontab', matchedBy: 'name' });
      expect(handleScheduleDetail(request('/v1/schedules/..%2Fetc'), '../etc', meta, actualDeps).status).toBe(400);
      expect(handleScheduleDetail(request('/v1/schedules/missing'), 'missing', meta, actualDeps).status).toBe(404);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('duplicate matching is performed before redaction (distinct secrets do not collapse)', async () => {
    const different: SchedulesReadDeps = { ...deps, rows: () => [row, { ...row, id: 'other',
      command: command.replace(secret, 'sk-or-v1-other-random-secret-with-long-chars'),
      raw: null, run_via: 'trigger' }], triggerIds: () => new Set(['other']) };
    const body = await handleSchedulesList(request('/v1/schedules'), meta, different).json() as any;
    expect(body.schedules).toHaveLength(3);
    expect(body.schedules.every((s: any) => !s.flags.includes('duplicate'))).toBe(true);
  });
  test('active subscription with stale crontab run_via stays visible without a crontab line', async () => {
    const migrated: SchedulesReadDeps = { ...deps, crontab: () => '', triggerIds: () => new Set(['abc']) };
    const body = await handleSchedulesList(request('/v1/schedules'), meta, migrated).json() as any;
    expect(body.schedules.find((s: any) => s.id === 'abc')).toMatchObject({ state: 'firing', registryEnabled: false });
  });
  test('dual crontab + daemon ownership flags each live source as duplicate', async () => {
    const dual: SchedulesReadDeps = { ...deps, triggerIds: () => new Set(['abc']) };
    const body = await handleSchedulesList(request('/v1/schedules'), meta, dual).json() as any;
    expect(body.schedules.filter((s: any) => s.flags.includes('duplicate')).map((s: any) => s.id))
      .toEqual(['abc', 'trigger:abc']);
  });
  test('the same active crontab line twice is flagged duplicate (each copy fires)', async () => {
    const twice = { ...deps, crontab: () => `*/10 * * * * ${command}\n*/10 * * * * ${command}` };
    const body = JSON.parse(await handleSchedulesList(request('/v1/schedules'), meta, twice).text());
    expect(body.schedules.find((s: { id: string }) => s.id === 'abc').flags).toContain('duplicate');
    const once = JSON.parse(await handleSchedulesList(request('/v1/schedules'), meta, deps).text());
    expect(once.schedules.find((s: { id: string }) => s.id === 'abc').flags).not.toContain('duplicate');
  });
  test('NEXUS route registers both GET paths and rejects encoded separators', async () => {
    expect(parseDashboardPath('/v1/dashboard/schedules')).toBe('schedules');
    const opts = { metaApi: meta } as NexusHttpServerOpts;
    const server = { requestIP: () => ({ address: '203.0.113.1' }) } as any;
    const ref = { get: () => null } as any;
    const res = await routeRequest(request('/v1/schedules/..%2Fetc'), opts, server, null, ref);
    expect(res?.status).toBe(400);
    const noAuth = await routeRequest(request('/v1/schedules', false), opts, server, null, ref);
    expect(noAuth?.status).toBe(401);
    // Authenticated requests reach the new handlers, even with empty isolated stores.
    const list = await routeRequest(request('/v1/schedules'), opts, server, null, ref);
    expect(list?.status).toBe(200);
    const detail = await routeRequest(request('/v1/schedules/unknown'), opts, server, null, ref);
    expect(detail?.status).toBe(404);
  });
});
