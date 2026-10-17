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
import { execFile, spawnSync } from 'node:child_process';
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
/** A cached snapshot older than this is rebuilt in the background on the next periodic dirty tick. */
const GIT_SNAPSHOT_KEEP_WARM_MS = 30_000;

interface GitSnapshotCacheEntry {
  at: number;
  /** Monotonic store ordering — `at` can flip within the same millisecond. */
  version: number;
  value: string | null;
}

const gitSnapshotCache = new Map<string, GitSnapshotCacheEntry>();
/** The entry an invalidation (known write · HEAD move) just evicted. Only the
 *  stale-while-revalidate turn path reads it, and only while it is younger than
 *  its window: the turn is served the last snapshot (its header states when it
 *  was taken) while the background rebuild runs, instead of rebuilding
 *  synchronously on the event loop. Any later store supersedes it. */
const gitSnapshotLastKnown = new Map<string, GitSnapshotCacheEntry>();

function storeGitSnapshot(key: string, entry: Omit<GitSnapshotCacheEntry, 'version'>): void {
  gitSnapshotCache.set(key, { ...entry, version: bumpGitSnapshotVersion(key) });
  gitSnapshotLastKnown.delete(key);
}

function evictGitSnapshot(key: string): boolean {
  const entry = gitSnapshotCache.get(key);
  if (!entry) return false;
  gitSnapshotCache.delete(key);
  gitSnapshotLastKnown.set(key, entry);
  return true;
}
/** One background snapshot rebuild per cwd and invalidation generation. */
const gitSnapshotInFlight = new Map<string, { generation: string; promise: Promise<string | null> }>();

/** Per-key monotonic store version: async rebuilds never overwrite a newer
 *  sync value, not even when both land in the same millisecond (`at`
 *  comparisons can flip). Generation guards invalidation races instead. */
const gitSnapshotVersion = new Map<string, number>();

function gitSnapshotVersionOf(key: string): number {
  return gitSnapshotVersion.get(key) ?? 0;
}

function bumpGitSnapshotVersion(key: string): number {
  const version = gitSnapshotVersionOf(key) + 1;
  gitSnapshotVersion.set(key, version);
  return version;
}

/** Test-only hold seam (production null): parks an async rebuild after its
 *  reads and before its store, so «a write during a rebuild wins» is provable
 *  deterministically instead of by racing timers. */
let gitSnapshotRebuildHold: (() => void | Promise<void>) | null = null;

export function __setGitSnapshotRebuildHoldForTest(hold: (() => void | Promise<void>) | null): void {
  gitSnapshotRebuildHold = hold;
}

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
    const before = entry.head;
    entry.head = readGitHead(entry.located);
    entry.watcher.retargetForHead(entry.head);
    // A branch/ref move makes every cached snapshot's branch + log lines wrong. Only a real
    // move: macOS fs.watch also replays the ref write that happened just before the watch was
    // installed (measured: refs/heads/main «change» right after the first build), and that
    // spurious event must not evict a fresh snapshot.
    if (headMoved(before, entry.head)) invalidateAllGitSnapshots();
    else debug.log('git-fs.snapshot', 'watch-event-head-unchanged', { root: entry.located.root });
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
 *  one probe. `force` also marks cached LLM snapshots stale and rebuilds
 *  them in the background — a known write happened. */
