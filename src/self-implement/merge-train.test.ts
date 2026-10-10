import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrateTrain, planTrain, runTrain, type TrainCandidate, type TrainGit, type TrainObservation } from './merge-train.js';

const candidates = Array.from({ length: 8 }, (_, index): TrainCandidate => ({ number: index + 1, head: 'a'.repeat(40), files: [`${index}.ts`] }));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'merge-train-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'shared.txt'), 'original\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  function branch(name: string, file: string, text: string) {
    git(repo, 'checkout', '-qb', name, base);
    writeFileSync(join(repo, file), text);
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', name);
    return git(repo, 'rev-parse', 'HEAD');
  }
  const first = branch('first', 'first.txt', 'first\n');
  const second = branch('second', 'second.txt', 'second\n');
  const conflict = branch('conflict', 'shared.txt', 'incoming\n');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'shared.txt'), 'main changed\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'main changed');
  return { repo, base: git(repo, 'rev-parse', 'HEAD'), first, second, conflict };
}

test('planTrain selects disjoint PRs in order and defers overlap and unmeasured files', () => {
  const input: TrainCandidate[] = [
    { number: 1, head: 'a', files: ['a', 'b'] }, { number: 2, head: 'b', files: ['b'] },
    { number: 3, head: 'c', filesUnmeasured: true, files: ['c'] }, { number: 4, head: 'd', files: ['d'] },
    { number: 5, head: 'e', files: ['a', 'd'] },
  ];
  expect(planTrain(input, { maxBatch: 8 })).toEqual({ batch: [input[0], input[3]], deferred: [
    { number: 2, reason: 'overlap', with: [1] }, { number: 3, reason: 'files-unknown' },
    { number: 5, reason: 'overlap', with: [1, 4] },
  ] });
  expect(planTrain(input.slice(2), { maxBatch: 8 })).toEqual({ batch: [input[2]], deferred: [
    { number: 4, reason: 'files-unknown' }, { number: 5, reason: 'files-unknown' },
  ] });
  expect(planTrain(candidates, { maxBatch: 2 }).batch.map((item) => item.number)).toEqual([1, 2]);
});

test('8 disjoint PRs pass with one gate and a 0.125 gate-per-landing observation', async () => {
  const observed: TrainObservation[] = [];
  let calls = 0;
  const planned = planTrain(candidates, { maxBatch: 8 });
  const result = await runTrain(planned.batch, {
    deferred: planned.deferred,
    integrate: () => ({ commitSha: 'b'.repeat(40), conflicts: [] }),
    gate: (_sha, numbers) => { calls++; expect(numbers).toEqual(candidates.map((item) => item.number)); return 'pass'; },
    observe: (data) => { observed.push(data); },
  });
  expect(result).toEqual({ verdicts: candidates.map((item) => ({ number: item.number, verdict: 'pass' })), gatesRun: 1, integrations: 1 });
  expect(calls).toBe(1);
  expect(observed).toEqual([{ batch: [1, 2, 3, 4, 5, 6, 7, 8], deferred: [], gatesRun: 1,
    passed: [1, 2, 3, 4, 5, 6, 7, 8], culprits: [], unmeasured: [], gatesPerLanding: 0.125 }]);
});

test('omitted deferred remains unknown in the train-verdict log rather than reporting no deferred PRs', async () => {
  const observed: TrainObservation[] = [];
  await runTrain(candidates.slice(0, 1), {
    integrate: () => ({ commitSha: 'b'.repeat(40), conflicts: [] }),
    gate: () => 'pass',
    observe: (data) => { observed.push(data); },
  });
  expect(observed).toEqual([{ batch: [1], deferred: null, gatesRun: 1,
    passed: [1], culprits: [], unmeasured: [], gatesPerLanding: 1 }]);
});

test('provided overlap deferrals survive in the train observation', async () => {
  const planned = planTrain([
    { number: 1, head: 'a', files: ['shared'] },
    { number: 2, head: 'b', files: ['shared'] },
  ], { maxBatch: 2 });
  const observed: TrainObservation[] = [];
  await runTrain(planned.batch, {
    deferred: planned.deferred,
    integrate: () => ({ commitSha: 'b'.repeat(40), conflicts: [] }),
    gate: () => 'pass',
    observe: (data) => { observed.push(data); },
  });
  expect(observed[0]?.deferred).toEqual([{ number: 2, reason: 'overlap', with: [1] }]);
});

