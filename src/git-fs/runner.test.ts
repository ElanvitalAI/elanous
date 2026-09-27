import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreSnapshot } from '../undo-turn/restore.js';
import { captureSnapshot } from '../undo-turn/snapshot.js';
import type { Snapshot } from '../undo-turn/types.js';
import { runGitCommand, setGitCommandRunnerForTesting, type GitCommandOptions, type GitCommandRunner } from './runner.js';
import type { GitRunResult, GitRunner } from './retry.js';

const PARENT_OID = 'a'.repeat(40);
const TREE_OID = 'b'.repeat(40);
const COMMIT_OID = 'c'.repeat(40);

type Fixture = { repo: string; dispose: () => void };
type ObservedCall = { cwd: string; args: string[]; options: GitCommandOptions };

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function gitResult(cwd: string, args: string[], options: GitCommandOptions): GitRunResult {
  const result = spawnSync('git', args, { ...options, cwd });
  return {
    status: result.status,
    stdout: result.stdout == null ? '' : result.stdout.toString(),
    stderr: result.stderr == null ? '' : result.stderr.toString(),
  };
}

function makeRepository(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'elanous-git-runner-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Elanous Test']);
  git(repo, ['config', 'user.email', 'test@elanous.local']);
  writeFileSync(join(repo, 'tracked.txt'), 'initial\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'initial']);
  return { repo, dispose: () => rmSync(repo, { recursive: true, force: true }) };
}

function snapshotResult(args: string[]): GitRunResult {
  switch (args[0]) {
    case 'rev-parse': return { status: 0, stdout: `${PARENT_OID}\n`, stderr: 'rev-parse diagnostic' };
    case 'ls-files': return { status: 0, stdout: 'kept-untracked.txt\0', stderr: 'ls-files diagnostic' };
    case 'read-tree': return { status: 0, stdout: 'read-tree output', stderr: 'read-tree diagnostic' };
    case 'add': return { status: 0, stdout: 'add output', stderr: 'add diagnostic' };
    case 'write-tree': return { status: 0, stdout: `${TREE_OID}\n`, stderr: 'write-tree diagnostic' };
    case 'commit-tree': return { status: 0, stdout: `${COMMIT_OID}\n`, stderr: 'commit-tree diagnostic' };
    default: throw new Error(`unexpected git command: ${args.join(' ')}`);
  }
}

function snapshot(repo: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snapshot',
    sha: COMMIT_OID,
    parentSha: PARENT_OID,
    repoRoot: repo,
    gitDir: join(repo, '.git'),
    untrackedFiles: [],
    capturedAt: 0,
    ...overrides,
  };
}

function observe(runner: GitCommandRunner): { calls: ObservedCall[]; runner: GitCommandRunner } {
  const calls: ObservedCall[] = [];
  return {
    calls,
    runner: (cwd, args, options) => {
      calls.push({ cwd, args: [...args], options });
      return runner(cwd, args, options);
    },
  };
}

function withRunner<T>(runner: GitCommandRunner, run: () => T): T {
  setGitCommandRunnerForTesting(runner);
  try {
    return run();
  } finally {
    setGitCommandRunnerForTesting(undefined);
  }
}

