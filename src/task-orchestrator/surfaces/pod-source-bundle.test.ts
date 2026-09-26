import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSourceBundle } from './pod-source-bundle.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(): { dir: string; repo: string; out: string; base: string; remote: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pod-source-'));
  const remote = join(dir, 'origin.git');
  git(dir, 'init', '--bare', '--initial-branch=main', remote);
  const seed = join(dir, 'seed');
  git(dir, 'init', '--initial-branch=main', seed);
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'config', 'user.email', 'test@example.org');
  writeFileSync(join(seed, 'a.txt'), 'original a\n');
  writeFileSync(join(seed, 'b.txt'), 'original b\n');
  writeFileSync(join(seed, '.gitignore'), 'ignored.txt\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  const repo = join(dir, 'clone');
  git(dir, 'clone', remote, repo);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.org');
  return { dir, repo, out: join(dir, 'output'), base: git(repo, 'rev-parse', 'HEAD'), remote };
}

function snapshot(repo: string): string[] {
  return [git(repo, 'status', '--porcelain=v1', '-uall'), git(repo, 'rev-parse', 'HEAD'), git(repo, 'diff', '--cached', '--binary'), git(repo, 'symbolic-ref', 'HEAD'), git(repo, 'stash', 'list'), git(repo, 'show-ref', '--verify', 'refs/remotes/origin/HEAD')];
}

function fetchBundle(f: ReturnType<typeof fixture>, bundlePath: string): string {
  const dest = join(f.dir, `receiver-${Math.random().toString(36).slice(2)}`);
  git(f.dir, 'init', dest);
  git(dest, 'fetch', f.remote, 'main');
  git(dest, 'bundle', 'verify', bundlePath);
  git(dest, 'fetch', bundlePath, 'refs/elanous/pod-source/*:refs/remotes/bundle/*');
  return dest;
}

