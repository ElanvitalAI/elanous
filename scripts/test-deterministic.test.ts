import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupTemporaryRoot,
  classifyExplicitTestFiles,
  deriveMockModuleTestFiles,
  deriveTestFiles,
  effectiveTestCwd,
  getProcessGroupId,
  installShutdownSignalGate,
  isLivePid,
  isLiveProcessGroup,
  killProcessGroup,
  partitionBunTestArguments,
  planDeterministicTestCommands,
  prepareIsolatedTestEnv,
  runDeterministicTests as runDeterministicTestsOriginal,
  scanNamePatternStderr,
  selectedTestFiles,
  TEMP_ROOT_PREFIX,
  terminateDirectChild,
  type DirectChild,
  type DeterministicRunnerDeps,
  type ShutdownSignal,
  type SignalTarget,
} from './test-deterministic.js';

// Existing lifecycle fixtures exercise one direct child. They explicitly opt
// out of source discovery; the partition tests below opt in to mock files.
const runDeterministicTests = (deps: DeterministicRunnerDeps = {}) =>
  runDeterministicTestsOriginal({ deriveMockModuleFiles: () => [], ...deps });

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const source = readFileSync('scripts/test-deterministic.ts', 'utf8');
const envSource = readFileSync('scripts/lib/deterministic-env.ts', 'utf8');
const script = join(import.meta.dir, 'test-deterministic.ts');
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function trackRoot(root: string): string {
  cleanups.push(() => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });
  return root;
}

function makeRoot(prefix = 'elanous-deterministic-unit-'): string {
  return trackRoot(mkdtempSync(join(tmpdir(), prefix)));
}

function isLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function expectDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLive(pid)) return;
    await Bun.sleep(25);
  }
  throw new Error(`process survived cleanup: ${pid}`);
}

function spawnHang(ignoreTerm = false): DirectChild {
  const body = ignoreTerm
    ? 'process.on("SIGTERM", () => {}); await Bun.sleep(60_000);'
    : 'await Bun.sleep(60_000);';
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', body],
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  const wrapped: DirectChild = {
    pid: child.pid,
    exited: child.exited,
    kill(signal) { return child.kill(signal); },
  };
  cleanups.push(() => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  });
  return wrapped;
}

async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8'));
      if (Number.isInteger(pid) && pid > 1) return pid;
    }
    await Bun.sleep(25);
  }
  throw new Error(`pid file did not appear: ${path}`);
}

