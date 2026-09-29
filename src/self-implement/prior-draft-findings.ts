import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { parse as parsePrCommentMeta } from '../agent-substrate/pr-comment-meta.js';

export interface PriorDraftPr {
  number: number;
  title: string;
  isDraft: boolean;
  state: string;
  mergedAt?: string | null;
  createdAt: string;
  closedAt?: string | null;
}

export interface PriorDraftComment {
  body: string;
  created_at: string;
  id?: number;
}

export interface PriorDraftFinding {
  pr: number;
  runId: string;
  round: number;
  items: string[];
}

function ghJson<T>(args: string[], repoPath: string): T {
  return JSON.parse(execFileSync('gh', args, { cwd: repoPath, env: { ...process.env }, encoding: 'utf8', timeout: 15_000 })) as T;
}

function defaultListPrs(repo: string, repoPath: string): readonly PriorDraftPr[] {
  const fields = 'number,title,isDraft,state,mergedAt,createdAt,closedAt';
  return ghJson<PriorDraftPr[]>(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', fields], repoPath);
}

function defaultListComments(pr: number, repo: string, repoPath: string): readonly PriorDraftComment[] {
  return ghJson<PriorDraftComment[][]>(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--slurp'], repoPath).flat();
}

/** Read the goal H1 from the target worktree, never an unrelated caller cwd. */
export function goalTitleFromTargetGoalFile(goalFile: string, worktreePath: string): string | undefined {
  try {
    const goalPath = resolve(worktreePath, goalFile);
    return /^# (.+)\s*$/m.exec(readFileSync(goalPath, 'utf8'))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Read-only cross-run reviewer context. A failed lookup must never block review. */
export async function collectPriorDraftFindings({
  goalTitle, currentRunId, repoPath, listPrs, listComments,
}: {
  goalTitle: string;
  currentRunId: string;
  /** Worktree belonging to the target repository, independent of the caller's current directory. */
  repoPath?: string;
  listPrs?: () => Promise<readonly PriorDraftPr[]> | readonly PriorDraftPr[];
  listComments?: (pr: number) => Promise<readonly PriorDraftComment[]> | readonly PriorDraftComment[];
}): Promise<PriorDraftFinding[]> {
  try {
    const path = repoPath ?? process.cwd();
    const repo = !listPrs || !listComments
      ? ghJson<{ nameWithOwner: string }>(['repo', 'view', '--json', 'nameWithOwner'], path).nameWithOwner
      : undefined;
    if (repo !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('Invalid target repository');
    const fetchPrs = listPrs ?? (() => defaultListPrs(repo!, path));
    const fetchComments = listComments ?? ((pr: number) => defaultListComments(pr, repo!, path));
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const prs = await fetchPrs();
    const results: PriorDraftFinding[] = [];
    let remaining = 12;
    for (const pr of prs) {
      if (remaining === 0) break;
      if (pr.title !== goalTitle || !(pr.state.toUpperCase() === 'OPEN' && pr.isDraft || pr.state.toUpperCase() === 'CLOSED' && !pr.mergedAt)) continue;
      let comments: readonly PriorDraftComment[];
      try {
        comments = await fetchComments(pr.number);
      } catch (error) {
        debug.log('self-implement', 'prior-findings.unreadable', { pr: pr.number, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const prActivity = Date.parse(pr.state.toUpperCase() === 'CLOSED' ? pr.closedAt ?? pr.createdAt : pr.createdAt);
      // A PR bearing the current run's comment is this run's PR, not a predecessor.
      if (comments.some((comment) => parsePrCommentMeta(comment.body)?.run === currentRunId)) continue;
      const reviewers = comments.flatMap((comment) => {
        const meta = parsePrCommentMeta(comment.body);
        return meta?.role === 'reviewer' && meta.run && meta.round !== undefined
          ? [{ comment, meta }] : [];
      }).sort((a, b) => Date.parse(a.comment.created_at) - Date.parse(b.comment.created_at) || (a.comment.id ?? 0) - (b.comment.id ?? 0));
      const last = reviewers.at(-1);
      if (!last) continue;
      const recentPr = Number.isFinite(prActivity) && prActivity >= cutoff && prActivity <= now;
      const recentComment = comments.some((comment) => {
        const at = Date.parse(comment.created_at);
        return Number.isFinite(at) && at >= cutoff && at <= now;
      });
      if (!recentPr && !recentComment) continue;
      const body = last.comment.body.split(/\r?\n/).slice(1);
      const heading = body.findIndex((line) => /^Round \d+: reviewer requested \d+ must-fix change\(s\)\.$/.test(line.trim())
        && line.startsWith(`Round ${last.meta.round}:`));
      if (heading === -1) continue;
      // Honour the declared count and the section boundary: only the bullet run right under the heading,
      // at most K items — a later «Should-fix»/discussion list must never be read as the previous run's must-fix.
      const declared = Number(body[heading]!.trim().match(/requested (\d+) must-fix/)?.[1] ?? 0);
      if (!declared) continue;
      const items: string[] = [];
      for (const line of body.slice(heading + 1)) {
        if (line.startsWith('- ')) { items.push(line.slice(2).trim().slice(0, 300)); if (items.length >= declared) break; continue; }
        if (!line.trim()) { if (items.length) break; continue; }
        if (line.startsWith('  ') && items.length) continue;  // wrapped continuation of the current item
        break;
      }
      const selected = items.filter(Boolean).slice(0, remaining);
      if (!selected.length) continue;
      results.push({ pr: pr.number, runId: last.meta.run!, round: last.meta.round!, items: selected });
      remaining -= selected.length;
    }
    return results;
  } catch (error) {
    debug.log('self-implement', 'prior-findings.unreadable', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
