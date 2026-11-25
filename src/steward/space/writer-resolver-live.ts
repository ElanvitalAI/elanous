// WRITER-CHECK-RESOLVER live ports — read-only gh / git lookups (each bounded by a timeout; a failure is «unknown»).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OpenPr, RecentCommit, WriterCheckPorts } from './writer-resolver.js';
import { RECENT_COMMIT_MS } from './writer-resolver.js';

const run = (cmd: string, args: string[], cwd?: string): string => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} exit ${r.status}`);
  return String(r.stdout ?? '');
};

/** Seat tokens a branch name may carry (declared seat roles are added by the caller). */
export const BASE_SEATS = ['OP', 'OPC', 'OPT', 'TC', 'MK', 'UX', 'RES', 'JUD', 'REL', 'MOB', 'MVP', 'HAND'] as const;

export const liveRepoRoot = (): string => process.env.ELANOUS_REPO_ROOT || join(homedir(), 'elanous-hq', 'repo.git');

/** Worktrees from `git worktree list --porcelain`: path ⊕ branch. */
export function parseWorktreeList(text: string): { path: string; branch: string }[] {
  const out: { path: string; branch: string }[] = [];
  let path = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line.startsWith('branch ')) out.push({ path, branch: line.slice(7).replace(/^refs\/heads\//, '') });
  }
  return out;
}

/** `git log --name-only --format=@@%H%x09%S` → commits with the seat taken from the reaching ref's name (seat token among `seats`). */
export function parseRecentLog(text: string, seats: readonly string[]): RecentCommit[] {
  const out: RecentCommit[] = [];
  let cur: { sha: string; seat: string; files: string[] } | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      if (cur) out.push(cur);
      const [sha = '', ref = ''] = line.slice(2).split('\t');
      const tokens = ref.toUpperCase().split(/[^A-Z0-9-]+/);
      const seat = [...seats].sort((a, b) => b.length - a.length).find((s) => tokens.some((t) => t === s.toUpperCase() || t.startsWith(`${s.toUpperCase()}-`))) ?? '';
      cur = { sha, seat, files: [] };
    } else if (line.trim() && cur) cur.files.push(line.trim());
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.seat);
}

export function liveWriterCheckPorts(seats: readonly string[], repo = liveRepoRoot()): WriterCheckPorts {
  let worktrees: { path: string; branch: string }[] | null = null;
  const list = (): { path: string; branch: string }[] => (worktrees ??= parseWorktreeList(run('git', ['worktree', 'list', '--porcelain'], repo)));
  return {
    worktreeOf(seat, hint) {
      if (hint && existsSync(hint)) return hint;
      const s = seat.toLowerCase();
      return list().find((w) => w.branch.toLowerCase().includes(s) || w.path.toLowerCase().split('/').pop()!.includes(s))?.path ?? null;
    },
    uncommitted: (worktree) => run('git', ['status', '--porcelain'], worktree).split('\n').filter(Boolean).map((l) => l.slice(3).trim()),
    openPrs: (): OpenPr[] => (JSON.parse(run('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,files'], repo)) as { number: number; headRefName: string; files?: { path: string }[] }[])
      .map((p) => ({ number: p.number, branch: p.headRefName, files: (p.files ?? []).map((f) => f.path) })),
    recentCommits: () => parseRecentLog(run('git', ['log', '--all', `--since=${Math.round(RECENT_COMMIT_MS / 60_000)} minutes ago`, '--name-only', '--format=@@%H%x09%S'], repo), seats),
  };
}
