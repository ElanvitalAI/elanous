import { join, relative, resolve, sep } from 'node:path';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { spawnElanous } from '../../instance/spawn-elanous.js';
import { validateAppSimulationResult, type AppSimulationResult } from './app-simulation.js';
import { renderAppScreen } from './app-screen-render.js';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const SCENARIOS: Readonly<Record<string, string>> = {
  'voice-notes': 'scenarios/ux-sim/app-demo-1114.yaml',
  'shop-studio': 'scenarios/ux-sim/app-demo-1114.yaml',
  'lecture-scrap': 'scenarios/ux-sim/kaist-lecture-scrap-app.yaml',
};

type CliResult = { status: number; stdout: string; stderr?: string };
type CliCommand = (args: string[], allowedStatus?: readonly number[]) => Promise<CliResult>;
type AppSimulationOptions = {
  readonly executeCli?: CliCommand;
  readonly onStaticExport?: (files: Readonly<Record<string, string>>) => void;
  readonly environment?: NodeJS.ProcessEnv;
  readonly renderScreen?: typeof renderAppScreen;
};

export interface AppSimulationScenarioDeclaration {
  readonly name: string;
  readonly steps: readonly unknown[];
  readonly expect: readonly unknown[];
}

export interface AppSimulationScenarioEvidence {
  readonly events: readonly string[];
  readonly tableRows: Readonly<Record<string, number>>;
  readonly screenText: string;
  readonly screenStatus?: 'measured' | 'unmeasured';
  readonly screenUnmeasuredReason?: string;
  readonly browserDeniedUrls?: readonly string[];
}

export interface AppSimulationScenarioExecution {
  readonly result: AppSimulationResult;
  readonly evidence: AppSimulationScenarioEvidence;
  readonly runtimePassed?: boolean;
  /** True only when the world runner returned from its OS-network-sandboxed execution path. */
  readonly networkSandboxEstablished?: boolean;
  readonly externalNetworkEvents?: readonly { readonly url: string; readonly blocked: true }[];
}

export interface AppSimulationScenarioRun {
  readonly name: string;
  readonly passed: boolean;
  readonly failedExpectations: readonly string[];
  readonly networkSandboxEstablished: boolean;
  readonly externalNetworkAttempts: number | null;
  readonly blockedNetworkAttempts: number | null;
  readonly unmeasuredCount: number;
  readonly externalNetworkEvents: readonly { readonly url: string; readonly blocked: true }[];
  readonly evidence: AppSimulationScenarioEvidence;
  readonly result: AppSimulationResult;
}

export interface AppSimulationRun {
  readonly appSlug: string;
  readonly scenarios: readonly AppSimulationScenarioRun[];
  readonly passed: boolean;
  readonly networkEvidence: {
    readonly sandboxEstablished: boolean;
    readonly externalNetworkAttempts: number | null;
    readonly blockedNetworkAttempts: number | null;
    readonly unmeasuredCount: number;
  };
}

export type AppSimulationScenarioExecutor = (scenario: AppSimulationScenarioDeclaration) => Promise<AppSimulationScenarioExecution>;

function evaluateScenarioExpectations(
  scenario: AppSimulationScenarioDeclaration,
  evidence: AppSimulationScenarioEvidence,
): string[] {
  const failed: string[] = [];
  for (const [index, raw] of scenario.expect.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      failed.push(`expect[${index}] is not a supported expectation`);
      continue;
    }
    const expected = raw as Record<string, unknown>;
    if (typeof expected.event === 'string') {
      if (!evidence.events.includes(expected.event)) failed.push(`event:${expected.event}`);
    } else if (typeof expected.table === 'string' && Number.isSafeInteger(expected.rows)) {
      if (evidence.tableRows[expected.table] !== expected.rows) failed.push(`table:${expected.table} expected ${expected.rows} rows`);
    } else if (typeof expected['screen-text'] === 'string') {
      if (evidence.screenStatus === 'unmeasured') failed.push('screen-text:unmeasured');
      else if (!evidence.screenText.includes(expected['screen-text'])) failed.push(`screen-text:${expected['screen-text']}`);
    } else failed.push(`expect[${index}] is not a supported expectation`);
  }
  return failed;
}

