import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapStaleGateWorktrees } from './gate-baseline-reap.js';
import { withBaselineWorktree } from './gate-baseline.js';
import { setGitCommandRunnerForTesting } from '../git-fs/runner.js';
import { debug } from '../debug/log.js';

const roots: string[] = [];
const age = 3 * 60 * 60_000;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(): { cwd: string; temp: string } {
  // git prints real paths (macOS: /var → /private/var); compare against the same spelling.
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'gate-reap-test-')));
  roots.push(temp);
  const cwd = join(temp, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Gate Reaper Test');
  git(cwd, 'config', 'user.email', 'gate-reaper@test.local');
  writeFileSync(join(cwd, 'README.md'), 'base\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', 'base');
  return { cwd, temp };
}

function add(cwd: string, temp: string, name: string, reason?: string): string {
  const path = join(temp, name);
  git(cwd, 'worktree', 'add', '--detach', ...(reason ? ['--lock', '--reason', reason] : []), path, 'HEAD');
  return path;
}

function metadata(cwd: string, path: string): string {
  const list = git(cwd, 'worktree', 'list', '--porcelain');
  expect(list).toContain(`worktree ${path}`);
  return join(cwd, git(cwd, 'rev-parse', '--git-common-dir'), 'worktrees', path.split('/').at(-1)!);
}

