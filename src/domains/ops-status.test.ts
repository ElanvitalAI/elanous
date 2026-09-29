// opsSnapshot — read-only 보장(부재 스토어 skip · fleet 부작용 차단).
//
// openOpsEventsDb/openSchedulesDb 는 mkdir+CREATE TABLE 로 부재 파일을 생성한다(write 부작용).
// fleet 연합(runOpsFleet)이 부재 인스턴스에 경로를 주입하면 빈 db 가 생겨선 안 된다 —
// "명시 주입 경로가 부재하면 open skip" 가드가 이를 보장한다(관측=무부작용, 관측 정비 트랙 정신).

import { describe, test, expect, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  opsSnapshot, opsHealth,
  OPS_STATUS_LOG_CATEGORY,
  OPS_SCHEDULES_LOOKUP_FAILED_EVENT,
  readRecentFailureLogs,
} from './ops-status.js';
import { buildCronLine, openSchedulesDb, repoRoot, scheduleHealth, type ScheduleRow } from './schedule-registry.js';
import type { TradeMandate } from './trade-mandate.js';
import { TaskStore } from '../task-orchestrator/store.js';

describe('opsHealth — repeated failure is isolated from existing health checks', () => {
  test('unreadable logs skip only this check and leave existing anomaly wording untouched', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const opts = { missionStore: store, opsDbPath: '/nonexistent/ops_events.db', mandate: null,
      listScheduleRows: () => [schedRow({ id: 'failed', name: 'failed', last_status: 'error', last_run: '2026-09-28T06:00:00Z' })],
      now: new Date('2026-09-28T06:02:00Z') };
    try {
      const baseline = opsHealth({ ...opts, recentLogs: () => [] });
      const failed = opsHealth({ ...opts, recentLogs: () => { throw new Error('log DB unavailable'); } });
      expect(failed.anomalies).toEqual(baseline.anomalies);
      expect(failed.anomalies).toContainEqual({ kind: 'schedule_error', entity: 'failed', detail: '마지막 실행 error', since: '2026-09-28T06:00:00Z' });
      expect(log).toHaveBeenCalledWith('ops.health', 'repeated-failure-skipped', { reason: 'log DB unavailable' });
      expect(log).toHaveBeenCalledWith('ops.health', 'repeated-failure', { groups: 0, topCount: 0 });
    } finally { store.close(); log.mockRestore(); }
  });
});

