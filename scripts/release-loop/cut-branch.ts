import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { isReleaseVersion } from './release-version.js';

export interface CutBranchOptions { version: string; base: string; pick: string[]; append?: boolean; dryRun?: boolean; repoRoot?: string; log?: (line: string) => void }

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
  const report = (event: 'created' | 'refused' | 'conflict' | 'appended', reason?: string, commit?: string, extra?: Record<string, string | string[]>) =>
    debug.log('release-loop.cut-branch', event, { version: opts.version, branch, ...(commit ? { commit } : {}), ...(reason ? { reason } : {}), ...extra });
  try {
    if (!isReleaseVersion(opts.version)) throw new Error(`invalid release version: ${opts.version}`);
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
    const remoteLine = git(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    if (remoteLine && !opts.append) throw new Error(`${branch} already exists on origin — use --append to fast-forward more picks onto it`);
    if (!remoteLine && opts.append) throw new Error(`${branch} does not exist on origin — omit --append to create it`);
    if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).status === 0) throw new Error(`${branch} already exists locally`);
    let remoteTip: string | undefined;
    if (opts.append) {
      const advertised = remoteLine.split(/\s+/)[0] ?? '';
      if (!/^[0-9a-f]{40}$/i.test(advertised)) throw new Error(`${branch} remote tip is not a commit SHA`);
      git(repo, ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      remoteTip = git(repo, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
      if (advertised !== remoteTip) throw new Error(`${branch} remote tip moved — fast-forward refused (no force push)`);
      for (const sha of picks) if (ancestor(repo, sha, remoteTip)) throw new Error(`pick ${sha} is already in ${branch}`);
    }
    const versionAt = remoteTip ?? base;
    const pkg = JSON.parse(git(repo, ['show', `${versionAt}:package.json`])) as { version?: unknown };
    if (pkg.version !== opts.version) throw new Error(`${opts.append ? 'release branch' : 'base'} package.json version ${pkg.version} is not ${opts.version}`);
    const start = remoteTip ?? base;
    log(`${branch}: ${start} + ${picks.join(' + ')}${opts.append ? ' (append)' : ''}${opts.dryRun ? ' (dry-run)' : ''}`);
    if (opts.dryRun) return { branch, commit: null, dryRun: true };
    const temp = mkdtempSync(join(tmpdir(), 'release-cut-branch-'));
    const tree = join(temp, 'tree');
    let added = false;
    let commit: string | undefined;
    try {
      git(repo, ['worktree', 'add', '--detach', tree, start]);
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
    const lease = opts.append ? remoteTip! : '';
    let push: string;
    try {
      push = git(repo, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${lease}`, 'origin', `${commit}:refs/heads/${branch}`]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (opts.append && /stale info|rejected|non-fast-forward|failed to push/i.test(message)) {
        throw new Error(`${branch} remote tip moved — fast-forward refused (no force push)`);
      }
      throw error;
    }
    const landed = push.split('\n').some((line) => {
      const [flag, ref, summary] = line.split('\t');
      if (flag !== ' ' && flag !== '*') return false;
      if (!ref?.endsWith(`:refs/heads/${branch}`)) return false;
      if (!opts.append) return flag === '*' && summary === '[new branch]';
      const range = summary?.match(/^([0-9a-f]+)\.\.([0-9a-f]+)$/i);
      return flag === ' ' && !!range && remoteTip!.startsWith(range[1]!) && commit.startsWith(range[2]!);
    });
    if (!landed) throw new Error(opts.append
      ? `${branch} remote tip moved — fast-forward refused (no force push)`
      : `${branch} already exists on origin (push did not create a new branch)`);
    if (opts.append) report('appended', undefined, commit, { from: remoteTip!, to: commit, picks });
    else report('created', undefined, commit);
    log(`${branch} → ${commit}`);
    return { branch, commit, dryRun: false };
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('충돌'))) report('refused', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