export function refreshDirtyAsync(
  cwd: string,
  opts: { minIntervalMs?: number; force?: boolean } = {},
): Promise<GitStatusView> {
  let entry: CacheEntry | null;
  try { entry = ensureEntry(cwd); } catch (error) { return Promise.reject(error); }
  if (!entry) return Promise.resolve({ head: null, dirty: null, aheadBehind: null, lastDirtyProbeAt: 0 });
  // An in-flight probe (possibly a forced, post-write one) is newer than the last stored view —
  // a throttled call joins it instead of returning the pre-write view (#27493 contract).
  const running = dirtyInFlight.get(entry);
  if (running && !opts.force) return running;
  const min = opts.minIntervalMs ?? 2_000;
  if (!opts.force && entry.lastDirtyProbeAt > 0 && Date.now() - entry.lastDirtyProbeAt < min) {
    return Promise.resolve(viewOf(entry));
  }
  const probe = probeDirtyAsyncFor(entry, { fresh: !!opts.force });
  // After the post-write probe is queued, so the snapshot rebuild joins it instead of an older one.
  if (opts.force) invalidateGitSnapshots(cwd);
  // Keep-warm: the dashboard's periodic (non-forced) dirty tick also re-warms a snapshot that is in
  // use, so a turn typed after an idle stretch is served within the stale window instead of falling
  // back to the synchronous build. Only snapshots already cached are kept warm.
  else if (gitSnapshotCache.has(resolve(cwd)) || gitSnapshotLastKnown.has(resolve(cwd))) void refreshGitSnapshotAsync(cwd, { ifOlderThanMs: GIT_SNAPSHOT_KEEP_WARM_MS });
  return probe;
}

/** Share the in-flight probe, unless the caller needs one that started after
 *  now (`fresh`: a known write just happened) — then queue a new probe behind it. */
function probeDirtyAsyncFor(entry: CacheEntry, opts: { fresh: boolean }): Promise<GitStatusView> {
  const running = dirtyInFlight.get(entry);
  if (running && !opts.fresh) return running;
  const root = entry.located.root;
  const start = (): Promise<GitStatusView> => Promise.all([probeDirtyAsync(root), probeAheadBehindAsync(root)])
    .then(([dirty, aheadBehind]) => {
      entry.dirty = dirty;
      entry.aheadBehind = aheadBehind;
      entry.lastDirtyProbeAt = Date.now();
      return viewOf(entry);
    });
  const probe = (running ? running.then(start, start) : start())
    .finally(() => { if (dirtyInFlight.get(entry) === probe) dirtyInFlight.delete(entry); });
  dirtyInFlight.set(entry, probe);
  return probe;
}

/** Claude Code-style git snapshot for LLM system context.
 *  This is intentionally a point-in-time summary: good enough for
 *  baseline repo awareness, but callers should still use tools for
 *  fresh state after mutations. Returns null outside a git repo. */
export function buildGitSnapshot(
  cwd: string,
  opts: { now?: () => number; ttlMs?: number; staleWhileRevalidateMs?: number } = {},
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
  // Stale-while-revalidate (TUI turn path): serve the recent snapshot now
  // and rebuild it off the event loop for the next turn.
  if (cached && opts.staleWhileRevalidateMs !== undefined && at - cached.at < opts.staleWhileRevalidateMs) {
    debug.log('git-fs.snapshot', 'stale-hit', { cwd, ageMs: at - cached.at });
    void refreshGitSnapshotAsync(cwd);
    return cached.value;
  }
  // Invalidated (known write · HEAD move) and the background rebuild has not
  // stored yet: serve the evicted snapshot rather than a synchronous rebuild —
  // the TYPING-LAG this path exists to remove. Bounded by the same window.
  const evicted = !cached ? gitSnapshotLastKnown.get(key) : undefined;
  if (evicted && opts.staleWhileRevalidateMs !== undefined && at - evicted.at < opts.staleWhileRevalidateMs) {
    debug.log('git-fs.snapshot', 'stale-after-invalidate', { cwd, ageMs: at - evicted.at, rebuilding: gitSnapshotInFlight.has(key) });
    void refreshGitSnapshotAsync(cwd);
    return evicted.value;
  }

  const view = refreshDirty(cwd, { force: true });
  let value: string | null = null;
  if (view.head) {
    value = composeGitSnapshot(view, {
      mainBranch: detectDefaultBranch(cwd),
      status: runGit(cwd, ['status', '--short']),
      recentLog: runGit(cwd, ['log', '--oneline', '-n', '5']),
      userName: runGit(cwd, ['config', 'user.name']),
      generatedAt: at,
    });
  }

  storeGitSnapshot(key, { at, value });
  debug.log('git-fs.snapshot', 'built', { cwd, ageMs: 0 });
  return value;
}

