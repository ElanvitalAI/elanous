// ── git-fs public API ──
//
// One call path that the dashboard cares about:
//
//   const view = getGitStatusView(cwd);   // branch synchronously
//   subscribeGitChanges(cwd, () => draw()); // re-render on branch / ref change
//
// Dirty + ahead/behind are async — caller schedules refreshDirty()
// on its own cadence (dashboard throttles to ~2s).

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findGitDir, type LocatedGit } from './locate.js';
import { readGitHead } from './read-head.js';
import { GitFileWatcher } from './watcher.js';
import { probeDirty, probeAheadBehind, probeDirtyAsync, probeAheadBehindAsync } from './dirty.js';
import { debug } from '../debug/log.js';
import type {
  GitHeadInfo,
  GitStatusView,
  DirtyCount,
  AheadBehind,
} from './types.js';

export type { GitHeadInfo, GitStatusView, DirtyCount, AheadBehind, BranchRef } from './types.js';
export { listBranches } from './branches.js';
export { findGitDir } from './locate.js';
export { readGitHead } from './read-head.js';
export { probeDirty, probeAheadBehind, parsePorcelain } from './dirty.js';

const SNAPSHOT_TIMEOUT_MS = 5_000;
const SNAPSHOT_STATUS_MAX_CHARS = 2_000;
const GIT_SNAPSHOT_TTL_MS = 3_000;

interface GitSnapshotCacheEntry {
  at: number;
  value: string | null;
}

const gitSnapshotCache = new Map<string, GitSnapshotCacheEntry>();

interface CacheEntry {
  located: LocatedGit;
  head: GitHeadInfo | null;
  dirty: DirtyCount | null;
  aheadBehind: AheadBehind | null;
  lastDirtyProbeAt: number;
  watcher: GitFileWatcher;
  listeners: Set<() => void>;
}

/** LRU of resolved repo roots — one SWD is active, but /compact +
 *  multi-repo dev warrants a small cache. Cheap map with manual
 *  eviction; 16 entries > any realistic session. */
const cache = new Map<string, CacheEntry>();
const MAX_CACHE = 16;

function cacheKey(located: LocatedGit): string {
  return located.root;
}

function bumpLru(key: string): void {
  const e = cache.get(key);
  if (!e) return;
  cache.delete(key);
  cache.set(key, e);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    const ev = cache.get(oldest);
    if (ev) ev.watcher.dispose();
    cache.delete(oldest);
  }
}

function ensureEntry(cwd: string): CacheEntry | null {
  const located = findGitDir(resolve(cwd));
  if (!located) return null;
  const key = cacheKey(located);
  const existing = cache.get(key);
  if (existing) {
    bumpLru(key);
    return existing;
  }
  const head = readGitHead(located);
  const watcher = new GitFileWatcher(located, head);
  const entry: CacheEntry = {
    located,
    head,
    dirty: null,
    aheadBehind: null,
    lastDirtyProbeAt: 0,
    watcher,
    listeners: new Set(),
  };
  cache.set(key, entry);
  // Re-read HEAD + retarget watcher whenever a watched file changes.
  // One handler covers all listeners so we don't race each subscriber.
  watcher.subscribe(() => {
    entry.head = readGitHead(entry.located);
    entry.watcher.retargetForHead(entry.head);
    for (const fn of entry.listeners) {
      try { fn(); } catch { /* noop */ }
    }
  });
  bumpLru(key);
  return entry;
}

/** Synchronous status view. Branch + worktree detection only — no
 *  subprocess, no dirty info. Returns a view whose `head` is null
 *  when cwd is not inside a git repo. */
export function getGitStatusView(cwd: string): GitStatusView {
  const entry = ensureEntry(cwd);
  if (!entry) {
    return { head: null, dirty: null, aheadBehind: null, lastDirtyProbeAt: 0 };
  }
  return {
    head: entry.head,
    dirty: entry.dirty,
    aheadBehind: entry.aheadBehind,
    lastDirtyProbeAt: entry.lastDirtyProbeAt,
  };
}

/** Subscribe to HEAD / current-ref changes. Callback fires AFTER
 *  the cache has been updated, so getGitStatusView(cwd) inside the
 *  callback sees the new state. Returns an unsubscribe fn. Safe to
 *  call on a cwd that isn't a git repo — subscription is a no-op
 *  and returns a no-op unsubscribe. */
export function subscribeGitChanges(cwd: string, fn: () => void): () => void {
  const entry = ensureEntry(cwd);
  if (!entry) return () => {};
  entry.listeners.add(fn);
  return () => { entry.listeners.delete(fn); };
}

/** Kick off a dirty + aheadBehind probe. Throttled: if the last
 *  probe was < minIntervalMs ago, this is a no-op. Caller can pass
 *  force=true to bypass throttle after a known write. Returns the
 *  fresh view on completion (same object the next getGitStatusView
 *  would return). */
export function refreshDirty(
  cwd: string,
  opts: { minIntervalMs?: number; force?: boolean } = {},
): GitStatusView {
  const entry = ensureEntry(cwd);
  if (!entry) return { head: null, dirty: null, aheadBehind: null, lastDirtyProbeAt: 0 };
  const min = opts.minIntervalMs ?? 2_000;
  const now = Date.now();
  if (!opts.force && entry.lastDirtyProbeAt > 0 && now - entry.lastDirtyProbeAt < min) {
    return {
      head: entry.head,
      dirty: entry.dirty,
      aheadBehind: entry.aheadBehind,
      lastDirtyProbeAt: entry.lastDirtyProbeAt,
    };
  }
  entry.dirty = probeDirty(entry.located.root);
  entry.aheadBehind = probeAheadBehind(entry.located.root);
  entry.lastDirtyProbeAt = Date.now();
  // A dirty probe doesn't fire the listener set — listeners are for
  // branch changes. Caller that wanted the new dirty count has the
  // return value.
  return {
    head: entry.head,
    dirty: entry.dirty,
    aheadBehind: entry.aheadBehind,
    lastDirtyProbeAt: entry.lastDirtyProbeAt,
  };
}

