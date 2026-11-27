/**
 * SMART-MERGE ②③④ — bring a PR branch onto fresh main without a hand: stack rebuild after a squash, or a main merge,
 * conflicts through the ladder, revert guard, then a plain (never force) push.
 *
 * S: every squash-land broke the PRs stacked on it (#40352→#40362→#40370→#40372→#40385 · #40350→#40358 · #40378→#40361):
 *    the child still carried the parent's original commits, so main + child = stale-base-revert / merge-tree conflicts,
 *    each fixed by an agent merging main by hand. The land graph's REFRESH only merged main and gave up on any conflict.
 * C: the parent's change is already in main (squashed); only the child's OWN commits need to move.
 * A: method by ancestry —
 *    rebuild  a squash-landed head (`parentHeads`) is shares non-main history with the branch → the effect
 *             of `git rebase --onto main <parent>` in a throwaway worktree: cherry-pick only the child's OWN commits
 *             (`rev-list --no-merges head ^main ^<every relevant landed head>`) onto main — main merges, the parent's
 *             commits and an earlier rebuild of the parent (its first parent is the parent's old head) all drop out,
 *             so a 4-deep stack rebuilds one layer per landing.
 *             Published WITHOUT force: a merge commit whose tree is the rebuilt tree and whose parents are
 *             [old head, main] — a fast-forward of the branch, so a plain push; the PR diff (merge-base = main) is
 *             exactly the rebuilt own change. Other people's branches are never force-pushed.
 *    merge    otherwise `git merge origin/main` into the branch.
 *    Both run with rerere on; a stop goes through the ladder (conflict-ladder.ts); the result must pass the revert guard
 *    (own change = the cherry-picked own commits for a rebuild · merge-base..head for a merge) before anything is pushed.
 * Safety: one smart-merge per PR at a time (lock file) · the remote branch must still be at `head` (checked after fetch
 * and again right before the push; a force-pushed or moved branch → head-moved) · a closed PR → closed · any git failure
 * before the push → error with nothing pushed. The worktree is always removed.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitAt, SMART_MERGE_IDENTITY, type GitRun } from '../git-fs/smart-run.js';
import { conflictCard, forgetOwnResolutions, NO_RERERE_ARGS, RERERE_ARGS, runLadderLlm, runLadderSync, type FileConflict, type LadderResult, type LlmResolve } from './conflict-ladder.js';
import { revertGuard } from './revert-guard.js';
import { SHA40 } from './delta.js';

export type RefreshMethod = 'rebuild' | 'merge';
export type SmartRefreshResult =
  | { result: 'up-to-date' }
  | { result: 'merged' | 'rebuilt'; newHead: string; method: RefreshMethod; parents?: string[]; resolved: LadderResult['resolved']; pushed: boolean }
  | { result: 'conflict'; method: RefreshMethod; card: string; remaining: FileConflict[] }
  | { result: 'needs-llm'; method: RefreshMethod; files: string[] }
  | { result: 'guard'; method: RefreshMethod; card: string }
  | { result: 'head-moved' | 'closed' | 'busy' | 'error'; why: string };

export interface SmartRefreshInput {
  repo: string; pr: number; head: string; branch: string;
  /** Remote main ref after fetch (default origin/main). */
  mainRef?: string;
  /** Squash-landed PR heads that may be inside this branch (stack parents · recent merged heads). */
  parentHeads?: readonly string[];
  /** Directory for the per-PR lock (default <tmp>/git-smart-locks). */
  lockDir?: string;
  /** false = compute and guard, but do not push (dry run / sim). */
  push?: boolean;
  /** Re-checked right before the push; false → closed. */
  stillOpen?: () => boolean;
  /** Injected runner factory (sim: fault injection). */
  gitFor?: (cwd: string) => GitRun;
}

/** Commit trailer key on every commit the smart-merge writes. */
export const SMART_MERGE_TRAILER = 'Smart-Merge';

type Step = { need: 'llm'; method: RefreshMethod; remaining: FileConflict[]; worktree: string; git: GitRun };
const LOCK_STALE_MS = 30 * 60_000;

