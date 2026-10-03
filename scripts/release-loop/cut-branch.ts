import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';

export interface CutBranchOptions { version: string; base: string; pick: string[]; dryRun?: boolean; repoRoot?: string; log?: (line: string) => void }

// git-spawn-allow: release branch operations happen only in an isolated temporary worktree; main is never checked out or changed.
function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error || result.stdout || 'no output').toString().trim()}`);
  return result.stdout.trim();
}

function ancestor(repo: string, sha: string, ref: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', sha, ref], { cwd: repo });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git merge-base failed: ${result.error || result.stderr || 'unknown'}`);
  return result.status === 0;
}

export function cutReleaseBranch(opts: CutBranchOptions): { branch: string; commit: string | null; dryRun: boolean } {
  const repo = resolve(opts.repoRoot ?? process.cwd());
  const branch = `release/${opts.version}`;
  const log = opts.log ?? console.log;
  const report = (event: 'created' | 'refused' | 'conflict', reason?: string, commit?: string) =>
    debug.log('release-loop.cut-branch', event, { version: opts.version, branch, ...(commit ? { commit } : {}), ...(reason ? { reason } : {}) });
  try {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(opts.version)) throw new Error(`invalid release version: ${opts.version}`);
    if (!opts.pick.length) throw new Error('at least one --pick commit is required');
    for (const sha of [opts.base, ...opts.pick]) if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`invalid commit SHA: ${sha}`);
    git(repo, ['fetch', 'origin', 'main']);
    const base = git(repo, ['rev-parse', '--verify', `${opts.base}^{commit}`]);
    if (!ancestor(repo, base, 'origin/main')) throw new Error(`base ${base} is not an ancestor of origin/main`);
    const picks = opts.pick.map((sha) => git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]));
    for (const sha of picks) if (!ancestor(repo, sha, 'origin/main')) throw new Error(`pick ${sha} is not an ancestor of origin/main`);
    for (const sha of picks) if (ancestor(repo, sha, base)) throw new Error(`pick ${sha} is already in base ${base}`);
    if (new Set(picks).size !== picks.length) throw new Error('duplicate --pick commit');
    for (const sha of picks) if (git(repo, ['rev-list', '--parents', '-n', '1', sha]).split(' ').length !== 2) throw new Error(`pick ${sha} must have exactly one parent`);
    if (git(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])) throw new Error(`${branch} already exists on origin`);
    if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).status === 0) throw new Error(`${branch} already exists locally`);
    const pkg = JSON.parse(git(repo, ['show', `${base}:package.json`])) as { version?: unknown };
    if (pkg.version !== opts.version) throw new Error(`base package.json version ${pkg.version} is not ${opts.version}`);
    log(`${branch}: ${base} + ${picks.join(' + ')}${opts.dryRun ? ' (dry-run)' : ''}`);
    if (opts.dryRun) return { branch, commit: null, dryRun: true };
    const temp = mkdtempSync(join(tmpdir(), 'release-cut-branch-'));
    const tree = join(temp, 'tree');
    let added = false;
    let commit: string | undefined;
    try {
      git(repo, ['worktree', 'add', '--detach', tree, base]);
      added = true;
      for (const sha of picks) {
        try { git(tree, ['cherry-pick', sha]); }
        catch (error) {
          const files = git(tree, ['diff', '--name-only', '--diff-filter=U']);
          if (!files) throw error;
          report('conflict', `cherry-pick ${sha}`);
          throw new Error(`cherry-pick ${sha} 충돌 — 손으로 풀 곳: ${files.split('\n').join(', ')} (release/${opts.version} 가지는 만들지 않음)`);
        }
      }
      commit = git(tree, ['rev-parse', 'HEAD']);
      const finalPackage = JSON.parse(git(tree, ['show', 'HEAD:package.json'])) as { version?: unknown };
      if (finalPackage.version !== opts.version) throw new Error(`picked branch package.json version ${finalPackage.version} is not ${opts.version}`);
    } finally {
      try {
        if (added) git(repo, ['worktree', 'remove', '--force', tree]);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    if (!commit) throw new Error('cherry-pick produced no commit');
    const push = git(repo, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${commit}:refs/heads/${branch}`]);
    const newBranch = push.split('\n').some((line) => {
      const [flag, ref, summary] = line.split('\t');
      return flag === '*' && ref?.endsWith(`:refs/heads/${branch}`) && summary === '[new branch]';
    });
    if (!newBranch) throw new Error(`${branch} already exists on origin (push did not create a new branch)`);
    report('created', undefined, commit);
    log(`${branch} → ${commit}`);
    return { branch, commit, dryRun: false };
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('충돌'))) report('refused', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
