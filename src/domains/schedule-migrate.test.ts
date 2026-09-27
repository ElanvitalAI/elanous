import { describe, expect, it } from 'bun:test';
import { openSchedulesDb, listSchedules, type ScheduleRow } from './schedule-registry.js';
import { migrateJobToTrigger, registerScheduledToxTasks, catchUpTriggerJobs, findScheduledTaskId, deleteTriggerJob } from './schedule-migrate.js';
import { TaskStore } from '../task-orchestrator/store.js';
import { createTask } from '../task-orchestrator/types.js';
import type { WorkflowEntry } from '../workflow-runtime/types.js';

function seedJob(db: ReturnType<typeof openSchedulesDb>, over: Partial<ScheduleRow> = {}): string {
  const row = {
    id: 'job_x', name: 'collect', source: 'crontab', cron: '5,35 9-15 * * 1-5',
    interval_ms: null, command: 'cd /r && bun scripts/collect.ts', category: 'ingest', domain: 'finance',
    enabled: 1, managed_by: 'elanous', run_via: 'elanous', raw: '5,35 9-15 * * 1-5 cd /r && bun scripts/collect.ts',
    ...over,
  };
  db.run(
    `INSERT OR REPLACE INTO schedule_registry
       (id, name, source, cron, interval_ms, command, category, domain, enabled, managed_by, run_via, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.name, row.source, row.cron, row.interval_ms, row.command, row.category,
      row.domain, row.enabled, row.managed_by, row.run_via, row.raw],
  );
  return row.id;
}

describe('migrateJobToTrigger', () => {
  it('예약잡 → Task 생성·데몬 등록·run_via=trigger·crontab 제거', () => {
    const sdb = openSchedulesDb(':memory:');
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const registered: WorkflowEntry[] = [];
    const removedRaws: string[] = [];
    try {
      const jobId = seedJob(sdb);
      const res = migrateJobToTrigger({
        scheduleDb: sdb, store,
        registerWorkflow: (e) => registered.push(e),
        removeCrontabLine: (raw) => removedRaws.push(raw),
        now: () => new Date(1000),
      }, jobId);

      // Task 저장됨(terminal-pane·command·scheduleText)
      const task = store.getTask(res.taskId)!;
      expect(task.surface.kind).toBe('terminal-pane');
      expect(task.scheduleText).toBe('5,35 9-15 * * 1-5');
      expect(task.schedulerJobId).toBe(jobId);
      // 데몬 등록(ScheduleTrigger workflow)
      expect(res.registered).toBe(true);
      expect(registered).toHaveLength(1);
      expect(registered[0]!.definition.name).toBe(res.workflowName);
      // run_via=trigger (schedule-runner 정지)
      expect(listSchedules(sdb).find((r) => r.id === jobId)!.run_via).toBe('trigger');
      // crontab 라인 제거(이중발화 방지)
      expect(res.crontabRemoved).toBe(true);
      expect(removedRaws).toEqual(['5,35 9-15 * * 1-5 cd /r && bun scripts/collect.ts']);
    } finally { sdb.close(); store.close(); }
  });

  it('이미 trigger 면 throw(재이관 방지)', () => {
    const sdb = openSchedulesDb(':memory:');
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      const jobId = seedJob(sdb, { run_via: 'trigger' });
      expect(() => migrateJobToTrigger({ scheduleDb: sdb, store }, jobId)).toThrow(/이미 trigger/);
    } finally { sdb.close(); store.close(); }
  });

  it('없는 잡 → throw', () => {
    const sdb = openSchedulesDb(':memory:');
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      expect(() => migrateJobToTrigger({ scheduleDb: sdb, store }, 'nope')).toThrow(/없음/);
    } finally { sdb.close(); store.close(); }
  });

  it('registerWorkflow 없으면(CLI·데몬 미가동) registered=false·부팅 sweep 위임', () => {
    const sdb = openSchedulesDb(':memory:');
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      const jobId = seedJob(sdb, { raw: null });
      const res = migrateJobToTrigger({ scheduleDb: sdb, store, now: () => new Date(1000) }, jobId);
      expect(res.registered).toBe(false);
      expect(res.crontabRemoved).toBe(false);
      expect(listSchedules(sdb).find((r) => r.id === jobId)!.run_via).toBe('trigger');
      expect(store.getTask(res.taskId)).not.toBeNull();
    } finally { sdb.close(); store.close(); }
  });
});

describe('findScheduledTaskId / deleteTriggerJob (U4e — trigger CRUD)', () => {
  it('schedulerJobId 로 tox task 찾고 삭제(고아 방지)', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      store.saveTask(createTask({
        title: 'sched', surface: { kind: 'terminal-pane', spec: { command: 'bun x' } },
        scheduleText: '0 8 * * *', schedulerJobId: 'jobX',
      }, { id: 'task:sx', now: 1 }));
      expect(findScheduledTaskId(store, 'jobX')).toBe('task:sx');
      expect(findScheduledTaskId(store, 'nope')).toBeNull();
      const r = deleteTriggerJob(store, 'jobX');
      expect(r.taskDeleted).toBe(true);
      expect(store.getTask('task:sx')).toBeNull();       // 삭제됨 → 부팅 sweep 재등록 안 함
      expect(deleteTriggerJob(store, 'jobX').taskDeleted).toBe(false); // 이미 없음
    } finally { store.close(); }
  });
});

describe('catchUpTriggerJobs — 이관잡 놓친발화 복구(U4b)', () => {
  function seedTrigger(db: ReturnType<typeof openSchedulesDb>, over: Partial<ScheduleRow> & { last_run?: string | null } = {}): void {
    const row = {
      id: 'j1', name: 'daily-report', cron: '0 8 * * *', command: 'bun scripts/report.ts',
      run_via: 'trigger', enabled: 1, last_run: null as string | null, ...over,
    };
    db.run(
      `INSERT OR REPLACE INTO schedule_registry (id, name, source, cron, command, category, enabled, managed_by, run_via, last_run)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.name, 'crontab', row.cron, row.command, 'report', row.enabled, 'elanous', row.run_via, row.last_run],
    );
  }
  const at10am = () => new Date('2026-07-09T10:00:00');

  it('놓친 일간 잡(last_run 없음) → command spawn 복구·markResult via=catchup', async () => {
    const db = openSchedulesDb(':memory:');
    const spawned: string[] = [];
    try {
      seedTrigger(db, { last_run: null });
      const r = await catchUpTriggerJobs(db, {
        spawn: async (cmd) => { spawned.push(cmd); return { code: 0, ms: 5 }; },
        now: at10am,
      });
      expect(r.recovered).toEqual(['j1']);
      expect(spawned).toEqual(['bun scripts/report.ts']);
      const row = listSchedules(db).find((x) => x.id === 'j1')!;
      expect(row.last_via).toBe('catchup');
      expect(row.last_status).toBe('ok');
    } finally { db.close(); }
  });

  it('이미 발화한 잡(last_run ≥ 직전예정) → 복구 안 함', async () => {
    const db = openSchedulesDb(':memory:');
    try {
      seedTrigger(db, { last_run: '2026-07-09T08:00:05' }); // 오늘 8시 이미 발화
      const r = await catchUpTriggerJobs(db, { spawn: async () => ({ code: 0, ms: 1 }), now: at10am });
      expect(r.recovered).toEqual([]);
    } finally { db.close(); }
  });

  it('매매 잡은 catch-up 제외(defaultCatchupEligible)', async () => {
    const db = openSchedulesDb(':memory:');
    try {
      seedTrigger(db, { id: 'jt', name: 'trade-autonomous-cycle', command: 'bun scripts/trade-autonomous-cycle.ts', last_run: null });
      const r = await catchUpTriggerJobs(db, { spawn: async () => ({ code: 0, ms: 1 }), now: at10am });
      expect(r.recovered).toEqual([]);
    } finally { db.close(); }
  });

  it('run_via=elanous(비이관) 잡은 이 sweep 대상 아님', async () => {
    const db = openSchedulesDb(':memory:');
    try {
      seedTrigger(db, { run_via: 'elanous', last_run: null });
      const r = await catchUpTriggerJobs(db, { spawn: async () => ({ code: 0, ms: 1 }), now: at10am });
      expect(r.recovered).toEqual([]);
    } finally { db.close(); }
  });
});