/** Exclusive per-PR lock (O_EXCL file · stale after 30 min). Returns the release function, or null when held. */
export function acquirePrLock(dir: string, pr: number, nowMs = Date.now()): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `pr-${pr}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx'); writeSync(fd, `${process.pid} ${new Date(nowMs).toISOString()}\n`); closeSync(fd);
      return () => { try { rmSync(path, { force: true }); } catch { /* gone */ } };
    } catch {
      let stale = false;
      try { stale = nowMs - statSync(path).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
      if (!stale) return null;
      try { rmSync(path, { force: true }); } catch { return null; }
    }
  }
  return null;
}
export const lockHolder = (dir: string, pr: number): string | null => { try { return readFileSync(join(dir, `pr-${pr}.lock`), 'utf8').trim(); } catch { return null; } };

const sha = (r: { status: number | null; stdout: string }): string | null => { const s = r.stdout.trim().toLowerCase(); return r.status === 0 && SHA40.test(s) ? s : null; };

/**
 * Squash-landed heads that share non-main history with `head` (merge-base(head, H) not in main): the branch carries
 * their original commits, which main already has as a squash.
 */
export function relevantParents(git: GitRun, head: string, main: string, parentHeads: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of new Set(parentHeads.map(x => x.toLowerCase()))) {
    if (!SHA40.test(p) || p === head || git(['cat-file', '-e', `${p}^{commit}`]).status !== 0) continue;
    const mb = git(['merge-base', head, p]).stdout.trim();
    if (!SHA40.test(mb) || git(['merge-base', '--is-ancestor', mb, main]).status === 0) continue;
    out.push(p);
  }
  return out;
}
/**
 * Automatic stack-parent discovery (11-27 #40382 on #40369 · #40447 on #40441/#40444): walk the branch's own commits
 * (`head ^main`, newest first) and ask `mergedHeadOf(commit)` which squash-landed PR (not this one) contains it — the
 * GitHub «commit → pulls» association. The first hit is the newest landed parent; older layers sit below it (their
 * commits are ancestors of it), so one hit per distinct parent is enough. Bounded by `max` lookups.
 */
export function discoverParents(git: GitRun, head: string, mainRef: string, mergedHeadOf: (commit: string) => string | null, max = 40): string[] {
  const r = git(['rev-list', '--first-parent', head, `^${mainRef}`]);
  if (r.status !== 0) return [];
  const found: string[] = [];
  let looked = 0;
  for (const c of r.stdout.split('\n').filter(Boolean)) {
    if (looked++ >= max) break;
    // a commit already inside a found parent adds nothing new
    if (found.some(p => git(['merge-base', '--is-ancestor', c, p]).status === 0)) continue;
    let h: string | null = null;
    try { h = mergedHeadOf(c); } catch { h = null; }
    if (h && SHA40.test(h.toLowerCase())) found.push(h.toLowerCase());
  }
  return found;
}

/** @deprecated name kept for callers: the first relevant parent (or null). */
export const pickParent = (git: GitRun, head: string, main: string, parentHeads: readonly string[]): string | null => relevantParents(git, head, main, parentHeads)[0] ?? null;

function* refreshSteps(o: SmartRefreshInput): Generator<Step, SmartRefreshResult, LadderResult> {
  const mk = o.gitFor ?? ((cwd: string) => gitAt(cwd));
  const repo = mk(o.repo);
  const mainRef = o.mainRef ?? 'origin/main';
  const remoteRef = `refs/remotes/origin/${o.branch}`;
  const fetch = repo(['fetch', '-q', 'origin', 'main', `+refs/heads/${o.branch}:${remoteRef}`]);
  if (fetch.status !== 0) return { result: 'error', why: `fetch failed: ${fetch.stderr.trim().slice(0, 120)}` };
  const tip = sha(repo(['rev-parse', '--verify', `${remoteRef}^{commit}`]));
  if (!tip || tip !== o.head.toLowerCase()) return { result: 'head-moved', why: `branch ${o.branch} is at ${tip?.slice(0, 12) ?? '?'} (expected ${o.head.slice(0, 12)}) — force-pushed or moved` };
  const main = sha(repo(['rev-parse', '--verify', `${mainRef}^{commit}`]));
  if (!main) return { result: 'error', why: `${mainRef} unreadable` };
  const head = tip;
  let parents = relevantParents(repo, head, main, o.parentHeads ?? []);
  // A merge commit inside the own range whose result differs from a clean merge (a hand's conflict resolution or an
  // evil merge) carries own content the cherry-pick rebuild would drop → use the merge method instead.
  if (parents.length) {
    const merges = repo(['rev-list', '--merges', head, `^${main}`, ...parents.map(p => `^${p}`)]);
    if (merges.status !== 0) return { result: 'error', why: 'own merge list unreadable' };
    for (const mc of merges.stdout.split('\n').filter(Boolean)) {
      const rd = repo(['show', '--remerge-diff', '--format=', '--no-color', mc]);
      if (rd.status !== 0 || rd.stdout.trim()) { parents = []; break; }
    }
  }
  if (!parents.length && repo(['merge-base', '--is-ancestor', main, head]).status === 0) return { result: 'up-to-date' };
  const method: RefreshMethod = parents.length ? 'rebuild' : 'merge';
  const ownRevs = [head, `^${main}`, ...parents.map(p => `^${p}`)];
  const parentLabel = parents.map(p => p.slice(0, 12)).join(',');
  const dir = mkdtempSync(join(tmpdir(), `git-smart-${o.pr}-`));
  const wt = join(dir, 'wt');
  try {
    if (repo(['worktree', 'add', '-q', '--detach', wt, head]).status !== 0) return { result: 'error', why: 'worktree add failed' };
    const w = mk(wt);
    const resolved: LadderResult['resolved'] = [];
    // `Smart-Merge:` trailer — the review guard and humans read which ladder steps produced this commit.
    const trailer = (how: RefreshMethod) => `${SMART_MERGE_TRAILER}: ${how}${parents.length ? ` · parents ${parentLabel}` : ''}${resolved.length ? ` · ${[...new Set(resolved.map(x => x.rule))].join('+')}` : ''}`;
    // Resolve one stop: rerere already ran; structural; then (async drivers only) the LLM step.
    function* settleStop(what: string, gitOut: string): Generator<Step, SmartRefreshResult | null, LadderResult> {
      // (a) rerere already replayed recorded resolutions inside the merge / cherry-pick (autoUpdate staged them).
      for (const m of gitOut.matchAll(/(?:Resolved|Staged) '([^']+)' using previous resolution/g)) resolved.push({ path: m[1]!, rule: 'rerere' });
      const s = runLadderSync(w, wt);
      resolved.push(...s.resolved);
      let left = s.remaining;
      if (left.length) {
        const l = yield { need: 'llm', method, remaining: left, worktree: wt, git: w };
        resolved.push(...l.resolved); left = l.remaining;
      }
      if (left.length) return { result: 'conflict', method, card: conflictCard(what, left), remaining: left };
      return null;
    }
    let newHead: string;
    if (method === 'rebuild') {
      // Own commits only: reachable from head, not from main, not from any relevant squash-landed head.
      const own = repo(['rev-list', '--reverse', '--no-merges', ...ownRevs]);
      if (own.status !== 0) return { result: 'error', why: 'own commit list unreadable' };
      if (w(['checkout', '-q', '--detach', main]).status !== 0) return { result: 'error', why: 'checkout main failed' };
      for (const c of own.stdout.split('\n').filter(Boolean)) {
        const r = w([...SMART_MERGE_IDENTITY, ...RERERE_ARGS, 'cherry-pick', '--allow-empty', '--keep-redundant-commits', c]);
        if (r.status === 0) continue;
        if (!w(['diff', '--name-only', '--diff-filter=U']).stdout.trim() && !/conflict|could not apply/i.test(r.stdout + r.stderr)) {
          w(['cherry-pick', '--abort']);
          return { result: 'error', why: `cherry-pick ${c.slice(0, 12)} failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}` };
        }
        const stop = yield* settleStop(`rebuild #${o.pr} onto main after the squash of ${parentLabel} (commit ${c.slice(0, 12)})`, r.stdout + r.stderr);
        if (stop) { w(['cherry-pick', '--abort']); return stop; }
        forgetOwnResolutions(w);
        const cm = w([...SMART_MERGE_IDENTITY, ...NO_RERERE_ARGS, 'commit', '-q', '--no-verify', '--allow-empty', '-C', c]);
        if (cm.status !== 0) return { result: 'error', why: `commit after resolution failed: ${(cm.stderr || cm.stdout).trim().slice(0, 120)}` };
      }
      const tree = sha(w(['rev-parse', 'HEAD^{tree}']));
      if (!tree) return { result: 'error', why: 'rebuilt tree unreadable' };
      const c = sha(w([...SMART_MERGE_IDENTITY, 'commit-tree', tree, '-p', head, '-p', main, '-m',
        `smart-merge: rebuild #${o.pr} onto main ${main.slice(0, 12)} (own commits after squash-landed ${parentLabel})\n\n${trailer('rebuild')}`]));
      if (!c) return { result: 'error', why: 'commit-tree failed' };
      newHead = c;
    } else {
      const subject = `smart-merge: merge main ${main.slice(0, 12)} into #${o.pr}`;
      const m = w([...SMART_MERGE_IDENTITY, ...RERERE_ARGS, 'merge', '--no-edit', '-m', `${subject}\n\n${trailer('merge')}`, main]);
      if (m.status !== 0) {
        if (!w(['diff', '--name-only', '--diff-filter=U']).stdout.trim() && !/conflict/i.test(m.stdout + m.stderr)) {
          w(['merge', '--abort']);
          return { result: 'error', why: `merge failed: ${(m.stderr || m.stdout).trim().slice(0, 160)}` };
        }
        const stop = yield* settleStop(`merge main into #${o.pr}`, m.stdout + m.stderr);
        if (stop) { w(['merge', '--abort']); return stop; }
        forgetOwnResolutions(w);
        const cm = w([...SMART_MERGE_IDENTITY, ...NO_RERERE_ARGS, 'commit', '--no-verify', '-m', `${subject}\n\n${trailer('merge')}`]);
        if (cm.status !== 0) return { result: 'error', why: `merge commit failed: ${(cm.stderr || cm.stdout).trim().slice(0, 120)}` };
      }
      const c = sha(w(['rev-parse', 'HEAD']));
      if (!c) return { result: 'error', why: 'merge head unreadable' };
      newHead = c;
    }
    const ownBase = method === 'rebuild' ? null : sha(repo(['merge-base', main, head]));
    if (method === 'merge' && !ownBase) return { result: 'error', why: 'own merge-base unreadable' };
    const g = revertGuard(repo, { mainRef: main, result: newHead, ...(ownBase ? { ownBase, ownHead: head } : { ownRevs }) });
    if (!g.ok) return { result: 'guard', method, card: g.card ?? 'revert guard refused' };
    const done = { result: method === 'rebuild' ? 'rebuilt' as const : 'merged' as const, newHead, method, ...(parents.length ? { parents } : {}), resolved };
    if (o.push === false) return { ...done, pushed: false };
    if (o.stillOpen && !o.stillOpen()) return { result: 'closed', why: `PR #${o.pr} closed during the smart-merge — nothing pushed` };
    const ls = repo(['ls-remote', 'origin', `refs/heads/${o.branch}`]);
    const now = ls.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (ls.status !== 0) return { result: 'error', why: `ls-remote failed: ${ls.stderr.trim().slice(0, 120)} — nothing pushed` };
    if (now !== head) return { result: 'head-moved', why: `branch moved to ${now.slice(0, 12) || '?'} during the smart-merge — nothing pushed` };
    const push = repo(['push', '-q', 'origin', `${newHead}:refs/heads/${o.branch}`]);
    if (push.status !== 0) return { result: 'error', why: `push refused: ${push.stderr.trim().slice(0, 120)}` };
    return { ...done, pushed: true };
  } finally {
    repo(['worktree', 'remove', '--force', wt]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function withLock<T extends SmartRefreshResult | Promise<SmartRefreshResult>>(o: SmartRefreshInput, run: () => T): T | SmartRefreshResult {
  const lockDir = o.lockDir ?? join(tmpdir(), 'git-smart-locks');
  const release = acquirePrLock(lockDir, o.pr);
  if (!release) return { result: 'busy', why: `another smart-merge holds #${o.pr} (${lockHolder(lockDir, o.pr) ?? '?'})` };
  try {
    const r = run();
    if (r instanceof Promise) { r.finally(release).catch(() => undefined); return r; }
    release();
    return r;
  } catch (e) { release(); throw e; }
}

/** In-tick (sync): rerere + structural only. Hunks left → `needs-llm` (the caller launches the capsule) — nothing pushed. */
export function smartRefreshSync(o: SmartRefreshInput): SmartRefreshResult {
  return withLock(o, () => {
    const it = refreshSteps(o);
    const s = it.next();
    if (s.done) return s.value;
    const { method, remaining } = s.value;
    it.return({ result: 'error', why: 'deferred' }); // runs the finally (the worktree with the stopped merge is removed)
    return { result: 'needs-llm', method, files: remaining.map(f => f.path) };
  }) as SmartRefreshResult;
}

/** Capsule (async): the full ladder including the LLM step. */
export async function smartRefresh(o: SmartRefreshInput & { llm: LlmResolve }): Promise<SmartRefreshResult> {
  return withLock(o, async () => {
    const it = refreshSteps(o);
    let s = it.next();
    while (!s.done) {
      const step = s.value;
      let res: LadderResult;
      try { res = await runLadderLlm(step.git, step.worktree, step.remaining, o.llm); } catch { res = { resolved: [], remaining: step.remaining }; }
      s = it.next(res);
    }
    return s.value;
  });
}
