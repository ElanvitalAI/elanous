import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bodySha256, DEFAULT_STALE_AFTER_MS, NEEDS_CLEAN_BRANCH_AUTHOR_ACTION, preflightMergeHistory, ReviewSlotLedger,
  type RunResult,
} from './review-runner-guard.js';
import { runReviewRunnerGuardCli } from '../../scripts/review-runner-guard.js';

const HEAD = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const MERGE_BASE = 'd'.repeat(40);
const MERGE = 'e'.repeat(40);
const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Ledger root + canonical cap file fixture; the cap value is the file content, as in K-EAST. */
function fixture(capText: string) {
  const root = mkdtempSync(join(tmpdir(), 'a204-review-ledger-'));
  roots.push(root);
  const capFile = join(root, 'heavy-slot-review-cap.txt');
  writeFileSync(capFile, `${capText}\n`);
  return { root: join(root, 'review-acp-slots'), capFile };
}

/** Fake git: one merge commit in base..head whose remerge-diff is `remerge`. */
function fakeGit(remerge: RunResult, calls: string[][] = []) {
  return (args: string[]): RunResult => {
    calls.push(args);
    const command = args[0] === '-C' ? args.slice(2) : args;
    if (command[0] === 'cat-file') return ok();
    if (command[0] === 'fetch') return ok();
    if (command[0] === 'rev-parse') return ok(`${BASE}\n`);
    if (command[0] === 'merge-base') return ok(`${MERGE_BASE}\n`);
    if (command[0] === 'rev-list' && command.includes('--merges')) return ok(`${MERGE}\n`);
    if (command[0] === 'show' && command.includes('--remerge-diff')) return remerge;
    return { status: 1, stdout: '', stderr: `unexpected git ${command.join(' ')}` };
  };
}

/** Fake gh whose PR identity can be swapped mid-review. */
function fakeGh(state: { head: string; body: string }, calls: string[][]) {
  return (args: string[]): RunResult => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ headRefOid: state.head, body: state.body }));
    if (args[0] === 'pr' && args[1] === 'comment') return ok(`https://github.com/o/r/pull/${args[2]}#issuecomment-4242\n`);
    if (args[0] === 'api' && args.includes('PATCH')) return ok('{}');
    return { status: 1, stdout: '', stderr: 'unexpected gh call' };
  };
}

function cliDeps(o: { gh?: (args: string[]) => RunResult; git?: (args: string[]) => RunResult; clock: { now: number }; pid: number; alive?: Set<number> }) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      gh: o.gh ?? (() => ({ status: 1, stdout: '', stderr: 'gh not expected' })),
      git: o.git ?? (() => ({ status: 1, stdout: '', stderr: 'git not expected' })),
      now: () => o.clock.now, host: 'test-host', pid: o.pid,
      pidAlive: (pid: number) => o.alive?.has(pid) ?? false,
      print: (line: string) => { lines.push(line); }, home: '/nonexistent-home', token: () => `token-${o.pid}`,
    },
    last: () => JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>,
  };
}

