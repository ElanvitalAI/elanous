// `--config-dir <dir>` + `getElanousConfigDir()` resolver tests.
//
// 2026-05-13 · config-dir-unify — removes the `ELANOUS_DAEMON_DIR` env
// var read and the `setElanousConfigDir` env mirror. The single public
// surface is the `--config-dir` CLI flag (which calls the
// programmatic setter). Child processes inherit via `--config-dir`
// re-appended to argv in `bg-launch.ts`, not via env inheritance.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
