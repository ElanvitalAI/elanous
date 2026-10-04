import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupTemporaryRoot,
  getProcessGroupId,
  installShutdownSignalGate,
  isLivePid,
  isLiveProcessGroup,
  killProcessGroup,
  prepareIsolatedTestEnv,
  runDeterministicTests,
  TEMP_ROOT_PREFIX,
  terminateDirectChild,
  type DirectChild,
  type ShutdownSignal,
  type SignalTarget,
} from './test-deterministic.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const source = readFileSync('scripts/test-deterministic.ts', 'utf8');
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
  const grandchildBody = 'process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); process.on("SIGINT", () => {}); await Bun.sleep(60_000);';
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', `
      import { writeFileSync } from 'node:fs';
      const g = Bun.spawn({
        cmd: ${JSON.stringify([process.execPath, '-e', grandchildBody])},
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      g.unref();
      writeFileSync(${JSON.stringify(pidPath)}, String(g.pid));
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
    expect(source).toContain("import { isCredentialKey } from './lib/deterministic-env.js';");
    expect(source).toContain("'ELANOUS_HARNESS_SPACE'");
    expect(source).toContain('!isCredentialKey(key)');
    expect(source).toContain('!HARNESS_TEST_ENV_KEYS.includes');
    expect(source).toContain('!EXECUTION_ORIGIN_ENV_KEYS.includes');
    expect(source).toContain('env.HOME = testRoot;');
    expect(source).toContain('delete env.XDG_CONFIG_HOME;');
    expect(source).toContain('env.ELANOUS_TEST_HOME = testRoot;');
    expect(source).toContain("env.ELANOUS_STATE_DIR = join(testRoot, 'state');");
    expect(source).toContain('delete env.ELANOUS_CONFIG_DIR;');
    expect(source).not.toMatch(/env\.ELANOUS_CONFIG_DIR\s*=/);
    expect(source).toContain('env,');
    expect(source).toContain("stdin: 'inherit'");
    expect(source).toContain("stdout: 'inherit'");
    expect(source).toContain("stderr: 'inherit'");
    expect(source).toContain('detached: true');
    // ⛔ 이 칸이 지키는 «뜻»은 「사람이 준 argv 가 bun test 까지 그대로 간다」다.
    //   2026-09-24: CDP 레인 분리로 그 앞에 ...ignoreArgs 가 붙었다 — argv 통과는 그대로다.
    expect(source).toContain("cmd: ['bun', 'test', ...ignoreArgs, ...argv]");
    expect(source).toContain("join(tempBase(), TEMP_ROOT_PREFIX)");
    expect(source).toContain("export const TEMP_ROOT_PREFIX = 'elanous-deterministic-test-';");
    expect(source).toContain('if (import.meta.main)');
    expect(source).toContain('await runDeterministicTests()');
    expect(source).toContain('const defaultSpawn: SpawnDirectChild = (opts) => Bun.spawn({');
    expect(source).not.toContain("Bun.spawnSync({\n  cmd: ['bun', 'test'");
  });

  test('signal path terminates the process group before cleanup and retries once with SIGKILL', () => {
    const signalBlock = source.slice(source.indexOf("if (outcome.kind === 'signal')"));
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
      argv: ['scripts/test-deterministic.test.ts'],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      gitConfig: (_cwd, args) => {
        if (args[0] === 'rev-parse') return join(process.cwd(), '.git');
        if (args.includes('--get-all')) return values;
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
    expect(reads).toBe(2);
  });

  test('does not raise an alert when core.bare remains unchanged', async () => {
    const messages: string[] = [];
    const code = await runDeterministicTests({
      argv: ['scripts/test-deterministic.test.ts'],
      mkdtempSync: () => makeRoot(),
      waitForSignal: () => new Promise<ShutdownSignal>(() => {}),
      report: (message) => messages.push(message),
      spawn: () => ({ pid: process.pid, exited: Promise.resolve(0), kill: () => true }),
    });
    expect(code).toBe(0);
    expect(messages).toEqual([]);
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
