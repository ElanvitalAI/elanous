import type { Command } from 'commander';
import type { Database } from 'bun:sqlite';
import type { GuardianPlan } from '../domains/guardian-tick.js';
import { getUserConfig } from '../user-config.js';
import { writeStdoutJson } from './stdout-json.js';

// Domain modules (schedules.db · schedule-runner → node-cron) load lazily inside the actions,
// so registering `guardian` adds no static dependency to the CLI boot path.
async function guardianPlan(): Promise<{ db: Database; plan: GuardianPlan }> {
  const { listSchedules, openSchedulesDb } = await import('../domains/schedule-registry.js');
  const db = openSchedulesDb();
  try {
    return { db, plan: { jobs: listSchedules(db) } };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function registerGuardianCommands(program: Command): void {
  const guardian = program.command('guardian').description('크론 수호자 그림자 관측(기존 크론·알림 무변경)');
  guardian.command('doctor-shadow')
    .description('기록된 admit-starved 진료 요청을 재평가 처방으로 기록(집행 없음)')
    .requiredOption('--run <runId>', '진료 요청이 기록된 런')
    .option('--json', 'JSON 출력')
    .action(async (opts: { run: string; json?: boolean }) => {
      const { recordShadowDoctorReevaluation } = await import('../self-implement/doctor-visit.js');
      const result = recordShadowDoctorReevaluation(opts.run);
      if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
      else console.log(`doctor shadow: runId=${opts.run} status=${result.status} rx=${result.rx ?? 'none'} outcome=${result.outcome ?? 'none'} executed=0`);
    });
  guardian.command('grok-expiry').description('현재 호스트 Grok 구독 만료 시각과 4시간 경보 상태 출력')
    .action(async () => {
      const { readGrokSubscriptionExpiry } = await import('../grok/credential.js');
      const { grokExpiryAlertLine, grokExpiryStatusLine } = await import('../domains/guardian-tick.js');
      const now = new Date();
      const expiresAt = readGrokSubscriptionExpiry();
      console.log(grokExpiryStatusLine({ now, expiresAt }));
      const alert = grokExpiryAlertLine({ now, expiresAt });
      if (alert) console.log(alert);
    });
  guardian.command('tick').description('현재 시각에 발화했을 잡을 관측(잡은 실행하지 않음)')
    .action(async () => {
      const { guardianTick } = await import('../domains/guardian-tick.js');
      const { db, plan } = await guardianPlan();
      try {
        const cfg = getUserConfig();
        // Live activation (and crontab retirement) is a separate operational change.
        if (cfg.guardian?.mode === 'live') throw new Error('guardian live activation is outside GUARD-ONE-a');
        // The shadow observation is for the tick's entry time, however long the GC's evidence collection takes.
        const tickAt = new Date();
        // Local orphan GC is separate from the guardian's shadow-only schedule execution.
        const orphanGc = cfg.guardian?.orphanGc ?? 'shadow';
        try {
          // off never loads the collector, so no ps snapshot is taken.
          if (orphanGc !== 'off') {
            // Loading the collector is inside the guard too: a GC that cannot even load only observes.
            const { runMachineHeartbeat } = await import('../ops/machine-heartbeat.js');
            await runMachineHeartbeat(plan.jobs.filter((job): job is typeof job & { command: string; cron: string } =>
              job.source === 'crontab' && job.run_via === 'crontab' && !!job.enabled
              && typeof job.command === 'string' && typeof job.cron === 'string')
              .map(job => ({ command: job.command, cron: job.cron })), { timeZone: plan.timeZone, mode: orphanGc });
          } else {
            // Still one decision line per tick, so «switched off» is distinguishable from «tick never ran».
            const { debug } = await import('../debug/log.js');
            debug.log('ops.orphan-cli', 'decision', { mode: 'off', candidates: 0, collected: 0, alreadyEvidenced: 0, killed: 0 });
          }
        } catch (error) {
          // The logger import is inside the guard as well: if it is the failing module, the shadow tick still runs.
          try {
            const { debug } = await import('../debug/log.js');
            debug.log('ops.orphan-cli', 'observation-failed', { error: String(error) });
          } catch { /* guardian shadow still runs */ }
        }
        const result = await guardianTick(tickAt, plan, { config: cfg,
          doctorShadow: async () => { (await import('../self-implement/doctor-visit.js')).recordPendingShadowDoctorReevaluations(); },
        });
        await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
      } finally { db.close(); }
    });
  guardian.command('compare').description('하루의 예정 발화와 기록된 실제 발화 비교')
    .requiredOption('--day <YYYY-MM-DD>', '비교할 달력 날짜')
    .option('--json', 'JSON 출력')
    .action(async (opts: { day: string; json?: boolean }) => {
      const { guardianShadowDay } = await import('../domains/guardian-tick.js');
      const { db, plan } = await guardianPlan();
      try {
        const result = guardianShadowDay(opts.day, { db, plan });
        if (opts.json) await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
        else {
          console.log(`guardian ${result.day}: ${result.same ? 'same' : 'diff'} (현재 레지스트리 cron·활성 기준 재계산 · alertsActual=null: 발송 수 미측정)`);
          for (const row of result.jobs) console.log(`  ${row.job}: would=${row.would} actual=${row.actual} alertsActual=${row.alertsActual ?? '미측정'}`);
        }
      } finally { db.close(); }
    });
}
