import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { alternateRepairModel, repairModelAvailability, resolveRepairOwner, runRepairCycle, type RepairLaunchRequest } from './repair-cycle.js';
import { applyRepairBundle, REPAIR_BUNDLE_REF, type RepairCasDeps, type RepairCasRequest } from './repair-branch-cas.js';
import { readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';
import { addItem } from '../release-loop/checklist.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const HASH = 'c'.repeat(64);
const now = new Date('2026-10-13T08:00:00.000Z');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ta-repair-cycle-'));
  const statePath = join(dir, 'task-agent-actions.json');
  const card: TaskCard = { id: 'ta-repair-1', text: 'fix code', seat: 'TC', createdAt: now.toISOString(), status: 'launched', history: [],
    pr: { number: 30, url: 'https://github.com/o/r/pull/30' }, childLlm: { provider: 'openai-codex', model: 'gpt-6-sol' } };
  writeTaskCards(statePath, [card]);
  const input = (over: object = {}) => ({ card: readTaskCard(card.id, statePath)!, statePath, repo: dir, pr: 30, head: A,
    branch: 'feature', mustFix: ['fix the broken assertion'], liveMoves: new Set(['narrow-relaunch']), now,
    modelAvailability: { codexSubscription: false, grokSubscription: false }, ...over });
  return { dir, statePath, card, input };
}

test('supervisor report-deficit consumes the same evidence without requesting a PR repair', async () => {
  const f = fixture();
  let launched = 0;
  const deficit = { evidenceId: 'run-evidence-1', previousEvidence: 'previous evidence', round: 0, kind: 'unwired' as const };
  const outcome = await runRepairCycle(f.input({ supervisorDeficit: deficit, request: async () => { launched++; } }));
  expect(outcome).toMatchObject({ decision: 'would-repair', reason: 'connect-goal · evidence run-evidence-1' });
  expect(launched).toBe(0);
  expect(readTaskCard(f.card.id, f.statePath)?.repairs).toBeUndefined();
});

test('repair reads the originating run supervisor ledger only while its deficit remains unresolved', async () => {
  const f = fixture();
  const card = { ...f.card, runId: 'run-grounded' };
  writeTaskCards(f.statePath, [card]);
  const deficit = { runId: card.runId, event: 'supervisor-report-deficit', data: {
    evidenceId: 'evidence-grounded', kind: 'unwired', round: 0, previousEvidence: 'prior-run evidence', gateLog: 'original gate' } };
  const fill = { runId: card.runId, event: 'goal-slot-fill', data: { result: 'unverifiable', round: 0 } };
  const requested: string[] = [];
  const shadow = await runRepairCycle(f.input({ readRunLedger: (runId: string) => {
    expect(runId).toBe(card.runId);
    return [deficit, fill];
  }, request: async () => { requested.push('launch'); } }));
  expect(shadow).toMatchObject({ decision: 'would-repair', reason: 'connect-goal · evidence evidence-grounded' });
  expect(requested).toEqual([]);
  expect(readTaskCard(f.card.id, f.statePath)?.repairs).toBeUndefined();
  const resolved = await runRepairCycle(f.input({ readRunLedger: () => [deficit, { ...fill, data: { ...fill.data, result: 'filled' } }],
    request: async () => { requested.push('launch'); }, observeLaunch: () => {} }));
  expect(resolved.decision).toBe('repair-requested');
  expect(requested).toEqual(['launch']);
  const newerRound = fixture();
  writeTaskCards(newerRound.statePath, [{ ...newerRound.card, runId: card.runId }]);
  const stale = await runRepairCycle(newerRound.input({ readRunLedger: () => [deficit, { ...fill, data: { ...fill.data, round: 1 } }],
    request: async () => { requested.push('new-round-launch'); }, observeLaunch: () => {} }));
  expect(stale.decision).toBe('repair-requested');
  expect(requested).toContain('new-round-launch');
});

test('terminal report-deficit with the same card runId prevents a blind PR relaunch', async () => {
  const f = fixture();
  const runId = 'run-terminal-report';
  writeTaskCards(f.statePath, [{ ...f.card, runId }]);
  let launches = 0;
  const result = await runRepairCycle(f.input({ readRunLedger: () => [{ runId, event: 'supervisor-report-deficit',
    data: { evidenceId: 'report:run-terminal-report:terminal-state-not-reviewed', kind: 'unmeasured', round: 0,
      previousEvidence: 'classification raw', classification: { classification: 'report-deficit' } } }],
  request: async () => { launches++; } }));
  expect(result).toMatchObject({ decision: 'would-repair', reason: 'remeasure · evidence report:run-terminal-report:terminal-state-not-reviewed' });
  expect(launches).toBe(0);
  expect(readTaskCard(f.card.id, f.statePath)?.history).toContainEqual(expect.objectContaining({
    event: 'repair-grounding', runId, detail: result.reason,
  }));
  const history = readTaskCard(f.card.id, f.statePath)?.history?.filter((entry) => entry.event === 'repair-grounding');
  expect(history).toHaveLength(1);
  const resolved = fixture();
  writeTaskCards(resolved.statePath, [{ ...resolved.card, runId }]);
  let resumed = 0;
  const green = await runRepairCycle(resolved.input({ readRunLedger: () => [
    { runId, event: 'supervisor-report-deficit', data: { evidenceId: 'report:run-terminal-report:terminal-state-not-reviewed',
      kind: 'unmeasured', round: 0, previousEvidence: 'classification raw', classification: { classification: 'report-deficit' } } },
    { runId, event: 'goal-slot-fill', data: { round: 0, result: 'filled' } },
  ], request: async () => { resumed++; }, observeLaunch: () => {} }));
  expect(green.decision).toBe('repair-requested');
  expect(resumed).toBe(1);
});

