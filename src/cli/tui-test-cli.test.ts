import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elanousInvocation, spawnElanous } from '../instance/spawn-elanous.js';
import { getElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { assertTestUniverseConfigMatches, buildHeldTuiArgs, buildHeldTuiLaunch, buildHeldTuiQuitArgs, buildHeldTuiRegistryArgs, parseReadyHeldPty, pwaBuildDecision, runTuiTestUniverse } from './tui-test-cli.js';

describe('tui test setup', () => {
  test('reuses an export, skips missing PWA by default, and builds only when requested', () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-test-pwa-'));
    const pwa = join(root, 'apps/pwa');
    try {
      mkdirSync(pwa, { recursive: true });
      expect(pwaBuildDecision(pwa)).toBe('skip');
      expect(pwaBuildDecision(pwa, true)).toBe('build');
      mkdirSync(join(pwa, 'out'), { recursive: true });
      writeFileSync(join(pwa, 'out/index.html'), '<html></html>');
      expect(pwaBuildDecision(pwa, true)).toBe('reuse');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('held TUI readiness comes from an alive same-universe PTY row with a runId', () => {
  expect(parseReadyHeldPty(JSON.stringify([
    { id: 'pty_dead0000', alive: false, runId: 'run-dead' },
    { id: 'pty_live0000', alive: true, runId: 'run-live' },
  ]))).toEqual({ id: 'pty_live0000', runId: 'run-live' });
  expect(parseReadyHeldPty(JSON.stringify([{ id: 'pty_wait0000', alive: true }]))).toBeUndefined();
});

test('held TUI uses the isolated Git worktree as its cwd', () => {
  expect(buildHeldTuiArgs('/repo/bin/elanous.mjs', '/repo/worktree/.elanous-test', 120_000, '/repo/worktree')).toEqual([
    '/repo/bin/elanous.mjs', 'dev', '--elanous', '--hold', '--json', '--isolated-root', '/repo/worktree/.elanous-test', '--ready-timeout-ms', '120000', '--cwd', '/repo/worktree',
  ]);
});

test('held TUI launch isolates launcher state from the test universe', () => {
  const launch = buildHeldTuiLaunch('/repo/bin/elanous.mjs', '/repo/worktree/.elanous-test', 120_000, '/repo/worktree');
  expect(launch.stateDir).toBe('/repo/worktree/.elanous-test-launcher');
  expect(launch.stateDir).not.toBe('/repo/worktree/.elanous-test');
  expect(launch.args).toContain('--isolated-root');
  expect(launch.args[launch.args.indexOf('--isolated-root') + 1]).toBe('/repo/worktree/.elanous-test');
  expect(launch.args).toContain('--ready-timeout-ms');
  expect(launch.args[launch.args.indexOf('--ready-timeout-ms') + 1]).toBe('120000');
});

test('held TUI registry queries use the isolated child universe', () => {
  expect(buildHeldTuiRegistryArgs('/repo/bin/elanous.mjs', '/repo/worktree/.elanous-test')).toEqual([
    '/repo/bin/elanous.mjs', '--config-dir', '/repo/worktree/.elanous-test', '--test-state-dir', '/repo/worktree/.elanous-test', 'pty', 'list', '--json',
  ]);
});

test('held TUI startup fails closed if the isolated config changes after Nexus readiness', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-test-config-stability-'));
  const expected = JSON.stringify({ onboarding: { ready: true }, global: { nexus: { pwa: { shareTailnet: 'disabled' } } } });
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), expected);
    expect(() => assertTestUniverseConfigMatches(root, expected)).not.toThrow();
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { ready: true }, global: { lateWrite: true } }));
    expect(() => assertTestUniverseConfigMatches(root, expected)).toThrow('changed while the held TUI was starting');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed one-command runs quit only PTYs in their isolated child universe', () => {
  expect(buildHeldTuiQuitArgs('/repo/bin/elanous.mjs', '/repo/worktree/.elanous-test', 'pty_live0000')).toEqual([
    '/repo/bin/elanous.mjs', '--config-dir', '/repo/worktree/.elanous-test', '--test-state-dir', '/repo/worktree/.elanous-test', 'pty', 'text', 'pty_live0000', '/quit', '--enter',
  ]);
});

