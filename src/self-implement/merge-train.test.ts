import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrateTrain, planTrain, runTrain, tangledPairs, type TrainCandidate, type TrainGit, type TrainObservation } from './merge-train.js';
import { enqueueL8ShadowQueue, runL8ShadowQueue, statusL8ShadowQueue } from './l8-merge-queue.js';
import { createGraphEventBus } from '../graph-runner/graph-events.js';
import { createMacrophageRuntime } from '../release-loop/macrophage-heal-node.js';

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

test('tangledPairs combines reversed pairs and returns only pairs at the threshold', () => {
  expect(tangledPairs([
    { pr: 5, with: 7 }, { pr: 7, with: 5 }, { pr: 5, with: 7 }, { pr: 8, with: 9 },
  ])).toEqual([{ first: 5, then: 7, failures: 3 }]);
  expect(tangledPairs([{ pr: 5, with: 7 }])).toEqual([]);
  expect(tangledPairs([{ pr: 5, with: 7 }, { pr: 7, with: 5 }, { pr: 8, with: 9 }])).toEqual([
    { first: 5, then: 7, failures: 2 },
  ]);
  expect(tangledPairs([{ pr: 5, with: 7 }, { pr: 8, with: 9 }], { threshold: 1 })).toEqual([
    { first: 5, then: 7, failures: 1 }, { first: 8, then: 9, failures: 1 },
  ]);
  expect(tangledPairs([{ pr: 5, with: 7 }, { pr: 7, with: 5 }], { threshold: 3 })).toEqual([]);
});

test('tangledPairs honors an explicit threshold option', () => {
  const failures = [{ pr: 5, with: 7 }, { pr: 7, with: 5 }, { pr: 8, with: 9 }];
  expect(tangledPairs(failures, { threshold: 2 })).toEqual([{ first: 5, then: 7, failures: 2 }]);
  expect(tangledPairs(failures, { threshold: 3 })).toEqual([]);
  expect(tangledPairs(failures, { threshold: 1 })).toEqual([
    { first: 5, then: 7, failures: 2 }, { first: 8, then: 9, failures: 1 },
  ]);
});

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

test('runTrain emits real batch and verdict progress into the macrophage simulation receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-train-macrophage-'));
  dirs.push(root);
  const runId = 'train-macrophage-run';
  const graphId = 'train-macrophage-sim';
  const bus = createGraphEventBus();
  const macrophage = createMacrophageRuntime({ runId, graphId, root, eventBus: bus, mode: 'simulation' });
  const emitted: string[] = [];
  const largeBatch = Array.from({ length: 40 }, (_, index): TrainCandidate => ({
    number: 100 + index, head: index.toString(16).padStart(40, '0'), files: [`${index}.ts`],
  }));
  try {
    const result = await runTrain(largeBatch, {
      progressId: 'batch-42',
      emitProgress: async (event) => {
        emitted.push(event.type);
        await bus.publish({ eventId: event.eventId, graphId, runId, type: event.type,
          source: { kind: 'node', nodeId: 'merge-train' },
          data: event.type === 'merge-train.batch'
            ? { batch: event.batch }
            : { observation: event.observation, verdicts: event.verdicts } });
      },
      integrate: () => ({ commitSha: 'b'.repeat(40), conflicts: [] }),
      gate: () => 'pass',
      observe: () => {},
    });
    const failed = await runTrain([{ number: 900, head: 'c'.repeat(40), files: ['failed.ts'] }], {
      progressId: 'batch-fail',
      emitProgress: async (event) => {
        emitted.push(event.type);
        await bus.publish({ eventId: event.eventId, graphId, runId, type: event.type,
          source: { kind: 'node', nodeId: 'merge-train' },
          data: event.type === 'merge-train.batch'
            ? { batch: event.batch }
            : { observation: event.observation, verdicts: event.verdicts } });
      },
      integrate: () => ({ commitSha: 'd'.repeat(40), conflicts: [] }),
      gate: () => 'fail',
      observe: () => {},
    });
    const receiptPath = join(root, 'graph-runs', 'release-loop', `${runId}.json.contexts`, 'macrophage.jsonl');
    const receipts = readFileSync(receiptPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      eventId: string; data: Record<string, unknown>;
    });
    expect(result.verdicts.every(({ verdict }) => verdict === 'pass')).toBe(true);
    expect(failed.verdicts).toEqual([{ number: 900, verdict: 'fail' }]);
    expect(emitted).toEqual(['merge-train.batch', 'merge-train.verdict', 'merge-train.batch', 'merge-train.verdict']);
    expect(macrophage.decisions).toHaveLength(4);
    expect(macrophage.decisions.map((event) => event.data?.sourceEventType)).toEqual(emitted);
    expect(receipts).toHaveLength(4);
    expect(receipts.map((receipt) => receipt.data.sourceEventId)).toEqual([
      'batch-42:batch', 'batch-42:verdict', 'batch-fail:batch', 'batch-fail:verdict',
    ]);
    expect(receipts.every((receipt) => receipt.data.action === 'retain' && receipt.data.applied === false
      && receipt.data.sourceEventType?.toString().startsWith('merge-train.'))).toBe(true);
    expect((receipts[0]?.data.evidence as string).length).toBeGreaterThan(1200);
    expect(receipts[0]?.data.evidence).toContain('"number":139');
    expect(receipts[1]?.data.evidence).toContain('"passed":[100,101,102');
    expect(receipts[3]?.data.evidence).toContain('"verdict":"fail"');
  } finally { macrophage.dispose(); }
});

