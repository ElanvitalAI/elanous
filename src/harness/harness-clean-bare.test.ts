import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeParentDir } from '../git-fs/worktree.js';
import { recordHarnessWorktreeProvenance } from './harness-worktree-add.js';
import { listHarnessWorktreeDirectories, planHarnessClean, renderHarnessCleanReport, type GitRunner } from './harness-clean.js';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-clean-bare-'));
  temporaryRoots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init');
  git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  const bare = join(root, 'repo.git');
  git(root, 'clone', '--bare', source, bare);
  const a = join(root, 'seat-a');
  const b = join(root, 'seat-b');
  git(bare, 'worktree', 'add', '-b', 'seat-a', a, 'HEAD');
  git(bare, 'worktree', 'add', '-b', 'seat-b', b, 'HEAD');
  const worktreeRoot = join(root, 'harness-root');
  const runner: GitRunner = (args) => {
    const result = spawnSync('git', ['-C', a, ...args], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { root, bare, a, b, worktreeRoot, runner };
}

function children(parent: string, ...names: string[]): string[] {
  for (const name of names) mkdirSync(join(parent, name), { recursive: true });
  return names.map((name) => join(parent, name));
}

describe('harness clean directory query from a bare repository worktree', () => {
  it('enumerates all registered source checkouts, not the registered harness children', () => {
    const { root, bare, a, b, worktreeRoot, runner } = fixture();
    const parentA = worktreeParentDir(a, worktreeRoot);
    const parentB = worktreeParentDir(b, worktreeRoot);
    const paths = [...children(parentA, 'z', 'a'), ...children(parentB, 'm')].sort();
    git(bare, 'worktree', 'add', '-b', 'harness-child', join(parentA, 'z'), 'HEAD');
    const otherRoot = join(root, 'other-harness-root');
    const otherParent = worktreeParentDir(a, otherRoot);
    const otherChild = join(otherParent, 'remote-harness-child');
    mkdirSync(otherParent, { recursive: true });
    git(bare, 'worktree', 'add', '-b', 'other-harness-child', otherChild, 'HEAD');
    const result = listHarnessWorktreeDirectories(undefined, runner, worktreeRoot);
    expect(result).toEqual({ ok: true, value: paths, scope: { rootKind: 'bare', parents: 2 } });
    const report = renderHarnessCleanReport({
      plan: { remove: [], preserve: [], orphanedWorktrees: [], orphanedWorktreeSafety: [], orphanScan: 'scanned', unavailable: false,
        scope: { branchPrefix: 'dev/', matchedWorktrees: 0, matchedBranches: 0, bareDirectoryParents: result.scope?.parents } },
      removed: [], failed: [], dryRun: true,
    }, 'all');
    expect(report.find((line) => line.startsWith('스코프 '))).toContain('bare 저장소 · 부모 2 곳을 봤다');
  });

  it('includes a human checkout under an ordinary archives.worktrees directory', () => {
    const { root, bare, a, worktreeRoot, runner } = fixture();
    const human = join(root, 'archives.worktrees', 'seat-c');
    mkdirSync(join(root, 'archives.worktrees'));
    git(bare, 'worktree', 'add', '-b', 'seat-c', human, 'HEAD');
    const paths = [
      ...children(worktreeParentDir(a, worktreeRoot), 'a'),
      ...children(worktreeParentDir(human, worktreeRoot), 'c'),
    ].sort();
    // `parents` counts parents that exist and were read; seat-b has none yet.
    expect(listHarnessWorktreeDirectories(undefined, runner, worktreeRoot)).toEqual({
      ok: true, value: paths, scope: { rootKind: 'bare', parents: 2 },
    });
  });

  it('keeps a human checkout nested deeper than a direct child of a harness parent as a launch root', () => {
    const { bare, a, worktreeRoot, runner } = fixture();
    // The path contains `/<scope(a)>/seat-a.worktrees/` but is not a direct child of that parent.
    const nested = join(worktreeParentDir(a, worktreeRoot), 'deep', 'seat-d');
    mkdirSync(join(worktreeParentDir(a, worktreeRoot), 'deep'), { recursive: true });
    git(bare, 'worktree', 'add', '-b', 'seat-d', nested, 'HEAD');
    const nestedChild = children(worktreeParentDir(nested, worktreeRoot), 'd');
    const result = listHarnessWorktreeDirectories(undefined, runner, worktreeRoot);
    expect(result.ok).toBe(true);
    expect(result.scope).toEqual({ rootKind: 'bare', parents: 2 });
    expect(result.value).toContain(nestedChild[0]);
  });

  it('reads the parent of a human checkout registered as a direct child of a harness parent', () => {
    const { bare, a, worktreeRoot, runner } = fixture();
    // Same position a harness child would occupy — path shape alone cannot tell them apart,
    // so the checkout stays a candidate and its own parent is read (review r2 must-fix).
    const direct = join(worktreeParentDir(a, worktreeRoot), 'human-direct');
    git(bare, 'worktree', 'add', '-b', 'human-direct', direct, 'HEAD');
    const directChild = children(worktreeParentDir(direct, worktreeRoot), 'h');
    const result = listHarnessWorktreeDirectories(undefined, runner, worktreeRoot);
    expect(result.ok).toBe(true);
    expect(result.scope).toEqual({ rootKind: 'bare', parents: 2 });
    expect(result.value).toEqual([direct, ...directChild].sort());
    // …and if that parent cannot be read, the whole inventory is unknown, not ok:true.
    chmodSync(worktreeParentDir(direct, worktreeRoot), 0o000);
    try {
      expect(listHarnessWorktreeDirectories(undefined, runner, worktreeRoot).ok).toBe(false);
    } finally {
      chmodSync(worktreeParentDir(direct, worktreeRoot), 0o700);
    }
  });

  it('excludes a registered harness child only when git records its harness ownership', () => {
    const { bare, a, worktreeRoot, runner } = fixture();
    git(bare, 'config', 'extensions.worktreeConfig', 'true');
    const parentA = worktreeParentDir(a, worktreeRoot);
    // ⓐ a real harness child: direct child of A's parent ⊕ ownership marker recorded by git.
    const harnessChild = join(parentA, 'harness-owned');
    git(bare, 'worktree', 'add', '-b', 'harness-owned', harnessChild, 'HEAD');
    git(harnessChild, 'config', '--worktree', 'elanous.harness.owner', 'dev:run-test');
    const outOfScope = children(worktreeParentDir(harnessChild, worktreeRoot), 'inner');
    // ⓑ same position, no marker: a human checkout — stays a candidate.
    const human = join(parentA, 'human-same-spot');
    git(bare, 'worktree', 'add', '-b', 'human-same-spot', human, 'HEAD');
    const humanChild = children(worktreeParentDir(human, worktreeRoot), 'h');
    const result = listHarnessWorktreeDirectories(undefined, runner, worktreeRoot);
    expect(result.ok).toBe(true);
    expect(result.value).not.toContain(outOfScope[0]);
    expect(result.value).toEqual([harnessChild, human, ...humanChild].sort());
    expect(result.scope).toEqual({ rootKind: 'bare', parents: 2 });
    // The harness child's own parent is out of scope, so its read failure cannot stop the inventory.
    chmodSync(worktreeParentDir(harnessChild, worktreeRoot), 0o000);
    try {
      expect(listHarnessWorktreeDirectories(undefined, runner, worktreeRoot).ok).toBe(true);
    } finally {
      chmodSync(worktreeParentDir(harnessChild, worktreeRoot), 0o700);
    }
  });

  it('excludes an owned harness child even after its launching checkout is gone', () => {
    const { root, bare, worktreeRoot, runner } = fixture();
    git(bare, 'config', 'extensions.worktreeConfig', 'true');
    const launch = join(root, 'seat-c');
    git(bare, 'worktree', 'add', '-b', 'seat-c', launch, 'HEAD');
    const child = join(worktreeParentDir(launch, worktreeRoot), 'orphaned-owned');
    git(bare, 'worktree', 'add', '-b', 'orphaned-owned', child, 'HEAD');
    // The marker comes from the real creation path's writer, not a hand-written key.
    recordHarnessWorktreeProvenance(child, { owner: 'dev:run-test', command: 'harness test', createdAt: '2026-10-10T00:00:00Z' });
    git(bare, 'worktree', 'remove', launch);
    const inner = children(worktreeParentDir(child, worktreeRoot), 'inner');
    chmodSync(worktreeParentDir(child, worktreeRoot), 0o000);
    try {
      const result = listHarnessWorktreeDirectories(undefined, runner, worktreeRoot);
      expect(result.ok).toBe(true);
      expect(result.value).not.toContain(inner[0]);
      // seat-c is gone, so its parent is no longer a candidate; seat-a/seat-b have none yet.
      expect(result.value).toEqual([]);
      expect(result.scope).toEqual({ rootKind: 'bare', parents: 0 });
    } finally {
      chmodSync(worktreeParentDir(child, worktreeRoot), 0o700);
    }
  });

  it('skips a registration whose directory is gone (prunable) instead of failing the inventory', () => {
    const { bare, a, worktreeRoot, runner } = fixture();
    git(bare, 'config', 'extensions.worktreeConfig', 'true');
    const parent = worktreeParentDir(a, worktreeRoot);
    const paths = children(parent, 'kept').sort();
    const child = join(parent, 'deleted-owned');
    git(bare, 'worktree', 'add', '-b', 'deleted-owned', child, 'HEAD');
    recordHarnessWorktreeProvenance(child, { owner: 'dev:run-test', command: 'harness test', createdAt: '2026-10-10T00:00:00Z' });
    // The directory is removed but git still lists it (porcelain `prunable`); the marker read would exit 128.
    rmSync(child, { recursive: true, force: true });
    expect(git(a, 'worktree', 'list', '--porcelain')).toContain(child);
    expect(listHarnessWorktreeDirectories(undefined, runner, worktreeRoot)).toEqual({
      ok: true, value: paths, scope: { rootKind: 'bare', parents: 1 },
    });
  });

  it('fails closed when a candidate harness child ownership marker cannot be read', () => {
    const { bare, a, worktreeRoot, runner } = fixture();
    git(bare, 'config', 'extensions.worktreeConfig', 'true');
    const child = join(worktreeParentDir(a, worktreeRoot), 'owner-unreadable');
    git(bare, 'worktree', 'add', '-b', 'owner-unreadable', child, 'HEAD');
    git(child, 'config', '--worktree', 'elanous.harness.owner', 'dev:run-test');
    children(worktreeParentDir(child, worktreeRoot), 'inner');
    // git exits 128 (not 1 = «unset») for the marker read: ownership is unknown, not «human».
    const brokenMarker: GitRunner = (args) => args.includes('elanous.harness.owner')
      ? { status: 128, stdout: '', stderr: 'fatal: unable to read config' } : runner(args);
    expect(listHarnessWorktreeDirectories(undefined, brokenMarker, worktreeRoot))
      .toEqual({ ok: false, value: [], failure: 'directories', scope: { rootKind: 'bare', parents: 0 } });
    // An unset marker (git exit 1) is a real «no marker»: the checkout stays a candidate.
    const unset: GitRunner = (args) => args.includes('elanous.harness.owner')
      ? { status: 1, stdout: '', stderr: '' } : runner(args);
    const asHuman = listHarnessWorktreeDirectories(undefined, unset, worktreeRoot);
    expect(asHuman.ok).toBe(true);
    expect(asHuman.value).toContain(join(worktreeParentDir(child, worktreeRoot), 'inner'));
  });

  it('treats a missing second parent as empty, without losing the first parent', () => {
    const { a, worktreeRoot, runner } = fixture();
    const paths = children(worktreeParentDir(a, worktreeRoot), 'z', 'a').sort();
    // seat-b's parent is ENOENT: empty, not a failure, and not counted as «seen».
    expect(listHarnessWorktreeDirectories(undefined, runner, worktreeRoot)).toEqual({
      ok: true, value: paths, scope: { rootKind: 'bare', parents: 1 },
    });
  });

  it('fails closed when one parent is unreadable or registration cannot be queried', () => {
    const { a, worktreeRoot, runner } = fixture();
    const parent = worktreeParentDir(a, worktreeRoot);
    children(parent, 'a');
    chmodSync(parent, 0o000);
    try {
      // Fail-closed, but the bare scope stays observable on the failure path (review r1 must-fix).
      const unreadable = listHarnessWorktreeDirectories(undefined, runner, worktreeRoot);
      // Nothing was read before the failing parent, so the human line must not claim any.
      expect(unreadable).toEqual({ ok: false, value: [], failure: 'directories', scope: { rootKind: 'bare', parents: 0 } });
      const report = renderHarnessCleanReport({
        plan: { remove: [], preserve: [], orphanedWorktrees: [], orphanedWorktreeSafety: [], orphanScan: 'scanned', unavailable: true,
          scope: { branchPrefix: 'dev/', matchedWorktrees: 0, matchedBranches: 0, bareDirectoryParents: unreadable.scope?.parents } },
        removed: [], failed: [], dryRun: true,
      }, 'all');
      expect(report.find((line) => line.startsWith('스코프 '))).toContain('bare 저장소 · 부모 0 곳을 봤다');
    } finally {
      chmodSync(parent, 0o700);
    }
    const failedRunner: GitRunner = (args) => args.includes('worktree')
      ? { status: 1, stdout: '', stderr: 'unavailable' } : runner(args);
    const failed = listHarnessWorktreeDirectories(undefined, failedRunner, worktreeRoot);
    // Still fail-closed, but the already-known bare scope is not dropped (review r4).
    expect(failed).toEqual({ ok: false, value: [], failure: 'directories', scope: { rootKind: 'bare', parents: 0 } });
    const plan = planHarnessClean({
      worktrees: [], branches: ['dev/keep'], openPr: new Set(), mergedPr: new Set(['dev/keep']),
      mode: 'merged', activeDirectories: [], worktreeDirectories: failed.value,
      registeredWorktreePaths: [], queryStatus: { worktrees: true, branches: true, pullRequests: true,
        directories: failed.ok, registeredWorktrees: true, activeDirectories: true, directoriesFailure: failed.failure },
      unmergedCommitCounts: new Map(), uncommittedChanges: new Map(),
    });
    // HARNESS-GC-LOOP: a failed directory query is an orphan-scan failure only — it is recorded, not
    // spread to branch decisions (a merged branch with no worktree is still decided on its own evidence).
    expect(plan.unavailable).toBe(false);
    expect(plan.orphanScan).toBe('unavailable');
    expect(plan.orphanScanFailure).toBe('directories');
    expect(plan.orphanedWorktrees).toEqual([]);
  });

  it('preserves the regular .git main-root directory result and scope line', () => {
    const { root, worktreeRoot } = fixture();
    const source = join(root, 'source');
    const parent = worktreeParentDir(source, worktreeRoot);
    const paths = children(parent, 'z', 'a').sort();
    const runner: GitRunner = (args) => {
      const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    expect(listHarnessWorktreeDirectories(undefined, runner, worktreeRoot)).toEqual({ ok: true, value: paths });
    const report = renderHarnessCleanReport({
      plan: { remove: [], preserve: [], orphanedWorktrees: [], orphanedWorktreeSafety: [], orphanScan: 'scanned', unavailable: false,
        scope: { branchPrefix: 'dev/', matchedWorktrees: 0, matchedBranches: 0 } },
      removed: [], failed: [], dryRun: true,
    }, 'all');
    expect(report.find((line) => line.startsWith('스코프 '))).toBe('스코프 prefix=dev/ · 걸린 worktree 0 · 브랜치 0');
  });
});