test('repair tick cap zero defers eligible launches but preserves missing-owner stop', async () => {
  const eligible = fixture();
  const budget = { max: 0, requested: 0, capped: 0 };
  let launches = 0;
  const deferred = await runRepairCycle(eligible.input({ repairBudget: budget, request: async () => { launches++; } }));
  expect(deferred.decision).toBe('would-repair');
  expect(deferred.reason).toContain('상한 0');
  expect(budget).toEqual({ max: 0, requested: 0, capped: 1 });
  expect(launches).toBe(0);
  expect(readTaskCard(eligible.card.id, eligible.statePath)?.repairs).toBeUndefined();

  const unowned = fixture();
  const stopped = await runRepairCycle(unowned.input({ repairBudget: budget,
    resolveOwner: () => ({ source: 'none', reason: 'seat absent' }), request: async () => { launches++; } }));
  expect(stopped.decision).toBe('repair-stopped');
  expect(stopped.reason).toContain('seat absent');
  expect(budget.capped).toBe(1);
  expect(launches).toBe(0);
});

test('exact review must-fix launches one graph-routed commit-only worker, records model change, and deduplicates the next tick', async () => {
  const f = fixture();
  const launches: RepairLaunchRequest[] = [];
  const first = await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launches.push(request); } }));
  expect(first.decision).toBe('repair-requested');
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({ pr: 30, head: A, model: { provider: 'glm', model: 'glm-5.3' } });
  expect(readFileSync(launches[0]!.goalFile, 'utf8')).toContain('fix the broken assertion');
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]).toMatchObject({ status: 'requested', fromModel: 'openai-codex/gpt-6-sol' });
  const second = await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launches.push(request); } }));
  expect(second.decision).toBe('repair-pending');
  expect(launches).toHaveLength(1);
});

test('accepted repair worker takes the declared next-move → dispatch edge once with the source PR and run identity', async () => {
  const f = fixture();
  const edges: Array<Record<string, unknown>> = [];
  const off = debug.registerSink({ name: 'ta-next-move-edge-test', emit: (record) => {
    if (record.category === 'self-implement' && record.event === 'graph-edge-taken') edges.push(record.data as Record<string, unknown>);
  } });
  try {
    const launched: RepairLaunchRequest[] = [];
    const first = await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launched.push(request); } }));
    expect(first.decision).toBe('repair-requested');
    expect(launched).toHaveLength(1);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ graphId: 'self-implement', from: 'next-move', on: 'move', label: 'narrow-relaunch',
      to: 'dispatch', source: 'graph', taken: 'dispatch', honored: true });
    expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]).toMatchObject({ pr: 30, head: A, runId: launched[0]!.runId, status: 'requested' });
    expect((await runRepairCycle(f.input({ request: async () => { throw new Error('duplicate launch'); } }))).decision).toBe('repair-pending');
    expect(edges).toHaveLength(1);
  } finally { off(); }
});

test('observation failure after a worker starts leaves its repair requested and prevents a second launch', async () => {
  const f = fixture();
  let launches = 0;
  const first = await runRepairCycle(f.input({ request: async () => { launches++; }, observeLaunch: () => { throw new Error('graph sink unavailable'); } }));
  expect(first.decision).toBe('repair-requested');
  expect(first.reason).toContain('observation failed');
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]?.status).toBe('requested');
  expect((await runRepairCycle(f.input({ request: async () => { launches++; } }))).decision).toBe('repair-pending');
  expect(launches).toBe(1);
});

test('two competing ticks write distinct immutable goal files and only the claimed text reaches the worker', async () => {
  const f = fixture();
  const launched: RepairLaunchRequest[] = [];
  const request = async (item: RepairLaunchRequest) => { launched.push(item); };
  const first = f.input({ mustFix: ['first review text'], request });
  const second = f.input({ mustFix: ['other review text'], request });
  await Promise.all([runRepairCycle(first), runRepairCycle(second)]);
  expect(launched).toHaveLength(1);
  expect(readFileSync(launched[0]!.goalFile, 'utf8')).toContain('first review text');
  expect(readFileSync(launched[0]!.goalFile, 'utf8')).not.toContain('other review text');
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]?.resultPath).toContain(launched[0]!.runId);
});

test('a receipt arriving after the overdue event still passes artifact checks and CAS on the same PR', async () => {
  const f = fixture();
  const launch: RepairLaunchRequest[] = [];
  await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launch.push(request); } }));
  const pending = readTaskCard(f.card.id, f.statePath)!;
  writeTaskCards(f.statePath, [{ ...pending, repairs: pending.repairs!.map((entry) => ({ ...entry,
    at: new Date(now.getTime() - 4 * 60 * 60_000).toISOString() })) }]);
  expect((await runRepairCycle(f.input())).decision).toBe('repair-pending');
  expect(readTaskCard(f.card.id, f.statePath)?.history.some((entry) => entry.event === 'repair-receipt-overdue')).toBe(true);
  const artifactDir = join(f.dir, 'pod-artifacts', 'si-test', 'repair');
  mkdirSync(artifactDir, { recursive: true });
  const result = { pr: 30, baseHead: A, runId: launch[0]!.runId, commit: B, bundleSha256: HASH };
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(result));
  writeFileSync(launch[0]!.resultPath, JSON.stringify({ pr: 30, head: A, runId: launch[0]!.runId,
    ok: true, job: 'si-test', artifactDir, result }));
  let cas = 0;
  const outcome = await runRepairCycle(f.input({ apply: () => { cas++; return { ok: true, fromHead: A, toHead: B, branch: 'feature' }; } }));
  expect(outcome.decision).toBe('repair-applied');
  expect(cas).toBe(1);
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]).toMatchObject({ status: 'applied', commit: B });
  expect((await runRepairCycle(f.input())).decision).toBe('repair-pending');
});

