import type { Command } from 'commander';
import { runScenarioFile } from '../ux-sim/scenario.js';

export function registerSimCommands(program: Command): void {
  const sim = program.command('sim').description('격리 시나리오를 실행하고 화면·로그 기대값을 대조한다');
  sim.command('run <scenario-file>')
    .description('등록된 UX simulation 시나리오를 test 우주에서 실행한다')
    .action(async (scenarioFile: string) => {
      try {
        const result = await runScenarioFile(scenarioFile);
        console.log(JSON.stringify(result));
        if (!result.pass) process.exitCode = 1;
      } catch (error) {
        console.error(`sim run: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  // SIM-EVENT-MONKEY — 사건 주입(L0). ⛔ 모듈은 액션 안에서만 불러온다(다른 명령 기동 경로에 안 올라오게).
  sim.command('emit <kind>')
    .allowExcessArguments(false)
    .description('격리 test 우주 원장·logs.db 에 주입 사건을 쓴다(L0) — 종류는 `sim kinds`')
    .option('--run <id>', '기존 런 원장에 덧붙인다(없으면 새 run-<uuid>)')
    .option('--variant <variant>', 'same-cell 전용: allowed | refused')
    .option('--json', '구조화 출력')
    .action(async (kind: string, opts: { run?: string; variant?: string; json?: boolean }) => {
      const { runEventMonkeyCli } = await import('../ux-sim/event-monkey.js');
      const out = runEventMonkeyCli({ kindName: kind, json: opts.json === true,
        ...(opts.run ? { runId: opts.run } : {}), ...(opts.variant ? { variant: opts.variant } : {}) });
      for (const line of out.stdout) console.log(line);
      for (const line of out.stderr) console.error(line);
      process.exitCode = out.code;
    });
  sim.command('kinds')
    .description('주입할 수 있는 사건 종류 · 별칭 · 읽어야 할 소비자')
    .option('--json', '구조화 출력')
    .action(async (opts: { json?: boolean }) => {
      const { renderEventMonkeyKinds } = await import('../ux-sim/event-monkey.js');
      console.log(renderEventMonkeyKinds(opts.json === true).join('\n'));
    });
}
