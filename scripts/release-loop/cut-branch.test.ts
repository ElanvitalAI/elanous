import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cutReleaseBranch } from './cut-branch.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cut-branch-test-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'remote', 'add', 'origin', remote);
  const commit = (name: string, content: string) => {
    writeFileSync(join(repo, name), content);
    git(repo, 'add', name);
    git(repo, 'commit', '-q', '-m', name);
    return git(repo, 'rev-parse', 'HEAD');
  };
  commit('package.json', '{"version":"0.2.4"}\n');
  const base = git(repo, 'rev-parse', 'HEAD');
  const pick = commit('repair.txt', 'fixed\n');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { root, repo, git, commit, base, pick };
}

test('dry-run prints the ordered plan and leaves no release branch', () => {
  const f = fixture();
  const lines: string[] = [];
  const result = cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], dryRun: true, repoRoot: f.repo, log: (line) => lines.push(line) });
  expect(result).toEqual({ branch: 'release/0.2.4', commit: null, dryRun: true });
  expect(lines[0]).toContain(`${f.base} + ${f.pick}`);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4')).toBe('');
});

test('picked fixes are cherry-picked in order and pushed; resulting SHA can be used as the cut', () => {
  const f = fixture();
  const second = f.commit('repair-two.txt', 'fixed again\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const result = cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick, second], repoRoot: f.repo, log: () => {} });
  expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  const commit = result.commit!;
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0]).toBe(commit);
  expect(f.git(f.repo, 'show', `${commit}:repair.txt`)).toBe('fixed');
  expect(f.git(f.repo, 'show', `${commit}:repair-two.txt`)).toBe('fixed again');
  expect(f.git(f.repo, 'rev-parse', 'origin/main')).toBe(second);
});

test('a freshly cloned checkout can select the pushed release tip absent from its local objects', () => {
  const f = fixture();
  const branch = cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} });
  const clone = join(f.root, 'fresh');
  f.git(f.root, 'clone', '-q', '--single-branch', '--branch', 'main', join(f.root, 'remote.git'), clone);
  const selected = spawnSync(process.execPath, [resolve(import.meta.dir, 'version-node.ts'), 'release', '--version', '0.2.4', '--cut-commit', branch.commit!, '--json'], {
    cwd: clone, encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '' },
  });
  expect(selected.status).toBe(0);
  expect(JSON.parse(selected.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'ok', commit: branch.commit, pr: null });
  expect(f.git(clone, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0]).toBe(branch.commit!);
});

test('a pick not on origin/main is refused before branch creation', () => {
  const f = fixture();
  f.git(f.repo, 'checkout', '-q', '-b', 'unmerged');
  const stray = f.commit('stray.txt', 'not on main\n');
  expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [stray], repoRoot: f.repo, log: () => {} })).toThrow('not an ancestor of origin/main');
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4')).toBe('');
});

test('existing remote branch is refused without changing its tip and names --append', () => {
  const f = fixture();
  const existing = cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} });
  expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} })).toThrow('--append');
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0]).toBe(existing.commit!);
});

test('--append fast-forwards a new main pick onto release/9.9.9 and refuses a moved tip without force-push', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'package.json'), '{"version":"9.9.9"}\n');
  f.git(f.repo, 'add', 'package.json');
  f.git(f.repo, 'commit', '-q', '-m', 'bump 9.9.9');
  f.base = f.git(f.repo, 'rev-parse', 'HEAD');
  f.pick = f.commit('repair.txt', 'fixed on 9.9.9\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  f.git(f.repo, 'push', '-q', 'origin', `${f.pick}:refs/heads/release/9.9.9`);
  const existing = f.pick;
  const added = f.commit('repair-three.txt', 'fourth\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const lines: string[] = [];
  const appended = cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [added], append: true, repoRoot: f.repo, log: (line) => lines.push(line) });
  expect(appended.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(appended.commit).not.toBe(existing);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(appended.commit!);
  expect(f.git(f.repo, 'merge-base', '--is-ancestor', existing, appended.commit!)).toBe('');
  expect(f.git(f.repo, 'show', `${appended.commit}:repair-three.txt`)).toBe('fourth');
  expect(lines[0]).toContain('(append)');
  const sneak = f.commit('sneak.txt', 'moved\n');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(f.root, 'bin-append');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = push ]; then
  "${realGit}" --git-dir="${join(f.root, 'remote.git')}" update-ref refs/heads/release/9.9.9 "${sneak}" || exit $?
