import { setDefaultTimeout, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { snapshotWorktreeRoot, sweepNewEmptyWorktreeRoots } from './helpers/worktree-root-leak.js';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { configuredWorktreeRoot } from '../src/user-config.js';
import { prepareDevWorktree, renderPreparedDevWorktree } from '../src/harness/harness-worktree-auto.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

describe('dev auto-worktree', () => {
  let root: string;
  let repo: string;
  const createdWorktrees: string[] = [];
  const cleanupWarnings: string[] = [];
  const prepareTrackedDevWorktree: typeof prepareDevWorktree = (...args) => {
    const prepared = prepareDevWorktree(...args);
    createdWorktrees.push(prepared.worktree.path);
    return prepared;
  };
  const cleanupCreatedWorktrees = () => {
    const worktreeRoot = resolve(configuredWorktreeRoot());
    const createdParents = new Set(createdWorktrees.map(dirname));
    for (const path of createdWorktrees.splice(0)) {
      const removed = spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', path], { encoding: 'utf8' });
      if (removed.status !== 0) {
        const warning = `[harness-worktree-auto.test] worktree remove failed rc=${removed.status} ${path}: ${(removed.stderr ?? '').trim().slice(0, 120)}`;
        cleanupWarnings.push(warning);
        console.warn(warning);
      }
      rmSync(path, { recursive: true, force: true });
    }
    for (const createdParent of createdParents) {
      for (let parent = createdParent; parent !== worktreeRoot && parent.startsWith(`${worktreeRoot}/`); parent = dirname(parent)) {
        try {
          rmdirSync(parent);
        } catch (error) {
          const warning = `[harness-worktree-auto.test] worktree parent remove failed ${parent}: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
          cleanupWarnings.push(warning);
          console.warn(warning);
          break;
        }
      }
    }
  };

  // ⛔ 자식 프로세스가 만든 워크트리와 실패 롤백이 남긴 «인스턴스 뿌리»는 위 정리기가 못 잡는다
  //   (추적할 경로가 부모에게 없다). 그래서 「도는 동안 새로 났고 지금 비어 있는 것」을 따로 걷는다.
  let worktreeRootBefore: ReadonlySet<string> = new Set();
  beforeEach(() => {
    worktreeRootBefore = snapshotWorktreeRoot();
    createdWorktrees.length = 0;
    cleanupWarnings.length = 0;
    root = mkdtempSync(join(tmpdir(), 'dev-auto-worktree-'));
    repo = join(root, 'repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'initial\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial');
  });

  afterEach(() => {
    cleanupCreatedWorktrees();
    rmSync(root, { recursive: true, force: true });
    sweepNewEmptyWorktreeRoots(worktreeRootBefore);
  });

  test('cleanup removes empty worktree ancestors without removing the configured root', () => {
    const prepared = prepareTrackedDevWorktree(repo, 'cleanup-empty');
    const parent = dirname(prepared.worktree.path);
    const ownerRoot = dirname(parent);
    const worktreeRoot = resolve(configuredWorktreeRoot());

    cleanupCreatedWorktrees();

    expect(existsSync(parent)).toBe(false);
    expect(existsSync(ownerRoot)).toBe(false);
    expect(existsSync(worktreeRoot)).toBe(true);
    expect(cleanupWarnings).toEqual([]);
  });

  test('cleanup preserves a blocked worktree ancestor and warns with the failure value', () => {
    const prepared = prepareTrackedDevWorktree(repo, 'cleanup-preserved');
    const parent = dirname(prepared.worktree.path);
    const ownerRoot = dirname(parent);
    writeFileSync(join(ownerRoot, 'still-in-use'), 'preserve this ancestor\n');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      cleanupCreatedWorktrees();

      expect(existsSync(parent)).toBe(false);
      expect(existsSync(ownerRoot)).toBe(true);
      expect(cleanupWarnings).toEqual([expect.stringContaining(`worktree parent remove failed ${ownerRoot}`)]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`worktree parent remove failed ${ownerRoot}`));
    } finally {
      warn.mockRestore();
      rmSync(ownerRoot, { recursive: true, force: true });
    }
  });

  test('preserves a failed worktree removal value before force-removing the tracked path', () => {
    const prepared = prepareTrackedDevWorktree(repo, 'cleanup-remove-failure');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    rmSync(repo, { recursive: true, force: true });
    try {
      cleanupCreatedWorktrees();

      expect(existsSync(prepared.worktree.path)).toBe(false);
      expect(cleanupWarnings).toEqual([expect.stringContaining(`worktree remove failed rc=128 ${prepared.worktree.path}: fatal: cannot change to '${repo}'`)]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`worktree remove failed rc=128 ${prepared.worktree.path}: fatal: cannot change to '${repo}'`));
    } finally {
      warn.mockRestore();
    }
  });

  test('records supplied goal metadata and omits it without a goal while preserving dev provenance', () => {
    const goalFile = join(repo, 'goal.md');
    writeFileSync(goalFile, [
      '# Record the supplied goal title',
      '',
      '- GoalId: 0123456789abcdef',
      '',
      '## PROBLEM',
    ].join('\n'));
    const withGoal = prepareTrackedDevWorktree(repo, 'run-with-goal', 'dev', { id: '0123456789abcdef', file: goalFile });
    const withoutGoal = prepareTrackedDevWorktree(repo, 'run-without-goal');
    const config = (worktreePath: string, key: string) => spawnSync('git', ['config', '--worktree', '--get', key], { cwd: worktreePath, encoding: 'utf8' });

    expect(withGoal.environment).toMatchObject({ cwd: realpathSync(repo), repoRoot: repo, isPrimary: true, branch: 'main' });
    expect(withGoal.environment.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(withGoal.worktree).toMatchObject({ branch: 'dev/run-with-goal', owner: 'dev:run-with-goal', command: 'dev' });
    expect(withGoal.worktree.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(config(withGoal.worktree.path, 'elanous.harness.owner').stdout.trim()).toBe('dev:run-with-goal');
    expect(config(withGoal.worktree.path, 'elanous.harness.command').stdout.trim()).toBe('dev');
    expect(config(withGoal.worktree.path, 'elanous.harness.goalId').stdout.trim()).toBe('0123456789abcdef');
    expect(config(withGoal.worktree.path, 'elanous.harness.goalFile').stdout.trim()).toBe(goalFile);
    expect(config(withGoal.worktree.path, 'elanous.harness.goalTitle').stdout.trim()).toBe('Record the supplied goal title');
    for (const key of ['elanous.harness.goalId', 'elanous.harness.goalFile', 'elanous.harness.goalTitle']) {
      expect(config(withoutGoal.worktree.path, key).status).not.toBe(0);
    }
    expect(withoutGoal.worktree).toMatchObject({ branch: 'dev/run-without-goal', owner: 'dev:run-without-goal', command: 'dev' });
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: withGoal.worktree.path, encoding: 'utf8' }).stdout).toBe('');
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: withoutGoal.worktree.path, encoding: 'utf8' }).stdout).toBe('');
    expect(renderPreparedDevWorktree(withGoal).join('\n')).toContain(`worktree.path: ${withGoal.worktree.path}`);
    expect(renderPreparedDevWorktree(withGoal).join('\n')).toContain('current.kind: primary');
  });

  // ⛔⭐ detached HEAD 를 «거부하지 않는다» — 브랜치 이름은 «환경 보고»에만 쓰이고 워크트리는
  //    commit 을 base 로 만든다. 거부하면 지원 범위만 좁아진다(무인 리뷰 must-fix · 사람이 수리).
  //    ⇒ 이 회귀는 「거부로 되돌리면」 운다. 그것이 이 테스트의 존재 이유다.
  test('rejects a supplied goal file without an identifier instead of omitting its metadata', () => {
    const goalFile = join(repo, 'goal-without-id.md');
    writeFileSync(goalFile, '## A title without a GoalId\n');

    expect(() => prepareDevWorktree(repo, 'invalid-goal-run', 'dev', { id: '', file: goalFile }))
      .toThrow(`dev auto-worktree requires a goal identifier when a goal file is supplied — ${goalFile}`);
  });

  test('rejects a supplied goal document without an extractable title', () => {
    const goalFile = join(repo, 'goal-without-title.md');
    writeFileSync(goalFile, '- GoalId: 0123456789abcdef\n\nplain text only\n');

    expect(() => prepareDevWorktree(repo, 'untitled-goal-run', 'dev', { id: '0123456789abcdef', file: goalFile }))
      .toThrow(`dev auto-worktree requires a titled goal document — ${goalFile}`);
    expect(spawnSync('git', ['branch', '--list', 'dev/untitled-goal-run'], { cwd: repo, encoding: 'utf8' }).stdout.trim()).toBe('');
  });

  test('rolls back and rejects a supplied goal when goal metadata cannot be recorded', () => {
    const goalFile = join(repo, 'goal.md');
    writeFileSync(goalFile, '# Title\n\n- GoalId: 0123456789abcdef\n\n## PROBLEM\n');
    const bin = join(root, 'bin');
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    mkdirSync(bin);
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = config ] && [ "$4" = elanous.harness.goalId ]; then exit 1; fi\nexec ${realGit} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const moduleUrl = new URL('../src/harness/harness-worktree-auto.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['-e', `import { prepareDevWorktree } from ${JSON.stringify(moduleUrl)}; prepareDevWorktree(${JSON.stringify(repo)}, 'metadata-failure', 'dev', { id: '0123456789abcdef', file: ${JSON.stringify(goalFile)} });`], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('HarnessWorktreeGoalMetadataError');
    expect(child.stderr).toContain('harness worktree goal metadata declaration failed');
    expect(child.stderr).toContain('Error: harness worktree goal metadata declaration failed');
    expect(child.stderr).not.toContain('dev auto-worktree goal metadata recording failed');
    expect(spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout)
      .not.toContain('dev/metadata-failure');
    expect(spawnSync('git', ['branch', '--list', 'dev/metadata-failure'], { cwd: repo, encoding: 'utf8' }).stdout.trim()).toBe('');

    git(repo, 'branch', 'dev/branch-conflict');
    const holder = join(root, 'branch-conflict-holder');
    git(repo, 'worktree', 'add', '-q', holder, 'dev/branch-conflict');
    const conflictGoalFile = join(repo, 'goal-for-branch-conflict.md');
    writeFileSync(conflictGoalFile, '# Valid goal title\n\n- GoalId: 0123456789abcdef\n');
    expect(() => prepareDevWorktree(repo, 'branch-conflict', 'dev', { id: '0123456789abcdef', file: conflictGoalFile }))
      .toThrow(holder);
    try {
      prepareDevWorktree(repo, 'branch-conflict', 'dev', { id: '0123456789abcdef', file: conflictGoalFile });
      throw new Error('expected branch conflict');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('goal metadata');
    }
  });

  test('supports a detached HEAD and reports the missing branch as null instead of refusing', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    git(repo, 'checkout', '-q', '--detach', head);
    // ⭐ 전제를 먼저 못 박는다 — 실제로 detached 인지 확인하지 않으면 이 테스트가 «조용히» 무의미해진다.
    expect(spawnSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).stdout.trim()).toBe('');

    const prepared = prepareTrackedDevWorktree(repo, 'detached-run');

    expect(prepared.environment.branch).toBeNull();
    expect(prepared.environment.commit).toBe(head);
    expect(prepared.worktree).toMatchObject({ branch: 'dev/detached-run', owner: 'dev:detached-run' });
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: prepared.worktree.path, encoding: 'utf8' }).stdout).toBe('');
  });

  test('preserves the actual drive front-door command in worktree provenance', () => {
    const prepared = prepareTrackedDevWorktree(repo, 'drive-run-42', 'drive');

    expect(prepared.worktree).toMatchObject({ branch: 'dev/drive-run-42', owner: 'dev:drive-run-42', command: 'drive' });
    expect(spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.command'], { cwd: prepared.worktree.path, encoding: 'utf8' }).stdout.trim()).toBe('drive');
    expect(renderPreparedDevWorktree(prepared).join('\n')).toContain('worktree.command: drive');
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: prepared.worktree.path, encoding: 'utf8' }).stdout).toBe('');
  });
});