test('a pushed repair with delayed PR head is unconfirmed, stays on the same attempt, then becomes applied', async () => {
  const f = fixture();
  const launch: RepairLaunchRequest[] = [];
  await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launch.push(request); } }));
  const artifactDir = join(f.dir, 'pod-artifacts', 'si-lag', 'repair');
  mkdirSync(artifactDir, { recursive: true });
  const result = { pr: 30, baseHead: A, runId: launch[0]!.runId, commit: B, bundleSha256: HASH };
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(result));
  writeFileSync(launch[0]!.resultPath, JSON.stringify({ pr: 30, head: A, runId: launch[0]!.runId,
    ok: true, job: 'si-lag', artifactDir, result }));
  let checks = 0;
  const requests: RepairCasRequest[] = [];
  const apply = (request: RepairCasRequest) => { requests.push(request); return ++checks <= 2
    ? { ok: false as const, unconfirmed: true as const, reason: 'push succeeded; PR head confirmation pending' }
    : { ok: true as const, fromHead: A, toHead: B, branch: 'feature' }; };
  expect((await runRepairCycle(f.input({ apply }))).decision).toBe('repair-pending');
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]?.status).toBe('unconfirmed');
  const historyLength = readTaskCard(f.card.id, f.statePath)?.history?.length;
  expect((await runRepairCycle(f.input({ apply }))).decision).toBe('repair-pending');
  expect(readTaskCard(f.card.id, f.statePath)?.history).toHaveLength(historyLength!);
  expect((await runRepairCycle(f.input({ apply }))).decision).toBe('repair-applied');
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]).toMatchObject({ status: 'applied', commit: B });
  expect(checks).toBe(3);
  expect(requests.map(request => [request.confirmationOnly ?? false, request.branch])).toEqual([[false, 'feature'], [true, 'feature'], [true, 'feature']]);
  expect(readTaskCard(f.card.id, f.statePath)?.repairs).toHaveLength(1);
});

test('a stale concurrent result collector cannot turn another collector push intent into failed', async () => {
  const f = fixture();
  const launch: RepairLaunchRequest[] = [];
  await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launch.push(request); } }));
  const artifactDir = join(f.dir, 'pod-artifacts', 'si-race', 'repair');
  mkdirSync(artifactDir, { recursive: true });
  const bundlePath = join(artifactDir, 'commit.bundle');
  writeFileSync(bundlePath, 'concurrent proof');
  const result = { pr: 30, baseHead: A, runId: launch[0]!.runId, commit: B,
    bundleSha256: createHash('sha256').update(readFileSync(bundlePath)).digest('hex') };
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(result));
  writeFileSync(launch[0]!.resultPath, JSON.stringify({ pr: 30, head: A, runId: launch[0]!.runId,
    ok: true, job: 'si-race', artifactDir, result }));
  const rivalInput = f.input({ apply: (request: RepairCasRequest) => applyRepairBundle(request, {
    git: () => ({ status: 1, stdout: '', stderr: '' }), prView: () => null, originRepo: () => 'owner/repo',
  }) });
  let rival: Promise<Awaited<ReturnType<typeof runRepairCycle>>> | undefined;
  const first = await runRepairCycle(f.input({ apply: (request: RepairCasRequest) => {
    expect(request.claimBeforePush?.()).toBe(true);
    const historyBeforeRival = readTaskCard(f.card.id, f.statePath)?.history?.length;
    rival = runRepairCycle(rivalInput);
    expect(readTaskCard(f.card.id, f.statePath)?.history).toHaveLength(historyBeforeRival!);
    return { ok: false as const, unconfirmed: true as const, reason: 'push response uncertain' };
  } }));
  expect(first.decision).toBe('repair-pending');
  expect((await rival)?.decision).toBe('repair-pending');
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]).toMatchObject({ status: 'unconfirmed', commit: B });
  expect(readTaskCard(f.card.id, f.statePath)?.history?.filter(entry => entry.event === 'repair-result')).toHaveLength(1);
});

test('artifact from an earlier repair run cannot be applied to a later run on the same head', async () => {
  const f = fixture();
  const launch: RepairLaunchRequest[] = [];
  await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launch.push(request); } }));
  const artifactDir = join(f.dir, 'pod-artifacts', 'si-old', 'repair');
  mkdirSync(artifactDir, { recursive: true });
  const result = { pr: 30, baseHead: A, runId: 'old-run', commit: B, bundleSha256: HASH };
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(result));
  writeFileSync(launch[0]!.resultPath, JSON.stringify({ pr: 30, head: A, runId: launch[0]!.runId,
    ok: true, job: 'si-old', artifactDir, result: { ...result, runId: launch[0]!.runId } }));
  let cas = 0;
  const outcome = await runRepairCycle(f.input({ apply: () => { cas++; return { ok: true, fromHead: A, toHead: B, branch: 'feature' }; } }));
  expect(outcome.decision).toBe('repair-failed');
  expect(cas).toBe(0);
});

