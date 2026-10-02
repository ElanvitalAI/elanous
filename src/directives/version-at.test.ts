import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compareVersions, createVersionResolver } from './version-at.js';

test('release and origin/main package history boundaries, aliases and cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'directive-version-'));
  const releaseRoot = join(root, 'release'); mkdirSync(releaseRoot);
  for (const [version, at] of [['0.2.3', '2026-09-27T15:00:00Z'], ['0.2.4', '2026-09-29T08:44:00Z']]) {
    const path = join(releaseRoot, version); mkdirSync(path);
    writeFileSync(join(path, 'release.json'), JSON.stringify({ version, tag: `v${version}`, sourceCommit: 'abc', publishedAt: at }));
  }
  const unpublished = join(releaseRoot, '0.2.5'); mkdirSync(unpublished);
  writeFileSync(join(unpublished, 'release.json'), JSON.stringify({ version: '0.2.5', tag: 'v0.2.5', sourceCommit: 'abc', createdAt: '2026-09-29T09:00:00Z' }));
  const repoRoot = join(root, 'repo'); mkdirSync(repoRoot);
  const git = (args: string[], date?: string) => {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ version: '0.2.5-dev.0' }));
  git(['add', 'package.json']); git(['commit', '-qm', 'first'], '2026-09-28T00:00:00Z');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ version: '0.2.6-dev.0' }));
  git(['commit', '-qam', 'second'], '2026-09-30T00:00:00Z');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD~1'], '2026-09-28T00:01:00Z');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], '2026-09-30T01:00:00Z');
  const at = createVersionResolver({ releaseRoot, repoRoot, codenames: { '0.2.5': '지니의 소원', '0.2.6': '내 일에 맞게' } });
  expect(at('2026-09-27T14:59:59Z').released).toBeNull();
  expect(at('2026-09-28T01:00:00Z')).toEqual({ released: '0.2.3', dev: '0.2.5-dev.0', codename: '지니의 소원' });
  expect(at('2026-09-29T08:43:59Z').released).toBe('0.2.3');
  expect(at('2026-09-29T08:44:00Z').released).toBe('0.2.4');
  expect(at('2026-09-29T10:00:00Z').released).toBe('0.2.4');
  expect(at('2026-09-30T00:00:00Z').dev).toBe('0.2.5-dev.0');
  expect(at('2026-09-30T01:00:00Z').codename).toBe('내 일에 맞게');
  expect(at('2026-09-28T01:00:00Z').dev).toBe('0.2.5-dev.0');
  expect(at('2026-09-28T00:00:00Z').dev).toBeNull();
  expect(createVersionResolver({ releaseRoot, repoRoot: join(root, 'missing') })('2026-09-29T09:00:00Z').dev).toBeNull();
});

test('two origin/main updates in the same second resolve to the later snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'directive-version-same-second-'));
  const repoRoot = join(root, 'repo'); mkdirSync(repoRoot);
  const git = (args: string[], date?: string) => {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ version: '0.2.5-dev.0' }));
  git(['add', 'package.json']); git(['commit', '-qm', 'first'], '2026-09-28T00:00:00Z');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ version: '0.2.6-dev.0' }));
  git(['commit', '-qam', 'second'], '2026-09-28T00:00:00Z');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD~1'], '2026-09-30T01:00:00Z');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], '2026-09-30T01:00:00Z');
  const at = createVersionResolver({ releaseRoot: join(root, 'none'), repoRoot });
  expect(at('2026-09-30T02:00:00Z').dev).toBe('0.2.6-dev.0');
});

test('released = highest version published by then, even when an old record was re-written later', () => {
  const root = mkdtempSync(join(tmpdir(), 'directive-version-rewritten-'));
  const releaseRoot = join(root, 'release'); mkdirSync(releaseRoot);
  for (const [version, at] of [['0.1.1', '2026-09-29T23:32:13Z'], ['0.2.4', '2026-09-29T08:37:43Z'], ['0.2.3', '2026-09-27T15:29:10Z']]) {
    const path = join(releaseRoot, version); mkdirSync(path);
    writeFileSync(join(path, 'release.json'), JSON.stringify({ version, publishedAt: at }));
  }
  const at = createVersionResolver({ releaseRoot, repoRoot: join(root, 'missing') });
  expect(at('2026-09-30T01:00:00Z').released).toBe('0.2.4');
  expect(at('2026-09-29T09:00:00Z').released).toBe('0.2.4');
  expect(at('2026-09-28T00:00:00Z').released).toBe('0.2.3');
});

test('compareVersions orders numerically and puts a prerelease before its release', () => {
  expect(['0.2.10', '0.1.1', '0.2.4', '0.2.5-alpha.93', '0.2.5'].sort(compareVersions)).toEqual(['0.1.1', '0.2.4', '0.2.5-alpha.93', '0.2.5', '0.2.10']);
});
