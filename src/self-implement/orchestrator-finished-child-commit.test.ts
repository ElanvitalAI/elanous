import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSelfImplement, type SelfImplementSeams } from './orchestrator.js';
import { seams } from './test-seams.js';

describe('finished child uncommitted work recovery', () => {
  const feature = 'Implement src/self-implement/example.ts without touching unrelated paths';

  async function run(over: Partial<SelfImplementSeams>, goal = feature, completion: 'worktree-only' | 'pr' = 'worktree-only') {
    return runSelfImplement({
      feature: goal, completion, memory: false,
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({
        changedFilesForGateRoute: () => [],
        reviewScopeDiff: async () => '',
        ...over,
      }),
    });
  }

  test('commits child-created untracked target in a real Git worktree without committing outside paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finished-child-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'child');
    const git = (cwd: string, ...args: string[]): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    try {
      mkdirSync(repo);
      git(repo, 'init', '-q');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git(repo, 'add', 'README.md');
      git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base');
      const base = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'worktree', 'add', '-qb', 'finished-child', worktree);
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const openedAt: Array<{ head: string; diff: string }> = [];
      const result = await run({
        createWorktree: async () => ({ path: worktree, branch: 'finished-child', base, resolvedBase: base, invokedHead: base }),
        implement: async () => {
          mkdirSync(join(worktree, 'src/self-implement'), { recursive: true });
          writeFileSync(join(worktree, 'src/self-implement/example.ts'), 'export const child = true;\n');
          mkdirSync(join(worktree, 'src'), { recursive: true });
          writeFileSync(join(worktree, 'src/other.ts'), 'export const outside = true;\n');
          git(worktree, 'add', 'src/other.ts');
          return { ok: true, summary: 'finished', completionDisposition: 'completed-without-changes' };
        },
        writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
        openPr: async ({ cwd }) => {
          openedAt.push({ head: git(cwd, 'rev-parse', 'HEAD'), diff: git(cwd, 'diff', '--name-only', base, 'HEAD') });
          return { url: 'https://pr/finished-child', number: 7 };
        },
      }, feature, 'pr');
      expect(result.stage).toBe('pr-opened');
      expect(result.prNumber).toBe(7);
      expect(result.completionDisposition).toBeUndefined();
      expect(openedAt).toEqual([{ head: git(worktree, 'rev-parse', 'HEAD'), diff: 'src/self-implement/example.ts' }]);
      expect(events.find(({ event }) => event === 'finished-child-commit')?.data).toMatchObject({ status: 'committed', paths: ['src/self-implement/example.ts'] });
      expect(events.find(({ event }) => event === 'implemented')?.data.completionDisposition).toBeUndefined();
      expect(git(worktree, 'show', 'HEAD:src/self-implement/example.ts')).toBe('export const child = true;');
      expect(git(worktree, 'show', '--format=', '--name-only', 'HEAD').split('\n')).toEqual(['src/self-implement/example.ts']);
      expect(git(worktree, 'status', '--porcelain')).toContain('A  src/other.ts');
      expect(git(worktree, 'show', '-s', '--format=%an <%ae> / %cn <%ce> / %s', 'HEAD'))
        .toMatch(/^elanous child .+ <child\+.+@elanous\.local> \/ elanous child .+ <child\+.+@elanous\.local> \/ self-implement: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores a target path quoted only as excluded boundary', async () => {
    let committed = false;
    await run({
      detectUncommittedWork: () => ({ status: 'changes', trackedChanges: ['src/self-implement/example.ts'], untrackedFiles: [] }),
      commitFinishedChildWork: () => { committed = true; return { ok: true, out: '' }; },
    }, '## SCOPE BOUNDARY\nsrc/self-implement/example.ts\n');
    expect(committed).toBe(false);
  });

  test('does not commit unrelated changes or an unreadable status', async () => {
    for (const work of [
      { status: 'changes' as const, trackedChanges: ['src/other.ts'], untrackedFiles: [] },
      { status: 'unavailable' as const, reason: 'status unavailable' },
      { status: 'clean' as const, trackedChanges: [], untrackedFiles: [] },
    ]) {
      let committed = false;
      await run({
        detectUncommittedWork: () => work,
        commitFinishedChildWork: () => { committed = true; return { ok: true, out: '' }; },
      });
      expect(committed).toBe(false);
    }
  });

  test('clean and out-of-scope finished children retain their no-change disposition', async () => {
    for (const work of [
      { status: 'clean' as const, trackedChanges: [], untrackedFiles: [] },
      { status: 'changes' as const, trackedChanges: ['src/other.ts'], untrackedFiles: [] },
    ]) {
      const result = await run({
        implement: async () => ({ ok: true, summary: 'finished', completionDisposition: 'completed-without-changes' }),
        detectUncommittedWork: () => work,
      }, feature, 'pr');
      expect(result.completionDisposition).toBe('completed-without-changes');
    }
  });

  test('a failed commit blocks PR even if the branch already contains a commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finished-child-failed-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    try {
      git('init', '-q');
      writeFileSync(join(root, 'README.md'), 'base\n');
      git('add', 'README.md');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base');
      writeFileSync(join(root, 'previous.txt'), 'earlier child work\n');
      git('add', 'previous.txt');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'previous work');
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      let openPrCalls = 0;
      const result = await run({
        createWorktree: async () => ({ path: root, branch: 'existing-commit' }),
        implement: async () => {
          mkdirSync(join(root, 'src/self-implement'), { recursive: true });
          writeFileSync(join(root, 'src/self-implement/example.ts'), 'export const child = true;\n');
          return { ok: true, summary: 'finished', completionDisposition: 'completed-without-changes' };
        },
        commitFinishedChildWork: () => ({ ok: false, out: 'commit failed' }),
        openPr: async () => { openPrCalls++; return { url: 'https://pr/should-not-open', number: 8 }; },
        writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
      }, feature, 'pr');
      expect(events.find(({ event }) => event === 'finished-child-commit')?.data).toMatchObject({ status: 'commit-missing', reason: 'commit failed' });
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('abandoned');
      expect(result.stage).toBe('aborted');
      expect(result.completionDisposition).toBeUndefined();
      expect(result.prNumber).toBeUndefined();
      expect(openPrCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('an unreadable working tree blocks PR when the branch already carries commits (HARV1 review round 3)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finished-child-unreadable-'));
    spawnSync('git', ['init', '-q'], { cwd: root });
    let openPrCalls = 0;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run({
      createWorktree: async () => ({ path: root, branch: 'unreadable' }),
      implement: async () => ({ ok: true, summary: 'finished' }),
      detectUncommittedWork: () => ({ status: 'unavailable', reason: 'git status failed' }),
      changedFilesForGateRoute: () => ['src/self-implement/example.ts'],
      openPr: async () => { openPrCalls++; return { url: 'https://pr/should-not-open', number: 9 }; },
      writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
    }, feature, 'pr');
    expect(events.find(({ event }) => event === 'finished-child-commit')?.data).toMatchObject({ status: 'unavailable', blocked: true });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('aborted');
    expect(openPrCalls).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test('an unreadable working tree with no branch commits keeps the no-change path (no block)', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run({
      implement: async () => ({ ok: true, summary: 'finished' }),
      detectUncommittedWork: () => ({ status: 'unavailable', reason: 'git status failed' }),
      changedFilesForGateRoute: () => [],
      writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
    });
    expect(events.find(({ event }) => event === 'finished-child-commit')?.data).toMatchObject({ status: 'unavailable', blocked: false });
  });

  test('a target file the child only staged (never committed) is committed — MK GK2b case', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finished-child-staged-'));
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git(root, 'init', '-q');
      writeFileSync(join(root, 'README.md'), 'base\n');
      git(root, 'add', 'README.md');
      git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base');
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      await run({
        createWorktree: async () => ({ path: root, branch: 'staged-only' }),
        implement: async () => {
          mkdirSync(join(root, 'src/self-implement'), { recursive: true });
          writeFileSync(join(root, 'src/self-implement/example.ts'), 'export const staged = true;\n');
          git(root, 'add', 'src/self-implement/example.ts');
          return { ok: true, summary: 'finished' };
        },
        writeRunLedger: (entry) => { events.push({ event: entry.event, data: entry.data }); },
      });
      expect(events.find(({ event }) => event === 'finished-child-commit')?.data).toMatchObject({ status: 'committed', paths: ['src/self-implement/example.ts'] });
      expect(git(root, 'show', 'HEAD:src/self-implement/example.ts')).toBe('export const staged = true;');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
