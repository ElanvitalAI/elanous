import { expect, test } from 'bun:test';
import {
  isExpectedEdgeCreatorAppend,
  isWithinE5VisitLimit,
  EDGE_CREATOR_NODE_VISIT_LIMITS,
  EDGE_CREATOR_INCIDENT_SEEDS,
  generateEdgeCreatorPlan,
  runEdgeCreatorE5Simulation,
  runEdgeCreatorM2Simulation,
  sourceReceiptMatches,
} from './edge-creator.js';

test('M2 executes current E1–E4 and E6 seeds through the production graph runner and gate helpers', async () => {
  const result = await runEdgeCreatorM2Simulation();
  const m2Invariants = new Set([
    'completed-receipts-survive-interruption',
    'invalidate-only-source-affected-receipts',
    'node-scope-does-not-expand-run-scope',
    'passing-shard-receipts-survive-peer-failure',
    'missing-cut-pin-refuses-standalone-gate',
  ]);
  const selectedSeeds = EDGE_CREATOR_INCIDENT_SEEDS.filter((seed) => m2Invariants.has(seed.invariant));

  expect(result.status).toBe('done');
  expect(result.executedIncidentIds).toEqual(selectedSeeds.map(({ incidentId }) => incidentId));
  for (const seed of selectedSeeds) expect(result.invariantEvidence[seed.incidentId]).toMatchObject({
    seedSummary: seed.summary, seedAxes: seed.axes, seedInvariant: seed.invariant, passed: true,
  });
  expect(result.invariantEvidence.E1).toMatchObject({ savedCommit: 'a'.repeat(40), completedCommit: 'a'.repeat(40), attemptCount: 2 }); // 출처: #35989 E1 records the completed run and one retry
  expect(result.invariantEvidence.E2).toMatchObject({ reused: ['src/b.test.ts'], measured: ['src/a.test.ts'] });
  expect(result.invariantEvidence.E3).toMatchObject({ override: { gateExecutor: 'host', gateRemote: 'ubuntu@node-b' }, unset: [] });
  expect(result.invariantEvidence.E4).toMatchObject({ receiptValid: true, receiptFiles: 2, verdict: 'regression' }); // 출처: #35989 E4 has two shard receipts in its fixture
  expect(result.invariantEvidence.E6).toMatchObject({ exitCode: 2, refusalReason: 'pod-gate-missing-run-scope' }); // 출처: #35989 gate CLI refusal exit contract

  const renamedSeeds = EDGE_CREATOR_INCIDENT_SEEDS.map((seed) => seed.incidentId === 'E1'
    ? { ...seed, incidentId: 'E9' as const, summary: 'renamed current seed definition' } : seed);
  const renamed = await runEdgeCreatorM2Simulation(renamedSeeds);
  expect(renamed.status).toBe('done');
  expect(renamed.executedIncidentIds).toContain('E9');
  expect(renamed.invariantEvidence.E9).toMatchObject({ seedSummary: 'renamed current seed definition', seedInvariant: 'completed-receipts-survive-interruption' });

  const changedAxisSeeds = EDGE_CREATOR_INCIDENT_SEEDS.map((seed) => seed.incidentId === 'E1'
    ? { ...seed, axes: { ...seed.axes, interruption: 'node' as const } } : seed);
  const changedAxis = await runEdgeCreatorM2Simulation(changedAxisSeeds);
  expect(changedAxis.status).toBe('failed');
  expect(changedAxis.invariantEvidence.E1).toMatchObject({ interruption: 'node', attemptCount: 1, seedAxes: { interruption: 'node' } }); // 출처: #35989 node interruption does not retry the receipt path
});

test('E5 compares equivalent dynamic runs and classifies same-run resume invariants', async () => {
  const result = await runEdgeCreatorE5Simulation();

  expect(result).toMatchObject({
    baselineStatus: 'done',
    baselineTerminal: 'done',
    baselineAppendCount: 1,
    baselineRepairCalls: 1,
    interruptedStatus: 'running',
    appendCount: 1,
    sourceReceiptPreserved: true,
    repairCallsByIdempotencyKey: { 'edge-e5-same-run:repair': 1 },
    effectsByIdempotencyKey: { 'edge-e5-same-run:repair': 1 },
  });
  expect(result.sourceReceiptBefore).toMatchObject({ evidence: { sourceReceipt: 'source-v1' } });
  expect(result.sourceReceiptAfter).toEqual(result.sourceReceiptBefore);
  if (result.resumedStatus === 'done') {
    expect(result.verdict).toBe('green');
    expect(result.invariantViolations).toEqual([]);
    expect(result.resumedTerminal).toBe(result.baselineTerminal);
  } else {
    expect(result.verdict).toBe('red');
    expect(result.invariantViolations).not.toEqual([]);
    expect(result.invariantViolations).toContain('I2-retry-not-repeated');
  }
  expect(result.runNodeExecutionCount).toBeLessThanOrEqual(result.declaredRunNodeExecutionLimit);
  expect(Number.isFinite(result.perRunTimeoutMs)).toBe(true);
});