async function spawnHangWithGrandchild(pidPath: string): Promise<{ child: DirectChild; grandchildPid: number }> {
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', `
      import { writeFileSync } from 'node:fs';
      const g = Bun.spawn({ cmd: ['sleep', '60'], stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      writeFileSync(${JSON.stringify(pidPath)}, String(g.pid));
      await Bun.sleep(60_000);
    `],
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  const wrapped: DirectChild = {
    pid: child.pid,
    exited: child.exited,
    kill(signal) { return child.kill(signal); },
  };
  cleanups.push(() => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  });
  const grandchildPid = await waitForPidFile(pidPath);
  cleanups.push(() => {
    try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
  });
  return { child: wrapped, grandchildPid };
}

async function spawnExitedLeaderWithTermIgnoringGrandchild(pidPath: string): Promise<{ child: DirectChild; grandchildPid: number }> {
  // The readiness file comes from the grandchild *after* its signal handlers
  // are installed. Otherwise this test can SIGTERM it before it starts.
  const grandchildBody = `
    import { writeFileSync } from 'node:fs';
    process.on("SIGTERM", () => {});
    process.on("SIGHUP", () => {});
    process.on("SIGINT", () => {});
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    await Bun.sleep(60_000);
  `;
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', `
      const g = Bun.spawn({
        cmd: ${JSON.stringify([process.execPath, '-e', grandchildBody])},
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      g.unref();
    `],
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  const wrapped: DirectChild = {
    pid: child.pid,
    exited: child.exited,
    kill(signal) { return child.kill(signal); },
  };
  cleanups.push(() => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  });
  const grandchildPid = await waitForPidFile(pidPath);
  cleanups.push(() => {
    try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
  });
  await child.exited;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (isLive(grandchildPid) && isLiveProcessGroup(wrapped.pid!)) return { child: wrapped, grandchildPid };
    await Bun.sleep(25);
  }
  throw new Error(`term-ignoring grandchild did not remain in the dead leader group: pid=${grandchildPid}`);
}

class FakeSignalTarget implements SignalTarget {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, list.filter((candidate) => candidate !== listener));
    return this;
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

function writeProbeTest(directory: string): string {
  const file = join(directory, 'probe.test.ts');
  writeFileSync(file, `
import { test } from 'bun:test';
import { writeFileSync } from 'node:fs';
test('deterministic runner probe', async () => {
  const path = process.env.DETERMINISTIC_RUNNER_PROBE_PATH;
  if (path) {
    writeFileSync(path, JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
      ELANOUS_TEST_HOME: process.env.ELANOUS_TEST_HOME,
      ELANOUS_HOST_ID: process.env.ELANOUS_HOST_ID ?? null,
      ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR,
      ELANOUS_CONFIG_DIR: process.env.ELANOUS_CONFIG_DIR ?? null,
      GIT_DIR: process.env.GIT_DIR ?? null,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE ?? null,
      GIT_COMMON_DIR: process.env.GIT_COMMON_DIR ?? null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      APIFY_TOKEN: process.env.APIFY_TOKEN ?? null,
    }));
  }
  const mode = process.env.DETERMINISTIC_RUNNER_PROBE_MODE ?? 'exit-0';
  if (mode === 'hang-grandchild') {
    const g = Bun.spawn({ cmd: ['sleep', '60'], stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    if (path) {
      writeFileSync(path, JSON.stringify({
        pid: process.pid,
        ppid: process.ppid,
        HOME: process.env.HOME,
        grandchildPid: g.pid,
      }));
    }
    await Bun.sleep(60_000);
  }
  if (mode === 'hang') await Bun.sleep(60_000);
  if (mode === 'xdg-warning') {
    const { userConfigPath } = await import(${JSON.stringify(join(import.meta.dir, '../src/user-config.ts'))});
    const resolved = userConfigPath();
    if (resolved !== process.env.ELANOUS_STATE_DIR + '/config.json') throw new Error('config escaped isolated root: ' + resolved);
  }
  if (mode === 'git-bare-leak') {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('git', ['init', '--bare'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('git init --bare: ' + result.stderr);
  }
  if (mode === 'stdout-marker') console.log('DETERMINISTIC_STDOUT_VISIBLE');
  if (mode === 'exit-1') throw new Error('forced child failure');
}, 70_000);
`);
  return file;
}

async function waitForProbe(path: string): Promise<{
  pid: number;
  ppid: number;
  HOME: string;
  XDG_CONFIG_HOME?: string | null;
  ELANOUS_TEST_HOME?: string;
  ELANOUS_HOST_ID?: string | null;
  ELANOUS_STATE_DIR?: string;
  ELANOUS_CONFIG_DIR?: string;
  GIT_DIR?: string | null;
  GIT_WORK_TREE?: string | null;
  GIT_COMMON_DIR?: string | null;
  ANTHROPIC_API_KEY?: string | null;
  APIFY_TOKEN?: string | null;
  grandchildPid?: number;
}> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    await Bun.sleep(25);
  }
  throw new Error(`probe did not write: ${path}`);
}

function startRunner(
  env: Record<string, string>,
  probeFile: string,
  stdio: ['ignore', 'ignore' | 'pipe', 'pipe'] = ['ignore', 'ignore', 'pipe'],
): ChildProcess {
  return spawn(process.execPath, [script, probeFile], {
    env: { ...process.env, ...env },
    stdio,
  });
}

async function collect(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk; });
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode, stdout, stderr };
  }
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

describe('scripts/test-deterministic.ts preservation', () => {
  test('keeps the human deterministic entrypoint wired to the credential filter and redirected roots', () => {
    // R7(10-16): the isolated env builder moved to the side-effect-free lib (shared with the regate runner).
    expect(source).toContain("import { GIT_LOCATION_ENV_KEYS, prepareIsolatedTestEnv } from './lib/deterministic-env.js';");
    expect(source).toContain('const env = prepareIsolatedTestEnv(deps.env ?? process.env, testRoot);');
    expect(envSource).toContain("'ELANOUS_HARNESS_SPACE'");
    expect(envSource).toContain('!isCredentialKey(key)');
    expect(envSource).toContain('!HARNESS_TEST_ENV_KEYS.includes');
    expect(envSource).toContain('!EXECUTION_ORIGIN_ENV_KEYS.includes');
    expect(envSource).toContain('env.HOME = testRoot;');
    expect(envSource).toContain('delete env.XDG_CONFIG_HOME;');
    expect(envSource).toContain('env.ELANOUS_TEST_HOME = testRoot;');
    expect(envSource).toContain("env.ELANOUS_STATE_DIR = join(testRoot, 'state');");
    expect(envSource).toContain('delete env.ELANOUS_CONFIG_DIR;');
    expect(source).not.toMatch(/env\.ELANOUS_CONFIG_DIR\s*=/);
    expect(envSource).not.toMatch(/env\.ELANOUS_CONFIG_DIR\s*=\s*join\(testRoot/);
    expect(source).toContain('env,');
    expect(source).toContain("stdin: 'inherit'");
    expect(source).toContain("stdout: 'inherit'");
    expect(source).toContain("stderr: 'inherit'");
    expect(source).toContain('detached: true');
    // ⛔ 이 칸이 지키는 «뜻»은 「사람이 준 argv 가 bun test 까지 그대로 간다」다.
    //   2026-09-24: CDP 레인 분리로 그 앞에 ...ignoreArgs 가 붙었다 — argv 통과는 그대로다.
    expect(source).toContain('let commands = planDeterministicTestCommands(argv, cdpPatterns, mockFiles, allTestFiles, testCwd)');
    expect(source).toContain('for (const cmd of commands)');
    expect(source).toContain("join(tempBase(), TEMP_ROOT_PREFIX)");
    expect(source).toContain("export const TEMP_ROOT_PREFIX = 'elanous-deterministic-test-';");
    expect(source).toContain('if (import.meta.main)');
    expect(source).toContain('await runDeterministicTests()');
    expect(source).toContain('const child = Bun.spawn({');
    expect(source).not.toContain("Bun.spawnSync({\n  cmd: ['bun', 'test'");
  });

  test('signal path terminates the process group before cleanup and retries once with SIGKILL', () => {
    const signalBlock = source.slice(source.indexOf('await terminateDirectChild(child, outcome.signal'));
    expect(signalBlock).toContain('await terminateDirectChild(child, outcome.signal');
    expect(signalBlock).toContain('cleanupTemporaryRoot(testRoot');
    expect(signalBlock.indexOf('await terminateDirectChild')).toBeLessThan(signalBlock.indexOf('cleanupTemporaryRoot'));
    expect(source).toContain("tryKill('SIGKILL')");
    expect(source).toContain('process.kill(-pid, signal)');
    expect(source).toContain('killGroup(pid, sig)');
    expect(source).toContain('signalDirectChild(child, pid, sig, report)');
    expect(source).toContain('failed to signal process group pgid=');
    expect(source).toContain("refusing to signal this process's own group");
    expect(source).toContain('reportVisible(`failed to signal process group pgid=${pid} with ${sig}: ${formatError(error)}`, report)');
    expect(source).toContain('waitUntilPidAndGroupDead');
    expect(source).toContain('isLiveProcessGroup');
    expect(source).toContain('getProcessGroupId');
    expect(source).toContain('process.kill(-pgid, 0)');
    expect(source).not.toMatch(/if \(pid === process\.pid\)/);
    expect(source.indexOf('if (await waitUntilPidAndGroupDead')).toBeGreaterThan(source.indexOf('tryKill(signal)'));
    expect(source.indexOf("tryKill('SIGKILL')")).toBeGreaterThan(source.indexOf('if (await waitUntilPidAndGroupDead'));
    expect(source).not.toContain('pgrep');
    expect(source).not.toContain('pkill');
    expect(source).not.toContain('killall');
    expect(signalBlock).toContain('resignalSelf(outcome.signal');
    expect(source).toContain('} finally {');
    expect(source).not.toContain('process.once');
    expect(source).not.toContain('process.exit(130');
    expect(source).not.toContain('process.exit(143');
  });
});

describe('prepareIsolatedTestEnv', () => {
  test('strips credential-shaped keys while isolating HOME and the state-backed config root', () => {
    const testRoot = '/isolated/elanous-deterministic-test-root';
    const env = prepareIsolatedTestEnv({
      ANTHROPIC_API_KEY: 'live-secret',
      APIFY_TOKEN: 'live-token',
      OPENAI_BASE_URL: 'https://example.invalid',
      HOME: '/real/home',
      XDG_CONFIG_HOME: '/real/.config',
      ELANOUS_TEST_HOME: '/real/test-home',
      ELANOUS_STATE_DIR: '/real/state',
      ELANOUS_CONFIG_DIR: '/real/config',
      ELANOUS_HARNESS_SPACE: 'self-implement',
      ELANOUS_HARNESS_SPACE_ID: 'test-space',
      ELANOUS_HARNESS_BOUNDARY: '/real/boundary',
      ELANOUS_HARNESS_ROLE: 'executor',
      ELANOUS_HARNESS_DETACHED: '1',
      ELANOUS_RUN_ID: 'run-parent',
      ELANOUS_HOST_ID: 'x',
      ELANOUS_RUN_CONTEXT: 'self-implement',
      ELANOUS_PARENT_RUN_ID: 'run-ancestor',
      ELANOUS_PARENT_PTY_ID: 'pty-ancestor',
      ELANOUS_PARENT_SELF_DEV_RUNS_DIR: '/real/runs',
      ELANOUS_SUBSTRATE: 'pod',
      ELANOUS_ARM_ID: 'arm-parent',
      ELANOUS_STATE_DIR_SOURCE: 'derived',
      ELANOUS_CODEX_ACCOUNT: 'team',
      GIT_DIR: '/real/shared/.git',
      GIT_WORK_TREE: '/real/shared/worktree',
      GIT_COMMON_DIR: '/real/shared/.git',
      PATH: '/usr/bin',
    }, testRoot);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.APIFY_TOKEN).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBe('https://example.invalid');
    expect(env.HOME).toBe(testRoot);
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.ELANOUS_TEST_HOME).toBe(testRoot);
    expect(env.ELANOUS_STATE_DIR).toBe(`${testRoot}/state`);
    expect(env.ELANOUS_CONFIG_DIR).toBeUndefined();
    expect(env.ELANOUS_HARNESS_SPACE).toBeUndefined();
    expect(env.ELANOUS_HARNESS_SPACE_ID).toBeUndefined();
    expect(env.ELANOUS_HARNESS_BOUNDARY).toBeUndefined();
    expect(env.ELANOUS_HARNESS_ROLE).toBeUndefined();
    expect(env.ELANOUS_HARNESS_DETACHED).toBeUndefined();
    for (const key of [
      'ELANOUS_RUN_ID', 'ELANOUS_HOST_ID', 'ELANOUS_RUN_CONTEXT',
      'ELANOUS_PARENT_RUN_ID', 'ELANOUS_PARENT_PTY_ID', 'ELANOUS_PARENT_SELF_DEV_RUNS_DIR',
      'ELANOUS_SUBSTRATE', 'ELANOUS_ARM_ID', 'ELANOUS_STATE_DIR_SOURCE', 'ELANOUS_CODEX_ACCOUNT',
    ]) expect(env[key]).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
  });
});

describe('cleanupTemporaryRoot', () => {
  test('reports a forced removal failure with the affected path', () => {
    const testRoot = '/tmp/elanous-deterministic-test-forced-fail';
    const messages: string[] = [];
    cleanupTemporaryRoot(testRoot, {
      rmSync: () => { throw new Error('EACCES: permission denied'); },
      report: (message) => messages.push(message),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(testRoot);
    expect(messages[0]).toContain('failed to remove temporary root');
    expect(messages[0]).toContain('EACCES: permission denied');
  });
});

describe('installShutdownSignalGate', () => {
  test('keeps listeners until dispose and absorbs later SIGINT/SIGTERM', async () => {
    const target = new FakeSignalTarget();
    const absorbed: ShutdownSignal[] = [];
    const gate = installShutdownSignalGate(target, (signal) => absorbed.push(signal));
    target.emit('SIGTERM');
    target.emit('SIGTERM');
    target.emit('SIGINT');
    expect(await gate.received).toBe('SIGTERM');
    expect(absorbed).toEqual(['SIGTERM', 'SIGINT']);
    expect(target.listenerCount('SIGTERM')).toBe(1);
    expect(target.listenerCount('SIGINT')).toBe(1);
    gate.dispose();
    expect(target.listenerCount('SIGTERM')).toBe(0);
    expect(target.listenerCount('SIGINT')).toBe(0);
  });
});

describe('killProcessGroup', () => {
  test('refuses to signal this process own group', () => {
    expect(() => killProcessGroup(process.pid, 'SIGTERM')).toThrow(/own group/);
  });

  test('refuses when the target pid equals this process actual pgid, not process.pid', () => {
    const ownPgid = process.pid === 1 ? 2 : 1;
    expect(ownPgid).not.toBe(process.pid);
    expect(() => killProcessGroup(ownPgid, 'SIGTERM', {
      getProcessGroupId: (pid) => pid === 0 ? ownPgid : 99_001,
    })).toThrow(/own group/);
  });

  test('refuses when a different pid shares this process pgid', () => {
    const ownPgid = 4242;
    const otherPid = 7777;
    expect(() => killProcessGroup(otherPid, 'SIGTERM', {
      getProcessGroupId: (pid) => pid === 0 || pid === otherPid ? ownPgid : 99_001,
    })).toThrow(/own group/);
  });

  test('reads the live process group id instead of treating process.pid as pgid', () => {
    const ownPgid = getProcessGroupId(0);
    expect(ownPgid).toBe(getProcessGroupId(process.pid));
    expect(Number.isInteger(ownPgid) && ownPgid > 0).toBe(true);
    const child = spawnHang();
    if (child.pid === undefined) throw new Error('spawned child has no pid');
    const childPid: number = child.pid;
    expect(getProcessGroupId(childPid)).toBe(childPid);
    expect(getProcessGroupId(childPid)).not.toBe(ownPgid);
  });
});

describe('terminateDirectChild', () => {
  test('sends the received signal and waits until the direct child is dead', async () => {
    const child = spawnHang();
    expect(child.pid).toBeTypeOf('number');
    await terminateDirectChild(child, 'SIGTERM', { graceMs: 1_000 });
    await expectDead(child.pid!, 1_000);
  });

  test('retries exactly once with SIGKILL when the child ignores the first signal', async () => {
    const child = spawnHang(true);
    await terminateDirectChild(child, 'SIGTERM', { graceMs: 200 });
    await expectDead(child.pid!, 1_000);
  });

  test('ends a grandchild that lives in the child process group', async () => {
    const pidPath = join(makeRoot(), 'grandchild.pid');
    const { child, grandchildPid } = await spawnHangWithGrandchild(pidPath);
    expect(isLive(child.pid!)).toBe(true);
    expect(isLive(grandchildPid)).toBe(true);
    await terminateDirectChild(child, 'SIGTERM', { graceMs: 1_000 });
    await expectDead(child.pid!, 1_000);
    await expectDead(grandchildPid, 1_000);
  });

  test('SIGINT also ends the child and its grandchild', async () => {
    const pidPath = join(makeRoot(), 'grandchild.pid');
    const { child, grandchildPid } = await spawnHangWithGrandchild(pidPath);
    await terminateDirectChild(child, 'SIGINT', { graceMs: 1_000 });
    await expectDead(child.pid!, 1_000);
    await expectDead(grandchildPid, 1_000);
  });

  test('SIGKILLs the group when the direct child is already dead and a grandchild ignores SIGTERM', async () => {
    const pidPath = join(makeRoot(), 'grandchild.pid');
    const { child, grandchildPid } = await spawnExitedLeaderWithTermIgnoringGrandchild(pidPath);
    expect(isLive(child.pid!)).toBe(false);
    expect(isLive(grandchildPid)).toBe(true);
    expect(isLiveProcessGroup(child.pid!)).toBe(true);
    const groupSignals: NodeJS.Signals[] = [];
    await terminateDirectChild(child, 'SIGTERM', {
      graceMs: 200,
      killProcessGroup: (pid, signal) => {
        groupSignals.push(signal);
        killProcessGroup(pid, signal);
      },
    });
    expect(groupSignals).toContain('SIGTERM');
    expect(groupSignals).toContain('SIGKILL');
    await expectDead(grandchildPid, 1_000);
    expect(isLiveProcessGroup(child.pid!)).toBe(false);
  }, 15_000);

  test('reports the child pid when termination fails', async () => {
    const child = spawnHang();
    const messages: string[] = [];
    await terminateDirectChild({
      pid: child.pid,
      exited: child.exited,
      kill: () => true,
    }, 'SIGTERM', {
      graceMs: 80,
      report: (message) => messages.push(message),
      killProcessGroup: () => {},
    });
    expect(messages.some((message) => message.includes(`failed to terminate child pid=${child.pid}`))).toBe(true);
    expect(isLive(child.pid!)).toBe(true);
  });

  test('group termination failure is visible and still ends the direct child', async () => {
    const child = spawnHang();
    const messages: string[] = [];
    await terminateDirectChild(child, 'SIGTERM', {
      graceMs: 1_000,
      report: (message) => messages.push(message),
      killProcessGroup: () => { throw new Error('killpg failed: ESRCH'); },
    });
    expect(messages.join('\n')).toContain(`failed to signal process group pgid=${child.pid}`);
    expect(messages.join('\n')).toContain('killpg failed: ESRCH');
    await expectDead(child.pid!, 1_000);
  });
});

describe('runDeterministicTests core.bare guard', () => {
  test('restores a changed shared config and fails even when the test child passes', async () => {
    const repo = makeRoot('elanous-bare-guard-');
    const common = join(repo, '.git');
    const configFile = join(common, 'config');
    mkdirSync(common);
    writeFileSync(configFile, '[core]\n\tbare = false\n');
    const messages: string[] = [];
    const readBare = () => /bare = (true|false)/.exec(readFileSync(configFile, 'utf8'))?.[1] ?? '';
    const code = await runDeterministicTests({
      cwd: repo,
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      argv: ['scripts/test-deterministic.test.ts'],
      gitConfig: (_cwd, args) => {
        if (args[0] === 'rev-parse') return common;
        if (args.includes('--get-all')) return readBare();
        if (args.includes('--replace-all')) {
          writeFileSync(configFile, `[core]\n\tbare = ${args.at(-1)}\n`);
          return '';
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      spawn: () => {
        writeFileSync(configFile, '[core]\n\tbare = true\n');
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(readBare()).toBe('false');
    expect(messages).toEqual(['[test-deterministic] core.bare changed false -> true; restored false; failing run']);
  });

  test('restores an initially unset core.bare by unsetting it again', async () => {
    const repo = makeRoot('elanous-bare-unset-');
    const common = join(repo, '.git');
    mkdirSync(common);
    writeFileSync(join(common, 'config'), '[core]\n\tfilemode = true\n');
    const configFile = join(common, 'config');
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic.test.ts'],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      gitConfig: (_cwd, args) => {
        if (args[0] === 'rev-parse') return common;
        if (args.includes('--get-all')) return /bare = true/.test(readFileSync(configFile, 'utf8')) ? 'true' : '';
        if (args.includes('--unset-all')) {
          writeFileSync(configFile, '[core]\n\tfilemode = true\n');
          return '';
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      spawn: () => {
        writeFileSync(configFile, '[core]\n\tfilemode = true\n\tbare = true\n');
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(readFileSync(configFile, 'utf8')).toBe('[core]\n\tfilemode = true\n');
    expect(messages).toEqual(['[test-deterministic] core.bare changed <unset> -> true; restored <unset>; failing run']);
  });

  test('a real cloned repository worktree is restored after a bare init targets its shared Git directory', async () => {
    const root = makeRoot('elanous-bare-worktree-');
    const source = join(root, 'source');
    const shared = join(root, 'shared');
    const worktree = join(root, 'worktree');
    const run = (args: string[], cwd = root, env = process.env): string => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    run(['init', '-b', 'main', source]);
    writeFileSync(join(source, 'initial'), 'initial');
    run(['add', 'initial'], source);
    run(['-c', 'user.email=test@example.com', '-c', 'user.name=Tester', 'commit', '-m', 'initial'], source);
    run(['clone', source, shared]);
    run(['worktree', 'add', '-b', 'probe', worktree], shared);
    const configFile = join(shared, '.git', 'config');
    const readBare = () => run(['config', '--file', configFile, '--get', 'core.bare']);
    expect(readBare()).toBe('false');
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: worktree,
      argv: ['scripts/test-deterministic.test.ts'],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        run(['init', '--bare'], worktree, { ...process.env, GIT_DIR: join(shared, '.git') });
        expect(readBare()).toBe('true');
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(readBare()).toBe('false');
    expect(messages).toEqual(['[test-deterministic] core.bare changed false -> true; restored false; failing run']);
  });

  test.each([
    { original: 'false', expected: ['false'], injected: ['false', 'true'] },
    { original: '', expected: [], injected: ['true', 'true'] },
  ])('restores duplicate core.bare entries with real Git (original=$original)', async ({ original, expected, injected }) => {
    const repo = makeRoot('elanous-bare-duplicate-');
    const gitEnv = { ...process.env };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_WORK_TREE;
    delete gitEnv.GIT_COMMON_DIR;
    const run = (args: string[]): string => {
      const result = spawnSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    run(['init']);
    const configFile = join(repo, '.git', 'config');
    if (!original) run(['config', '--file', configFile, '--unset-all', 'core.bare']);
    const values = () => {
      const result = spawnSync('git', ['config', '--file', configFile, '--get-all', 'core.bare'], { cwd: repo, env: gitEnv, encoding: 'utf8' });
      if (result.status !== 0 && result.status !== 1) throw new Error(`git config --get-all failed: ${result.stderr}`);
      return result.stdout.trim().split('\n').filter(Boolean);
    };
    expect(values()).toEqual([...expected]);
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic.test.ts'],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        for (const value of injected) run(['config', '--file', configFile, '--add', 'core.bare', value]);
        expect(values()).toEqual([...expected, ...injected]);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(values()).toEqual([...expected]);
    expect(messages).toEqual([`[test-deterministic] core.bare changed ${original || '<unset>'} -> ${[...expected, ...injected].join(',')}; restored ${original || '<unset>'}; failing run`]);
  });

  test('preserves an originally duplicated core.bare configuration', async () => {
    const repo = makeRoot('elanous-bare-original-duplicates-');
    const gitEnv = { ...process.env };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_WORK_TREE;
    delete gitEnv.GIT_COMMON_DIR;
    const run = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
    };
    run(['init']);
    const configFile = join(repo, '.git', 'config');
    run(['config', '--file', configFile, '--add', 'core.bare', 'false']);
    const values = () => spawnSync('git', ['config', '--file', configFile, '--get-all', 'core.bare'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).stdout.trim().split('\n');
    expect(values()).toEqual(['false', 'false']);
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic.test.ts'],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        run(['config', '--file', configFile, '--add', 'core.bare', 'true']);
        expect(values()).toEqual(['false', 'false', 'true']);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(values()).toEqual(['false', 'false']);
    expect(messages).toEqual(['[test-deterministic] core.bare changed false,false -> false,false,true; restored false,false; failing run']);
  });

  test('fails visibly when restoring core.bare does not reproduce the original values', async () => {
    let values = 'false';
    const messages: string[] = [];
    const code = await runDeterministicTests({
      argv: ['--dots'],
      deriveCdpPatterns: () => [],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      gitConfig: (_cwd, args) => {
        if (args[0] === 'rev-parse') return join(process.cwd(), '.git');
        // Only core.bare drifts here; user.name/user.email (also watched) stay unset.
        if (args.includes('--get-all')) return args.at(-1) === 'core.bare' ? values : '';
        if (args.includes('--replace-all')) return '';
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      spawn: () => {
        values = 'false\ntrue';
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(messages).toEqual(['[test-deterministic] core.bare changed false -> false,true; restore failed: expected false, got false,true']);
  });

  test('checks the shared config only once after a normal child exit', async () => {
    let reads = 0;
    const code = await runDeterministicTests({
      argv: ['scripts/test-deterministic.test.ts'],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      gitConfig: (_cwd, args) => {
        if (args[0] === 'rev-parse') return join(process.cwd(), '.git');
        reads += 1;
        return 'false';
      },
      spawn: () => ({ pid: process.pid, exited: Promise.resolve(0), kill: () => true }),
    });
    expect(code).toBe(0);
    // Three watched keys (core.bare · user.name · user.email), read once before and once after.
    expect(reads).toBe(6);
  });

  test('does not raise an alert when core.bare remains unchanged', async () => {
    const messages: string[] = [];
    const code = await runDeterministicTests({
      argv: ['--dots'],
      deriveCdpPatterns: () => [],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      spawn: () => ({ pid: process.pid, exited: Promise.resolve(0), kill: () => true }),
    });
    expect(code).toBe(0);
    expect(messages).toEqual([]);
  });
});

describe('mock.module process isolation', () => {
  test('discovers module mocks across Bun test name forms and extensions', () => {
    const root = makeRoot();
    for (const dir of ['src', 'test', 'plugins']) mkdirSync(join(root, dir));
    const mocked = ['src/mocked.test.ts', 'plugins/widget.test.tsx'];
    for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']) {
      for (const name of [`value.test.${ext}`, `value.spec.${ext}`, `value_test.${ext}`, `value_spec.${ext}`]) {
        mocked.push(`src/${name}`);
      }
    }
    for (const file of mocked) writeFileSync(join(root, file), 'mock .\nmodule ("x", () => ({}));');
    writeFileSync(join(root, 'test', 'plain.test.ts'), 'test("plain", () => {});');
    expect(deriveMockModuleTestFiles({ cwd: root })).toEqual(mocked.sort());
    expect(deriveTestFiles({ cwd: root }).sort()).toEqual([...mocked, 'test/plain.test.ts'].sort());
  });

  test('keeps comment-only tests together and separates inline-comment and parenthesized module mocks', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'test', 'comment.test.ts'),
      "import { test } from 'bun:test'; // mock.module('unused', () => ({}))\ntest('comment', () => {});\n");
    writeFileSync(join(root, 'test', 'actual.test.ts'),
      "import { mock, test } from 'bun:test'; mock/* inline */.module('virtual-test-module', () => ({})); test('actual', () => {});\n");
    writeFileSync(join(root, 'test', 'parenthesized.test.ts'),
      "import { mock, test } from 'bun:test'; (mock).module('virtual-parenthesized', () => ({})); test('parenthesized', () => {});\n");
    writeFileSync(join(root, 'test', 'callee-parenthesized.test.ts'),
      "import { mock, test } from 'bun:test'; (mock.module)('virtual-callee', () => ({})); test('callee-parenthesized', () => {});\n");
    writeFileSync(join(root, 'test', 'plain.test.ts'),
      "import { test } from 'bun:test'; test('plain', () => {});\n");
    expect(deriveMockModuleTestFiles({ cwd: root })).toEqual([
      'test/actual.test.ts', 'test/callee-parenthesized.test.ts', 'test/parenthesized.test.ts',
    ]);
    const run = (...selectors: string[]) => spawnSync('bun', ['run', script, '--cwd', root, ...selectors], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    const comment = run('test/comment.test.ts', 'test/plain.test.ts');
    expect(comment.status).toBe(0);
    expect(`${comment.stdout}\n${comment.stderr}`).toContain('Ran 2 tests across 2 files');
    const actual = run('test/actual.test.ts', 'test/plain.test.ts');
    expect(actual.status).toBe(0);
    expect((`${actual.stdout}\n${actual.stderr}`).match(/Ran 1 test across 1 file/g) ?? []).toHaveLength(2);
    for (const selector of ['test/parenthesized.test.ts', 'test/callee-parenthesized.test.ts']) {
      const result = run(selector, 'test/plain.test.ts');
      expect(result.status).toBe(0);
      expect((`${result.stdout}\n${result.stderr}`).match(/Ran 1 test across 1 file/g) ?? []).toHaveLength(2);
    }
  });

  test('path-selected runs parse only reachable tests and plan the same commands as a full scan', async () => {
    const root = makeRoot();
    for (const dir of ['test/a', 'test/b']) mkdirSync(join(root, dir), { recursive: true });
    const mock = "import { mock, test } from 'bun:test'; mock.module('x', () => ({})); test('m', () => {});\n";
    const plain = "import { test } from 'bun:test'; test('p', () => {});\n";
    writeFileSync(join(root, 'test/a/mock.test.ts'), mock);
    writeFileSync(join(root, 'test/a/plain.test.ts'), plain);
    writeFileSync(join(root, 'test/b/other-mock.test.ts'), mock);
    writeFileSync(join(root, 'test/b/plain.test.ts'), plain);
    const all = deriveTestFiles({ cwd: root });
    expect(deriveMockModuleTestFiles({ cwd: root, files: selectedTestFiles(['test/a'], all, root) }))
      .toEqual(['test/a/mock.test.ts']);
    expect(selectedTestFiles(['--dots', 'b/plain', './test/a/mock.test.ts'], all, root).sort())
      .toEqual(['test/a/mock.test.ts', 'test/b/plain.test.ts']);
    const fullMocks = deriveMockModuleTestFiles({ cwd: root });
    expect(fullMocks).toEqual(['test/a/mock.test.ts', 'test/b/other-mock.test.ts']);
    for (const argv of [
      ['test/a'], ['test/a/plain.test.ts'], ['test/a/plain.test.ts', 'test/a/mock.test.ts'],
      ['--dots', 'plain', 'other-mock'], ['mock'], ['./test/b/other-mock.test.ts', 'test/a'],
    ]) {
      const commands: string[][] = [];
      const code = await runDeterministicTestsOriginal({
        cwd: root,
        argv,
        mkdtempSync: () => makeRoot(),
        waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
        report: () => {},
        gitConfig: (_cwd, args) => args[0] === 'rev-parse' ? root : '',
        spawn: (opts) => {
          commands.push(opts.cmd);
          return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
        },
      });
      expect(code).toBe(0);
      const explicit = classifyExplicitTestFiles(argv, root);
      expect(commands).toEqual(planDeterministicTestCommands(
        argv, [], [...new Set([...fullMocks, ...explicit.mockFiles])], [...new Set([...all, ...explicit.files])], root,
      ));
    }
  });

  test('keeps syntax errors and unreadable discovered files isolated', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'broken.test.ts'), 'function (\n');
    const found = deriveMockModuleTestFiles({
      cwd: root,
      spawnSync: (() => ({
        exitCode: 0, stdout: Buffer.from('broken.test.ts\nmissing.test.ts\n'), stderr: Buffer.from(''),
      })) as unknown as typeof Bun.spawnSync,
    });
    expect(found).toEqual(['broken.test.ts', 'missing.test.ts']);
  });

  test('keeps a mixed selection in Bun path order and gives the mock its own process', () => {
    const commands = planDeterministicTestCommands(
      ['--dots', 'dashboard-handlers', 'pty-drive-action'], [],
      ['src/dashboard/slash-runtime/dashboard-handlers.test.ts'],
      ['src/dashboard/slash-runtime/dashboard-handlers.test.ts', 'test/pty-drive-action.test.ts'],
    );
    expect(commands).toEqual([
      ['bun', 'test', '--dots', 'src/dashboard/slash-runtime/dashboard-handlers.test.ts'],
      ['bun', 'test', '--dots', 'test/pty-drive-action.test.ts'],
    ]);
  });

  test('skips an empty bulk run when only a mock file was requested', () => {
    expect(planDeterministicTestCommands(
      ['--dots', 'dashboard-handlers'], [],
      ['src/dashboard/slash-runtime/dashboard-handlers.test.ts'],
      ['src/dashboard/slash-runtime/dashboard-handlers.test.ts'],
    )).toEqual([
      ['bun', 'test', '--dots', 'src/dashboard/slash-runtime/dashboard-handlers.test.ts'],
    ]);
    expect(planDeterministicTestCommands(
      ['./src/dashboard/slash-runtime/dashboard-handlers.test.ts'], [],
      ['src/dashboard/slash-runtime/dashboard-handlers.test.ts'],
      ['src/dashboard/slash-runtime/dashboard-handlers.test.ts'],
    )).toEqual([['bun', 'test', 'src/dashboard/slash-runtime/dashboard-handlers.test.ts']]);
  });

  test('full selection isolates every mock except CDP files', () => {
    expect(planDeterministicTestCommands(
      ['--dots'], ['test/browser.test.ts'],
      ['test/browser.test.ts', 'test/a.test.ts', 'test/b.test.ts'],
    )).toEqual([
      ['bun', 'test', '--path-ignore-patterns', 'test/browser.test.ts', '--path-ignore-patterns', 'test/a.test.ts', '--path-ignore-patterns', 'test/b.test.ts', '--pass-with-no-tests', '--dots'],
      ['bun', 'test', '--dots', 'test/a.test.ts'],
      ['bun', 'test', '--dots', 'test/b.test.ts'],
    ]);
  });

  test('keeps spaced Bun option values out of path selectors and on solo commands', () => {
    const mock = 'src/dashboard/slash-runtime/dashboard-handlers.test.ts';
    const plain = 'test/pty-drive-action.test.ts';
    expect(partitionBunTestArguments(['--test-name-pattern', 'dashboard-handlers', plain])).toEqual({
      selectors: [plain], soloArgs: ['--test-name-pattern', 'dashboard-handlers'],
    });
    expect(planDeterministicTestCommands(
      ['--test-name-pattern', 'dashboard-handlers', plain], [], [mock], [mock, plain],
    )).toEqual([['bun', 'test', '--test-name-pattern', 'dashboard-handlers', plain]]);
    expect(planDeterministicTestCommands(
      ['-t', 'dashboard-handlers', mock], [], [mock], [mock, plain],
    )).toEqual([['bun', 'test', '-t', 'dashboard-handlers', mock]]);
    expect(planDeterministicTestCommands(
      ['--test-name-pattern=dashboard-handlers', mock], [], [mock], [mock, plain],
    )).toEqual([['bun', 'test', '--test-name-pattern=dashboard-handlers', mock]]);
    expect(planDeterministicTestCommands(
      ['--test-name-pattern', 'dashboard-handlers'], [], [mock], [mock, plain],
    )).toEqual([
      ['bun', 'test', '--path-ignore-patterns', mock, '--test-name-pattern', 'dashboard-handlers'],
      ['bun', 'test', '--test-name-pattern', 'dashboard-handlers', mock],
    ]);
  });

  test('treats tokens after optional Bun flags as file selectors', () => {
    const mock = 'src/mock.test.ts';
    for (const flag of ['--bail', '--parallel', '--changed']) {
      expect(partitionBunTestArguments([flag, mock])).toEqual({
        selectors: [mock], soloArgs: [flag],
      });
      expect(planDeterministicTestCommands([flag, mock], [], [mock], [mock])).toEqual([
        ['bun', 'test', flag, mock],
      ]);
      expect(partitionBunTestArguments([`${flag}=2`, mock])).toEqual({
        selectors: [mock], soloArgs: [`${flag}=2`],
      });
    }
  });

  test('uses Bun final --cwd for mock and CDP discovery in another tree', async () => {
    const root = makeRoot();
    const earlier = join(root, 'earlier');
    const target = join(root, 'target');
    mkdirSync(earlier);
    mkdirSync(target);
    mkdirSync(join(target, 'test'));
    mkdirSync(join(target, 'scripts'));
    writeFileSync(join(target, 'test', 'mock.test.ts'), 'mock.module("x", () => ({}));');
    writeFileSync(join(target, 'test', 'browser.test.ts'), 'requireCdpBase();');
    writeFileSync(join(target, 'test', 'plain.test.ts'), 'test("plain", () => {});');
    expect(deriveMockModuleTestFiles({ cwd: target })).toEqual(['test/mock.test.ts']);
    expect(effectiveTestCwd(['--cwd', 'earlier', '--cwd=target'], root)).toBe(target);
    expect(effectiveTestCwd(['--', '--cwd=other'], root)).toBe(root);
    const argv = ['--cwd', earlier, `--cwd=${target}`];
    expect(effectiveTestCwd(argv, process.cwd())).toBe(target);
    const commands: string[][] = [];
    const code = await runDeterministicTestsOriginal({
      argv,
      spawn: (opts) => {
        commands.push(opts.cmd);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
    });
    expect(code).toBe(0);
    expect(commands).toEqual([
      ['bun', 'test', '--path-ignore-patterns', 'test/browser.test.ts', '--path-ignore-patterns', 'test/mock.test.ts', '--pass-with-no-tests', ...argv],
      ['bun', 'test', ...argv, 'test/mock.test.ts'],
    ]);
  });

  test('treats the spaced --timings argument as timing JSON, not a test selector', () => {
    expect(partitionBunTestArguments(['--timings', 'sample.test.ts'])).toEqual({
      selectors: [], soloArgs: ['--timings', 'sample.test.ts'],
    });
    expect(partitionBunTestArguments(['--timings'])).toEqual({ selectors: [], soloArgs: ['--timings'] });
    expect(partitionBunTestArguments(['--timings=times.json', 'sample.test.ts'])).toEqual({
      selectors: ['sample.test.ts'], soloArgs: ['--timings=times.json'],
    });
  });

  test('does not skip bulk when a selected Bun spec or JavaScript test remains', () => {
    const mock = 'src/shared.test.ts';
    const remaining = ['src/shared.spec.ts', 'src/shared.test.js'];
    expect(planDeterministicTestCommands(['shared'], [], [mock], [mock, ...remaining])).toEqual([
      ['bun', 'test', ...remaining],
      ['bun', 'test', mock],
    ]);
  });

  test('runs an ignored outside absolute mock alone while keeping its ordinary neighbor', () => {
    const root = makeRoot();
    const mock = join(root, 'mock.test.ts');
    const plain = join(root, 'plain.test.ts');
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    writeFileSync(join(root, '.gitignore'), 'mock.test.ts\n');
    writeFileSync(mock, "import { mock, test } from 'bun:test'; mock.module('virtual-test-module', () => ({}));\ntest('mock', () => {});\n");
    writeFileSync(plain, "import { test } from 'bun:test'; test('plain', () => {});\n");
    expect(classifyExplicitTestFiles([mock, plain], process.cwd())).toEqual({
      files: [mock, plain], mockFiles: [mock],
    });
    const child = spawnSync('bun', ['run', script, mock, plain], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    expect(child.status).toBe(0);
    expect(`${child.stdout}\n${child.stderr}`).toContain('mock.module 시험 파일을 각자 단독 프로세스로 실행한다');
    expect((`${child.stdout}\n${child.stderr}`).match(/Ran 1 test across 1 file/g) ?? []).toHaveLength(2);
    const missing = spawnSync('bun', ['run', script, mock, join(root, 'missing.test.ts')], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    expect(missing.status).not.toBe(0);
    const noNameMatch = spawnSync('bun', ['run', script, '--test-name-pattern', '__no_such_test__', mock], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    expect(noNameMatch.status).not.toBe(0);
  });

  test('preserves Bun verdict for mock-only partial and name selectors and an invalid neighbor', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'test', 'mock.test.ts'),
      "import { mock, test } from 'bun:test'; mock.module('virtual-test-module', () => ({}));\ntest('mock-only', () => {});\n");
    writeFileSync(join(root, 'test', 'plain.test.ts'),
      "import { test } from 'bun:test'; test('plain-only', () => {});\n");
    const run = (...args: string[]) => spawnSync('bun', ['run', script, '--cwd', root, ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    const partial = run('mock');
    expect(partial.status).toBe(0);
    expect(`${partial.stdout}\n${partial.stderr}`).toContain('1 pass');
    const name = run('--test-name-pattern', 'mock-only');
    expect(name.status).toBe(0);
    expect(`${name.stdout}\n${name.stderr}`).toContain('1 pass');
    const invalid = run('mock', 'missing-ordinary');
    expect(invalid.status).not.toBe(0);
  });

  test('keeps shared output options in one Bun child while preserving ordinary split options', async () => {
    const mock = 'src/mock.test.ts';
    const plain = 'src/plain.test.ts';
    for (const option of [
      ['--reporter-outfile', 'report.xml'], ['--reporter-outfile=report.xml'],
      ['--coverage', '--coverage-reporter=lcov'], ['--coverage', '--coverage-reporter', 'lcov'],
      ['--timings=timings.json', '--update-timings'],
    ]) {
      const messages: string[] = [];
      const commands: string[][] = [];
      const code = await runDeterministicTestsOriginal({
        argv: [...option, plain, mock],
        deriveMockModuleFiles: () => [mock],
        deriveTestFiles: () => [mock, plain],
        report: (message) => messages.push(message),
        spawn: (opts) => {
          commands.push(opts.cmd);
          return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
        },
        waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      });
      expect(code).toBe(0);
      expect(commands).toEqual([['bun', 'test', ...option, plain, mock]]);
      expect(messages.join('\n')).toContain('공유 파일 출력 옵션');
      expect(messages.join('\n')).not.toContain('각자 단독 프로세스');
    }
    const splitCommands: string[][] = [];
    expect(await runDeterministicTestsOriginal({
      argv: ['--coverage', '--coverage-reporter=text', mock, plain],
      deriveMockModuleFiles: () => [mock], deriveTestFiles: () => [mock, plain],
      spawn: (opts) => {
        splitCommands.push(opts.cmd);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
    })).toBe(0);
    expect(splitCommands.length).toBe(2);
    const commands: string[][] = [];
    const code = await runDeterministicTestsOriginal({
      argv: ['--reporter-outfile', 'report.xml', mock],
      deriveMockModuleFiles: () => [mock],
      deriveTestFiles: () => [mock],
      spawn: (opts) => {
        commands.push(opts.cmd);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
    });
    expect(code).toBe(0);
    expect(commands).toEqual([['bun', 'test', '--reporter-outfile', 'report.xml', mock]]);
  });

  test('rejects global shard and multi-failure bail across children; first-failure bail stops', async () => {
    const mock = 'src/mock.test.ts';
    const plain = 'src/plain.test.ts';
    for (const option of ['--shard=1/2', '--bail=2']) {
      let spawned = 0;
      const messages: string[] = [];
      const code = await runDeterministicTestsOriginal({
        argv: [option, mock, plain],
        deriveMockModuleFiles: () => [mock], deriveTestFiles: () => [mock, plain],
        report: (message) => messages.push(message),
        spawn: () => { spawned++; return { pid: process.pid, exited: Promise.resolve(0), kill: () => true }; },
      });
      expect(code).toBe(1);
      expect(spawned).toBe(0);
      expect(messages.join('\n')).toContain(option.startsWith('--shard') ? '--shard' : '--bail');
    }
    for (const bail of ['--bail', '--bail=1']) {
      let spawned = 0;
      const code = await runDeterministicTestsOriginal({
        argv: [bail, mock, plain],
        deriveMockModuleFiles: () => [mock], deriveTestFiles: () => [mock, plain],
        spawn: () => { spawned++; return { pid: process.pid, exited: Promise.resolve(3), kill: () => true }; },
        waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      });
      expect(code).toBe(3);
      expect(spawned).toBe(1);
    }
  });

  test('does not treat another option value as a multi-child control flag', async () => {
    const mock = 'src/mock.test.ts';
    const plain = 'src/plain.test.ts';
    for (const value of ['--shard=1/2', '--bail=2', '--reporter-outfile=report.xml']) {
      const commands: string[][] = [];
      const code = await runDeterministicTestsOriginal({
        argv: ['--test-name-pattern', value, mock, plain],
        deriveMockModuleFiles: () => [mock], deriveTestFiles: () => [mock, plain],
        spawn: (opts) => {
          commands.push(opts.cmd);
          return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
        },
        waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      });
      expect(code).toBe(0);
      expect(commands).toHaveLength(2);
    }
  });

  test('honors caller path-ignore-patterns when selecting solo mocks', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'test', 'mock.test.ts'),
      "import { mock, test } from 'bun:test'; mock.module('virtual-test-module', () => ({}));\ntest('mock', () => {});\n");
    writeFileSync(join(root, 'test', 'plain.test.ts'),
      "import { test } from 'bun:test'; test('plain', () => {});\n");
    for (const ignoreArg of [['--path-ignore-patterns', '**/mock.test.ts'], ['--path-ignore-patterns=**/mock.test.ts']]) {
      const child = spawnSync('bun', ['run', script, '--cwd', root, ...ignoreArg], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
      });
      expect(child.status).toBe(0);
      const output = `${child.stdout}\n${child.stderr}`;
      expect(output).toContain('1 pass');
      expect(output).toContain('Ran 1 test across 1 file');
      expect(output).not.toContain('(pass) mock');
    }
    const selected = ['--cwd', root, '--path-ignore-patterns', '**/mock.test.ts', 'test/mock.test.ts', 'test/plain.test.ts'];
    const raw = spawnSync('bun', ['test', ...selected], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    const runner = spawnSync('bun', ['run', script, ...selected], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    expect(raw.status).toBe(0);
    expect(runner.status).toBe(raw.status);
    expect(`${runner.stdout}\n${runner.stderr}`).toContain('Ran 1 test across 1 file');
    expect(`${runner.stdout}\n${runner.stderr}`).not.toContain('(pass) mock');
  });

  test('isolates an explicitly selected mock in a JavaScript or TypeScript file without test suffix', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'test', 'custom.ts'),
      "import { mock, test } from 'bun:test'; mock.module('virtual-test-module', () => ({}));\ntest('custom-mock', () => {});\n");
    writeFileSync(join(root, 'test', 'plain.test.ts'),
      "import { test } from 'bun:test'; test('plain', () => {});\n");
    const run = (args: string[]) => spawnSync('bun', ['run', script, '--cwd', root, ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    const bare = run(['test/custom.ts']);
    const rawBare = spawnSync('bun', ['test', 'test/custom.ts'], { cwd: root, encoding: 'utf8' });
    expect(bare.status).toBe(rawBare.status);
    expect(bare.status).not.toBe(0);
    const mixed = run(['test/custom.ts', 'test/plain.test.ts']);
    const rawMixed = spawnSync('bun', ['test', 'test/custom.ts', 'test/plain.test.ts'], { cwd: root, encoding: 'utf8' });
    expect(mixed.status).toBe(rawMixed.status);
    expect(`${mixed.stdout}\n${mixed.stderr}`).toContain('Ran 1 test across 1 file');
    expect(`${mixed.stdout}\n${mixed.stderr}`).not.toContain('custom-mock');
    for (const selector of ['./test/custom.ts', join(root, 'test', 'custom.ts')]) {
      const child = run([selector, 'test/plain.test.ts']);
      expect(child.status).toBe(0);
      expect((`${child.stdout}\n${child.stderr}`).match(/Ran 1 test across 1 file/g) ?? []).toHaveLength(2);
    }
  });

  test('allows an empty explicit directory with Bun pass-with-no-tests and still reports scan errors', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'empty'));
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'test', 'mock.test.ts'),
      "import { mock, test } from 'bun:test'; mock.module('virtual-test-module', () => ({}));\ntest('mock', () => {});\n");
    expect(deriveTestFiles({ cwd: join(root, 'empty') })).toEqual([]);
    const child = spawnSync('bun', ['run', script, '--cwd', root, '--pass-with-no-tests', 'empty'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    expect(child.status).toBe(0);
    expect(`${child.stdout}\n${child.stderr}`).not.toContain('(pass) mock');
    expect(() => deriveTestFiles({ spawnSync: (() => ({
      exitCode: 2, stdout: Buffer.from(''), stderr: Buffer.from('read error'),
    })) as unknown as typeof Bun.spawnSync })).toThrow('test file scan failed (exit 2): read error');
  });

  test('preserves global name-pattern verdict across bulk and solo children', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'test', 'mock.test.ts'),
      "import { mock, test } from 'bun:test'; mock.module('virtual-test-module', () => ({}));\ntest('mock-only', () => {}); test('fake', () => {});\n");
    writeFileSync(join(root, 'test', 'plain.test.ts'),
      "import { test } from 'bun:test'; test('plain-only', () => {}); test('plain-fail', () => { throw new Error('intentional'); }); test('fake-error', () => { console.error('error: regex \"fake\" matched 0 tests. Searched 1 file (skipping 1 test) [1.00ms]'); throw new Error('intentional fake'); });\n");
    const run = (name: string, ...rest: string[]) => spawnSync('bun',
      ['run', script, '--cwd', root, '--test-name-pattern', name, ...rest],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
    expect(run('plain-only').status).toBe(0);
    expect(run('mock-only').status).toBe(0);
    expect(run('mock-only', 'test').status).toBe(0);
    const invalidNeighbor = run('mock-only', 'test/mock.test.ts', 'test/missing.test.ts');
    expect(invalidNeighbor.status).not.toBe(0);
    expect(`${invalidNeighbor.stdout}\n${invalidNeighbor.stderr}`).toContain('test selector matched no files: test/missing.test.ts');
    expect(run('mock-only', 'test/mock.test.ts', 'test/missing.test.ts', '--pass-with-no-tests').status).toBe(0);
    expect(run('missing').status).not.toBe(0);
    expect(run('missing', '--pass-with-no-tests').status).toBe(0);
    const failed = run('plain-fail');
    expect(failed.status).not.toBe(0);
    expect(`${failed.stdout}\n${failed.stderr}`).toContain('intentional');
    const faked = run('fake');
    expect(faked.status).not.toBe(0);
    expect(`${faked.stdout}\n${faked.stderr}`).toContain('intentional fake');
  });

  test('finds exact no-match diagnostics before trailing stderr without mistaking a passing summary for no-match', async () => {
    const root = makeRoot();
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    const diagnostic = 'error: regex "missing" matched 0 tests. Searched 1 file (skipping 1 test) [1.00ms]';
    const evidenceFor = (stderr: string) => scanNamePatternStderr((async function* () {
      const bytes = new TextEncoder().encode(stderr);
      yield bytes.slice(0, 25);
      yield bytes.slice(25);
    })(), ['missing']);
    const run = async (stderr: string) => runDeterministicTestsOriginal({
      argv: ['--test-name-pattern', 'missing'],
      cwd: root,
      deriveCdpPatterns: () => [],
      deriveMockModuleFiles: () => ['a.test.ts', 'b.test.ts'],
      spawn: () => ({
        pid: process.pid,
        exited: Promise.resolve(0),
        kill: () => true,
        stderrEvidence: evidenceFor(stderr),
      }),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
    });
    expect(await run(`${diagnostic}\npreload wrote after Bun's diagnostic\n`)).toBe(1);
    expect(await run(`${diagnostic}\n 1 pass\n 0 fail\nRan 1 test across 1 file. [2.00ms]\n`)).toBe(0);
  });

  test('runs exact mock and ordinary selectors in Bun path order without dropping options', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'src'));
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    writeFileSync(join(root, '.gitignore'), 'src/mock.test.ts\n');
    writeFileSync(join(root, 'src', 'mock.test.ts'), 'mock.module("virtual-test-module", () => ({}));\n');
    writeFileSync(join(root, 'src', 'plain.test.ts'), 'test("plain", () => {});\n');
    const argv = ['--cwd', root, 'src/mock.test.ts', '--dots', 'src/plain.test.ts'];
    const commands: string[][] = [];
    const code = await runDeterministicTestsOriginal({
      argv,
      spawn: (opts) => {
        commands.push(opts.cmd);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
    });
    expect(code).toBe(0);
    expect(commands).toEqual([
      ['bun', 'test', '--cwd', root, '--dots', 'src/mock.test.ts'],
      ['bun', 'test', '--cwd', root, '--dots', 'src/plain.test.ts'],
    ]);
  });

  test('matches Bun exact-file order across ordinary and mock children with --bail', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.test.ts'), "import { mock, test } from 'bun:test'; mock.module('virtual-a', () => ({})); test('A fail', () => { throw new Error('intentional order'); });\n");
    writeFileSync(join(root, 'b.test.ts'), "import { mock, test } from 'bun:test'; mock.module('virtual-b', () => ({})); test('B later', () => {});\n");
    writeFileSync(join(root, 'plain.test.ts'), "import { test } from 'bun:test'; test('plain later', () => {});\n");
    const args = ['b.test.ts', 'plain.test.ts', 'a.test.ts', '--bail'];
    const raw = spawnSync('bun', ['test', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    const isolated = spawnSync('bun', ['run', script, '--cwd', root, ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    for (const result of [raw, isolated]) {
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain('intentional order');
      expect(output).not.toContain('B later');
      expect(output).not.toContain('plain later');
    }
  });

  test('matches Bun default discovery order before stopping on --bail', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.test.ts'), "import { mock, test } from 'bun:test'; mock.module('virtual-a', () => ({})); test('A fail', () => { throw new Error('intentional default order'); });\n");
    writeFileSync(join(root, 'b.test.ts'), "import { test } from 'bun:test'; test('B later', () => {});\n");
    writeFileSync(join(root, 'c.test.ts'), "import { mock, test } from 'bun:test'; mock.module('virtual-c', () => ({})); test('C later', () => {});\n");
    const raw = spawnSync('bun', ['test', '--bail'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    const isolated = spawnSync('bun', ['run', script, '--cwd', root, '--bail'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    for (const result of [raw, isolated]) {
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain('intentional default order');
      expect(output).not.toContain('B later');
      expect(output).not.toContain('C later');
    }
  });

  test('keeps ordinary runs on both sides of an exact mock in Bun path order', () => {
    expect(planDeterministicTestCommands(
      ['c.test.ts', 'b.test.ts', 'a.test.ts'], [], ['b.test.ts'],
      ['a.test.ts', 'b.test.ts', 'c.test.ts'],
    )).toEqual([
      ['bun', 'test', 'a.test.ts'],
      ['bun', 'test', 'b.test.ts'],
      ['bun', 'test', 'c.test.ts'],
    ]);
  });

  test('runs mock and ordinary files separately for relative and absolute directory selectors', () => {
    const root = makeRoot();
    const subdir = join(root, 'subdir');
    mkdirSync(subdir);
    writeFileSync(join(subdir, 'mock.test.ts'), "import { mock, test } from 'bun:test'; mock.module('virtual-test-module', () => ({}));\ntest('mock', () => {});\n");
    writeFileSync(join(subdir, 'plain.test.ts'), "import { test } from 'bun:test'; test('plain', () => {});\n");
    for (const selector of ['./subdir', subdir]) {
      const child = spawnSync('bun', ['run', script, '--cwd', root, selector], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
      });
      expect(child.status).toBe(0);
      expect((`${child.stdout}\n${child.stderr}`).match(/Ran 1 test across 1 file/g) ?? []).toHaveLength(2);
    }
  });

  test('keeps Bun preload values while excluding CDP and isolating mock files', async () => {
    const cdp = 'test/browser.test.ts';
    const mock = 'src/dashboard/slash-runtime/dashboard-handlers.test.ts';
    for (const flag of ['--preload', '-r', '--require', '--import']) {
      const argv = [flag, './setup.ts'];
      expect(partitionBunTestArguments(argv)).toEqual({ selectors: [], soloArgs: argv });
      expect(planDeterministicTestCommands(argv, [cdp], [cdp, mock])).toEqual([
        ['bun', 'test', '--path-ignore-patterns', cdp, '--path-ignore-patterns', mock, '--pass-with-no-tests', ...argv],
        ['bun', 'test', ...argv, mock],
      ]);
    }
    const commands: string[][] = [];
    const code = await runDeterministicTests({
      argv: ['--preload', './setup.ts'],
      deriveCdpPatterns: () => [cdp],
      deriveMockModuleFiles: () => [cdp, mock],
      spawn: (opts) => {
        commands.push(opts.cmd);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
    });
    expect(code).toBe(0);
    expect(commands).toEqual([
      ['bun', 'test', '--path-ignore-patterns', cdp, '--path-ignore-patterns', mock, '--pass-with-no-tests', '--preload', './setup.ts'],
      ['bun', 'test', '--preload', './setup.ts', mock],
    ]);
  });

  test('keeps Bun global value options from becoming test selectors', () => {
    const help = spawnSync('bun', ['--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    const options = (help.stdout ?? '').split('\n').flatMap((line) => {
      const long = line.match(/(--[a-z0-9-]+)=<val>/)?.[1];
      return long ? [long, ...(line.match(/^\s*(-[A-Za-z]),/)?.slice(1) ?? [])] : [];
    });
    expect(options).toContain('--env-file');
    for (const option of options) {
      expect(partitionBunTestArguments([option, 'value.test.ts']).selectors).toEqual([]);
    }
  });

  test('keeps --env-file value while excluding CDP and isolating mock files', async () => {
    const cdp = 'test/browser.test.ts';
    const mock = 'src/dashboard/slash-runtime/dashboard-handlers.test.ts';
    const commands: string[][] = [];
    const code = await runDeterministicTests({
      argv: ['--env-file', '.env.test'],
      deriveCdpPatterns: () => [cdp],
      deriveMockModuleFiles: () => [cdp, mock],
      spawn: (opts) => {
        commands.push(opts.cmd);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
    });
    expect(code).toBe(0);
    expect(commands).toEqual([
      ['bun', 'test', '--path-ignore-patterns', cdp, '--path-ignore-patterns', mock, '--pass-with-no-tests', '--env-file', '.env.test'],
      ['bun', 'test', '--env-file', '.env.test', mock],
    ]);
  });

  test('runs each selected mock in a separate child and combines nonzero results', async () => {
    const commands: string[][] = [];
    const code = await runDeterministicTests({
      argv: ['--dots', 'dashboard-handlers', 'pty-drive-action'],
      deriveMockModuleFiles: () => ['src/dashboard/slash-runtime/dashboard-handlers.test.ts'],
      deriveTestFiles: () => ['src/dashboard/slash-runtime/dashboard-handlers.test.ts', 'test/pty-drive-action.test.ts'],
      spawn: (opts) => {
        commands.push(opts.cmd);
        return { pid: process.pid, exited: Promise.resolve(commands.length === 1 ? 4 : 0), kill: () => true };
      },
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
    });
    expect(code).toBe(4);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(['bun', 'test', '--dots', 'src/dashboard/slash-runtime/dashboard-handlers.test.ts']);
    expect(commands[1]).toEqual(['bun', 'test', '--dots', 'test/pty-drive-action.test.ts']);
  });
});

describe('runDeterministicTests lifecycle', () => {
  test('propagates a normal child exit code and removes the temporary root', async () => {
    const testRoot = makeRoot();
    writeFileSync(join(testRoot, 'keep-me'), 'x');
    const leftover = makeRoot(TEMP_ROOT_PREFIX);
    writeFileSync(join(leftover, 'prior'), 'stale');
    let spawned: { cmd: string[]; stdin: string; stdout: string; stderr: string; detached: true; env: NodeJS.ProcessEnv } | undefined;
    const code = await runDeterministicTests({
      env: { ANTHROPIC_API_KEY: 'secret', PATH: '/bin' },
      argv: ['--dots', 'focused.test.ts'],
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: (opts) => {
        spawned = opts;
        return { pid: process.pid, exited: Promise.resolve(7), kill: () => true };
      },
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      killSelf: () => { throw new Error('normal exit must not re-signal self'); },
    });
    expect(code).toBe(7);
    expect(existsSync(testRoot)).toBe(false);
    expect(existsSync(leftover)).toBe(true);
    expect(spawned?.cmd).toEqual(['bun', 'test', '--dots', 'focused.test.ts']);
    expect(spawned?.stdin).toBe('inherit');
    expect(spawned?.stdout).toBe('inherit');
    expect(spawned?.stderr).toBe('inherit');
    expect(spawned?.detached).toBe(true);
    expect(spawned?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawned?.env.HOME).toBe(testRoot);
    expect(spawned?.env.ELANOUS_STATE_DIR).toBe(join(testRoot, 'state'));
  });

  test('SIGTERM kills the process group, removes the root, and re-signals SIGTERM', async () => {
    const testRoot = makeRoot();
    const hang = spawnHang();
    const groupSignals: NodeJS.Signals[] = [];
    let killedSelf: ShutdownSignal | undefined;
    await runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: () => ({
        pid: hang.pid,
        exited: hang.exited,
        kill(signal) { return hang.kill(signal); },
      }),
      waitForSignal: async () => 'SIGTERM',
      killSelf: (signal) => { killedSelf = signal; },
      childGraceMs: 1_000,
      killProcessGroup: (pid, signal) => {
        groupSignals.push(signal);
        killProcessGroup(pid, signal);
      },
    });
    expect(groupSignals[0]).toBe('SIGTERM');
    expect(killedSelf).toBe('SIGTERM');
    expect(existsSync(testRoot)).toBe(false);
    await expectDead(hang.pid!, 1_000);
  });

  test('SIGINT kills the process group, removes the root, and re-signals SIGINT', async () => {
    const testRoot = makeRoot();
    const hang = spawnHang();
    const groupSignals: NodeJS.Signals[] = [];
    let killedSelf: ShutdownSignal | undefined;
    await runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: () => ({
        pid: hang.pid,
        exited: hang.exited,
        kill(signal) { return hang.kill(signal); },
      }),
      waitForSignal: async () => 'SIGINT',
      killSelf: (signal) => { killedSelf = signal; },
      childGraceMs: 1_000,
      killProcessGroup: (pid, signal) => {
        groupSignals.push(signal);
        killProcessGroup(pid, signal);
      },
    });
    expect(groupSignals[0]).toBe('SIGINT');
    expect(killedSelf).toBe('SIGINT');
    expect(existsSync(testRoot)).toBe(false);
    await expectDead(hang.pid!, 1_000);
  });

  test('SIGTERM through the runner ends a grandchild in the child group', async () => {
    const testRoot = makeRoot();
    const pidPath = join(makeRoot(), 'grandchild.pid');
    const { child, grandchildPid } = await spawnHangWithGrandchild(pidPath);
    let killedSelf: ShutdownSignal | undefined;
    await runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: () => child,
      waitForSignal: async () => 'SIGTERM',
      killSelf: (signal) => { killedSelf = signal; },
      childGraceMs: 1_000,
    });
    expect(killedSelf).toBe('SIGTERM');
    await expectDead(child.pid!, 1_000);
    await expectDead(grandchildPid, 1_000);
    expect(existsSync(testRoot)).toBe(false);
  });

  test('SIGTERM through the runner SIGKILLs a grandchild that ignores SIGTERM after the child exits', async () => {
    const testRoot = makeRoot();
    const pidPath = join(makeRoot(), 'grandchild.pid');
    const { child, grandchildPid } = await spawnExitedLeaderWithTermIgnoringGrandchild(pidPath);
    expect(isLive(child.pid!)).toBe(false);
    expect(isLive(grandchildPid)).toBe(true);
    const groupSignals: NodeJS.Signals[] = [];
    let killedSelf: ShutdownSignal | undefined;
    await runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: () => ({
        pid: child.pid,
        // Leader already exited; keep this pending so the signal path, not the
        // normal-exit path, is the one that must reap the remaining group.
        exited: new Promise<number>(() => {}),
        kill(signal) { return child.kill(signal); },
      }),
      waitForSignal: async () => 'SIGTERM',
      killSelf: (signal) => { killedSelf = signal; },
      childGraceMs: 200,
      killProcessGroup: (pid, signal) => {
        groupSignals.push(signal);
        killProcessGroup(pid, signal);
      },
    });
    expect(killedSelf).toBe('SIGTERM');
    expect(groupSignals).toContain('SIGTERM');
    expect(groupSignals).toContain('SIGKILL');
    await expectDead(grandchildPid, 1_000);
    expect(existsSync(testRoot)).toBe(false);
  }, 15_000);

  test('SIGINT through the runner ends a grandchild in the child group', async () => {
    const testRoot = makeRoot();
    const pidPath = join(makeRoot(), 'grandchild.pid');
    const { child, grandchildPid } = await spawnHangWithGrandchild(pidPath);
    let killedSelf: ShutdownSignal | undefined;
    await runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: () => child,
      waitForSignal: async () => 'SIGINT',
      killSelf: (signal) => { killedSelf = signal; },
      childGraceMs: 1_000,
    });
    expect(killedSelf).toBe('SIGINT');
    await expectDead(child.pid!, 1_000);
    await expectDead(grandchildPid, 1_000);
    expect(existsSync(testRoot)).toBe(false);
  });

  test('group-kill failure through the runner is visible and still ends the direct child', async () => {
    const testRoot = makeRoot();
    const hang = spawnHang();
    const messages: string[] = [];
    let killedSelf: ShutdownSignal | undefined;
    await runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: () => hang,
      waitForSignal: async () => 'SIGTERM',
      killSelf: (signal) => { killedSelf = signal; },
      childGraceMs: 1_000,
      report: (message) => messages.push(message),
      killProcessGroup: () => { throw new Error('killpg failed: ESRCH'); },
    });
    expect(killedSelf).toBe('SIGTERM');
    expect(messages.join('\n')).toContain(`failed to signal process group pgid=${hang.pid}`);
    expect(messages.join('\n')).toContain('killpg failed: ESRCH');
    await expectDead(hang.pid!, 1_000);
    expect(existsSync(testRoot)).toBe(false);
  });

  test('fails if the signal path no longer terminates the direct child', async () => {
    const testRoot = makeRoot();
    const hang = spawnHang();
    let groupKilled = false;
    await runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: () => hang,
      waitForSignal: async () => 'SIGTERM',
      killSelf: () => {},
      childGraceMs: 1_000,
      killProcessGroup: (pid, signal) => {
        groupKilled = true;
        killProcessGroup(pid, signal);
      },
    });
    expect(groupKilled).toBe(true);
    expect(isLivePid(hang.pid!)).toBe(false);
  });

  test('a second SIGTERM during shutdown is absorbed before the child and root are cleaned', async () => {
    const testRoot = makeRoot();
    const hang = spawnHang();
    const target = new FakeSignalTarget();
    const absorbed: ShutdownSignal[] = [];
    let killedSelf: ShutdownSignal | undefined;
    const running = runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      signalTarget: target,
      onAbsorbSignal: (signal) => absorbed.push(signal),
      spawn: () => {
        queueMicrotask(() => {
          target.emit('SIGTERM');
          target.emit('SIGTERM');
          target.emit('SIGINT');
        });
        return {
          pid: hang.pid,
          exited: hang.exited,
          kill(signal) { return hang.kill(signal); },
        };
      },
      killSelf: (signal) => { killedSelf = signal; },
      childGraceMs: 1_000,
    });
    await running;
    expect(killedSelf).toBe('SIGTERM');
    expect(absorbed).toEqual(['SIGTERM', 'SIGINT']);
    expect(existsSync(testRoot)).toBe(false);
    expect(target.listenerCount('SIGTERM')).toBe(0);
    expect(target.listenerCount('SIGINT')).toBe(0);
    await expectDead(hang.pid!, 1_000);
  });

  test('cleans the temporary root and signal listeners when spawn throws', async () => {
    const testRoot = makeRoot();
    const target = new FakeSignalTarget();
    const messages: string[] = [];
    await expect(runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      signalTarget: target,
      spawn: () => { throw new Error('spawn failed'); },
      report: (message) => messages.push(message),
    })).rejects.toThrow('spawn failed');
    expect(existsSync(testRoot)).toBe(false);
    expect(target.listenerCount('SIGINT')).toBe(0);
    expect(target.listenerCount('SIGTERM')).toBe(0);
    expect(messages.some((message) => message.includes('spawn failed'))).toBe(true);
  });

  test('cleans the temporary root when child.exited rejects', async () => {
    const testRoot = makeRoot();
    const hang = spawnHang();
    const messages: string[] = [];
    await expect(runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      spawn: () => ({
        pid: hang.pid,
        exited: Promise.reject(new Error('exited rejected')),
        kill(signal) { return hang.kill(signal); },
      }),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      childGraceMs: 1_000,
    })).rejects.toThrow('exited rejected');
    expect(existsSync(testRoot)).toBe(false);
    expect(messages.some((message) => message.includes('exited rejected'))).toBe(true);
    await expectDead(hang.pid!, 1_000);
  });
});

