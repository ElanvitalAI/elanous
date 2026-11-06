#!/usr/bin/env bun

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

export type TreeSyncDecision =
  | { action: 'pull'; reason: 'clean-behind'; behind: number; path: string; untracked: number }
  | { action: 'skip'; reason: 'local-changes' | 'overlapping-changes' | 'overlap-unreadable' | 'up-to-date' | 'ahead-of-remote' | 'diverged'; behind: number; path: string; untracked: number; overlaps?: string[]; error?: string }
  | { action: 'unavailable'; reason: 'target-unreadable' | 'local-unreadable' | 'remote-unreadable'; behind: null; path: string; untracked: number | null; error: string };

type TreeSyncOverlap =
  | { status: 'measured'; paths: string[] }
  | { status: 'unreadable'; error: string };

type TreeSyncInput = { dirty: boolean; untracked: number; ahead: number; behind: number; overlap?: TreeSyncOverlap };

export type GitResult = { stdout: string; stderr: string; exitCode: number | null };
export type GitCommand = (args: string[], cwd: string) => Promise<GitResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(command: string, result: GitResult): Error {
  return new Error(result.stderr.trim() || `${command} exited with ${result.exitCode ?? 'no exit code'}`);
}

export function decideTreeSync(path: string, input: TreeSyncInput): TreeSyncDecision {
  if (input.dirty) {
    if (input.ahead === 0 && input.behind > 0) {
      if (!input.overlap) return { action: 'skip', reason: 'local-changes', behind: input.behind, path, untracked: input.untracked };
      if (input.overlap.status === 'unreadable') return { action: 'skip', reason: 'overlap-unreadable', behind: input.behind, path, untracked: input.untracked, error: input.overlap.error };
      if (input.overlap.paths.length > 0) return { action: 'skip', reason: 'overlapping-changes', behind: input.behind, path, untracked: input.untracked, overlaps: input.overlap.paths };
    } else {
      return { action: 'skip', reason: 'local-changes', behind: input.behind, path, untracked: input.untracked };
    }
  }
  if (input.ahead > 0 && input.behind > 0) return { action: 'skip', reason: 'diverged', behind: input.behind, path, untracked: input.untracked };
  if (input.behind > 0) return { action: 'pull', reason: 'clean-behind', behind: input.behind, path, untracked: input.untracked };
  return { action: 'skip', reason: input.ahead > 0 ? 'ahead-of-remote' : 'up-to-date', behind: 0, path, untracked: input.untracked };
}

function changedPaths(output: string): Set<string> {
  return new Set(output.split('\0').filter(Boolean));
}

export async function defaultGit(args: string[], cwd: string): Promise<GitResult> {
  // git-spawn-allow: read-only worktree and remote observations for a human-reviewed sync decision.
  const child = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function observeTreeSync(path: string, git: GitCommand = defaultGit): Promise<TreeSyncDecision> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error('target is not a directory');
    await access(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    return { action: 'unavailable', reason: 'target-unreadable', behind: null, path, untracked: null, error: `target path ${JSON.stringify(path)} is unreadable: ${errorMessage(error)}` };
  }

  let dirty: boolean;
  let untracked: number;
  let branch: string;
  try {
    const trackedStatus = await git(['status', '--porcelain', '--untracked-files=no'], path);
    if (trackedStatus.exitCode !== 0) throw failed('git status --porcelain --untracked-files=no', trackedStatus);
    dirty = trackedStatus.stdout.trim().length > 0;
    const untrackedStatus = await git(['status', '--porcelain', '--untracked-files=all'], path);
    if (untrackedStatus.exitCode !== 0) throw failed('git status --porcelain --untracked-files=all', untrackedStatus);
    untracked = untrackedStatus.stdout.split('\n').filter((line) => line.startsWith('?? ')).length;
    const currentBranch = await git(['branch', '--show-current'], path);
    if (currentBranch.exitCode !== 0 || !currentBranch.stdout.trim()) throw failed('git branch --show-current', currentBranch);
    branch = currentBranch.stdout.trim();
  } catch (error) {
    return { action: 'unavailable', reason: 'local-unreadable', behind: null, path, untracked: null, error: errorMessage(error) };
  }

  try {
    const remoteRef = `refs/remotes/origin/${branch}`;
    // PR-HEAD-FETCH-STATELESS: «+» so a force-updated remote branch is measured (as diverged) instead of refused,
    // and no --quiet so a real fetch failure keeps its stderr in the observed error.
    const fetch = await git(['fetch', 'origin', `+refs/heads/${branch}:${remoteRef}`], path);
    if (fetch.exitCode !== 0) throw failed(`git fetch origin ${branch}`, fetch);
    const counts = await git(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], path);
    if (counts.exitCode !== 0) throw failed(`git rev-list HEAD...${remoteRef}`, counts);
    const [aheadText, behindText] = counts.stdout.trim().split(/\s+/);
    const ahead = Number(aheadText);
    const behind = Number(behindText);
    if (!Number.isInteger(ahead) || ahead < 0 || !Number.isInteger(behind) || behind < 0) throw new Error('git rev-list returned invalid ahead/behind counts');
    let overlap: TreeSyncOverlap | undefined;
    if (dirty && ahead === 0 && behind > 0) {
      try {
        const local = await git(['diff', '--no-renames', '--name-only', '-z', 'HEAD'], path);
        if (local.exitCode !== 0) throw failed('git diff --no-renames --name-only -z HEAD', local);
        const incoming = await git(['diff', '--no-renames', '--name-only', '-z', `HEAD...${remoteRef}`], path);
        if (incoming.exitCode !== 0) throw failed(`git diff --no-renames --name-only -z HEAD...${remoteRef}`, incoming);
        const incomingPaths = changedPaths(incoming.stdout);
        overlap = { status: 'measured', paths: [...changedPaths(local.stdout)].filter((candidate) => incomingPaths.has(candidate)).sort() };
      } catch (error) {
        overlap = { status: 'unreadable', error: errorMessage(error) };
      }
    }
    return decideTreeSync(path, { dirty, untracked, ahead, behind, overlap });
  } catch (error) {
    return { action: 'unavailable', reason: 'remote-unreadable', behind: null, path, untracked, error: errorMessage(error) };
  }
}

export function formatTreeSyncDecision(decision: TreeSyncDecision): string {
  if (decision.action === 'unavailable') return `tree sync unavailable (${decision.reason}): ${decision.error}`;
  if (decision.action === 'pull') return `tree sync pull: ${decision.path} is ${decision.behind} commit(s) behind (${decision.reason}; untracked ${decision.untracked})`;
  const overlapDetail = decision.overlaps ? `; overlaps ${decision.overlaps.join(', ')}` : decision.error ? `; error ${decision.error}` : '';
  return `tree sync skip: ${decision.path} (${decision.reason}; behind ${decision.behind}; untracked ${decision.untracked}${overlapDetail})`;
}

export async function runTreeSyncDecisionCli(path: string | undefined = process.argv[2], git: GitCommand = defaultGit): Promise<TreeSyncDecision> {
  if (!path) throw new Error('target worktree path is required; refusing to infer it from process.cwd()');
  const decision = await observeTreeSync(path, git);
  console.log(formatTreeSyncDecision(decision));
  return decision;
}

if (import.meta.main) {
  try {
    await runTreeSyncDecisionCli();
  } catch (error) {
    console.log(formatTreeSyncDecision({ action: 'unavailable', reason: 'local-unreadable', behind: null, path: '<missing-target>', untracked: null, error: errorMessage(error) }));
  }
}
