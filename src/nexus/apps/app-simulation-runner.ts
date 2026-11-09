import { join, relative, resolve, sep } from 'node:path';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { spawnElanous } from '../../instance/spawn-elanous.js';
import { validateAppSimulationResult, type AppSimulationResult } from './app-simulation.js';

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
};

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
    if (!files['index.html'].includes('스크랩 목록') || !files['notes/new.html'].includes('노트 작성') || !files['search.html'].includes('검색')) {
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

const runCli: CliCommand = (args, allowedStatus = [0]) => {
  return new Promise((resolveResult, rejectResult) => {
    const inheritedTestRoot = process.env.NODE_ENV === 'test' ? process.env.ELANOUS_STATE_DIR?.trim() : undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_SIM_RUN_SOURCE: 'operator-app-view' };
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
  return (async () => {
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
      if (!simulation.events.some(event => event.appId === appSlug) || !simulation.receipts.some(receipt => receipt.appId === appSlug)) {
        throw new Error('registered app simulation omitted the requested app');
      }
      return simulation;
    } finally {
      if (worldId) await executeCli(['sim', 'world', 'destroy', worldId]).catch(() => undefined);
      scenario?.cleanup();
    }
  })();
}