test('real CAS records a single-use push intent; missing worker result and reverted remote never repush', async () => {
  const f = fixture();
  const bare = join(f.dir, 'origin.git');
  const repo = join(f.dir, 'repo');
  const child = join(f.dir, 'child');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['init', '-q', '-b', 'feature', repo]);
  git(repo, 'config', 'user.name', 'repair test'); git(repo, 'config', 'user.email', 'repair@example.test');
  writeFileSync(join(repo, 'file.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'origin', bare); git(repo, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'HEAD:refs/heads/feature');
  const baseHead = git(repo, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '-b', 'feature', bare, child]);
  git(child, 'config', 'user.name', 'repair test'); git(child, 'config', 'user.email', 'repair@example.test');
  writeFileSync(join(child, 'file.txt'), 'fixed\n'); git(child, 'add', '.'); git(child, 'commit', '-qm', 'fix');
  const commit = git(child, 'rev-parse', 'HEAD');
  git(child, 'update-ref', REPAIR_BUNDLE_REF, commit);
  const artifactDir = join(f.dir, 'pod-artifacts', 'si-recovery', 'repair');
  mkdirSync(artifactDir, { recursive: true });
  const bundlePath = join(artifactDir, 'commit.bundle');
  git(child, 'bundle', 'create', bundlePath, REPAIR_BUNDLE_REF);
  const runId = 'repair-recovery';
  const result = { pr: 30, baseHead, runId, commit, bundleSha256: createHash('sha256').update(readFileSync(bundlePath)).digest('hex') };
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(result));
  const resultPath = join(f.dir, 'worker-result.json');
  writeFileSync(resultPath, JSON.stringify({ pr: 30, head: baseHead, runId, ok: true, job: 'si-recovery', artifactDir, result }));
  const requested: TaskCard = { ...f.card, repairs: [{ pr: 30, head: baseHead, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId, resultPath, fromModel: 'codex', toModel: 'glm', status: 'requested' }] };
  let pushes = 0;
  const deps: RepairCasDeps = {
    git(cwd, args) {
      if (args[0] === 'push') {
        pushes++;
        expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]).toMatchObject({ status: 'unconfirmed', commit });
      }
      const r = spawnSync('git', args[0] === 'push' ? ['-c', 'core.hooksPath=/dev/null', ...args] : args, { cwd, encoding: 'utf8' }); return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    },
    prView() { return { state: 'OPEN', head: git(repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]!, branch: 'feature', crossRepository: false, headRepo: 'owner/repo' }; },
    originRepo() { return 'owner/repo'; },
  };
  const apply = (request: Parameters<typeof applyRepairBundle>[0]) => applyRepairBundle(request, deps);
  writeTaskCards(f.statePath, [requested]);
  expect(await runRepairCycle(f.input({ repo, head: baseHead, apply }))).toMatchObject({
    decision: 'repair-applied', repairRunId: runId, repairHead: baseHead,
  });
  expect(git(repo, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]).toBe(commit);
  expect(pushes).toBe(1);
  // Simulate process death after the persisted push intent and before the applied card write.
  const pending: TaskCard = { ...requested, repairs: [{ ...requested.repairs![0]!, status: 'unconfirmed', commit,
    bundleSha256: result.bundleSha256, bundlePath }] };
  writeTaskCards(f.statePath, [pending]);
  unlinkSync(resultPath);
  const confirmation = await runRepairCycle(f.input({ repo, head: commit, apply }));
  expect(confirmation.decision).toBe('repair-applied');
  expect(confirmation.repairRunId).toBeUndefined();
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]).toMatchObject({ status: 'applied', commit });
  expect(pushes).toBe(1);
  git(bare, 'update-ref', 'refs/heads/feature', baseHead);
  writeTaskCards(f.statePath, [pending]);
  expect((await runRepairCycle(f.input({ repo, head: baseHead, apply }))).decision).toBe('repair-pending');
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]?.status).toBe('unconfirmed');
  expect(pushes).toBe(1);
});

test('two repair relaunches exhaust the card and notify its owner once', async () => {
  const f = fixture();
  const repairs: NonNullable<TaskCard['repairs']> = [1, 2].map((n) => ({ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: `run-${n}`, resultPath: join(f.dir, `result-${n}.json`),
    fromModel: 'openai-codex/gpt-6-sol', toModel: 'openrouter/openrouter/z-ai/glm-5.3', status: 'failed' as const }));
  writeTaskCards(f.statePath, [{ ...f.card, repairs }]);
  const messages: string[] = [];
  expect((await runRepairCycle(f.input({ liveMoves: new Set(), notify: (_seat: string, body: string) => messages.push(body) }))).decision).toBe('repair-stopped');
  expect(readTaskCard(f.card.id, f.statePath)?.status).toBe('failed');
  expect(messages).toHaveLength(1);
  await runRepairCycle(f.input({ notify: (_seat: string, body: string) => messages.push(body) }));
  expect(messages).toHaveLength(1);
});

test('two applied repairs do not consume the failed-repair convergence budget', async () => {
  const f = fixture();
  const repairs: NonNullable<TaskCard['repairs']> = [1, 2].map((n) => ({ pr: 30, head: n === 1 ? A : B,
    branch: 'feature', at: now.toISOString(), move: 'narrow-relaunch', runId: `run-applied-${n}`,
    resultPath: join(f.dir, `applied-${n}.json`), fromModel: 'glm/glm-5.3', toModel: 'glm/glm-5.3',
    status: 'applied' as const, commit: n === 1 ? B : 'd'.repeat(40) }));
  writeTaskCards(f.statePath, [{ ...f.card, repairs }]);
  const launches: RepairLaunchRequest[] = [];
  const result = await runRepairCycle(f.input({ head: 'd'.repeat(40),
    request: async (item: RepairLaunchRequest) => { launches.push(item); } }));
  expect(result.decision).toBe('repair-requested');
  expect(launches).toHaveLength(1);
  expect(readTaskCard(f.card.id, f.statePath)?.status).toBe('launched');
});

test('an overdue missing receipt stays requested so a late Pod result can still be collected', async () => {
  const f = fixture();
  const runId = 'run-overdue';
  const repairs: NonNullable<TaskCard['repairs']> = [{ pr: 30, head: A, branch: 'feature',
    at: new Date(now.getTime() - 4 * 60 * 60_000).toISOString(), move: 'narrow-relaunch', runId,
    resultPath: join(f.dir, 'late-result.json'), fromModel: 'glm/glm-5.3', toModel: 'glm/glm-5.3', status: 'requested' }];
  writeTaskCards(f.statePath, [{ ...f.card, repairs }]);
  const result = await runRepairCycle(f.input());
  expect(result.decision).toBe('repair-pending');
  expect(result.reason).toContain('receipt overdue');
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]?.status).toBe('requested');
  const overdue = readTaskCard(f.card.id, f.statePath)?.history.filter((entry) => entry.event === 'repair-receipt-overdue');
  expect(overdue).toHaveLength(1);
  expect(overdue?.[0]).toMatchObject({ runId, resultPath: repairs[0]!.resultPath });
  await runRepairCycle(f.input());
  expect(readTaskCard(f.card.id, f.statePath)?.history.filter((entry) => entry.event === 'repair-receipt-overdue')).toHaveLength(1);
});

