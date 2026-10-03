import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectUncommittedWork } from './uncommitted-work.js';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};
const file = (cwd: string, path: string, content: string) => {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), content);
};
const repo = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-uncommitted-work-'));
  roots.push(cwd);
  git(cwd, 'init', '-q');
  return cwd;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('detectUncommittedWork', () => {
  test('distinguishes clean from a git status lookup failure', () => {
    const cwd = repo();
    expect(detectUncommittedWork(cwd)).toEqual({ status: 'clean', trackedChanges: [], untrackedFiles: [] });
    const missing = detectUncommittedWork(join(cwd, 'missing'));
    expect(missing.status).toBe('unavailable');
    if (missing.status === 'unavailable') expect(missing.reason.length).toBeGreaterThan(0);
    const plain = mkdtempSync(join(tmpdir(), 'elanous-nonrepo-'));
    roots.push(plain);
    expect(detectUncommittedWork(plain).status).toBe('unavailable');
  });

  test('reports staged and unstaged changes, including deletion and an index move, without touching the index or files', () => {
    const cwd = repo();
    file(cwd, 'tracked space.ts', 'before');
    file(cwd, 'removed.ts', 'removed');
    file(cwd, 'old.ts', 'old');
    git(cwd, 'add', 'tracked space.ts', 'removed.ts', 'old.ts');
    git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
    git(cwd, 'mv', 'old.ts', 'new.ts');
    file(cwd, 'tracked space.ts', 'after');
    rmSync(join(cwd, 'removed.ts'));
    const before = git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
    const observed = detectUncommittedWork(cwd);
    expect(observed.status).toBe('changes');
    if (observed.status === 'changes') {
      expect(observed.trackedChanges).toEqual(expect.arrayContaining(['tracked space.ts', 'removed.ts', 'old.ts', 'new.ts']));
      for (const target of ['old.ts', 'new.ts']) {
        expect(observed.trackedChanges.includes(target)).toBe(true);
      }
      expect(observed.untrackedFiles).toEqual([]);
    }
    expect(readFileSync(join(cwd, 'tracked space.ts'), 'utf8')).toBe('after');
    expect(git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).toBe(before);
  });

  test('enumerates eligible untracked files recursively, omitting ignored and harness runtime artifacts', () => {
    const cwd = repo();
    file(cwd, '.gitignore', 'ignored.txt\n');
    git(cwd, 'add', '.gitignore');
    file(cwd, 'src/nested/new name.ts', 'export const newFile = true;');
    file(cwd, 'ignored.txt', 'ignored');
    file(cwd, '.elanous/debug/out.log', 'runtime');
    file(cwd, '.elanous-test/state.json', '{}');
    file(cwd, '.elanous-skill-artifacts/cache', 'runtime');
    file(cwd, '.elanous-child-liveness.hb', 'live');
    const before = git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
    expect(detectUncommittedWork(cwd)).toEqual({
      status: 'changes', trackedChanges: ['.gitignore'], untrackedFiles: ['src/nested/new name.ts'],
    });
    expect(git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).toBe(before);
  });

  test('observes the requested worktree despite caller Git repository and index overrides', () => {
    const target = repo();
    file(target, 'target.ts', 'target');
    git(target, 'add', 'target.ts');
    file(target, 'untracked.ts', 'untracked');
    const other = repo();
    file(other, 'other.ts', 'other');
    git(other, 'add', 'other.ts');

    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;
    const original = keys.map((key) => process.env[key]);
    try {
      process.env.GIT_DIR = join(other, '.git');
      process.env.GIT_WORK_TREE = other;
      process.env.GIT_INDEX_FILE = join(other, '.git', 'index');
      expect(detectUncommittedWork(target)).toEqual({
        status: 'changes', trackedChanges: ['target.ts'], untrackedFiles: ['untracked.ts'],
      });
    } finally {
      keys.forEach((key, i) => {
        if (original[i] === undefined) delete process.env[key];
        else process.env[key] = original[i];
      });
    }
  });

  test('excluded artifacts alone do not masquerade as child work', () => {
    const cwd = repo();
    file(cwd, '.elanous-child-liveness.hb', 'live');
    file(cwd, '.elanous/debug/out.log', 'runtime');
    expect(detectUncommittedWork(cwd)).toEqual({ status: 'clean', trackedChanges: [], untrackedFiles: [] });
  });
});
