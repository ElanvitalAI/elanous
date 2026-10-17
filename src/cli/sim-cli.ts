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
}