function scenarioEvidenceIssue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'executor evidence must be an object';
  const evidence = value as Record<string, unknown>;
  if (!Array.isArray(evidence.events) || evidence.events.some((event) => typeof event !== 'string' || !event.trim())) {
    return 'executor evidence.events must be a list of non-empty strings';
  }
  if (!evidence.tableRows || typeof evidence.tableRows !== 'object' || Array.isArray(evidence.tableRows)) {
    return 'executor evidence.tableRows must be a table-to-row-count map';
  }
  for (const [table, rows] of Object.entries(evidence.tableRows as Record<string, unknown>)) {
    // Source: app-simulate contract requires nonnegative integer row counts for table expectations.
    if (!table.trim() || !Number.isSafeInteger(rows) || Number(rows) < 0) return 'executor evidence.tableRows values must be nonnegative integers';
  }
  if (typeof evidence.screenText !== 'string') return 'executor evidence.screenText must be text';
  if (evidence.screenStatus !== undefined && evidence.screenStatus !== 'measured' && evidence.screenStatus !== 'unmeasured') {
    return 'executor evidence.screenStatus is invalid';
  }
  if (evidence.screenStatus === 'unmeasured' && (typeof evidence.screenUnmeasuredReason !== 'string' || !evidence.screenUnmeasuredReason.trim())) {
    return 'executor evidence.screenUnmeasuredReason is required';
  }
  return undefined;
}

/** Execute only the declared app scenarios and evaluate each declared expectation against executor evidence. */
export async function runAppSimulation(input: {
  readonly appSlug: string;
  readonly scenarios: readonly AppSimulationScenarioDeclaration[];
  readonly scenarioName?: string;
}, execute: AppSimulationScenarioExecutor): Promise<AppSimulationRun> {
  if (!input.scenarios.length) throw new Error('app simulation requires at least one declared scenario');
  const names = input.scenarios.map((scenario) => scenario.name);
  if (new Set(names).size !== names.length || names.some((name) => !name.trim())) throw new Error('app simulation scenario names must be unique and non-empty');
  const selected = input.scenarioName === undefined
    ? input.scenarios
    : input.scenarios.filter((scenario) => scenario.name === input.scenarioName);
  if (!selected.length) throw new Error(`unknown app simulation scenario: ${input.scenarioName}`);
  const scenarios: AppSimulationScenarioRun[] = [];
  for (const scenario of selected) {
    const execution = await execute(scenario);
    const result = validateAppSimulationResult(execution.result);
    if (!result.events.some((event) => event.appId === input.appSlug)
      || !result.receipts.some((receipt) => receipt.appId === input.appSlug)) {
      throw new Error(`app simulation omitted requested app: ${input.appSlug}`);
    }
    const evidenceIssue = scenarioEvidenceIssue(execution.evidence);
    const failedExpectations = evidenceIssue
      ? [evidenceIssue]
      : evaluateScenarioExpectations(scenario, execution.evidence);
    const rawNetworkEvents: unknown = execution.externalNetworkEvents;
    const networkEventsValid = Array.isArray(rawNetworkEvents)
      && rawNetworkEvents.every((event) => Boolean(event) && typeof event.url === 'string' && event.blocked === true);
    const networkEvents: readonly { readonly url: string; readonly blocked: true }[] = networkEventsValid
      ? rawNetworkEvents as Array<{ readonly url: string; readonly blocked: true }>
      : [];
    if (rawNetworkEvents !== undefined && !networkEventsValid) {
      failedExpectations.unshift('executor network evidence is invalid');
    } else if (networkEventsValid && networkEvents.length > [].length) failedExpectations.unshift('executor recorded blocked external network attempts');
    if (execution.runtimePassed === false) failedExpectations.unshift('simulation runtime reported failure');
    if (result.receipts.some((receipt) => receipt.outcome === 'failed')) failedExpectations.unshift('executor returned a failed receipt');
    const passed = !failedExpectations.length;
    const outcome = passed ? 'passed' as const : 'failed' as const;
    const summary = passed ? undefined : `Failed expectations: ${failedExpectations.join(', ')}`.slice(0, 240);
    const verifiedResult: AppSimulationResult = {
      ...result,
      receipts: result.receipts.map((receipt) => ({ ...receipt, outcome, ...(summary ? { summary } : {}) })),
    };
    const networkSandboxEstablished = execution.networkSandboxEstablished === true;
    const networkEvidenceMeasured = networkSandboxEstablished && networkEventsValid;
    const unmeasuredCount = Number(evidenceIssue !== undefined) + Number(!networkSandboxEstablished) + Number(!networkEventsValid);
    scenarios.push({ name: scenario.name, passed, failedExpectations, networkSandboxEstablished,
      externalNetworkAttempts: networkEvidenceMeasured ? 0 : null,
      blockedNetworkAttempts: networkEventsValid ? networkEvents.length : null,
      unmeasuredCount, externalNetworkEvents: networkEvents, evidence: execution.evidence, result: verifiedResult });
  }
  const networkEvidenceComplete = scenarios.every((scenario) => scenario.externalNetworkAttempts !== null
    && scenario.blockedNetworkAttempts !== null && scenario.networkSandboxEstablished);
  return { appSlug: input.appSlug, scenarios, passed: scenarios.every((scenario) => scenario.passed),
    networkEvidence: {
      sandboxEstablished: scenarios.length > 0 && scenarios.every((scenario) => scenario.networkSandboxEstablished),
      externalNetworkAttempts: networkEvidenceComplete
        ? scenarios.reduce((total, scenario) => total + scenario.externalNetworkAttempts!, 0) : null,
      blockedNetworkAttempts: scenarios.every((scenario) => scenario.blockedNetworkAttempts !== null)
        ? scenarios.reduce((total, scenario) => total + scenario.blockedNetworkAttempts!, 0) : null,
      unmeasuredCount: scenarios.reduce((total, scenario) => total + scenario.unmeasuredCount, 0),
    } };
}

