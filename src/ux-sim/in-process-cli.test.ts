import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simCli } from './in-process-cli.js';


test('in-process CLI restores process.exitCode after a command failure', async () => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const result = await simCli(['control', 'member', '--once', '--json'], {
      allowPaths: [['control', 'member']],
    });
    expect(result.exitCode).toBe(2);
    expect(process.exitCode ?? 0).toBe(0);
  } finally {
    process.exitCode = previousExitCode ?? 0;
  }
}, 30_000);


test('registered where action runs in an isolated universe without spawn', async () => {
  const oldArgv = process.argv;
  const oldState = process.env.ELANOUS_STATE_DIR;
  const first = await simCli(['where', '--json']);
  expect(first.exitCode).toBe(0);
  const observed = JSON.parse(first.stdout);
  expect(observed.kind).toBe('test');
  expect(observed.root).toBe(first.stateRoot);
  expect(observed.configDir).toBe(first.stateRoot);
  expect(existsSync(first.stateRoot)).toBe(false);
  expect(process.argv).toBe(oldArgv);
  expect(process.env.ELANOUS_STATE_DIR).toBe(oldState);

  // Commander command options must not leak into the next simulated turn.
  const second = await simCli(['where']);
  expect(second.exitCode).toBe(0);
  expect(second.stdout).toContain('지금 어느 우주인가');
  expect(second.stdout).not.toContain('"configDir"');
  expect(existsSync(second.stateRoot)).toBe(false);
}, 30_000);

test('unsafe command and root override are rejected before touching global state', async () => {
  const argv = process.argv;
  await expect(simCli(['pr', 'land', '123'], { allowPaths: [['where']] })).rejects.toThrow('not allowed');
  await expect(simCli(['--config-dir', '/outside/config', 'where'])).rejects.toThrow('under the temporary test root');
  expect(process.argv).toBe(argv);
});

