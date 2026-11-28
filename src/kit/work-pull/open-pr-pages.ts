import { runGhCliWithResult } from '../../git-fs/gh-cli.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { GhGovernorRefusal, liveGhGovernorPolicy } from '../gh-governor/index.js';
import { readOpenPrSnapshot, sleepSync, type SnapshotTarget } from '../gh-governor/open-pr-snapshot.js';

/**
 * Every open PR (all pages: creation order is not update order, so a fixed limit misses recently updated old PRs) —
 * GH-BUDGET-GOVERNOR: read from the shared open-PR snapshot (kit/gh-governor/open-pr-snapshot.ts · one refresher for every
 * seat) instead of each caller paging `gh api graphql` with body ⊕ files(first:100) per PR (11-28 20:0x: 56 such queries in
 * 295 s from 23 seat processes → GitHub's secondary limit). Rows keep the old shape: files = [{ path }].
 */
export function readAllOpenPrs(target: { readonly cwd?: string; readonly args: readonly string[] }, timeoutMs?: number): unknown {
  const repo = target.args[0] === '--repo' ? target.args[1] : undefined;
  const policy = liveGhGovernorPolicy();
  if (!policy) throw new Error('gh-governor policy unreadable (graphs/policies/gh-governor.yaml) — open PR snapshot unavailable');
  const t: SnapshotTarget = { slug: repo ?? null, ...(target.cwd ? { cwd: target.cwd } : {}) };
  try {
    return readOpenPrSnapshot(t, {
      stateRoot: effectiveInstanceRoot(), now: Date.now, policy, sleep: sleepSync,
      // The refresh pages the whole list: its own timeout is the policy wait, not the caller's short child budget.
      timeoutMs: Math.max(timeoutMs ?? 0, policy.snapshot.waitForRefresherSec * 1000),
      run: (args, opts) => runGhCliWithResult(args, opts),
    }).prs;
  } catch (e) {
    if (e instanceof GhGovernorRefusal) throw e;
    throw new Error(`gh open PRs: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Pages of the old paged GraphQL answer (pullRequests.nodes) → rows (files = nodes). Kept for recorded pages / tests. */
export function flattenOpenPrPages(pages: unknown): unknown[] {
  if (!Array.isArray(pages)) throw new Error('gh open PR pages: not an array');
  return pages.flatMap((page: any) => {
    const nodes = page?.data?.repository?.pullRequests?.nodes;
    if (!Array.isArray(nodes)) throw new Error('gh open PR page missing nodes');
    return nodes.map((pr: any) => ({ ...pr, files: pr.files?.nodes }));
  });
}
