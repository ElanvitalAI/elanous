import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { simulateTrainManagerDecision } from './train-manager-decision-sim.js';
import { planSimulationSignal, runSmartMergeWorld, type SmartMergeScenario, type TrainLoopSignal } from './smart-merge-world.js';
import { createWorld, destroyWorld, runWorldScenario } from './world.js';
import type { TrainDecisionInput } from '../loops/train/decisions.js';

const main = 'a'.repeat(40);
const head = 'b'.repeat(40);
const scenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/night-train-dead-pid-lock.yaml');
const worldPath = join(import.meta.dir, '../../scenarios/ux-sim/night-train-world.yaml');
const operationalReplayPath = join(import.meta.dir, '../../scripts/ux-sim/test-train-edge-operational-replay.py');
const retryReplayPath = join(import.meta.dir, '../../scripts/ux-sim/test-train-retry-file-map.py');

async function withNightTrainWorld(run: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'train-edge-night-train-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try { await run(); }
  finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}

function decision(overrides: Partial<TrainDecisionInput> = {}): TrainDecisionInput {
  return { base: main, queue: [{ pr: '99001', head, state: 'open', gate: 'passed' }],
    activePrs: [], refusals: [], lastParks: [], slots: [{ host: 'mshq', slot: 1, expressOnly: false }],
    groupLimit: 1, ...overrides };
}

async function assertResolved(scenario: SmartMergeScenario) {
  const [result] = await runSmartMergeWorld([scenario]);
  expect(result).toMatchObject({ id: scenario.id, observed: scenario.expectedActions, missing: [], unexpected: [],
    finalState: { resolved: true }, humanInterventions: 0, zeroInterventionAssertion: true });
  return result!;
}

test('TRAIN-EDGE-SIM-SUITE reuses the night-train world and its fake clock', async () => {
  expect(readFileSync(scenarioPath, 'utf8')).toContain('fake-clock');
  await withNightTrainWorld(async () => {
    const world = await createWorld(worldPath);
    try {
      const result = await runWorldScenario(world, scenarioPath);
      expect(result.pass).toBe(true);
      expect(result.devices).toContain('fake-clock');
    } finally { await destroyWorld(world); }
  });
});

test('artifact collision splits writers without human intervention', async () => {
  const scenario: SmartMergeScenario = { id: 'train-edge-artifact-collision',
    signal: { type: 'generated-file-overlap', path: 'artifacts/train/run.json', prs: [99011, 99012] },
    expectedActions: ['generated.split-writer'] };
  const result = await assertResolved(scenario);
  expect(result.finalState.writerCollision).toBe(false);
  expect(Object.values(result.finalState.writerOwners)).toEqual([[99011], [99012]]);
});

test('the #36049 retry-file-map replay uses bundled pinned sources in a clean environment', () => {
  const env = { ...process.env };
  for (const key of [
    'ELANOUS_TRAIN_MANAGER_SOURCE', 'ELANOUS_TRAIN_MANAGER_SHA',
    'ELANOUS_TRAIN_BATCH_LIVE_SOURCE', 'ELANOUS_TRAIN_BATCH_LIVE_SHA',
    'ELANOUS_TRAIN_GATE_TIER_LANES_SOURCE', 'ELANOUS_TRAIN_GATE_TIER_LANES_SHA',
    'ELANOUS_TRAIN_GATE_TIER_SOURCE', 'ELANOUS_TRAIN_GATE_TIER_SHA',
  ]) delete env[key];
  const replay = spawnSync(process.env.ELANOUS_PYTHON ?? 'python3', [retryReplayPath], { encoding: 'utf8', env });
  expect(replay.status, replay.stderr || replay.stdout).toBe(0);
  expect(JSON.parse(replay.stdout)).toMatchObject({
    scenario: 'unattributed-intact-retry-keeps-primary-file-map',
    retryMembers: ['35964'],
    retryPrFiles: { '35964': ['src/ledger/resource-ledger-tailnet-cli.ts'] },
    gateRetry: 'retry',
    operationalHelperSha256: 'c8835cbc55040ef84bcf4af7b389780b2f77d5d8aabf51c1b4f192d3dda37874',
  });
});

test('a mismatched head receipt is rejected and never requeued', async () => {
  const scenario: SmartMergeScenario = { id: 'train-edge-head-mismatch',
    signal: { type: 'hotspot-main-drift', pr: 99013, currentHead: head, mainHead: main, integratedHead: 'c'.repeat(40),
      retestId: 'retest-99013', conflictDelta: ['src/loops/train/decisions.ts'], priorVerdict: 'WARN:mustFix0' },
    followupSignals: [
      { type: 'hotspot-retest-result', pr: 99013, retestId: 'retest-99013', head: 'c'.repeat(40),
        result: 'failed', receiptId: 'receipt-head-c' },
      { type: 'hotspot-retest-complete', pr: 99013, retestId: 'retest-99013', integratedHead: 'c'.repeat(40),
        verifiedHead: 'd'.repeat(40), result: 'failed', priorVerdict: 'WARN:mustFix0' },
    ],
    expectedActions: ['main.merge', 'conflict.delta-transplant', 'gate.retest', 'gate.retest-rejected'] };
  const result = await assertResolved(scenario);
  expect(result.finalState.requeued).toBe(false);
  expect(result.finalState.queueCandidates).toEqual([]);
});

