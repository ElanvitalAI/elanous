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
  guardian.command('tick').description('현재 시각에 발화했을 잡을 관측(잡은 실행하지 않음)')
    .action(async () => {
      const { guardianTick } = await import('../domains/guardian-tick.js');
      const { db, plan } = await guardianPlan();
      try {
        const cfg = getUserConfig();
        // Live activation (and crontab retirement) is a separate operational change.
        if (cfg.guardian?.mode === 'live') throw new Error('guardian live activation is outside GUARD-ONE-a');
        const result = await guardianTick(new Date(), plan, { config: cfg });
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
