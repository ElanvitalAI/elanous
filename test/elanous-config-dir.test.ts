// `--config-dir <dir>` + `getElanousConfigDir()` resolver tests.
//
// 2026-05-13 · config-dir-unify — removes the `ELANOUS_DAEMON_DIR` env
// var read and the `setElanousConfigDir` env mirror. The single public
// surface is the `--config-dir` CLI flag (which calls the
// programmatic setter). Child processes inherit via `--config-dir`
// re-appended to argv in `bg-launch.ts`, not via env inheritance.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  extractConfigDirFlag,
  applyConfigDirFlagFromArgv,
} from '../src/cli/config-dir-flag';
import {
  getElanousConfigDir,
  setElanousConfigDir,
  resetElanousConfigDir,
} from '../src/elanous-config-dir';
import {
  resetEffectiveInstanceRoot,
  treeDerivedRootFor,
} from '../src/instance/resolve';

let savedArgv: string[];
let savedDaemonDir: string | undefined;
let savedStateDir: string | undefined;

beforeEach(() => {
  savedArgv = [...process.argv];
  // Preserve externally-set env vars while asserting that the resolver ignores them.
  savedDaemonDir = process.env.ELANOUS_DAEMON_DIR;
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  delete process.env.ELANOUS_DAEMON_DIR;
  delete process.env.ELANOUS_STATE_DIR;
  resetElanousConfigDir();
  resetEffectiveInstanceRoot();
});

const treeRoot = treeDerivedRootFor(process.cwd());
if (treeRoot === null) throw new Error('This test requires a source tree');

afterEach(() => {
  process.argv = savedArgv;
  if (savedDaemonDir === undefined) delete process.env.ELANOUS_DAEMON_DIR;
  else process.env.ELANOUS_DAEMON_DIR = savedDaemonDir;
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = savedStateDir;
  resetElanousConfigDir();
  resetEffectiveInstanceRoot();
});

describe('extractConfigDirFlag · pure parser', () => {
  it('returns undefined when the flag is absent', () => {
    const r = extractConfigDirFlag(['elanous', 'nexus', 'run']);
    expect(r.dir).toBeUndefined();
    expect(r.argv).toEqual(['elanous', 'nexus', 'run']);
  });

  it('parses `--config-dir <dir>` at the global position', () => {
    const r = extractConfigDirFlag(['elanous', '--config-dir', '/tmp/x', 'nexus', 'run']);
    expect(r.dir).toBe('/tmp/x');
    expect(r.argv).toEqual(['elanous', 'nexus', 'run']);
  });

  it('parses `--config-dir <dir>` after a subcommand', () => {
    const r = extractConfigDirFlag(['elanous', 'nexus', 'run', '--config-dir', '/tmp/y']);
    expect(r.dir).toBe('/tmp/y');
    expect(r.argv).toEqual(['elanous', 'nexus', 'run']);
  });

  it('parses the `--config-dir=<dir>` long form', () => {
    const r = extractConfigDirFlag(['elanous', 'wf', 'validate', '--config-dir=/tmp/z', './flow.yaml']);
    expect(r.dir).toBe('/tmp/z');
    expect(r.argv).toEqual(['elanous', 'wf', 'validate', './flow.yaml']);
  });

  it('trims whitespace', () => {
    const r = extractConfigDirFlag(['elanous', '--config-dir', '  /tmp/spaced  ']);
    expect(r.dir).toBe('/tmp/spaced');
  });

  it('ignores `--config-dir=` with an empty value', () => {
    const r = extractConfigDirFlag(['elanous', '--config-dir=', 'nexus']);
    expect(r.dir).toBeUndefined();
    expect(r.argv).toEqual(['elanous', 'nexus']);
  });

  it('last occurrence wins when the flag is repeated', () => {
    const r = extractConfigDirFlag(['elanous', '--config-dir', '/a', '--config-dir=/b']);
    expect(r.dir).toBe('/b');
  });

  it('does not mutate the input array', () => {
    const argv = ['elanous', '--config-dir', '/tmp/x', 'nexus'];
    const snapshot = [...argv];
    extractConfigDirFlag(argv);
    expect(argv).toEqual(snapshot);
  });
});

describe('applyConfigDirFlagFromArgv · side-effecting bootstrap', () => {
  it('routes the flag through setElanousConfigDir', () => {
    process.argv = ['bun', 'src/index.ts', '--config-dir', '/tmp/applied', 'nexus', 'run'];
    const dir = applyConfigDirFlagFromArgv();
    expect(dir).toBe('/tmp/applied');
    expect(getElanousConfigDir()).toBe('/tmp/applied');
    expect(process.argv).toEqual(['bun', 'src/index.ts', 'nexus', 'run']);
  });

  it('is a no-op when the flag is absent', () => {
    process.argv = ['bun', 'src/index.ts', 'nexus', 'run'];
    const dir = applyConfigDirFlagFromArgv();
    expect(dir).toBeUndefined();
    expect(getElanousConfigDir()).toBe(treeRoot);
  });
});