test('the train decision replay keeps a conflicted candidate unassigned after parking', () => {
  const refusal = (runId: string, minute: number) => ({ pr: '99014', head, base: main, runId,
    at: `2026-11-09T00:${String(minute).padStart(2, '0')}:00Z`, kind: 'batch-refusal' as const });
  const result = simulateTrainManagerDecision(decision({
    queue: [{ pr: '99014', head, state: 'open', gate: 'conflict' }],
    refusals: [refusal('conflict-1', 0), refusal('conflict-2', 1), refusal('conflict-3', 2)],
  }));
  expect(result.parked).toEqual(['99014']);
  expect(result.assignments).toEqual([]);
});

test('expired STOP_AT refuses a late assignment through the shared readiness world', async () => {
  const signal: TrainLoopSignal = { type: 'role-tag-readiness', roleTag: 'train-worker', edge: 'countdown-late',
    recipe: 'night-train', nowMs: 20_000, deadlineMs: 10_000, mirrorSha: 'mirror', goldenSha: 'golden',
    primaryHost: 'mshq', substitutionMapAvailable: false, alternatives: [],
    hosts: [{ host: 'mshq', ready: true, occupied: false, preempted: false, imageAvailable: true,
      registryReadyAtMs: 0, credentialExpiresAtMs: 30_000, mirrorSha: 'mirror', goldenSha: 'golden',
      // Source: #36054 expired-credential fixture keeps one available host with one unit of role lead time.
      budget: 1, recipeState: 'ready', leadMsByRole: { 'train-worker': 1, 'si-warm': 1, 'gate-warm': 1,
        'remote-parent': 1, rehearsal: 1, 'export-check': 1, 'relay-edge': 1 } }] };
  const result = await assertResolved({ id: 'train-edge-stop-at-expired', signal,
    expectedActions: ['readiness.refuse-assignment'] });
  expect(result.finalState.assignment).toBe('refused');
});

test('a zero-cap host does not restart an exited worker', () => {
  // Source: #36054 zero-cap worker-exit scenario must have no restart action.
  expect(planSimulationSignal({ type: 'worker-exit', host: 'mshq', workerId: 'worker-1', cap: 0 })).toEqual([]);
});

test('duplicate records from one run do not count as repeated same-head refusals', () => {
  const refusal = (at: string) => ({ pr: '99015', head, base: main, runId: 'same-run', at, kind: 'batch-refusal' as const });
  const result = simulateTrainManagerDecision(decision({
    queue: [{ pr: '99015', head, state: 'open', gate: 'unmeasured' }],
    refusals: [refusal('2026-11-09T00:00:00Z'), refusal('2026-11-09T00:01:00Z')], slots: [],
  }));
  expect(result.parked).toEqual([]);
  expect(result.waiting).toEqual([{ pr: '99015', reason: 'gate-not-ready' }]);
});

test('bundled pinned operational snapshots replay manager escalation, train retry callsite, filters, parking, and capacity', () => {
  const replay = spawnSync(process.env.ELANOUS_PYTHON ?? 'python3', [operationalReplayPath], { encoding: 'utf8' });
  expect(replay.status, replay.stderr || replay.stdout).toBe(0);
  const result = JSON.parse(replay.stdout);
  expect(result.retryPlan).toMatchObject({ stage: 'retry', members: ['35964'],
    files: { '35964': ['src/ledger/resource-ledger-tailnet-cli.ts'] }, attributed: false, humanInterventions: 0 });
  expect(result.mainBaseFilter).toEqual({ kept: ['99022'], excluded: [
    { pr: '99021', reason: 'pr-base-not-main' }, { pr: '99023', reason: 'pr-base-unmeasured' },
  ], humanInterventions: 0 });
  expect(result.threeConflictPark).toMatchObject({ counts: [1, 2, 3], parkCheckCounts: [0, 0, 1], parkedPrs: ['99031'],
    operatorNotifications: 1, humanInterventions: 0 });
  expect(result.injectedIntervention).toMatchObject({ counts: [1, 2, 3], humanInterventions: 1,
    events: [{ kind: 'manager-escalation', requiresHuman: true }] });
  expect(result.capZero).toEqual({ slots: 0, humanInterventions: 0 });
  expect(result.positiveCap).toEqual({ slots: 1, humanInterventions: 0 });
  expect(result.runLiveRetryCallsite).toEqual({
    primary: { verdict: 'failed', introducedFailureDetected: true },
    retry: { members: ['35964'], files: { '35964': ['src/ledger/resource-ledger-tailnet-cli.ts'] } },
    forcedGateFailure: true,
  });
  expect(result.sources).toEqual({
    trainManagerSha256: '8548776d3b9c7cf46aba4fe852d70ed882c191a8fcf1bb09d7c7ec4a0bfe3d89',
    trainBatchLiveSha256: 'c8835cbc55040ef84bcf4af7b389780b2f77d5d8aabf51c1b4f192d3dda37874',
    gateTierLanesSha256: '27e1be4b1ea2e154e5985566bfc8922b8284a5f2ad0c1de3abc4e2229c29db45',
    gateTierSha256: '16fdf3514801b540b72eedfa122e374affe73205286c48bc5ce4a0067210263c',
  });
});