function readStaticExport(root: string, directory = root, files: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) readStaticExport(root, path, files);
    else if (entry.isFile()) {
      const key = relative(root, path).split(sep).join('/');
      try { files[key] = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); }
      catch { throw new Error(`lecture-scrap static export contains an unsupported binary asset: ${key}`); }
    }
  }
  return files;
}

async function buildLectureScrapScenario(scenarioPath: string): Promise<{ file: string; files: Readonly<Record<string, string>>; cleanup: () => void }> {
  const buildRoot = mkdtempSync(join(tmpdir(), 'lecture-scrap-simulation-'));
  let generatedScenario: string | undefined;
  try {
    const appRoot = join(buildRoot, 'app');
    cpSync(resolve(REPOSITORY_ROOT, 'templates/next-app-lecture-scrap'), appRoot, { recursive: true });
    const dependencies = resolve(REPOSITORY_ROOT, 'apps/pwa/node_modules');
    const nextBin = join(dependencies, '.bin/next');
    symlinkSync(dependencies, join(appRoot, 'node_modules'), 'dir');
    await new Promise<void>((resolveBuild, rejectBuild) => {
      const child = spawn(nextBin, ['build'], { cwd: appRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
      const signalBuildTree = (signal: NodeJS.Signals) => {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid, signal); return; } catch { /* Fall through if the process group is already gone. */ }
        }
        child.kill(signal);
      };
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      let hardStop: ReturnType<typeof setTimeout> | undefined;
      const clearTimers = () => { if (timeout) clearTimeout(timeout); if (forceKill) clearTimeout(forceKill); if (hardStop) clearTimeout(hardStop); };
      const fail = (error: Error) => { if (settled) return; settled = true; clearTimers(); rejectBuild(error); };
      timeout = setTimeout(() => {
        timedOut = true;
        signalBuildTree('SIGTERM');
        forceKill = setTimeout(() => signalBuildTree('SIGKILL'), 5_000);
        hardStop = setTimeout(() => {
          signalBuildTree('SIGKILL');
          fail(new Error(`lecture-scrap static build process tree did not close after termination${stderr.trim() ? `: ${stderr.trim().slice(-1_000)}` : ''}`));
        }, 15_000);
      }, 180_000);
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
      child.once('error', () => fail(new Error('lecture-scrap static build failed to start')));
      child.once('close', (status) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (timedOut || status !== 0) rejectBuild(new Error(`lecture-scrap static build ${timedOut ? 'timed out' : 'failed'}${stderr.trim() ? `: ${stderr.trim().slice(-1_000)}` : ''}`));
        else resolveBuild();
      });
    });

    const files = readStaticExport(join(appRoot, 'out'));
    if (!files['index.html'].includes('날짜별 기록') || !files['index.html'].includes('강의 자료 폴더')
      || !files['notes/new.html'].includes('노트 작성') || !files['notes/new.html'].includes('수업일')
      || !files['notes/new.html'].includes('논리 분류') || !files['search.html'].includes('검색')) {
      throw new Error('lecture-scrap static export omitted a registered screen');
    }
    const scenario = parseYaml(readFileSync(resolve(REPOSITORY_ROOT, scenarioPath), 'utf8')) as {
      world: string; apps: Array<{ versions: Array<{ files: Record<string, string> }> }>;
    };
    if (!scenario.apps[0]?.versions[0]) throw new Error('lecture-scrap simulation fixture is invalid');
    scenario.world = `kaist-lecture-scrap-${randomUUID().slice(0, 8)}`;
    scenario.apps[0].versions[0].files = files;
    generatedScenario = join(buildRoot, 'scenario.yaml');
    writeFileSync(generatedScenario, stringifyYaml(scenario));
    return { file: generatedScenario, files, cleanup: () => {
      rmSync(buildRoot, { recursive: true, force: true });
    } };
  } catch (error) {
    if (generatedScenario) rmSync(generatedScenario, { force: true });
    rmSync(buildRoot, { recursive: true, force: true });
    throw error;
  }
}

