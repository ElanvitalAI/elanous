import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { getTestStateRoot } from '../nexus/paths.js';
import { runReleaseSimRigIfFile } from '../ux-sim/release-sim-rig.js';
import { runScenarioFile } from '../ux-sim/scenario.js';
import { loadMockScenarioCatalog, renderMockScenarioDevices } from '../ux-sim/mock-scenario-catalog.js';
import { createWorld, destroyWorldById, loadWorld, runWorldScenario } from '../ux-sim/world.js';
import { createSimWorld, destroySimWorld, listSimWorlds } from '../ux-sim/world-store.js';
import { parseSimWorld } from '../ux-sim/world-schema.js';

export function registerSimCommands(program: Command): void {
  const sim = program.command('sim').description('격리 시나리오를 실행하고 화면·로그 기대값을 대조한다');
  sim.command('run <scenario-file>')
    .description('등록된 UX simulation 시나리오를 test 우주에서 실행한다')
    .action(async (scenarioFile: string) => {
      try {
        // Enforce isolation before either runner inspects the supplied path. Otherwise
        // release-graph dispatch can leak a path-validation error outside test mode.
        if (!getTestStateRoot()) throw new Error('scenario runner requires --test isolated mode');
        const releaseResult = await runReleaseSimRigIfFile(scenarioFile);
        const result = releaseResult ?? await runScenarioFile(scenarioFile);
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
  sim.command('devices')
    .description('정본 목장치 카탈로그를 읽기 전용으로 조회한다')
    .option('--json', '카탈로그 JSON 출력')
    .action((opts: { json?: boolean }) => {
      const catalog = loadMockScenarioCatalog();
      console.log(opts.json ? JSON.stringify(catalog, null, 2) : renderMockScenarioDevices(catalog).join('\n'));
    });
  const world = sim.command('world').description('test 우주 안에서 독립 시뮬레이션 작업공간과 선언형 세계를 다룬다');
  world.command('validate <world-yaml>')
    .description('선언형 world YAML을 mock catalog에 대조해 검증한다')
    .action((worldYaml: string) => {
      try {
        if (!getTestStateRoot()) throw new Error('world validation requires --test isolated mode');
        console.log(JSON.stringify(parseSimWorld(readFileSync(worldYaml, 'utf8'))));
      } catch (error) {
        console.error(`sim world validate: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  world.command('create <id>')
    .description('빈 격리 시뮬레이션 작업공간을 만든다')
    .action((id: string) => {
      try {
        console.log(JSON.stringify(createSimWorld(id)));
      } catch (error) {
        console.error(`sim world create: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  world.command('create-yaml <world-file>')
    .description('선언 YAML에서 catalog fake를 조립한 test 격리 세계를 만든다')
    .action(async (worldFile: string) => {
      try {
        const created = await createWorld(worldFile);
        console.log(JSON.stringify({ id: created.id, root: created.root, devices: created.spec.devices }));
      } catch (error) {
        console.error(`sim world create-yaml: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  world.command('run <world-id> <scenario-file>')
    .description('생성된 세계에서 YAML 사건 주입 시나리오를 실행한다')
    .action(async (worldId: string, scenarioFile: string) => {
      try {
        const current = loadWorld(worldId);
        const result = await runWorldScenario(current, scenarioFile);
        console.log(JSON.stringify(result));
        if (!result.pass) process.exitCode = 1;
      } catch (error) {
        console.error(`sim world run: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  world.command('destroy <world-id>')
    .description('빈 격리 시뮬레이션 작업공간을 제거한다')
    .action((worldId: string) => {
      try {
        console.log(JSON.stringify({ id: worldId, destroyed: destroySimWorld(worldId) }));
      } catch (error) {
        console.error(`sim world destroy: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  world.command('destroy-yaml <world-id>')
    .description('YAML 선언형 test 세계 하나와 그 안의 산출물을 제거한다')
    .action(async (worldId: string) => {
      try {
        await destroyWorldById(worldId);
        console.log(JSON.stringify({ id: worldId, destroyed: true }));
      } catch (error) {
        console.error(`sim world destroy-yaml: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  world.command('list')
    .description('완전한 시뮬레이션 작업공간을 조회한다')
    .action(() => {
      try {
        console.log(JSON.stringify(listSimWorlds()));
      } catch (error) {
        console.error(`sim world list: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
}