afterEach(() => {
  setGitCommandRunnerForTesting(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('reapStaleGateWorktrees (real git registrations)', () => {
  test('dead locked owner is removed; live owner and other worktree stay registered', () => {
    const { cwd, temp } = fixture();
    const old = Date.now() - age;
    const a = add(cwd, temp, 'elanous-gate-baseline-a', `elanous-gate pid=99999999 started=${old}`);
    const b = add(cwd, temp, 'elanous-gate-baseline-b', `elanous-gate pid=${process.pid} started=${old}`);
    const other = add(cwd, temp, 'other-wt');
    const result = reapStaleGateWorktrees(cwd, undefined, { isPidAlive: (pid) => pid === process.pid, tmpRoots: [temp] });
    expect(result).toMatchObject({ ok: true, listed: 4, candidates: 2, removed: 1, keptLive: 1, failed: 0 });
    const list = git(cwd, 'worktree', 'list', '--porcelain');
    expect(list).not.toContain(`worktree ${a}\n`);
    expect(list).toContain(`worktree ${b}\n`);
    expect(list).toContain(`worktree ${other}\n`);
    expect(existsSync(a)).toBe(false);
  });

  test('old gate checkout registered in another repository is not an orphan of this repository', () => {
    const first = fixture();
    const second = fixture();
    const foreign = add(second.cwd, first.temp, 'elanous-gate-baseline-foreign',
      `elanous-gate pid=${process.pid} started=${Date.now() - age}`);
    const stale = add(first.cwd, first.temp, 'elanous-gate-baseline-stale',
      `elanous-gate pid=99999999 started=${Date.now() - age}`);
    const orphan = join(first.temp, 'elanous-gate-baseline-empty');
    const unknown = join(first.temp, 'elanous-gate-baseline-unknown');
    mkdirSync(orphan);
    mkdirSync(unknown);
    writeFileSync(join(unknown, 'unidentified-owner'), 'keep');
    const timestamp = new Date(Date.now() - age);
    utimesSync(foreign, timestamp, timestamp);
    utimesSync(orphan, timestamp, timestamp);
    utimesSync(unknown, timestamp, timestamp);
    expect(readFileSync(join(foreign, '.git'), 'utf8')).toContain(second.cwd);

    const result = reapStaleGateWorktrees(first.cwd, undefined, {
      tmpRoots: [first.temp], isPidAlive: (pid) => pid === process.pid,
    });
    expect(result).toMatchObject({ ok: true, candidates: 1, removed: 1, orphanDirsRemoved: 1 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(git(second.cwd, 'worktree', 'list', '--porcelain')).toContain(`worktree ${foreign}\n`);
    expect(git(first.cwd, 'worktree', 'list', '--porcelain')).not.toContain(`worktree ${foreign}\n`);
  });

  test('old locked initializing uses metadata mtime; young locked initializing is preserved', () => {
    const { cwd, temp } = fixture();
    const old = add(cwd, temp, 'elanous-gate-baseline-old');
    const young = add(cwd, temp, 'elanous-gate-baseline-young');
    const oldMetadata = metadata(cwd, old);
    const youngMetadata = metadata(cwd, young);
    writeFileSync(join(oldMetadata, 'locked'), 'initializing\n');
    writeFileSync(join(youngMetadata, 'locked'), 'initializing\n');
    const timestamp = new Date(Date.now() - age);
    utimesSync(oldMetadata, timestamp, timestamp);
    const result = reapStaleGateWorktrees(cwd, undefined, { tmpRoots: [temp] });
    expect(result).toMatchObject({ ok: true, candidates: 2, removed: 1, keptYoung: 1, failed: 0 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldMetadata)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(youngMetadata)).toBe(true);
  });

  test('missing checkout removes only its matching metadata; old orphan temp directory is removed', () => {
    const { cwd, temp } = fixture();
    const missing = add(cwd, temp, 'elanous-gate-baseline-missing', `elanous-gate pid=99999999 started=${Date.now() - age}`);
    const record = metadata(cwd, missing);
    expect(readFileSync(join(record, 'gitdir'), 'utf8').trim()).toBe(join(missing, '.git'));
    rmSync(missing, { recursive: true });
    const orphan = join(temp, 'elanous-gate-baseline-z');
    const other = join(temp, 'not-gate-z');
    mkdirSync(orphan);
    mkdirSync(other);
    const timestamp = new Date(Date.now() - age);
    utimesSync(orphan, timestamp, timestamp);
    utimesSync(other, timestamp, timestamp);
    const result = reapStaleGateWorktrees(cwd, undefined, { isPidAlive: () => false, tmpRoots: [temp] });
    expect(result).toMatchObject({ ok: true, candidates: 1, removed: 1, orphanDirsRemoved: 1, failed: 0 });
    expect(existsSync(record)).toBe(false);
    expect(git(cwd, 'worktree', 'list', '--porcelain')).not.toContain(`worktree ${missing}\n`);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  test('add failure after registration removes locked initializing record without changing gate result', () => {
    const { cwd, temp } = fixture();
    const events: Array<{ stage?: string; status?: number }> = [];
    const off = debug.registerSink({
      name: 'gate-add-failed-remove',
      emit: (record) => {
        if (record.category === 'self-implement' && record.event === 'gate.baseline.cleanup') {
          events.push(record.data as { stage?: string; status?: number });
        }
      },
    });
    let added = '';
    setGitCommandRunnerForTesting((dir, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        added = args.at(-2)!;
        git(dir, 'worktree', 'add', '--detach', '--lock', '--reason', 'initializing', added, 'HEAD');
        return { status: 1, stdout: '', stderr: 'interrupted add' };
      }
      const child = spawnSync('git', args, { ...options, cwd: dir, encoding: 'utf8' });
      return { status: child.status, stdout: child.stdout, stderr: child.stderr };
    });
    try {
      const result = withBaselineWorktree(cwd, 'HEAD', () => 'not run');
      expect(result).toMatchObject({ status: 'unknown' });
      expect(git(cwd, 'worktree', 'list', '--porcelain')).not.toContain(`worktree ${added}\n`);
      expect(existsSync(added)).toBe(false);
      expect(events.filter((event) => event.stage === 'add-failed-remove')).toEqual([]);
    } finally { off(); }
  });

  test('unmarked live-era registration stays young and default temp roots do not touch other prefixes', () => {
    const { cwd, temp } = fixture();
    const young = add(cwd, temp, 'elanous-gate-baseline-young');
    const unrelated = add(cwd, temp, 'self-impl-goal-unrelated');
    const result = reapStaleGateWorktrees(cwd, undefined, { tmpRoots: [temp] });
    expect(result).toMatchObject({ ok: true, candidates: 1, keptYoung: 1, removed: 0 });
    expect(git(cwd, 'worktree', 'list', '--porcelain')).toContain(`worktree ${young}\n`);
    expect(existsSync(unrelated)).toBe(true);
  });

  test('list failure deletes nothing; cap and unrelated roots stay safe', () => {
    const { cwd, temp } = fixture();
    const old = add(cwd, temp, 'elanous-gate-baseline-old', `elanous-gate pid=99999999 started=${Date.now() - age}`);
    const orphan = join(temp, 'elanous-gate-baseline-orphan');
    mkdirSync(orphan);
    const timestamp = new Date(Date.now() - age);
    utimesSync(orphan, timestamp, timestamp);
    const failed = reapStaleGateWorktrees(cwd, undefined, { tmpRoots: [temp], run: () => ({ status: 1, stdout: '', stderr: 'git unavailable' }) });
    expect(failed).toMatchObject({ ok: false, removed: 0, orphanDirsRemoved: 0 });
    expect(existsSync(old)).toBe(true);
    expect(existsSync(orphan)).toBe(true);
    const deferred = reapStaleGateWorktrees(cwd, { max: 0 }, { tmpRoots: [temp], isPidAlive: () => false });
    expect(deferred).toMatchObject({ ok: true, candidates: 1, deferred: 1, removed: 0, orphanDirsRemoved: 1 });
    expect(statSync(old).isDirectory()).toBe(true);
  });
});