test('runTrain progress callback failures stop work or suppress a final verdict as documented', async () => {
  const candidate = candidates[0]!;
  let integrations = 0;
  const firstEvents: string[] = [];
  await expect(runTrain([candidate], {
    progressId: 'sink-fails',
    emitProgress: (event) => { firstEvents.push(event.type); throw new Error('batch sink failed'); },
    integrate: () => { integrations++; return { commitSha: 'b'.repeat(40), conflicts: [] }; },
    gate: () => 'pass', observe: () => {},
  })).rejects.toThrow('batch sink failed');
  expect(firstEvents).toEqual(['merge-train.batch']);
  expect(integrations).toBe(0);

  const observedEvents: string[] = [];
  await expect(runTrain([candidate], {
    progressId: 'observe-fails',
    emitProgress: (event) => { observedEvents.push(event.type); },
    integrate: () => ({ commitSha: 'b'.repeat(40), conflicts: [] }),
    gate: () => 'pass', observe: () => { throw new Error('observation sink failed'); },
  })).rejects.toThrow('observation sink failed');
  expect(observedEvents).toEqual(['merge-train.batch']);
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
  const injected: TrainGit = (args, cwd, env) => {
    calls.push([...args]);
    const result = spawnSync('git', [...args], { cwd, env, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const result = integrateTrain(repo, base, [
    { number: 1, head: first }, { number: 3, head: conflict }, { number: 2, head: second },
  ], injected);
  expect(result.conflicts).toEqual([{ number: 3, reason: 'conflict', files: ['shared.txt'] }]);
  expect(result.conflictPlans).toMatchObject([{ number: 3, files: ['shared.txt'], repairPlan: { decision: 'launch', reason: 'needs-repair' } }]);
  expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(git(repo, 'show', `${result.commitSha}:first.txt`)).toBe('first');
  expect(git(repo, 'show', `${result.commitSha}:second.txt`)).toBe('second');
  expect(git(repo, 'show', `${result.commitSha}:shared.txt`)).toBe('main changed');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
  expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('main changed\n');
  expect(calls.some((args) => args.includes('worktree') || args.includes('checkout') || args.includes('push') || args.includes('merge'))).toBe(false);
  expect(calls.filter((args) => args.includes('commit-tree'))).toHaveLength(2);
}, 30_000);

test('merge train applies append-only conflict plans to a shadow tree and gates the preserved main-first result', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'merge-train-append-only-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'shared.md'), 'base\n');
  chmodSync(join(repo, 'shared.md'), 0o755);
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-qb', 'pr', base);
  writeFileSync(join(repo, 'shared.md'), 'base\npr append\n');
  chmodSync(join(repo, 'shared.md'), 0o755);
  git(repo, 'commit', '-qam', 'pr append');
  const prHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'shared.md'), 'base\nmain append\n');
  chmodSync(join(repo, 'shared.md'), 0o755);
  git(repo, 'commit', '-qam', 'main append');
  const mainHead = git(repo, 'rev-parse', 'HEAD');
  let gatedTree = '';
  let gatedCommitSha = '';
  const observed: TrainObservation[] = [];
  const result = await runTrain([{ number: 41, head: prHead, title: 'PR 41 intent', body: 'PR 41 body' }], {
    integrate: (batch) => integrateTrain(repo, mainHead, batch),
    gate: (commitSha) => { gatedCommitSha = commitSha; gatedTree = git(repo, 'show', `${commitSha}:shared.md`); return 'pass'; },
    observe: (data) => { observed.push(data); },
  });
  expect(result.verdicts).toEqual([{ number: 41, verdict: 'pass' }]);
  expect(gatedTree).toBe('base\nmain append\npr append');
  expect(git(repo, 'ls-tree', gatedCommitSha, 'shared.md')).toMatch(/^100755 blob /);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(mainHead);
  expect(observed[0]?.conflictPlans).toMatchObject([{ number: 41, files: ['shared.md'], decision: 'automerge', reason: 'append-only' }]);
});