describe('REVIEW-ACCEPT-MERGE-MAIN — a hand-resolved main merge is reviewed as merge-base..head', () => {
  test('a merge with hand-resolved content is clean with reviewedDiff merge-base, never needs-clean-branch', () => {
    const result = preflightMergeHistory({ pr: '38029', head: HEAD, baseTip: BASE, git: fakeGit(ok('diff --git a/x b/x\n+resolved\n')) });
    expect(result).toEqual({ status: 'clean', mergeCommits: [MERGE], reviewedDiff: 'merge-base', mergeBase: MERGE_BASE,
      resolutionMerges: [MERGE] });
  });

  test('a clean merge stays reviewable', () => {
    expect(preflightMergeHistory({ pr: '38029', head: HEAD, baseTip: BASE, git: fakeGit(ok('')) }))
      .toEqual({ status: 'clean', mergeCommits: [MERGE] });
  });

  test('CLI preflight on a resolved merge exits 0, writes no terminal record, and begin admits', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 27) };
    const pre = cliDeps({ git: fakeGit(ok('+resolved\n')), clock, pid: 101 });
    const common = ['--ledger-root', root, '--cap-file', capFile, '--no-marker'];
    expect(runReviewRunnerGuardCli(['preflight', '38029', '--head', HEAD, ...common], pre.deps)).toBe(0);
    expect(pre.last()).toMatchObject({ status: 'clean', reviewedDiff: 'merge-base', mergeBase: MERGE_BASE });
    expect(pre.last().refusal).toBeUndefined();
    expect(existsSync(join(root, 'terminal'))).toBe(false);
    const begin = cliDeps({ gh: fakeGh({ head: HEAD, body: 'body' }, []), clock, pid: 103, alive: new Set([103]) });
    expect(runReviewRunnerGuardCli(['begin', '38029', '--seat', 'RES', '--engine', 'terra', ...common], begin.deps)).toBe(0);
    expect(begin.last()).toMatchObject({ status: 'acquired' });
  });

  test('an older needs-clean-branch terminal record is read as absent and removed', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 27) };
    const ledger = new ReviewSlotLedger({ root, capFile, now: () => clock.now, host: 'test-host', pid: 104, pidAlive: () => false });
    mkdirSync(join(root, 'terminal'), { recursive: true });
    writeFileSync(ledger.terminalPath('39824', HEAD), JSON.stringify({ refusal: 'needs-clean-branch',
      reason: 'main-merge-has-resolution-changes', authorAction: NEEDS_CLEAN_BRANCH_AUTHOR_ACTION, recordedAt: clock.now }));
    expect(ledger.terminalRefusal('39824', HEAD)).toBeUndefined();
    expect(existsSync(ledger.terminalPath('39824', HEAD))).toBe(false);
    const calls: string[][] = [];
    const run = cliDeps({ git: fakeGit(ok('+resolved\n'), calls), clock, pid: 105 });
    expect(runReviewRunnerGuardCli(['preflight', '39824', '--head', HEAD, '--ledger-root', root, '--cap-file', capFile], run.deps)).toBe(0);
    expect(calls.some((args) => args.includes('--remerge-diff'))).toBe(true);
  });
});

describe('REVIEW-ACCEPT-MERGE-MAIN — real temp git repository', () => {
  function realRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'review-merge-main-'));
    roots.push(dir);
    const git = (args: string[]): RunResult => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const must = (args: string[]): string => {
      const r = git(args);
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
    const commit = (message: string) => { must(['add', '-A']); must(['commit', '-q', '-m', message]); return must(['rev-parse', 'HEAD']); };
    must(['init', '-q', '-b', 'main']);
    write('shared.txt', 'line1\nline2\nline3\n');
    write('main-only.txt', 'm0\n');
    const root = commit('root');
    return { dir, git, must, write, commit, root };
  }

  test('clean branch: no merges, nothing to exclude', () => {
    const r = realRepo();
    r.must(['checkout', '-q', '-b', 'pr']);
    r.write('pr.txt', 'pr change\n');
    const head = r.commit('pr');
    r.must(['checkout', '-q', 'main']);
    r.write('main-only.txt', 'm1\n');
    const baseTip = r.commit('main moves');
    expect(preflightMergeHistory({ pr: '1', head, baseTip, git: r.git })).toEqual({ status: 'clean', mergeCommits: [] });
  });

  test('branch with main merged cleanly: reviewable, merge-base diff excludes main-side changes', () => {
    const r = realRepo();
    r.must(['checkout', '-q', '-b', 'pr']);
    r.write('pr.txt', 'pr change\n');
    r.commit('pr');
    r.must(['checkout', '-q', 'main']);
    r.write('main-only.txt', 'm1\n');
    const baseTip = r.commit('main moves');
    r.must(['checkout', '-q', 'pr']);
    r.must(['merge', '-q', '--no-edit', 'main']);
    const head = r.must(['rev-parse', 'HEAD']);
    const result = preflightMergeHistory({ pr: '2', head, baseTip, git: r.git });
    expect(result).toEqual({ status: 'clean', mergeCommits: [head] });
    const mergeBase = r.must(['merge-base', baseTip, head]);
    expect(mergeBase).toBe(baseTip);
    const reviewed = r.must(['diff', `${mergeBase}..${head}`]);
    expect(reviewed).toContain('pr change');
    expect(reviewed).not.toContain('main-only.txt');
  });

  test('conflict-resolution merge: reviewed as merge-base..head with the resolution hunk, without main-only changes', () => {
    const r = realRepo();
    r.must(['checkout', '-q', '-b', 'pr']);
    r.write('shared.txt', 'line1\nPR line2\nline3\n');
    r.commit('pr edits shared');
    r.must(['checkout', '-q', 'main']);
    r.write('shared.txt', 'line1\nMAIN line2\nline3\n');
    r.write('main-only.txt', 'm1\n');
    const baseTip = r.commit('main edits shared');
    r.must(['checkout', '-q', 'pr']);
    expect(r.git(['merge', '-q', '--no-edit', 'main']).status).not.toBe(0);
    r.write('shared.txt', 'line1\nRESOLVED PR+MAIN line2\nline3\n');
    r.must(['add', 'shared.txt']);
    r.must(['commit', '-q', '--no-edit']);
    const head = r.must(['rev-parse', 'HEAD']);
    const result = preflightMergeHistory({ pr: '3', head, baseTip, git: r.git });
    expect(result).toEqual({ status: 'clean', mergeCommits: [head], reviewedDiff: 'merge-base', mergeBase: baseTip,
      resolutionMerges: [head] });
    const reviewed = r.must(['diff', `${baseTip}..${head}`]);
    expect(reviewed).toContain('+RESOLVED PR+MAIN line2');
    expect(reviewed).toContain('-MAIN line2');
    expect(reviewed).not.toContain('main-only.txt');
    // CLI on the same real repo: exit 0, no terminal record.
    const { root, capFile } = fixture('2');
    const fetchless = (args: string[]): RunResult => (args[0] === 'fetch' ? ok() : r.git(args));
    const cli = cliDeps({ git: (args) => {
      // No remote in the temp repo: answer fetch and point FETCH_HEAD at main.
      if (args[0] === 'rev-parse' && args.includes('FETCH_HEAD^{commit}')) return ok(`${baseTip}\n`);
      return fetchless(args);
    }, clock: { now: Date.UTC(2026, 10, 27) }, pid: 302 });
    expect(runReviewRunnerGuardCli(['preflight', '3', '--head', head, '--ledger-root', root, '--cap-file', capFile], cli.deps)).toBe(0);
    expect(cli.last()).toMatchObject({ status: 'clean', reviewedDiff: 'merge-base', mergeBase: baseTip });
    expect(existsSync(join(root, 'terminal'))).toBe(false);
  });
});

