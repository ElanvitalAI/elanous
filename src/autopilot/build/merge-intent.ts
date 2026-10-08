import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGitCommand } from '../../git-fs/runner.js';

export interface MergeIntent {
  ours: string | null;
  theirs: string[];
}

export type IntentGit = (worktreePath: string, args: string[]) => { status: number | null; stdout: string };

export const defaultIntentGit: IntentGit = (worktreePath, args) => {
  const result = runGitCommand(worktreePath, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '' };
};

/** Read only commits introduced on each side of the merge base; a missing ref/document never blocks resolution. */
export function collectMergeIntent({ worktreePath, filePath, mergeTarget, git }: {
  worktreePath: string;
  filePath: string;
  mergeTarget: string;
  git: IntentGit;
}): MergeIntent {
  const read = (...args: string[]): string | null => {
    try {
      const result = git(worktreePath, args);
      return result.status === 0 ? result.stdout.trim() : null;
    } catch { return null; }
  };
  const base = read('merge-base', 'HEAD', mergeTarget);
  if (!base) return { ours: null, theirs: [] };

  let ours: string | null = null;
  const added = read('log', '--reverse', '--diff-filter=A', '--format=', '--name-only', '-z', `${base}..HEAD`, '--', 'docs/goals/');
  for (const goal of added?.split('\0').map((file) => file.trim()).filter((file) => /^docs\/goals\/[^/]+$/.test(file)) ?? []) {
    try {
      ours = summarizeGoalDocument(readFileSync(join(worktreePath, goal), 'utf8'));
      if (ours) break;
    } catch { /* missing goal: try the next added document */ }
  }
  if (!ours) {
    const subjects = read('log', '-3', '--format=%s', `${base}..HEAD`);
    ours = subjects || null;
  }
  const subjects = read('log', '-5', '--format=%s', `${base}..${mergeTarget}`, '--', filePath);
  return { ours, theirs: subjects ? subjects.split('\n') : [] };
}

/**
 * MERGE-INTENT-RESOLVE (0.2.20 P0) — the «other side» of a main-sync conflict is usually a sibling PR
 * that landed first on the same paths (76% of launches overlap an open PR or running run). Commit subjects
 * alone ("feat: B (#2)") don't tell the resolver *why* the sibling changed the file, so it drops one side.
 * Here we identify those merged sibling PRs from the merge target's history for the conflicting file and
 * carry their title/body (and linked goal document) into the resolver's prompt.
 */
export interface SiblingPrIntent {
  number: number;
  title: string;
  /** PR body (or squash commit body when the PR lookup failed), trimmed to `SIBLING_BODY_MAX_CHARS`. */
  body: string | null;
  /** Title/Situation/Complication of the goal document the body links, read from the merge target. */
  goal: string | null;
  goalPath: string | null;
  /** Where title/body came from — `gh` PR lookup or the squash commit message fallback. */
  source: 'gh' | 'commit';
}

/** Async — a `gh` round trip must never block the event loop (the resolver can run inside the daemon). */
export type SiblingPrLookup = (worktreePath: string, number: number) => Promise<{ title: string; body: string } | null>;

export const SIBLING_BODY_MAX_CHARS = 1_200;
export const SIBLING_PR_MAX = 3;

/** Keyed by worktree + PR number — one process can drive worktrees of different repositories (same `#N`, other PR). */
//   Stores the in-flight promise, so concurrent lookups of the same PR share one `gh` call.
const prLookupCache = new Map<string, Promise<{ title: string; body: string } | null>>();

export const SIBLING_PR_LOOKUP_TIMEOUT_MS = 15_000;