test('edge creator pairs every axis and pins all eight recorded 0.3.7 incidents into the bounded plan', () => {
  const plan = generateEdgeCreatorPlan();
  const repeatedPlan = generateEdgeCreatorPlan();
  const observedPairs = new Set<string>();
  const axes = ['outcome', 'interruption', 'mutation', 'environment'] as const;
  for (const scenario of plan.scenarios) {
    for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++) {
      const left = axes[i]!;
      const right = axes[j]!;
      observedPairs.add(`${left}:${scenario.axes[left]}|${right}:${scenario.axes[right]}`);
    }
  }

  // Independent transcription of the 0.3.7 eight-event list in the 11-08 checklist evidence.
  const expectedSeeds = [
    ['E1', 'timeout', 'receipt', 'receipt', 'partial-shards', 'completed-receipts-survive-interruption'],
    ['E2', 'unmeasured', 'append', 'image-pin', 'image-drift', 'invalidate-only-source-affected-receipts'],
    ['E3', 'unmeasured', 'node', 'none', 'same-host', 'node-scope-does-not-expand-run-scope'],
    ['E4', 'fail', 'receipt', 'receipt', 'partial-shards', 'passing-shard-receipts-survive-peer-failure'],
    ['E5', 'timeout', 'append', 'append', 'same-host', 'same-run-resume-is-equivalent-and-idempotent'],
    ['E6', 'unmeasured', 'resume', 'image-pin', 'image-drift', 'missing-cut-pin-refuses-standalone-gate'],
    ['E7', 'fail', 'resume', 'receipt', 'remote-user-missing', 'waiver-store-mismatch-fails-closed'],
    ['E8', 'fail', 'node', 'none', 'remote-user-missing', 'child-failure-exit-code-is-preserved'],
  ];

  expect(plan.incidentCount).toBe(8);
  expect(plan.coveredIncidentIds).toEqual(EDGE_CREATOR_INCIDENT_SEEDS.map((seed) => seed.incidentId).sort());
  expect(EDGE_CREATOR_INCIDENT_SEEDS.map((seed) => [seed.incidentId, seed.axes.outcome, seed.axes.interruption,
    seed.axes.mutation, seed.axes.environment, seed.invariant])).toEqual(expectedSeeds);
  expect(plan.requiredPairCount).toBe(96);
  expect(plan.coveredPairCount).toBe(plan.requiredPairCount);
  expect(observedPairs.size).toBe(96);
  expect(repeatedPlan).toEqual(plan);
  expect(plan.scenarios.length).toBeLessThan(plan.requiredPairCount);
  expect(new Set(plan.scenarios.map((scenario) => JSON.stringify(scenario.axes))).size).toBe(plan.scenarios.length);
  for (const seed of EDGE_CREATOR_INCIDENT_SEEDS) {
    const scenario = plan.scenarios.find((item) => item.incidentIds.includes(seed.incidentId));
    expect(scenario?.axes).toEqual(seed.axes);
    expect(scenario?.invariants).toContain(seed.invariant);
  }
});

test('E5 evidence checks reject a changed receipt, an extra appended edge, and excess visits', () => {
  const receipt = { evidence: { sourceReceipt: 'source-v1' }, output: { bytes: 3 } };
  expect(sourceReceiptMatches(receipt, structuredClone(receipt))).toBe(true);
  expect(sourceReceiptMatches(receipt, { ...receipt, output: { bytes: 4 } })).toBe(false);

  const append = {
    entryNodeId: 'repair', returnTo: 'resume', failureTo: 'failed', reason: 'E5 dynamic repair append',
    nodes: [{ nodeId: 'repair', kind: 'agent', recipe: 'handler:edge-repair', maxVisits: EDGE_CREATOR_NODE_VISIT_LIMITS.repair }],
    edges: [{ from: 'repair', on: 'outcome', map: { ok: 'resume', fail: 'failed', error: 'failed' } }],
  };
  expect(isExpectedEdgeCreatorAppend(append)).toBe(true);
  expect(isExpectedEdgeCreatorAppend({ ...append, edges: [...append.edges, { from: 'repair', on: 'error', map: { ok: 'failed' } }] })).toBe(false);

  expect(isWithinE5VisitLimit(['source', 'repair', 'resume', 'done'], 6)).toBe(true);
  expect(isWithinE5VisitLimit(['source', 'repair', 'resume', 'resume', 'repair', 'resume', 'done'], 6)).toBe(false);
});
