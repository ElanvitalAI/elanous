import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import * as ui from '../ui.js';
import { writeStdoutJson } from './stdout-json.js';

// ── cron (스케줄/크론 CRUD — claude code/codex 외부 접근용) ──
// dispatchScheduleManage(전 표면 공유 구현) 재사용 → schedule_registry·crontab·surface_events
// 메모리 루프까지 텔레그램/PWA와 동일 정합. schedules.db 직접 조작 금지(정합 깨짐).
interface ScheduleOpts { id?: string; category?: string; cron?: string; command?: string; apm?: string; json?: boolean; dryRun?: boolean; from?: string; to?: string; yes?: boolean; only?: string }

export type ScheduleDispatch = (args: Record<string, unknown>) => Promise<unknown>;
type ScheduleExit = (code: number) => void;
type SchedulePlanValue<T> = { found: T } | { missing: string };
type ScheduleCreatePlan = {
  schedule: SchedulePlanValue<string>;
  commands: SchedulePlanValue<string[]>;
  resultPath: SchedulePlanValue<string>;
  cron: SchedulePlanValue<string>;
};
type ParsedScheduleCreatePlan = { from: string; plan: ScheduleCreatePlan } | { error: string };

async function parseScheduleCreatePlan(from?: string): Promise<ParsedScheduleCreatePlan> {
  if (!from) return { error: '명세 문서 경로를 --from으로 지정해야 합니다.' };

  let specification: string;
  try {
    specification = await readFile(from, 'utf8');
  } catch {
    return { error: `명세 문서를 읽을 수 없음: ${from}` };
  }

  const schedule = specification.match(/^\s*-\s*\*\*주기:\*\*\s*(.+?)(?:\.|$)/m)?.[1]?.trim();
  const commands = [...specification.matchAll(/^\s*bun bin\/elanous\.mjs\s+(.+)$/gm)].map(match => match[1].trim());
  const resultPath = specification.match(/^(reports\/[^\s`]+)$/m)?.[1];
  const cron = specification.match(/^\s*(?:-\s*)?cron\s*:\s*`?([^`\n]+)`?\s*$/mi)?.[1]?.trim();
  return {
    from,
    plan: {
      schedule: schedule ? { found: schedule } : { missing: '주기' },
      commands: commands.length > 0 ? { found: commands } : { missing: '실행 명령' },
      resultPath: resultPath ? { found: resultPath } : { missing: '결과 경로' },
      cron: cron ? { found: cron } : { missing: '명세에 cron 식이 없음' },
    },
  };
}

export async function scheduleCreatePlan(opts: Pick<ScheduleOpts, 'dryRun' | 'from'>): Promise<unknown> {
  const parsed = await parseScheduleCreatePlan(opts.from);
  if ('error' in parsed) {
    return { error: opts.from ? parsed.error : 'dry-run에는 명세 문서 경로를 --from으로 지정해야 합니다.' };
  }
  const { from, plan } = parsed;
  if ('missing' in plan.schedule || 'missing' in plan.commands) {
    return { error: '명세에 등록 계획의 필수 주기 또는 실행 명령이 없음', from, plan };
  }
  return {
    dryRun: true,
    from,
    plan,
    note: '명세에서 등록 계획만 산출했습니다. 스케줄 저장소와 crontab은 변경하지 않았습니다.',
  };
}

export async function runSchedule(action: string, opts: ScheduleOpts, dispatch?: ScheduleDispatch, exit: ScheduleExit = process.exit): Promise<void> {
  let result: unknown;
  if (['migrate', 'adopt', 'release', 'delete'].includes(action) && opts.yes !== true) {
    result = { dryRun: true, action, id: opts.id, note: '적용하려면 --yes 를 붙인다' };
  } else if (action === 'retarget') {
    const { retargetScheduleFolders } = await import('../domains/schedule-retarget-action.js');
    result = retargetScheduleFolders({ from: opts.from, to: opts.to, yes: opts.yes === true, ...(opts.only ? { only: opts.only } : {}) });
  } else if (action === 'create' && opts.dryRun) {
    result = await scheduleCreatePlan(opts);
  } else if (action === 'create' && opts.from) {
    const parsed = await parseScheduleCreatePlan(opts.from);
    if ('error' in parsed) {
      result = parsed;
    } else {
      const requiredPlanFields = [
        ['schedule', parsed.plan.schedule],
        ['commands', parsed.plan.commands],
        ['resultPath', parsed.plan.resultPath],
        ['cron', parsed.plan.cron],
      ] as const;
      const missing = requiredPlanFields
        .filter(([, value]) => 'missing' in value)
        .map(([field]) => field);
      if (missing.length > 0) {
        result = { error: `명세 등록을 거부했습니다: ${missing.join(', ')}`, from: parsed.from, plan: parsed.plan };
      } else if (
        'found' in parsed.plan.schedule
        && 'found' in parsed.plan.commands
        && 'found' in parsed.plan.resultPath
        && 'found' in parsed.plan.cron
      ) {
        result = await (dispatch ?? (await import('../domains/schedule-manage-tool.js')).dispatchScheduleManage)({
          action,
          id: opts.id,
          category: opts.category,
          cron: parsed.plan.cron.found,
          command: parsed.plan.commands.found.map(command => `bun bin/elanous.mjs ${command}`).join(' && '),
          schedule: parsed.plan.schedule.found,
          resultPath: parsed.plan.resultPath.found,
          yes: true,
          ...(opts.apm ? { autopilotId: opts.apm } : {}),
        });
      } else {
        result = { error: '명세 등록 계획을 읽을 수 없음', from: parsed.from, plan: parsed.plan };
      }
    }
  } else {
    result = await (dispatch ?? (await import('../domains/schedule-manage-tool.js')).dispatchScheduleManage)({
      action, id: opts.id, category: opts.category, cron: opts.cron, command: opts.command,
      // 오토파일럿 계보(AL2) — --apm 으로 미션에 fan-in 태깅(관측성). dispatch 가 setScheduleMission.
      ...(opts.apm ? { autopilotId: opts.apm } : {}),
      // wrap/unwrap(P3 관측성 래핑) — --yes 로 적용(기본 dry-run).
      ...((opts as { yes?: boolean }).yes ? { yes: true } : {}),
    });
  }
  const isErr = !!result && typeof result === 'object' && 'error' in (result as object);
  if (opts.json) {
    await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
  } else if (isErr) {
    ui.error(String((result as { error: string }).error));
  } else if (action === 'list' && result && typeof result === 'object' && 'schedules' in result) {
    const r = result as { schedules: Array<{ id: string; name: string; cron: string | null; interval_ms: number | null; category: string; enabled: boolean; run_via: string; last_run: string | null }>; count: number };
    ui.header(`schedules (${r.count})`);
    for (const s of r.schedules) {
      const when = s.cron ?? (s.interval_ms ? `${Math.round(s.interval_ms / 1000)}s` : '?');
      const flag = s.enabled ? '' : ' [disabled]';
      console.log(`  ${s.id.padEnd(14)}  ${when.padEnd(18)}  [${s.category}·${s.run_via}]${flag}  ${s.name}`);
      if (s.last_run) console.log(`              last_run ${s.last_run}`);
    }
  } else {
    await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
  }
  exit(isErr ? 1 : 0);
}

export function registerScheduleCommands(program: Command): void {
  const scheduleCmd = program.command('schedule')
    .description('스케줄/크론 CRUD (registry·crontab·기억 정합). --json 으로 프로그래매틱 소비.');

scheduleCmd.command('list').description('전체 크론 조회(category 필터)')
  .option('--category <cat>', 'ingest|monitor|report|alert|digest|maintenance')
  .option('--json', 'JSON 출력(프로그래매틱)')
  .action((o: ScheduleOpts) => runSchedule('list', o));
scheduleCmd.command('inspect <id>').description('상세 + 최근발송(surface_events 회상·S3 폐루프)')
  .option('--json').action((id: string, o: ScheduleOpts) => runSchedule('inspect', { ...o, id }));
scheduleCmd.command('create').description('신규 크론(cron 식 + command). 자동 백업·cd/bun/로그 보강.')
  .option('--cron <expr>', 'cron 식(예: "0 7 * * *")')
  .option('--command <cmd>', 'command(예: "scripts/foo.ts --x")')
  .option('--dry-run', '명세에서 등록 계획만 산출하고 등록하지 않음')
  .option('--from <path>', '명세 문서에서 등록 계획을 읽음(--dry-run이면 계획만 산출)')
  .option('--apm <id>', '오토파일럿 미션 fan-in 태깅(관측성·autopilot_id)')
  .option('--json').action((o: ScheduleOpts) => {
    if (!o.dryRun && !o.from && (!o.cron || !o.command)) throw new Error('create에는 --cron과 --command가 필요합니다.');
    return runSchedule('create', o);
  });
scheduleCmd.command('update <id>').description('cron 시간 변경')
  .requiredOption('--cron <expr>', '새 cron 식').option('--json')
  .action((id: string, o: ScheduleOpts) => runSchedule('update', { ...o, id }));
scheduleCmd.command('enable <id>').description('잡 켜기').option('--json')
  .action((id: string, o: ScheduleOpts) => runSchedule('enable', { ...o, id }));
scheduleCmd.command('disable <id>').description('잡 끄기(주석)').option('--json')
  .action((id: string, o: ScheduleOpts) => runSchedule('disable', { ...o, id }));
scheduleCmd.command('delete <id>').description('삭제(자동 백업·복구 가능). 기본 dry-run·--yes 적용').option('--yes', '적용(기본 dry-run)').option('--json')
  .action((id: string, o: ScheduleOpts) => runSchedule('delete', { ...o, id }));
scheduleCmd.command('wrap [id]').description('★관측성 래핑 — bun .ts 크론을 cron-run.ts 로 감싸 파이어 시 3계층(logs.db·레지스트리·자기기억) 기록. id 생략=전 .ts 크론. 기본 dry-run·--yes 적용(백업 자동·unwrap-aware id 승계·가역)').option('--yes', '적용(기본 dry-run)').option('--json')
  .action((id: string | undefined, o: ScheduleOpts) => runSchedule('wrap', { ...o, ...(id ? { id } : {}) }));
scheduleCmd.command('unwrap [id]').description('관측성 래퍼 제거(가역) — id 생략=전 래핑 크론. 기본 dry-run·--yes 적용').option('--yes', '적용(기본 dry-run)').option('--json')
  .action((id: string | undefined, o: ScheduleOpts) => runSchedule('unwrap', { ...o, ...(id ? { id } : {}) }));
scheduleCmd.command('migrate <id>').description('fabric Schedule Trigger 로 이관(elanous 데몬 발화·Mission Fabric B안). 기본 dry-run·--yes 적용').option('--yes', '적용(기본 dry-run)').option('--json')
  .action((id: string, o: ScheduleOpts) => runSchedule('migrate', { ...o, id }));
scheduleCmd.command('adopt <id>').description('=migrate 별칭(schedule-runner 은퇴로 통합). 기본 dry-run·--yes 적용').option('--yes', '적용(기본 dry-run)').option('--json')
  .action((id: string, o: ScheduleOpts) => runSchedule('adopt', { ...o, id }));
scheduleCmd.command('release <id>').description('crontab 실행으로 복원. 기본 dry-run·--yes 적용').option('--yes', '적용(기본 dry-run)').option('--json')
  .action((id: string, o: ScheduleOpts) => runSchedule('release', { ...o, id }));
scheduleCmd.command('retarget').description('크론 cd <folder> 일괄 교체 — --from 폴더를 --to 폴더로. 기본 dry-run·--yes 적용(백업 자동). 대상 폴더가 없으면 에러.')
  .option('--from <folder>', '바꿀 원본 폴더(cd 경로)')
  .option('--to <folder>', '새 대상 폴더(존재해야 함)')
  .option('--only <ids>', '이 잡들만(쉼표 구분 · schedule list 의 id 접두 또는 이름 · 각각 정확히 하나에 맞아야 함)')
  .option('--yes', '적용(기본 dry-run)')
  .option('--json')
  .action((o: ScheduleOpts) => runSchedule('retarget', o));
}