function composeGitSnapshot(
  view: GitStatusView,
  git: { mainBranch: string | null; status: string; recentLog: string; userName: string; generatedAt: number },
): string {
  const head = view.head!;
  const branch = head.branch ?? `HEAD@${head.sha?.slice(0, 7) ?? 'unknown'}`;
  const truncatedStatus = git.status.length > SNAPSHOT_STATUS_MAX_CHARS
    ? `${git.status.slice(0, SNAPSHOT_STATUS_MAX_CHARS)}\n... (truncated; run git status for more)`
    : git.status;
  const parts = [
    `This is the git status as of ${new Date(git.generatedAt).toISOString()}. It is a snapshot and will not update during the turn.`,
    `Current branch: ${branch}${head.isWorktree ? ' (worktree)' : ''}`,
    git.mainBranch ? `Main branch: ${git.mainBranch}` : '',
    git.userName ? `Git user: ${git.userName}` : '',
    view.aheadBehind
      ? `Upstream: ahead ${view.aheadBehind.ahead}, behind ${view.aheadBehind.behind}`
      : '',
    `Status:\n${truncatedStatus || '(clean)'}`,
    `Recent commits:\n${git.recentLog || '(none)'}`,
  ].filter(Boolean);
  return parts.join('\n\n');
}

/** Rebuild the snapshot for `cwd` with async subprocesses and store it.
 *  Concurrent calls share one rebuild. Never throws. `ifOlderThanMs` turns it
 *  into a keep-warm tick: a cached snapshot younger than that is left alone. */
export function refreshGitSnapshotAsync(cwd: string, opts: { ifOlderThanMs?: number } = {}): Promise<string | null> {
  const key = resolve(cwd);
  const cached = gitSnapshotCache.get(key);
  if (cached && opts.ifOlderThanMs !== undefined && Date.now() - cached.at < opts.ifOlderThanMs) {
    return Promise.resolve(cached.value);
  }
  const generation = snapshotGeneration(key);
  const running = gitSnapshotInFlight.get(key);
  if (running && running.generation === generation) return running.promise;
  const startedAt = Date.now();
  const startVersion = gitSnapshotVersionOf(key);
  const rebuild = (async (): Promise<string | null> => {
    const entry = ensureEntry(cwd);
    // Joins the in-flight probe; callers that need a post-write/post-move probe queue a fresh one first.
    const view = entry ? await probeDirtyAsyncFor(entry, { fresh: false }) : getGitStatusView(cwd);
    let value: string | null = null;
    if (view.head) {
      const [mainBranch, status, recentLog, userName] = await Promise.all([
        detectDefaultBranchAsync(cwd),
        runGitAsync(cwd, ['status', '--short']),
        runGitAsync(cwd, ['log', '--oneline', '-n', '5']),
        runGitAsync(cwd, ['config', 'user.name']),
      ]);
      // «as of» = when the reads finished, not when the rebuild was queued.
      value = composeGitSnapshot(view, { mainBranch, status, recentLog, userName, generatedAt: Date.now() });
    }
    // Test-only hold seam: reads are done, the store decision is next.
    if (gitSnapshotRebuildHold) await gitSnapshotRebuildHold();
    // An invalidation that landed mid-rebuild wins: keep the entry stale.
    // A newer entry (e.g. a synchronous build that overlapped this rebuild) is
    // kept — ordered by monotonic version, never by `at` (same-ms flips).
    const current = gitSnapshotCache.get(key);
    if (snapshotGeneration(key) === generation && !(current && current.version > startVersion)) {
      storeGitSnapshot(key, { at: startedAt, value });
    }
    debug.log('git-fs.snapshot', 'rebuilt-async', { cwd, ms: Date.now() - startedAt });
    return value;
  })()
    .catch(() => null)
    .finally(() => { if (gitSnapshotInFlight.get(key)?.promise === rebuild) gitSnapshotInFlight.delete(key); });
  gitSnapshotInFlight.set(key, { generation, promise: rebuild });
  return rebuild;
}

