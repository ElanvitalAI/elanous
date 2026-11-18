import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bodySha256, DEFAULT_STALE_AFTER_MS, NEEDS_CLEAN_BRANCH_AUTHOR_ACTION, preflightMergeHistory, ReviewSlotLedger,
  TERMINAL_REFUSAL_TTL_MS,
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

describe('A204 needs-clean-branch', () => {
  test('a merge with hand-resolved content is terminal before any reviewer is admitted', () => {
    const result = preflightMergeHistory({ pr: '38029', head: HEAD, baseTip: BASE, git: fakeGit(ok('diff --git a/x b/x\n+resolved\n')) });
    expect(result).toMatchObject({ refusal: 'needs-clean-branch', reviewed: false, verdict: null, modelStarted: false,
      terminal: true, retryable: false, authorAction: NEEDS_CLEAN_BRANCH_AUTHOR_ACTION,
      reason: 'main-merge-has-resolution-changes', mergeCommits: [MERGE] });
  });

  test('a clean merge stays reviewable', () => {
    expect(preflightMergeHistory({ pr: '38029', head: HEAD, baseTip: BASE, git: fakeGit(ok('')) }))
      .toEqual({ status: 'clean', mergeCommits: [MERGE] });
  });

  test('CLI preflight records a terminal refusal; begin then refuses without freezing or commenting', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 17) };
    const ghCalls: string[][] = [];
    const gh = fakeGh({ head: HEAD, body: 'body' }, ghCalls);
    const pre = cliDeps({ git: fakeGit(ok('+resolved\n')), clock, pid: 101 });
    const common = ['--ledger-root', root, '--cap-file', capFile];
    expect(runReviewRunnerGuardCli(['preflight', '38029', '--head', HEAD, ...common], pre.deps)).toBe(3);
    expect(pre.last()).toMatchObject({ refusal: 'needs-clean-branch', authorAction: NEEDS_CLEAN_BRANCH_AUTHOR_ACTION });
    // A second launch of the same PR+head returns the recorded refusal without touching git again.
    const again = cliDeps({ clock, pid: 102 });
    expect(runReviewRunnerGuardCli(['preflight', '38029', '--head', HEAD, ...common], again.deps)).toBe(3);
    expect(again.last()).toMatchObject({ refusal: 'needs-clean-branch', source: 'ledger-terminal' });
    const begin = cliDeps({ gh, clock, pid: 103 });
    expect(runReviewRunnerGuardCli(['begin', '38029', '--seat', 'RES', '--engine', 'claude-acp', ...common], begin.deps)).toBe(3);
    expect(begin.last()).toMatchObject({ status: 'terminal-refusal' });
    expect(ghCalls.filter((args) => args[1] === 'comment')).toEqual([]);
    expect(readdirSync(root).filter((name) => name.endsWith('.d') && !name.startsWith('.'))).toEqual([]);
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

  test('a terminal record expires: past the TTL the next preflight measures again', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 17) };
    const common = ['--ledger-root', root, '--cap-file', capFile];
    const first = cliDeps({ git: fakeGit(ok('+resolved\n')), clock, pid: 202 });
    expect(runReviewRunnerGuardCli(['preflight', '38060', '--head', HEAD, ...common], first.deps)).toBe(3);
    clock.now += TERMINAL_REFUSAL_TTL_MS;
    const calls: string[][] = [];
    const later = cliDeps({ git: fakeGit(ok(''), calls), clock, pid: 203 });
    expect(runReviewRunnerGuardCli(['preflight', '38060', '--head', HEAD, ...common], later.deps)).toBe(0);
    expect(later.last()).toMatchObject({ status: 'clean' });
    expect(calls.some((args) => args.includes('--remerge-diff'))).toBe(true);
  });

  test('clear removes a terminal record; an older unknown-as-terminal record is read as absent', () => {
    const { root, capFile } = fixture('2');
    const clock = { now: Date.UTC(2026, 10, 17) };
    const common = ['--ledger-root', root, '--cap-file', capFile];
    const first = cliDeps({ git: fakeGit(ok('+resolved\n')), clock, pid: 204 });
    expect(runReviewRunnerGuardCli(['preflight', '38060', '--head', HEAD, ...common], first.deps)).toBe(3);
    const clear = cliDeps({ clock, pid: 205 });
    expect(runReviewRunnerGuardCli(['clear', '38060', '--head', HEAD, ...common], clear.deps)).toBe(0);
    expect(clear.last()).toMatchObject({ cleared: true });
    const ledger = new ReviewSlotLedger({ root, capFile, now: () => clock.now, host: 'test-host', pid: 206, pidAlive: () => false });
    expect(ledger.terminalRefusal('38060', HEAD)).toBeUndefined();
    mkdirSync(join(root, 'terminal'), { recursive: true });
    writeFileSync(ledger.terminalPath('38060', HEAD_2), JSON.stringify({ refusal: 'needs-clean-branch', reason: 'merge-resolution-unknown', recordedAt: clock.now }));
    expect(ledger.terminalRefusal('38060', HEAD_2)).toBeUndefined();
    expect(existsSync(ledger.terminalPath('38060', HEAD_2))).toBe(false);
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