test('a six-hour missing receipt alerts its owner once and retries a failed notification', async () => {
  const f = fixture();
  const repairs: NonNullable<TaskCard['repairs']> = [{ pr: 30, head: A, branch: 'feature',
    at: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(), move: 'narrow-relaunch', runId: 'run-alert',
    resultPath: join(f.dir, 'missing.json'), fromModel: 'glm/glm-5.3', toModel: 'glm/glm-5.3', status: 'requested' }];
  writeTaskCards(f.statePath, [{ ...f.card, repairs }]);
  let attempts = 0;
  const notify = (_seat: string, body: string) => {
    attempts++;
    expect(body).toContain(repairs[0]!.resultPath);
    if (attempts === 1) throw new Error('mail temporarily unavailable');
  };
  expect((await runRepairCycle(f.input({ notify }))).decision).toBe('repair-pending');
  expect(readTaskCard(f.card.id, f.statePath)?.history.at(-1)?.event).toBe('repair-receipt-alert-failed');
  expect((await runRepairCycle(f.input({ notify }))).decision).toBe('repair-pending');
  expect(readTaskCard(f.card.id, f.statePath)?.history.at(-1)?.event).toBe('repair-receipt-alert-sent');
  await runRepairCycle(f.input({ notify }));
  expect(attempts).toBe(2);
  expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]?.status).toBe('requested');
});

test('an interrupted receipt alert claim is retried after ten minutes', async () => {
  const f = fixture();
  const runId = 'run-interrupted-alert';
  const repairs: NonNullable<TaskCard['repairs']> = [{ pr: 30, head: A, branch: 'feature',
    at: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(), move: 'narrow-relaunch', runId,
    resultPath: join(f.dir, 'missing.json'), fromModel: 'glm/glm-5.3', toModel: 'glm/glm-5.3', status: 'requested' }];
  writeTaskCards(f.statePath, [{ ...f.card, repairs, history: [{ at: now.toISOString(), event: 'repair-receipt-alert-claimed',
    pr: 30, head: A, runId, resultPath: repairs[0]!.resultPath }] }]);
  let alerts = 0;
  const notify = () => { alerts++; };
  await runRepairCycle(f.input({ notify }));
  expect(alerts).toBe(0);
  await runRepairCycle(f.input({ now: new Date(now.getTime() + 11 * 60_000), notify }));
  expect(alerts).toBe(1);
  expect(readTaskCard(f.card.id, f.statePath)?.history.at(-1)?.event).toBe('repair-receipt-alert-sent');
  await runRepairCycle(f.input({ now: new Date(now.getTime() + 22 * 60_000), notify }));
  expect(alerts).toBe(1);
});

test('exhausted repair notifies the checklist owner when the card seat is absent', async () => {
  const f = fixture();
  const repairs: NonNullable<TaskCard['repairs']> = [1, 2].map((n) => ({ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: `run-${n}`, resultPath: join(f.dir, `result-${n}.json`),
    fromModel: 'openai-codex/gpt-6-sol', toModel: 'openrouter/openrouter/z-ai/glm-5.3', status: 'failed' as const }));
  setElanousConfigDir(f.dir);
  try {
    addItem('0.2.28', { id: 'REPAIR-CELL', title: 'repair owner fallback', owner: 'MK/rel' });
    writeTaskCards(f.statePath, [{ ...f.card, seat: undefined, checklistId: 'REPAIR-CELL', checklistVersion: '0.2.28', repairs }]);
    const recipients: string[] = [];
    await runRepairCycle(f.input({ notify: (seat: string, body: string) => { recipients.push(seat); expect(body).toContain('owner MK via checklist'); } }));
    expect(recipients).toEqual(['MK']);
  } finally { resetElanousConfigDir(); }
});

test('exhausted repair with ambiguous checklist owner records refusal and sends no message', async () => {
  const f = fixture();
  const repairs: NonNullable<TaskCard['repairs']> = [1, 2].map((n) => ({ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: `run-${n}`, resultPath: join(f.dir, `result-${n}.json`),
    fromModel: 'openai-codex/gpt-6-sol', toModel: 'openrouter/openrouter/z-ai/glm-5.3', status: 'failed' as const }));
  setElanousConfigDir(f.dir);
  try {
    addItem('0.2.27', { id: 'REPAIR-CELL', title: 'older owner', owner: 'TC' });
    addItem('0.2.28', { id: 'REPAIR-CELL', title: 'newer owner', owner: 'MK' }, { allowDuplicateId: true });
    writeTaskCards(f.statePath, [{ ...f.card, seat: undefined, checklistId: 'REPAIR-CELL', checklistVersion: undefined, repairs }]);
    const recipients: string[] = [];
    const outcome = await runRepairCycle(f.input({ notify: (seat: string) => { recipients.push(seat); } }));
    expect(outcome.reason).toContain('ambiguous');
    expect(recipients).toEqual([]);
    expect(readTaskCard(f.card.id, f.statePath)?.history.some((entry) => entry.event === 'repair-owner-missing' && entry.detail?.includes('ambiguous'))).toBe(true);
  } finally { resetElanousConfigDir(); }
});

