import { test, expect, describe } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSchedulesDb, inventoryCrontab, listSchedules, setRunVia, markRun } from './schedule-registry.js';
import { startScheduleRunner } from './schedule-runner.js';
import { dispatchScheduleManage } from './schedule-manage-tool.js';
import { TaskStore } from '../task-orchestrator/store.js';

// 합성 crontab — 2잡
const CRON = [
  '0 7 * * * cd /r && bun scripts/foo-report.ts >> /tmp/x.log 2>&1',
  '*/10 * * * * cd /r && bun scripts/bar-monitor.ts >> /tmp/x.log 2>&1',
].join('\n');

// fake node-cron — 타이머 안 돌고 stop만. 발화는 triggerNow로.
const fakeSchedule = () => ({ stop() { /* noop */ } });

function seed(runViaElanous: string[]) {
  const db = openSchedulesDb(':memory:');
  inventoryCrontab(db, { crontab: CRON, now: '2026-07-07T00:00:00Z' });
  for (const r of listSchedules(db)) {
    if (runViaElanous.includes(r.name)) setRunVia(db, r.id, 'elanous');
  }
  return db;
}

describe('startScheduleRunner — 실행 대상 선별', () => {
  test('run_via=elanous 잡만 스케줄(나머지 crontab이 실행)', () => {
    const db = seed(['foo-report']);
    // adopt 시나리오: foo는 crontab에서 제거됨(= crontabText가 foo 제외)
    const runner = startScheduleRunner({
      db, schedule: fakeSchedule, catchupGraceMs: 0,
      crontabText: () => 'invalid', now: () => '2026-07-07T01:00:00Z',
    });
    const active = runner.active();
    expect(active.length).toBe(1); // foo-report만
    runner.stop();
  });

  test('더블파이어 가드 — crontab에 아직 있으면 스킵', () => {
    const db = seed(['foo-report']);
    // foo가 여전히 crontab에 있음 → elanous 러너는 스킵(중복 발화 방지)
    const runner = startScheduleRunner({ db, schedule: fakeSchedule, catchupGraceMs: 0, crontabText: () => CRON });
    expect(runner.active().length).toBe(0);
    runner.stop();
  });

  test('run_via=crontab 잡은 스케줄 안 함', () => {
    const db = seed([]); // 아무것도 elanous 아님
    const runner = startScheduleRunner({ db, schedule: fakeSchedule, catchupGraceMs: 0, crontabText: () => '' });
    expect(runner.active().length).toBe(0);
    runner.stop();
  });
});

describe('발화 — spawn + last_run(S3)', () => {
  test('triggerNow → spawnJob 실행 + last_run 갱신', async () => {
    const db = seed(['foo-report']);
    const fired: string[] = [];
    const runner = startScheduleRunner({
      db, schedule: fakeSchedule, catchupGraceMs: 0, crontabText: () => '',
      spawnJob: async (cmd) => { fired.push(cmd); return { code: 0, ms: 0 }; },
      now: () => '2026-07-07T02:00:00Z',
    });
    const id = runner.active()[0]!;
    await runner.triggerNow(id);
    expect(fired.length).toBe(1);
    expect(fired[0]).toContain('foo-report');
    const row = listSchedules(db).find(r => r.id === id)!;
    expect(row.last_run).toBe('2026-07-07T02:00:00Z');
    runner.stop();
  });

  test('오버랩 가드 — 실행 중이면 재발화 스킵', async () => {
    const db = seed(['bar-monitor']);
    let running = 0, maxConcurrent = 0;
    const runner = startScheduleRunner({
      db, schedule: fakeSchedule, catchupGraceMs: 0, crontabText: () => '',
      spawnJob: async () => { running++; maxConcurrent = Math.max(maxConcurrent, running); await Promise.resolve(); running--; return { code: 0, ms: 0 }; },
    });
    const id = runner.active()[0]!;
    await Promise.all([runner.triggerNow(id), runner.triggerNow(id)]); // 동시 2회
    expect(maxConcurrent).toBe(1); // 겹치지 않음
    runner.stop();
  });
});

describe('reload — adopt/release 반영(재시작 불요)', () => {
  test('run_via 변경 후 reload → active 갱신', () => {
    const db = seed([]);
    const runner = startScheduleRunner({ db, schedule: fakeSchedule, catchupGraceMs: 0, crontabText: () => '' });
    expect(runner.active().length).toBe(0);
    // adopt: bar-monitor를 elanous 실행으로
    const bar = listSchedules(db).find(r => r.name === 'bar-monitor')!;
    setRunVia(db, bar.id, 'elanous');
    runner.reload();
    expect(runner.active()).toEqual([bar.id]);
    // release: 다시 crontab
    setRunVia(db, bar.id, 'crontab');
    runner.reload();
    expect(runner.active().length).toBe(0);
    runner.stop();
  });
});