test('failed train bisects and isolates #5 without failing seven innocent PRs', async () => {
  const groups: number[][] = [];
  const result = await runTrain(candidates, {
    integrate: () => ({ commitSha: 'b'.repeat(40), conflicts: [] }),
    gate: (_sha, numbers) => { groups.push(numbers); return numbers.includes(5) ? 'fail' : 'pass'; },
    observe: () => {},
  });
  expect(result.verdicts).toEqual(candidates.map((item) => ({ number: item.number, verdict: item.number === 5 ? 'fail' : 'pass' })));
  expect(result.gatesRun).toBe(groups.length);
  expect(groups.length).toBeLessThanOrEqual(7);
  expect(groups[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a failed combination with two passing halves remains unmeasured rather than passing the original train', async () => {
  const groups: number[][] = [];
  const observations: TrainObservation[] = [];
  const result = await runTrain(candidates.slice(0, 4), {
    integrate: () => ({ commitSha: 'b'.repeat(40), conflicts: [] }),
    gate: (_sha, numbers) => { groups.push(numbers); return numbers.length === 4 ? 'fail' : 'pass'; },
    observe: (data) => { observations.push(data); },
  });
  expect(groups).toEqual([[1, 2, 3, 4], [1, 2], [3, 4]]);
  expect(result).toEqual({ verdicts: [1, 2, 3, 4].map((number) => ({ number, verdict: 'unmeasured' })), gatesRun: 3, integrations: 3 });
  expect(observations).toEqual([{ batch: [1, 2, 3, 4], deferred: null, gatesRun: 3,
    passed: [], culprits: [], unmeasured: [1, 2, 3, 4], gatesPerLanding: 3 }]);
});

test('a nested interaction failure leaves its PRs unmeasured while a separately passing half stays passed', async () => {
  const groups: number[][] = [];
  const result = await runTrain(candidates.slice(0, 4), {
    integrate: () => ({ commitSha: 'b'.repeat(40), conflicts: [] }),
    gate: (_sha, numbers) => { groups.push(numbers); return numbers.includes(1) && numbers.includes(2) ? 'fail' : 'pass'; },
    observe: () => {},
  });
  expect(groups).toEqual([[1, 2, 3, 4], [1, 2], [1], [2], [3, 4]]);
  expect(result.verdicts).toEqual([1, 2, 3, 4].map((number) => ({ number, verdict: number <= 2 ? 'unmeasured' : 'pass' })));
});

test('unmeasured gate or unsupported integration stops further bisect and leaves unresolved PRs unmeasured', async () => {
  const groups: number[][] = [];
  const result = await runTrain(candidates.slice(0, 4), {
    integrate: (group) => group.length === 2 && group[0]?.number === 1
      ? { conflicts: [], unmeasured: true } : { commitSha: 'a'.repeat(40), conflicts: [] },
    gate: (_sha, numbers) => { groups.push(numbers); return 'fail'; },
    observe: () => {},
  });
  expect(groups).toEqual([[1, 2, 3, 4]]);
  expect(result).toEqual({ verdicts: [1, 2, 3, 4].map((number) => ({ number, verdict: 'unmeasured' })), gatesRun: 1, integrations: 2 });
  const gateUnknown = await runTrain(candidates, { integrate: () => ({ commitSha: 'a'.repeat(40), conflicts: [] }), gate: () => 'unmeasured', observe: () => {} });
  expect(gateUnknown.gatesRun).toBe(1);
  expect(gateUnknown.verdicts.every((item) => item.verdict === 'unmeasured')).toBe(true);
  const partial = await runTrain(candidates.slice(0, 4), {
    integrate: () => ({ commitSha: 'a'.repeat(40), conflicts: [] }),
    gate: (_sha, numbers) => numbers.length === 4 ? 'fail' : numbers[0] === 1 ? 'pass' : 'unmeasured',
    observe: () => {},
  });
  expect(partial.verdicts).toEqual([1, 2, 3, 4].map((number) => ({ number, verdict: number <= 2 ? 'pass' : 'unmeasured' })));
  expect(partial.gatesRun).toBe(3);
});

test('real merge-tree builds both disjoint changes, excludes a conflicting branch, and never checks out', () => {
  const { repo, base, first, second, conflict } = fixture();
  const calls: string[][] = [];
  const injected: TrainGit = (args, cwd) => {
    calls.push([...args]);
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const result = integrateTrain(repo, base, [
    { number: 1, head: first }, { number: 3, head: conflict }, { number: 2, head: second },
  ], injected);
  expect(result.conflicts).toEqual([{ number: 3, reason: 'conflict', files: ['shared.txt'] }]);
  expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(git(repo, 'show', `${result.commitSha}:first.txt`)).toBe('first');
  expect(git(repo, 'show', `${result.commitSha}:second.txt`)).toBe('second');
  expect(git(repo, 'show', `${result.commitSha}:shared.txt`)).toBe('main changed');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
  expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('main changed\n');
  expect(calls.some((args) => args.includes('worktree') || args.includes('checkout') || args.includes('push') || args.includes('merge'))).toBe(false);
  expect(calls.filter((args) => args.includes('commit-tree'))).toHaveLength(2);
}, 30_000);

test('unsupported merge-tree option fails closed without attempting checkout or gate', async () => {
  const calls: string[][] = [];
  const integrated = integrateTrain('/not-used', 'a'.repeat(40), candidates.slice(0, 2), (args) => {
    calls.push([...args]); return { status: 129, stdout: '', stderr: 'error: unknown option `write-tree`' };
  });
  expect(integrated).toEqual({ conflicts: [], unmeasured: true });
  expect(calls).toHaveLength(1);
  let gateCalls = 0;
  const verdict = await runTrain(candidates.slice(0, 2), {
    integrate: () => integrated, gate: () => { gateCalls++; return 'pass'; }, observe: () => {},
  });
  expect(gateCalls).toBe(0);
  expect(verdict.verdicts).toEqual([{ number: 1, verdict: 'unmeasured' }, { number: 2, verdict: 'unmeasured' }]);
});

test('conflicting PR is excluded from gate while remaining PRs pass', async () => {
  const verdict = await runTrain(candidates.slice(0, 3), {
    integrate: () => ({ commitSha: 'a'.repeat(40), conflicts: [{ number: 2, reason: 'conflict', files: ['x'] }] }),
    gate: (_sha, numbers) => { expect(numbers).toEqual([1, 3]); return 'pass'; }, observe: () => {},
  });
  expect(verdict.verdicts).toEqual([{ number: 1, verdict: 'pass' }, { number: 2, verdict: 'conflict' }, { number: 3, verdict: 'pass' }]);
});