test('failed owner message remains observable and is retried on the next tick', async () => {
  const f = fixture();
  const repairs: NonNullable<TaskCard['repairs']> = [1, 2].map((n) => ({ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: `run-${n}`, resultPath: join(f.dir, `result-${n}.json`),
    fromModel: 'openai-codex/gpt-6-sol', toModel: 'openrouter/openrouter/z-ai/glm-5.3', status: 'failed' as const }));
  writeTaskCards(f.statePath, [{ ...f.card, repairs }]);
  let calls = 0;
  const notify = () => { calls++; if (calls === 1) throw new Error('message bus unavailable'); };
  await runRepairCycle(f.input({ notify }));
  expect(readTaskCard(f.card.id, f.statePath)?.history.some((entry) => entry.event === 'repair-owner-notify-failed')).toBe(true);
  await runRepairCycle(f.input({ notify }));
  expect(calls).toBe(2);
  expect(readTaskCard(f.card.id, f.statePath)?.history.some((entry) => entry.event === 'repair-owner-notified')).toBe(true);
  await runRepairCycle(f.input({ notify }));
  expect(calls).toBe(2);
});

test('live repair refuses a card without an owner seat before starting the worker', async () => {
  const f = fixture();
  writeTaskCards(f.statePath, [{ ...f.card, seat: undefined }]);
  let launches = 0;
  const outcome = await runRepairCycle(f.input({ request: async () => { launches++; } }));
  expect(outcome.decision).toBe('repair-stopped');
  expect(outcome.reason).toContain('owner seat missing');
  expect(launches).toBe(0);
  expect(readTaskCard(f.card.id, f.statePath)?.status).toBe('failed');
});

test('missing card seat launches once at the explicit checklist version owner and records its source', async () => {
  const f = fixture();
  setElanousConfigDir(f.dir);
  try {
    addItem('0.2.28', { id: 'REPAIR-CELL', title: 'repair owner fallback', owner: 'MK/rel' });
    writeTaskCards(f.statePath, [{ ...f.card, seat: undefined, checklistId: 'REPAIR-CELL', checklistVersion: '0.2.28' }]);
    const launches: RepairLaunchRequest[] = [];
    const request = async (item: RepairLaunchRequest) => { launches.push(item); };
    expect((await runRepairCycle(f.input({ request }))).decision).toBe('repair-requested');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.seat).toBe('MK');
    expect(readTaskCard(f.card.id, f.statePath)?.history.find((entry) => entry.event === 'repair-launched')?.detail).toContain('owner MK via checklist 0.2.28/REPAIR-CELL');
    expect((await runRepairCycle(f.input({ request }))).decision).toBe('repair-pending');
    expect(launches).toHaveLength(1);
  } finally { resetElanousConfigDir(); }
});

test('an unversioned card uses only a uniquely present checklist cell', () => {
  const f = fixture();
  const card = { ...f.card, seat: undefined, checklistId: 'REPAIR-CELL', checklistVersion: undefined };
  const history = () => [{ version: '0.2.27' }, { version: '0.2.28' }];
  expect(resolveRepairOwner(card, { history, checklist: (version) => ({ items: version === '0.2.28'
    ? [{ id: 'REPAIR-CELL', owner: 'TC' }] : [] }) })).toEqual({ seat: 'TC', source: 'checklist 0.2.28/REPAIR-CELL' });
  expect(resolveRepairOwner(card, { history, checklist: () => ({ items: [{ id: 'REPAIR-CELL', owner: 'TC' }] }) }))
    .toEqual({ source: 'none', reason: 'checklist cell ambiguous: 2 matches' });
  expect(resolveRepairOwner(card, { history: () => [{ version: '0.2.28' }], checklist: () => ({ items: [
    { id: 'REPAIR-CELL', owner: 'TC' }, { id: 'REPAIR-CELL', owner: 'MK' },
  ] }) })).toEqual({ source: 'none', reason: 'checklist cell ambiguous: 2 matches' });
});

test('unversioned missing seat launches from a unique real checklist cell', async () => {
  const f = fixture();
  setElanousConfigDir(f.dir);
  try {
    addItem('0.2.28', { id: 'REPAIR-CELL', title: 'repair owner fallback', owner: 'MK/rel' });
    writeTaskCards(f.statePath, [{ ...f.card, seat: undefined, checklistId: 'REPAIR-CELL', checklistVersion: undefined }]);
    const recipients: string[] = [];
    expect((await runRepairCycle(f.input({ request: async (item: RepairLaunchRequest) => { recipients.push(item.seat ?? ''); } }))).decision).toBe('repair-requested');
    expect(recipients).toEqual(['MK']);
  } finally { resetElanousConfigDir(); }
});

test('card seat wins, while missing, invalid, and unreadable checklist owners refuse a guessed launch', () => {
  const f = fixture();
  const card = { ...f.card, checklistId: 'REPAIR-CELL', checklistVersion: '0.2.28' };
  expect(resolveRepairOwner(card, { checklist: () => { throw new Error('must not read'); } })).toEqual({ seat: 'TC', source: 'card' });
  const missing = { ...card, seat: undefined };
  expect(resolveRepairOwner(missing, { checklist: () => ({ items: [] }) })).toEqual({ source: 'none', reason: 'checklist cell absent' });
  expect(resolveRepairOwner(missing, { checklist: () => ({ items: [{ id: 'REPAIR-CELL' }] }) })).toEqual({ source: 'none', reason: 'checklist owner missing: 0.2.28/REPAIR-CELL' });
  expect(resolveRepairOwner(missing, { checklist: () => ({ items: [{ id: 'REPAIR-CELL', owner: 'ZZ' }] }) })).toEqual({ source: 'none', reason: 'checklist owner seat unknown: 0.2.28/REPAIR-CELL' });
  expect(resolveRepairOwner(missing, { checklist: () => { throw new Error('db unavailable'); } }).reason).toContain('checklist lookup unavailable');
});

test('repair stays bound to the card source PR when a later tick presents another PR', async () => {
  const f = fixture();
  writeTaskCards(f.statePath, [{ ...f.card, repairs: [{ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: 'first', resultPath: 'missing', status: 'failed', fromModel: 'a', toModel: 'b' }] }]);
  let launches = 0;
  const outcome = await runRepairCycle(f.input({ pr: 31, request: async () => { launches++; } }));
  expect(outcome.decision).toBe('repair-stopped');
  expect(outcome.reason).toContain('bound to #30');
  expect(launches).toBe(0);
  expect(readTaskCard(f.card.id, f.statePath)?.repairs).toHaveLength(1);
});

