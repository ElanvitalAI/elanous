import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideTreeSync, defaultGit, formatTreeSyncDecision, observeTreeSync, runTreeSyncDecisionCli, type GitCommand, type GitResult } from './tree-sync-decide.js';

const readableTarget = process.cwd();
const result = (stdout: string, exitCode = 0, stderr = ''): GitResult => ({ stdout, stderr, exitCode });
const gitFrom = (...results: Array<GitResult | Error>): GitCommand => async () => {
  const next = results.shift();
  if (!next) throw new Error('unexpected git command');
  if (next instanceof Error) throw next;
  return next;
};

describe('tree sync decision', () => {
  test('a clean worktree behind its remote is a pull decision that preserves behind commits', () => {
    expect(decideTreeSync('/target', { dirty: false, untracked: 0, ahead: 0, behind: 6 })).toEqual({ action: 'pull', reason: 'clean-behind', behind: 6, path: '/target', untracked: 0 });
  });

  test('unmeasured local changes retain the legacy conservative skip', () => {
    expect(decideTreeSync('/target', { dirty: true, untracked: 2, ahead: 0, behind: 3 })).toEqual({ action: 'skip', reason: 'local-changes', behind: 3, path: '/target', untracked: 2 });
  });

  test('measured non-overlapping local changes permit a pull', () => {
    expect(decideTreeSync('/target', { dirty: true, untracked: 2, ahead: 0, behind: 3, overlap: { status: 'measured', paths: [] } })).toEqual({ action: 'pull', reason: 'clean-behind', behind: 3, path: '/target', untracked: 2 });
  });

  test('measured overlapping local changes skip and name the conflicting files', () => {
    expect(decideTreeSync('/target', { dirty: true, untracked: 2, ahead: 0, behind: 3, overlap: { status: 'measured', paths: ['docs/goals/GOAL-1.md'] } })).toEqual({ action: 'skip', reason: 'overlapping-changes', behind: 3, path: '/target', untracked: 2, overlaps: ['docs/goals/GOAL-1.md'] });
  });

  test('an unreadable overlap measurement skips distinctly and conservatively', () => {
    expect(decideTreeSync('/target', { dirty: true, untracked: 2, ahead: 0, behind: 3, overlap: { status: 'unreadable', error: 'diff failed' } })).toEqual({ action: 'skip', reason: 'overlap-unreadable', behind: 3, path: '/target', untracked: 2, error: 'diff failed' });
  });

  test('a diverged worktree skips because a plain pull is not a safe fast-forward', () => {
    expect(decideTreeSync('/target', { dirty: false, untracked: 0, ahead: 2, behind: 3 })).toEqual({ action: 'skip', reason: 'diverged', behind: 3, path: '/target', untracked: 0 });
  });

  test('dirty worktrees preserve the legacy local-changes decision outside the behind-only overlap branch', () => {
    expect(decideTreeSync('/target', { dirty: true, untracked: 0, ahead: 2, behind: 3 })).toEqual({ action: 'skip', reason: 'local-changes', behind: 3, path: '/target', untracked: 0 });
    expect(decideTreeSync('/target', { dirty: true, untracked: 0, ahead: 1, behind: 0 })).toEqual({ action: 'skip', reason: 'local-changes', behind: 0, path: '/target', untracked: 0 });
    expect(decideTreeSync('/target', { dirty: true, untracked: 0, ahead: 0, behind: 0 })).toEqual({ action: 'skip', reason: 'local-changes', behind: 0, path: '/target', untracked: 0 });
  });

  test('unreadable remote is unavailable rather than a skip', async () => {
    const decision = await observeTreeSync(readableTarget, gitFrom(result(''), result(''), result('main\n'), new Error('network unavailable')));
    expect(decision).toEqual({ action: 'unavailable', reason: 'remote-unreadable', behind: null, path: readableTarget, untracked: 0, error: 'network unavailable' } satisfies typeof decision);
  });

  test('an unreadable target is unavailable before git and names the target without blaming git', async () => {
    const target = join(tmpdir(), 'tree-sync-missing-target');
    let called = false;
    const git: GitCommand = async () => {
      called = true;
      throw new Error('git must not run for an unreadable target');
    };
    const decision = await observeTreeSync(target, git);
    expect(decision).toMatchObject({ action: 'unavailable', reason: 'target-unreadable', behind: null, path: target, untracked: null });
    expect(decision.action).toBe('unavailable');
    if (decision.action !== 'unavailable') throw new Error('unreadable target must be unavailable');
    expect(decision.error).toContain(target);
    expect(decision.error).not.toContain('git');
    expect(called).toBeFalse();
  });

  test('a target without directory search permission is unavailable before git', async () => {
    const target = await mkdtemp(join(tmpdir(), 'tree-sync-unsearchable-target-'));
    let called = false;
    try {
      await chmod(target, 0o400);
      const decision = await observeTreeSync(target, async () => {
        called = true;
        throw new Error('git must not run for an unsearchable target');
      });
      expect(decision).toMatchObject({ action: 'unavailable', reason: 'target-unreadable', behind: null, path: target, untracked: null });
      expect(decision.action).toBe('unavailable');
      if (decision.action !== 'unavailable') throw new Error('unsearchable target must be unavailable');
      expect(decision.error).toContain(target);
      expect(decision.error).not.toContain('git');
      expect(called).toBeFalse();
    } finally {
      await chmod(target, 0o700);
      await rm(target, { recursive: true, force: true });
    }
  });

  test('local git command failures become local-unreadable output', async () => {
    const decision = await observeTreeSync(readableTarget, gitFrom(new Error('spawn failed')));
    expect(decision).toEqual({ action: 'unavailable', reason: 'local-unreadable', behind: null, path: readableTarget, untracked: null, error: 'spawn failed' });
  });

  test('remote git command failures become remote-unreadable output', async () => {
    const decision = await observeTreeSync(readableTarget, gitFrom(result(''), result(''), result('main\n'), result('', 128, 'fatal: remote unavailable')));
    expect(decision).toEqual({ action: 'unavailable', reason: 'remote-unreadable', behind: null, path: readableTarget, untracked: 0, error: 'fatal: remote unavailable' } satisfies typeof decision);
  });

  test('an untracked-only worktree behind its remote is observed as a pull with its untracked count', async () => {
    const calls: string[][] = [];
    const git: GitCommand = async (args) => {
      calls.push(args);
      if (args[0] === 'status' && args.includes('--untracked-files=no')) return result('');
      if (args[0] === 'status' && args.includes('--untracked-files=all')) return result('?? docs/goals/new-goal.md\n');
      if (args[0] === 'branch') return result('main\n');
      if (args[0] === 'fetch') return result('');
      if (args[0] === 'rev-list') return result('0\t1\n');
      throw new Error(`unexpected command ${args.join(' ')}`);
    };
    await expect(observeTreeSync(readableTarget, git)).resolves.toEqual({ action: 'pull', reason: 'clean-behind', behind: 1, path: readableTarget, untracked: 1 });
    expect(calls).toContainEqual(['status', '--porcelain', '--untracked-files=no']);
    expect(calls).toContainEqual(['status', '--porcelain', '--untracked-files=all']);
  });

  test('the observer measures local and incoming paths before pulling non-overlapping tracked changes', async () => {
    const calls: string[][] = [];
    const git: GitCommand = async (args) => {
      calls.push(args);
      if (args[0] === 'status' && args.includes('--untracked-files=no')) return result(' M docs/goals/GOAL-1.md\n');
      if (args[0] === 'status' && args.includes('--untracked-files=all')) return result(' M docs/goals/GOAL-1.md\n?? scratch.txt\n');
      if (args[0] === 'branch') return result('main\n');
      if (args[0] === 'fetch') return result('');
      if (args[0] === 'rev-list') return result('0\t1\n');
      if (args.join(' ') === 'diff --no-renames --name-only -z HEAD') return result('docs/goals/GOAL-1.md\0');
      if (args.join(' ') === 'diff --no-renames --name-only -z HEAD...refs/remotes/origin/main') return result('src/other.ts\0');
      throw new Error(`unexpected command ${args.join(' ')}`);
    };
    await expect(observeTreeSync(readableTarget, git)).resolves.toEqual({ action: 'pull', reason: 'clean-behind', behind: 1, path: readableTarget, untracked: 1 });
    expect(calls).toContainEqual(['diff', '--no-renames', '--name-only', '-z', 'HEAD']);
    expect(calls).toContainEqual(['diff', '--no-renames', '--name-only', '-z', 'HEAD...refs/remotes/origin/main']);
  });

  test('the observer reports named overlapping tracked changes', async () => {
    const git: GitCommand = async (args) => {
      if (args[0] === 'status') return result(' M docs/goals/GOAL-1.md\n');
      if (args[0] === 'branch') return result('main\n');
      if (args[0] === 'fetch') return result('');
      if (args[0] === 'rev-list') return result('0\t1\n');
      if (args.join(' ') === 'diff --no-renames --name-only -z HEAD') return result('docs/goals/GOAL-1.md\0');
      if (args.join(' ') === 'diff --no-renames --name-only -z HEAD...refs/remotes/origin/main') return result('docs/goals/GOAL-1.md\0src/other.ts\0');
      throw new Error(`unexpected command ${args.join(' ')}`);
    };
    await expect(observeTreeSync(readableTarget, git)).resolves.toEqual({ action: 'skip', reason: 'overlapping-changes', behind: 1, path: readableTarget, untracked: 0, overlaps: ['docs/goals/GOAL-1.md'] });
  });

  test('the observer blocks an actual incoming rename that touches a locally changed old path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tree-sync-rename-'));
    const remote = join(directory, 'remote.git');
    const source = join(directory, 'source');
    const target = join(directory, 'target');
    const git = async (args: string[], cwd = directory): Promise<void> => {
      const command = await defaultGit(args, cwd);
      if (command.exitCode !== 0) throw new Error(command.stderr || `git ${args.join(' ')} failed`);
    };
    try {
      await git(['init', '--bare', '--quiet', remote]);
      await git(['clone', '--quiet', remote, source]);
      await git(['config', 'user.email', 'tree-sync@example.test'], source);
      await git(['config', 'user.name', 'Tree Sync Test'], source);
      await writeFile(join(source, 'old-path.txt'), 'initial\n');
      await git(['add', 'old-path.txt'], source);
      await git(['commit', '--quiet', '-m', 'initial'], source);
      await git(['push', '--quiet', 'origin', 'HEAD:main'], source);
      await git(['clone', '--quiet', '--branch', 'main', remote, target]);
      await writeFile(join(target, 'old-path.txt'), 'local modification\n');
      await git(['mv', 'old-path.txt', 'new-path.txt'], source);
      await git(['commit', '--quiet', '-m', 'rename old path'], source);
      await git(['push', '--quiet', 'origin', 'HEAD:main'], source);

      await expect(observeTreeSync(target)).resolves.toEqual({ action: 'skip', reason: 'overlapping-changes', behind: 1, path: target, untracked: 0, overlaps: ['old-path.txt'] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('the observer keeps a failed overlap lookup distinct from local changes', async () => {
    const git: GitCommand = async (args) => {
      if (args[0] === 'status') return result(' M docs/goals/GOAL-1.md\n');
      if (args[0] === 'branch') return result('main\n');
      if (args[0] === 'fetch') return result('');
      if (args[0] === 'rev-list') return result('0\t1\n');
      if (args.join(' ') === 'diff --no-renames --name-only -z HEAD') return result('', 1, 'fatal: overlap unavailable');
      throw new Error(`unexpected command ${args.join(' ')}`);
    };
    await expect(observeTreeSync(readableTarget, git)).resolves.toEqual({ action: 'skip', reason: 'overlap-unreadable', behind: 1, path: readableTarget, untracked: 0, error: 'fatal: overlap unavailable' });
  });

  test('fetching the remote tracking ref lets a newly pushed remote commit be measured', async () => {
    const calls: string[][] = [];
    const git: GitCommand = async (args) => {
      calls.push(args);
      if (args[0] === 'status') return result('');
      if (args[0] === 'branch') return result('main\n');
      if (args[0] === 'fetch') return result('');
      if (args[0] === 'rev-list') return result('0\t1\n');
      throw new Error(`unexpected command ${args.join(' ')}`);
    };
    await expect(observeTreeSync(readableTarget, git)).resolves.toEqual({ action: 'pull', reason: 'clean-behind', behind: 1, path: readableTarget, untracked: 0 });
    expect(calls).toContainEqual(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    expect(calls).toContainEqual(['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main']);
  });

  test('a newly pushed remote commit is fetched and measured from the remote tracking ref', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tree-sync-remote-'));
    const remote = join(directory, 'remote.git');
    const source = join(directory, 'source');
    const target = join(directory, 'target');
    const git = async (args: string[], cwd = directory): Promise<void> => {
      const command = await defaultGit(args, cwd);
      if (command.exitCode !== 0) throw new Error(command.stderr || `git ${args.join(' ')} failed`);
    };
    try {
      await git(['init', '--bare', '--quiet', remote]);
      await git(['clone', '--quiet', remote, source]);
      await git(['config', 'user.email', 'tree-sync@example.test'], source);
      await git(['config', 'user.name', 'Tree Sync Test'], source);
      await writeFile(join(source, 'initial.txt'), 'initial\n');
      await git(['add', 'initial.txt'], source);
      await git(['commit', '--quiet', '-m', 'initial'], source);
      await git(['push', '--quiet', 'origin', 'HEAD:main'], source);
      await git(['clone', '--quiet', '--branch', 'main', remote, target]);
      await writeFile(join(source, 'new-remote-commit.txt'), 'new\n');
      await git(['add', 'new-remote-commit.txt'], source);
      await git(['commit', '--quiet', '-m', 'remote advance'], source);
      await git(['push', '--quiet', 'origin', 'HEAD:main'], source);

      await expect(observeTreeSync(target)).resolves.toEqual({ action: 'pull', reason: 'clean-behind', behind: 1, path: target, untracked: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('defaultGit drains stdout and stderr larger than a pipe buffer before the child exits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tree-sync-decide-'));
    try {
      const command = join(directory, 'git-large-output');
      await writeFile(command, `#!/bin/sh\nbun -e "process.stdout.write('o'.repeat(2_000_000)); process.stderr.write('e'.repeat(2_000_000))"\n`);
      await chmod(command, 0o755);
      const output = await Promise.race([
        defaultGit([`--exec-path=${directory}`, 'large-output'], directory),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('large-output git command timed out')), 5_000)),
      ]);
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toHaveLength(2_000_000);
      expect(output.stderr).toHaveLength(2_000_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('CLI calls the observer with an explicit target path and emits readable output', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => { lines.push(line); };
      const decision = await runTreeSyncDecisionCli(readableTarget, gitFrom(result(''), result('?? docs/goals/new-goal.md\n'), result('main\n'), result(''), result('0\t5\n')));
      expect(decision).toEqual({ action: 'pull', reason: 'clean-behind', behind: 5, path: readableTarget, untracked: 1 });
      expect(lines).toEqual([`tree sync pull: ${readableTarget} is 5 commit(s) behind (clean-behind; untracked 1)`]);
    } finally {
      console.log = originalLog;
    }
  });

  test('CLI refuses an omitted target rather than treating an isolated worktree cwd as the scheduled tree', async () => {
    await expect(runTreeSyncDecisionCli(undefined, gitFrom())).rejects.toThrow('target worktree path is required');
  });

  test('readable output distinguishes overlap, skip and unavailable decisions', () => {
    expect(formatTreeSyncDecision({ action: 'skip', reason: 'overlapping-changes', behind: 1, path: '/target', untracked: 2, overlaps: ['docs/goals/GOAL-1.md'] })).toBe('tree sync skip: /target (overlapping-changes; behind 1; untracked 2; overlaps docs/goals/GOAL-1.md)');
    expect(formatTreeSyncDecision({ action: 'skip', reason: 'overlap-unreadable', behind: 1, path: '/target', untracked: 2, error: 'diff failed' })).toBe('tree sync skip: /target (overlap-unreadable; behind 1; untracked 2; error diff failed)');
    expect(formatTreeSyncDecision({ action: 'skip', reason: 'up-to-date', behind: 0, path: '/target', untracked: 2 })).toBe('tree sync skip: /target (up-to-date; behind 0; untracked 2)');
    expect(formatTreeSyncDecision({ action: 'unavailable', reason: 'remote-unreadable', behind: null, path: '/target', untracked: null, error: 'offline' })).toContain('tree sync unavailable');
  });
});