test('runTuiTestUniverse closes its registered PTY and Nexus when snapshot fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-test-cleanup-'));
  const repoRoot = join(root, 'caller');
  mkdirSync(join(repoRoot, 'bin'), { recursive: true });
  writeFileSync(join(repoRoot, 'bin/elanous.mjs'), '');
  mkdirSync(join(repoRoot, 'node_modules'), { recursive: true });
  const previousConfigDir = getElanousConfigDir();
  setElanousConfigDir(join(root, 'config'));
  const calls: Array<{ command: string; args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  const spawned: Array<{ bin: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const killed: number[] = [];
  const ptyId = 'pty_cleanup0001';
  let registryPtyAlive = true;
  const run = (command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => {
    calls.push({ command, args, cwd, env });
    if (command === 'git' && args[0] === 'worktree') mkdirSync(args[4]!, { recursive: true });
    if (command === 'bun' && args.includes('sync-test')) {
      const stateDir = args[args.indexOf('--state-dir') + 1]!;
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ global: {}, onboarding: { ready: true } }));
    }
    if (args.includes('pty') && args.includes('list')) return { status: 0, stdout: JSON.stringify(registryPtyAlive ? [{ id: ptyId, runId: 'run-cleanup', alive: true }] : []), stderr: '' };
    if (args.includes('pty') && args.includes('text') && args.includes('/quit')) registryPtyAlive = false;
    if (args.includes('snapshot')) return { status: 1, stdout: '', stderr: 'injected snapshot failure' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const spawn = ((args: readonly string[], options: { bin?: string; env?: NodeJS.ProcessEnv; stdio?: readonly unknown[] }) => {
    spawned.push({ bin: options.bin ?? '', args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; unref(): void };
    child.pid = 4100 + spawned.length;
    child.exitCode = null;
    child.unref = () => {};
    const fd = options.stdio?.[1];
    if (typeof fd === 'number') {
      writeSync(fd, args.includes('nexus') ? 'http://127.0.0.1:31450\n' : '{"held":true}\n');
    }
    return child as never;
  }) as never;
  try {
    await expect(runTuiTestUniverse({ readyTimeoutMs: 5_000 }, {
      repoRoot, now: () => new Date('2026-11-01T00:00:00.000Z'), run,
      fetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      spawn,
      killProcessGroup: (pid) => { killed.push(pid); },
    })).rejects.toThrow('injected snapshot failure');

    const targetEntry = join(root, 'config/worktrees/tui-test/20261101-000000000Z/bin/elanous.mjs');
    expect(spawned.map((item) => item.bin)).toEqual([targetEntry, join(repoRoot, 'bin/elanous.mjs')]);
    expect(spawned[1]?.env?.ELANOUS_HOLD_TUI_REPO_ROOT).toBe(join(root, 'config/worktrees/tui-test/20261101-000000000Z'));
    expect(killed).toEqual([4102]);
    expect(calls.some(({ args }) => args.includes('pty') && args.includes('text') && args.includes(ptyId) && args.includes('/quit'))).toBe(true);
    expect(calls.some(({ args }) => args.includes('nexus') && args.includes('stop'))).toBe(true);
    expect(registryPtyAlive).toBe(false);
    expect(JSON.parse(run('bun', ['--config-dir', 'test-state', '--test-state-dir', 'test-state', 'pty', 'list', '--json'], repoRoot).stdout)).toEqual([]);
  } finally {
    setElanousConfigDir(previousConfigDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test('spawnElanous prepends the held TUI entry once and stamps a launcher root separate from the child root', () => {
  const entry = '/repo/bin/elanous.mjs';
  const childStateDir = '/repo/worktree/.elanous-test';
  const launch = buildHeldTuiLaunch(entry, childStateDir, 120_000, '/repo/worktree');
  const invocation = elanousInvocation(launch.args, { bin: entry, stateDir: launch.stateDir, env: {} });
  const heldArgs = buildHeldTuiArgs(entry, childStateDir, 120_000, '/repo/worktree');
  expect(invocation.args).toEqual(heldArgs);
  expect(invocation.args.filter((arg) => arg === entry)).toHaveLength(1);
  expect(invocation.env).toMatchObject({ ELANOUS_STATE_DIR: '/repo/worktree/.elanous-test-launcher' });
  expect(invocation.env.ELANOUS_STATE_DIR).not.toBe(childStateDir);
  expect(invocation.env.ELANOUS_STATE_DIR_SOURCE).toBeTruthy();
});

// Opt-in only: run the real Nexus, detached PTY owner and latest-main TUI on a
// remote host, then inject failure at snapshot and verify the real registry is
// empty. The evidence config path guard prevents touching a user's config.
if (process.env.ELANOUS_TUI_TEST_UNIVERSE_LIVE === '1') {
  test('live snapshot failure closes the real held PTY in its dedicated registry', async () => {
    const configDir = process.env.ELANOUS_TUI_TEST_UNIVERSE_LIVE_CONFIG_DIR;
    if (!configDir?.includes('/seat-state/OPC/evidence/')) throw new Error('live TUI test requires an OPC evidence-only config directory');
    const previousConfigDir = getElanousConfigDir();
    const repoRoot = process.cwd();
    const startedAt = new Date();
    const stamp = startedAt.toISOString().replace(/[-:.]/gu, '').replace('T', '-').replace('Z', 'Z');
    const invocations: Array<{ command: string; args: readonly string[] }> = [];
    const spawnedBins: string[] = [];
    const leakedTestEnvKeys: string[] = [];
    setElanousConfigDir(configDir);
    try {
      let failure = '';
      try {
        await runTuiTestUniverse({ readyTimeoutMs: 180_000 }, {
          repoRoot,
          now: () => startedAt,
          spawn: (args, options) => {
            if (options?.bin) spawnedBins.push(options.bin);
            return spawnElanous(args, options);
          },
          run: (command, args, cwd, env, timeoutMs) => {
            invocations.push({ command, args });
            for (const key of Object.keys(env ?? {})) if (key.startsWith('BUN_TEST')) leakedTestEnvKeys.push(key);
            if (args.includes('snapshot')) return { status: 1, stdout: '', stderr: 'injected live snapshot failure' };
            const child = spawnSync(command, [...args], { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
            return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '', ...(child.error ? { error: child.error } : {}) };
          },
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      expect(failure).toContain('injected live snapshot failure');
      const worktree = join(configDir, 'worktrees/tui-test', stamp);
      const targetEntry = join(worktree, 'bin/elanous.mjs');
      const testStateDir = join(worktree, '.elanous-test');
      const registry = spawnSync('bun', buildHeldTuiRegistryArgs(targetEntry, testStateDir), {
        cwd: worktree, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      expect(registry.status).toBe(0);
      const rows = JSON.parse(registry.stdout || '[]') as Array<{ id?: string; alive?: boolean }>;
      expect(rows).toEqual([]);
      expect(spawnedBins).toEqual([targetEntry, join(repoRoot, 'bin/elanous.mjs')]);
      expect(leakedTestEnvKeys).toEqual([]);
      expect(invocations.some(({ args }) => args.includes('pty') && args.includes('text') && args.includes('/quit'))).toBe(true);
      expect(invocations.some(({ args }) => args.includes('nexus') && args.includes('stop'))).toBe(true);
      console.log(JSON.stringify({ implementationHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim(), worktree, spawnedBins, postCleanupRegistry: rows }));
    } finally {
      setElanousConfigDir(previousConfigDir);
    }
  }, 300_000);
}
