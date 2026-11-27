// HARNESS-BARE-REPO-BASE-REF — bare 클론은 refs/remotes/origin/* 가 비어
// changedFiles 가 낡은 로컬 main 과 비교한다. base 동기화가 가져온 tip 을
// 그 원격 추적 ref 에 강제 기록하면 비교 기준이 작업 가지의 시작점과 같다.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, syncBaseWithRemote } from './worktree.js';
import { changedFiles } from '../self-implement/seams.js';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} — ${result.stderr || result.stdout}`);
  return (result.stdout ?? '').trim();
}

describe('HARNESS-BARE-REPO-BASE-REF', () => {
  test('HARNESS-BARE-REPO-BASE-REF: base 동기화에서 가져온 tip을 refs/remotes/origin/main 에 남기고 changedFiles 는 자식 변경 1개만 낸다', () => {
    const root = mkdtempSync(join(tmpdir(), 'bare-base-ref-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const bare = join(root, 'bare.git');
    try {
      git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
      git(root, ['init', '-q', '-b', 'main', seed]);
      git(seed, ['config', 'user.email', 't@t.co']);
      git(seed, ['config', 'user.name', 'T']);
      writeFileSync(join(seed, 'README.md'), 'old\n');
      writeFileSync(join(seed, 'AGENTS.md'), 'agents\n');
      git(seed, ['add', '.']);
      git(seed, ['commit', '-q', '-m', 'old main']);
      const stale = git(seed, ['rev-parse', 'HEAD']);
      git(seed, ['remote', 'add', 'origin', origin]);
      git(seed, ['push', '-q', 'origin', 'main']);

      git(root, ['clone', '-q', '--bare', origin, bare]);
      git(bare, ['update-ref', 'refs/heads/main', stale]);
      expect(git(bare, ['rev-parse', 'refs/heads/main'])).toBe(stale);
      expect(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: bare }).status).not.toBe(0);

      const created = createWorktree({
        repoRoot: bare,
        branch: 'se/bare-child',
        worktreeRoot: join(root, 'wts'),
        base: 'main',
      });
      expect(git(created.path, ['rev-parse', 'HEAD'])).toBe(stale);
      expect(git(bare, ['rev-parse', 'refs/heads/main'])).toBe(stale);

      writeFileSync(join(seed, 'README.md'), 'tip\n');
      git(seed, ['commit', '-q', '-am', 'remote tip']);
      const tip = git(seed, ['rev-parse', 'HEAD']);
      git(seed, ['push', '-q', 'origin', 'main']);
      expect(tip).not.toBe(stale);
      expect(spawnSync('git', ['cat-file', '-e', `${tip}^{commit}`], { cwd: bare }).status).not.toBe(0);

      const synced = syncBaseWithRemote(bare, 'main', false);
      expect(synced).toEqual({ checkout: tip, freshness: 'remote-synced' });
      expect(git(bare, ['rev-parse', 'refs/remotes/origin/main'])).toBe(tip);
      expect(git(bare, ['rev-parse', 'refs/heads/main'])).toBe(stale);

      writeFileSync(join(created.path, 'child-only.ts'), 'export const child = 1;\n');
      git(created.path, ['config', 'user.email', 't@t.co']);
      git(created.path, ['config', 'user.name', 'T']);
      git(created.path, ['add', 'child-only.ts']);
      git(created.path, ['commit', '-q', '-m', 'child change']);

      expect(changedFiles(created.path)).toEqual(['child-only.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('HARNESS-BARE-REPO-BASE-REF: 객체가 이미 있어도 낡은 원격 추적 ref를 비정방향으로 강제 갱신하고 로컬 가지는 둔다', () => {
    const root = mkdtempSync(join(tmpdir(), 'bare-base-ref-skip-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const bare = join(root, 'bare.git');
    try {
      git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
      git(root, ['init', '-q', '-b', 'main', seed]);
      git(seed, ['config', 'user.email', 't@t.co']);
      git(seed, ['config', 'user.name', 'T']);
      writeFileSync(join(seed, 'README.md'), 'old\n');
      git(seed, ['add', 'README.md']);
      git(seed, ['commit', '-q', '-m', 'old']);
      const stale = git(seed, ['rev-parse', 'HEAD']);
      git(seed, ['remote', 'add', 'origin', origin]);
      git(seed, ['push', '-q', 'origin', 'main']);
      writeFileSync(join(seed, 'README.md'), 'new\n');
      git(seed, ['commit', '-q', '-am', 'new']);
      const tip = git(seed, ['rev-parse', 'HEAD']);
      git(seed, ['push', '-q', 'origin', 'main']);

      git(root, ['clone', '-q', '--bare', origin, bare]);
      git(bare, ['update-ref', 'refs/heads/main', stale]);
      git(bare, ['update-ref', 'refs/remotes/origin/main', stale]);
      expect(git(bare, ['cat-file', '-t', tip])).toBe('commit');

      const synced = syncBaseWithRemote(bare, 'main', false);
      expect(synced.checkout).toBe(tip);
      expect(git(bare, ['rev-parse', 'refs/remotes/origin/main'])).toBe(tip);
      expect(git(bare, ['rev-parse', 'refs/heads/main'])).toBe(stale);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('HARNESS-BARE-REPO-BASE-REF: refs/remotes/origin/main 이 refs/heads/main 의 심볼릭 ref여도 로컬 main 은 그대로이고 원격 추적 ref 는 가져온 tip 을 가리킨다', () => {
    const root = mkdtempSync(join(tmpdir(), 'bare-base-ref-sym-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const bare = join(root, 'bare.git');
    try {
      git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
      git(root, ['init', '-q', '-b', 'main', seed]);
      git(seed, ['config', 'user.email', 't@t.co']);
      git(seed, ['config', 'user.name', 'T']);
      writeFileSync(join(seed, 'README.md'), 'old\n');
      git(seed, ['add', 'README.md']);
      git(seed, ['commit', '-q', '-m', 'old']);
      const stale = git(seed, ['rev-parse', 'HEAD']);
      git(seed, ['remote', 'add', 'origin', origin]);
      git(seed, ['push', '-q', 'origin', 'main']);
      writeFileSync(join(seed, 'README.md'), 'tip\n');
      git(seed, ['commit', '-q', '-am', 'remote tip']);
      const tip = git(seed, ['rev-parse', 'HEAD']);
      git(seed, ['push', '-q', 'origin', 'main']);
      expect(tip).not.toBe(stale);

      git(root, ['clone', '-q', '--bare', origin, bare]);
      git(bare, ['update-ref', 'refs/heads/main', stale]);
      git(bare, ['symbolic-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
      expect(git(bare, ['symbolic-ref', 'refs/remotes/origin/main'])).toBe('refs/heads/main');
      expect(git(bare, ['rev-parse', 'refs/heads/main'])).toBe(stale);

      const synced = syncBaseWithRemote(bare, 'main', false);
      expect(synced).toEqual({ checkout: tip, freshness: 'remote-synced' });
      expect(git(bare, ['rev-parse', '--verify', 'refs/remotes/origin/main'])).toBe(tip);
      expect(git(bare, ['rev-parse', 'refs/heads/main'])).toBe(stale);
      expect(spawnSync('git', ['symbolic-ref', '-q', 'refs/remotes/origin/main'], { cwd: bare }).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
