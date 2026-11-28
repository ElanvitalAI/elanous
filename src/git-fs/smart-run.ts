/**
 * The git seam for src/git-smart (SMART-MERGE · CEO 11-27): one synchronous runner bound to a working directory.
 * Lives under src/git-fs/ so the spawn-discipline ratchet (I-T4) sees every smart-merge git call go through the seam.
 */
import { spawnSync } from 'node:child_process';

export interface GitOut { status: number | null; stdout: string; stderr: string }
/** A git runner bound to one directory. `input` = stdin · `env` = extra environment (merged over process.env). */
export type GitRun = (args: readonly string[], opts?: { input?: string; env?: Record<string, string>; timeoutMs?: number }) => GitOut;

/** True only for git's success status; caller retains responsibility for validation and error handling. */
export function isAncestor(git: (args: string[]) => { status: number | null }, ancestor: string, descendant: string): boolean {
  return git(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}

/** Identity for synthetic commits the smart-merge writes (merge / rebuild commits). */
export const SMART_MERGE_IDENTITY = ['-c', 'user.name=land-graph', '-c', 'user.email=land-graph@elanous.local'] as const;

export function gitAt(cwd: string, base: { timeoutMs?: number } = {}): GitRun {
  return (args, opts = {}) => {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? base.timeoutMs ?? 120_000,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
  };
}
