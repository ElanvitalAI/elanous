import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRepairBundle, REPAIR_BUNDLE_REF, type RepairCasDeps } from './repair-branch-cas.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ta-repair-cas-'));
  const bare = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const child = join(root, 'child');
  execFileSync('git', ['init', '--bare', bare]);
  execFileSync('git', ['init', '-b', 'feature', repo]);
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git(repo, 'add', 'file.txt');
  git(repo, 'commit', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/feature');
  const baseHead = git(repo, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', bare, child]);
  git(child, 'checkout', '-B', 'feature', 'origin/feature');
  git(child, 'config', 'user.name', 'test');
  git(child, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(child, 'intermediate.txt'), 'advance\n');
  git(child, 'add', 'intermediate.txt');
  git(child, 'commit', '-m', 'intermediate');
  const intermediateHead = git(child, 'rev-parse', 'HEAD');
  writeFileSync(join(child, 'file.txt'), 'repaired\n');
  git(child, 'add', 'file.txt');
  git(child, 'commit', '-m', 'repair');
  const commit = git(child, 'rev-parse', 'HEAD');
  git(child, 'update-ref', REPAIR_BUNDLE_REF, commit);
  const bundlePath = join(root, 'repair.bundle');
  git(child, 'bundle', 'create', bundlePath, REPAIR_BUNDLE_REF);
  const bundleSha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
  const request = { repo, pr: 30, expectedHead: baseHead, bundlePath, result: { pr: 30, baseHead, commit, bundleSha256 } };
  const deps: RepairCasDeps = {
    git(cwd, args) {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    },
    prView() {
      return { state: 'OPEN', head: git(repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]!, branch: 'feature', crossRepository: false, headRepo: 'owner/repo' };
    },
    originRepo() { return 'owner/repo'; },
  };
  return { ...request, deps, bare, child, intermediateHead };
}

test('repair bundle applies only to the exact existing PR branch by leased fast-forward push', () => {
  const f = fixture();
  let pushArgs: string[] = [];
  const deps: RepairCasDeps = { ...f.deps, git(cwd, args) {
    if (args[0] === 'push') pushArgs = args;
    return f.deps.git(cwd, args);
  } };
  expect(applyRepairBundle(f, deps)).toEqual({ ok: true, fromHead: f.expectedHead, toHead: f.result.commit, branch: 'feature' });
  expect(pushArgs).toEqual(['push', `--force-with-lease=refs/heads/feature:${f.expectedHead}`, 'origin', `${f.result.commit}:refs/heads/feature`]);
  expect(pushArgs.at(-1)?.startsWith('+')).toBe(false);
  expect(git(f.repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]).toBe(f.result.commit);
  expect(git(f.repo, 'ls-remote', 'origin', 'refs/heads/ta-repair')).toBe('');
  expect(applyRepairBundle(f, f.deps)).toEqual({ ok: true, fromHead: f.expectedHead, toHead: f.result.commit, branch: 'feature' });
});

test('confirmation-only success reads PR and remote without fetching or pushing again', () => {
  const f = fixture();
  expect(applyRepairBundle(f, f.deps).ok).toBe(true);
  const commands: string[] = [];
  const deps: RepairCasDeps = { ...f.deps, git(cwd, args) {
    commands.push(args[0]!);
    return f.deps.git(cwd, args);
  } };
  expect(applyRepairBundle({ ...f, confirmationOnly: true, branch: 'feature' }, deps)).toMatchObject({ ok: true, toHead: f.result.commit });
  expect(commands).toEqual(['check-ref-format', 'ls-remote']);
});

test('confirmation-only preserves a transient PR identity mismatch across ticks', () => {
  const f = fixture();
  expect(applyRepairBundle(f, f.deps).ok).toBe(true);
  let stale = true;
  const deps: RepairCasDeps = { ...f.deps, prView(cwd, pr) {
    const view = f.deps.prView(cwd, pr);
    return stale && view ? { ...view, headRepo: 'other/repo', crossRepository: true, branch: 'stale/feature' } : view;
  } };
  const request = { ...f, confirmationOnly: true, branch: 'feature' };
  expect(applyRepairBundle(request, deps)).toMatchObject({ ok: false, unconfirmed: true });
  expect(applyRepairBundle(request, deps)).toMatchObject({ ok: false, unconfirmed: true });
  stale = false;
  expect(applyRepairBundle(request, deps)).toMatchObject({ ok: true, toHead: f.result.commit });
});

test('PR repository and git origin must match before any repair push', () => {
  const f = fixture();
  let pushes = 0;
  const deps: RepairCasDeps = { ...f.deps, originRepo: () => 'other/repo', git(cwd, args) {
    if (args[0] === 'push') pushes++;
    return f.deps.git(cwd, args);
  } };
  expect(applyRepairBundle(f, deps)).toMatchObject({ ok: false, reason: 'PR head repository differs from git origin' });
  expect(pushes).toBe(0);
});

test('a transient PR view mismatch after push is retried before reporting the repair', () => {
  for (const change of [{ headRepo: 'other/repo' }, { crossRepository: true }]) {
    const f = fixture();
    let views = 0;
    const deps: RepairCasDeps = { ...f.deps, sleep: () => {}, prView(cwd, pr) {
      const view = f.deps.prView(cwd, pr);
      return ++views === 3 && view ? { ...view, ...change } : view;
    } };
    expect(applyRepairBundle(f, deps)).toMatchObject({ ok: true, toHead: f.result.commit });
    expect(views).toBe(4);
  }
});

test('successful push with stale PR view stays unconfirmed and never pushes the same commit twice', () => {
  const f = fixture();
  let pushes = 0;
  let stale = true;
  const deps: RepairCasDeps = { ...f.deps, sleep: () => {}, git(cwd, args) {
    if (args[0] === 'push') pushes++;
    return f.deps.git(cwd, args);
  }, prView(cwd, pr) {
    const view = f.deps.prView(cwd, pr);
    return stale && view ? { ...view, head: f.expectedHead } : view;
  } };
  expect(applyRepairBundle(f, deps)).toEqual({ ok: false, unconfirmed: true, reason: 'push succeeded; PR head confirmation pending' });
  expect(pushes).toBe(1);
  expect(applyRepairBundle(f, deps)).toEqual({ ok: false, unconfirmed: true, reason: 'repair commit is on the remote branch; PR head confirmation pending' });
  expect(pushes).toBe(1);
  stale = false;
  expect(applyRepairBundle(f, deps)).toMatchObject({ ok: true, toHead: f.result.commit });
  expect(pushes).toBe(1);
});

test('confirmation-only keeps a missing PR response and a reverted remote pending without repush', () => {
  const f = fixture();
  let pushes = 0;
  let missing = false;
  let reverted = false;
  const deps: RepairCasDeps = { ...f.deps, sleep: () => {}, git(cwd, args) {
    if (args[0] === 'push') pushes++;
    if (reverted && args[0] === 'ls-remote') return { status: 0, stdout: `${f.expectedHead}\trefs/heads/feature\n`, stderr: '' };
    return f.deps.git(cwd, args);
  }, prView(cwd, pr) {
    if (missing) return null;
    const view = f.deps.prView(cwd, pr);
    return view ? { ...view, head: f.expectedHead } : view;
  } };
  expect(applyRepairBundle(f, deps)).toMatchObject({ ok: false, unconfirmed: true });
  expect(pushes).toBe(1);
  missing = true;
  expect(applyRepairBundle({ ...f, confirmationOnly: true, branch: 'feature' }, deps)).toMatchObject({ ok: false, unconfirmed: true });
  missing = false;
  reverted = true;
  expect(applyRepairBundle({ ...f, confirmationOnly: true, branch: 'feature' }, deps)).toMatchObject({ ok: false, unconfirmed: true });
  expect(pushes).toBe(1);
});

test('push confirmation does not apply when the real remote ref moves back before PR view catches up', () => {
  const f = fixture();
  let pushes = 0;
  const deps: RepairCasDeps = { ...f.deps, sleep: () => {}, git(cwd, args) {
    const out = f.deps.git(cwd, args);
    if (args[0] === 'push') {
      pushes++;
      git(f.bare, 'update-ref', 'refs/heads/feature', f.expectedHead);
    }
    return out;
  }, prView() {
    return { state: 'OPEN', head: pushes ? f.result.commit : f.expectedHead, branch: 'feature', crossRepository: false, headRepo: 'owner/repo' };
  } };
  expect(applyRepairBundle(f, deps)).toMatchObject({ ok: false, unconfirmed: true });
  expect(git(f.repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]).toBe(f.expectedHead);
  expect(pushes).toBe(1);
});

test('accepted push with a failed command response keeps the claimed intent unconfirmed', () => {
  const f = fixture();
  let claimed = 0;
  const deps: RepairCasDeps = { ...f.deps, git(cwd, args) {
    const out = f.deps.git(cwd, args);
    return args[0] === 'push' ? { ...out, status: 1, stderr: 'transport response lost' } : out;
  } };
  expect(applyRepairBundle({ ...f, claimBeforePush: () => { claimed++; return true; } }, deps)).toMatchObject({ ok: false, unconfirmed: true });
  expect(claimed).toBe(1);
  expect(git(f.repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]).toBe(f.result.commit);
});

test('remote advancement between ls-remote and push is rejected by the exact-head lease', () => {
  const f = fixture();
  let advanced = '';
  const deps: RepairCasDeps = { ...f.deps, git(cwd, args) {
    if (args[0] === 'push') {
      // Advance to an ancestor of the repair commit: an ordinary fast-forward push would succeed.
      advanced = f.intermediateHead;
      git(f.child, 'push', 'origin', `${advanced}:refs/heads/feature`);
    }
    return f.deps.git(cwd, args);
  } };
  const outcome = applyRepairBundle(f, deps);
  expect(outcome).toMatchObject({ ok: false });
  expect(outcome.ok ? '' : outcome.reason).toContain('exact-head');
  expect(git(f.repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]).toBe(advanced);
});

test('changed PR head or malformed bundle never pushes', () => {
  const f = fixture();
  git(f.child, 'push', 'origin', `${f.intermediateHead}:refs/heads/feature`);
  expect(applyRepairBundle(f, f.deps)).toMatchObject({ ok: false, reason: 'PR head CAS mismatch or PR unavailable' });
  const original = git(f.repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0];
  writeFileSync(f.bundlePath, 'damaged');
  expect(applyRepairBundle(f, f.deps)).toMatchObject({ ok: false, reason: 'repair bundle sha256 mismatch' });
  expect(git(f.repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]).toBe(original);
});

test('a bundle that returns the reviewed head cannot be reported as an applied repair', () => {
  const f = fixture();
  const unchanged = { ...f, result: { ...f.result, commit: f.expectedHead } };
  expect(applyRepairBundle(unchanged, f.deps)).toEqual({ ok: false, reason: 'repair produced no new commit' });
  expect(git(f.repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]).toBe(f.expectedHead);
});
