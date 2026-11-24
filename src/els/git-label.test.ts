// ELS-GIT-AWARENESS-HERDR (OP #139752) — 판정식 ①④: labels are accurate (branch · ahead/behind · dirty · worktree
// root, against a real synthetic git repo) and a listing NEVER runs or waits for git on the request path: a slow git
// answer may not delay a label read (#39546 lesson — typing latency zero). Synthetic repos are the test universe.
import { describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitLabels, gitLabelRunner, type GitLabelRunner } from './git-label.js';

const tick = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe('createGitLabels (cached · debounced · off the request path)', () => {
  test('a cold label read never starts git', () => {
    let calls = 0;
    const run: GitLabelRunner = async () => { calls += 1; await tick(50); return { branch: 'main', ahead: 0, behind: 0, dirty: false, root: null }; };
    const labels = createGitLabels(run);
    expect(labels.labelFor('/repo')).toBeUndefined();   // unknown — and no git was even started
    expect(calls).toBe(0);
  });

  test('refresh asks at most once per window per cwd and serves the cached label afterwards', async () => {
    let calls = 0;
    const run: GitLabelRunner = async (cwd: string) => { calls += 1; return { branch: `b-${cwd}`, ahead: 0, behind: 0, dirty: false, root: null }; };
    let at = 1_000;
    const labels = createGitLabels(run, () => at);
    labels.refresh(['/a', '/a', '/b']);
    labels.refresh(['/a']);
    await tick(10);
    expect(calls).toBe(2);                              // one ask per cwd — not one per refresh call (디바운스)
    expect(labels.labelFor('/a')).toEqual({ branch: 'b-/a', ahead: 0, behind: 0, dirty: false, root: null });
    labels.refresh(['/a']);
    await tick(10);
    expect(calls).toBe(2);                              // inside the window the cached label is served, no new ask
    at += 6_000;
    labels.refresh(['/a']);
    await tick(10);
    expect(calls).toBe(3);                              // after the window the repo is asked again (주기 갱신)
  });

  test('a slow git answer never blocks a label read (판정식 ④ — busy git off the request stack, <50ms)', async () => {
    const run: GitLabelRunner = async () => { await tick(300); return { branch: 'slow', ahead: 0, behind: 0, dirty: false, root: null }; };
    const labels = createGitLabels(run);
    const started = Date.now();
    labels.refresh(['/repo']);
    const reads = Array.from({ length: 50 }, () => labels.labelFor('/repo'));
    const elapsed = Date.now() - started;
    expect(reads.every((value) => value === undefined)).toBe(true);   // unknown while git is busy — never a wait
    expect(elapsed).toBeLessThan(50);                                  // 50 reads must not queue behind the 300ms answer
    await tick(320);
    expect(labels.labelFor('/repo')?.branch).toBe('slow');            // the answer lands on its own macrotask
  });

  test('a git that fails answers unknown and is retried only after the window', async () => {
    let calls = 0;
    const run: GitLabelRunner = async () => { calls += 1; return null; };
    let at = 1_000;
    const labels = createGitLabels(run, () => at);
    labels.refresh(['/repo']);
    await tick(10);
    expect(labels.labelFor('/repo')).toBeUndefined();
    labels.refresh(['/repo']);
    await tick(10);
    expect(calls).toBe(1);                              // failure kept: no hammering a repo git could not read
    at += 6_000;
    labels.refresh(['/repo']);
    await tick(10);
    expect(calls).toBe(2);                              // retried once the window has passed
  });
});

describe('gitLabelRunner (accuracy against a real synthetic repo — 판정식 ①)', () => {
  const git = (cwd: string, cmd: string): string => execSync(`git -C ${JSON.stringify(cwd)} ${cmd}`, { stdio: 'pipe' }).toString();
  const makeRepo = (dir: string, name: string): string => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    git(path, 'init');
    git(path, 'config user.email probe@elanous.local');
    git(path, 'config user.name probe');
    return path;
  };

  test('branch · dirty · ahead/behind · worktree root all match the repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-label-'));
    try {
      const upstream = join(dir, 'upstream.git');
      mkdirSync(upstream, { recursive: true });
      git(upstream, 'init --bare');
      const work = makeRepo(dir, 'work');
      git(work, 'checkout -b herdr-probe');
      git(work, `remote add origin ${JSON.stringify(upstream)}`);
      writeFileSync(join(work, 'seed.txt'), 's');
      git(work, 'add .');
      git(work, 'commit -m seed');
      git(work, 'push -u origin herdr-probe');
      const clean = await gitLabelRunner(work);
      expect(clean?.branch).toBe('herdr-probe');
      expect(clean?.dirty).toBe(false);
      expect(clean?.ahead).toBe(0);
      expect(clean?.root).toBe(realpathSync(work));   // macOS: git answers the resolved /private/tmp path
      writeFileSync(join(work, 'dirty.txt'), 'x');
      const dirty = await gitLabelRunner(work);
      expect(dirty?.branch).toBe('herdr-probe');
      expect(dirty?.dirty).toBe(true);
      writeFileSync(join(work, 'commit.txt'), 'y');
      git(work, 'add .');
      git(work, 'commit -m ahead');
      const ahead = await gitLabelRunner(work);
      expect(ahead?.dirty).toBe(false);
      expect(ahead?.ahead).toBe(1);
      expect(ahead?.behind).toBe(0);
      // a linked worktree: its root is itself, not the main checkout (herdr #4293 — open must not land on the repo's own ws)
      const linked = join(dir, 'linked');
      git(work, `worktree add ${JSON.stringify(linked)} -b linked-probe`);
      const label = await gitLabelRunner(linked);
      expect(label?.root).toBe(realpathSync(linked));
      expect(label?.branch).toBe('linked-probe');
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
  });

  test('a directory outside any repo answers null (no label)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-norepo-'));
    try { expect(await gitLabelRunner(dir)).toBeNull(); }
    finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
  });
});