const runCli: (args: string[], allowedStatus?: readonly number[], environment?: NodeJS.ProcessEnv) => Promise<CliResult> =
  (args, allowedStatus = [0], environment = process.env) => {
  return new Promise((resolveResult, rejectResult) => {
    const inheritedTestRoot = environment.ELANOUS_STATE_DIR?.trim();
    const env: NodeJS.ProcessEnv = { ...environment, ELANOUS_SIM_RUN_SOURCE: 'operator-app-view' };
    delete env.ELANOUS_CONFIG_DIR;
    const commandArgs = inheritedTestRoot
      ? [`--test=${inheritedTestRoot}`, '--config-dir', inheritedTestRoot, ...args]
      : ['--test', ...args];
    const child = spawnElanous(commandArgs, {
      ...(inheritedTestRoot ? { stateDir: inheritedTestRoot } : {}),
      cwd: REPOSITORY_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const childStdout = child.stdout;
    if (!childStdout) { child.kill('SIGTERM'); rejectResult(new Error('registered app simulation stdout is unavailable')); return; }
    let timedOut = false;
    let oversized = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 180_000);
    childStdout.setEncoding('utf8');
    childStdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4_000_000) { oversized = true; child.kill('SIGTERM'); }
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.once('error', () => { clearTimeout(timeout); rejectResult(new Error('registered app simulation failed to start')); });
    child.once('close', (status) => {
      clearTimeout(timeout);
      if (timedOut || oversized || status === null || !allowedStatus.includes(status)) {
        rejectResult(new Error(`registered app simulation command failed${stderr.trim() ? `: ${stderr.trim().slice(-1_000)}` : ''}`));
      } else resolveResult({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
};

/** Run only a registered hermetic demo scenario in a separate --test universe. */
export function runRegisteredAppSimulation(appSlug: string, options: CliCommand | AppSimulationOptions = runCli): Promise<AppSimulationResult> {
  const executeCli = typeof options === 'function' ? options : options.executeCli ?? runCli;
  const onStaticExport = typeof options === 'function' ? undefined : options.onStaticExport;
  const registeredScenario = SCENARIOS[appSlug];
  if (!registeredScenario) return Promise.reject(new Error('app simulation is not registered'));
  return runAppSimulation({ appSlug, scenarios: [{ name: registeredScenario, steps: [], expect: [] }] }, async () => {
    const scenario = appSlug === 'lecture-scrap' ? await buildLectureScrapScenario(registeredScenario) : undefined;
    if (scenario) onStaticExport?.(scenario.files);
    let worldId: string | undefined;
    try {
      const scenarioFile = scenario?.file ?? registeredScenario;
      const created = await executeCli(['sim', 'world', 'create-yaml', scenarioFile]);
      const metadata = JSON.parse(created.stdout) as { id?: unknown };
      if (typeof metadata.id !== 'string') throw new Error('registered app simulation did not create a world');
      worldId = metadata.id;
      const run = await executeCli(['sim', 'world', 'run', worldId, scenarioFile], [0, 1]);
      const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
      if (parsed.pass !== (run.status === 0)) throw new Error('registered app simulation exit status did not match its result');
      const simulation = validateAppSimulationResult(parsed.appSimulation);
      return { result: simulation,
        evidence: { events: simulation.events.map((event) => event.data.step), tableRows: {}, screenText: '' },
        runtimePassed: parsed.pass === true && simulation.receipts.every((receipt) => receipt.outcome === 'passed') };
    } finally {
      if (worldId) await executeCli(['sim', 'world', 'destroy', worldId]).catch(() => undefined);
      scenario?.cleanup();
    }
  }).then((run) => {
    const first = run.scenarios.find(() => true);
    if (!first) throw new Error(`registered app simulation produced no scenario: ${appSlug}`);
    return first.result;
  });
}

/** Build a test-world scenario from app.yaml and execute only its declared scenario set. */
export async function runDeclaredAppSimulation(input: {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly scenarioName?: string;
  readonly appDirectory?: string;
}, options: CliCommand | AppSimulationOptions = runCli): Promise<AppSimulationRun> {
  const executeCli: CliCommand = typeof options === 'function' ? options
    : options.executeCli ?? ((args, allowedStatus) => runCli(args, allowedStatus, options.environment));
  const renderScreen = typeof options === 'function' ? renderAppScreen : options.renderScreen ?? renderAppScreen;
  if (typeof input.manifest.slug !== 'string' || !input.manifest.slug.trim()) throw new Error('app simulation manifest requires a slug');
  const simulate = input.manifest.simulate as { scenarios?: AppSimulationScenarioDeclaration[] } | undefined;
  const scenarios = simulate?.scenarios;
  if (!Array.isArray(scenarios)) throw new Error('app simulation manifest requires declared scenarios');
  return runAppSimulation({ appSlug: input.manifest.slug, scenarios, ...(input.scenarioName ? { scenarioName: input.scenarioName } : {}) }, async (scenario) => {
    const scratch = mkdtempSync(join(tmpdir(), 'declared-app-simulation-'));
    const worldId = `app-sim-${randomUUID()}`;
    let createdWorld = false;
    try {
      const worldFile = join(scratch, 'world.yaml');
      const scenarioFile = join(scratch, 'scenario.yaml');
      writeFileSync(worldFile, stringifyYaml({ world: worldId, seed: [].length, devices: ['fake-clock'], events: [] }), { mode: 0o600 });
      writeFileSync(scenarioFile, stringifyYaml({ world: worldId, steps: scenario.steps,
        appSimulation: { manifest: input.manifest, scenario } }), { mode: 0o600 });
      const created = await executeCli(['sim', 'world', 'create-yaml', worldFile]);
      const metadata = JSON.parse(created.stdout) as { id?: unknown };
      if (metadata.id !== worldId) throw new Error('declared app simulation did not create its isolated world');
      createdWorld = true;
      const run = await executeCli(['sim', 'world', 'run', worldId, scenarioFile], [0, 1]);
      const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
      if (parsed.pass !== (run.status === 0)) throw new Error('declared app simulation exit status did not match its result');
      const result = validateAppSimulationResult(parsed.appSimulation);
      const rawEvidence = parsed.appSimulationEvidence as AppSimulationScenarioEvidence | undefined;
      const frontend = input.manifest.frontend as { kind?: unknown } | undefined;
      const screen = frontend?.kind === 'static-export' && input.appDirectory
        ? await renderScreen({ appDirectory: input.appDirectory, appSlug: input.manifest.slug as string })
        : { status: 'unmeasured' as const, reason: 'static export directory unavailable', blockedUrls: [], browserDeniedUrls: [] };
      const evidence = { events: rawEvidence?.events, tableRows: rawEvidence?.tableRows, screenText: screen.status === 'measured' ? screen.screenText : '',
        screenStatus: screen.status, browserDeniedUrls: screen.browserDeniedUrls,
        ...(screen.status === 'unmeasured' ? { screenUnmeasuredReason: screen.reason } : {}) } as AppSimulationScenarioEvidence;
      const externalNetworkEvents = parsed.externalNetworkEvents;
      const devices = parsed.devices;
      const networkEvents = Array.isArray(externalNetworkEvents) ? externalNetworkEvents as NonNullable<AppSimulationScenarioExecution['externalNetworkEvents']> : [];
      return { result, evidence: evidence as AppSimulationScenarioEvidence,
        externalNetworkEvents: [...networkEvents, ...screen.blockedUrls.map((url) => ({ url, blocked: true as const }))],
        // Source: src/ux-sim/world.ts refuses execution without ELANOUS_SIM_WORLD_OS_SANDBOXED and only its OS-sandbox launcher sets it.
        networkSandboxEstablished: Array.isArray(devices) && devices.includes('fake-clock'),
        runtimePassed: parsed.pass === true && Array.isArray(externalNetworkEvents) && externalNetworkEvents.length === [].length && screen.blockedUrls.length === [].length };
    } finally {
      if (createdWorld) await executeCli(['sim', 'world', 'destroy', worldId]).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
