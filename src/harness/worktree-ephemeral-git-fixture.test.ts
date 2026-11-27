import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyGitWorktree } from './worktree-ephemeral-policy';

const facts = { ownerKnown: true, ptyInactive: true, merged: true, nowMs: 172_800_000, lastActivityMs: 0 };
describe('read-only Git fixture classification', () => {
  test('clean, untracked and ignored fixture contents are classified and preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ephemeral-git-fixture-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    git('init', '-q');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    git('add', '.gitignore');
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    expect(classifyGitWorktree(dir, facts).eligible).toBe(true);
    writeFileSync(join(dir, 'untracked.txt'), 'preserve');
    expect(classifyGitWorktree(dir, facts).reasons).toContain('untracked-present-or-unknown');
    writeFileSync(join(dir, 'ignored.txt'), 'preserve');
    expect(classifyGitWorktree(dir, facts).reasons).toContain('ignored-present-or-unknown');
    expect(existsSync(join(dir, 'untracked.txt'))).toBe(true);
    expect(existsSync(join(dir, 'ignored.txt'))).toBe(true);
  });
  test('invalid path fails closed', () => {
    expect(classifyGitWorktree('/path-that-does-not-exist-fixture', facts).eligible).toBe(false);
  });
});
