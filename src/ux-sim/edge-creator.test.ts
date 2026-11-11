import { expect, test } from 'bun:test';
import {
  isExpectedEdgeCreatorAppend,
  isWithinE5VisitLimit,
  EDGE_CREATOR_NODE_VISIT_LIMITS,
  EDGE_CREATOR_INCIDENT_SEEDS,
  edgeCreatorScenarioHash,
  edgeCreatorTupleKey,
  evaluateEdgeCreatorPromotion,
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
  const repairKey = `${result.runId}:repair`;

  expect(result).toMatchObject({
    baselineStatus: 'done',
    baselineTerminal: 'done',
    baselineAppendCount: 1,
    baselineRepairCalls: 1,
    interruptedStatus: 'running',
    appendCount: 1,
    sourceReceiptPreserved: true,
    repairCallsByIdempotencyKey: { [repairKey]: 2 },
    effectsByIdempotencyKey: { [repairKey]: 1 },
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

test('E5 refuses an unsupported planned axis tuple instead of returning a GREEN fixed run', async () => {
  const seed = EDGE_CREATOR_INCIDENT_SEEDS.find(({ incidentId }) => incidentId === 'E5')!;
  const result = await runEdgeCreatorE5Simulation({ axes: { ...seed.axes, outcome: 'ok' }, scenarioHash: 'f'.repeat(64) });
  expect(result.verdict).toBe('red');
  expect(result.invariantViolations).toContain('E5-axis-unsupported');
  expect(result.runNodeExecutionCount).toBe(0);
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
  const registeredPairs = new Set(EDGE_CREATOR_INCIDENT_SEEDS.flatMap((seed) => {
    const axes = Object.keys(seed.axes) as (keyof typeof seed.axes)[];
    return axes.flatMap((left, index) => axes.slice(index + 1).map((right) => `${left}:${seed.axes[left]}|${right}:${seed.axes[right]}`));
  }));
  expect(plan.requiredPairCount).toBe(registeredPairs.size);
  expect(plan.coveredPairCount).toBe(plan.requiredPairCount);
  for (const pair of registeredPairs) expect(observedPairs.has(pair)).toBe(true);
  expect(repeatedPlan).toEqual(plan);
  expect(plan.scenarios.length).toBeLessThan(plan.requiredPairCount);
  expect(new Set(plan.scenarios.map((scenario) => JSON.stringify(scenario.axes))).size).toBe(plan.scenarios.length);
  for (const seed of EDGE_CREATOR_INCIDENT_SEEDS) {
    const scenario = plan.scenarios.find((item) => item.incidentIds.includes(seed.incidentId));
    expect(scenario?.axes).toEqual(seed.axes);
    expect(scenario?.invariants).toContain(seed.invariant);
  }
});

test('M4 limits candidates to registered changed-touch pairs, weights incident history, and honors a measured cap', () => {
  const touchedPair = 'outcome:ok|interruption:node';
  const historyPair = 'outcome:fail|interruption:receipt';
  const touchesByPair = { [touchedPair]: ['src/release-loop/gate.ts'], [historyPair]: ['src/release-loop/gate.ts'] };
  const plan = generateEdgeCreatorPlan(EDGE_CREATOR_INCIDENT_SEEDS, {
    changedTouches: ['src/release-loop/gate.ts'], touchesByPair,
    incidentHistory: { [touchedPair]: 'x'.length, [historyPair]: 'history'.length }, maxScenarios: ['one scenario'].length,
  });
  expect(plan.requiredPairCount).toBe(2);
  expect(plan.suppressedPairCount).toBe(94);
  expect(plan.scenarios).toHaveLength(1);
  expect(plan.scenarios[0]?.riskScore).toBeGreaterThan([].length);
  expect(plan.scenarios[0]?.touches).toContain('src/release-loop/gate.ts');

  const unregistered = generateEdgeCreatorPlan(EDGE_CREATOR_INCIDENT_SEEDS, { changedTouches: ['src/unregistered.ts'], touchesByPair });
  expect(unregistered.requiredPairCount).toBe(0);
  expect(unregistered.scenarios).toHaveLength(0);
  const noRegistry = generateEdgeCreatorPlan([], { touchesByPair: {} });
  expect(noRegistry.requiredPairCount).toBe(0);
  expect(noRegistry.scenarios).toEqual([]);
});

test('M4 default touch registry is tied to incident source files and the actual changed path', () => {
  const plan = generateEdgeCreatorPlan(EDGE_CREATOR_INCIDENT_SEEDS, { changedTouches: ['scripts/release-loop/gate-node.ts'] });
  expect(plan.requiredPairCount).toBeGreaterThan([].length);
  expect(plan.scenarios.some((scenario) => scenario.touches.includes('scripts/release-loop/gate-node.ts'))).toBe(true);
});

test('M4 reuses only same-head GREEN receipts and leaves unmeasured dormancy threshold disabled', () => {
  const baseline = generateEdgeCreatorPlan();
  const first = baseline.scenarios[0]!;
  const reused = generateEdgeCreatorPlan(EDGE_CREATOR_INCIDENT_SEEDS, {
    head: 'a'.repeat(40), priorReceipts: [{ head: 'a'.repeat(40), scenarioHash: first.scenarioHash, status: 'green' }],
  });
  expect(reused.scenarios.find(({ scenarioHash }) => scenarioHash === first.scenarioHash)?.disposition).toBe('receipt-reuse');
  expect(reused.skippedReceiptCount).toBe(1);
  const wrongHead = generateEdgeCreatorPlan(EDGE_CREATOR_INCIDENT_SEEDS, {
    head: 'b'.repeat(40), priorReceipts: [{ head: 'a'.repeat(40), scenarioHash: first.scenarioHash, status: 'green' }],
  });
  expect(wrongHead.skippedReceiptCount).toBe(0);

  const greenStreakByHash = Object.fromEntries(baseline.scenarios.map(({ scenarioHash }) => [scenarioHash, 3]));
  const dormant = generateEdgeCreatorPlan(EDGE_CREATOR_INCIDENT_SEEDS, { greenStreakByHash, dormantAfterGreenRuns: 3 });
  expect(dormant.scenarios).toHaveLength(baseline.scenarios.length);
  expect(dormant.scenarios.every(({ disposition }) => disposition === 'dormant')).toBe(true);
  expect(dormant.dormantScenarioCount).toBe(baseline.scenarios.length);
  expect(generateEdgeCreatorPlan().scenarios.length).toBe(baseline.scenarios.length);
});

test('M4 fingerprint retains environment and invariant observations; promotion needs compressed independent proof', () => {
  const axes = EDGE_CREATOR_INCIDENT_SEEDS[0]!.axes;
  const baseTrace = { nodeExitSequence: ['gate', 'done'], stateWrites: ['receipt:complete'], environment: 'host-a',
    invariantObservations: { I1: { passed: true } }, externalEffects: [] } as const;
  const hash = edgeCreatorScenarioHash({ axes, trace: baseTrace });
  expect(edgeCreatorScenarioHash({ axes, trace: { ...baseTrace, environment: 'host-b' } })).not.toBe(hash);
  expect(edgeCreatorScenarioHash({ axes, trace: { ...baseTrace, invariantObservations: { I1: { passed: false } } } })).not.toBe(hash);

  const touchesByPair = {
    'outcome:ok|interruption:node': ['fixture.ts'],
    'outcome:fail|mutation:receipt': ['fixture.ts'],
  };
  const untraced = generateEdgeCreatorPlan([], { touchesByPair });
  const traceByTuple = Object.fromEntries(untraced.scenarios.map(({ axes: scenarioAxes }) => [edgeCreatorTupleKey(scenarioAxes), {
    ...baseTrace, environment: scenarioAxes.environment,
  }]));
  const deduped = generateEdgeCreatorPlan([], { traceByTuple, touchesByPair });
  expect(deduped.deduplicatedScenarioCount).toBeGreaterThan([].length);
  expect(new Set(deduped.scenarios.map(({ axes: scenarioAxes }) => scenarioAxes.environment)).size)
    .toBe(new Set(untraced.scenarios.map(({ axes: scenarioAxes }) => scenarioAxes.environment)).size);

  const evidence = { clusterId: 'cause-1', scenarioResults: [{ scenarioHash: hash, verdict: 'green' as const }],
    changedPaths: ['src/release-loop/gate.ts'], clusterPaths: ['src/release-loop/gate.ts'], mutationRevertedVerdict: 'red' as const,
    implementedBy: 'NM-1', judgedBy: 'GREEN-V' };
  expect(evaluateEdgeCreatorPromotion(evidence)).toEqual({ promotable: true, reasons: [], paths: ['src/release-loop/gate.ts'] });
  expect(evaluateEdgeCreatorPromotion({ ...evidence, judgedBy: 'NM-1' }).reasons).toContain('implementation-and-judge-not-independent');
  expect(evaluateEdgeCreatorPromotion({ ...evidence, mutationRevertedVerdict: 'unmeasured' }).reasons).toContain('mutation-did-not-reproduce-red');
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
