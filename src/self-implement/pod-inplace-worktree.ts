import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';
import { DEFAULT_BRANCH_WORKTREE_BASE, prepareWorktreeDependencies, resolveDefaultBranchBase, worktreeDependenciesAvailable } from '../git-fs/worktree.js';
import type { CreateWorktreeResult } from '../git-fs/worktree.js';

export type PodInplaceWorktree = CreateWorktreeResult & { readonly inPlace: true };

export function tryCreatePodInplaceWorktree(input: {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly branch: string;
  readonly base?: string;
  readonly runId?: string;
  readonly goalFile?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dependencyFallbackRoot?: string;
}): PodInplaceWorktree | null {
  if (input.env.ELANOUS_POD_INPLACE_WORKTREE !== '1') return null;
  const skip = (reason: string): null => {
    debug.log('self-implement', 'pod-inplace-worktree-skipped', { reason, branch: input.branch }, { level: 'warn' });
    process.stderr.write(`ELANOUS_POD_INPLACE_SKIP reason=${reason}\n`);
    return null;
  };
  if (input.env.ELANOUS_SUBSTRATE !== 'pod' || input.env.ELANOUS_POD_SINGLE_CHILD !== '1'
    || !input.env.ELANOUS_POD_NAME?.trim() || !input.runId || input.env.ELANOUS_RUN_ID !== input.runId) {
    return skip('not-single-owned-pod-child');
  }
  let repoRoot: string;
  try {
    repoRoot = realpathSync(input.repoRoot);
    if (repoRoot !== realpathSync(input.cwd)) return skip('different-cwd');
  } catch { return skip('repo-path-unavailable'); }
  const git = (args: string[]) => runGitCommand(repoRoot, args, { encoding: 'utf8', timeout: 10_000 });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || resolve(top.stdout.trim()) !== repoRoot) return skip('not-repo-root');
  const head = git(['rev-parse', '--verify', 'HEAD']);
  const resolvedBase = head.status === 0 ? head.stdout.trim() : '';
  if (!/^[0-9a-f]{40,64}$/i.test(resolvedBase)) return skip('head-unavailable');
  const base = input.base === DEFAULT_BRANCH_WORKTREE_BASE
    ? (resolveDefaultBranchBase(repoRoot) ?? 'HEAD')
    : (input.base ?? 'origin/main');
  const pin = git(['rev-parse', '--verify', `${base}^{commit}`]);
  if (pin.status !== 0 || pin.stdout.trim() !== resolvedBase) return skip('base-pin-mismatch');
  const clean = git(['status', '--porcelain', '-z', '--untracked-files=all']);
  let expectedGoalStatus: string | undefined;
  if (input.goalFile) {
    try {
      const goalRelative = relative(repoRoot, realpathSync(resolve(repoRoot, input.goalFile))).split(sep).join('/');
      if (/^docs\/goals\/GOAL-[^/]+\.md$/.test(goalRelative)) expectedGoalStatus = `?? ${goalRelative}`;
    } catch { /* An unavailable goal file cannot exempt source dirt. */ }
  }
  const dirty = clean.stdout.split('\0').filter(Boolean);
  if (clean.status !== 0 || (dirty.length > 0 && (dirty.length !== 1 || dirty[0] !== expectedGoalStatus))) return skip('source-dirty');
  if (!worktreeDependenciesAvailable(repoRoot, input.dependencyFallbackRoot)) return skip('dependencies-unavailable');
  const validBranch = git(['check-ref-format', '--branch', input.branch]);
  if (validBranch.status !== 0) return skip('invalid-branch');
  const held = git(['show-ref', '--verify', '--quiet', `refs/heads/${input.branch}`]);
  if (held.status !== 1) return skip('branch-exists-or-unreadable');
  const started = Date.now();
  const switched = git(['switch', '--no-guess', '-c', input.branch]);
  if (switched.status !== 0) {
    throw new Error(`pod in-place branch switch failed: ${(switched.stderr || switched.stdout || `git exited ${switched.status}`).trim()}`);
  }
  const after = git(['rev-parse', '--verify', 'HEAD']);
  const currentBranch = git(['branch', '--show-current']);
  if (after.status !== 0 || after.stdout.trim() !== resolvedBase
    || currentBranch.status !== 0 || currentBranch.stdout.trim() !== input.branch) {
    throw new Error('pod in-place branch switch changed pin or branch unexpectedly');
  }
  const switchElapsedMs = Date.now() - started;
  prepareWorktreeDependencies(repoRoot, repoRoot,
    input.dependencyFallbackRoot ? { dependencyFallbackRoot: input.dependencyFallbackRoot } : {}, {});
  const elapsedMs = Date.now() - started;
  debug.log('self-implement', 'pod-inplace-worktree-selected', {
    branch: input.branch, runId: input.runId, sourcePath: repoRoot,
    resolvedBase, elapsedMs, switchElapsedMs, checkoutFiles: 0,
  });
  process.stderr.write(`ELANOUS_POD_INPLACE_SELECTED elapsedMs=${elapsedMs} switchMs=${switchElapsedMs} checkoutFiles=0\n`);
  return { path: repoRoot, branch: input.branch, base: input.base ?? 'HEAD', resolvedBase, baseFreshness: 'head', inPlace: true };
}
