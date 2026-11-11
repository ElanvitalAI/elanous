import type { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getTestStateRoot, nexusRootDir, setTestStateRoot } from '../nexus/paths.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import { validateAppSimulation } from '../nexus/apps/app-simulate.js';
import { runScenarioFile } from '../ux-sim/scenario.js';
import { buildMockScenarioUserPackage, loadMockScenarioCatalog, renderMockScenarioDevices } from '../ux-sim/mock-scenario-catalog.js';
import { createWorld, createWorldRegressionTargetRunner, destroyWorldById, loadWorld, parseSimWorld, runWorldScenario } from '../ux-sim/world.js';
import { createSimWorld, destroySimWorld, listSimWorlds } from '../ux-sim/world-store.js';
import { restoreSimWorld, snapshotSimWorld } from '../ux-sim/world-snapshot.js';
import { listMockDeviceRequests, renderMockDeviceRequests, requestMockDevice } from '../ux-sim/mock-device-requests.js';
import { compareDeviceRecording, deviceFidelityStatus } from '../ux-sim/device-fidelity.js';
import { readSimCoverage } from '../ux-sim/sim-coverage.js';
import { readSimWorldWatchEvents, renderSimWorldWatchEvent } from '../ux-sim/world-watch.js';
import { assertNetworkZeroSandboxAvailable } from '../ux-sim/network-sandbox.js';
import { assertRealTargetGuards, assertScenarioTargetAllowed, resolveScenarioTarget, type ScenarioTargetDeclaration } from '../ux-sim/scenario-target.js';
import { registerSimSuggestCommand } from './sim-suggest-cli.js';

type UserSimulationProfile = { credentials: string; network: string; storage: string };
type SimAppCliCommand = (args: string[], allowedStatus?: readonly number[]) => Promise<{ status: number; stdout: string; stderr?: string }>;
type SimAppRuntime = {
  assertNetworkIsolation?: typeof assertNetworkZeroSandboxAvailable;
  executeCli?: SimAppCliCommand;
};
/** Create an isolated child environment from runtime essentials, excluding host credentials and connection strings. */
export function createUserSimulationEnvironment(
  profiles: readonly UserSimulationProfile[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const testStateRoot = getTestStateRoot();
  if (!testStateRoot) throw new Error('sim app requires --test isolated mode');
  if (profiles.some((profile) => profile.credentials !== 'fake-only'
    || profile.network !== 'loopback-only' || profile.storage !== 'temporary')) {
    throw new Error('user simulation device does not provide the mandatory safe default profile');
  }
  const allowedEnv = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV',
    'ELANOUS_STATE_DIR', 'ELANOUS_CONFIG_DIR', 'LANG', 'LC_ALL', 'TZ']);
  return { ...Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => allowedEnv.has(key))), NODE_ENV: sourceEnv.NODE_ENV ?? 'test', ELANOUS_STATE_DIR: testStateRoot, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(testStateRoot, sourceEnv) };
}

