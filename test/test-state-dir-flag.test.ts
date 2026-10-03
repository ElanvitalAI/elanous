// `--test-state-dir <dir>` + `setTestStateRoot()` contract.
//
// 2026-05-13 · config-dir-unify — internal CLI flag that bg-launch
// re-appends to the child argv to inherit the parent's test state
// root override. Replaces the removed `ELANOUS_NEXUS_DIR` env var.
// Public surface for users remains `--test`; this is the wire.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import {
  extractTestStateDirFlag,
  applyTestStateDirFlagFromArgv,
} from '../src/cli/test-state-dir-flag';
import {
  setTestStateRoot,
  getTestStateRoot,
  nexusRootDir,
  nexusLockPath,
  nexusRuntimePath,
  nexusTabsDir,
  nexusLogsDir,
} from '../src/nexus/paths';
import { applyIsolatedRoot } from '../src/cli/test-state-dir-flag';
import {
  setElanousConfigDir,
  resetElanousConfigDir,
} from '../src/elanous-config-dir';
import { setUserConfigOverlay, resetUserConfig, getUserConfig } from '../src/user-config';

let savedArgv: string[];
let savedStateDir: string | undefined;
let savedNexusDir: string | undefined;

beforeEach(() => {
  savedArgv = [...process.argv];
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  savedNexusDir = process.env.ELANOUS_NEXUS_DIR;
  delete process.env.ELANOUS_NEXUS_DIR;
  setTestStateRoot(null);
  resetElanousConfigDir();
});