describe('packSourceBundle', () => {
  test('worktree packs tracked, untracked and staged on-disk content; user state survives; receiver fetches history', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, '.gitignore'), 'ignored.txt\nlocal-ignore.txt\n');
      git(f.repo, 'stash', 'push', '-m', 'keep stash');
      writeFileSync(join(f.repo, 'a.txt'), 'changed a\n');
      writeFileSync(join(f.repo, 'new.txt'), 'new\n');
      writeFileSync(join(f.repo, 'ignored.txt'), 'ignored\n');
      writeFileSync(join(f.repo, 'b.txt'), 'staged version\n');
      git(f.repo, 'add', 'b.txt');
      writeFileSync(join(f.repo, 'b.txt'), 'disk version\n');
      const before = snapshot(f.repo);
      const indexBytes = readFileSync(join(f.repo, '.git/index'));
      const diskBytes = ['a.txt', 'b.txt', 'new.txt'].map((name) => readFileSync(join(f.repo, name)));
      const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
      const bundle = packSourceBundle({ repoDir: f.repo, kind: 'worktree', base: f.base, outDir: f.out, log: (category, event, data) => events.push({ category, event, data }) });
      expect(snapshot(f.repo)).toEqual(before);
      expect(readFileSync(join(f.repo, '.git/index'))).toEqual(indexBytes);
      expect(['a.txt', 'b.txt', 'new.txt'].map((name) => readFileSync(join(f.repo, name)))).toEqual(diskBytes);
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
      expect(existsSync(join(f.out, 'index.tmp'))).toBe(false);
      expect(bundle.baseCommit).toBe(f.base);
      expect(bundle.fileCount).toBe(3);
      expect(bundle.sizeBytes).toBeGreaterThan(0);
      expect(bundle.sha256).toBe(createHash('sha256').update(readFileSync(bundle.bundlePath)).digest('hex'));
      expect(events).toContainEqual({ category: 'pod.source', event: 'bundle-packed', data: { kind: 'worktree', baseCommit: f.base, headCommit: bundle.headCommit, fileCount: 3, sizeBytes: bundle.sizeBytes, ms: expect.any(Number) } });
      const dest = fetchBundle(f, bundle.bundlePath);
      expect(git(dest, 'show', `${bundle.headCommit}:a.txt`)).toBe('changed a');
      expect(git(dest, 'show', `${bundle.headCommit}:new.txt`)).toBe('new');
      expect(git(dest, 'show', `${bundle.headCommit}:b.txt`)).toBe('disk version');
      expect(git(dest, 'rev-parse', `${bundle.headCommit}^`)).toBe(f.base);
      expect(git(dest, 'ls-tree', '-r', '--name-only', bundle.headCommit)).not.toContain('ignored.txt');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('files packs only selected disk paths relative to base, not unrelated staged changes', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, 'a.txt'), 'chosen\n');
      writeFileSync(join(f.repo, 'b.txt'), 'unrelated staged\n');
      git(f.repo, 'add', 'b.txt');
      writeFileSync(join(f.repo, 'unrelated.txt'), 'not selected\n');
      const before = snapshot(f.repo);
      const bundle = packSourceBundle({ repoDir: f.repo, kind: 'files', base: f.base, paths: ['a.txt'], outDir: f.out });
      expect(snapshot(f.repo)).toEqual(before);
      expect(existsSync(join(f.out, 'index.tmp'))).toBe(false);
      expect(bundle.fileCount).toBe(1);
      const dest = fetchBundle(f, bundle.bundlePath);
      expect(git(dest, 'show', `${bundle.headCommit}:a.txt`)).toBe('chosen');
      expect(git(dest, 'show', `${bundle.headCommit}:b.txt`)).toBe('original b');
      expect(git(dest, 'ls-tree', '-r', '--name-only', bundle.headCommit)).not.toContain('unrelated.txt');
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('refuses a local-only base, logging why without changing the user state', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, 'a.txt'), 'local\n');
      git(f.repo, 'add', 'a.txt');
      git(f.repo, 'commit', '-m', 'local only');
      const before = snapshot(f.repo);
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      expect(() => packSourceBundle({ repoDir: f.repo, kind: 'worktree', base: 'HEAD', outDir: f.out, log: (_c, event, data) => events.push({ event, data }) })).toThrow('not on origin default branch');
      expect(events).toContainEqual({ event: 'bundle-refused', data: { kind: 'worktree', reason: expect.stringContaining('not on origin default branch') } });
      expect(snapshot(f.repo)).toEqual(before);
      expect(existsSync(f.out)).toBe(false);
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('accepts a fetched origin default branch without a local origin/HEAD and leaves refs intact', () => {
    const f = fixture();
    try {
      const repo = join(f.dir, 'initialized');
      git(f.dir, 'init', repo);
      git(repo, 'remote', 'add', 'origin', f.remote);
      git(repo, 'fetch', 'origin', 'main');
      git(repo, 'checkout', '-b', 'local', 'FETCH_HEAD');
      expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/HEAD')).toBe('');
      writeFileSync(join(repo, 'a.txt'), 'initialized change\n');
      const before = [git(repo, 'status', '--porcelain'), git(repo, 'rev-parse', 'HEAD'), git(repo, 'diff', '--cached'), git(repo, 'symbolic-ref', 'HEAD'), git(repo, 'show-ref')];
      const bundle = packSourceBundle({ repoDir: repo, kind: 'files', base: f.base, paths: ['a.txt'], outDir: f.out });
      expect([git(repo, 'status', '--porcelain'), git(repo, 'rev-parse', 'HEAD'), git(repo, 'diff', '--cached'), git(repo, 'symbolic-ref', 'HEAD'), git(repo, 'show-ref')]).toEqual(before);
      expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
      const dest = fetchBundle(f, bundle.bundlePath);
      expect(git(dest, 'show', `${bundle.headCommit}:a.txt`)).toBe('initialized change');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('rejects a stale tracking ref when origin no longer supplies the base', () => {
    const f = fixture();
    try {
      const replacement = join(f.dir, 'replacement');
      git(f.dir, 'init', '--initial-branch=main', replacement);
      git(replacement, 'config', 'user.name', 'Test');
      git(replacement, 'config', 'user.email', 'test@example.org');
      writeFileSync(join(replacement, 'a.txt'), 'replacement\n');
      git(replacement, 'add', '-A');
      git(replacement, 'commit', '-m', 'unrelated root');
      git(replacement, 'remote', 'add', 'origin', f.remote);
      git(replacement, 'push', '--force', 'origin', 'main');
      expect(git(f.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(f.base);
      const before = snapshot(f.repo);
      const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
      expect(() => packSourceBundle({ repoDir: f.repo, kind: 'worktree', base: f.base, outDir: f.out, log: (category, event, data) => events.push({ category, event, data }) })).toThrow('not on origin default branch');
      expect(events).toContainEqual({ category: 'pod.source', event: 'bundle-refused', data: { kind: 'worktree', reason: expect.stringContaining('origin cannot supply this base') } });
      expect(snapshot(f.repo)).toEqual(before);
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
      expect(existsSync(f.out)).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('preserves an existing temporary index in outDir on refusal', () => {
    const f = fixture();
    try {
      git(f.dir, 'init', f.out);
      const keep = join(f.out, 'index.tmp');
      writeFileSync(keep, 'do not replace');
      expect(() => packSourceBundle({ repoDir: f.repo, kind: 'worktree', base: f.base, outDir: f.out })).toThrow('temporary index already exists');
      expect(readFileSync(keep, 'utf8')).toBe('do not replace');
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('rejects a dangling temporary index symlink and preserves the link', () => {
    const f = fixture();
    try {
      mkdirSync(f.out);
      const keep = join(f.out, 'index.tmp');
      symlinkSync('missing-index', keep);
      const before = snapshot(f.repo);
      expect(() => packSourceBundle({ repoDir: f.repo, kind: 'worktree', base: f.base, outDir: f.out })).toThrow('temporary index already exists');
      expect(lstatSync(keep).isSymbolicLink()).toBe(true);
      expect(readlinkSync(keep)).toBe('missing-index');
      expect(snapshot(f.repo)).toEqual(before);
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('rejects worktree-internal outDir when repoDir is a subdirectory without changing user state', () => {
    const f = fixture();
    try {
      const subdir = join(f.repo, 'nested');
      mkdirSync(subdir);
      const keep = join(f.repo, 'keep.bundle');
      writeFileSync(keep, 'host bytes');
      writeFileSync(join(f.repo, 'a.txt'), 'changed at root\n');
      const before = snapshot(f.repo);
      expect(() => packSourceBundle({ repoDir: subdir, kind: 'worktree', base: f.base, outDir: f.repo })).toThrow('outDir must be outside');
      expect(readFileSync(keep, 'utf8')).toBe('host bytes');
      expect(snapshot(f.repo)).toEqual(before);
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('packs the entire worktree when repoDir is a subdirectory and outDir is external', () => {
    const f = fixture();
    try {
      const subdir = join(f.repo, 'nested');
      mkdirSync(subdir);
      writeFileSync(join(f.repo, 'a.txt'), 'changed at root\n');
      writeFileSync(join(subdir, 'new.txt'), 'new below\n');
      const before = snapshot(f.repo);
      const bundle = packSourceBundle({ repoDir: subdir, kind: 'worktree', base: f.base, outDir: f.out });
      expect(snapshot(f.repo)).toEqual(before);
      expect(bundle.fileCount).toBe(2);
      const dest = fetchBundle(f, bundle.bundlePath);
      expect(git(dest, 'show', `${bundle.headCommit}:a.txt`)).toBe('changed at root');
      expect(git(dest, 'show', `${bundle.headCommit}:nested/new.txt`)).toBe('new below');
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('rejects an output directory inside the worktree without touching its files', () => {
    const f = fixture();
    try {
      const keep = join(f.repo, 'keep.bundle');
      writeFileSync(keep, 'host bytes');
      const before = snapshot(f.repo);
      expect(() => packSourceBundle({ repoDir: f.repo, kind: 'worktree', base: f.base, outDir: f.repo })).toThrow('outDir must be outside');
      expect(readFileSync(keep, 'utf8')).toBe('host bytes');
      expect(snapshot(f.repo)).toEqual(before);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('rejects oversized bundles and removes bundle, ref and temporary index', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, 'a.txt'), 'oversize');
      const before = snapshot(f.repo);
      const events: string[] = [];
      expect(() => packSourceBundle({ repoDir: f.repo, kind: 'worktree', base: f.base, outDir: f.out, maxSizeBytes: 1, log: (_c, event) => events.push(event) })).toThrow('exceeds limit');
      expect(events).toContain('bundle-refused');
      expect(snapshot(f.repo)).toEqual(before);
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/elanous/pod-source')).toBe('');
      expect(existsSync(join(f.out, 'index.tmp'))).toBe(false);
      expect(readdirSync(f.out)).toEqual([]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
