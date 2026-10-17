// ── git-fs module (GT1) ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  findGitDir,
  readGitHead,
  parsePorcelain,
  listBranches,
  buildGitSnapshot,
  clearGitSnapshotCache,
  getGitStatusView,
  subscribeGitChanges,
  refreshDirty,
  refreshDirtyAsync,
  refreshGitSnapshotAsync,
  __invalidateAllGitSnapshotsForTest,
  __peekGitSnapshot,
  __resetGitFsCache,
  __setGitSnapshotRebuildHoldForTest,
} from '../src/git-fs/index.js';
import { buildSessionRuntimeSystemMessages } from '../src/session-runtime/index.js';

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

describe('git-fs: findGitDir', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfs-repo-'));
    runGit(repo, ['init', '-q', '-b', 'main']);
    __resetGitFsCache();
  });

  afterEach(() => {
    __resetGitFsCache();
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('finds .git dir from repo root', () => {
    const loc = findGitDir(repo);
    expect(loc).not.toBeNull();
    expect(loc!.root).toBe(resolve(repo));
    expect(loc!.isWorktree).toBe(false);
    expect(loc!.gitDir).toBe(join(resolve(repo), '.git'));
  });

  test('walks up from a subdir', () => {
    const sub = join(repo, 'a', 'b', 'c');
    mkdirSync(sub, { recursive: true });
    const loc = findGitDir(sub);
    expect(loc).not.toBeNull();
    expect(loc!.root).toBe(resolve(repo));
  });

  test('returns null outside any repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gitfs-outside-'));
    try {
      const loc = findGitDir(outside);
      expect(loc).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('resolves worktree .git file to the real gitdir', () => {
    // Need at least one commit before creating a worktree.
    writeFileSync(join(repo, 'a.txt'), 'hi');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'init']);
    const wt = mkdtempSync(join(tmpdir(), 'gitfs-wt-'));
    try {
      runGit(repo, ['worktree', 'add', '-q', '-b', 'feat', wt]);
      const loc = findGitDir(wt);
      expect(loc).not.toBeNull();
      expect(loc!.isWorktree).toBe(true);
      // commonGitDir should point back at main repo's .git
      expect(loc!.commonGitDir).toContain(resolve(repo));
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('git-fs: readGitHead', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfs-head-'));
    runGit(repo, ['init', '-q', '-b', 'main']);
    __resetGitFsCache();
  });

  afterEach(() => {
    __resetGitFsCache();
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('fresh repo with no commits: branch is set, sha is null', () => {
    const loc = findGitDir(repo)!;
    const head = readGitHead(loc);
    expect(head).not.toBeNull();
    expect(head!.branch).toBe('main');
    expect(head!.sha).toBeNull();
    expect(head!.detached).toBe(false);
  });

  test('after a commit: sha resolves', () => {
    writeFileSync(join(repo, 'a'), '1');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'c1']);
    const loc = findGitDir(repo)!;
    const head = readGitHead(loc);
    expect(head!.branch).toBe('main');
    expect(head!.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('detached HEAD: branch null, detached true', () => {
    writeFileSync(join(repo, 'a'), '1');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'c1']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    runGit(repo, ['checkout', '-q', '--detach', sha]);
    const loc = findGitDir(repo)!;
    const head = readGitHead(loc);
    expect(head!.branch).toBeNull();
    expect(head!.detached).toBe(true);
    expect(head!.sha).toBe(sha);
  });

  test('packed refs: branch still resolves', () => {
    writeFileSync(join(repo, 'a'), '1');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'c1']);
    runGit(repo, ['pack-refs', '--all']);
    const loc = findGitDir(repo)!;
    const head = readGitHead(loc);
    expect(head!.branch).toBe('main');
    expect(head!.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('git-fs: parsePorcelain', () => {
  test('empty → clean', () => {
    expect(parsePorcelain('')).toEqual({ modified: 0, staged: 0, untracked: 0, total: 0 });
  });

  test('untracked only', () => {
    const d = parsePorcelain('?? new.ts\n?? other.md\n');
    expect(d).toEqual({ modified: 0, staged: 0, untracked: 2, total: 2 });
  });

  test('mix: staged, modified, untracked', () => {
    const out = [
      'M  a.ts',      // staged
      ' M b.ts',      // modified only
      'MM c.ts',      // both
      'A  d.ts',      // staged-added
      '?? new.md',    // untracked
    ].join('\n');
    const d = parsePorcelain(out);
    expect(d.staged).toBe(3);    // a, c, d
    expect(d.modified).toBe(2);  // b, c
    expect(d.untracked).toBe(1); // new.md
    expect(d.total).toBe(6);
  });

  test('rename counts as staged', () => {
    const d = parsePorcelain('R  old.ts -> new.ts\n');
    expect(d.staged).toBe(1);
  });
});

describe('git-fs: getGitStatusView + refreshDirty', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfs-view-'));
    runGit(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'clean');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'c1']);
    __resetGitFsCache();
  });

  afterEach(() => {
    __resetGitFsCache();
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('view contains branch + sha', () => {
    const v = getGitStatusView(repo);
    expect(v.head).not.toBeNull();
    expect(v.head!.branch).toBe('main');
    expect(v.head!.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('refreshDirty detects an untracked file', () => {
    writeFileSync(join(repo, 'new.md'), 'x');
    const v = refreshDirty(repo, { force: true });
    expect(v.dirty).not.toBeNull();
    expect(v.dirty!.untracked).toBeGreaterThanOrEqual(1);
  });

  test('throttle: back-to-back probes reuse cache', () => {
    refreshDirty(repo, { force: true });
    const first = getGitStatusView(repo).lastDirtyProbeAt;
    // Next call without force should keep the timestamp.
    refreshDirty(repo);
    const second = getGitStatusView(repo).lastDirtyProbeAt;
    expect(second).toBe(first);
  });

  test('outside repo → null head', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gitfs-nope-'));
    try {
      const v = getGitStatusView(outside);
      expect(v.head).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('git-fs: subscribeGitChanges', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfs-sub-'));
    runGit(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a'), '1');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'c1']);
    __resetGitFsCache();
  });

  afterEach(() => {
    __resetGitFsCache();
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('no-op unsubscribe when cwd is not a repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gitfs-no-'));
    try {
      const off = subscribeGitChanges(outside, () => {});
      expect(typeof off).toBe('function');
      off();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('branch switch fires the subscription', async () => {
    let fired = 0;
    const off = subscribeGitChanges(repo, () => { fired += 1; });
    try {
      runGit(repo, ['switch', '-q', '-c', 'feat']);
      // fs.watch is async; poll for up to 500ms.
      const deadline = Date.now() + 500;
      while (fired === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      expect(fired).toBeGreaterThan(0);
      const v = getGitStatusView(repo);
      expect(v.head!.branch).toBe('feat');
    } finally {
      off();
    }
  });
});

describe('git-fs: listBranches', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfs-br-'));
    runGit(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a'), '1');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'c1']);
    runGit(repo, ['branch', 'feat-a']);
    runGit(repo, ['branch', 'feat-b']);
    __resetGitFsCache();
  });

  afterEach(() => {
    __resetGitFsCache();
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('lists local branches, marks HEAD', () => {
    const v = getGitStatusView(repo);
    const brs = listBranches(repo, v.head);
    const names = brs.map(b => b.name);
    expect(names).toContain('main');
    expect(names).toContain('feat-a');
    expect(names).toContain('feat-b');
    const main = brs.find(b => b.name === 'main')!;
    expect(main.isHead).toBe(true);
    expect(main.isRemote).toBe(false);
  });
});

describe('git-fs: buildGitSnapshot', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfs-snapshot-'));
    runGit(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'hello');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'init']);
    __resetGitFsCache();
  });

  afterEach(() => {
    __resetGitFsCache();
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('returns a Claude Code-style snapshot inside a repo', () => {
    writeFileSync(join(repo, 'b.txt'), 'dirty');
    const snapshot = buildGitSnapshot(repo);
    expect(snapshot).not.toBeNull();
    expect(snapshot!).toContain('Current branch: main');
    expect(snapshot!).toContain('Status:');
    expect(snapshot!).toContain('?? b.txt');
    expect(snapshot!).toContain('Recent commits:');
  });

  test('returns null outside a repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gitfs-snapshot-outside-'));
    try {
      expect(buildGitSnapshot(outside)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('reuses a snapshot within the TTL and refreshes after expiry', () => {
    let now = 1_000;
    const first = buildGitSnapshot(repo, { now: () => now });
    writeFileSync(join(repo, 'cached.txt'), 'dirty');

    now = 2_000;
    const cached = buildGitSnapshot(repo, { now: () => now });
    expect(cached).toBe(first);
    expect(cached!).not.toContain('?? cached.txt');

    now = 4_000;
    const refreshed = buildGitSnapshot(repo, { now: () => now });
    expect(refreshed!).toContain('?? cached.txt');
  });

  test('clearing the snapshot cache refreshes before TTL expiry', () => {
    let now = 1_000;
    buildGitSnapshot(repo, { now: () => now });
    writeFileSync(join(repo, 'cleared.txt'), 'dirty');

    clearGitSnapshotCache();
    now = 2_000;
    expect(buildGitSnapshot(repo, { now: () => now })!).toContain('?? cleared.txt');
  });

  test('caches null snapshots outside a git repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gitfs-snapshot-null-cache-'));
    let now = 1_000;
    try {
      expect(buildGitSnapshot(outside, { now: () => now })).toBeNull();
      runGit(outside, ['init', '-q', '-b', 'main']);

      now = 2_000;
      expect(buildGitSnapshot(outside, { now: () => now })).toBeNull();

      now = 5_000;
      expect(buildGitSnapshot(outside, { now: () => now })).not.toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// TUI-TYPING-LAG — the TUI probes git without blocking its event loop.
/** Wait until the background rebuild stored a snapshot containing `needle` (no sync build). */
async function waitForPeek(repo: string, needle: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (__peekGitSnapshot(repo)?.includes(needle)) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

describe('git-fs: async refresh + stale-while-revalidate snapshot', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfs-async-'));
    runGit(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'hello');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'init']);
    __resetGitFsCache();
  });

  afterEach(() => {
    __setGitSnapshotRebuildHoldForTest(null);
    __resetGitFsCache();
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('refreshDirtyAsync matches the sync probe and shares one in-flight probe', async () => {
    writeFileSync(join(repo, 'new.md'), 'x');
    const first = refreshDirtyAsync(repo, { force: true });
    const second = refreshDirtyAsync(repo, { minIntervalMs: 0 });
    expect(second).toBe(first);
    const view = await first;
    expect(view.dirty).toEqual(refreshDirty(repo, { force: true }).dirty);
    expect(view.dirty!.untracked).toBe(1);
  });

  test('refreshDirtyAsync throttles like the sync probe', async () => {
    await refreshDirtyAsync(repo, { force: true });
    const first = getGitStatusView(repo).lastDirtyProbeAt;
    await refreshDirtyAsync(repo);
    expect(getGitStatusView(repo).lastDirtyProbeAt).toBe(first);
  });

  test('a throttled call during a forced probe joins it instead of returning the pre-write view', async () => {
    await refreshDirtyAsync(repo, { force: true });
    writeFileSync(join(repo, 'joined.txt'), 'dirty');
    const forced = refreshDirtyAsync(repo, { force: true });
    const throttled = refreshDirtyAsync(repo);
    expect(throttled).toBe(forced);
    expect((await throttled).dirty!.untracked).toBe(1);
  });

  test('refreshDirtyAsync outside a repo resolves an empty view', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gitfs-async-outside-'));
    try {
      expect((await refreshDirtyAsync(outside)).head).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('async rebuild produces the same snapshot text as the sync build', async () => {
    writeFileSync(join(repo, 'b.txt'), 'dirty');
    const asyncSnapshot = await refreshGitSnapshotAsync(repo);
    clearGitSnapshotCache();
    // Only the header line may differ: it states the actual generation time.
    const withoutHeader = (s: string) => s!.split('\n\n').slice(1).join('\n\n');
    expect(withoutHeader(asyncSnapshot!)).toBe(withoutHeader(buildGitSnapshot(repo)!));
  });

  test('a stale snapshot is served and the turn path itself schedules the rebuild', async () => {
    const first = buildGitSnapshot(repo);
    writeFileSync(join(repo, 'later.txt'), 'dirty');
    const served = buildGitSnapshot(repo, { ttlMs: 0, staleWhileRevalidateMs: 60_000 });
    expect(served).toBe(first);
    // No explicit refresh and no sync build: only the stale-hit's own background rebuild can fill this.
    expect(await waitForPeek(repo, 'later.txt')).toBe(true);
    expect(buildGitSnapshot(repo, { ttlMs: 60_000 })).toBe(__peekGitSnapshot(repo)!);
  });

  test('a forced dirty refresh (known write) re-warms the snapshot in the background', async () => {
    buildGitSnapshot(repo);
    writeFileSync(join(repo, 'edited.txt'), 'dirty');
    await refreshDirtyAsync(repo, { force: true });
    expect(await waitForPeek(repo, 'edited.txt')).toBe(true);
    expect(buildGitSnapshot(repo, { ttlMs: 60_000, staleWhileRevalidateMs: 60_000 })!).toContain('?? edited.txt');
  });

  test('a background rebuild never overwrites a newer synchronous snapshot', async () => {
    buildGitSnapshot(repo);
    const rebuild = refreshGitSnapshotAsync(repo, { ifOlderThanMs: 0 });
    // A synchronous build lands while the rebuild (started earlier) is still running.
    writeFileSync(join(repo, 'sync-newer.txt'), 'dirty');
    const syncValue = buildGitSnapshot(repo, { ttlMs: 0 });
    await rebuild;
    expect(__peekGitSnapshot(repo)).toBe(syncValue);
    expect(syncValue!).toContain('?? sync-newer.txt');
  });

  test('a forced probe after a write does not reuse a probe that started before the write', async () => {
    buildGitSnapshot(repo);
    const before = refreshDirtyAsync(repo, { minIntervalMs: 0 });
    writeFileSync(join(repo, 'raced.txt'), 'dirty');
    const forced = refreshDirtyAsync(repo, { force: true });
    expect(forced).not.toBe(before);
    expect((await forced).dirty!.untracked).toBe(1);
    const rebuilt = await refreshGitSnapshotAsync(repo);
    expect(rebuilt!).toContain('?? raced.txt');
    expect(buildGitSnapshot(repo, { ttlMs: 60_000 })!).toContain('?? raced.txt');
  });

  test('a real HEAD move re-warms the snapshot so branch and upstream match the new ref', async () => {
    // feature is one commit ahead of main and tracks it (a real configured
    // upstream), so the new ref's upstream state (ahead 1, behind 0) is
    // distinguishable from main's (no upstream at all).
    runGit(repo, ['switch', '-q', '-c', 'feature']);
    writeFileSync(join(repo, 'f.txt'), 'feature');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'feature']);
    runGit(repo, ['config', 'branch.feature.remote', '.']);
    runGit(repo, ['config', 'branch.feature.merge', 'refs/heads/main']);
    runGit(repo, ['switch', '-q', 'main']);

    const warm = buildGitSnapshot(repo);
    expect(warm!).toContain('Current branch: main');
    expect(warm!).not.toContain('Upstream:');
    // The real move: main → feature.
    runGit(repo, ['switch', '-q', 'feature']);
    // Wait for the observable completion: the watcher invalidated and the background rebuild stored a new snapshot.
    for (let i = 0; i < 200 && !__peekGitSnapshot(repo)?.includes('Current branch: feature'); i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(__peekGitSnapshot(repo)!).toContain('Current branch: feature');
    expect(__peekGitSnapshot(repo)!).toContain('Upstream: ahead 1, behind 0');
    // Written after the re-warm: a synchronous rebuild would list it, the warm cache does not.
    writeFileSync(join(repo, 'after-warm.txt'), 'dirty');
    const served = buildGitSnapshot(repo, { ttlMs: 60_000, staleWhileRevalidateMs: 60_000 });
    expect(served!).toContain('Current branch: feature');
    expect(served!).toContain('Upstream: ahead 1, behind 0');
    expect(served!).not.toContain('after-warm.txt');
  });

  test('store ordering is judged by a monotonic version, not wall-clock `at` (same-millisecond flip)', async () => {
    // Warm the cache with a frozen clock.
    buildGitSnapshot(repo, { now: () => 1_000, ttlMs: 0 });
    let release!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(r => { enteredResolve = r; });
    let holds = 0;
    __setGitSnapshotRebuildHoldForTest(() => {
      holds += 1;
      if (holds === 1) { enteredResolve(); return new Promise<void>(r => { release = r; }); }
    });
    writeFileSync(join(repo, 'one.txt'), '1');
    const t0 = Date.now();
    const rebuild = refreshGitSnapshotAsync(repo);
    await entered; // The rebuild read git (one.txt only) and now waits before storing.
    writeFileSync(join(repo, 'two.txt'), '2');
    // A synchronous build whose `at` is no newer than the rebuild's start — the
    // old wall-clock comparison (`current.at > startedAt`) could not tell these
    // apart, and a same-millisecond `at` flips the decision.
    const syncValue = buildGitSnapshot(repo, { ttlMs: 0, now: () => t0 - 1_000 });
    expect(syncValue!).toContain('?? two.txt');
    release();
    await rebuild;
    // The held rebuild (one.txt only) must not overwrite the newer synchronous value.
    expect(__peekGitSnapshot(repo)).toBe(syncValue);
    expect(holds).toBe(1);
  });

  test('a write during an in-flight rebuild wins: the stale rebuild is discarded (hold seam)', async () => {
    buildGitSnapshot(repo);
    let release!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(r => { enteredResolve = r; });
    let holds = 0;
    __setGitSnapshotRebuildHoldForTest(() => {
      holds += 1;
      if (holds === 1) { enteredResolve(); return new Promise<void>(r => { release = r; }); }
    });
    writeFileSync(join(repo, 'one.txt'), '1');
    // force: invalidates the cached snapshot and schedules a rebuild (now held).
    void refreshDirtyAsync(repo, { force: true });
    await entered;
    writeFileSync(join(repo, 'two.txt'), '2');
    // A second known write: the first rebuild is in flight against the old
    // generation; only the re-scheduled rebuild can ever store the new state.
    // (Remove the reschedule in invalidateGitSnapshots and this times out.)
    void refreshDirtyAsync(repo, { force: true });
    expect(await waitForPeek(repo, 'two.txt')).toBe(true);
    // Drop the cached entry mid-flight: with no current entry the held
    // rebuild's captured generation is the only thing that can discard it.
    // (Remove the generation check and it lands with the stale one.txt state.)
    clearGitSnapshotCache();
    release();
    await new Promise(r => setTimeout(r, 200));
    expect(__peekGitSnapshot(repo)).toBeUndefined();
    await refreshGitSnapshotAsync(repo, { ifOlderThanMs: 0 });
    expect(__peekGitSnapshot(repo)!).toContain('?? two.txt');
    expect(__peekGitSnapshot(repo)!.split('\n\n').slice(1).join('\n\n')).not.toContain('start of this turn');
    expect(holds).toBeGreaterThanOrEqual(2);
  });

  test('the snapshot header states the actual generation time, not the turn start', () => {
    const snapshot = buildGitSnapshot(repo, { now: () => 1_000 });
    expect(snapshot!).toMatch(/^This is the git status as of 1970-01-01T00:00:01\.000Z\./);
    expect(snapshot!).not.toContain('at the start of this turn');
  });

  test('a HEAD move does not let the rebuild reuse a probe started against the old ref', async () => {
    buildGitSnapshot(repo);
    const oldProbe = refreshDirtyAsync(repo, { minIntervalMs: 0 });
    __invalidateAllGitSnapshotsForTest();
    const afterMove = refreshDirtyAsync(repo, { minIntervalMs: 0 });
    expect(afterMove).not.toBe(oldProbe);
    await Promise.all([oldProbe, afterMove, refreshGitSnapshotAsync(repo)]);
  });

  test('a keep-warm tick leaves a young snapshot alone', async () => {
    const first = buildGitSnapshot(repo);
    writeFileSync(join(repo, 'young.txt'), 'dirty');
    expect(await refreshGitSnapshotAsync(repo, { ifOlderThanMs: 60_000 })).toBe(first);
    expect(await refreshGitSnapshotAsync(repo, { ifOlderThanMs: 0 })).toContain('?? young.txt');
  });

  test('the periodic (non-forced) dirty tick re-warms an old cached snapshot in the background', async () => {
    buildGitSnapshot(repo, { now: () => Date.now() - 45_000 });
    writeFileSync(join(repo, 'tick-warm.txt'), 'dirty');
    await refreshDirtyAsync(repo, { minIntervalMs: 0 });
    expect(await waitForPeek(repo, 'tick-warm.txt')).toBe(true);
  });

  test('the periodic dirty tick does not build a snapshot nobody has used', async () => {
    await refreshDirtyAsync(repo, { minIntervalMs: 0 });
    await new Promise(r => setTimeout(r, 200));
    expect(__peekGitSnapshot(repo)).toBeUndefined();
  });

  test('after a known write the turn path serves the evicted snapshot while the rebuild runs (no sync build)', async () => {
    const first = buildGitSnapshot(repo);
    let release!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(r => { enteredResolve = r; });
    __setGitSnapshotRebuildHoldForTest(() => {
      enteredResolve();
      return new Promise<void>(r => { release = r; });
    });
    writeFileSync(join(repo, 'written.txt'), 'dirty');
    // force = a known write: evicts the cached snapshot and schedules a (held) background rebuild.
    void refreshDirtyAsync(repo, { force: true });
    await entered;
    expect(__peekGitSnapshot(repo)).toBeUndefined();
    // The TUI turn path: a synchronous rebuild would list written.txt; the evicted snapshot does not.
    // (Remove the evicted-snapshot branch in buildGitSnapshot and this sees written.txt.)
    const served = buildGitSnapshot(repo, { ttlMs: 0, staleWhileRevalidateMs: 60_000 });
    expect(served).toBe(first);
    expect(served!).not.toContain('written.txt');
    __setGitSnapshotRebuildHoldForTest(null);
    release();
    expect(await waitForPeek(repo, 'written.txt')).toBe(true);
    expect(buildGitSnapshot(repo, { ttlMs: 60_000, staleWhileRevalidateMs: 60_000 })!).toContain('?? written.txt');
  });

  test('an evicted snapshot older than the stale window is not served: the turn rebuilds synchronously', async () => {
    buildGitSnapshot(repo, { now: () => Date.now() - 120_000 });
    let release!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(r => { enteredResolve = r; });
    __setGitSnapshotRebuildHoldForTest(() => {
      enteredResolve();
      return new Promise<void>(r => { release = r; });
    });
    writeFileSync(join(repo, 'too-old.txt'), 'dirty');
    void refreshDirtyAsync(repo, { force: true });
    await entered;
    expect(buildGitSnapshot(repo, { ttlMs: 0, staleWhileRevalidateMs: 60_000 })!).toContain('?? too-old.txt');
    __setGitSnapshotRebuildHoldForTest(null);
    release();
  });

  test('callers without a stale window never see an evicted snapshot', async () => {
    buildGitSnapshot(repo);
    let release!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(r => { enteredResolve = r; });
    __setGitSnapshotRebuildHoldForTest(() => {
      enteredResolve();
      return new Promise<void>(r => { release = r; });
    });
    writeFileSync(join(repo, 'non-tui.txt'), 'dirty');
    void refreshDirtyAsync(repo, { force: true });
    await entered;
    expect(buildGitSnapshot(repo, { ttlMs: 0 })!).toContain('?? non-tui.txt');
    __setGitSnapshotRebuildHoldForTest(null);
    release();
  });

  test('turn path (buildSessionRuntimeSystemMessages with a stale window) serves the warm snapshot without a sync rebuild', () => {
    // Warmed 10s ago: past the 3s TTL, inside the TUI stale window.
    buildGitSnapshot(repo, { now: () => Date.now() - 10_000 });
    writeFileSync(join(repo, 'typed-later.txt'), 'dirty');
    const turn = buildSessionRuntimeSystemMessages({ cwd: repo, gitSnapshotStaleMs: 60_000 });
    expect(turn[0]!.content as string).toContain('## Git Snapshot');
    expect(turn[0]!.content as string).not.toContain('typed-later.txt');
    // Non-TUI callers (no stale window) keep the synchronous, fresh behaviour.
    const fresh = buildSessionRuntimeSystemMessages({ cwd: repo });
    expect(fresh[0]!.content as string).toContain('?? typed-later.txt');
  });

  test('a ref-file event that does not move HEAD keeps the cached snapshot (no spurious invalidation)', async () => {
    const warm = buildGitSnapshot(repo);
    // Same content rewritten: the watcher fires, HEAD (branch · sha) is unchanged.
    // (Drop the headMoved gate in ensureEntry and the snapshot is evicted and rebuilt.)
    const ref = join(repo, '.git', 'refs', 'heads', 'main');
    writeFileSync(ref, readFileSync(ref, 'utf8'));
    await new Promise(r => setTimeout(r, 400));
    expect(__peekGitSnapshot(repo)).toBe(warm);
  });

  test('a commit on the current branch (sha move) still invalidates and re-warms', async () => {
    buildGitSnapshot(repo);
    writeFileSync(join(repo, 'c.txt'), 'c');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'second-commit']);
    expect(await waitForPeek(repo, 'second-commit')).toBe(true);
  });

  test('without a stale window the snapshot is rebuilt synchronously as before', () => {
    buildGitSnapshot(repo);
    writeFileSync(join(repo, 'sync.txt'), 'dirty');
    expect(buildGitSnapshot(repo, { ttlMs: 0 })!).toContain('?? sync.txt');
  });
});
