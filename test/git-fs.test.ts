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
  __resetGitFsCache,
} from '../src/git-fs/index.js';

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

// TUI-TYPING-LAG — the TUI probes git dirty state without blocking its event loop.
describe('git-fs: refreshDirtyAsync', () => {
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
    __resetGitFsCache();
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  test('matches the sync probe and shares one in-flight probe', async () => {
    writeFileSync(join(repo, 'new.md'), 'x');
    const first = refreshDirtyAsync(repo, { minIntervalMs: 0 });
    const second = refreshDirtyAsync(repo, { minIntervalMs: 0 });
    expect(second).toBe(first);
    const view = await first;
    expect(view.dirty).toEqual(refreshDirty(repo, { force: true }).dirty);
    expect(view.dirty!.untracked).toBe(1);
  });

  test('throttles like the sync probe', async () => {
    await refreshDirtyAsync(repo, { force: true });
    const first = getGitStatusView(repo).lastDirtyProbeAt;
    await refreshDirtyAsync(repo);
    expect(getGitStatusView(repo).lastDirtyProbeAt).toBe(first);
  });

  test('outside a repo resolves an empty view', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gitfs-async-outside-'));
    try {
      expect((await refreshDirtyAsync(outside)).head).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a throttled call during a forced probe joins it instead of returning the pre-write view', async () => {
    await refreshDirtyAsync(repo, { force: true });
    writeFileSync(join(repo, 'joined.txt'), 'dirty');
    const forced = refreshDirtyAsync(repo, { force: true });
    const throttled = refreshDirtyAsync(repo);
    expect(throttled).toBe(forced);
    expect((await throttled).dirty!.untracked).toBe(1);
  });

  test('a forced probe after a write does not reuse a probe that started before the write', async () => {
    const before = refreshDirtyAsync(repo, { minIntervalMs: 0 });
    writeFileSync(join(repo, 'raced.txt'), 'dirty');
    const forced = refreshDirtyAsync(repo, { force: true });
    expect(forced).not.toBe(before);
    expect((await forced).dirty!.untracked).toBe(1);
  });
});
