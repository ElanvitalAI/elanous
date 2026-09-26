import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePodSourceSpec, resolvePodSource } from './pod-source-spec.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('parsePodSourceSpec', () => {
  test('commit: plus 40 hex is kind commit', () => {
    expect(parsePodSourceSpec(`commit:${SHA}`)).toEqual({ kind: 'commit', sha: SHA });
  });

  test('pr:20785 is kind pr', () => {
    expect(parsePodSourceSpec('pr:20785')).toEqual({ kind: 'pr', number: 20785 });
  });

  test('pr:abc is a reasoned error', () => {
    expect(() => parsePodSourceSpec('pr:abc')).toThrow(/positive integer/);
  });

  test('files:a.txt,dir/b.txt is kind files', () => {
    expect(parsePodSourceSpec('files:a.txt,dir/b.txt')).toEqual({ kind: 'files', paths: ['a.txt', 'dir/b.txt'] });
  });

  test('worktree:. is kind worktree', () => {
    expect(parsePodSourceSpec('worktree:.')).toEqual({ kind: 'worktree', path: '.' });
  });

  test('commit:123 is a reasoned error', () => {
    expect(() => parsePodSourceSpec('commit:123')).toThrow(/40 hex/);
  });
});

describe('resolvePodSource', () => {
  test('worktree packs a bundle with sha256, sizeBytes, and headCommit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-source-spec-'));
    const remote = join(dir, 'origin.git');
    git(dir, 'init', '--bare', '--initial-branch=main', remote);
    const seed = join(dir, 'seed');
    git(dir, 'init', '--initial-branch=main', seed);
    git(seed, 'config', 'user.name', 'Test');
    git(seed, 'config', 'user.email', 'test@example.org');
    writeFileSync(join(seed, 'a.txt'), 'original\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-m', 'base');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-u', 'origin', 'main');
    const repo = join(dir, 'clone');
    git(dir, 'clone', remote, repo);
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.org');
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    const base = git(repo, 'rev-parse', 'HEAD');
    const outDir = join(dir, 'output');
    try {
      const parsed = parsePodSourceSpec(`worktree:${repo}`);
      expect(parsed.kind).toBe('worktree');
      if (parsed.kind !== 'worktree') return;
      const source = resolvePodSource(parsed, { base, outDir });
      expect(source.kind).toBe('bundle');
      if (source.kind !== 'bundle') return;
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.sizeBytes).toBeGreaterThan(0);
      expect(source.headCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(source.headCommit).not.toBe(base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