describe('registerScheduledToxTasks — 부팅 재등록 sweep', () => {
  it('scheduleText 달린 비-terminal task 만 등록', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const registered: WorkflowEntry[] = [];
    try {
      // 이관잡(scheduled·backlog) → 등록
      store.saveTask(createTask({
        title: 'sched', surface: { kind: 'terminal-pane', spec: { command: 'bun x' } },
        scheduleText: '0 8 * * *', schedulerJobId: 'j1',
      }, { id: 'task:aa', now: 1 }));
      // 일반 task(scheduleText 없음) → skip
      store.saveTask(createTask({
        title: 'plain', surface: { kind: 'llm-direct', prompt: 'hi' },
      }, { id: 'task:bb', now: 1 }));
      // 이관잡이지만 done(terminal) → skip
      store.saveTask(createTask({
        title: 'olddone', surface: { kind: 'terminal-pane', spec: { command: 'bun y' } },
        scheduleText: '0 9 * * *', status: 'done',
      }, { id: 'task:cc', now: 1 }));

      const res = registerScheduledToxTasks(store, (e) => registered.push(e));
      expect(res.registered).toBe(1);
      expect(registered).toHaveLength(1);
      expect(registered[0]!.definition.name).toBe('tox-task-task:aa');
    } finally { store.close(); }
  });

  it('레지스트리가 trigger 가 아니라고 하면 파생 task 를 등록하지 않는다(release 뒤 고아 · 이중 발화 방지)', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const registered: WorkflowEntry[] = [];
    try {
      store.saveTask(createTask({
        title: 'released', surface: { kind: 'terminal-pane', spec: { command: 'bun x' } },
        scheduleText: '0 7 * * *', schedulerJobId: 'jRel',
      }, { id: 'task:rel', now: 1 }));
      store.saveTask(createTask({
        title: 'live', surface: { kind: 'terminal-pane', spec: { command: 'bun y' } },
        scheduleText: '0 8 * * *', schedulerJobId: 'jTrig',
      }, { id: 'task:trig', now: 1 }));
      const runVia: Record<string, string> = { jRel: 'crontab', jTrig: 'trigger' };
      const res = registerScheduledToxTasks(store, (e) => registered.push(e), (id) => runVia[id] ?? null);
      expect(res.registered).toBe(1);
      expect(res.skippedNotTrigger).toBe(1);
      expect(registered.map((e) => e.definition.name)).toEqual(['tox-task-task:trig']);
    } finally { store.close(); }
  });
});
