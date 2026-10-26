import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryCreatePodInplaceWorktree } from './pod-inplace-worktree.js';
import { recordHarnessWorktreeProvenance } from '../harness/harness-worktree-add.js';
import { DEFAULT_BRANCH_WORKTREE_BASE } from '../git-fs/worktree.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pod-inplace-wt-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'target.ts'), 'export const target = 1;\n');
  git('add', 'target.ts');
  git('commit', '-qm', 'base');
  const pin = git('rev-parse', 'HEAD');
  return { root, git, pin };
}

const env = { ELANOUS_POD_INPLACE_WORKTREE: '1', ELANOUS_SUBSTRATE: 'pod', ELANOUS_POD_SINGLE_CHILD: '1', ELANOUS_POD_NAME: 'si-task-test', ELANOUS_RUN_ID: 'run-test' };

test('Pod single owner switches in place with zero new worktree and unchanged pin', () => {
  const f = fixture();
  const result = tryCreatePodInplaceWorktree({ repoRoot: f.root, cwd: f.root, branch: 'self-impl/test', base: f.pin, runId: 'run-test', env });
  expect(result).toMatchObject({ path: realpathSync(f.root), branch: 'self-impl/test', resolvedBase: f.pin, inPlace: true });
  expect(f.git('rev-parse', 'HEAD')).toBe(f.pin);
  expect(f.git('branch', '--show-current')).toBe('self-impl/test');
  expect(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  expect(f.git('status', '--porcelain')).toBe('');
  recordHarnessWorktreeProvenance(result!.path, { owner: 'dev:run-test', command: 'elanous dev', createdAt: '2026-10-25T00:00:00Z' });
  expect(f.git('config', '--worktree', '--get', 'elanous.harness.owner')).toBe('dev:run-test');
});

test('Pod authored goal is the only allowed untracked file with the default branch base', () => {
  const f = fixture();
  f.git('update-ref', 'refs/remotes/origin/main', f.pin);
  f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const goalFile = join(f.root, 'docs/goals/GOAL-run-test.md');
  mkdirSync(join(f.root, 'docs/goals'), { recursive: true });
  writeFileSync(goalFile, '# Goal\n');
  const result = tryCreatePodInplaceWorktree({ repoRoot: f.root, cwd: f.root, branch: 'self-impl/test', base: DEFAULT_BRANCH_WORKTREE_BASE, runId: 'run-test', goalFile, env });
  expect(result).toMatchObject({ inPlace: true, resolvedBase: f.pin, path: realpathSync(f.root) });
  expect(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  expect(f.git('status', '--porcelain', '--untracked-files=all')).toBe('?? docs/goals/GOAL-run-test.md');
});

test('Pod authored goal exception rejects any other dirty source file', () => {
  const f = fixture();
  const goalFile = join(f.root, 'docs/goals/GOAL-run-test.md');
  mkdirSync(join(f.root, 'docs/goals'), { recursive: true });
  writeFileSync(goalFile, '# Goal\n');
  expect(tryCreatePodInplaceWorktree({ repoRoot: f.root, cwd: f.root, branch: 'self-impl/test', base: f.pin, runId: 'run-test', goalFile: join(f.root, 'docs/goals/GOAL-other.md'), env })).toBeNull();
  writeFileSync(join(f.root, 'other.txt'), 'unrelated');
  const branch = f.git('branch', '--show-current');
  expect(tryCreatePodInplaceWorktree({ repoRoot: f.root, cwd: f.root, branch: 'self-impl/test', base: f.pin, runId: 'run-test', goalFile, env })).toBeNull();
  expect(f.git('branch', '--show-current')).toBe(branch);
});

test('Pod source without node_modules uses matching baked dependencies after the in-place switch', () => {
  const f = fixture();
  const baked = mkdtempSync(join(tmpdir(), 'pod-inplace-baked-'));
  roots.push(baked);
  for (const tree of ['', 'apps/pwa']) {
    const sourceTree = join(f.root, tree);
    const bakedTree = join(baked, tree);
    mkdirSync(sourceTree, { recursive: true });
    mkdirSync(join(bakedTree, 'node_modules'), { recursive: true });
    const manifest = JSON.stringify({ name: 'fixture', dependencies: { fixture: '1.0.0' } });
    writeFileSync(join(sourceTree, 'package.json'), manifest);
    writeFileSync(join(bakedTree, 'package.json'), manifest);
    writeFileSync(join(sourceTree, 'bun.lock'), 'matching lock');
    writeFileSync(join(bakedTree, 'bun.lock'), 'matching lock');
  }
  writeFileSync(join(f.root, '.gitignore'), 'node_modules\n');
  f.git('add', '.gitignore', 'package.json', 'bun.lock', 'apps/pwa/package.json', 'apps/pwa/bun.lock');
  f.git('commit', '-qm', 'dependency manifests');
  const pin = f.git('rev-parse', 'HEAD');
  const input = { repoRoot: f.root, cwd: f.root, branch: 'self-impl/test', base: pin, runId: 'run-test', env, dependencyFallbackRoot: baked };
  const result = tryCreatePodInplaceWorktree(input);
  expect(result).toMatchObject({ inPlace: true, resolvedBase: pin });
  for (const tree of ['', 'apps/pwa']) {
    const link = join(f.root, tree, 'node_modules');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(baked, tree, 'node_modules')));
  }
  expect(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  expect(f.git('status', '--porcelain')).toBe('');
});

test('mismatched baked dependency lock refuses in-place before changing the source branch', () => {
  const f = fixture();
  const baked = mkdtempSync(join(tmpdir(), 'pod-inplace-baked-mismatch-'));
  roots.push(baked);
  mkdirSync(join(baked, 'node_modules'));
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
  writeFileSync(join(baked, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
  writeFileSync(join(f.root, 'bun.lock'), 'new lock');
  writeFileSync(join(baked, 'bun.lock'), 'old lock');
  f.git('add', 'package.json', 'bun.lock');
  f.git('commit', '-qm', 'dependency manifests');
  const branch = f.git('branch', '--show-current');
  const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(tryCreatePodInplaceWorktree({ repoRoot: f.root, cwd: f.root, branch: 'self-impl/test', base: f.git('rev-parse', 'HEAD'), runId: 'run-test', env, dependencyFallbackRoot: baked })).toBeNull();
    expect(write.mock.calls.some(([line]) => String(line).includes('ELANOUS_POD_INPLACE_SKIP reason=dependencies-unavailable'))).toBe(true);
  } finally { write.mockRestore(); }
  expect(f.git('branch', '--show-current')).toBe(branch);
});

test('disabled, wrong owner, dirty source, or mismatched base falls back without changing branch', () => {
  const f = fixture();
  const initialBranch = f.git('branch', '--show-current');
  const input = { repoRoot: f.root, cwd: f.root, branch: 'self-impl/test', base: f.pin, runId: 'run-test', env };
  expect(tryCreatePodInplaceWorktree({ ...input, env: { ...env, ELANOUS_POD_INPLACE_WORKTREE: '0' } })).toBeNull();
  expect(tryCreatePodInplaceWorktree({ ...input, env: { ...env, ELANOUS_RUN_ID: 'other' } })).toBeNull();
  expect(tryCreatePodInplaceWorktree({ ...input, base: 'HEAD~1' })).toBeNull();
  writeFileSync(join(f.root, 'untracked.txt'), 'dirty');
  expect(tryCreatePodInplaceWorktree(input)).toBeNull();
  expect(f.git('branch', '--show-current')).toBe(initialBranch);
});