describe('A204 #38060 r1 MF — an uncomputable remerge-diff is not proof of resolution', () => {
  const failed: RunResult = { status: 128, stdout: '', stderr: 'remerge-diff unavailable' };

  test('a failed remerge-diff is unmeasured (main-merge-resolution-unknown), never needs-clean-branch', () => {
    expect(preflightMergeHistory({ pr: '38060', head: HEAD, baseTip: BASE, git: fakeGit(failed) }))
      .toEqual({ status: 'unmeasured', reason: 'main-merge-resolution-unknown' });
  });

  test('CLI preflight on an uncomputable merge exits 0 and leaves no terminal record', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 17) };
    const run = cliDeps({ git: fakeGit(failed), clock, pid: 201 });
    const common = ['--ledger-root', root, '--cap-file', capFile];
    expect(runReviewRunnerGuardCli(['preflight', '38060', '--head', HEAD, ...common], run.deps)).toBe(0);
    expect(run.last()).toMatchObject({ status: 'unmeasured', reason: 'main-merge-resolution-unknown' });
    expect(existsSync(join(root, 'terminal'))).toBe(false);
  });

  test('clear removes a terminal record by PR+head', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 17) };
    const ledger = new ReviewSlotLedger({ root, capFile, now: () => clock.now, host: 'test-host', pid: 206, pidAlive: () => false });
    mkdirSync(join(root, 'terminal'), { recursive: true });
    writeFileSync(ledger.terminalPath('38060', HEAD), JSON.stringify({ refusal: 'needs-clean-branch', reason: 'merge-resolution-unknown', recordedAt: clock.now }));
    const clear = cliDeps({ clock, pid: 205 });
    expect(runReviewRunnerGuardCli(['clear', '38060', '--head', HEAD, '--ledger-root', root, '--cap-file', capFile], clear.deps)).toBe(0);
    expect(clear.last()).toMatchObject({ cleared: true });
    expect(existsSync(ledger.terminalPath('38060', HEAD))).toBe(false);
  });
});