/** Invalidation generations: a rebuild only stores its result when no
 *  invalidation (per cwd or global) landed while it was running. */
const gitSnapshotGeneration = new Map<string, number>();
let allGitSnapshotsGeneration = 0;

function snapshotGeneration(key: string): string {
  return `${allGitSnapshotsGeneration}:${gitSnapshotGeneration.get(key) ?? 0}`;
}

function invalidateAllGitSnapshots(): void {
  // Snapshots that were in use (cached or being rebuilt) are re-warmed for the next turn.
  const inUse = new Set([...gitSnapshotCache.keys(), ...gitSnapshotInFlight.keys()]);
  for (const key of [...gitSnapshotCache.keys()]) evictGitSnapshot(key);
  allGitSnapshotsGeneration += 1;
  // Probes already running read the old ref's upstream — queue one fresh probe per repo behind
  // them, so the rebuilds below join it instead.
  const entries = new Set<CacheEntry>();
  for (const key of inUse) {
    const entry = ensureEntry(key);
    if (entry) entries.add(entry);
  }
  for (const entry of entries) void probeDirtyAsyncFor(entry, { fresh: true });
  for (const key of inUse) void refreshGitSnapshotAsync(key);
}

/** A known write happened: the cached snapshot must not be served again.
 *  When a snapshot was in use (cached or being rebuilt), rebuild it in the
 *  background so the next turn usually still hits. */
function invalidateGitSnapshots(cwd: string): void {
  const key = resolve(cwd);
  const wasCached = evictGitSnapshot(key);
  const wasRebuilding = gitSnapshotInFlight.has(key);
  gitSnapshotGeneration.set(key, (gitSnapshotGeneration.get(key) ?? 0) + 1);
  // An in-flight rebuild of the old generation will be discarded — schedule its replacement.
  if (wasCached || wasRebuilding) void refreshGitSnapshotAsync(cwd);
}

function headMoved(before: GitHeadInfo | null | undefined, after: GitHeadInfo | null | undefined): boolean {
  if (!before || !after) return before !== after;
  return before.branch !== after.branch || before.sha !== after.sha || before.detached !== after.detached;
}

/** Explicitly discard cached git snapshots, including cached non-repositories. */
export function clearGitSnapshotCache(): void {
  gitSnapshotCache.clear();
  gitSnapshotLastKnown.clear();
  allGitSnapshotsGeneration += 1;
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

async function detectDefaultBranchAsync(cwd: string): Promise<string | null> {
  const symbolic = await runGitAsync(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (symbolic.startsWith('refs/remotes/origin/')) {
    return symbolic.slice('refs/remotes/origin/'.length).trim() || null;
  }
  for (const candidate of ['main', 'master', 'develop']) {
    if (await gitSucceeds(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])) return candidate;
  }
  return null;
}

function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return new Promise((resolveOk) => {
    try { execFile('git', args, { cwd, timeout: SNAPSHOT_TIMEOUT_MS }, (error) => resolveOk(!error)); }
    catch { resolveOk(false); }
  });
}

function runGitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveOut) => {
    try {
      execFile('git', args, { cwd, encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        resolveOut(error ? '' : String(stdout ?? '').trim());
      });
    } catch { resolveOut(''); }
  });
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

/** Test helper — the cached snapshot for `cwd` without building one. */
export function __peekGitSnapshot(cwd: string): string | null | undefined {
  return gitSnapshotCache.get(resolve(cwd))?.value;
}

/** Test helper — what a HEAD move does to cached snapshots. */
export function __invalidateAllGitSnapshotsForTest(): void {
  invalidateAllGitSnapshots();
}

/** Test helper — drop the cache + dispose every watcher. */
export function __resetGitFsCache(): void {
  for (const [, entry] of cache) entry.watcher.dispose();
  cache.clear();
  clearGitSnapshotCache();
  gitSnapshotInFlight.clear();
  dirtyInFlight.clear();
  gitSnapshotGeneration.clear();
  gitSnapshotVersion.clear();
}
