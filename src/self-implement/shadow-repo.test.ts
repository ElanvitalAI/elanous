import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  diffShadow,
  listShadow,
  restoreShadow,
  shadowPaths,
  snapshotShadow,
  type GitResult,
  type ShadowGit,
} from './shadow-repo.js';

function realGit(): ShadowGit {
  return (args, opts) => {
    const result = spawnSync('git', args, {
      cwd: opts?.cwd,
      env: opts?.env ?? process.env,
      encoding: 'utf8',
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

const missingGit: ShadowGit = (): GitResult => ({ status: 127, stdout: '', stderr: 'git: command not found' });

describe('shadow repo', () => {
  test('스냅숏 → 수정 → 스냅숏 → 첫 커밋 복원: 원래 내용, b.txt 없음, 이력 4, .env 미추적, .git 없음', () => {
    const root = mkdtempSync(join(tmpdir(), 'shadow-repo-'));
    const target = join(root, 'folder');
    const instanceRoot = join(root, 'instance');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.txt'), 'original\n');
    writeFileSync(join(target, '.env'), 'SECRET=1\n');

    const git = realGit();
    const first = snapshotShadow({ target, instanceRoot, git, message: 'base' });
    expect(first.mode).toBe('git');

    writeFileSync(join(target, 'a.txt'), 'edited\n');
    writeFileSync(join(target, 'b.txt'), 'new\n');
    const second = snapshotShadow({ target, instanceRoot, git, message: 'edit' });
    expect(second.commit).not.toBe(first.commit);

    const restored = restoreShadow({ target, instanceRoot, git, commit: first.commit });
    expect(restored.mode).toBe('git');

    const names = readdirSync(target).sort();
    expect(names).toEqual(['.env', 'a.txt']);
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(target, 'b.txt'))).toBe(false);
    expect(existsSync(join(target, '.git'))).toBe(false);

    const history = listShadow({ target, instanceRoot, git });
    expect(history).toHaveLength(4);
    expect(history.map((row) => row.message)).toEqual([
      `restore 후 ${first.commit}`,
      `restore 전 ${first.commit}`,
      'edit',
      'base',
    ]);

    const paths = shadowPaths(target, instanceRoot);
    const tree = spawnSync('git', ['--git-dir', paths.gitDir, 'ls-tree', '-r', '--name-only', first.commit], { encoding: 'utf8' });
    expect(tree.stdout.split('\n').filter((line) => line.length > 0)).toEqual(['a.txt']);
    expect(tree.stdout).not.toContain('.env');

    const marker = readFileSync(join(paths.gitDir, 'elanous-target'), 'utf8');
    expect(marker.trim().length).toBeGreaterThan(0);
    const exclude = readFileSync(join(paths.gitDir, 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('node_modules/');
    expect(exclude).toContain('.env*');
    expect(exclude).toContain('.git/');

    const diff = diffShadow({ target, instanceRoot, git, from: first.commit, to: second.commit });
    expect(diff).toContain('b.txt');

    rmSync(root, { recursive: true, force: true });
  });

  test('git 이 없으면 mode=copy 이고 snapshotsDir 사본에 a.txt 가 있다', () => {
    const root = mkdtempSync(join(tmpdir(), 'shadow-copy-'));
    const target = join(root, 'folder');
    const instanceRoot = join(root, 'instance');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.txt'), 'original\n');
    writeFileSync(join(target, '.env'), 'SECRET=1\n');

    const at = new Date('2026-09-27T00:00:00.000Z');
    const snap = snapshotShadow({ target, instanceRoot, git: missingGit, now: () => at, message: 'copy me' });
    expect(snap.mode).toBe('copy');

    const paths = shadowPaths(target, instanceRoot);
    const copy = join(paths.snapshotsDir, snap.commit, 'a.txt');
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe('original\n');
    expect(existsSync(join(paths.snapshotsDir, snap.commit, '.env'))).toBe(false);
    expect(existsSync(join(target, '.git'))).toBe(false);

    const listed = listShadow({ target, instanceRoot, git: missingGit });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.commit).toBe(snap.commit);
    expect(listed[0]?.message).toBe('copy me');

    rmSync(root, { recursive: true, force: true });
  });
});
