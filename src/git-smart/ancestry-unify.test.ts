import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAncestor, type GitRun } from '../git-fs/smart-run.js';
import { ownerWorktreeHarvestState } from '../task-agent/actions.js';
import { relevantParents } from './smart-refresh.js';

const head = 'a'.repeat(40), parent = 'b'.repeat(40), base = 'c'.repeat(40), main = 'd'.repeat(40);

test('ancestry preserves git status and exceptions with exact argument order', () => {
  for (const status of [0, 1, 2, null]) {
    const calls: string[][] = [];
    expect(isAncestor(args => { calls.push(args); return { status }; }, base, main)).toBe(status === 0);
    expect(calls).toEqual([['merge-base', '--is-ancestor', base, main]]);
  }
  expect(() => isAncestor(() => { throw new Error('git error'); }, base, main)).toThrow('git error');
});

test('relevant parents retain nonzero and null ancestry results, but not success', () => {
  for (const status of [0, 1, 2, null]) {
    const git: GitRun = args => ({ status: args[1] === '--is-ancestor' ? status : 0,
      stdout: args[0] === 'merge-base' && args[1] !== '--is-ancestor' ? base : '', stderr: '' });
    expect(relevantParents(git, head, main, [parent, parent.toUpperCase(), 'bad'])).toEqual(status === 0 ? [] : [parent]);
  }
  const failing: GitRun = args => { if (args[1] === '--is-ancestor') throw new Error('runner'); return { status: 0, stdout: base, stderr: '' }; };
  expect(() => relevantParents(failing, head, main, [parent])).toThrow('runner');
});

test('owner harvest fails closed on ancestry failures and keeps ownership and SHA checks', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ancestry-owner-'));
  try {
    const input = { pr: 1, cwd, head, branch: 'owner', state: 'OPEN' };
    for (const status of [0, 1, 2, null]) {
      const git = (_cwd: string, args: string[]) => ({ status: args[0] === 'merge-base' ? status : 0,
        stdout: args[0] === 'branch' ? 'owner\n' : args[0] === 'rev-parse' ? parent : args[0] === 'worktree' ? `worktree ${cwd}\nbranch refs/heads/owner\n` : '' });
      expect(ownerWorktreeHarvestState(input, git)).toEqual(status === 0 ? { pr: 1, source: 'owner-worktree-commit', head: parent } : undefined);
      expect(ownerWorktreeHarvestState({ ...input, head: 'invalid' }, git)).toBeUndefined();
      expect(ownerWorktreeHarvestState({ ...input, branch: 'other' }, git)).toBeUndefined();
      expect(ownerWorktreeHarvestState(input, (dir, args) => { if (args[0] === 'merge-base') throw new Error('runner'); return git(dir, args); })).toBeUndefined();
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