describe('catch-up 자기회복 + 실행결과 추적(P1)', () => {
  const dayCron = '0 7 * * * cd /r && bun scripts/foo-report.ts >> /tmp/x.log 2>&1';
  const tradeCron = '5 8 * * * cd /r && bun scripts/trade-autonomous-cycle.ts >> /tmp/t.log 2>&1';
  function seedRows(cronLines: string[], elanousNames: string[]) {
    const db = openSchedulesDb(':memory:');
    inventoryCrontab(db, { crontab: cronLines.join('\n'), now: '2026-07-07T00:00:00Z' });
    for (const r of listSchedules(db)) if (elanousNames.includes(r.name)) setRunVia(db, r.id, 'elanous');
    return db;
  }
  const settle = () => new Promise((r) => setTimeout(r, 15));

  test('놓친 일간 잡 → sweep 이 catch-up 발화(via=catchup) + 결과 기록', async () => {
    const db = seedRows([dayCron], ['foo-report']);
    const fired: string[] = [];
    const runner = startScheduleRunner({
      db, schedule: fakeSchedule, crontabText: () => '',
      spawnJob: async (cmd) => { fired.push(cmd); return { code: 0, ms: 42 }; },
      nowDate: () => new Date(2026, 6, 9, 8, 30, 0), // 07:00 잡, 08:30 기준 → 유실
      now: () => '2026-07-09T08:30:00Z',
    });
    await settle();
    expect(fired.length).toBe(1);
    const row = listSchedules(db).find(r => r.name === 'foo-report')!;
    expect(row.last_via).toBe('catchup');
    expect(row.last_status).toBe('ok');
    expect(row.last_duration_ms).toBe(42);
    runner.sweepNow(); // idempotent — 이미 실행됨 → 재발화 없음
    await settle();
    expect(fired.length).toBe(1);
    runner.stop();
  });

  test('매매 실행류는 catch-up 제외(stale 주문 방지)', async () => {
    const db = seedRows([tradeCron], ['trade-autonomous-cycle']);
    const fired: string[] = [];
    const runner = startScheduleRunner({
      db, schedule: fakeSchedule, crontabText: () => '',
      spawnJob: async (cmd) => { fired.push(cmd); return { code: 0, ms: 0 }; },
      nowDate: () => new Date(2026, 6, 9, 8, 30, 0), // 08:05 예정 놓쳤어도
    });
    await settle();
    expect(fired.length).toBe(0);
    runner.stop();
  });

  test('exit!=0 → last_status=error + exit 기록', async () => {
    const db = seedRows([dayCron], ['foo-report']);
    const runner = startScheduleRunner({
      db, schedule: fakeSchedule, crontabText: () => '',
      spawnJob: async () => ({ code: 1, ms: 5 }),
      nowDate: () => new Date(2026, 6, 9, 8, 30, 0),
      now: () => '2026-07-09T08:30:00Z',
    });
    await settle();
    const row = listSchedules(db).find(r => r.name === 'foo-report')!;
    expect(row.last_status).toBe('error');
    expect(row.last_exit).toBe(1);
    runner.stop();
  });

  test('이미 실행됨(last_run>=직전예정) → catch-up 안 함', async () => {
    const db = seedRows([dayCron], ['foo-report']);
    const id = listSchedules(db).find(r => r.name === 'foo-report')!.id;
    markRun(db, id, '2026-07-09T08:00:00Z'); // 예정(07:00 KST)보다 나중 → 유실 아님
    const fired: string[] = [];
    const runner = startScheduleRunner({
      db, schedule: fakeSchedule, crontabText: () => '',
      spawnJob: async (cmd) => { fired.push(cmd); return { code: 0, ms: 0 }; },
      nowDate: () => new Date(2026, 6, 9, 8, 30, 0),
    });
    await settle();
    expect(fired.length).toBe(0);
    runner.stop();
  });
});

describe('schedule_manage adopt compatibility', () => {
  test('adopt migrates a crontab job to a fabric trigger instead of arming the retired runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c8d-schedule-adopt-'));
    const crontab = join(root, 'crontab.txt');
    const bin = join(root, 'crontab');
    writeFileSync(crontab, '0 7 * * * bun scripts/foo-report.ts\n');
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${crontab}"; else cat > "${crontab}"; fi\n`);
    chmodSync(bin, 0o755);
    const previous = { state: process.env.ELANOUS_STATE_DIR, config: process.env.ELANOUS_CONFIG_DIR, path: process.env.PATH };
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.PATH = `${root}:${previous.path ?? ''}`;
    try {
      const result = await dispatchScheduleManage({ action: 'adopt', id: 'foo-report' }) as { migrated?: string; taskId?: string; error?: string };
      expect(result.error).toBeUndefined();
      expect(result.migrated).toBe('foo-report');
      expect(result.taskId).toBeTruthy();
      let schedulerJobId: string | undefined;
      const store = new TaskStore();
      try {
        const task = store.getTask(result.taskId!);
        expect(task).toMatchObject({
          surface: { kind: 'terminal-pane', spec: { command: 'bun scripts/foo-report.ts' } },
          scheduleText: '0 7 * * *',
        });
        schedulerJobId = task?.schedulerJobId;
      } finally { store.close(); }
      expect(readFileSync(crontab, 'utf8').trim()).toBe('');
      const db = openSchedulesDb();
      try {
        const row = listSchedules(db).find((candidate) => candidate.name === 'foo-report');
        expect(row?.run_via).toBe('trigger');
        expect(schedulerJobId).toBe(row?.id);
        const retiredRunner = startScheduleRunner({ db, schedule: fakeSchedule, crontabText: () => '' });
        try { expect(retiredRunner.active()).toEqual([]); }
        finally { retiredRunner.stop(); }
      }
      finally { db.close(); }
    } finally {
      if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
      if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
      if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