test('merge train carries complete repair goals for non-append conflicts without running the gate', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'merge-train-repair-plan-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'shared.md'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-qb', 'pr', base);
  writeFileSync(join(repo, 'shared.md'), 'pr changed\n');
  git(repo, 'commit', '-qam', 'pr changed');
  const prHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'shared.md'), 'main changed\n');
  git(repo, 'commit', '-qam', 'main changed');
  const mainHead = git(repo, 'rev-parse', 'HEAD');
  const candidate = { number: 42, head: prHead, title: 'PR intent title', body: 'PR body intent' };
  const integration = integrateTrain(repo, mainHead, [candidate]);
  expect(integration.conflicts).toHaveLength(1);
  expect(integration.conflictPlans?.[0]?.repairPlan).toMatchObject({ decision: 'launch', reason: 'needs-repair' });
  expect(integration.conflictPlans?.[0]?.repairPlan?.goal).toContain('MAIN (theirs)');
  let gateCalls = 0;
  const observed: TrainObservation[] = [];
  const result = await runTrain([candidate], {
    integrate: (batch) => integrateTrain(repo, mainHead, batch),
    gate: () => { gateCalls++; return 'pass'; },
    observe: (data) => { observed.push(data); },
  });
  expect(result.verdicts).toEqual([{ number: 42, verdict: 'conflict' }]);
  expect(gateCalls).toBe(0);
  expect(observed[0]?.conflictPlans).toMatchObject([{ number: 42, files: ['shared.md'], decision: 'launch', reason: 'needs-repair' }]);
  expect(observed[0]?.conflictPlans?.[0]?.goal).toContain('FILE shared.md');
  expect(observed[0]?.conflictPlans?.[0]?.goal).toContain('PR body intent');
});

test('merge train refuses to automerge symlink conflicts instead of replacing their type', () => {
  const repo = mkdtempSync(join(tmpdir(), 'merge-train-symlink-conflict-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@localhost');
  symlinkSync('base-target', join(repo, 'shared.md'));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-qb', 'pr', base);
  rmSync(join(repo, 'shared.md'));
  symlinkSync('pr-target', join(repo, 'shared.md'));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'pr link');
  const prHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  rmSync(join(repo, 'shared.md'));
  symlinkSync('main-target', join(repo, 'shared.md'));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'main link');
  const mainHead = git(repo, 'rev-parse', 'HEAD');
  const result = integrateTrain(repo, mainHead, [{ number: 43, head: prHead }]);
  expect(result.conflicts).toEqual([{ number: 43, reason: 'conflict', files: ['shared.md'] }]);
  expect(result.conflictPlans).toMatchObject([{ number: 43, repairPlan: { decision: 'escalate', reason: 'conflict-file-mode-unsupported' } }]);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(mainHead);
});