test('in-process mode isolates cwd and ELANOUS environment, then restores both', async () => {
  const originalCwd = process.cwd();
  const originalState = process.env.ELANOUS_STATE_DIR;
  const originalMarker = process.env.ELANOUS_SIM_CLI_MARKER;
  const cwd = mkdtempSync(join(tmpdir(), 'ux-sim-cli-cwd-'));
  try {
    process.env.ELANOUS_STATE_DIR = '/outside/state';
    process.env.ELANOUS_SIM_CLI_MARKER = 'parent';
    const result = await simCli(['where', '--json'], {
      cwd,
      env: { ELANOUS_SIM_CLI_MARKER: 'child', ELANOUS_STATE_DIR: '/ignored/state' },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'test', root: result.stateRoot, actualRoot: result.stateRoot });
    expect(process.cwd()).toBe(originalCwd);
    expect(process.env.ELANOUS_STATE_DIR).toBe('/outside/state');
    expect(process.env.ELANOUS_SIM_CLI_MARKER).toBe('parent');
  } finally {
    if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = originalState;
    if (originalMarker === undefined) delete process.env.ELANOUS_SIM_CLI_MARKER;
    else process.env.ELANOUS_SIM_CLI_MARKER = originalMarker;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('allowPaths matches registered commands and leaves positional arguments out', async () => {
  const result = await simCli(['config', 'get', 'llm.provider'], { allowPaths: [['config', 'get']] });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(0);
  await expect(simCli(['config', 'set', 'llm.provider', 'openai'], { allowPaths: [['config']] }))
    .rejects.toThrow('not allowed');
});

test('allowPaths accepts a registered Commander alias by its invoked name', async () => {
  const result = await simCli(['drive', '--help'], { allowPaths: [['drive']] });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('drive');
});

test('omitted allowPaths permits only safe read-only commands', async () => {
  await expect(simCli(['pr', 'land', '123'])).rejects.toThrow('not allowed');
  const safe = await simCli(['where', '--json']);
  expect(safe.exitCode).toBe(0);
  await expect(simCli(['drive', '--help'], { allowPaths: [['where']] })).rejects.toThrow('not allowed');
  const explicit = await simCli(['drive', '--help'], { allowPaths: [['drive']] });
  expect(explicit.exitCode).toBe(0);
  expect(explicit.stdout).toContain('drive');
});

test('environment deletions are applied and every process variable is restored after a simulated turn', async () => {
  const before = { ...process.env };
  const originalHome = process.env.HOME;
  const hadHome = Object.hasOwn(process.env, 'HOME');
  try {
    process.env.HOME = '/tmp/sim-cli-parent-home';
    let homeWasAbsent = false;
    const result = await simCli(['where', '--json'], {
      env: { HOME: undefined, ELANOUS_SIM_CLI_NEW: 'child' },
      beforeParse: () => {
        homeWasAbsent = process.env.HOME === undefined;
      },
      afterDispatch: () => {
        process.env.ELANOUS_SIM_CLI_NEW = 'changed-by-command';
        process.env.ELANOUS_SIM_CLI_ADDED = 'added-by-command';
      },
    });
    expect(result.exitCode).toBe(0);
    expect(homeWasAbsent).toBe(true);
    expect(process.env.HOME).toBe('/tmp/sim-cli-parent-home');
    expect(process.env.ELANOUS_SIM_CLI_NEW).toBe(before.ELANOUS_SIM_CLI_NEW);
    expect(process.env.ELANOUS_SIM_CLI_ADDED).toBe(before.ELANOUS_SIM_CLI_ADDED);
    let secondTurnSawRestoredEnv = false;
    const second = await simCli(['where', '--json'], {
      beforeParse: () => {
        secondTurnSawRestoredEnv = process.env.HOME === '/tmp/sim-cli-parent-home'
          && process.env.ELANOUS_SIM_CLI_NEW === before.ELANOUS_SIM_CLI_NEW
          && process.env.ELANOUS_SIM_CLI_ADDED === before.ELANOUS_SIM_CLI_ADDED;
      },
    });
    expect(second.exitCode).toBe(0);
    expect(secondTurnSawRestoredEnv).toBe(true);
  } finally {
    if (hadHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
  }
});

test('explicit spawn mode confirms the where contract at the real entry boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-cli-entry-'));
  try {
    const run = await simCli(['where', '--json'], { mode: 'spawn', stateRoot: root, timeoutMs: 20_000 });
    expect(run.exitCode).toBe(0);
    const observed = JSON.parse(run.stdout);
    expect(observed.kind).toBe('test');
    expect(observed.root).toBe(root);
    expect(observed.configDir).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

test('TMP-DIR-LEAK: detached task child cleanup follows the simCli real entry boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-task-launch-'));
  const scratch = mkdtempSync(join(root, 'tasks-cli-launch-'));
  const stderrPath = join(scratch, 'detached-child.stderr');
  const started = join(root, 'detached-child.started');
  const finished = join(root, 'detached-child.finished');
  const wrapper = resolve(import.meta.dir, 'fixtures/task-launch-entry.mjs');
  const supervisor = resolve(import.meta.dir, '../cli/task-launch-supervisor.ts');
  const realEntry = resolve(import.meta.dir, '../../bin/elanous.mjs');
  writeFileSync(stderrPath, '');
  try {
    const run = await simCli(['where', '--json'], {
      mode: 'spawn', entrypoint: wrapper, allowPaths: [['where']],
      stateRoot: join(root, 'state'), timeoutMs: 20_000,
      env: { ELANOUS_TASK_LAUNCH_FIXTURE: [scratch, supervisor, started, finished, realEntry].join('\n') },
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ kind: 'test', root: join(root, 'state') });
    for (let attempt = 0; attempt < 40 && !existsSync(started); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(existsSync(started)).toBe(true);
    expect(existsSync(scratch)).toBe(true);
    for (let attempt = 0; attempt < 80 && (existsSync(scratch) || !existsSync(finished)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(finished)).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('spawn timeout force-kills a child that ignores SIGTERM after the grace period', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-ignore-term-'));
  const wrapper = join(root, 'ignore-term.mjs');
  writeFileSync(wrapper, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
  const started = Date.now();
  try {
    const result = await simCli(['where', '--json'], {
      mode: 'spawn', entrypoint: wrapper, injectTestFlag: false,
      stateRoot: join(root, 'state'), timeoutMs: 100,
    });
    expect(result.stderr).toContain('CLI spawn timed out');
    expect(result.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('spawn timeout and abort terminate a non-detached child process', async () => {
  const timedOut = await simCli(['where', '--json'], {
    mode: 'spawn', detached: false, timeoutMs: 1,
  });
  expect(timedOut.stderr).toContain('CLI spawn timed out');
  expect(timedOut.signal).not.toBeNull();

  const controller = new AbortController();
  const pending = simCli(['where', '--json'], {
    mode: 'spawn', detached: false, timeoutMs: 20_000, signal: controller.signal,
  });
  controller.abort();
  const aborted = await pending;
  expect(aborted.signal).not.toBeNull();
}, 60_000);
test('in-process CLI preserves a preexisting nonzero process.exitCode', async () => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = 7;
    const result = await simCli(['control', 'member', '--once', '--json'], {
      allowPaths: [['control', 'member']],
    });
    expect(result.exitCode).toBe(2);
    expect(process.exitCode).toBe(7);
  } finally {
    process.exitCode = previousExitCode ?? 0;
  }
}, 30_000);