test('repair model respects tier and measured subscription without reducing GLM capacity on retry', () => {
  const f = fixture();
  expect(alternateRepairModel(f.card).to.model).toBe('glm-5.3');
  expect(alternateRepairModel({ ...f.card, childLlm: undefined })).toEqual({
    from: 'unknown', to: { provider: 'glm', model: 'glm-5.3' },
  });
  const afterGlm: TaskCard = { ...f.card, repairs: [{ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: 'run-1', resultPath: 'x', status: 'failed', fromModel: 'openai-codex/gpt-6-sol',
    toModel: 'openrouter/openrouter/z-ai/glm-5.3' }] };
  expect(alternateRepairModel(afterGlm).to).toEqual({ provider: 'glm', model: 'glm-5.3' });
  expect(alternateRepairModel({ ...afterGlm, tier: '상' }, { codexSubscription: true, grokSubscription: true }).to).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' });
  expect(alternateRepairModel({ ...afterGlm, tier: '상', pr: 31 }, { codexSubscription: true, grokSubscription: true }).to).toEqual({ provider: 'grok', model: 'grok-4.6' });
  expect(alternateRepairModel({ ...afterGlm, tier: '상' }, { codexSubscription: false, grokSubscription: true }).to).toEqual({ provider: 'grok', model: 'grok-4.6' });
  expect(alternateRepairModel({ ...afterGlm, tier: '특' }, { codexSubscription: false, grokSubscription: false }).to).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' });
  expect(alternateRepairModel({ ...afterGlm, tier: '상', repairs: [{ ...afterGlm.repairs![0]!, toModel: 'openai-codex/gpt-6-sol' }] },
    { codexSubscription: false, grokSubscription: false }).to).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' });
  expect(alternateRepairModel({ ...afterGlm, tier: '중' }, { codexSubscription: true, grokSubscription: true }).to.model).toBe('glm-5.3');
  expect(alternateRepairModel({ ...f.card, tier: '하', childLlm: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' } }).to.model).toBe('glm-5.3');
});

test('live quota inputs gate Sol before repair model selection, including missing and exhausted quota', async () => {
  const card: TaskCard = { ...fixture().card, tier: '상', childLlm: undefined };
  const input = { codexCandidates: [{ name: 'team', reached: false, usedPercent: 42 }],
    grokUsedPercent: 17, maxUsedPercent: { 'openai-codex': 95, grok: 48 } };
  const available = await repairModelAvailability(async () => input);
  expect(alternateRepairModel(card, available).to.model).toBe('gpt-6-sol');
  const exhausted = await repairModelAvailability(async () => ({ ...input,
    codexCandidates: [{ name: 'team', reached: true, usedPercent: 100 }] }));
  expect(alternateRepairModel(card, exhausted).to.model).not.toBe('gpt-6-sol');
  const unknown = await repairModelAvailability(async () => ({ ...input,
    codexCandidates: [{ name: 'team' }], grokUsedPercent: undefined }));
  expect(unknown).toEqual({ codexSubscription: false, grokSubscription: false });
  expect(alternateRepairModel(card, unknown).to.model).toBe('glm-5.3');
  const unreadable = await repairModelAvailability(async () => { throw new Error('quota source down'); });
  expect(unreadable).toEqual(unknown);
});

test('repair cycle reads quota and passes the tier model to the worker request', async () => {
  const quota = { codexCandidates: [{ name: 'team', reached: false, usedPercent: 42 }],
    grokUsedPercent: 17, maxUsedPercent: { 'openai-codex': 95, grok: 48 } };
  for (const [tier, usedPercent, expected] of [
    ['상', 42, 'gpt-6-sol'],
    ['상', 100, 'grok-4.6'],
    ['중', 42, 'glm-5.3'],
  ] as const) {
    const f = fixture();
    writeTaskCards(f.statePath, [{ ...f.card, tier, childLlm: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' } }]);
    const launches: RepairLaunchRequest[] = [];
    const outcome = await runRepairCycle(f.input({ modelAvailability: undefined,
      readBudgetInputs: async () => ({ ...quota, codexCandidates: [{ name: 'team', reached: usedPercent >= 100, usedPercent }] }),
      request: async (request: RepairLaunchRequest) => { launches.push(request); } }));
    expect(outcome.decision).toBe('repair-requested');
    expect(launches[0]?.model.model).toBe(expected);
    expect(readTaskCard(f.card.id, f.statePath)?.repairs?.[0]?.toModel).toContain(expected);
  }
});

test('TA-PARENT-ROLE-LLM: card parent policy survives automatic same-PR repair request', async () => {
  const f = fixture();
  const pin = 'audit={"provider":"openrouter","model":"openrouter/z-ai/glm-5.3"}';
  writeTaskCards(f.statePath, [{ ...f.card, parentRoleLlm: [pin] }]);
  const launches: RepairLaunchRequest[] = [];
  const outcome = await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launches.push(request); } }));
  expect(outcome.decision).toBe('repair-requested');
  expect(launches).toHaveLength(1);
  expect(launches[0]?.parentRoleLlm).toEqual([pin]);
  expect(launches[0]?.model).toEqual({ provider: 'glm', model: 'glm-5.3' });
});

test('PLANNING-FOLLOWS-CHILD-LLM: inferred planning pin survives a same-PR repair request', async () => {
  const f = fixture();
  const planningPin = 'planning={"provider":"openai-codex","model":"gpt-6-luna"}';
  writeTaskCards(f.statePath, [{ ...f.card, childLlm: { provider: 'openai-codex', model: 'gpt-6-luna' }, parentRoleLlm: [planningPin] }]);
  const launches: RepairLaunchRequest[] = [];
  const outcome = await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launches.push(request); } }));
  expect(outcome.decision).toBe('repair-requested');
  expect(launches).toHaveLength(1);
  expect(launches[0]?.parentRoleLlm).toEqual([planningPin]);
});

