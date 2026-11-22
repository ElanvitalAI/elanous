// Pane reports describe the running TUI, not the els server or its working tree.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { desiredSha as readDesiredSha } from '../nexus/host-registry/desired-sha.js';

export type BuildAge = 'current' | 'older' | 'different' | 'unknown';

// Pattern re-implemented from herdr (Apache-2.0) — src/app/git_refresh.rs (background refresh, cached result served to
// the UI) and src/workspace/git/status.rs (results keyed by fixed inputs; failure = unknown with a retry window).
// The listing never runs git or re-reads unchanged files on the request path.

const DEFAULT_DESIRED_PATH = join(homedir(), 'elanous-hq/seat-state/OP/rail/DESIRED.json');
let desiredMemo: { path: string; stamp: string; value: string | undefined } | undefined;
/** DESIRED.json's sha, re-read only when the file's (mtime, size, inode) stamp changes; a missing file = undefined. */
export function desiredSha(path: string = DEFAULT_DESIRED_PATH): string | undefined {
  let stamp: string;
  try { const st = statSync(path); stamp = `${st.mtimeMs}:${st.size}:${st.ino}`; }
  catch { desiredMemo = undefined; return undefined; }
  if (desiredMemo && desiredMemo.path === path && desiredMemo.stamp === stamp) return desiredMemo.value;
  const value = readDesiredSha(path);
  desiredMemo = { path, stamp, value };
  return value;
}
export function buildAge(sha: string | undefined, desired: string | undefined, ancestor: (a: string, b: string) => boolean | undefined): BuildAge {
  if (!sha || !desired || !/^[a-f0-9]{40}$/i.test(sha)) return 'unknown';
  if (sha.toLowerCase() === desired.toLowerCase()) return 'current';
  const older = ancestor(sha, desired);
  return older === true ? 'older' : older === false ? 'different' : 'unknown';
}
/** How a pair is asked: resolves the git exit status (0 ancestor · 1 not), or null when git could not answer. */
export type AncestorRunner = (a: string, b: string) => Promise<number | null>;

/** A git that could not answer is asked again only after this long (the pair stays «unknown» meanwhile — herdr retry_after). */
const ANCESTOR_RETRY_MS = 30_000;
/** One background git answer may take this long before it is killed (unknown, retried after ANCESTOR_RETRY_MS). */
const ANCESTOR_TIMEOUT_MS = 5_000;

/**
 * ELS-SERVER-MAINLOOP-STARVATION: the listing's «is this build older than the desired one» answer, without git on the
 * request path. A pair's answer never changes, so it is memoized forever; an unknown pair returns undefined at once and
 * one async `git merge-base --is-ancestor` starts on the next macrotask (one per pair in flight). The listing shows
 * `unknown` until the answer is in — the old code ran spawnSync (≤ 1 s) per pane per listing on the server thread.
 */
export function createGitAncestor(run: AncestorRunner, now: () => number = Date.now): (a: string, b: string) => boolean | undefined {
  const ages = new Map<string, boolean>();
  const asked = new Map<string, number>();
  return (a, b) => {
    const key = `${a}:${b}`;
    const known = ages.get(key);
    if (known !== undefined) return known;
    const at = asked.get(key);
    if (at !== undefined && now() - at < ANCESTOR_RETRY_MS) return undefined;
    asked.set(key, now());
    const timer = setTimeout(() => {
      void run(a, b).then((status) => {
        if (status === 0 || status === 1) { ages.set(key, status === 0); asked.delete(key); }
      }, () => { /* unknown; asked again after the retry window */ });
    }, 0);
    timer.unref?.();
    return undefined;
  };
}

/** `git --git-dir ~/elanous-hq/repo.git merge-base --is-ancestor a b`, async spawn (never spawnSync), killed after 5 s. */
const gitRunner: AncestorRunner = (a, b) => new Promise((resolve) => {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('git', ['--git-dir', join(homedir(), 'elanous-hq/repo.git'), 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
  } catch { resolve(null); return; }
  const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(null); }, ANCESTOR_TIMEOUT_MS);
  timer.unref?.();
  child.on('error', () => { clearTimeout(timer); resolve(null); });
  child.on('close', (code) => { clearTimeout(timer); resolve(typeof code === 'number' ? code : null); });
});

export const gitAncestor = createGitAncestor(gitRunner);