describe('runGitCommand', () => {
  test('preserves a real Git failure status and stderr instead of turning it into empty output', () => {
    const result = runGitCommand(process.cwd(), ['definitely-not-a-git-subcommand']);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  }, 10_000);

  test('preserves non-empty stdout from the default spawnSync runner byte-for-byte', () => {
    const fixture = makeRepository();
    try {
      const expectedStdout = git(fixture.repo, ['rev-parse', '--show-toplevel']);
      const result = runGitCommand(fixture.repo, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
      expect(result).toEqual({ status: 0, stdout: expectedStdout, stderr: '' });
      expect(result).not.toHaveProperty('signal');
    } finally {
      fixture.dispose();
    }
  }, 10_000);

  test('retries an injected index.lock failure through the shared retry loop', () => {
    let calls = 0;
    const lockedRunner: GitRunner = () => {
      calls += 1;
      return { status: 1, stdout: 'partial output', stderr: 'fatal: Unable to create .git/index.lock: File exists.' };
    };
    const result = runGitCommand(process.cwd(), ['status'], {}, lockedRunner);
    expect(calls).toBeGreaterThan(1);
    expect(result).toEqual({ status: 1, stdout: 'partial output', stderr: 'fatal: Unable to create .git/index.lock: File exists.' });
  }, 10_000);

  test('retries a real temporary-index lock during snapshot staging and then captures', () => {
    const fixture = makeRepository();
    let addAttempts = 0;
    try {
      setGitCommandRunnerForTesting((cwd, args, options) => {
        if (args[0] === 'add' && addAttempts++ === 0) {
          const indexPath = options.env?.GIT_INDEX_FILE;
          expect(indexPath).toBeString();
          writeFileSync(`${indexPath}.lock`, 'real lock');
          const locked = gitResult(cwd, args, options);
          rmSync(`${indexPath}.lock`, { force: true });
          expect(locked.status).not.toBe(0);
          expect(locked.stderr).toContain('index.lock');
          return locked;
        }
        return gitResult(cwd, args, options);
      });

      const captured = captureSnapshot(fixture.repo, { description: 'real lock retry' });

      expect(addAttempts).toBe(2);
      expect(captured).toMatchObject({ repoRoot: fixture.repo });
      expect(captured?.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      setGitCommandRunnerForTesting(undefined);
      fixture.dispose();
    }
  }, 20_000);

  test('snapshot consumes distinct command outputs and preserves all six argv, cwd, env, timeout, and stdio option objects exactly', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => snapshotResult(args));
    try {
      writeFileSync(join(fixture.repo, 'kept-untracked.txt'), 'kept\n');
      const captured = withRunner(observed.runner, () => captureSnapshot(fixture.repo, { description: 'runner behavior' }));

      expect(captured).toMatchObject({
        sha: COMMIT_OID,
        parentSha: PARENT_OID,
        repoRoot: fixture.repo,
        untrackedFiles: ['kept-untracked.txt'],
        description: 'runner behavior',
      });
      expect(observed.calls.map(({ args }) => args)).toEqual([
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '-o', '--exclude-standard', '-z'],
        ['read-tree', PARENT_OID],
        ['add', '--all', '--', '.'],
        ['write-tree'],
        ['commit-tree', TREE_OID, '-p', PARENT_OID, '-m', 'elanous snapshot — runner behavior'],
      ]);
      expect(observed.calls.map(({ cwd }) => cwd)).toEqual(Array(6).fill(fixture.repo));

      const temporaryIndex = observed.calls[2].options.env?.GIT_INDEX_FILE;
      expect(temporaryIndex).toBeString();
      const indexEnv = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      expect(observed.calls.map(({ options }) => options)).toEqual([
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
        { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        { env: indexEnv, stdio: 'pipe' },
        { env: indexEnv, encoding: 'utf8', timeout: 60_000 },
        { env: indexEnv, encoding: 'utf8', timeout: 30_000 },
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Elanous Snapshot',
            GIT_AUTHOR_EMAIL: 'snapshot@elanous.local',
            GIT_COMMITTER_NAME: 'Elanous Snapshot',
            GIT_COMMITTER_EMAIL: 'snapshot@elanous.local',
          },
        },
      ]);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('snapshot treats a failed rev-parse as no parent, consumes ls-files/write-tree/commit-tree stdout, and skips read-tree', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => {
      if (args[0] === 'rev-parse') return { status: 12, stdout: PARENT_OID, stderr: 'HEAD unavailable' };
      return snapshotResult(args);
    });
    try {
      writeFileSync(join(fixture.repo, 'kept-untracked.txt'), 'kept\n');
      const captured = withRunner(observed.runner, () => captureSnapshot(fixture.repo));
      expect(captured).toMatchObject({
        sha: COMMIT_OID,
        parentSha: null,
        untrackedFiles: ['kept-untracked.txt'],
      });
      expect(observed.calls.map(({ args }) => args)).toEqual([
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '-o', '--exclude-standard', '-z'],
        ['add', '--all', '--', '.'],
        ['write-tree'],
        ['commit-tree', TREE_OID, '-m', 'elanous snapshot'],
      ]);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('snapshot treats failed ls-files as an empty untracked set and continues the remaining commands', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => args[0] === 'ls-files'
      ? { status: 13, stdout: 'must-not-be-consumed.txt\0', stderr: 'enumeration failed' }
      : snapshotResult(args));
    try {
      const captured = withRunner(observed.runner, () => captureSnapshot(fixture.repo));
      expect(captured).toMatchObject({ sha: COMMIT_OID, parentSha: PARENT_OID, untrackedFiles: [] });
      expect(observed.calls.map(({ args }) => args)).toEqual([
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '-o', '--exclude-standard', '-z'],
        ['read-tree', PARENT_OID],
        ['add', '--all', '--', '.'],
        ['write-tree'],
        ['commit-tree', TREE_OID, '-p', PARENT_OID, '-m', 'elanous snapshot'],
      ]);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  for (const [failedCommand, expectedCommands] of [
    ['read-tree', ['rev-parse', 'ls-files', 'read-tree']],
    ['add', ['rev-parse', 'ls-files', 'read-tree', 'add']],
    ['write-tree', ['rev-parse', 'ls-files', 'read-tree', 'add', 'write-tree']],
    ['commit-tree', ['rev-parse', 'ls-files', 'read-tree', 'add', 'write-tree', 'commit-tree']],
  ] as const) {
    test(`snapshot returns null and stops after a nonzero ${failedCommand} result`, () => {
      const fixture = makeRepository();
      const observed = observe((_cwd, args) => args[0] === failedCommand
        ? { status: 23, stdout: `${failedCommand} partial stdout`, stderr: `${failedCommand} failed detail` }
        : snapshotResult(args));
      try {
        expect(withRunner(observed.runner, () => captureSnapshot(fixture.repo))).toBeNull();
        expect(observed.calls.map(({ args }) => args[0])).toEqual([...expectedCommands]);
      } finally {
        fixture.dispose();
      }
    }, 20_000);
  }

  test('restore consumes ls-files stdout and preserves all three argv, cwd, timeout, stdio, and output option objects exactly', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => {
      if (args[0] === 'cat-file') return { status: 0, stdout: 'object exists output', stderr: 'cat-file diagnostic' };
      if (args[0] === 'restore') return { status: 0, stdout: 'restore output', stderr: 'restore diagnostic' };
      if (args[0] === 'ls-files') return { status: 0, stdout: 'preserved.txt\0remove-me.txt\0', stderr: 'ls-files diagnostic' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    });
    try {
      writeFileSync(join(fixture.repo, 'preserved.txt'), 'preserved\n');
      writeFileSync(join(fixture.repo, 'remove-me.txt'), 'remove\n');
      const result = withRunner(observed.runner, () => restoreSnapshot(snapshot(fixture.repo, { untrackedFiles: ['preserved.txt'] })));

      expect(result).toEqual({
        ok: true,
        untrackedRemoved: 1,
        summary: `restored ${COMMIT_OID.slice(0, 7)} (cleared 1 new untracked file)`,
      });
      expect(existsSync(join(fixture.repo, 'preserved.txt'))).toBe(true);
      expect(existsSync(join(fixture.repo, 'remove-me.txt'))).toBe(false);
      expect(observed.calls).toEqual([
        {
          cwd: fixture.repo,
          args: ['cat-file', '-e', COMMIT_OID],
          options: { stdio: 'pipe', timeout: 5_000 },
        },
        {
          cwd: fixture.repo,
          args: ['restore', '--source', COMMIT_OID, '--worktree', '--', '.'],
          options: { encoding: 'utf8', timeout: 60_000 },
        },
        {
          cwd: fixture.repo,
          args: ['ls-files', '-o', '--exclude-standard', '-z'],
          options: { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        },
      ]);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('restore returns snapshot-missing and stops after a failed cat-file status', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => args[0] === 'cat-file'
      ? { status: 31, stdout: 'cat-file partial stdout', stderr: 'cat-file failed detail' }
      : { status: 0, stdout: '', stderr: '' });
    try {
      expect(withRunner(observed.runner, () => restoreSnapshot(snapshot(fixture.repo)))).toEqual({
        ok: false,
        untrackedRemoved: 0,
        summary: 'snapshot missing',
        error: `snapshot commit ${COMMIT_OID.slice(0, 7)} no longer exists — it may have been gc'd. Run /undo list to see what's still available.`,
      });
      expect(observed.calls.map(({ args }) => args[0])).toEqual(['cat-file']);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('restore preserves a failed restore status and stderr as its observable error and stops before ls-files', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => args[0] === 'restore'
      ? { status: 17, stdout: 'partial restore output', stderr: 'restore failed detail' }
      : { status: 0, stdout: '', stderr: '' });
    try {
      expect(withRunner(observed.runner, () => restoreSnapshot(snapshot(fixture.repo)))).toEqual({
        ok: false,
        untrackedRemoved: 0,
        summary: 'git restore failed',
        error: 'restore failed detail',
      });
      expect(observed.calls.map(({ args }) => args[0])).toEqual(['cat-file', 'restore']);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('restore treats failed ls-files as an empty set and leaves untracked files untouched', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => args[0] === 'ls-files'
      ? { status: 41, stdout: 'remove-me.txt\0', stderr: 'ls-files failed detail' }
      : { status: 0, stdout: `${args[0]} output`, stderr: `${args[0]} diagnostic` });
    try {
      writeFileSync(join(fixture.repo, 'remove-me.txt'), 'keep after enumeration failure\n');
      expect(withRunner(observed.runner, () => restoreSnapshot(snapshot(fixture.repo)))).toEqual({
        ok: true,
        untrackedRemoved: 0,
        summary: `restored ${COMMIT_OID.slice(0, 7)}`,
      });
      expect(existsSync(join(fixture.repo, 'remove-me.txt'))).toBe(true);
      expect(observed.calls.map(({ args }) => args[0])).toEqual(['cat-file', 'restore', 'ls-files']);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('captures and restores a temporary Git repository without changing its real index', () => {
    const fixture = makeRepository();
    try {
      const beforeIndex = readFileSync(join(fixture.repo, '.git', 'index'));
      writeFileSync(join(fixture.repo, 'tracked.txt'), 'snapshot state\n');
      writeFileSync(join(fixture.repo, 'untracked-before.txt'), 'preserved\n');
      const captured = captureSnapshot(fixture.repo, { description: 'runner behavior' });
      expect(captured).not.toBeNull();
      expect(readFileSync(join(fixture.repo, '.git', 'index'))).toEqual(beforeIndex);
      writeFileSync(join(fixture.repo, 'tracked.txt'), 'later state\n');
      writeFileSync(join(fixture.repo, 'untracked-after.txt'), 'removed\n');
      expect(restoreSnapshot(captured!)).toMatchObject({ ok: true, untrackedRemoved: 1 });
      expect(readFileSync(join(fixture.repo, 'tracked.txt'), 'utf8')).toBe('snapshot state\n');
      expect(readFileSync(join(fixture.repo, 'untracked-before.txt'), 'utf8')).toBe('preserved\n');
    } finally {
      fixture.dispose();
    }
  }, 20_000);
});