describe('A204 identity freeze', () => {
  test('a body edit mid-review names body, the window and the author action; marker is updated', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 17, 1) };
    const state = { head: HEAD, body: 'original body' };
    const ghCalls: string[][] = [];
    const run = cliDeps({ gh: fakeGh(state, ghCalls), clock, pid: 201, alive: new Set([201]) });
    const common = ['--ledger-root', root, '--cap-file', capFile];
    expect(runReviewRunnerGuardCli(['begin', '38047', '--seat', 'OP', '--engine', 'claude-acp', ...common], run.deps)).toBe(0);
    expect(run.last()).toMatchObject({ status: 'acquired', markerCommentId: '4242', frozen: { head: HEAD, bodySha256: bodySha256('original body') } });
    expect(ghCalls.find((args) => args[1] === 'comment')?.join(' ')).toContain('리뷰 중 — 본문·head 동결');

    const status = cliDeps({ clock, pid: 202, alive: new Set([201]) });
    expect(runReviewRunnerGuardCli(['status', '38047', ...common], status.deps)).toBe(0);
    expect(status.last()).toMatchObject({ frozen: true });

    state.body = 'edited by the author';
    clock.now += 60_000;
    expect(runReviewRunnerGuardCli(['end', '38047', '--token', 'token-201', ...common], run.deps)).toBe(7);
    const end = run.last() as { identity: Record<string, unknown>; markerReleased: boolean };
    expect(end.identity).toMatchObject({ match: false, refusal: 'identity-changed-during-review', changed: ['body'], actor: 'author',
      frozenAt: new Date(Date.UTC(2026, 10, 17, 1)).toISOString(), detectedAt: new Date(clock.now).toISOString() });
    expect(String(end.identity.authorAction)).toContain('PR 본문 수정');
    expect(String(end.identity.authorAction)).not.toContain('head(새 커밋 push)');
    expect(end.markerReleased).toBe(true);
    expect(ghCalls.some((args) => args.includes('repos/{owner}/{repo}/issues/comments/4242'))).toBe(true);

    expect(runReviewRunnerGuardCli(['status', '38047', ...common], status.deps)).toBe(0);
    expect(status.last()).toMatchObject({ frozen: false, holders: [] });
  });

  test('a new head mid-review names head only', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 17, 2) };
    const state = { head: HEAD, body: 'same body' };
    const run = cliDeps({ gh: fakeGh(state, []), clock, pid: 301, alive: new Set([301]) });
    const common = ['--ledger-root', root, '--cap-file', capFile, '--no-marker'];
    expect(runReviewRunnerGuardCli(['begin', '38047', '--seat', 'RES', '--engine', 'terra', ...common], run.deps)).toBe(0);
    state.head = HEAD_2;
    expect(runReviewRunnerGuardCli(['end', '38047', '--token', 'token-301', ...common], run.deps)).toBe(7);
    expect(run.last()).toMatchObject({ identity: { changed: ['head'] }, markerReleased: false });
  });
});

