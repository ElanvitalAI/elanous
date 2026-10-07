import { describe, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { openSchedulesDb } from './schedule-registry.js';
import { ensureScheduleRunsSchema, recordScheduleRun } from './schedule-runs.js';
import { guardianShadowDay, guardianTick, type GuardianPlan } from './guardian-tick.js';

const plan: GuardianPlan = { timeZone: 'Asia/Seoul', jobs: [
  { id: 'dawn', cron: '0 4 * * *', command: 'bun scripts/cron-run.ts --schedule-id dawn scripts/dawn.ts', enabled: 1, source: 'crontab', run_via: 'crontab' },
  { id: 'daytime', cron: '*/30 8-22 * * *', command: 'bun scripts/cron-run.ts --schedule-id daytime scripts/daytime.ts', enabled: 1, source: 'crontab', run_via: 'crontab' },
] };
const kst = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 7, hour - 9, minute));

describe('GUARD-ONE-a shadow tick', () => {
  test('04:00→1, 08:30→1, 05:00→0 with no injected execution, even on a nonmatch', async () => {
    let executions = 0;
    const execute = async () => { executions++; return { code: 0, ms: 0 }; };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect((await guardianTick(kst(4), plan, { execute })).wouldRun).toEqual(['dawn']);
      expect((await guardianTick(kst(8, 30), plan, { execute })).wouldRun).toEqual(['daytime']);
      expect((await guardianTick(kst(5), plan, { execute })).wouldRun).toEqual([]);
      expect(executions).toBe(0);
      expect(log.mock.calls.filter(([category, event]) => category === 'guardian.tick' && event === 'would-run').map(([, , data]) => data))
        .toEqual([{ job: 'dawn', cron: '0 4 * * *' }, { job: 'daytime', cron: '*/30 8-22 * * *' }]);
    } finally { log.mockRestore(); }
  });

  test('288 ticks in one KST calendar day add 1 + 30 would-runs, no execution', async () => {
    let executions = 0;
    let would = 0;
    const start = kst(0).getTime();
    for (let i = 0; i < 288; i++) {
      const result = await guardianTick(new Date(start + i * 300_000), plan, { execute: async () => { executions++; return { code: 0, ms: 0 }; } });
      would += result.wouldRun.length;
      expect(result.executed).toBe(0);
    }
    expect(would).toBe(31);
    expect(executions).toBe(0);
  });

  test('only matched enabled crontab jobs participate; live uses the existing command only when opted in', async () => {
    const excluded: GuardianPlan = { ...plan, jobs: [...plan.jobs,
      { id: 'disabled', cron: '0 4 * * *', command: 'disabled', enabled: 0, source: 'crontab', run_via: 'crontab' },
      { id: 'daemon', cron: '0 4 * * *', command: 'daemon', enabled: 1, source: 'workflow-runtime', run_via: 'daemon' },
    ] };
    expect((await guardianTick(kst(4), excluded)).wouldRun).toEqual(['dawn']);
    const calls: string[] = [];
    const live = await guardianTick(kst(4), plan, { config: { guardian: { mode: 'live' } }, execute: async command => {
      calls.push(command);
      return { code: 0, ms: 1 };
    } });
    expect(live).toEqual({ mode: 'live', wouldRun: ['dawn'], executed: 1 });
    expect(calls).toEqual(['bun scripts/cron-run.ts --schedule-id dawn scripts/dawn.ts']);
    await expect(guardianTick(kst(4), plan, { config: { guardian: { mode: 'live' } }, execute: async () => ({ code: 1, ms: 0 }) }))
      .rejects.toThrow('exited 1');
    const plain: GuardianPlan = { ...plan, jobs: [{ ...plan.jobs[0]!, command: 'printf done' }] };
    const wrapped: string[] = [];
    await guardianTick(kst(4), plain, { config: { guardian: { mode: 'live' } }, execute: async command => {
      wrapped.push(command);
      return { code: 0, ms: 0 };
    } });
    expect(wrapped[0]).toContain('cron-run.ts');
    expect(wrapped[0]).toContain('--schedule-id');
    expect(wrapped[0]).toContain('printf done');
  });

  test('live refuses a wrapped command whose --schedule-id names another job (no execution)', async () => {
    let executions = 0;
    const execute = async () => { executions++; return { code: 0, ms: 0 }; };
    const live = { config: { guardian: { mode: 'live' as const } }, execute };
    const foreign: GuardianPlan = { ...plan, jobs: [{ ...plan.jobs[0]!, command: 'bun scripts/cron-run.ts --schedule-id daytime scripts/dawn.ts' }] };
    await expect(guardianTick(kst(4), foreign, live)).rejects.toThrow('refusing misattributed run');
    const missingId: GuardianPlan = { ...plan, jobs: [{ ...plan.jobs[0]!, command: 'bun scripts/cron-run.ts scripts/dawn.ts' }] };
    await expect(guardianTick(kst(4), missingId, live)).rejects.toThrow('--schedule-id is missing');
    const nested: GuardianPlan = { ...plan, jobs: [{ ...plan.jobs[0]!, command: 'bun scripts/cron-run.ts --shell /bin/sh -c "echo --schedule-id dawn"' }] };
    await expect(guardianTick(kst(4), nested, live)).rejects.toThrow('--schedule-id is missing');
    const nestedPlain: GuardianPlan = { ...plan, jobs: [{ ...plan.jobs[0]!, command: "bun scripts/cron-run.ts --shell /bin/sh -c 'run --schedule-id dawn --x'" }] };
    await expect(guardianTick(kst(4), nestedPlain, live)).rejects.toThrow('--schedule-id is missing');
    for (const command of [
      "sh -c 'echo cron-run.ts --schedule-id dawn && scripts/dawn.ts'",
      'cd /tmp && bun scripts/cron-run.ts --schedule-id dawn scripts/dawn.ts',
      'bun scripts/cron-run.ts --schedule-id dawn scripts/dawn.ts; rm -rf /tmp/x',
      'true scripts/cron-run.ts --schedule-id dawn scripts/dawn.ts',
      'node scripts/cron-run.ts --schedule-id dawn scripts/dawn.ts',
    ]) {
      await expect(guardianTick(kst(4), { ...plan, jobs: [{ ...plan.jobs[0]!, command }] }, live)).rejects.toThrow('refusing misattributed run');
    }
    const quoted: GuardianPlan = { ...plan, jobs: [{ ...plan.jobs[0]!, command: "bun scripts/cron-run.ts --schedule-id 'dawn' scripts/dawn.ts" }] };
    expect((await guardianTick(kst(4), quoted, live)).executed).toBe(1);
    const absoluteBun: GuardianPlan = { ...plan, jobs: [{ ...plan.jobs[0]!, command: "'/opt/homebrew/bin/bun' /repo/scripts/cron-run.ts --schedule-id dawn scripts/dawn.ts" }] };
    expect((await guardianTick(kst(4), absoluteBun, live)).executed).toBe(1);
    expect(executions).toBe(2);
  });
});