describe('opsSnapshot — 부재 스토어 skip(read-only · 빈 db 미생성)', () => {
  test('주입된 ops_events/schedules 경로가 부재하면 open skip → 파일 미생성 · 스케줄은 조회 실패', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-skip-'));
    const opsDbPath = join(dir, 'ops_events.db');
    const schedulesDbPath = join(dir, 'schedules.db');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const mandate: TradeMandate = {
        armed: true, live: false, executionMode: 'per-cycle', paperSources: ['kis'],
      } as TradeMandate;
      const snap = opsSnapshot({ opsDbPath, schedulesDbPath, mandate });

      // ★ 핵심 — 부재 파일이 생성되지 않았다(write 부작용 없음).
      expect(existsSync(opsDbPath)).toBe(false);
      expect(existsSync(schedulesDbPath)).toBe(false);

      // 이벤트 rows 는 빈 채로 · 명시 부재 스케줄 DB 는 조회 실패(null)이지 빈 레지스트리(0)가 아니다.
      expect(snap.loops.loops).toEqual([]);
      expect(snap.orchestration.recent).toEqual([]);
      expect(snap.schedules).toBeNull();
      expect(log).toHaveBeenCalledWith(
        OPS_STATUS_LOG_CATEGORY,
        OPS_SCHEDULES_LOOKUP_FAILED_EVENT,
        expect.objectContaining({ error: expect.stringContaining(schedulesDbPath) }),
        { level: 'warn' },
      );

      // mandate(무장/모드)는 ops_events 와 무관하므로 부재에도 반영된다.
      expect(snap.loops.armed).toBe(true);
      expect(snap.loops.live).toBe(false);
      expect(snap.loops.executionMode).toBe('per-cycle');
      expect(snap.loops.paperSources).toEqual(['kis']);
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function schedRow(partial: Partial<ScheduleRow> & Pick<ScheduleRow, 'id' | 'name'>): ScheduleRow {
  return {
    source: 'crontab',
    cron: '0 * * * *',
    interval_ms: null,
    command: 'bun scripts/x.ts',
    category: 'monitor',
    domain: 'elanous',
    enabled: 1,
    last_seen: null,
    last_run: null,
    note: null,
    managed_by: 'elanous',
    raw: null,
    run_via: 'elanous',
    ...partial,
  };
}

const isolatedMandate: TradeMandate = {
  armed: true, live: false, executionMode: 'per-cycle', paperSources: ['kis'],
} as TradeMandate;

function isolatedSnapOpts(listScheduleRows: () => ScheduleRow[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-seam-'));
  return {
    dir,
    opts: {
      opsDbPath: join(dir, 'ops_events.db'),
      schedulesDbPath: join(dir, 'schedules.db'),
      mandate: isolatedMandate,
      listScheduleRows,
    },
  };
}

describe('opsSnapshot — 예약 레지스트리 조회 seam', () => {
  test('채워진 행을 주입하면 조회가 호출되고 헬스 elanousTotal 이 그 수를 반영한다', () => {
    const rows = [
      schedRow({ id: 'job-a', name: 'job-a' }),
      schedRow({ id: 'job-b', name: 'job-b' }),
      schedRow({ id: 'job-c', name: 'job-c', run_via: 'crontab' }),
      schedRow({ id: 'job-d', name: 'job-d', run_via: 'crontab', command: 'bun scripts/cron-run.ts scripts/job-d.ts' }),
    ];
    let calls = 0;
    const { dir, opts } = isolatedSnapOpts(() => { calls += 1; return rows; });
    try {
      const snap = opsSnapshot(opts);
      expect(calls).toBe(1);
      expect(snap.schedules).not.toBeNull();
      expect(snap.schedules!.elanousTotal).toBe(3);
      expect(snap.schedules!.excludedRunVia).toBe(0);
      expect(snap.schedules!.excludedUnwrappedCrontab).toBe(1);
      expect(snap.schedules!.excludedDisabled).toBe(0);
      expect(snap.schedules!.excludedMissingCron).toBe(0);
      expect(snap.schedules).toEqual(scheduleHealth(rows, {
        now: new Date(snap.generatedAt), repo: repoRoot(), bun: process.execPath,
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('진짜 빈 레지스트리 → 0 이고 못 셌다(null)가 아니다', () => {
    let calls = 0;
    const { dir, opts } = isolatedSnapOpts(() => { calls += 1; return []; });
    try {
      const snap = opsSnapshot(opts);
      expect(calls).toBe(1);
      expect(snap.schedules).not.toBeNull();
      expect(snap.schedules!.elanousTotal).toBe(0);
      expect(snap.schedules!.stale).toEqual([]);
      expect(snap.schedules!.errored).toEqual([]);
      expect(snap.schedules!.excludedRunVia).toBe(0);
      expect(snap.schedules!.excludedUnwrappedCrontab).toBe(0);
      expect(snap.schedules!.excludedDisabled).toBe(0);
      expect(snap.schedules!.excludedMissingCron).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('제외만 있는 레지스트리 → 빈 레지스트리와 다른 0-모집단 이유가 전파된다', () => {
    const rows = [
      schedRow({ id: 'crontab-only', name: 'crontab-only', run_via: 'crontab' }),
      schedRow({ id: 'disabled', name: 'disabled', enabled: 0 }),
      schedRow({ id: 'missing-cron', name: 'missing-cron', cron: '' }),
    ];
    const { dir, opts } = isolatedSnapOpts(() => rows);
    try {
      const snap = opsSnapshot(opts);
      expect(snap.schedules).not.toBeNull();
      expect(snap.schedules!.elanousTotal).toBe(0);
      expect(snap.schedules!.excludedRunVia).toBe(0);
      expect(snap.schedules!.excludedUnwrappedCrontab).toBe(1);
      expect(snap.schedules!.excludedDisabled).toBe(1);
      expect(snap.schedules!.excludedMissingCron).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('조회 throw → 실패가 값으로 남고 0으로 접히지 않는다', () => {
    let calls = 0;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const { dir, opts } = isolatedSnapOpts(() => {
      calls += 1;
      throw new Error('registry unavailable');
    });
    try {
      const snap = opsSnapshot(opts);
      expect(calls).toBe(1);
      expect(snap.schedules).toBeNull();
      expect(log).toHaveBeenCalledWith(
        OPS_STATUS_LOG_CATEGORY,
        OPS_SCHEDULES_LOOKUP_FAILED_EVENT,
        { error: 'registry unavailable' },
        { level: 'warn' },
      );
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('조회 실패와 진짜 빈 레지스트리의 산출이 서로 다르다', () => {
    const empty = isolatedSnapOpts(() => []);
    const failed = isolatedSnapOpts(() => { throw new Error('boom'); });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const emptySnap = opsSnapshot(empty.opts);
      const failedSnap = opsSnapshot(failed.opts);
      expect(emptySnap.schedules).not.toBeNull();
      expect(emptySnap.schedules!.elanousTotal).toBe(0);
      expect(failedSnap.schedules).toBeNull();
      expect(failedSnap.schedules).not.toEqual(emptySnap.schedules);
    } finally {
      log.mockRestore();
      rmSync(empty.dir, { recursive: true, force: true });
      rmSync(failed.dir, { recursive: true, force: true });
    }
  });

  test('예약 밖 축(미션·태스크·루프)은 조회 성공/실패와 무관하게 같다', () => {
    const empty = isolatedSnapOpts(() => []);
    const failed = isolatedSnapOpts(() => { throw new Error('boom'); });
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const emptySnap = opsSnapshot({ ...empty.opts, missionStore: store });
      const failedSnap = opsSnapshot({ ...failed.opts, missionStore: store });
      for (const snap of [emptySnap, failedSnap]) {
        expect(snap.missions).toEqual({ total: 0, byStatus: {}, active: [] });
        expect(snap.tasks).toEqual({
          total: 0, byStatus: {}, scheduleBacked: 0, recentlyActive: 0,
          dispatchPending: 0, blocked: [], dispatchable: [],
        });
        expect(snap.loops).toEqual({
          loops: [], armed: true, live: false, executionMode: 'per-cycle', paperSources: ['kis'],
        });
        expect(snap.orchestration).toEqual({ recent: [] });
      }
    } finally {
      store.close();
      log.mockRestore();
      rmSync(empty.dir, { recursive: true, force: true });
      rmSync(failed.dir, { recursive: true, force: true });
    }
  });

  test('정규형과 다른 raw 행은 스냅샷에서 측정된 noncanonical 이고 unmeasured 가 아니다', () => {
    const command = 'bun scripts/x.ts';
    const rows = [
      schedRow({
        id: 'canonical', name: 'canonical', command,
        raw: buildCronLine('0 * * * *', command, { repo: repoRoot(), bun: process.execPath }),
      }),
      schedRow({ id: 'noncanonical', name: 'noncanonical', command, raw: `0 * * * * ${command}` }),
    ];
    const { dir, opts } = isolatedSnapOpts(() => rows);
    try {
      const snap = opsSnapshot(opts);
      expect(snap.schedules!.noncanonical).toHaveLength(1);
      expect(snap.schedules!.noncanonical[0]!.id).toBe('noncanonical');
      expect(snap.schedules!.unmeasured).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('정규형 컨텍스트가 없으면 unmeasured 로 남고 noncanonical 로 오인하지 않는다', () => {
    const rows = [schedRow({ id: 'raw-job', name: 'raw-job', raw: '0 * * * * bun scripts/x.ts' })];
    const health = scheduleHealth(rows, { now: new Date('2026-07-09T10:00:00.000Z') });
    expect(health.unmeasured).toHaveLength(1);
    expect(health.noncanonical).toHaveLength(0);
  });

  test('같은 행 목록으로 scheduleHealth 를 부르면 스냅샷 예약 축과 같다', () => {
    const rows = [
      schedRow({ id: 'job-a', name: 'job-a' }),
      schedRow({ id: 'job-b', name: 'job-b', last_status: 'error', last_run: '2026-07-09T08:00:00Z' }),
    ];
    const now = new Date('2026-07-09T10:00:00.000Z');
    const { dir, opts } = isolatedSnapOpts(() => rows);
    try {
      const snap = opsSnapshot({ ...opts, now });
      expect(snap.schedules).toEqual(scheduleHealth(rows, {
        now, repo: repoRoot(), bun: process.execPath,
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('opsSnapshot — 기본 조회 경계(부재 DB vs 진짜 빈 레지스트리)', () => {
  test('명시된 부재 schedulesDbPath 는 파일을 만들지 않고 조회 실패(null)로 남긴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-default-missing-'));
    const opsDbPath = join(dir, 'ops_events.db');
    const schedulesDbPath = join(dir, 'schedules.db');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(existsSync(schedulesDbPath)).toBe(false);
      const snap = opsSnapshot({
        opsDbPath,
        schedulesDbPath,
        mandate: isolatedMandate,
      });
      expect(existsSync(schedulesDbPath)).toBe(false);
      expect(snap.schedules).toBeNull();
      expect(log).toHaveBeenCalledWith(
        OPS_STATUS_LOG_CATEGORY,
        OPS_SCHEDULES_LOOKUP_FAILED_EVENT,
        expect.objectContaining({ error: expect.stringContaining('schedules registry missing') }),
        { level: 'warn' },
      );
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('기본 조회 경계가 채워진 레지스트리 행을 읽어 elanousTotal 에 반영한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-default-filled-'));
    const opsDbPath = join(dir, 'ops_events.db');
    const schedulesDbPath = join(dir, 'schedules.db');
    const db = openSchedulesDb(schedulesDbPath);
    try {
      db.run(
        `INSERT INTO schedule_registry (id, name, source, cron, command, category, domain, enabled, managed_by, run_via)
         VALUES (?, ?, 'crontab', ?, ?, 'monitor', 'elanous', 1, 'elanous', 'elanous')`,
        ['job-a', 'job-a', '0 * * * *', 'bun scripts/a.ts'],
      );
      db.run(
        `INSERT INTO schedule_registry (id, name, source, cron, command, category, domain, enabled, managed_by, run_via)
         VALUES (?, ?, 'crontab', ?, ?, 'monitor', 'elanous', 1, 'elanous', 'elanous')`,
        ['job-b', 'job-b', '0 * * * *', 'bun scripts/b.ts'],
      );
      db.run(
        `INSERT INTO schedule_registry (id, name, source, cron, command, category, domain, enabled, managed_by, run_via)
         VALUES (?, ?, 'crontab', ?, ?, 'monitor', 'elanous', 1, 'manual', 'crontab')`,
        ['job-c', 'job-c', '0 * * * *', 'bun scripts/c.ts'],
      );
    } finally {
      db.close();
    }
    try {
      const snap = opsSnapshot({
        opsDbPath,
        schedulesDbPath,
        mandate: isolatedMandate,
      });
      expect(snap.schedules).not.toBeNull();
      expect(snap.schedules!.elanousTotal).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('존재하는 빈 레지스트리 DB 는 elanousTotal=0 이고 못 셌다(null)가 아니다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-default-empty-'));
    const opsDbPath = join(dir, 'ops_events.db');
    const schedulesDbPath = join(dir, 'schedules.db');
    const db = openSchedulesDb(schedulesDbPath);
    db.close();
    try {
      expect(existsSync(schedulesDbPath)).toBe(true);
      const snap = opsSnapshot({
        opsDbPath,
        schedulesDbPath,
        mandate: isolatedMandate,
      });
      expect(snap.schedules).not.toBeNull();
      expect(snap.schedules!.elanousTotal).toBe(0);
      expect(snap.schedules!.stale).toEqual([]);
      expect(snap.schedules!.errored).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('기본 조회 경계에서 부재 경로와 진짜 빈 레지스트리의 산출이 서로 다르다', () => {
    const missingDir = mkdtempSync(join(tmpdir(), 'ops-default-cmp-missing-'));
    const emptyDir = mkdtempSync(join(tmpdir(), 'ops-default-cmp-empty-'));
    const missingPath = join(missingDir, 'schedules.db');
    const emptyPath = join(emptyDir, 'schedules.db');
    const emptyDb = openSchedulesDb(emptyPath);
    emptyDb.close();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const missingSnap = opsSnapshot({
        opsDbPath: join(missingDir, 'ops_events.db'),
        schedulesDbPath: missingPath,
        mandate: isolatedMandate,
      });
      const emptySnap = opsSnapshot({
        opsDbPath: join(emptyDir, 'ops_events.db'),
        schedulesDbPath: emptyPath,
        mandate: isolatedMandate,
      });
      expect(existsSync(missingPath)).toBe(false);
      expect(existsSync(emptyPath)).toBe(true);
      expect(missingSnap.schedules).toBeNull();
      expect(emptySnap.schedules).not.toBeNull();
      expect(emptySnap.schedules!.elanousTotal).toBe(0);
      expect(missingSnap.schedules).not.toEqual(emptySnap.schedules);
    } finally {
      log.mockRestore();
      rmSync(missingDir, { recursive: true, force: true });
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('readRecentFailureLogs — bounded scan (review must-fix)', () => {
  test('asks the store for a bounded newest-first page of the last 10 minutes', () => {
    const seen: Array<{ sinceMs?: number; limit?: number }> = [];
    const rows = readRecentFailureLogs({ query: (q: unknown) => { seen.push(q as never); return []; } } as never, 1_000_000_000, 500);
    expect(rows).toEqual([]);
    expect(seen).toEqual([{ sinceMs: 1_000_000_000 - 600_000, limit: 500 }]);
  });
});

