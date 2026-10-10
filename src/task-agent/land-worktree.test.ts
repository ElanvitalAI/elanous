import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLandWorktree, landWorktreePath, localHead } from './land-worktree.js';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** origin(bare) ⊕ 호스트 checkout(main) ⊕ origin 에만 있는 PR 머리(refs/pull/7/head). */
function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ta-land-wt-'));
  const origin = join(root, 'origin.git');
  const host = join(root, 'host');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, host);
  git(host, 'config', 'user.email', 't@t'); git(host, 'config', 'user.name', 't');
  writeFileSync(join(host, 'a.txt'), 'main\n');
  git(host, 'add', '.'); git(host, 'commit', '-qm', 'main'); git(host, 'push', '-q', 'origin', 'HEAD:main');
  git(host, 'checkout', '-qb', 'feature/pod');
  writeFileSync(join(host, 'a.txt'), 'pr\n');
  git(host, 'commit', '-qam', 'pr');
  const head = git(host, 'rev-parse', 'HEAD');
  git(host, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  git(host, 'checkout', '-q', '-'); git(host, 'branch', '-qD', 'feature/pod');
  return { root, host, head, statePath: join(root, 'state', 'task-agent-actions.json') };
}

describe('TA-LAND-WORKTREE — PR 머리 임시 워크트리(실물 git)', () => {
  test('host checkout on another head → worktree on the PR head with the PR branch checked out, clean · cleanup removes it and the branch', async () => {
    const f = repoFixture();
    expect(localHead(f.host)).not.toBe(f.head);
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    if ('reason' in made) throw new Error(made.reason);
    expect(made.cwd).toBe(landWorktreePath(f.statePath, 'ta-c', 7, f.head));
    expect(git(made.cwd, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(git(made.cwd, 'branch', '--show-current')).toBe('feature/pod');
    expect(git(made.cwd, 'status', '--porcelain')).toBe('');
    expect(made.cleanup()).toEqual({ removed: true, branchRemoved: true });
    expect(existsSync(made.cwd)).toBe(false);
    expect(existsSync(`${made.cwd}.owner`)).toBe(false);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/pod'], { cwd: f.host }).status).not.toBe(0);
    expect(git(f.host, 'worktree', 'list')).not.toContain('land-worktrees');
  });

  test('a local branch with the PR name on another commit is not overwritten → reason, nothing created', async () => {
    const f = repoFixture();
    git(f.host, 'branch', 'feature/pod');
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    expect(made).toEqual({ reason: expect.stringContaining('local branch feature/pod exists'), created: false, removed: null });
    expect(existsSync(landWorktreePath(f.statePath, 'ta-c', 7, f.head))).toBe(false);
  });

  test('fetched PR head differs from the pinned head → reason', async () => {
    const f = repoFixture();
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: 'f'.repeat(40), branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    expect(made).toEqual({ reason: expect.stringContaining('fetched PR head'), created: false, removed: null });
  });

  test('a stale worktree from an earlier attempt at the same path is removed and recreated', async () => {
    const f = repoFixture();
    const first = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    if ('reason' in first) throw new Error(first.reason);
    // 앞 시도가 걷지 못하고 죽었다 — 가지는 우리가 만든 것(같은 머리)이라 재사용된다.
    const second = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    if ('reason' in second) throw new Error(second.reason);
    expect(git(second.cwd, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(second.cleanup().removed).toBe(true);
  });

  test('dependency setup dirties a tracked file → not clean → reason · tree and our branch removed (created true, removed true)', async () => {
    const f = repoFixture();
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath },
      { provideDeps: (worktree) => { writeFileSync(join(worktree, 'a.txt'), 'dirty\n'); } });
    expect(made).toEqual({ reason: expect.stringContaining('not clean after dependency setup'), created: true, removed: true });
    expect(existsSync(landWorktreePath(f.statePath, 'ta-c', 7, f.head))).toBe(false);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/pod'], { cwd: f.host }).status).not.toBe(0);
  });

  test('a branch created by someone else between the check and `worktree add -b` is left alone', async () => {
    const f = repoFixture();
    const base = git(f.host, 'rev-parse', 'HEAD');
    const racing = (cwd: string, args: string[]) => {
      // 경합: 우리 add 직전에 남이 같은 이름 가지를 다른 커밋에 만든다.
      if (args[0] === 'worktree' && args[1] === 'add') spawnSync('git', ['branch', 'feature/pod', base], { cwd: f.host });
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { git: racing, provideDeps: () => {} });
    expect(made).toEqual({ reason: expect.stringContaining('git worktree add failed'), created: false, removed: null });
    expect(git(f.host, 'rev-parse', 'refs/heads/feature/pod')).toBe(base);
  });

  test('a locked registered worktree is not force-deleted by hand — git refusal is reported, files stay', async () => {
    const f = repoFixture();
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    if ('reason' in made) throw new Error(made.reason);
    git(f.host, 'worktree', 'lock', made.cwd);
    const out = made.cleanup();
    expect(out.removed).toBe(false);
    expect(out.reason).toContain('git worktree remove failed');
    expect(existsSync(made.cwd)).toBe(true);
    git(f.host, 'worktree', 'unlock', made.cwd);
    expect(made.cleanup().removed).toBe(true);
  });

  test('worktree list unreadable → nothing is removed (unknown is not «unregistered»)', async () => {
    const f = repoFixture();
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    if ('reason' in made) throw new Error(made.reason);
    const broken = (cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 128, stdout: '', stderr: 'fatal: unreadable' };
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    // 같은 자리에 다시 만들려 할 때(지난 트리 정리) 목록을 못 읽으면 지우지 않고 멈춘다.
    const again = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { git: broken, provideDeps: () => {} });
    expect(again).toMatchObject({ reason: expect.stringContaining('worktree list unreadable') });
    expect(existsSync(made.cwd)).toBe(true);
    expect(made.cleanup().removed).toBe(true);
  });

  test('an unregistered path at the land-worktree spot without our owner mark is not deleted (could be someone else\'s)', async () => {
    const f = repoFixture();
    const path = landWorktreePath(f.statePath, 'ta-c', 7, f.head);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'user-file.txt'), 'keep me');
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    expect(made).toMatchObject({ reason: expect.stringContaining('not proven'), created: false, removed: null });
    expect(existsSync(join(path, 'user-file.txt'))).toBe(true);
  });

  test('an unregistered leftover carrying this repository\'s owner mark (died before registration) is removed and recreated', async () => {
    const f = repoFixture();
    const path = landWorktreePath(f.statePath, 'ta-c', 7, f.head);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'partial'), 'x');
    writeFileSync(`${path}.owner`, realpathSync(git(f.host, 'rev-parse', '--path-format=absolute', '--git-common-dir')));
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    if ('reason' in made) throw new Error(made.reason);
    expect(git(made.cwd, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(made.cleanup().removed).toBe(true);
  });

  test('a registered worktree at the land spot that is not ours (no owner mark) is kept — no force remove', async () => {
    const f = repoFixture();
    const path = landWorktreePath(f.statePath, 'ta-c', 7, f.head);
    mkdirSync(join(path, '..'), { recursive: true });
    git(f.host, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    writeFileSync(join(path, 'their-work.txt'), 'keep me');
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { provideDeps: () => {} });
    expect(made).toMatchObject({ reason: expect.stringContaining('not proven'), created: false, removed: null });
    expect(existsSync(join(path, 'their-work.txt'))).toBe(true);
    expect(git(f.host, 'worktree', 'list')).toContain('land-worktrees');
  });

  test('dependency setup detaches HEAD on the same commit → not the PR branch → reason · cleaned up', async () => {
    const f = repoFixture();
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath },
      { provideDeps: (worktree) => { git(worktree, 'checkout', '-q', '--detach'); } });
    expect(made).toEqual({ reason: expect.stringContaining('land worktree branch is detached'), created: true, removed: true });
    expect(existsSync(landWorktreePath(f.statePath, 'ta-c', 7, f.head))).toBe(false);
  });

  test('a git call that throws after the tree exists still removes the tree', async () => {
    const f = repoFixture();
    const throwing = (cwd: string, args: string[]) => {
      if (args[0] === 'branch' && args[1] === '--show-current') throw new Error('spawn exploded');
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const made = await createLandWorktree({ card: 'ta-c', pr: 7, head: f.head, branch: 'feature/pod', repoCwd: f.host, statePath: f.statePath }, { git: throwing, provideDeps: () => {} });
    expect(made).toMatchObject({ reason: expect.stringContaining('spawn exploded'), created: true, removed: true });
    expect(existsSync(landWorktreePath(f.statePath, 'ta-c', 7, f.head))).toBe(false);
  });
});