describe('runtime entrypoint', () => {
  test('does not let inherited GIT_DIR redirect a bare init into the shared clone', async () => {
    const root = makeRoot('elanous-deterministic-bare-child-');
    const source = join(root, 'source');
    const shared = join(root, 'shared');
    const worktree = join(root, 'worktree');
    const fixtureEnv = { ...process.env };
    delete fixtureEnv.GIT_DIR;
    delete fixtureEnv.GIT_WORK_TREE;
    delete fixtureEnv.GIT_COMMON_DIR;
    const run = (args: string[], cwd = root): string => {
      const result = spawnSync('git', args, { cwd, env: fixtureEnv, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    run(['init', '-b', 'main', source]);
    writeFileSync(join(source, 'initial'), 'initial');
    run(['add', 'initial'], source);
    run(['-c', 'user.email=test@example.com', '-c', 'user.name=Tester', 'commit', '-m', 'initial'], source);
    run(['clone', source, shared]);
    run(['worktree', 'add', '-b', 'probe', worktree], shared);
    const readBare = () => run(['config', '--file', join(shared, '.git', 'config'), '--get', 'core.bare']);
    const probePath = join(root, 'child.json');
    const child = spawn(process.execPath, [script, writeProbeTest(worktree)], {
      cwd: worktree,
      env: {
        ...fixtureEnv,
        DETERMINISTIC_RUNNER_PROBE_PATH: probePath,
        DETERMINISTIC_RUNNER_PROBE_MODE: 'git-bare-leak',
        GIT_DIR: join(shared, '.git'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await collect(child);
    const probe = await waitForProbe(probePath);
    expect(result.code).toBe(0);
    expect(probe.GIT_DIR).toBeNull();
    expect(readBare()).toBe('false');
    expect(result.stderr).not.toContain('core.bare changed');
  }, 15_000);

  test('strips parent host identity and keeps the XDG deprecation warning off child stderr with a legacy config present', async () => {
    const directory = makeRoot('elanous-deterministic-live-');
    const legacyHome = makeRoot('elanous-deterministic-legacy-');
    const legacyDir = join(legacyHome, '.config', 'elanous');
    mkdirSync(legacyDir, { recursive: true });
    const legacyConfig = join(legacyDir, 'config.json');
    writeFileSync(legacyConfig, '{"llm":{"provider":"auto"}}');
    const probePath = join(directory, 'probe.json');
    const child = startRunner({
      DETERMINISTIC_RUNNER_PROBE_PATH: probePath,
      DETERMINISTIC_RUNNER_PROBE_MODE: 'xdg-warning',
      ELANOUS_HOST_ID: 'x',
      GIT_DIR: join(directory, 'inherited.git'),
      GIT_WORK_TREE: directory,
      GIT_COMMON_DIR: join(directory, 'inherited.git'),
      ELANOUS_TEST_HOME: legacyHome,
      XDG_CONFIG_HOME: join(legacyHome, '.config'),
      ELANOUS_TEST_FORCE_XDG_WARNING: '1',
      ELANOUS_STATE_DIR_SOURCE: 'derived',
    }, writeProbeTest(directory));
    const result = await collect(child);
    const probe = await waitForProbe(probePath);
    expect(result.code).toBe(0);
    expect(probe.ELANOUS_HOST_ID).toBeNull();
    expect(probe.GIT_DIR).toBeNull();
    expect(probe.GIT_WORK_TREE).toBeNull();
    expect(probe.GIT_COMMON_DIR).toBeNull();
    expect(probe.XDG_CONFIG_HOME).toBeNull();
    expect(probe.ELANOUS_TEST_HOME).toBe(probe.HOME);
    expect(result.stderr).not.toContain('XDG_CONFIG_HOME is set');
    expect(readFileSync(legacyConfig, 'utf8')).toBe('{"llm":{"provider":"auto"}}');
    expect(existsSync(probe.HOME)).toBe(false);
  }, 15_000);

  test('SIGTERM from the live entrypoint ends the direct child and removes the temporary root', async () => {
    const directory = makeRoot('elanous-deterministic-live-');
    const probePath = join(directory, 'probe.json');
    const probeFile = writeProbeTest(directory);
    const leftover = makeRoot(TEMP_ROOT_PREFIX);
    writeFileSync(join(leftover, 'prior'), 'stale');
    const child = startRunner({
      DETERMINISTIC_RUNNER_PROBE_PATH: probePath,
      DETERMINISTIC_RUNNER_PROBE_MODE: 'hang',
      ANTHROPIC_API_KEY: 'live-secret',
      APIFY_TOKEN: 'live-token',
    }, probeFile);
    try {
      const probe = await waitForProbe(probePath);
      expect(probe.HOME.includes(TEMP_ROOT_PREFIX)).toBe(true);
      expect(probe.XDG_CONFIG_HOME).toBeNull();
      expect(probe.ELANOUS_TEST_HOME).toBe(probe.HOME);
      expect(probe.ELANOUS_STATE_DIR).toBe(`${probe.HOME}/state`);
      expect(probe.ELANOUS_CONFIG_DIR).toBeNull();
      expect(probe.ANTHROPIC_API_KEY).toBeNull();
      expect(probe.APIFY_TOKEN).toBeNull();
      expect(existsSync(probe.HOME)).toBe(true);
      const directChildPid = probe.ppid === child.pid ? probe.pid : probe.ppid;
      child.kill('SIGTERM');
      const result = await collect(child);
      expect(result.signal).toBe('SIGTERM');
      expect(result.code).toBeNull();
      await expectDead(directChildPid, 2_000);
      expect(existsSync(probe.HOME)).toBe(false);
      expect(existsSync(leftover)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await once(child, 'close').catch(() => undefined);
      }
    }
  }, 15_000);

  test('SIGINT from the live entrypoint ends the direct child and removes the temporary root', async () => {
    const directory = makeRoot('elanous-deterministic-live-');
    const probePath = join(directory, 'probe.json');
    const probeFile = writeProbeTest(directory);
    const child = startRunner({
      DETERMINISTIC_RUNNER_PROBE_PATH: probePath,
      DETERMINISTIC_RUNNER_PROBE_MODE: 'hang',
    }, probeFile);
    try {
      const probe = await waitForProbe(probePath);
      const directChildPid = probe.ppid === child.pid ? probe.pid : probe.ppid;
      child.kill('SIGINT');
      const result = await collect(child);
      expect(result.signal).toBe('SIGINT');
      expect(result.code).toBeNull();
      await expectDead(directChildPid, 2_000);
      expect(existsSync(probe.HOME)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await once(child, 'close').catch(() => undefined);
      }
    }
  }, 15_000);

  test('normal child completion propagates the exit code and removes the temporary root', async () => {
    const directory = makeRoot('elanous-deterministic-live-');
    const probePath = join(directory, 'probe.json');
    const probeFile = writeProbeTest(directory);
    const child = startRunner({
      DETERMINISTIC_RUNNER_PROBE_PATH: probePath,
      DETERMINISTIC_RUNNER_PROBE_MODE: 'exit-1',
      ANTHROPIC_API_KEY: 'live-secret',
    }, probeFile);
    const probe = await waitForProbe(probePath);
    const result = await collect(child);
    expect(result.code).toBe(1);
    expect(existsSync(probe.HOME)).toBe(false);
    expect(probe.ANTHROPIC_API_KEY).toBeNull();
    expect(probe.HOME.includes(TEMP_ROOT_PREFIX)).toBe(true);
  }, 15_000);

  test('SIGTERM from the live entrypoint ends a grandchild spawned by the child', async () => {
    const directory = makeRoot('elanous-deterministic-live-');
    const probePath = join(directory, 'probe.json');
    const probeFile = writeProbeTest(directory);
    const child = startRunner({
      DETERMINISTIC_RUNNER_PROBE_PATH: probePath,
      DETERMINISTIC_RUNNER_PROBE_MODE: 'hang-grandchild',
    }, probeFile);
    try {
      const probe = await waitForProbe(probePath);
      expect(probe.grandchildPid).toBeTypeOf('number');
      const directChildPid = probe.ppid === child.pid ? probe.pid : probe.ppid;
      child.kill('SIGTERM');
      const result = await collect(child);
      expect(result.signal).toBe('SIGTERM');
      await expectDead(directChildPid, 2_000);
      await expectDead(probe.grandchildPid!, 2_000);
      expect(existsSync(probe.HOME)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await once(child, 'close').catch(() => undefined);
      }
    }
  }, 15_000);

  test('inherited stdout from a detached child still reaches this process', async () => {
    const directory = makeRoot('elanous-deterministic-live-');
    const probePath = join(directory, 'probe.json');
    const probeFile = writeProbeTest(directory);
    const child = startRunner({
      DETERMINISTIC_RUNNER_PROBE_PATH: probePath,
      DETERMINISTIC_RUNNER_PROBE_MODE: 'stdout-marker',
    }, probeFile, ['ignore', 'pipe', 'pipe']);
    const result = await collect(child);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('DETERMINISTIC_STDOUT_VISIBLE');
  }, 15_000);

  test('forced temporary-directory cleanup failure is visible with the path', async () => {
    const testRoot = makeRoot();
    const messages: string[] = [];
    await runDeterministicTests({
      mkdtempSync: () => testRoot,
      tmpdir: () => tmpdir(),
      rmSync: () => { throw new Error('EBUSY: resource busy'); },
      spawn: () => ({ pid: process.pid, exited: Promise.resolve(0), kill: () => true }),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
    });
    expect(messages.join('\n')).toContain(testRoot);
    expect(messages.join('\n')).toContain('failed to remove temporary root');
    expect(messages.join('\n')).toContain('EBUSY: resource busy');
    expect(existsSync(testRoot)).toBe(true);
  });
});