export function registerSimCommands(program: Command, simAppRuntime: SimAppRuntime = {}): void {
  const sim = program.command('sim').description('격리 시나리오를 실행하고 화면·로그 기대값을 대조한다');
  sim.command('app <app>')
    .description('app.yaml 선언을 기존 가짜 장치 세계에서 실행하고 결과·영수증을 남긴다')
    .option('--scenario <name>', '실행할 선언 시나리오 이름')
    .option('--list', '선언된 시나리오 목록만 출력')
    .option('--json', '구조화 결과 출력')
    .action(async (app: string, options: { scenario?: string; list?: boolean; json?: boolean }) => {
      try {
        const stateRoot = getTestStateRoot();
        if (!stateRoot) throw new Error('sim app requires --test isolated mode');
        const appDir = isAbsolute(app) || app.includes('/') || app.includes('\\')
          ? resolve(app) : join(nexusRootDir(), 'apps', app);
        const appYaml = readFileSync(join(appDir, 'app.yaml'), 'utf8');
        const parsed = parseAppManifest(appYaml);
        if (!parsed.ok) throw new Error(`invalid app.yaml: ${parsed.errors.map((issue) => `${issue.path}: ${issue.reason}`).join('; ')}`);
        const manifest = parsed.manifest;
        const simulationIssues = validateAppSimulation(manifest.simulate, {
          actions: Object.keys((manifest.actions as Record<string, unknown> | undefined) ?? {}),
          rpc: Object.keys((manifest.rpc as Record<string, unknown> | undefined) ?? {}),
          roles: Object.keys((manifest.roles as Record<string, unknown> | undefined) ?? {}),
          tables: Object.keys((manifest.tables as Record<string, unknown> | undefined) ?? {}),
        });
        if (simulationIssues.length) throw new Error(`invalid simulate declaration: ${simulationIssues.map((issue) => `${issue.path}: ${issue.reason}`).join('; ')}`);
        const scenarios = (manifest.simulate as { scenarios?: Array<{ name: string }> } | undefined)?.scenarios ?? [];
        const connectorDeclarations = (manifest.simulate as { connectors?: Record<string, { fake: string; profile?: string }> } | undefined)?.connectors ?? {};
        const packageDevices = buildMockScenarioUserPackage(loadMockScenarioCatalog());
        const packageDeviceByAlias: Record<string, string> = {
          'generate-job': 'fake-higgsfield', stt: 'SIM-FAKE-PROVIDERS-AV', tts: 'SIM-FAKE-PROVIDERS-AV',
          'object-store': 'fake-app-storage', payment: 'fake-payment', 'share-link': 'fake-app-auth',
        };
        const deviceProfiles = Object.fromEntries(Object.entries(connectorDeclarations).map(([connector, declaration]) => {
          const deviceId = packageDeviceByAlias[declaration.fake];
          const packagedDevice = packageDevices.find((device) => device.id === deviceId);
          if (!packagedDevice) throw new Error(`connector ${connector} has no packaged user simulation device: ${declaration.fake}`);
          return [connector, { device: packagedDevice.id, selectedProfile: declaration.profile ?? 'ok', defaultProfile: packagedDevice.defaultProfile }];
        }));
        if (options.list) {
          if (options.json) console.log(JSON.stringify({ app: manifest.slug, scenarios, deviceProfiles }));
          else for (const scenario of scenarios) console.log(scenario.name);
          return;
        }
        if (options.scenario && !scenarios.some((scenario) => scenario.name === options.scenario)) {
          throw new Error(`unknown scenario: ${options.scenario}`);
        }
        const { runDeclaredAppSimulation } = await import('../nexus/apps/app-simulation-runner.js');
        const simulationEnv = createUserSimulationEnvironment(Object.values(deviceProfiles).map((row) => row.defaultProfile));
        (simAppRuntime.assertNetworkIsolation ?? assertNetworkZeroSandboxAvailable)(simulationEnv);
        const result = await runDeclaredAppSimulation({ manifest, appDirectory: appDir, ...(options.scenario ? { scenarioName: options.scenario } : {}) },
          { environment: simulationEnv, ...(simAppRuntime.executeCli ? { executeCli: simAppRuntime.executeCli } : {}) });
        const appFingerprint = createHash('sha256').update(appYaml).digest('hex');
        const receiptDir = join(resolve(stateRoot), 'sim', 'receipts', manifest.slug);
        mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
        const runId = result.scenarios.map((scenario) => scenario.result.runId).join('_');
        const receiptPath = join(receiptDir, `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
        const receipt = { app: manifest.slug, appFingerprint, runId, passed: result.passed,
          scenarios: result.scenarios.map((scenario) => ({ scenario: scenario.name, status: scenario.passed ? 'passed' as const : 'failed' as const, failedExpectations: scenario.failedExpectations })),
          devices: Object.values(deviceProfiles).map((row) => row.device), deviceProfiles,
          results: result.scenarios.map((scenario) => ({ scenario: scenario.name, events: scenario.result.events,
            evidence: scenario.evidence, receipts: scenario.result.receipts, externalNetworkEvents: scenario.externalNetworkEvents })),
          createdAt: new Date().toISOString() };
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        if (!result.passed) process.exitCode = 1;
        if (options.json) console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2));
        else {
          console.log(`시나리오 | 결과`);
          for (const row of receipt.scenarios) console.log(`${row.scenario} | ${row.status}`);
          console.log(`영수증 | ${receiptPath}`);
        }
      } catch (error) {
        console.error(`sim app: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
  registerSimSuggestCommand(sim);
  sim.command('suite <folder>')
    .description('시나리오 묶음의 정규화 영수증을 기준과 대조한다')
    .option('--target <target>', 'sim 또는 real')
    .option('--update-baseline', '결정론 확인 후 기준 영수증 갱신')
    .action(async (folder: string, opts: { target?: string; updateBaseline?: boolean }) => {
      const priorRoot = getTestStateRoot();
      const ownedRoot = priorRoot ? null : mkdtempSync(join(tmpdir(), 'elanous-sim-suite-'));
      try {
        if (ownedRoot) setTestStateRoot(ownedRoot);
        const suiteTarget = opts.target ?? 'sim';
        if (suiteTarget !== 'sim' && suiteTarget !== 'real') throw new Error('suite target must be sim or real');
        const { discoverSuiteCases, runWorldRegressionSuite } = await import('../ux-sim/world-regression-suite.js');
        const cases = discoverSuiteCases(folder, suiteTarget);
        for (const item of cases) {
          const value = parseYaml(readFileSync(item.scenarioFile, 'utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`scenario must be an object: ${item.scenarioFile}`);
          const scenario = value as Record<string, unknown>;
          const selection = resolveScenarioTarget(scenario.target, opts.target);
          assertScenarioTargetAllowed(selection.target, priorRoot);
          assertRealTargetGuards({ target: scenario.target as ScenarioTargetDeclaration['target'],
            real: scenario.real as ScenarioTargetDeclaration['real'] }, opts.target);
          if (selection.target === 'real') throw new Error('real scenario execution requires R-FRAG-2 world runner wiring');
        }
        const targetRunner = createWorldRegressionTargetRunner();
        const run = suiteTarget === 'sim' || (suiteTarget === 'real' && process.env.ELANOUS_SIM_REAL_TARGET_ADAPTER)
          ? targetRunner.run : undefined;
        const result = await runWorldRegressionSuite({ folder, target: suiteTarget, updateBaseline: opts.updateBaseline,
          ...(run ? { run } : {}) });
        if (result.differences.length === 0) console.log(`suite ${result.scenarios} scenario(s): no differences`);
        else for (const difference of result.differences) console.log(JSON.stringify(difference));
        if (!result.pass) process.exitCode = 1;
      } catch (error) {
        console.error(`sim suite: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      } finally {
        if (ownedRoot) {
          setTestStateRoot(null);
          rmSync(ownedRoot, { recursive: true, force: true });
        }
      }
    });
  sim.command('run <scenario-file>')
    .description('등록된 UX simulation 시나리오를 test 우주에서 실행한다')
    .action(async (scenarioFile: string) => {
      try {
        // Enforce isolation before either runner inspects the supplied path. Otherwise
        // release-graph dispatch can leak a path-validation error outside test mode.
        if (!getTestStateRoot()) throw new Error('scenario runner requires --test isolated mode');
        // The release graph rig is only needed when a scenario is run, not to register sim commands.
        const { runReleaseSimRigIfFile } = await import('../ux-sim/release-sim-rig.js');
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
    .option('--user-package', '내부 장치 중 사용자 앱 커넥터용 패키지만 조회')
    .option('--json', '카탈로그 JSON 출력')
    .action(async (opts: { json?: boolean; missing?: boolean; userPackage?: boolean }) => {
      if (opts.userPackage && opts.missing) {
        console.error('sim devices: --user-package cannot be combined with --missing');
        // Source: #36308 defines invalid sim-device option combinations as a CLI usage error.
        process.exitCode = 2;
        return;
      }
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
      if (opts.userPackage) {
        const devices = buildMockScenarioUserPackage(catalog);
        console.log(opts.json ? JSON.stringify({ devices }, null, 2) : devices.map((device) => `${device.id}\t${device.name}\t${device.scenarios.length} scenarios · ${device.decisionCases.length} decision cases · declared defaults: ${device.defaultProfile.credentials}/${device.defaultProfile.network}/${device.defaultProfile.storage}`).join('\n'));
        return;
      }
      if (opts.json) {
        // Large catalog snapshots can exceed a single pipe write; wait for the full payload.
        await new Promise<void>((resolve, reject) => {
          process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`, (error) => error ? reject(error) : resolve());
        });
      } else console.log(renderMockScenarioDevices(catalog).join('\n'));
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
