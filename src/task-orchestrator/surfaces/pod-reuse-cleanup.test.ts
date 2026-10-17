import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { decidePodReuseCleanup, POD_REUSE_CLEAN_EXCLUSIONS } from './pod-reuse-cleanup.js';

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function makeRepo(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'pod-reuse-cleanup-'));
  repos.push(root);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.name', 'cleanup-test']);
  git(['config', 'user.email', 'cleanup-test@localhost']);
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  writeFileSync(join(root, '.gitignore'), readFileSync(join(import.meta.dir, '../../../.gitignore')));
  mkdirSync(join(root, 'apps/pwa'), { recursive: true });
  writeFileSync(join(root, 'apps/pwa/.gitignore'), readFileSync(join(import.meta.dir, '../../../apps/pwa/.gitignore')));
  git(['add', 'tracked.txt', '.gitignore', 'apps/pwa/.gitignore']);
  git(['commit', '-qm', 'base']);
  return { root, base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
}

function executePlan(root: string, decision: ReturnType<typeof decidePodReuseCleanup>, beforeStatus?: () => void) {
  const run = (args: readonly string[]) => spawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
  const reset = run(decision.resetArgs);
  const clean = run(decision.cleanArgs);
  beforeStatus?.();
  const status = run(decision.statusArgs);
  return decidePodReuseCleanup({
    base: decision.resetArgs[2]!,
    resetExitCode: reset.status,
    cleanExitCode: clean.status,
    statusExitCode: status.status,
    statusPorcelain: status.stdout,
    remainingPaths: status.stdout.split('\0').filter(Boolean).map((record) => record.slice(3)),
  });
}

describe('pod reusable worker request cleanup decision', () => {
  test('resets tracked changes to an earlier request base', () => {
    const { root, base } = makeRepo();
    writeFileSync(join(root, 'tracked.txt'), 'next request base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'next request'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'uncommitted previous request\n');

    const plan = decidePodReuseCleanup({ base, resetExitCode: 0, cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '' });
    const result = executePlan(root, plan);

    expect(result.outcome).toBe('reuse');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(base);
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('base\n');
  });

  test('removes an untracked artifact from the preceding request', () => {
    const { root, base } = makeRepo();
    const artifact = join(root, 'src/generated/previous-request.ts');
    mkdirSync(join(root, 'src/generated'), { recursive: true });
    writeFileSync(artifact, 'must not reach the next request');
    const ignoredArtifact = join(root, 'ignored-output/previous-request.bin');
    mkdirSync(dirname(ignoredArtifact), { recursive: true });
    writeFileSync(join(root, '.git/info/exclude'), '\n/ignored-output/\n', { flag: 'a' });
    writeFileSync(ignoredArtifact, 'ignored output is still cleaned');

    const result = executePlan(root, decidePodReuseCleanup({ base, resetExitCode: 0, cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '' }));

    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(ignoredArtifact)).toBe(false);
    expect(result.outcome).toBe('reuse');
  });

  test('keeps every declared dependency and compiler-cache exclusion', () => {
    const { root, base } = makeRepo();
    const preserved = [
      'node_modules/pkg/index.js',
      'apps/pwa/node_modules/pkg/index.js',
      'apps/pwa/tsconfig.tsbuildinfo',
    ];
    for (const file of preserved) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), 'preserve');
    }
    const ignoreChecks = preserved.map((file) => spawnSync('git', ['check-ignore', '--quiet', '--', file], { cwd: root }));
    expect(ignoreChecks.every((check) => check.status === 0)).toBe(true);
    const plan = decidePodReuseCleanup({ base, resetExitCode: 0, cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '' });
    const result = executePlan(root, plan);

    expect(result.preserved).toEqual(POD_REUSE_CLEAN_EXCLUSIONS.map(({ name }) => name));
    expect(POD_REUSE_CLEAN_EXCLUSIONS).toHaveLength(5);
    expect(plan.cleanArgs).toContain('*.tsbuildinfo');
    expect(preserved.every((file) => existsSync(join(root, file)))).toBe(true);
    expect(result.outcome).toBe('reuse');
  });

  test('discards the worker when actual porcelain remains and reports at most five paths', () => {
    const { root, base } = makeRepo();
    const result = executePlan(root, decidePodReuseCleanup({ base, resetExitCode: 0, cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '' }), () => {
      writeFileSync(join(root, 'residue'), 'left after cleanup');
    });

    expect(result.outcome).toBe('discard');
    expect(result.reason).toBe('worktree-not-clean');
    expect(result.remainingPaths).toEqual(['residue']);
    expect(decidePodReuseCleanup({ base, resetExitCode: 1, cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '' }).reason).toBe('reset-failed');
    expect(decidePodReuseCleanup({ base, resetExitCode: 0, cleanExitCode: 128, statusExitCode: 0, statusPorcelain: '' }).reason).toBe('clean-failed');
    expect(decidePodReuseCleanup({ base, resetExitCode: 0, cleanExitCode: 0, statusExitCode: 128, statusPorcelain: '' }).reason).toBe('status-failed');
    expect(decidePodReuseCleanup({ base: 'a'.repeat(40), resetExitCode: 0, cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '?? residue\n', remainingPaths: ['residue', 'two', 'three', 'four', 'five', 'six'] }).remainingPaths).toEqual(['residue', 'two', 'three', 'four', 'five']);
  });

  test('passes an actual failed git command result into the discard decision', () => {
    const { root, base } = makeRepo();
    const plan = decidePodReuseCleanup({ base, resetExitCode: 0, cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '' });
    const env = { ...process.env, GIT_DIR: join(root, '.git-missing') };
    const reset = spawnSync('git', [...plan.resetArgs], { cwd: root, encoding: 'utf8', env });
    const result = decidePodReuseCleanup({
      base,
      resetExitCode: reset.status,
      cleanExitCode: 0,
      statusExitCode: 0,
      statusPorcelain: '',
    });

    expect(reset.status).not.toBe(0);
    expect(result.outcome).toBe('discard');
    expect(result.reason).toBe('reset-failed');
  });
});