fi
exec "${realGit}" "$@"
`);
  // The sneak is already the advertised tip. Move it again only when push runs, after fetch has pinned the lease.
  chmodSync(wrapper, 0o755);
  const next = f.commit('repair-four.txt', 'later\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const oldPath = process.env.PATH;
  let refused: unknown;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    try { cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [next], append: true, repoRoot: f.repo, log: () => {} }); }
    catch (error) { refused = error; }
  } finally {
    process.env.PATH = oldPath;
  }
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toMatch(/fast-forward refused|stale info/);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(sneak);
  expect(sneak).not.toBe(appended.commit);
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
});

test('--append refuses a pick already on the release branch and a missing branch', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'package.json'), '{"version":"9.9.9"}\n');
  f.git(f.repo, 'add', 'package.json');
  f.git(f.repo, 'commit', '-q', '-m', 'bump 9.9.9');
  f.base = f.git(f.repo, 'rev-parse', 'HEAD');
  f.pick = f.commit('repair.txt', 'fixed on 9.9.9\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  expect(() => cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [f.pick], append: true, repoRoot: f.repo, log: () => {} })).toThrow('does not exist on origin');
  f.git(f.repo, 'push', '-q', 'origin', `HEAD:refs/heads/release/9.9.9`);
  expect(() => cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [f.pick], append: true, repoRoot: f.repo, log: () => {} })).toThrow('already in release/9.9.9');
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(f.pick);
});

test('a remote branch created after the absence check is refused and its tip preserved', () => {
  const f = fixture();
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = push ]; then
  "${realGit}" --git-dir="${join(f.root, 'remote.git')}" update-ref refs/heads/release/0.2.4 "${f.base}" || exit $?
fi
exec "${realGit}" "$@"
`);
  chmodSync(wrapper, 0o755);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} })).toThrow('git push failed');
  } finally {
    process.env.PATH = oldPath;
  }
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0]).toBe(f.base);
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
});

test('a competing remote branch created at the same tip is refused and preserved', () => {
  const f = fixture();
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = push ]; then
  for arg do :; done
  sha="\${arg%%:*}"
  printf '%s' "$sha" > "${join(f.root, 'competing-tip')}"
  # A real push carries the cherry-picked object; update-ref alone fails once the pick lands in a new second (new SHA).
  "${realGit}" push -q "${join(f.root, 'remote.git')}" "$sha:refs/heads/release/0.2.4" || exit $?
  output=$("${realGit}" "$@" 2>&1)
  rc=$?
  printf '%s\n' "$output" > "${join(f.root, 'push-result')}"
  printf '%s\n' "$output"
  exit "$rc"
fi
exec "${realGit}" "$@"
`);
  chmodSync(wrapper, 0o755);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} })).toThrow('already exists on origin');
  } finally {
    process.env.PATH = oldPath;
  }
  const tip = f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0];
  expect(tip).toBe(readFileSync(join(f.root, 'competing-tip'), 'utf8'));
  expect(readFileSync(join(f.root, 'push-result'), 'utf8')).toContain('up to date');
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
});

test('cherry-pick conflict names the file, stops and leaves no branch', () => {
  const f = fixture();
  f.commit('repair.txt', 'changed by main\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  // A main-ancestor base can still conflict when a later main commit is picked before an earlier one.
  const first = f.commit('repair.txt', 'first\n');
  const second = f.commit('repair.txt', 'second\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [second, first], repoRoot: f.repo, log: () => {} })).toThrow('손으로 풀 곳: repair.txt');
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4')).toBe('');
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
  expect(f.git(f.repo, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(f.repo, 'package.json'), 'utf8')).toContain('0.2.4');
});
