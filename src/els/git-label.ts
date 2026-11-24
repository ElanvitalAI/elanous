// ELS-GIT-AWARENESS-HERDR (OP #139752): branch · ahead/behind · dirty labels and the git worktree root for a pane's
// cwd — computed outside the server main thread (async child processes), cached per resolved cwd, and debounced so a
// listing never runs or waits for git on the request path (#39546 lesson: the keyboard may never queue behind the
// server's own inspections; typing latency stays zero).
// Pattern re-implemented from herdr (Apache-2.0) — src/app/git_refresh.rs (background refresh keyed by the resolved
// identity cwd; the cached result is served to the UI) and src/workspace/git/status.rs (fixed-input keys; a git that
// fails answers «unknown» and is asked again only after a window). No herdr code is copied (RESEARCH §5 provenance).

import { spawn } from 'node:child_process';

export interface GitLabel {
  readonly branch: string;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
  /** `git rev-parse --show-toplevel` — the worktree root this cwd belongs to (null when git could not answer). */
  readonly root: string | null;
}

export type GitLabelRunner = (cwd: string) => Promise<GitLabel | null>;

/** One repo is asked again at most this often (herdr's refresh period); between refreshes the cached label is served. */
const REFRESH_MS = 5_000;
/** One background git answer may take this long before it is killed (label stays unknown, retried after REFRESH_MS). */
const RUN_TIMEOUT_MS = 5_000;

export interface GitLabels {
  /** The cached label for a cwd — a synchronous map read; never starts, waits for or blocks on git. */
  labelFor(cwd: string): GitLabel | undefined;
  /** Ask for a refresh at most once per window per cwd; answers land in the cache on a later macrotask. */
  refresh(cwds: readonly string[]): void;
}

export function createGitLabels(run: GitLabelRunner, now: () => number = Date.now): GitLabels {
  const cache = new Map<string, GitLabel>();
  const asked = new Map<string, number>();
  const queue = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = (): void => {
    timer = undefined;
    const cwds = [...queue];
    queue.clear();
    for (const cwd of cwds) {
      asked.set(cwd, now());
      void run(cwd).then((label: GitLabel | null) => { if (label) cache.set(cwd, label); },
        () => { /* git could not answer: unknown; asked again after the window */ });
    }
  };
  return {
    labelFor(cwd: string): GitLabel | undefined { return cache.get(cwd); },
    refresh(cwds: readonly string[]): void {
      const at = now();
      for (const cwd of cwds) {
        if (!cwd) continue;
        const seen = asked.get(cwd);
        if (seen !== undefined && at - seen < REFRESH_MS) continue;   // debounce: one ask per window, hit or miss
        queue.add(cwd);
      }
      if (queue.size === 0 || timer !== undefined) return;
      timer = setTimeout(drain, 0);
      timer.unref?.();
    },
  };
}

/** `git -C <cwd> …` as an async spawn (never spawnSync), killed after the timeout; null when git could not answer. */
function runGit(args: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(null); return; }
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    let settled = false;
    const finish = (answer: string | null): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(answer); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(null); }, RUN_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(typeof code === 'number' && code === 0 ? out : null));
  });
}

/** One `git status --porcelain=v1 --branch` call carries branch + upstream tracking + dirty in a single answer;
 *  `rev-parse --show-toplevel` names the worktree root. Both run in parallel — child processes, off the request path. */
export const gitLabelRunner: GitLabelRunner = async (cwd: string): Promise<GitLabel | null> => {
  const [status, root] = await Promise.all([
    runGit(['status', '--porcelain=v1', '--branch'], cwd),
    runGit(['rev-parse', '--show-toplevel'], cwd),
  ]);
  if (status === null) return null;                     // not a git repo, or git could not answer: no label
  const lines = status.split('\n');
  const header = (lines[0] ?? '').replace(/^## /, '');
  const dirty = lines.slice(1).some((row) => row.length > 0);
  let branch = header;
  let tracking = '';
  const split = header.indexOf('...');
  if (split >= 0) { branch = header.slice(0, split); tracking = header.slice(split + 3); }
  if (branch.startsWith('No commits yet on ')) branch = branch.slice('No commits yet on '.length);
  if (branch.endsWith(' (no branch)')) branch = 'HEAD';  // detached: the checked-out commit, not a branch name
  let ahead = 0;
  let behind = 0;
  const counts = /\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/.exec(tracking);
  if (counts) { ahead = Number(counts[1] ?? 0); behind = Number(counts[2] ?? counts[3] ?? 0); }
  return { branch, ahead, behind, dirty, root: root !== null ? root.trim() || null : null };
};

/** The server's single label store (core owns it like the mail badge cache; refreshes come from the listing path). */
export function gitLabelsOf(): GitLabels { return createGitLabels(gitLabelRunner); }
