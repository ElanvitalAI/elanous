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
      const content = readFileSync(join(worktreePath, goal), 'utf8');
      const lines = content.split(/\r?\n/);
      const title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '').trim()
        ?? lines.find((line) => line.trim().length > 0)?.trim();
      const situation = lines.find((line) => /^Situation:/.test(line))?.trim();
      const complication = lines.find((line) => /^Complication:/.test(line))?.trim();
      ours = [title, situation, complication].filter(Boolean).join('\n') || null;
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