describe('A204 single review-slot ledger', () => {
  const ledger = (root: string, capFile: string, clock: { now: number }, pid: number, alive: Set<number>) => new ReviewSlotLedger({
    root, capFile, now: () => clock.now, host: 'test-host', pid, pidAlive: (candidate) => alive.has(candidate), token: () => `token-${pid}`,
  });

  test('OP and RES launching the same PR+head: one wins, the other gets already-reviewing', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: 1 };
    const alive = new Set([401, 402]);
    const op = ledger(root, capFile, clock, 401, alive).acquire({ pr: '38047', head: HEAD, seat: 'OP', engine: 'claude-acp' });
    const res = ledger(root, capFile, clock, 402, alive).acquire({ pr: '38047', head: HEAD.toUpperCase(), seat: 'RES', engine: 'terra' });
    expect(op).toMatchObject({ status: 'acquired', slot: '1.d' });
    expect(res).toMatchObject({ status: 'already-reviewing', slot: '1.d', holder: { seat: 'OP', pid: 401 } });
  });

  test('the canonical cap file bounds different PRs; release frees the slot', () => {
    const { root, capFile } = fixture('1');
    const clock = { now: 1 };
    const alive = new Set([501, 502]);
    const first = ledger(root, capFile, clock, 501, alive);
    const second = ledger(root, capFile, clock, 502, alive);
    expect(first.acquire({ pr: '1', head: HEAD, seat: 'OP', engine: 'claude-acp' })).toMatchObject({ status: 'acquired' });
    expect(second.acquire({ pr: '2', head: HEAD_2, seat: 'RES', engine: 'terra' })).toMatchObject({ status: 'cap-full', occupied: 1 });
    expect(first.release('token-501', { verdict: 'pass' })).toBe(true);
    expect(second.acquire({ pr: '2', head: HEAD_2, seat: 'RES', engine: 'terra' })).toMatchObject({ status: 'acquired' });
  });

  test('legacy owner.txt slots count toward the cap and are never reclaimed here', () => {
    const { root, capFile } = fixture('1');
    mkdirSync(join(root, '3.d'), { recursive: true });
    writeFileSync(join(root, '3.d', 'owner.txt'), 'pid=1 pr=9 engine=claude-acp\n');
    const clock = { now: DEFAULT_STALE_AFTER_MS * 4 };
    expect(ledger(root, capFile, clock, 601, new Set()).acquire({ pr: '2', head: HEAD, seat: 'OP', engine: 'claude-acp' }))
      .toMatchObject({ status: 'cap-full', reclaimed: [] });
    expect(existsSync(join(root, '3.d'))).toBe(true);
  });

  test('stale reclaim: a silent dead holder is archived; a silent live same-host holder is kept', () => {
    const { root, capFile } = fixture('1');
    const clock = { now: 1 };
    const alive = new Set([701, 702]);
    expect(ledger(root, capFile, clock, 701, alive).acquire({ pr: '1', head: HEAD, seat: 'OP', engine: 'claude-acp' })).toMatchObject({ status: 'acquired' });
    clock.now += DEFAULT_STALE_AFTER_MS + 1;
    const waiter = ledger(root, capFile, clock, 702, alive);
    expect(waiter.acquire({ pr: '2', head: HEAD_2, seat: 'RES', engine: 'terra' })).toMatchObject({ status: 'cap-full', reclaimed: [] });
    alive.delete(701);
    const reclaimed = waiter.acquire({ pr: '2', head: HEAD_2, seat: 'RES', engine: 'terra' });
    expect(reclaimed).toMatchObject({ status: 'acquired', slot: '1.d' });
    expect((reclaimed as { reclaimed: string[] }).reclaimed).toHaveLength(1);
    expect(readdirSync(join(root, '_archive')).some((name) => name.startsWith('1.d.stale-'))).toBe(true);
  });

  test('a heartbeat keeps a holder fresh', () => {
    const { root, capFile } = fixture('1');
    const clock = { now: 1 };
    const holder = ledger(root, capFile, clock, 801, new Set());
    expect(holder.acquire({ pr: '1', head: HEAD, seat: 'OP', engine: 'claude-acp' })).toMatchObject({ status: 'acquired' });
    clock.now += DEFAULT_STALE_AFTER_MS;
    expect(holder.heartbeat('token-801')).toBe(true);
    clock.now += DEFAULT_STALE_AFTER_MS;
    expect(ledger(root, capFile, clock, 802, new Set()).acquire({ pr: '2', head: HEAD_2, seat: 'RES', engine: 'terra' }))
      .toMatchObject({ status: 'cap-full' });
  });

  test('a mutex held by a live process returns ledger-busy instead of a second admission', () => {
    const { root, capFile } = fixture('2');
    mkdirSync(join(root, '.ledger-mutex.d'), { recursive: true });
    writeFileSync(join(root, '.ledger-mutex.d', 'owner.json'), JSON.stringify({ pid: 901, host: 'test-host', at: 1 }));
    const clock = { now: 2 };
    expect(ledger(root, capFile, clock, 902, new Set([901])).acquire({ pr: '1', head: HEAD, seat: 'OP', engine: 'claude-acp' }))
      .toEqual({ status: 'ledger-busy' });
  });

  test('a missing canonical cap file refuses admission instead of guessing a cap', () => {
    const { root } = fixture('2');
    expect(ledger(root, join(root, 'absent-cap.txt'), { now: 1 }, 1001, new Set()).acquire({ pr: '1', head: HEAD, seat: 'OP', engine: 'claude-acp' }))
      .toEqual({ status: 'cap-unavailable', reason: 'review-cap-file-missing' });
  });
});
