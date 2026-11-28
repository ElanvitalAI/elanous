/**
 * GH-MIRROR-ORIGIN-URL-SAFE (0.3.40 P0 · 11-29) — the one door for «what repository is origin».
 *
 * S: the GH proxy fetch mirror sets `url.<mirror>.insteadOf = https://github.com/<owner>/<repo>.git` on the HQ repo
 *    (src/kit/gh-proxy/mirror.ts), so every fetch comes from the local mirror.
 * C: `git remote get-url origin` applies insteadOf → it printed the local mirror path, and every reader that parses a GitHub
 *    slug out of it refused («origin is not a supported GitHub repository URL» · land graph · pr · tasks · self review · hq).
 * A: read the RAW configured URL — `git config --get remote.<name>.url` is never insteadOf-rewritten — and fall back to
 *    `git remote get-url --push <name>` (the mirror keeps push on GitHub through pushInsteadOf). Parsing stays with each reader.
 *    test/origin-url-ratchet.test.ts keeps new `remote get-url origin` readers out of src/.
 */
import { spawnSync } from 'node:child_process';

/** `git config --get remote.<name>.url` — the configured URL, before url.*.insteadOf. */
export const rawRemoteUrlArgv = (remote = 'origin'): string[] => ['config', '--get', `remote.${remote}.url`];
/** `git remote get-url --push <name>` — the push URL (pushInsteadOf keeps it on GitHub when the fetch mirror is on). */
export const pushRemoteUrlArgv = (remote = 'origin'): string[] => ['remote', 'get-url', '--push', remote];

type Out = string | null | undefined;
const firstLine = (out: Out): string | null => (typeof out === 'string' ? out.split(/\r?\n/u).map(l => l.trim()).find(Boolean) ?? null : null);

/** The remote's URL through the caller's own git runner (stdout on success, null/undefined on failure). */
export function remoteUrlVia(git: (argv: string[]) => Out, remote = 'origin'): string | null {
  for (const argv of [rawRemoteUrlArgv(remote), pushRemoteUrlArgv(remote)]) {
    let out: Out = null;
    try { out = git(argv); } catch { out = null; }
    const url = firstLine(out);
    if (url) return url;
  }
  return null;
}

/** Async form of {@link remoteUrlVia}. */
export async function remoteUrlViaAsync(git: (argv: string[]) => Promise<Out>, remote = 'origin'): Promise<string | null> {
  for (const argv of [rawRemoteUrlArgv(remote), pushRemoteUrlArgv(remote)]) {
    let out: Out = null;
    try { out = await git(argv); } catch { out = null; }
    const url = firstLine(out);
    if (url) return url;
  }
  return null;
}

/** The remote's URL of the repository at `dir` (a worktree, a checkout, or a bare repo) — null when there is none. */
export function readRemoteUrl(dir: string, opts: { remote?: string; timeoutMs?: number } = {}): string | null {
  return remoteUrlVia(argv => {
    const r = spawnSync('git', argv, { cwd: dir, encoding: 'utf8', timeout: opts.timeoutMs ?? 10_000 });
    return r.status === 0 ? r.stdout : null;
  }, opts.remote ?? 'origin');
}

/** Shell form for scripts (remote hosts): the raw URL, else the push URL — `$repo`-style git-dir argument given verbatim. */
export const remoteUrlShell = (gitDirArg: string, remote = 'origin'): string =>
  `{ git --git-dir=${gitDirArg} config --get remote.${remote}.url || git --git-dir=${gitDirArg} remote get-url --push ${remote}; }`;
