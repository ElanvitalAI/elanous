import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setGitCommandRunnerForTesting, type GitCommandOptions } from '../src/git-fs/runner.js';
import { worktreeParentDir } from '../src/git-fs/worktree.js';
import {
  addHarnessWorktree,
  recordHarnessWorktreeGoalMetadata,
  recordHarnessWorktreeProvenance,
  renderHarnessWorktreeAdd,
} from '../src/harness/harness-worktree-add.js';
import { defaultSeams } from '../src/self-implement/seams.js';

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function worktreeConfigValues(repo: string, key: string): string[] {
  const result = spawnSync('git', ['config', '--worktree', '--null', '--get-all', key], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git config --get-all ${key} failed: ${result.stderr}`);
  if (!result.stdout.endsWith('\0')) throw new Error(`git config --get-all ${key} did not emit a NUL terminator`);
  return result.stdout.slice(0, -1).split('\0');
}

describe('harness worktree add', () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-worktree-add-'));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ tools: { selfImplement: { worktreeRoot: join(root, 'worktrees') } } }));
    repo = join(root, `repo-${basename(root)}`);
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'initial\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('creates through the gateway and records default provenance when no owner is supplied', () => {
    const result = addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: 'feature/fresh' });
    expect(result.path).toMatch(/^\//);
    expect(result.branch).toBe('feature/fresh');
    expect(result.resolvedBase).toMatch(/^[0-9a-f]{40}$/);
    expect(result.baseFreshness).toBe('head');
    expect(result.owner).toBe('harness:unattributed');
    expect(result.command).toBe('harness worktree add');
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(renderHarnessWorktreeAdd(result).join('\n')).toContain(`path: ${result.path}`);
    expect(renderHarnessWorktreeAdd(result).join('\n')).toContain(`owner: ${result.owner}`);
    expect(renderHarnessWorktreeAdd(result).join('\n')).toContain(`baseFreshness: ${result.baseFreshness}`);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.owner'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('harness:unattributed');
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: result.path, encoding: 'utf8' }).stdout).toBe('');
  });

  test('판정 신호: all four goal values are stored beside unchanged strict provenance', () => {
    const result = addHarnessWorktree({
      repoRoot: repo,
      worktreeRoot: join(root, 'worktrees'),
      branch: 'feature/goal-all',
      goalId: 'goal-42',
      goalFile: 'docs/goals/goal-42.md',
      goalTitle: 'Record worktree purpose',
      goalDescription: 'Store durable worktree purpose metadata.',
      goalDescriptionSource: 'generated',
    });
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.owner'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('harness:unattributed');
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalId'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('goal-42');
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalFile'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('docs/goals/goal-42.md');
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalTitle'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('Record worktree purpose');
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalDescription'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('Store durable worktree purpose metadata.');
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalDescriptionSource'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('generated');
  });

  test('판정 신호: absent, blank, and partial goal metadata omit only their own keys', () => {
    const none = addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: 'feature/goal-none' });
    for (const key of ['elanous.harness.goalId', 'elanous.harness.goalFile', 'elanous.harness.goalTitle', 'elanous.harness.goalDescription']) {
      expect(spawnSync('git', ['config', '--worktree', '--get', key], { cwd: none.path }).status).not.toBe(0);
    }
    const partial = addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: 'feature/goal-partial', goalFile: 'docs/goal.md', goalTitle: '  ' });
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalFile'], { cwd: partial.path, encoding: 'utf8' }).stdout.trim()).toBe('docs/goal.md');
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalId'], { cwd: partial.path }).status).not.toBe(0);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalTitle'], { cwd: partial.path }).status).not.toBe(0);
  });

  test('stores owner in worktree Git metadata without dirtying the worktree', () => {
    const result = addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: 'feature/owned', owner: 'session-42' });
    expect(result.owner).toBe('session-42');
    expect(result.command).toBe('harness worktree add');
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.owner'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('session-42');
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.command'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe('harness worktree add');
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.createdAt'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe(result.createdAt!);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: result.path, encoding: 'utf8' }).stdout).toBe('');
    expect(renderHarnessWorktreeAdd(result).join('\n')).toContain('owner: session-42');
    expect(renderHarnessWorktreeAdd(result).join('\n')).toContain('command: harness worktree add');
    expect(renderHarnessWorktreeAdd(result).join('\n')).toContain(`createdAt: ${result.createdAt}`);
  });

  test.each([
    ['command', 'elanous.harness.command'],
    ['createdAt', 'elanous.harness.createdAt'],
    ['owner', 'elanous.harness.owner'],
  ])('provenance write failure at %s restores pre-existing provenance exactly', (_stage, failedKey) => {
    const result = addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: `feature/partial-${_stage}` });
    const existing = {
      'elanous.harness.owner': 'dev:previous-run',
      'elanous.harness.command': 'elanous dev previous',
      'elanous.harness.createdAt': '2026-08-04T00:00:00.000Z',
    };
    for (const [key, value] of Object.entries(existing)) git(result.path, 'config', '--worktree', key, value);
    const hookDir = join(root, `git-wrapper-${_stage}`);
    mkdirSync(hookDir);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(hookDir, 'git'), `#!/bin/sh\nif [ "$1" = "config" ] && [ "$2" = "--worktree" ] && [ "$3" = "--replace-all" ] && [ "$4" = ${JSON.stringify(failedKey)} ]; then echo provenance-${_stage}-failed >&2; exit 41; fi\nexec "${realGit}" "$@"\n`);
    spawnSync('chmod', ['+x', join(hookDir, 'git')]);
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const script = `import { recordHarnessWorktreeProvenance } from ${JSON.stringify(join(projectRoot, 'src/harness/harness-worktree-add.ts'))}; recordHarnessWorktreeProvenance(${JSON.stringify(result.path)}, { owner: 'dev:partial', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' });`;
    const failed = spawnSync('bun', ['-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${hookDir}:${process.env.PATH}` },
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr + failed.stdout).toContain(`provenance-${_stage}-failed`);
    for (const [key, value] of Object.entries(existing)) {
      expect(spawnSync('git', ['config', '--worktree', '--get', key], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).toBe(value);
    }
  });

  test('판정 신호: goal context records a leading H1 goal title instead of structural H2 headings', async () => {
    const goalFile = join(root, 'leading-h1-goal.md');
    writeFileSync(goalFile, [
      '# Record human-readable worktree purpose',
      '',
      '## 실행 기록',
      '## PROBLEM',
      '## ACCEPTANCE CRITERIA',
    ].join('\n'));
    const seams = defaultSeams({ summarizeGoal: async () => 'A durable description.' });
    await expect(seams.synthesizeGoalContext!({ goalFile })).resolves.toEqual({
      goalTitle: 'Record human-readable worktree purpose',
      goalDescription: 'A durable description.',
      goalDescriptionSource: 'generated',
    });
  });

  test('판정 신호: seven-or-more hashes are readable body text and stop title selection', async () => {
    const goalFile = join(root, 'seven-hash-body-goal.md');
    writeFileSync(goalFile, [
      '## 실행 기록',
      '####### This is readable body text',
      '# A later heading must not become the title',
    ].join('\n'));
    const seams = defaultSeams({ summarizeGoal: async () => 'This must not run.' });

    await expect(seams.synthesizeGoalContext!({ goalFile })).resolves.toEqual({});
  });

  test('판정 신호: all skipped headings omit title metadata and never use RootIntent', async () => {
    const goalFile = join(root, 'all-structural-headings-goal.md');
    const rootIntent = '대상 경로: src/self-implement/seams.ts';
    writeFileSync(goalFile, [
      `- RootIntent: ${rootIntent}`,
      '## 실행 기록',
      '## PROBLEM',
      '## WHAT TO BUILD',
      '## 판정 신호',
    ].join('\n'));
    const seams = defaultSeams({ summarizeGoal: async () => 'This must not run.' });
    await expect(seams.synthesizeGoalContext!({ goalFile })).resolves.toEqual({});

    const result = addHarnessWorktree({
      repoRoot: repo,
      worktreeRoot: join(root, 'worktrees'),
      branch: 'feature/no-goal-title',
      goalId: 'goal-no-title',
      goalFile,
    });
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalTitle'], { cwd: result.path }).status).not.toBe(0);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalTitle'], { cwd: result.path, encoding: 'utf8' }).stdout.trim()).not.toBe(rootIntent);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalDescription'], { cwd: result.path }).status).not.toBe(0);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.goalDescriptionSource'], { cwd: result.path }).status).not.toBe(0);
  });

  test('판정 신호: goal synthesis truncates generated output at 250 characters and falls back to title on empty or thrown model output', async () => {
    const goalFile = join(root, 'goal.md');
    writeFileSync(goalFile, '# Durable worktree purpose\n\nDescribe worktree metadata.\n');
    const long = defaultSeams({ summarizeGoal: async () => 'x'.repeat(300) });
    await expect(long.synthesizeGoalContext!({ goalFile })).resolves.toEqual({
      goalTitle: 'Durable worktree purpose',
      goalDescription: 'x'.repeat(250),
      goalDescriptionSource: 'generated',
    });
    const empty = defaultSeams({ summarizeGoal: async () => '   ' });
    await expect(empty.synthesizeGoalContext!({ goalFile })).resolves.toEqual({
      goalTitle: 'Durable worktree purpose',
      goalDescription: 'Durable worktree purpose',
      goalDescriptionSource: 'title-fallback',
    });
    const thrown = defaultSeams({ summarizeGoal: async () => { throw new Error('model unavailable'); } });
    await expect(thrown.synthesizeGoalContext!({ goalFile })).resolves.toEqual({
      goalTitle: 'Durable worktree purpose',
      goalDescription: 'Durable worktree purpose',
      goalDescriptionSource: 'title-fallback',
    });
    const longTitle = 't'.repeat(300);
    const longTitleGoalFile = join(root, 'long-title-goal.md');
    writeFileSync(longTitleGoalFile, `# ${longTitle}\n`);
    await expect(empty.synthesizeGoalContext!({ goalFile: longTitleGoalFile })).resolves.toEqual({
      goalTitle: longTitle,
      goalDescription: 't'.repeat(250),
      goalDescriptionSource: 'title-fallback',
    });
    let aborted = false;
    const timedOut = defaultSeams({
      goalSummaryTimeoutMs: 5,
      summarizeGoal: async (_prompt, _model, signal) => new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve('late summary'); }, { once: true });
      }),
    });
    await expect(timedOut.synthesizeGoalContext!({ goalFile })).resolves.toEqual({
      goalTitle: 'Durable worktree purpose',
      goalDescription: 'Durable worktree purpose',
      goalDescriptionSource: 'title-fallback',
    });
    expect(aborted).toBe(true);
  });

  test('판정 신호: optional goal metadata writer failure preserves the created worktree', async () => {
    const seams = defaultSeams({
      repoRoot: repo,
      recordWorktreeGoalMetadata: () => { throw new Error('goal-metadata-failed'); },
    });
    const created = await seams.createWorktree({
      branch: 'feature/goal-writer-failure',
      runId: 'run-goal-writer-failure',
      goalId: 'goal-1',
      goalFile: 'goal.md',
      goalTitle: 'Goal',
      goalDescription: 'Description',
      goalDescriptionSource: 'generated',
    });
    expect(existsSync(created.path)).toBe(true);
    expect(created.owner).toBe('dev:run-goal-writer-failure');
  });

  test('provenance write failure restores empty and multiline values byte-for-byte in order', () => {
    const result = addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: 'feature/lossless-rollback' });
    const existing: Record<string, string[]> = {
      'elanous.harness.command': ['', 'elanous dev\n--resume run-previous'],
      'elanous.harness.createdAt': ['2026-08-04T00:00:00.000Z', ''],
      'elanous.harness.owner': ['dev:previous\nrun', ''],
    };
    for (const [key, values] of Object.entries(existing)) {
      git(result.path, 'config', '--worktree', '--unset-all', key);
      for (const value of values) git(result.path, 'config', '--worktree', '--add', key, value);
    }
    const hookDir = join(root, 'git-wrapper-lossless-rollback');
    mkdirSync(hookDir);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(hookDir, 'git'), `#!/bin/sh\nif [ "$1" = "config" ] && [ "$2" = "--worktree" ] && [ "$3" = "--replace-all" ] && [ "$4" = "elanous.harness.createdAt" ]; then echo created-at-write-failed >&2; exit 41; fi\nexec "${realGit}" "$@"\n`);
    spawnSync('chmod', ['+x', join(hookDir, 'git')]);
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const script = `import { recordHarnessWorktreeProvenance } from ${JSON.stringify(join(projectRoot, 'src/harness/harness-worktree-add.ts'))}; recordHarnessWorktreeProvenance(${JSON.stringify(result.path)}, { owner: 'dev:partial', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' });`;
    const failed = spawnSync('bun', ['-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${hookDir}:${process.env.PATH}` },
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr + failed.stdout).toContain('created-at-write-failed');
    for (const [key, values] of Object.entries(existing)) {
      expect(worktreeConfigValues(result.path, key)).toEqual(values);
    }
  });

  test('provenance rollback failure is surfaced rather than reported as an unrecorded worktree', () => {
    const result = addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: 'feature/rollback-failure' });
    const hookDir = join(root, 'git-wrapper-rollback-failure');
    mkdirSync(hookDir);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(hookDir, 'git'), `#!/bin/sh\nif [ "$1" = "config" ] && [ "$2" = "--worktree" ] && [ "$3" = "--replace-all" ] && [ "$4" = "elanous.harness.owner" ]; then echo owner-write-failed >&2; exit 41; fi\nif [ "$1" = "config" ] && [ "$2" = "--worktree" ] && [ "$3" = "--unset-all" ]; then echo rollback-clear-failed >&2; exit 42; fi\nexec "${realGit}" "$@"\n`);
    spawnSync('chmod', ['+x', join(hookDir, 'git')]);
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const script = `import { recordHarnessWorktreeProvenance } from ${JSON.stringify(join(projectRoot, 'src/harness/harness-worktree-add.ts'))}; recordHarnessWorktreeProvenance(${JSON.stringify(result.path)}, { owner: 'dev:partial', command: 'elanous dev', createdAt: '2026-08-05T00:00:00.000Z' });`;
    const failed = spawnSync('bun', ['-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${hookDir}:${process.env.PATH}` },
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr + failed.stdout).toContain('owner-write-failed');
    expect(failed.stderr + failed.stdout).toContain('rollback-clear-failed');
  });

  test('surfaces the holder path when the requested branch is already checked out', () => {
    git(repo, 'branch', 'feature/held');
    const holder = join(root, 'other-holder');
    git(repo, 'worktree', 'add', '-q', holder, 'feature/held');
    expect(() => addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: 'feature/held' })).toThrow(holder);
  });

  test('CLI emits structured creation data, persists owner metadata, and rejects a duplicate branch', () => {
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const cli = join(projectRoot, 'bin', 'elanous.mjs');
    const first = spawnSync('bun', [cli, '--test', '--config-dir', join(root, 'config'), 'harness', 'worktree', 'add', 'feature/cli', '--base', 'HEAD', '--owner', 'cli-session', '--json'], { cwd: repo, encoding: 'utf8' });
    expect(first.status).toBe(0);
    const created = JSON.parse(first.stdout) as { path: string; branch: string; resolvedBase: string; baseFreshness: string; owner: string; command: string; createdAt: string };
    expect(created.path).toMatch(/^\//);
    expect(created.branch).toBe('feature/cli');
    expect(created.resolvedBase).toMatch(/^[0-9a-f]{40}$/);
    expect(['head', 'remote-synced', 'remote-current', 'remote-unreachable']).toContain(created.baseFreshness);
    expect(created.owner).toBe('cli-session');
    expect(created.command).toBe('harness worktree add');
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.owner'], { cwd: created.path, encoding: 'utf8' }).stdout.trim()).toBe('cli-session');
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: created.path, encoding: 'utf8' }).stdout).toBe('');

    const duplicate = spawnSync('bun', [cli, '--test', '--config-dir', join(root, 'config'), 'harness', 'worktree', 'add', 'feature/cli'], { cwd: repo, encoding: 'utf8' });
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr + duplicate.stdout).toContain('already used by worktree');
    expect(duplicate.stderr + duplicate.stdout).toContain(created.path);
  });

  test('CLI prints non-JSON creation fields instead of succeeding silently', () => {
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const cli = join(projectRoot, 'bin', 'elanous.mjs');
    const result = spawnSync('bun', [cli, '--test', '--config-dir', join(root, 'config'), 'harness', 'worktree', 'add', 'feature/text'], { cwd: repo, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('path: ');
    expect(result.stdout).toContain('branch: feature/text');
    expect(result.stdout).toContain('resolvedBase: ');
    expect(result.stdout).toContain('baseFreshness: sha');
  });

  test('CLI resolves the main repository root while preserving caller HEAD for an omitted base', () => {
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const cli = join(projectRoot, 'bin', 'elanous.mjs');
    const nested = join(repo, 'nested', 'directory');
    mkdirSync(nested, { recursive: true });
    const fromNested = spawnSync('bun', [cli, '--test', '--config-dir', join(root, 'config'), 'harness', 'worktree', 'add', 'feature/nested', '--json'], { cwd: nested, encoding: 'utf8' });
    expect(fromNested.status).toBe(0);
    expect(JSON.parse(fromNested.stdout).path).toBe(join(worktreeParentDir(repo, join(root, 'worktrees')), 'feature-nested'));

    const mainHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const linked = join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/linked', linked);
    writeFileSync(join(linked, 'linked-only.txt'), 'linked commit\n');
    git(linked, 'add', '.');
    git(linked, 'commit', '-qm', 'linked commit');
    const linkedHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: linked, encoding: 'utf8' }).stdout.trim();
    expect(linkedHead).not.toBe(mainHead);

    const fromLinked = spawnSync('bun', [cli, '--test', '--config-dir', join(root, 'config'), 'harness', 'worktree', 'add', 'feature/from-linked', '--json'], { cwd: linked, encoding: 'utf8' });
    expect(fromLinked.status).toBe(0);
    const linkedCreated = JSON.parse(fromLinked.stdout) as { path: string; resolvedBase: string };
    expect(linkedCreated.path).toBe(join(worktreeParentDir(repo, join(root, 'worktrees')), 'feature-from-linked'));
    expect(linkedCreated.resolvedBase).toBe(linkedHead);
    expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: linkedCreated.path, encoding: 'utf8' }).stdout.trim()).toBe(linkedHead);

    const explicit = spawnSync('bun', [cli, '--test', '--config-dir', join(root, 'config'), 'harness', 'worktree', 'add', 'feature/explicit-main', '--base', mainHead, '--json'], { cwd: linked, encoding: 'utf8' });
    expect(explicit.status).toBe(0);
    expect((JSON.parse(explicit.stdout) as { resolvedBase: string }).resolvedBase).toBe(mainHead);
  }, 15_000);

  test('owner declaration failure rolls back the new worktree and branch so retry succeeds', () => {
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const cli = join(projectRoot, 'bin', 'elanous.mjs');
    const hookDir = join(root, 'git-wrapper');
    mkdirSync(hookDir);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(hookDir, 'git'), `#!/bin/sh\nif [ "$1" = "config" ] && [ "$2" = "extensions.worktreeConfig" ]; then echo owner-config-failed >&2; exit 41; fi\nexec "${realGit}" "$@"\n`);
    spawnSync('chmod', ['+x', join(hookDir, 'git')]);
    const failed = spawnSync('bun', [cli, '--test', '--config-dir', join(root, 'config'), 'harness', 'worktree', 'add', 'feature/rollback', '--owner', 'session-fail'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${hookDir}:${process.env.PATH}` },
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr + failed.stdout).toContain('owner-config-failed');
    // ⛔⭐ 중간 폴더(repository scope)를 빠뜨리면 «항상 존재하지 않는 경로»를 검사하게 되어
    //    롤백이 안 돼도 통과한다 — 죽은 검사다(리뷰 6R must-fix ①).
    //    ⇒ 실제 생성 경로를 `worktreeParentDir` 로 «같은 규칙»으로 조립한다.
    const expectedPath = join(worktreeParentDir(repo, join(root, 'worktrees')), 'feature-rollback');
    expect(existsSync(expectedPath)).toBe(false);
    expect(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/feature/rollback'], { cwd: repo }).status).not.toBe(0);
    expect(addHarnessWorktree({ repoRoot: repo, worktreeRoot: join(root, 'worktrees'), branch: 'feature/rollback', owner: 'retry-session' }).owner).toBe('retry-session');
  });
});

describe('harness worktree add git command seam', () => {
  afterEach(() => setGitCommandRunnerForTesting(undefined));

  test('seam: injected runner records config writes without a real git process', () => {
    const calls: Array<{ cwd: string; args: string[]; options: GitCommandOptions }> = [];
    setGitCommandRunnerForTesting((cwd, args, options) => {
      calls.push({ cwd, args: [...args], options });
      return { status: 0, stdout: '', stderr: '' };
    });

    recordHarnessWorktreeGoalMetadata('/injected/worktree', {
      goalId: 'goal-42',
      goalFile: 'docs/goal.md',
    });

    expect(calls).toEqual([
      {
        cwd: '/injected/worktree',
        args: ['config', '--worktree', '--replace-all', 'elanous.harness.goalId', 'goal-42'],
        options: { encoding: 'utf8' },
      },
      {
        cwd: '/injected/worktree',
        args: ['config', '--worktree', '--replace-all', 'elanous.harness.goalFile', 'docs/goal.md'],
        options: { encoding: 'utf8' },
      },
    ]);
  });

  test('seam: failed config write keeps the pre-change error surface', () => {
    setGitCommandRunnerForTesting(() => ({
      status: 41,
      stdout: '',
      stderr: 'config-write-failed',
    }));

    expect(() => recordHarnessWorktreeGoalMetadata('/injected/worktree', { goalId: 'goal-42' }))
      .toThrow('harness worktree goal metadata declaration failed — config-write-failed');

    setGitCommandRunnerForTesting(() => ({ status: 7, stdout: '', stderr: '' }));
    expect(() => recordHarnessWorktreeGoalMetadata('/injected/worktree', { goalId: 'goal-42' }))
      .toThrow('harness worktree goal metadata declaration failed — git exited 7');
  });

  test('seam: provenance writes keep command order and worktree cwd', () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    setGitCommandRunnerForTesting((cwd, args) => {
      calls.push({ cwd, args: [...args] });
      if (args[0] === 'config' && args.includes('--get-all')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    recordHarnessWorktreeProvenance('/injected/worktree', {
      owner: 'session-42',
      command: 'harness worktree add',
      createdAt: '2026-08-05T00:00:00.000Z',
    });

    expect(calls.map((call) => call.cwd)).toEqual(Array(7).fill('/injected/worktree'));
    expect(calls.map((call) => call.args)).toEqual([
      ['config', 'extensions.worktreeConfig', 'true'],
      ['config', '--worktree', '--null', '--get-all', 'elanous.harness.command'],
      ['config', '--worktree', '--null', '--get-all', 'elanous.harness.createdAt'],
      ['config', '--worktree', '--null', '--get-all', 'elanous.harness.owner'],
      ['config', '--worktree', '--replace-all', 'elanous.harness.command', 'harness worktree add'],
      ['config', '--worktree', '--replace-all', 'elanous.harness.createdAt', '2026-08-05T00:00:00.000Z'],
      ['config', '--worktree', '--replace-all', 'elanous.harness.owner', 'session-42'],
    ]);
  });
});
