import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { readFileSync } from 'node:fs';
import { resolveMainRepoRoot, type HarnessWorktreeCommand } from '../git-fs/worktree.js';
import { goalTitleFromDocument } from '../self-implement/seams.js';
import { addHarnessWorktree, type HarnessWorktreeAddResult } from './harness-worktree-add.js';

export interface DevWorktreeEnvironment {
  cwd: string;
  repoRoot: string;
  isPrimary: boolean;
  /** ⭐ detached HEAD 면 `null` — 「브랜치가 없다」와 「이름을 모른다」를 «값으로» 가른다.
   *  ⛔ 빈 문자열로 두지 않는다(그러면 「이름이 비었다」와 구분이 안 된다). */
  branch: string | null;
  commit: string;
}

export interface PreparedDevWorktree {
  environment: DevWorktreeEnvironment;
  worktree: HarnessWorktreeAddResult;
}

interface DevWorktreeGoal {
  id: string;
  file: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || `git exited ${result.status}`;
    throw new Error(`dev auto-worktree inspection failed — ${message}`);
  }
  return result.stdout.trim();
}

export function prepareDevWorktree(cwd: string, runId: string, command: HarnessWorktreeCommand = 'dev', goal?: DevWorktreeGoal): PreparedDevWorktree {
  const repoRoot = resolveMainRepoRoot(cwd);
  if (!repoRoot) throw new Error(`dev --worktree requires a Git repository — ${cwd}`);
  const worktreePaths = git(cwd, ['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .map((record) => record.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length))
    .filter((path): path is string => path !== undefined);
  const currentPath = git(cwd, ['rev-parse', '--show-toplevel']);
  // ⛔ detached HEAD 를 «거부하지 않는다» — 이 값은 «환경 보고»에만 쓰이고, 워크트리는 아래에서
  //    `base: commit` 으로 만든다. 즉 브랜치 이름이 없어도 자동 배정은 «원리적으로 가능하다».
  //    ⇒ 지원 범위를 좁히는 대신 «상태를 그대로 보고»한다(리뷰 must-fix).
  const branch = git(cwd, ['branch', '--show-current']) || null;
  const commit = git(cwd, ['rev-parse', 'HEAD']);
  const environment: DevWorktreeEnvironment = {
    cwd: currentPath,
    repoRoot,
    isPrimary: worktreePaths[0] === currentPath,
    branch,
    commit,
  };
  if (goal && !goal.id.trim()) {
    throw new Error(`dev auto-worktree requires a goal identifier when a goal file is supplied — ${goal.file}`);
  }
  const goalMetadata = goal
    ? (() => {
        const goalTitle = goalTitleFromDocument(readFileSync(goal.file, 'utf8'));
        if (!goalTitle) {
          throw new Error(`dev auto-worktree requires a titled goal document — ${goal.file}`);
        }
        return {
          goalId: goal.id,
          goalFile: goal.file,
          goalTitle,
          requireGoalMetadata: true,
        };
      })()
    : {};
  const worktreeBranch = `dev/${runId}`;
  const worktree = addHarnessWorktree({
    repoRoot,
    branch: worktreeBranch,
    base: commit,
    owner: `dev:${runId}`,
    command,
    ...goalMetadata,
  });
  return { environment, worktree };
}

export function renderPreparedDevWorktree(prepared: PreparedDevWorktree): string[] {
  const { environment, worktree } = prepared;
  return [
    '━━ dev auto-worktree ━━',
    `current.path: ${environment.cwd}`,
    `current.kind: ${environment.isPrimary ? 'primary' : 'linked-worktree'}`,
    `current.branch: ${environment.branch}`,
    `current.commit: ${environment.commit}`,
    `worktree.path: ${worktree.path}`,
    `worktree.branch: ${worktree.branch}`,
    `worktree.owner: ${worktree.owner ?? 'not-recorded'}`,
    `worktree.command: ${worktree.command ?? 'not-recorded'}`,
    `worktree.createdAt: ${worktree.createdAt ?? 'not-recorded'}`,
  ];
}