test('tier-less repair cards dispatch as 중 and never charge Sol on even PRs', () => {
  const f = fixture();
  expect(alternateRepairModel(f.card, { codexSubscription: true, grokSubscription: true }).to)
    .toEqual({ provider: 'glm', model: 'glm-5.3' });
  const afterGlm: TaskCard = { ...f.card, repairs: [{ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: 'run-1', resultPath: 'x', status: 'failed', fromModel: 'openai-codex/gpt-6-sol',
    toModel: 'openrouter/openrouter/z-ai/glm-5.3' }] };
  expect(alternateRepairModel(afterGlm, { codexSubscription: true, grokSubscription: true }).to)
    .toEqual({ provider: 'glm', model: 'glm-5.3' });
});

test('하-tier repairs recover old flash attempts with the subscription GLM, never downgrade full GLM', () => {
  const f = fixture();
  const failed = (toModel: string): TaskCard => ({ ...f.card, tier: '하', repairs: [{ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: 'run-1', resultPath: 'x', status: 'failed', fromModel: 'a', toModel }] });
  expect(alternateRepairModel({ ...f.card, tier: '하' }).to).toEqual({ provider: 'glm', model: 'glm-5.3' });
  expect(alternateRepairModel(failed('openrouter/openrouter/z-ai/glm-5.3')).to).toEqual({ provider: 'glm', model: 'glm-5.3' });
  expect(alternateRepairModel(failed('openrouter/openrouter/z-ai/glm-5.3-flash')).to).toEqual({ provider: 'glm', model: 'glm-5.3' });
  expect(alternateRepairModel(failed('openrouter/openrouter/z-ai/glm-5.3-flash'), { codexSubscription: true, grokSubscription: true }).to)
    .toEqual({ provider: 'glm', model: 'glm-5.3' });
  expect(alternateRepairModel(failed('openai-codex/gpt-6-luna')).to).toEqual({ provider: 'openai-codex', model: 'gpt-6-luna' });
});

test('a failed Sol repair waits for subscription capacity instead of downgrading or consuming an attempt', async () => {
  const f = fixture();
  const repairs: NonNullable<TaskCard['repairs']> = [{ pr: 30, head: A, branch: 'feature', at: now.toISOString(),
    move: 'narrow-relaunch', runId: 'run-sol', resultPath: join(f.dir, 'sol.json'), status: 'failed',
    fromModel: 'glm/glm-5.3', toModel: 'openai-codex/gpt-6-sol' }];
  writeTaskCards(f.statePath, [{ ...f.card, tier: '상', repairs }]);
  let launches = 0;
  const result = await runRepairCycle(f.input({ modelAvailability: { codexSubscription: false, grokSubscription: false },
    liveMoves: new Set(['narrow-relaunch', 'salvage-relaunch', 'alternative']), request: async () => { launches++; } }));
  expect(result.decision).toBe('would-repair');
  expect(result.reason).toContain('subscription unavailable');
  expect(launches).toBe(0);
  expect(readTaskCard(f.card.id, f.statePath)?.repairs).toHaveLength(1);
});

test('a subscription deferred repair alerts its owner after six hours and retries a failed alert', async () => {
  const f = fixture();
  const repairs: NonNullable<TaskCard['repairs']> = [{ pr: 30, head: A, branch: 'feature',
    at: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(), move: 'narrow-relaunch', runId: 'run-sol-overdue',
    resultPath: join(f.dir, 'sol.json'), status: 'failed', fromModel: 'glm/glm-5.3', toModel: 'openai-codex/gpt-6-sol' }];
  writeTaskCards(f.statePath, [{ ...f.card, tier: '상', repairs }]);
  let alerts = 0;
  const notify = () => { if (++alerts === 1) throw new Error('owner inbox unavailable'); };
  const input = () => f.input({ modelAvailability: { codexSubscription: false, grokSubscription: false },
    liveMoves: new Set(['narrow-relaunch', 'salvage-relaunch', 'alternative']), notify,
    request: async () => { throw new Error('must not launch'); } });
  expect((await runRepairCycle(input())).decision).toBe('would-repair');
  expect(readTaskCard(f.card.id, f.statePath)?.history.at(-1)?.event).toBe('repair-model-alert-failed');
  expect((await runRepairCycle(input())).decision).toBe('would-repair');
  expect(readTaskCard(f.card.id, f.statePath)?.history.at(-1)?.event).toBe('repair-model-alert-sent');
  await runRepairCycle(input());
  expect(alerts).toBe(2);
  expect(readTaskCard(f.card.id, f.statePath)?.repairs).toHaveLength(1);
});

test('repair launch records the implementation child model as a harness.role-llm event', async () => {
  const f = fixture();
  const launches: RepairLaunchRequest[] = [];
  await runRepairCycle(f.input({ request: async (request: RepairLaunchRequest) => { launches.push(request); } }));
  const stored = readTaskCard(f.card.id, f.statePath)!;
  const roleLlm = stored.history.find((entry) => entry.event === 'harness.role-llm');
  expect(roleLlm?.detail).toBe(`repair child model ${launches[0]!.model.provider}/${launches[0]!.model.model}`);
  expect(roleLlm?.runId).toBe(launches[0]!.runId);
  expect(stored.history.at(-1)?.event).toBe('harness.role-llm');
});

test('rejected repair request leaves no implementation model event', async () => {
  const f = fixture();
  const outcome = await runRepairCycle(f.input({ request: async () => { throw new Error('worker admission refused'); } }));
  expect(outcome.decision).toBe('repair-failed');
  const stored = readTaskCard(f.card.id, f.statePath)!;
  expect(stored.repairs?.at(-1)?.status).toBe('failed');
  expect(stored.history.some((entry) => entry.event === 'harness.role-llm')).toBe(false);
});