afterEach(() => {
  process.argv = savedArgv;
  setTestStateRoot(null);
  resetElanousConfigDir();
  // Clean the new test-daemon isolation side effects.
  setUserConfigOverlay(null);
  resetUserConfig();
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = savedStateDir;
  if (savedNexusDir === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = savedNexusDir;
});

describe('extractTestStateDirFlag · pure parser', () => {
  it('returns undefined when the flag is absent', () => {
    const r = extractTestStateDirFlag(['elanous', 'nexus', 'run']);
    expect(r.dir).toBeUndefined();
    expect(r.argv).toEqual(['elanous', 'nexus', 'run']);
  });

  it('parses `--test-state-dir <dir>` at any position', () => {
    const r = extractTestStateDirFlag(['elanous', '--test-state-dir', '/repo/.elanous-test', 'nexus', 'run']);
    expect(r.dir).toBe('/repo/.elanous-test');
    expect(r.argv).toEqual(['elanous', 'nexus', 'run']);
  });

  it('parses the `--test-state-dir=<dir>` long form', () => {
    const r = extractTestStateDirFlag(['elanous', 'nexus', 'run', '--test-state-dir=/x/y']);
    expect(r.dir).toBe('/x/y');
    expect(r.argv).toEqual(['elanous', 'nexus', 'run']);
  });

  it('ignores empty values', () => {
    expect(extractTestStateDirFlag(['elanous', '--test-state-dir=']).dir).toBeUndefined();
    expect(extractTestStateDirFlag(['elanous', '--test-state-dir', '   ']).dir).toBeUndefined();
  });

  it('does not mutate the input array', () => {
    const argv = ['elanous', '--test-state-dir', '/x'];
    const snapshot = [...argv];
    extractTestStateDirFlag(argv);
    expect(argv).toEqual(snapshot);
  });
});

describe('applyTestStateDirFlagFromArgv · side-effecting bootstrap', () => {
  it('routes the flag through setTestStateRoot', () => {
    process.argv = ['bun', 'src/index.ts', '--test-state-dir', '/tmp/state', 'nexus', 'run'];
    const dir = applyTestStateDirFlagFromArgv();
    expect(dir).toBe('/tmp/state');
    expect(getTestStateRoot()).toBe('/tmp/state');
    expect(process.argv).toEqual(['bun', 'src/index.ts', 'nexus', 'run']);
  });

  it('is a no-op when the flag is absent', () => {
    process.argv = ['bun', 'src/index.ts', 'nexus', 'run'];
    const before = process.env.ELANOUS_STATE_DIR;
    const dir = applyTestStateDirFlagFromArgv();
    expect(dir).toBeUndefined();
    expect(getTestStateRoot()).toBeUndefined();
    // No flag → no isolation side effects.
    expect(process.env.ELANOUS_STATE_DIR).toEqual(before);
  });

  it('completes the isolation — sets ELANOUS_STATE_DIR + installs the test-safe overlay', () => {
    Reflect.deleteProperty(process.env, 'ELANOUS_STATE_DIR');
    process.argv = ['bun', 'src/index.ts', '--test-state-dir', '/tmp/dstate', 'nexus', 'run'];
    applyTestStateDirFlagFromArgv();
    // 1) all mutable state relocates under the test root
    expect(process.env.ELANOUS_STATE_DIR).toBe('/tmp/dstate');
    // 2) the config overlay is live — getUserConfig now returns test-safe
    //    (discord disabled, prod telegram routes dropped).
    const cfg = getUserConfig();
    expect(cfg.discord.enabled).toBe(false);
    expect(cfg.telegram.reportChannel).toBeUndefined();
    expect(cfg.telegram.channels).toBeUndefined();
  });

  it('does not clobber an already-set ELANOUS_STATE_DIR', () => {
    process.env.ELANOUS_STATE_DIR = '/tmp/preset';
    process.argv = ['bun', 'src/index.ts', '--test-state-dir', '/tmp/dstate', 'nexus', 'run'];
    applyTestStateDirFlagFromArgv();
    expect(process.env.ELANOUS_STATE_DIR).toBe('/tmp/preset');
  });
});

describe('setTestStateRoot / nexusRootDir · state-only override', () => {
  it('nexusRootDir defaults to <config-dir>/nexus', () => {
    const { getElanousConfigDir } = require('../src/elanous-config-dir');
    expect(nexusRootDir()).toBe(join(getElanousConfigDir(), 'nexus'));
  });

  it('honours setTestStateRoot — config dir is left alone', () => {
    setTestStateRoot('/repo/.elanous-test');
    expect(nexusRootDir()).toBe('/repo/.elanous-test/nexus');
    // The config dir resolver is untouched — this is the whole point
    // of --test no longer redirecting config.json.
    const { getElanousConfigDir } = require('../src/elanous-config-dir');
    expect(getElanousConfigDir()).not.toBe('/repo/.elanous-test');
  });

  it('follows --config-dir override when no test root is set', () => {
    setElanousConfigDir('/tmp/custom');
    expect(nexusRootDir()).toBe(join('/tmp/custom', 'nexus'));
  });

  it('test state root beats --config-dir override', () => {
    setElanousConfigDir('/tmp/custom');
    setTestStateRoot('/repo/.elanous-test');
    expect(nexusRootDir()).toBe('/repo/.elanous-test/nexus');
  });

  it('all root inputs keep lock, runtime, tabs, and logs under one canonical nexus directory', () => {
    const root = '/repo/.elanous-test';
    const expected = join(root, 'nexus');
    const expectedPaths = [
      expected,
      join(expected, '.lock'),
      join(expected, 'runtime.json'),
      join(expected, 'tabs'),
      join(expected, 'logs'),
    ];
    const paths = () => [nexusRootDir(), nexusLockPath(), nexusRuntimePath(), nexusTabsDir(), nexusLogsDir()];

    applyIsolatedRoot(root);
    expect(paths()).toEqual(expectedPaths);

    setTestStateRoot(null);
    setElanousConfigDir(root);
    expect(paths()).toEqual(expectedPaths);

    resetElanousConfigDir();
    process.env.ELANOUS_NEXUS_DIR = expected;
    expect(paths()).toEqual(expectedPaths);

    delete process.env.ELANOUS_NEXUS_DIR;
    resetElanousConfigDir();
    const prodRoot = join(require('../src/elanous-config-dir').getElanousConfigDir(), 'nexus');
    expect(paths()).toEqual([
      prodRoot,
      join(prodRoot, '.lock'),
      join(prodRoot, 'runtime.json'),
      join(prodRoot, 'tabs'),
      join(prodRoot, 'logs'),
    ]);
  });

  it('keeps legacy files in place while resolving the canonical path', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-test-state-'));
    try {
      const legacyLock = join(root, '.lock');
      writeFileSync(legacyLock, 'legacy lock');

      applyIsolatedRoot(root);
      expect(nexusRootDir()).toBe(join(root, 'nexus'));
      expect(existsSync(legacyLock)).toBe(true);
      expect(existsSync(join(root, 'nexus', '.lock'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('global --test status finds and stop terminates a live legacy isolated daemon', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elanous-nexus-legacy-cli-'));
    const testRoot = join(realpathSync(repo), '.elanous-test');
    const elanousBin = join(process.cwd(), 'bin', 'elanous.mjs');
    mkdirSync(join(repo, '.git'));
    mkdirSync(testRoot, { recursive: true });
    const daemon = spawn('bun', ['-e', "process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1_000)"], { stdio: 'ignore' });
    const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(50);
      }
      throw new Error(message);
    };

    try {
      writeFileSync(join(testRoot, '.lock'), JSON.stringify({
        pid: daemon.pid!, host: hostname(), startedAt: new Date().toISOString(), label: 'legacy-test',
      }));
      writeFileSync(join(testRoot, 'runtime.json'), JSON.stringify({
        pid: daemon.pid!, startedAt: new Date().toISOString(), nexusVersion: 'legacy', phase: 'legacy-layout',
      }));

      const status = spawnSync('bun', [elanousBin, '--test', 'nexus', 'status'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`root      ${testRoot}`);
      expect(status.stdout).toContain(`status    lock alive, http silent (pid=${daemon.pid}`);

      const stop = spawnSync('bun', [elanousBin, '--test', 'nexus', 'stop'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect(stop.status).toBe(0);
      await waitFor(() => {
        try {
          process.kill(daemon.pid!, 0);
          return false;
        } catch {
          return true;
        }
      }, 'global --test stop did not terminate the legacy daemon');

      applyIsolatedRoot(testRoot);
      const release = (await import('../src/nexus/supervisor/lock.js')).acquireNexusLock();
      try {
        expect(existsSync(join(testRoot, 'nexus', '.lock'))).toBe(true);
      } finally {
        release();
      }
    } finally {
      if (daemon.exitCode === null) daemon.kill('SIGINT');
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it('prefers a live canonical daemon over a live legacy daemon', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-nexus-canonical-wins-'));
    const canonical = spawn('sleep', ['1000'], { stdio: 'ignore' });
    const legacy = spawn('sleep', ['1000'], { stdio: 'ignore' });
    try {
      mkdirSync(join(root, 'nexus'), { recursive: true });
      const runtime = (pid: number) => JSON.stringify({ pid, startedAt: new Date().toISOString(), nexusVersion: 'test', phase: 'test' });
      writeFileSync(join(root, 'nexus', '.lock'), JSON.stringify({ pid: canonical.pid!, host: hostname(), startedAt: new Date().toISOString() }));
      writeFileSync(join(root, 'nexus', 'runtime.json'), runtime(canonical.pid!));
      writeFileSync(join(root, '.lock'), JSON.stringify({ pid: legacy.pid!, host: hostname(), startedAt: new Date().toISOString() }));
      writeFileSync(join(root, 'runtime.json'), runtime(legacy.pid!));

      applyIsolatedRoot(root);
      const { findNexusLifecycleState } = await import('../src/nexus/supervisor/lock.js');
      expect(findNexusLifecycleState()?.root).toBe(join(root, 'nexus'));
      expect(findNexusLifecycleState()?.lock.pid).toBe(canonical.pid);
    } finally {
      if (canonical.exitCode === null) canonical.kill('SIGINT');
      if (legacy.exitCode === null) legacy.kill('SIGINT');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('setTestStateRoot(null) clears the override', () => {
    setTestStateRoot('/tmp/x');
    setTestStateRoot(null);
    expect(getTestStateRoot()).toBeUndefined();
    const { getElanousConfigDir } = require('../src/elanous-config-dir');
    expect(nexusRootDir()).toBe(join(getElanousConfigDir(), 'nexus'));
  });

  it('boots an isolated config without reading a missing operating home config', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-isolated-no-prod-config-'));
    const home = join(root, 'home');
    const isolated = join(root, '.elanous-test');
    mkdirSync(home);
    try {
      const source = join(process.cwd(), 'src/cli/test-state-dir-flag.ts');
      const configPaths = join(process.cwd(), 'src/nexus/config/paths.ts');
      const result = spawnSync('bun', ['-e', [
        `import { applyIsolatedRoot } from ${JSON.stringify(source)};`,
        `import { userConfigPath } from ${JSON.stringify(configPaths)};`,
        `applyIsolatedRoot(${JSON.stringify(isolated)});`,
        'console.log(userConfigPath());',
      ].join('\n')], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, HOME: home, NODE_ENV: 'production' },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('config 분기 실패');
      expect(result.stdout.trim()).toBe(join(isolated, 'config.json'));
      expect(existsSync(join(home, '.elanous', 'config.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the existing test-safe config copy when an operating config exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-isolated-with-prod-config-'));
    const home = join(root, 'home');
    const prod = join(home, '.elanous');
    const isolated = join(root, '.elanous-test');
    mkdirSync(prod, { recursive: true });
    const original = JSON.stringify({ telegram: { enabled: true, botToken: 'PROD-TOKEN' }, discord: { enabled: true } });
    writeFileSync(join(prod, 'config.json'), original);
    try {
      const source = join(process.cwd(), 'src/cli/test-state-dir-flag.ts');
      const result = spawnSync('bun', ['-e', [
        `import { applyIsolatedRoot } from ${JSON.stringify(source)};`,
        `applyIsolatedRoot(${JSON.stringify(isolated)});`,
      ].join('\n')], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, HOME: home, NODE_ENV: 'production' },
      });
      expect(result.status).toBe(0);
      expect(existsSync(join(isolated, 'config.json'))).toBe(true);
      expect(JSON.parse(require('node:fs').readFileSync(join(isolated, 'config.json'), 'utf8')).discord.enabled).toBe(false);
      expect(require('node:fs').readFileSync(join(isolated, 'config.json'), 'utf8')).not.toContain('PROD-TOKEN');
      expect(require('node:fs').readFileSync(join(prod, 'config.json'), 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('global --test status finds and stop terminates a live isolated daemon', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elanous-nexus-cli-'));
    const testRoot = join(realpathSync(repo), '.elanous-test');
    const daemonScript = join(repo, 'daemon.ts');
    const elanousBin = join(process.cwd(), 'bin', 'elanous.mjs');
    mkdirSync(join(repo, '.git'));
    writeFileSync(daemonScript, [
      `import { applyIsolatedRoot } from ${JSON.stringify(join(process.cwd(), 'src/cli/test-state-dir-flag.ts'))};`,
      `import { runNexus } from ${JSON.stringify(join(process.cwd(), 'src/nexus/index.ts'))};`,
      'applyIsolatedRoot(process.argv[2]!);',
      'await runNexus({ headless: false, skipRuntimeApi: true, mcpEnabled: false });',
    ].join('\n'));
    const daemon = spawn('bun', [daemonScript, testRoot], {
      cwd: repo,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'ignore',
    });
    const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(50);
      }
      throw new Error(message);
    };

    try {
      await waitFor(() => existsSync(join(testRoot, 'nexus', '.lock')), 'isolated daemon did not create its lock');
      const lock = JSON.parse(require('node:fs').readFileSync(join(testRoot, 'nexus', '.lock'), 'utf8')) as { pid: number };

      const status = spawnSync('bun', [elanousBin, '--test', 'nexus', 'status'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`root      ${join(testRoot, 'nexus')}`);
      expect(status.stdout).toContain(`status    alive (pid=${lock.pid}`);

      const stop = spawnSync('bun', [elanousBin, '--test', 'nexus', 'stop'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect(stop.status).toBe(0);
      await waitFor(() => !existsSync(join(testRoot, 'nexus', '.lock')), 'global --test stop did not remove the isolated lock');
      await waitFor(() => daemon.exitCode !== null, 'global --test stop did not terminate the isolated daemon');
    } finally {
      if (daemon.exitCode === null) daemon.kill('SIGINT');
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects empty strings', () => {
    expect(() => setTestStateRoot('')).toThrow();
    expect(() => setTestStateRoot('   ')).toThrow();
  });

  it('trims the value', () => {
    setTestStateRoot('  /tmp/trim  ');
    expect(getTestStateRoot()).toBe('/tmp/trim');
  });
});