describe('GUARD-ONE-a day comparison', () => {
  test('compares by schedule id, records same and missing-job diff, leaves alerts unmeasured', () => {
    const db = openSchedulesDb(':memory:');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const day = '2026-10-07';
      for (let i = 0; i < 288; i++) {
        const at = new Date(kst(0).getTime() + i * 300_000);
        for (const job of plan.jobs) {
          if (job.id === 'dawn' ? i === 48 : i >= 96 && i <= 270 && i % 6 === 0) {
            recordScheduleRun(db, job.id, { at: at.toISOString(), status: 'ok', via: 'crontab' });
          }
        }
      }
      const same = guardianShadowDay(day, { db, plan });
      expect(same.same).toBe(true);
      expect(same.jobs).toEqual([
        { job: 'dawn', would: 1, actual: 1, alertsActual: null },
        { job: 'daytime', would: 30, actual: 30, alertsActual: null },
      ]);
      expect(same.alertDiff).toEqual([]);
      const alertsMissing = guardianShadowDay(day, { db, plan, alertsActual: id => id === 'daytime' ? 29 : 1 });
      expect(alertsMissing.same).toBe(true);
      expect(alertsMissing.diff).toEqual([]);
      expect(alertsMissing.alertDiff).toEqual([{ job: 'daytime', would: 30, actual: 30, alertsActual: 29 }]);
      db.run('DELETE FROM schedule_runs WHERE id = (SELECT id FROM schedule_runs WHERE schedule_id = ? LIMIT 1)', ['daytime']);
      const missing = guardianShadowDay(day, { db, plan, alertsActual: id => id === 'daytime' ? 29 : 1 });
      expect(missing.same).toBe(false);
      expect(missing.diff).toEqual([{ job: 'daytime', would: 30, actual: 29, alertsActual: 29 }]);
      expect(log).toHaveBeenCalledWith('guardian.compare', 'day', { same: false, diff: missing.diff, alertDiff: missing.alertDiff });
      expect(() => guardianShadowDay('2026-02-30', { db, plan })).toThrow(RangeError);
    } finally { log.mockRestore(); db.close(); }
  });

  test('last-500 history cannot silently certify an older matching day', () => {
    const db = openSchedulesDb(':memory:');
    try {
      for (let i = 0; i < 501; i++) {
        recordScheduleRun(db, 'dawn', { at: new Date(Date.UTC(2026, 9, 8, 0, i)).toISOString(), status: 'ok' });
      }
      expect(() => guardianShadowDay('2026-10-07', { db, plan: { ...plan, jobs: plan.jobs.slice(0, 1) } })).toThrow('history truncated');
    } finally { db.close(); }
  });

  test('day boundaries use the declared time zone, not UTC midnight', () => {
    const db = new Database(':memory:');
    ensureScheduleRunsSchema(db);
    try {
      recordScheduleRun(db, 'dawn', { at: kst(4).toISOString(), status: 'ok' });
      expect(guardianShadowDay('2026-10-07', { db, plan: { ...plan, jobs: plan.jobs.slice(0, 1) } }).same).toBe(true);
    } finally { db.close(); }
  });
});