const dirtyInFlight = new Map<CacheEntry, Promise<GitStatusView>>();

function viewOf(entry: CacheEntry): GitStatusView {
  return { head: entry.head, dirty: entry.dirty, aheadBehind: entry.aheadBehind, lastDirtyProbeAt: entry.lastDirtyProbeAt };
}

/** Non-blocking twin of `refreshDirty` for the TUI: the probes run as
 *  async subprocesses so a slow `git status` (large worktree, loaded
 *  host) never stalls key input. Same throttle; concurrent calls share
 *  one probe, except that `force` (a known write just happened) never
 *  reuses a probe that started before it. */
export function refreshDirtyAsync(
  cwd: string,
  opts: { minIntervalMs?: number; force?: boolean } = {},
): Promise<GitStatusView> {
  let entry: CacheEntry | null;
  try { entry = ensureEntry(cwd); } catch (error) { return Promise.reject(error); }
  if (!entry) return Promise.resolve({ head: null, dirty: null, aheadBehind: null, lastDirtyProbeAt: 0 });
  // An in-flight probe (possibly a forced, post-write one) is newer than the last stored view.
  const running = dirtyInFlight.get(entry);
  if (running && !opts.force) return running;
  const min = opts.minIntervalMs ?? 2_000;
  if (!opts.force && entry.lastDirtyProbeAt > 0 && Date.now() - entry.lastDirtyProbeAt < min) {
    return Promise.resolve(viewOf(entry));
  }
  const target = entry;
  const root = target.located.root;
  const start = (): Promise<GitStatusView> => Promise.all([probeDirtyAsync(root), probeAheadBehindAsync(root)])
    .then(([dirty, aheadBehind]) => {
      target.dirty = dirty;
      target.aheadBehind = aheadBehind;
      target.lastDirtyProbeAt = Date.now();
      return viewOf(target);
    });
  // A forced probe queues behind the running one so it reads the post-write tree.
  const probe = (running ? running.then(start, start) : start())
    .finally(() => { if (dirtyInFlight.get(target) === probe) dirtyInFlight.delete(target); });
  dirtyInFlight.set(target, probe);
  return probe;
}

/** Claude Code-style git snapshot for LLM system context.
 *  This is intentionally a point-in-time summary: good enough for
 *  baseline repo awareness, but callers should still use tools for
 *  fresh state after mutations. Returns null outside a git repo. */
export function buildGitSnapshot(
  cwd: string,
  opts: { now?: () => number; ttlMs?: number } = {},
): string | null {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? GIT_SNAPSHOT_TTL_MS;
  const at = now();
  const key = resolve(cwd);
  const cached = gitSnapshotCache.get(key);
  if (cached && at - cached.at < ttlMs) {
    debug.log('git-fs.snapshot', 'cache-hit', { cwd, ageMs: at - cached.at });
    return cached.value;
  }

  const view = refreshDirty(cwd, { force: true });
  let value: string | null = null;
  if (view.head) {
    const branch = view.head.branch ?? `HEAD@${view.head.sha?.slice(0, 7) ?? 'unknown'}`;
    const mainBranch = detectDefaultBranch(cwd);
    const status = runGit(cwd, ['status', '--short']);
    const recentLog = runGit(cwd, ['log', '--oneline', '-n', '5']);
    const userName = runGit(cwd, ['config', 'user.name']);
    const truncatedStatus = status.length > SNAPSHOT_STATUS_MAX_CHARS
      ? `${status.slice(0, SNAPSHOT_STATUS_MAX_CHARS)}\n... (truncated; run git status for more)`
      : status;

    const parts = [
      'This is the git status at the start of this turn. It is a snapshot and will not update during the turn.',
      `Current branch: ${branch}${view.head.isWorktree ? ' (worktree)' : ''}`,
      mainBranch ? `Main branch: ${mainBranch}` : '',
      userName ? `Git user: ${userName}` : '',
      view.aheadBehind
        ? `Upstream: ahead ${view.aheadBehind.ahead}, behind ${view.aheadBehind.behind}`
        : '',
      `Status:\n${truncatedStatus || '(clean)'}`,
      `Recent commits:\n${recentLog || '(none)'}`,
    ].filter(Boolean);
    value = parts.join('\n\n');
  }

  gitSnapshotCache.set(key, { at, value });
  debug.log('git-fs.snapshot', 'built', { cwd, ageMs: 0 });
  return value;
}

/** Explicitly discard cached git snapshots, including cached non-repositories. */
export function clearGitSnapshotCache(): void {
  gitSnapshotCache.clear();
}

function detectDefaultBranch(cwd: string): string | null {
  const symbolic = runGit(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (symbolic.startsWith('refs/remotes/origin/')) {
    return symbolic.slice('refs/remotes/origin/'.length).trim() || null;
  }
  for (const candidate of ['main', 'master', 'develop']) {
    const ok = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], {
      cwd,
      timeout: SNAPSHOT_TIMEOUT_MS,
      stdio: 'ignore',
    });
    if (ok.status === 0) return candidate;
  }
  return null;
}

function runGit(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (res.status !== 0 || res.error) return '';
  return String(res.stdout ?? '').trim();
}

/** Test helper — drop the cache + dispose every watcher. */
export function __resetGitFsCache(): void {
  for (const [, entry] of cache) entry.watcher.dispose();
  cache.clear();
  clearGitSnapshotCache();
  dirtyInFlight.clear();
}
