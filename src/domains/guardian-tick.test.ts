import { describe, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { recordDoctorVisit, recordPendingShadowDoctorReevaluations } from '../self-implement/doctor-visit.js';
import { appendRunLedgerEntry, loadRunLedger } from '../self-implement/run-ledger.js';
import type { TcellHealthCard } from '../harness/harness-incidents.js';
import { openSchedulesDb } from './schedule-registry.js';
import { ensureScheduleRunsSchema, recordScheduleRun } from './schedule-runs.js';
import { GROK_EXPIRY_ALERT_WINDOW_MS, grokExpiryAlertLine, grokExpiryStatusLine, guardianShadowDay, guardianTick, type GuardianPlan } from './guardian-tick.js';

const plan: GuardianPlan = { timeZone: 'Asia/Seoul', jobs: [
  { id: 'dawn', cron: '0 4 * * *', command: 'bun scripts/cron-run.ts --schedule-id dawn scripts/dawn.ts', enabled: 1, source: 'crontab', run_via: 'crontab' },
  { id: 'daytime', cron: '*/30 8-22 * * *', command: 'bun scripts/cron-run.ts --schedule-id daytime scripts/daytime.ts', enabled: 1, source: 'crontab', run_via: 'crontab' },
] };
const kst = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 7, hour - 9, minute));

describe('GUARD-ONE-a shadow tick', () => {
  test('guardian tick records T-cell decisions as shadow only and never executes an external action', async () => {
    const now = kst(7);
    const healthCards: TcellHealthCard[] = [{
      runId: 'run-0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d', stage: 'implement',
      startedAt: now.getTime() - 60_000, progressAt: now.getTime() - 60_000, stageBudgetMs: 5 * 60_000,
      heartbeatAt: now.getTime(), parentPresent: true, leaseExpiresAt: now.getTime() + 60_000, riskSignal: false,
      stopClass: 'pod-died', site: 'launch', signatureTail: 'bounded-tail',
    }];
    let sourceReads = 0;
    let executions = 0;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await guardianTick(now, { ...plan, jobs: [] }, {
        config: { guardian: { mode: 'live' } }, grokExpiry: () => null,
        readTcellHealthCards: () => { sourceReads++; return healthCards; },
        execute: async () => { executions++; return { code: 0, ms: 0 }; },
      });
      expect(result.tcellPatrol).toEqual({ total: 1, measured: 1, unmeasured: 0,
        counts: { healthy: 1, slow: 0, stalled: 0, infected: 0, zombie: 0 } });
      expect(sourceReads).toBe(1);
      expect(executions).toBe(0);
      expect(log.mock.calls.some(([category, event, data]) => {
        const payload = data as Record<string, unknown>;
        const decisions = payload.decisions as Array<{ runId: string; classification: string }> | undefined;
        return category === 'guardian.tcell' && event === 'shadow-classification'
          && payload.mode === 'shadow' && decisions?.[0]?.classification === 'healthy';
      })).toBe(true);
    } finally { log.mockRestore(); }
  });

  test('guardian shadow tick records one doctor prescription for an admitted visit across repeated ticks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-doctor-shadow-'));
    const runId = 'run-0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
    const missingEvidenceRunId = 'run-1a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
    try {
      appendRunLedgerEntry({ timestamp: '2026-10-25T00:00:00.000Z', runId, event: 'run-start', data: {} }, dir);
      appendRunLedgerEntry({ timestamp: '2026-10-25T00:00:01.000Z', runId, event: 'knowhow-pack', data: { ids: ['K-TC-777'], injected: true } }, dir);
      recordDoctorVisit({ runId, from: 'supervisor', symptom: 'admit-starved', evidence: 'admission queue stalled', dir, incidentRoot: null });
      appendRunLedgerEntry({ timestamp: '2026-10-25T00:00:00.000Z', runId: missingEvidenceRunId, event: 'run-start', data: {} }, dir);
      recordDoctorVisit({ runId: missingEvidenceRunId, from: 'supervisor', symptom: 'admit-starved', dir, incidentRoot: null });
      const doctorShadow = () => { recordPendingShadowDoctorReevaluations(dir); };
      const deps = { doctorShadow, grokExpiry: () => null };
      await guardianTick(kst(5), { ...plan, jobs: [] }, deps);
      await guardianTick(kst(5, 5), { ...plan, jobs: [] }, deps);
      const rows = loadRunLedger(runId, dir)!.filter(row => row.event === 'doctor-rx');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data).toMatchObject({ shadow: true, rx: 're-evaluate-member', execution: 'none', knowhowPackSliceIds: ['K-TC-777'] });
      const unmeasured = loadRunLedger(missingEvidenceRunId, dir)!.filter(row => row.event === 'doctor-rx');
      expect(unmeasured).toHaveLength(1);
      expect(unmeasured[0]!.data).toMatchObject({ shadow: true, rx: null, outcome: 'needs-evidence', execution: 'none', knowhowPackSliceIds: 'unknown' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('Grok expiry alert starts at four hours and contains host/time without credential material', async () => {
    const now = kst(14);
    const expiresAt = new Date(now.getTime() + GROK_EXPIRY_ALERT_WINDOW_MS).toISOString();
    const line = grokExpiryAlertLine({ now, expiresAt, host: 'node-c' });
    expect(line).toContain('host=node-c');
    expect(line).toContain('remaining=4h00m');
    expect(line).toContain('device-auth=https://accounts.x.ai/oauth2/device');
    expect(line).toContain('코드 생성/Allow는 OP(grok login --device-auth)');
    expect(grokExpiryAlertLine({ now, expiresAt: new Date(now.getTime() + GROK_EXPIRY_ALERT_WINDOW_MS + 1).toISOString() })).toBeNull();
    expect(grokExpiryAlertLine({ now, expiresAt: null })).toBeNull();
    expect(grokExpiryStatusLine({ now, expiresAt, host: 'node-c' })).toContain('4h-alert=active');
    expect(grokExpiryStatusLine({ now, expiresAt: new Date(now.getTime() + GROK_EXPIRY_ALERT_WINDOW_MS + 1).toISOString(), host: 'node-c' }))
      .toContain('4h-alert=in 1m');
    expect(grokExpiryStatusLine({ now, expiresAt: null, host: 'node-c' })).toContain('expires=unknown');

    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await guardianTick(now, { ...plan, jobs: [] }, {
        grokExpiry: () => expiresAt, hostName: 'node-c',
      });
      expect(result.credentialAlert === line).toBe(true);
      expect(log.mock.calls.some(([category, event, data]) => category === 'guardian.credential-expiry'
        && event === 'warning' && JSON.stringify(data).includes('host=node-c'))).toBe(true);
    } finally { log.mockRestore(); }
  });

  test('Grok expiry read failure is logged without stopping scheduled guardian work', async () => {
    let executed = 0;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await guardianTick(kst(4), plan, {
        config: { guardian: { mode: 'live' } },
        grokExpiry: () => { throw new Error('credential path unavailable'); },
        execute: async () => { executed++; return { code: 0, ms: 1 }; },
      });
      expect(result.executed).toBe(1);
      expect(executed).toBe(1);
      expect(log.mock.calls.some(([category, event, data]) => category === 'guardian.credential-expiry'
        && event === 'read-failed' && JSON.stringify(data) === '{"errorName":"Error"}')).toBe(true);
    } finally { log.mockRestore(); }
  });

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