/** Real lookup: async `gh pr view <n> --json title,body` in the worktree (repo inferred from its remote). Never rejects. */
export const defaultSiblingPrLookup: SiblingPrLookup = (worktreePath, number) => {
  const key = `${worktreePath}\0${number}`;
  const cached = prLookupCache.get(key);
  if (cached) return cached;
  const pending = new Promise<{ title: string; body: string } | null>((resolve) => {
    try {
      execFile('gh', ['pr', 'view', String(number), '--json', 'title,body'], {
        cwd: worktreePath, encoding: 'utf8', timeout: SIBLING_PR_LOOKUP_TIMEOUT_MS,
      }, (error, stdout) => {
        if (error) { resolve(null); return; } // gh missing/offline/unauthenticated/timeout — commit message fallback
        try {
          const parsed = JSON.parse(String(stdout)) as { title?: unknown; body?: unknown };
          resolve(typeof parsed.title === 'string' ? { title: parsed.title, body: typeof parsed.body === 'string' ? parsed.body : '' } : null);
        } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
  prLookupCache.set(key, pending);
  return pending;
};

/** Title + Situation + Complication lines of a goal document (same shape `collectMergeIntent` uses for ours). */
export function summarizeGoalDocument(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '').trim()
    ?? lines.find((line) => line.trim().length > 0)?.trim();
  const situation = lines.find((line) => /^Situation:/.test(line))?.trim();
  const complication = lines.find((line) => /^Complication:/.test(line))?.trim();
  return [title, situation, complication].filter(Boolean).join('\n') || null;
}

const GOAL_PATH = /docs\/goals\/[A-Za-z0-9._-]+\.md/;
const PR_SUFFIX = /\(#(\d+)\)\s*$/;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Merged sibling PRs that touched `filePath` on the merge-target side (`merge-base..mergeTarget`), newest first.
 * Identified by the squash-merge subject suffix `(#N)`. Empty when none — the caller keeps current behavior.
 */
export async function collectSiblingPrIntents({ worktreePath, filePath, mergeTarget, git, lookupPr = defaultSiblingPrLookup, maxPrs = SIBLING_PR_MAX }: {
  worktreePath: string;
  filePath: string;
  mergeTarget: string;
  git: IntentGit;
  lookupPr?: SiblingPrLookup;
  maxPrs?: number;
}): Promise<SiblingPrIntent[]> {
  const read = (...args: string[]): string | null => {
    try {
      const result = git(worktreePath, args);
      return result.status === 0 ? result.stdout : null;
    } catch { return null; }
  };
  const base = read('merge-base', 'HEAD', mergeTarget)?.trim();
  if (!base) return [];
  // ⛔ No commit cap: direct pushes on the path must not hide older sibling PRs. The range is already bounded
  //   by the merge base, and the loop stops once `maxPrs` siblings are found.
  const log = read('log', '--format=%H%x09%s', `${base}..${mergeTarget}`, '--', filePath);
  if (!log) return [];
  const candidates: Array<{ number: number; sha: string; subject: string }> = [];
  const seen = new Set<number>();
  for (const line of log.split('\n')) {
    if (candidates.length >= maxPrs) break;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const sha = line.slice(0, tab).trim();
    const subject = line.slice(tab + 1).trim();
    const match = PR_SUFFIX.exec(subject);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || seen.has(number)) continue;
    seen.add(number);
    candidates.push({ number, sha, subject });
  }
  // PR lookups run in parallel — worst case is one timeout, not `maxPrs` timeouts in a row.
  const prs = await Promise.all(candidates.map(async ({ number }) => {
    try { return await lookupPr(worktreePath, number); } catch { return null; }
  }));
  return candidates.map(({ number, sha, subject }, index) => {
    const pr = prs[index] ?? null;
    const source: SiblingPrIntent['source'] = pr ? 'gh' : 'commit';
    const title = pr?.title.trim() || subject;
    const rawBody = pr ? pr.body : (read('log', '-1', '--format=%b', sha) ?? '');
    const body = rawBody.trim().length > 0 ? clip(rawBody, SIBLING_BODY_MAX_CHARS) : null;
    const goalPath = GOAL_PATH.exec(`${title}\n${rawBody}`)?.[0] ?? null;
    let goal: string | null = null;
    if (goalPath) {
      const doc = read('show', `${mergeTarget}:${goalPath}`);
      goal = doc ? summarizeGoalDocument(doc) : null;
    }
    return { number, title, body, goal, goalPath, source };
  });
}

/** Forget cached `gh` lookups (tests; a long-lived process may also drop stale PR text). */
export function resetSiblingPrLookupCache(): void { prLookupCache.clear(); }
