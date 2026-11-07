import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { getTestStateRoot } from '../nexus/paths.js';
import { runReleaseSimRigIfFile } from '../ux-sim/release-sim-rig.js';
import { runScenarioFile } from '../ux-sim/scenario.js';
import { loadMockScenarioCatalog, renderMockScenarioDevices } from '../ux-sim/mock-scenario-catalog.js';
import { createWorld, destroyWorldById, loadWorld, runWorldScenario } from '../ux-sim/world.js';
import { createSimWorld, destroySimWorld, listSimWorlds } from '../ux-sim/world-store.js';
import { restoreSimWorld, snapshotSimWorld } from '../ux-sim/world-snapshot.js';
import { parseSimWorld } from '../ux-sim/world-schema.js';
import { listMockDeviceRequests, renderMockDeviceRequests, requestMockDevice } from '../ux-sim/mock-device-requests.js';
import { compareDeviceRecording, deviceFidelityStatus } from '../ux-sim/device-fidelity.js';
import { readSimCoverage } from '../ux-sim/sim-coverage.js';
import { readSimWorldWatchEvents, renderSimWorldWatchEvent } from '../ux-sim/world-watch.js';

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
  sim.command('inject <spec-file>')
    .description('임의 원장·관측 사건을 운영 writer로 격리 test 우주에 주입한다(JSON)')
    .option('--run <id>', '기존 런 원장에 덧붙인다')
    .option('--json', '구조화 출력')
    .action(async (specFile: string, opts: { run?: string; json?: boolean }) => {
      const { injectAnyEvent, resolveEventMonkeyRoot, EventMonkeyRefusedError } = await import('../ux-sim/event-monkey.js');
      try {
        const spec = JSON.parse(readFileSync(specFile, 'utf8')) as Parameters<typeof injectAnyEvent>[0];
        const result = injectAnyEvent({ ...spec, stateRoot: resolveEventMonkeyRoot(), ...(opts.run ? { runId: opts.run } : {}) });
        console.log(opts.json ? JSON.stringify({ ok: true, ...result, level: 'L0' }) : `주입 ${result.injectionId} · run ${result.runId} · 원장 ${result.ledgerPath} · 관측 ${result.debugRows.length}줄`);
      } catch (error) {
        if (error instanceof EventMonkeyRefusedError) process.exitCode = 3;
        else process.exitCode = 2;
        console.error(`sim inject: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  sim.command('kinds')
    .description('주입할 수 있는 사건 종류 · 별칭 · 읽어야 할 소비자')
    .option('--json', '구조화 출력')
    .action(async (opts: { json?: boolean }) => {
      const { renderEventMonkeyKinds } = await import('../ux-sim/event-monkey.js');
      console.log(renderEventMonkeyKinds(opts.json === true).join('\n'));
    });
  const devices = sim.command('devices')
    .description('정본 목장치 카탈로그를 읽기 전용으로 조회한다')
    .option('--missing', 'test 우주에 기록된 미해결 mock 장치 요청 조회')
    .option('--json', '카탈로그 JSON 출력')
    .action((opts: { json?: boolean; missing?: boolean }) => {
      if (opts.missing) {
        try {
          const rows = listMockDeviceRequests();
          console.log(opts.json ? JSON.stringify({ missing: rows.filter((row) => row.state === 'missing'), resolved: rows.filter((row) => row.state === 'resolved') }, null, 2) : renderMockDeviceRequests(rows));
        } catch (error) {
          console.error(`sim devices --missing: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 2;
        }
        return;
      }
      const catalog = loadMockScenarioCatalog();
      console.log(opts.json ? JSON.stringify(catalog, null, 2) : renderMockScenarioDevices(catalog).join('\n'));
    });
  devices.command('request <cellId>')
    .description('test 우주에 필요한 mock 장치와 미충족 경계를 기록한다')
    .requiredOption('--boundary <boundary>', '미충족 경계')
    .requiredOption('--nearest <deviceId>', '가장 가까운 기존 mock 장치 ID')
    .option('--json', '구조화 출력')
    .action((cellId: string, opts: { boundary: string; nearest: string; json?: boolean }, command) => {
      const json = opts.json === true || command.optsWithGlobals().json === true;
      try {
        const row = requestMockDevice({ cellId, boundary: opts.boundary, nearestDeviceId: opts.nearest });
        console.log(json ? JSON.stringify(row, null, 2) : `mock device request ${row.id}: ${row.cellId} ${row.state}`);
      } catch (error) {
        console.error(`sim devices request: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  const fidelity = sim.command('fidelity').description('실물 녹음과 가짜 장치 응답을 대조하고 sim 판정에 반영한다');
  fidelity.command('compare <recording-file>')
    .description('기록된 GitHub API 응답을 fake-github 장치로 재생해 대조한다')
    .action((recordingFile: string) => {
      try {
        if (!getTestStateRoot()) throw new Error('sim fidelity requires --test isolated mode');
        const result = compareDeviceRecording(JSON.parse(readFileSync(recordingFile, 'utf8')));
        console.log(JSON.stringify(result));
        if (!result.passed) process.exitCode = 1;
      } catch (error) {
        console.error(`sim fidelity compare: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  fidelity.command('status <device-id>')
    .description('장치별 최근 녹음 대조 상태를 조회한다')
    .action((deviceId: string) => {
      try {
        if (!getTestStateRoot()) throw new Error('sim fidelity requires --test isolated mode');
        console.log(JSON.stringify({ deviceId, ...deviceFidelityStatus(deviceId) }));
      } catch (error) {
        console.error(`sim fidelity status: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  sim.command('coverage')
    .description('test 우주 실행의 코드 경로·사건·장치 지문 덮음과 미충족 장치 요청을 조회한다')
    .option('--json', '구조화 출력')
    .action((opts: { json?: boolean }, command) => {
      try {
        if (!getTestStateRoot()) throw new Error('sim coverage requires --test isolated mode');
        const report = readSimCoverage();
        if (opts.json === true || command.optsWithGlobals().json === true) console.log(JSON.stringify(report, null, 2));
        else {
          console.log(`runs ${report.runCount} · code paths ${report.codePathCoverage.covered}/${report.codePathCoverage.total} (${report.codePathCoverage.percent}%) · events ${report.eventCoverage.covered}/${report.eventCoverage.total} (${report.eventCoverage.percent}%) · devices ${report.deviceCoverage.fingerprinted}/${report.deviceCoverage.total} (${report.deviceCoverage.percent}%)`);
          for (const path of report.uncoveredPaths) console.log(`uncovered ${path.path} · devices ${path.deviceIds.join(',')} · runs ${path.coveredRuns}`);
        }
      } catch (error) {
        console.error(`sim coverage: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  const world = sim.command('world').description('test 우주 안에서 독립 시뮬레이션 작업공간과 선언형 세계를 다룬다');
  sim.command('watch <world-id>')
    .description('시뮬 월드의 실행 중 관측 사건을 실시간으로 읽는다(test 우주 전용)')
    .option('--once', '현재까지 기록된 사건만 출력하고 종료한다')
    .action(async (worldId: string, opts: { once?: boolean }) => {
      try {
        if (!getTestStateRoot()) throw new Error('sim watch requires --test isolated mode');
        const current = loadWorld(worldId);
        let offset = 0;
        const drain = () => {
          const batch = readSimWorldWatchEvents(current, offset);
          offset = batch.offset;
          for (const event of batch.events) console.log(renderSimWorldWatchEvent(event));
        };
        drain();
        if (opts.once) return;
        const stop = new AbortController();
        const onInterrupt = () => stop.abort();
        process.once('SIGINT', onInterrupt);
        try {
          while (!stop.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            drain();
          }
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      } catch (error) {
        console.error(`sim watch: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
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
    .description('test 우주에 mock catalog의 MD 소스 모듈을 조립한 작업공간을 만든다')
    .action((id: string) => {
      try {
        console.log(JSON.stringify(createSimWorld(id)));
      } catch (error) {
        console.error(`sim world create: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  world.command('snapshot <world-id>')
    .description('format-1 world 상태를 검증 가능한 snapshot으로 저장한다(test 우주 전용)')
    .option('--name <snapshot-id>', 'snapshot 이름(생략하면 UUID)')
    .action((worldId: string, opts: { name?: string }) => {
      try {
        console.log(JSON.stringify(snapshotSimWorld(worldId, opts.name)));
      } catch (error) {
        console.error(`sim world snapshot: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  world.command('restore <world-id> <snapshot-id>')
    .description('format-1 world의 state/config/fixtures/tmp를 snapshot 상태로 되돌린다(test 우주 전용)')
    .action((worldId: string, snapshotId: string) => {
      try {
        restoreSimWorld(worldId, snapshotId);
        console.log(JSON.stringify({ id: worldId, restored: snapshotId }));
      } catch (error) {
        console.error(`sim world restore: ${error instanceof Error ? error.message : String(error)}`);
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
  world.command('fork <world-id> <snapshot-id> <new-world-id>')
    .description('format-1 snapshot을 새 ID·생성 시각의 독립 test 세계로 복제한다(test 우주 전용)')
    .action(async (worldId: string, snapshotId: string, newWorldId: string) => {
      try {
        const { forkSimWorld } = await import('../ux-sim/world-snapshot.js');
        console.log(JSON.stringify(forkSimWorld(worldId, snapshotId, newWorldId)));
      } catch (error) {
        console.error(`sim world fork: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
}