describe('getElanousConfigDir · resolver-state isolation', () => {
  it('restores explicit override independently through resetElanousConfigDir', () => {
    setElanousConfigDir('/tmp/explicit-contamination');
    expect(getElanousConfigDir()).toBe('/tmp/explicit-contamination');
    resetElanousConfigDir();
    expect(getElanousConfigDir()).toBe(treeRoot);
  });

  it('restores ELANOUS_STATE_DIR independently through environment cleanup', () => {
    process.env.ELANOUS_STATE_DIR = '/tmp/state-contamination';
    expect(getElanousConfigDir()).toBe('/tmp/state-contamination');
    delete process.env.ELANOUS_STATE_DIR;
    expect(getElanousConfigDir()).toBe(treeRoot);
  });

  it('resetting a memoized tree root resolves a different source tree', () => {
    const first = mkdtempSync(join(tmpdir(), 'config-dir-first-'));
    const second = mkdtempSync(join(tmpdir(), 'config-dir-second-'));
    const originalArgv = process.argv;
    try {
      mkdirSync(join(first, '.git'));
      mkdirSync(join(second, '.git'));
      process.argv = [originalArgv[0] ?? 'bun', join(first, 'bin', 'elanous.mjs')];
      const firstRoot = join(first, '.elanous-test');
      expect(treeDerivedRootFor(first)).toBe(firstRoot);
      expect(getElanousConfigDir()).toBe(firstRoot);

      process.argv = [originalArgv[0] ?? 'bun', join(second, 'bin', 'elanous.mjs')];
      const secondRoot = join(second, '.elanous-test');
      expect(treeDerivedRootFor(second)).toBe(secondRoot);
      expect(secondRoot).not.toBe(firstRoot);
      expect(getElanousConfigDir()).toBe(firstRoot);
      resetEffectiveInstanceRoot();
      expect(getElanousConfigDir()).toBe(secondRoot);
    } finally {
      process.argv = originalArgv;
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('measures the combined inputs as independent precedence layers, not extra leaks', () => {
    setElanousConfigDir('/tmp/explicit-contamination');
    process.env.ELANOUS_STATE_DIR = '/tmp/state-contamination';
    expect(getElanousConfigDir()).toBe('/tmp/explicit-contamination');
    resetElanousConfigDir();
    expect(getElanousConfigDir()).toBe('/tmp/state-contamination');
    delete process.env.ELANOUS_STATE_DIR;
    expect(getElanousConfigDir()).toBe(treeRoot);
  });
});

describe('getElanousConfigDir · resolution order (env-var-free)', () => {
  it('defaults to the tree-derived test universe when nothing is set', () => {
    expect(getElanousConfigDir()).toBe(treeRoot);
  });

  it('IGNORES ELANOUS_DAEMON_DIR env var (removed 2026-05-13)', () => {
    process.env.ELANOUS_DAEMON_DIR = '/tmp/env-must-be-ignored';
    expect(getElanousConfigDir()).toBe(treeRoot);
  });

  it('honours programmatic override', () => {
    setElanousConfigDir('/tmp/override');
    expect(getElanousConfigDir()).toBe('/tmp/override');
  });

  it('setElanousConfigDir does NOT mirror into env (env removed 2026-05-13)', () => {
    delete process.env.ELANOUS_DAEMON_DIR;
    setElanousConfigDir('/tmp/no-mirror');
    expect(process.env.ELANOUS_DAEMON_DIR).toBeUndefined();
  });

  it('resetElanousConfigDir falls back to the tree-derived test universe regardless of the retired env', () => {
    setElanousConfigDir('/tmp/will-be-cleared');
    resetElanousConfigDir();
    expect(getElanousConfigDir()).toBe(treeRoot);
    // Even with a stray env var, the resolver remains env-blind.
    process.env.ELANOUS_DAEMON_DIR = '/tmp/still-ignored';
    expect(getElanousConfigDir()).toBe(treeRoot);
  });

  it('setElanousConfigDir rejects empty strings', () => {
    expect(() => setElanousConfigDir('')).toThrow();
    expect(() => setElanousConfigDir('   ')).toThrow();
  });

  it('trims the override', () => {
    setElanousConfigDir('  /tmp/trimmed  ');
    expect(getElanousConfigDir()).toBe('/tmp/trimmed');
  });
});

describe('ignored ELANOUS_CONFIG_DIR · process-wide observation', () => {
  it('warns once for a divergent env, stays silent for equal or absent env, and never writes stdout', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'config-dir-warning-'));
    try {
      const cases = [
        { name: 'divergent', env: '/tmp/x', flag: undefined, state: '/tmp/actual-state', calls: 1, source: 'state-dir' },
        { name: 'repeated', env: '/tmp/x', flag: undefined, state: '/tmp/actual-state', calls: 2, source: 'state-dir' },
        { name: 'different-flag', env: '/tmp/x', flag: '/tmp/same', state: '/tmp/actual-state', calls: 1, source: 'flag' },
        { name: 'equal-flag', env: '/tmp/flag/../same', flag: '/tmp/same', state: '/tmp/actual-state', calls: 1, source: 'flag' },
        { name: 'absent', env: undefined, flag: undefined, state: '/tmp/actual-state', calls: 1, source: 'state-dir' },
        { name: 'late-env', env: undefined, flag: undefined, state: '/tmp/actual-state', calls: 2, afterFirstEnv: '/tmp/x', source: 'state-dir' },
        { name: 'tilde-equal', env: '~/.elanous', flag: join(homedir(), '.elanous'), state: undefined, calls: 1, source: 'flag' },
        { name: 'default', env: '/tmp/x', flag: undefined, state: undefined, calls: 1, source: 'default' },
      ] as const;
      for (const scenario of cases) {
        const resultFile = join(scratch, `${scenario.name}.json`);
        const script = `
          const { getElanousConfigDir } = await import('./src/elanous-config-dir.ts');
          const { applyConfigDirFlagFromArgv } = await import('./src/cli/config-dir-flag.ts');
          if (${JSON.stringify(scenario.flag)} !== undefined) {
            process.argv = ['bun', 'elanous', '--config-dir', ${JSON.stringify(scenario.flag)}];
            applyConfigDirFlagFromArgv();
          }
          const roots = [getElanousConfigDir()];
          if (${JSON.stringify('afterFirstEnv' in scenario ? scenario.afterFirstEnv : undefined)} !== undefined) {
            process.env.ELANOUS_CONFIG_DIR = ${JSON.stringify('afterFirstEnv' in scenario ? scenario.afterFirstEnv : undefined)};
          }
          for (let i = 1; i < ${scenario.calls}; i++) roots.push(getElanousConfigDir());
          const { debug } = await import('./src/debug/log.ts');
          const events = debug.events(50).filter(e => e.category === 'config.dir' && e.event === 'env-ignored');
          await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ roots, events }));
        `;
        const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
        delete env.ELANOUS_CONFIG_DIR;
        delete env.ELANOUS_STATE_DIR;
        if (scenario.env !== undefined) env.ELANOUS_CONFIG_DIR = scenario.env;
        if (scenario.state !== undefined) env.ELANOUS_STATE_DIR = scenario.state;
        const child = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), env, encoding: 'utf8' });
        expect(child.status).toBe(0);
        expect(child.stdout).toBe('');
        const { roots, events } = JSON.parse(readFileSync(resultFile, 'utf8')) as {
          roots: string[]; events: Array<{ data: { env: string; resolved: string; source: string } }>;
        };
        const actual = scenario.flag ?? scenario.state ?? treeRoot;
        expect(roots).toEqual(Array(scenario.calls).fill(actual));
        const divergent = scenario.name === 'divergent' || scenario.name === 'repeated' || scenario.name === 'different-flag' || scenario.name === 'default';
        expect(child.stderr).toBe(divergent
          ? `ELANOUS_CONFIG_DIR 는 읽지 않습니다 — 설정 폴더 = ${actual} · 그 폴더를 쓰려면 --config-dir ${resolve(scenario.env!)}\n`
          : '');
        expect(events.length).toBe(divergent ? 1 : 0);
        if (divergent) expect(events[0]?.data).toMatchObject({ env: scenario.env, resolved: actual, source: scenario.source });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('downstream consumers honour the central resolver', () => {
  it('elanousDaemonDir returns the central value', async () => {
    const { elanousDaemonDir } = await import('../src/elanous-daemon.js');
    setElanousConfigDir('/tmp/daemon-test');
    expect(elanousDaemonDir()).toBe('/tmp/daemon-test');
  });

  it('nexus elanousConfigDir + userConfigPath honour the override', async () => {
    const { elanousConfigDir, userConfigPath, secretsPath } = await import('../src/nexus/config/paths.js');
    setElanousConfigDir('/tmp/nexus-test');
    expect(elanousConfigDir()).toBe('/tmp/nexus-test');
    expect(userConfigPath()).toBe('/tmp/nexus-test/config.json');
    expect(secretsPath()).toBe('/tmp/nexus-test/secrets.json');
  });

  it('workflow-runtime getGlobalWorkflowDir honours the override', async () => {
    const { getGlobalWorkflowDir } = await import('../src/workflow-runtime/discovery.js');
    setElanousConfigDir('/tmp/wf-test');
    expect(getGlobalWorkflowDir()).toBe('/tmp/wf-test/workflows');
  });
});