test('train integration passes the manual merge driver only to the merge-tree process', () => {
  const { repo, base, first } = fixture();
  const calls: string[][] = [];
  const injected: TrainGit = (args, cwd, env) => {
    calls.push([...args]);
    const result = spawnSync('git', [...args], { cwd, env, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const result = integrateTrain(repo, base, [{ number: 1, head: first }], injected);
  expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
  const mergeArgs = calls.find((args) => args.includes('merge-tree'))!;
  expect(mergeArgs).toContainEqual(expect.stringContaining('merge.uxsim-manual.driver=node'));
  expect(git(repo, 'config', '--local', '--list')).not.toContain('merge.uxsim-catalog.driver');
});

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

test('shadow queue with two non-overlapping PRs runs one train gate and records the verdict without merging', async () => {
  const { repo, base, first, second } = fixture();
  const viewFor = (head: string, path: string) => JSON.stringify({
    headRefOid: head, baseRefName: 'main', state: 'OPEN', isDraft: false, isCrossRepository: false, files: [{ path }],
  });
  const fetchHeads = new Map<string, string>([
    ['refs/heads/main', base], ['refs/pull/7/head', first], ['refs/pull/8/head', second],
  ]);
  let lastFetch = 'refs/heads/main';
  const calls: string[] = [];
  const real = (bin: string, args: readonly string[], cwd: string) => {
    const r = spawnSync(bin, [...args], { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const execute = (bin: string, args: readonly string[], cwd: string) => {
    calls.push([bin, ...args].join(' '));
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return Number(args[2]) === 7
        ? { status: 0, stdout: viewFor(first, 'first.txt'), stderr: '' }
        : { status: 0, stdout: viewFor(second, 'second.txt'), stderr: '' };
    }
    if (bin === 'git' && args[0] === 'fetch' && fetchHeads.has(args[2] ?? '')) {
      lastFetch = args[2]!;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (bin === 'git' && args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') {
      return { status: 0, stdout: `${fetchHeads.get(lastFetch)!}\n`, stderr: '' };
    }
    return real(bin, args, cwd);
  };
  await enqueueL8ShadowQueue(repo, 7, { command: execute, observeEnqueue: () => {} });
  await enqueueL8ShadowQueue(repo, 8, { command: execute, observeEnqueue: () => {} });
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  let gateCalls = 0;
  const gateBatches: number[][] = [];
  const trainCalls: string[] = [];
  const verdict = await runL8ShadowQueue(repo, {
    command: execute,
    trainGit: (args, cwd) => { trainCalls.push(['git', ...args].join(' ')); return real('git', args, cwd); },
    trainReachInspect: (candidate) => ({
      changedFiles: candidate.changedFiles, testFiles: ['test/shared.test.ts'], unverified: [], unrunImporterTotal: 0,
      routeLookupFailures: [], callerTestsOverflow: [], alwaysIncludeMissing: [],
    }),
    trainGate: (_repo, baseSha) => async (commitSha: string, prNumbers: readonly number[]): Promise<'pass'> => {
      gateCalls++;
      gateBatches.push([...prNumbers]);
      expect(baseSha).toBe(base);
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      return 'pass';
    },
  });
  expect(gateCalls).toBe(1);
  expect(gateBatches).toEqual([[7, 8]]);
  expect(verdict).toMatchObject({ number: 7, verdict: 'pass', base, tests: ['test/shared.test.ts'] });
  expect(verdict?.manifest).toMatchObject({ number: 7, group: [7, 8], reachTests: ['test/shared.test.ts'], gatesRun: 1, verdict: 'pass' });
  const state = await statusL8ShadowQueue(repo, { command: execute });
  expect(state.pending).toEqual([]);
  expect(state.verdicts.map(({ number, verdict }) => ({ number, verdict }))).toEqual([
    { number: 7, verdict: 'pass' }, { number: 8, verdict: 'pass' },
  ]);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  expect(calls.some((line) => /\bgit push\b|\bgh pr merge\b|\bupdate-ref\b|\bcheckout\b/.test(line))).toBe(false);
  expect(trainCalls.some((line) => /\bgit push\b|\bupdate-ref\b|\bcheckout\b/.test(line))).toBe(false);
  expect(trainCalls.some((line) => line.includes('commit-tree'))).toBe(true);
}, 30_000);

test('runTrain routes culprit plans through tangled-pair reordering', async () => {
  let plans: { pr: number; plan: { action: string; with?: number } }[] = [];
  await runTrain(candidates.slice(0, 2), {
    integrate: () => ({ commitSha: 'a'.repeat(40), conflicts: [] }),
    gate: () => 'fail',
    tangledPairs: [{ first: 1, then: 2, failures: 2 }],
    classifyCulprit: () => ({ action: 'launch', goal: 'unused', boundaryFiles: [] }),
    onCulpritPlans: value => { plans = value; },
    observe: () => {},
  });
  expect(plans).toEqual([{ pr: 1, plan: { action: 'reorder', with: 2 } }, { pr: 2, plan: { action: 'reorder', with: 1 } }]);
});
