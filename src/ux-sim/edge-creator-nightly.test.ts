import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clusterEdgeCreatorFailures,
  edgeCreatorFailureCellId,
  runEdgeCreatorNightly,
  readEdgeCreatorChangedPaths,
  startEdgeCreatorNightlyScheduler,
  type EdgeCreatorNightlyResult,
} from './edge-creator-nightly.js';
import { EDGE_CREATOR_CHILD_TIMEOUT_MS, EDGE_CREATOR_INCIDENT_SEEDS, edgeCreatorTupleKey,
  generateEdgeCreatorNodeResumeCases, generateEdgeCreatorPlan } from './edge-creator.js';
import { HARNESS_CORE_KINDS } from '../graph-kinds/registry.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';

test('node-resume generator covers every harness kind and pins both same-run regressions', () => {
  const cases = generateEdgeCreatorNodeResumeCases();
  expect(generateEdgeCreatorPlan().nodeResumeCases).toEqual(cases);
  const generatedKinds = new Set(cases.filter(({ interruption }) => interruption === 'mid-node').map(({ nodeKind }) => nodeKind));
  expect(generatedKinds).toEqual(new Set(HARNESS_CORE_KINDS));
  expect(cases.filter(({ interruption }) => interruption === 'mid-node')).toHaveLength(generatedKinds.size);
  expect(cases.find(({ id }) => id === 'resume-before-join-36417')).toEqual({
    id: 'resume-before-join-36417', nodeKind: 'gate', interruption: 'before-join', resumeRunId: 'same', regression: '#36417',
  });
  expect(cases.find(({ id }) => id === 'resume-after-completed-node')).toEqual({
    id: 'resume-after-completed-node', nodeKind: 'agent', interruption: 'after-completed-node', resumeRunId: 'same',
    regression: 'completed-node-resume',
  });
});

test('nightly simulation turns each failed invariant into a stable, targetable checklist cell', async () => {
  const created: Array<{ version: string; id: string; title: string; owner: string }> = [];
  const result = await runEdgeCreatorNightly({
    version: () => '0.3.9-dev.0',
    availableChecklistVersions: () => ['0.3.9'],
    runM2: async () => ({ runId: 'm2-fail', status: 'failed', executedIncidentIds: ['E1'], invariantEvidence: {
      E1: { seedInvariant: 'completed-receipts-survive-interruption', passed: false },
    } }),
    runE5: async () => ({
      runId: 'e5-fail', verdict: 'red', invariantViolations: ['I2-retry-not-repeated'], interruptedStatus: 'running',
      resumedStatus: 'failed', baselineTerminal: 'done', resumedTerminal: 'failed', baselineStatus: 'done',
      baselineAppendCount: 1, baselineRepairCalls: 1, appendCount: 1, sourceReceiptPreserved: true,
      sourceReceiptBefore: {}, sourceReceiptAfter: {}, repairCallsByIdempotencyKey: {}, effectsByIdempotencyKey: {},
      runNodeExecutionCount: Number.NaN, declaredRunNodeExecutionLimit: Number.NaN,
      perRunTimeoutMs: 10_000, // 출처: #35989 E5 subprocess bound
    }),
    classifySeverity: () => 'S2',
    ensureCell: (cell) => { created.push(cell); return true; },
  });

  expect(result.status).toBe('red');
  expect(result.failures.map(({ key }) => key)).toEqual([
    'E1:completed-receipts-survive-interruption', 'E5:I2-retry-not-repeated',
  ]);
  expect(created).toHaveLength(2);
  expect(created[0]).toMatchObject({ version: '0.3.9', owner: 'OPC', title: expect.stringContaining('대상 경로: src/ux-sim/edge-creator.ts') });
  expect(created[0]?.id).toBe(edgeCreatorFailureCellId('E1:completed-receipts-survive-interruption'));
  expect(created[1]?.title).toContain('E5 observed evidence:');
  expect(created[1]?.title).toContain('runId=e5-fail');
  expect(created[1]?.title).toContain('resumedTerminal=failed');
  expect(created[1]?.title).toContain('runNodeExecutionCount=NaN');
  expect(result.cellRecordingComplete).toBe(true);
  expect(result.checklistVersionStatus).toBe('confirmed');
});

test('unknown checklist release stays observation-only and preserves findings without writing cells', async () => {
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  let cellWrites = 0;
  const seed = EDGE_CREATOR_INCIDENT_SEEDS[0]!;
  const result = await runEdgeCreatorNightly({
    version: () => '0.3.99-dev.12', availableChecklistVersions: () => ['0.3.9'], seeds: [seed],
    generatePlan: () => generateEdgeCreatorPlan([seed], { changedTouches: seed.touches }),
    runM2: async () => ({ runId: 'm2-unknown-version', status: 'failed', executedIncidentIds: [seed.incidentId], invariantEvidence: {
      [seed.incidentId]: { seedInvariant: seed.invariant, passed: false },
    } }),
    runE5: async () => ({ runId: 'e5-unknown-version', verdict: 'green', invariantViolations: [], interruptedStatus: 'done', resumedStatus: 'done',
      baselineTerminal: 'done', resumedTerminal: 'done', baselineStatus: 'done', baselineAppendCount: 1, baselineRepairCalls: 1,
      appendCount: 1, sourceReceiptPreserved: true, sourceReceiptBefore: {}, sourceReceiptAfter: {}, repairCallsByIdempotencyKey: {},
      effectsByIdempotencyKey: {}, runNodeExecutionCount: 1, declaredRunNodeExecutionLimit: 1, perRunTimeoutMs: 10 }),
    classifySeverity: () => 'S1', ensureCell: () => { cellWrites++; return true; },
    log: (_category, event, data) => logs.push({ event, data }),
  });
  expect(result.checklistVersionStatus).toBe('unconfirmed-observation-only');
  expect(result.version).toBe('0.3.99-dev.12');
  expect(result.failures).not.toEqual([]);
  expect(result.unrecordedFailures.map(({ key }) => key)).toEqual(result.failures.map(({ key }) => key));
  expect(result.cellRecordingComplete).toBe(false);
  expect(cellWrites).toBe(0);
  expect(logs.find(({ event }) => event === 'nightly-version-unconfirmed')?.data).toMatchObject({
    checklistVersion: '0.3.99', mode: 'observation-only', reason: 'checklist-version-not-assigned',
  });
});

test('E5 verdict fallback cell preserves measured execution evidence', async () => {
  const created: string[] = [];
  await runEdgeCreatorNightly({
    availableChecklistVersions: () => ['0.3.9'],
    runM2: async () => ({ runId: 'm2-done', status: 'done', executedIncidentIds: [], invariantEvidence: {} }),
    runE5: async () => ({
      runId: 'e5-fail', verdict: 'red', invariantViolations: [], interruptedStatus: 'running', resumedStatus: 'failed',
      baselineTerminal: 'done', resumedTerminal: 'failed', baselineStatus: 'done', baselineAppendCount: 2,
      baselineRepairCalls: 1, appendCount: 2, sourceReceiptPreserved: true, sourceReceiptBefore: {}, sourceReceiptAfter: {},
      repairCallsByIdempotencyKey: {}, effectsByIdempotencyKey: {}, runNodeExecutionCount: 3,
      declaredRunNodeExecutionLimit: 2, perRunTimeoutMs: 10_000,
    }),
    classifySeverity: () => 'S1',
    ensureCell: ({ title }) => { created.push(title); return true; },
  });
  expect(created).toHaveLength(1);
  expect(created[0]).toContain('violation=none-reported');
  expect(created[0]).toContain('resumedTerminal=failed');
  expect(created[0]).toContain('runNodeExecutionCount=3');
});

test('M4 clusters only same-invariant failures at the same known code location', () => {
  const failures = [
    { key: 'E1:a', incidentId: 'E1', invariant: 'receipt-preserved', codePath: 'src/release-loop/receipt.ts', summary: 'one', detail: 'x' },
    { key: 'E4:a', incidentId: 'E4', invariant: 'receipt-preserved', codePath: 'src/release-loop/receipt.ts', summary: 'two', detail: 'y' },
    { key: 'E7:a', incidentId: 'E7', invariant: 'receipt-preserved', codePath: 'src/nexus/waiver.ts', summary: 'three', detail: 'z' },
    { key: 'E8:a', incidentId: 'E8', invariant: 'receipt-preserved', summary: 'unknown location', detail: '?' },
  ];
  const clusters = clusterEdgeCreatorFailures(failures);
  expect(clusters).toHaveLength(3);
  expect(clusters.find(({ codePath }) => codePath === 'src/release-loop/receipt.ts')?.failures.map(({ incidentId }) => incidentId)).toEqual(['E1', 'E4']);
  expect(clusters.filter(({ codePath }) => codePath === undefined)).toHaveLength(1);
});

test('M4 defers unknown severity and enforces only measured per-run WIP caps', async () => {
  const baseDeps = {
    generatePlan: () => generateEdgeCreatorPlan(),
    runM2: async () => ({ runId: 'm2-red', status: 'failed', executedIncidentIds: [], invariantEvidence: {
      E1: { seedInvariant: 'broken', passed: false },
    } }),
    runE5: async () => ({
      runId: 'e5-green', verdict: 'green' as const, invariantViolations: [], interruptedStatus: 'done', resumedStatus: 'done',
      baselineTerminal: 'done', resumedTerminal: 'done', baselineStatus: 'done', baselineAppendCount: 1, baselineRepairCalls: 1,
      appendCount: 1, sourceReceiptPreserved: true, sourceReceiptBefore: {}, sourceReceiptAfter: {},
      repairCallsByIdempotencyKey: {}, effectsByIdempotencyKey: {}, runNodeExecutionCount: 1,
      declaredRunNodeExecutionLimit: 2, perRunTimeoutMs: 10_000,
    }),
  };
  let creates = 0;
  const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const deferred = await runEdgeCreatorNightly({ ...baseDeps, availableChecklistVersions: () => ['0.3.9'], classifySeverity: () => 'unknown', ensureCell: () => { creates++; return true; },
    log: (category, event, data) => logs.push({ category, event, data }) });
  expect(creates).toBe(0);
  expect(deferred.deferredFailures?.map(({ key }) => key)).toContain('E1:broken');
  expect(new Set(logs.map(({ category }) => category))).toEqual(new Set([
    'sim.edge.generate', 'sim.edge.dedupe', 'sim.edge.cluster', 'sim.edge.run', 'sim.edge.promote', 'sim.edge.canary',
  ]));
  expect(logs.find(({ category, event }) => category === 'sim.edge.run' && event === 'finished')?.data.cpuMs).toEqual(expect.any(Number));

  const capped = await runEdgeCreatorNightly({ ...baseDeps, availableChecklistVersions: () => ['0.3.9'], classifySeverity: () => 'S0', maxNewCellsPerRun: [].length,
    ensureCell: () => { creates++; return true; } });
  expect(creates).toBe(0);
  expect(capped.cellRecordingComplete).toBe(false);
  expect(capped.unrecordedFailures.map(({ key }) => key)).toContain('E1:broken');
});

// Source: EDGE_CREATOR_CHILD_TIMEOUT_MS bounds the real E5 CLI child; the nightly wrapper also builds graph fixtures.
test('M4 nightly runs the planned axis tuple and only receipts matching M2 and E5 evidence', async () => {
  const seed = EDGE_CREATOR_INCIDENT_SEEDS.find(({ incidentId }) => incidentId === 'E5')!;
  const head = 'c'.repeat(40);
  const result = await runEdgeCreatorNightly({ seeds: [seed], planOptions: { head, changedTouches: seed.touches },
    availableChecklistVersions: () => ['0.3.9'],
    runScenarioM2: async (_seeds, scenario) => ({ runId: 'm2-axis-receipt', status: 'done', scenarioHash: scenario.scenarioHash,
      scenarioAxes: scenario.axes, executedIncidentIds: [], invariantEvidence: {} }) });
  expect(result.plan?.scenarios).toHaveLength(1);
  const scenario = result.plan!.scenarios[0]!;
  expect(scenario.axes).toEqual(seed.axes);
  expect(result.m2).toMatchObject({ scenarioHash: scenario.scenarioHash, scenarioAxes: scenario.axes, status: 'done' });
  expect(result.e5).toMatchObject({ scenarioAxes: scenario.axes, verdict: 'green' });
  expect(result.completedScenarioReceipts).toContainEqual({ head, scenarioHash: scenario.scenarioHash, status: 'green' });
  expect(result.scenarioTraces).toHaveProperty(edgeCreatorTupleKey(seed.axes));
}, EDGE_CREATOR_CHILD_TIMEOUT_MS + EDGE_CREATOR_CHILD_TIMEOUT_MS);

test('nightly feeds iOS chat seeds into the real planner for changed chat files and marks them unmeasured', async () => {
  const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const supportedInvariants = new Set([
    'completed-receipts-survive-interruption',
    'invalidate-only-source-affected-receipts',
    'node-scope-does-not-expand-run-scope',
    'passing-shard-receipts-survive-peer-failure',
    'missing-cut-pin-refuses-standalone-gate',
  ]);
  const result = await runEdgeCreatorNightly({
    planOptions: { head, changedTouches: ['apps/ios/ElanousiOS/ElanousiOS/Chat/ChatView.swift'] },
    runScenarioM2: async (seeds, scenario) => {
      const expected = seeds.filter(({ invariant }) => supportedInvariants.has(invariant));
      return {
        runId: 'm2-ios-chat-adapter-contract', status: 'done', scenarioHash: scenario.scenarioHash,
        scenarioAxes: scenario.axes, executedIncidentIds: expected.map(({ incidentId }) => incidentId),
        invariantEvidence: Object.fromEntries(expected.map((seed) => [seed.incidentId, { seedInvariant: seed.invariant, passed: true }])),
      };
    },
    runScenarioE5: async (scenario) => ({
      runId: 'e5-ios-chat-adapter-contract', verdict: 'green', scenarioAxes: scenario.axes, invariantViolations: [],
      interruptedStatus: 'done', resumedStatus: 'done', baselineTerminal: 'done', resumedTerminal: 'done', baselineStatus: 'done',
      baselineAppendCount: Number.NaN, baselineRepairCalls: Number.NaN, appendCount: Number.NaN, sourceReceiptPreserved: true,
      sourceReceiptBefore: {}, sourceReceiptAfter: {}, repairCallsByIdempotencyKey: {}, effectsByIdempotencyKey: {},
      runNodeExecutionCount: Number.NaN, declaredRunNodeExecutionLimit: Number.NaN, perRunTimeoutMs: Number.NaN,
    }),
  });
  const iosScenarios = result.plan!.scenarios.filter(({ incidentSummaries }) => incidentSummaries.some((summary) => summary.startsWith('[iOS chat:')));
  const iosScenarioHashes = iosScenarios.map(({ scenarioHash }) => scenarioHash);
  const ordinaryScenario = result.plan!.scenarios.find(({ incidentSummaries }) =>
    !incidentSummaries.some((summary) => summary.startsWith('[iOS chat:')));

  expect(iosScenarios).not.toEqual([]);
  expect(ordinaryScenario).toBeDefined();
  expect(iosScenarios.flatMap(({ incidentSummaries }) => incidentSummaries).some((summary) => summary.includes('setup:')
    && summary.includes('action:') && summary.includes('expected:'))).toBe(true);
  expect(result.unmeasuredScenarioHashes).toEqual(iosScenarioHashes);
  expect(result.completedScenarioReceipts?.some(({ scenarioHash }) => iosScenarioHashes.includes(scenarioHash))).toBe(false);
  expect(result.completedScenarioReceipts).toContainEqual({ head, scenarioHash: ordinaryScenario!.scenarioHash, status: 'green' });
});

test('nightly records generic runner failure for a mixed iOS scenario while keeping iOS unmeasured', async () => {
  const head = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const iosScenarioHashes = new Set<string>();
  const supportedInvariants = new Set([
    'completed-receipts-survive-interruption',
    'invalidate-only-source-affected-receipts',
    'node-scope-does-not-expand-run-scope',
    'passing-shard-receipts-survive-peer-failure',
    'missing-cut-pin-refuses-standalone-gate',
  ]);
  const result = await runEdgeCreatorNightly({
    planOptions: { head, changedTouches: ['apps/ios/ElanousiOS/ElanousiOS/Chat/ChatView.swift'] },
    generatePlan: (seeds, options) => {
      const plan = generateEdgeCreatorPlan(seeds, options);
      for (const scenario of plan.scenarios) if (scenario.incidentSummaries.some((summary) => summary.startsWith('[iOS chat:')))
        iosScenarioHashes.add(scenario.scenarioHash);
      return plan;
    },
    runScenarioM2: async (seeds, scenario) => {
      if (iosScenarioHashes.has(scenario.scenarioHash)) return {
        runId: 'm2-failed-mixed-ios-scenario', status: 'failed', scenarioHash: scenario.scenarioHash,
        scenarioAxes: scenario.axes, executedIncidentIds: [], invariantEvidence: {},
      };
      const expected = seeds.filter(({ invariant }) => supportedInvariants.has(invariant));
      return {
        runId: 'm2-green-non-ios-scenario', status: 'done', scenarioHash: scenario.scenarioHash,
        scenarioAxes: scenario.axes, executedIncidentIds: expected.map(({ incidentId }) => incidentId),
        invariantEvidence: Object.fromEntries(expected.map((seed) => [seed.incidentId, { seedInvariant: seed.invariant, passed: true }])),
      };
    },
    runScenarioE5: async (scenario) => ({
      runId: 'e5-mixed-ios-contract', verdict: 'green', scenarioAxes: scenario.axes, invariantViolations: [],
      interruptedStatus: 'done', resumedStatus: 'done', baselineTerminal: 'done', resumedTerminal: 'done', baselineStatus: 'done',
      baselineAppendCount: Number.NaN, baselineRepairCalls: Number.NaN, appendCount: Number.NaN, sourceReceiptPreserved: true,
      sourceReceiptBefore: {}, sourceReceiptAfter: {}, repairCallsByIdempotencyKey: {}, effectsByIdempotencyKey: {},
      runNodeExecutionCount: Number.NaN, declaredRunNodeExecutionLimit: Number.NaN, perRunTimeoutMs: Number.NaN,
    }),
  });
  const mixedFailedScenario = [...iosScenarioHashes].find((scenarioHash) => result.failedScenarioHashes?.includes(scenarioHash));

  expect(iosScenarioHashes).not.toEqual(new Set());
  expect(result.unmeasuredScenarioHashes).toEqual([...iosScenarioHashes]);
  expect(mixedFailedScenario).toBeDefined();
  expect(result.failures.some(({ invariant }) => invariant === 'scenario-execution-receipt-match')).toBe(true);
  expect(result.completedScenarioReceipts?.some(({ scenarioHash }) => scenarioHash === mixedFailedScenario)).toBe(false);
});

test('M4 records a fallback finding when a planned M2 graph fails without a named invariant', async () => {
  const seed = EDGE_CREATOR_INCIDENT_SEEDS.find(({ incidentId }) => incidentId === 'E5')!;
  const head = 'd'.repeat(40);
  const result = await runEdgeCreatorNightly({ seeds: [seed], planOptions: { head, changedTouches: seed.touches },
    runScenarioM2: async (_seeds, scenario) => ({ runId: 'm2-failed-no-finding', status: 'failed', scenarioHash: scenario.scenarioHash,
      scenarioAxes: scenario.axes, executedIncidentIds: [seed.incidentId], invariantEvidence: {} }),
    runScenarioE5: async (scenario) => ({ runId: 'e5-green', verdict: 'green', scenarioAxes: scenario.axes, invariantViolations: [],
      interruptedStatus: 'done', resumedStatus: 'done', baselineTerminal: 'done', resumedTerminal: 'done', baselineStatus: 'done',
      baselineAppendCount: 1, baselineRepairCalls: 1, appendCount: 1, sourceReceiptPreserved: true, sourceReceiptBefore: {},
      sourceReceiptAfter: {}, repairCallsByIdempotencyKey: {}, effectsByIdempotencyKey: {}, runNodeExecutionCount: 1,
      declaredRunNodeExecutionLimit: 2, perRunTimeoutMs: 10 }),
    classifySeverity: () => 'S1', ensureCell: () => true });
  expect(result.status).toBe('red');
  expect(result.failures.map(({ invariant }) => invariant)).toContain('production-graph-status');
  expect(result.completedScenarioReceipts).toEqual([]);
});

test('M4 changed-path measurement includes a deleted registered touch file', () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-deleted-touch-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env,
      GIT_AUTHOR_NAME: 'Edge test', GIT_AUTHOR_EMAIL: 'edge-test@example.invalid',
      GIT_COMMITTER_NAME: 'Edge test', GIT_COMMITTER_EMAIL: 'edge-test@example.invalid' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '-q']);
    writeFileSync(join(root, 'registered-touch.ts'), 'export const value = 1;\n');
    git(['add', 'registered-touch.ts']);
    git(['commit', '-q', '-m', 'add registered touch']);
    const previous = git(['rev-parse', 'HEAD']);
    unlinkSync(join(root, 'registered-touch.ts'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'delete registered touch']);
    const head = git(['rev-parse', 'HEAD']);
    expect(readEdgeCreatorChangedPaths(previous, head, root)).toEqual(['registered-touch.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M4 classifies nightly failures from the recorded incident seed severity', async () => {
  const seed = EDGE_CREATOR_INCIDENT_SEEDS[0]!;
  let recordedSeverity: string | undefined;
  const result = await runEdgeCreatorNightly({ seeds: [seed], generatePlan: () => generateEdgeCreatorPlan([seed], { changedTouches: seed.touches }),
    availableChecklistVersions: () => ['0.3.9'],
    runM2: async () => ({ runId: 'm2-severity', status: 'failed', executedIncidentIds: [seed.incidentId], invariantEvidence: {
      [seed.incidentId]: { seedInvariant: seed.invariant, passed: false },
    } }),
    runE5: async () => ({ runId: 'e5-severity', verdict: 'green', invariantViolations: [], interruptedStatus: 'done', resumedStatus: 'done',
      baselineTerminal: 'done', resumedTerminal: 'done', baselineStatus: 'done', baselineAppendCount: 1, baselineRepairCalls: 1,
      appendCount: 1, sourceReceiptPreserved: true, sourceReceiptBefore: {}, sourceReceiptAfter: {}, repairCallsByIdempotencyKey: {},
      effectsByIdempotencyKey: {}, runNodeExecutionCount: 1, declaredRunNodeExecutionLimit: 1, perRunTimeoutMs: 10 }),
    ensureCell: ({ failure }) => { recordedSeverity = failure.severity; return true; },
  });
  expect(recordedSeverity).toBe(seed.severity);
  expect(result.deferredFailures).toEqual([]);
});

test('nightly scheduler is due once per timezone day and retries a run whose failures did not get cells', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-nightly-test-'));
  try {
    const statePath = join(root, 'state.json');
    let now = new Date('2026-11-08T16:59:00.000Z'); // 01:59 KST
    let runs = 0;
    let failCellRecording = true;
    const pendingSeen: string[][] = [];
    const failure = { key: 'E1:broken', incidentId: 'E1', invariant: 'broken', summary: 'broken', detail: 'fixture' };
    const run = async (pendingFailures: readonly { key: string }[] = []): Promise<EdgeCreatorNightlyResult> => {
      runs += 1;
      pendingSeen.push(pendingFailures.map(({ key }) => key));
      return { status: 'red', version: '0.3.8', plan: null, m2: null, e5: null,
        failures: [failure], unrecordedFailures: failCellRecording ? [failure] : [],
        checklistCellIds: failCellRecording ? [] : ['SIM-EDGE-NIGHTLY-E1'], cellRecordingComplete: !failCellRecording };
    };
    const start = () => startEdgeCreatorNightlyScheduler({
      enabled: true, runOnStart: false, timeZone: 'Asia/Seoul', statePath, now: () => now, run,
      requestIdleSimSlot: async ({ runId }) => ({ state: 'granted', leaseId: 'lease-test', host: 'sim-host', runId }),
      releaseIdleSimSlot: async () => {},
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: () => {}, onError: () => {},
    });
    const first = start();
    await first.tickNow();
    expect(runs).toBe(0);

    now = new Date('2026-11-08T17:00:00.000Z'); // 02:00 KST
    await first.tickNow();
    expect(runs).toBe(1);
    expect(first.diagnostics()).toMatchObject({ lastRunDay: null });
    failCellRecording = false;
    await first.tickNow();
    expect(runs).toBe(2);
    expect(pendingSeen[1]).toEqual(['E1:broken']);
    expect(first.diagnostics()).toMatchObject({ lastRunDay: '2026-11-09' });
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ schema: 1, lastRunDay: '2026-11-09', pendingFailures: [] });
    await first.tickNow();
    expect(runs).toBe(2);
    first.stop();

    const restarted = start();
    await restarted.tickNow();
    expect(runs).toBe(2);
    now = new Date('2026-11-09T17:00:00.000Z');
    await restarted.tickNow();
    expect(runs).toBe(3);
    restarted.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nightly scheduler completes an unknown-version observation once and keeps its findings pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-observation-only-'));
  try {
    const statePath = join(root, 'state.json');
    const failure = { key: 'E1:unconfirmed', incidentId: 'E1', invariant: 'unconfirmed', summary: 'observed', detail: 'fixture' };
    let runs = 0;
    let errors = 0;
    const scheduler = startEdgeCreatorNightlyScheduler({
      enabled: true, runOnStart: false, timeZone: 'UTC', statePath,
      now: () => new Date('2026-11-10T03:00:00.000Z'),
      run: async () => {
        runs++;
        return { status: 'red', version: '0.3.99-dev.12', plan: null, m2: null, e5: null,
          failures: [failure], unrecordedFailures: [failure], checklistCellIds: [], cellRecordingComplete: false,
          checklistVersionStatus: 'unconfirmed-observation-only' };
      },
      requestIdleSimSlot: async ({ runId }) => ({ state: 'granted', leaseId: 'lease-test', host: 'sim-host', runId }),
      releaseIdleSimSlot: async () => {},
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: () => {}, onError: () => { errors++; },
    });
    await scheduler.tickNow();
    await scheduler.tickNow();
    expect(runs).toBe(1);
    expect(errors).toBe(0);
    expect(scheduler.diagnostics()).toMatchObject({ lastRunDay: '2026-11-10' });
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      lastRunDay: '2026-11-10', pendingFailures: [failure],
    });
    scheduler.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('disabled nightly scheduler creates no timer and does not execute', async () => {
  let timers = 0;
  let runs = 0;
  const scheduler = startEdgeCreatorNightlyScheduler({
    enabled: false, run: async () => { runs += 1; return { status: 'green', version: '0.3.8', plan: null, m2: null, e5: null, failures: [], unrecordedFailures: [], checklistCellIds: [], cellRecordingComplete: true }; },
    setIntervalImpl: (() => { timers += 1; return 1; }) as unknown as typeof setInterval,
    clearIntervalImpl: () => {},
  });
  await scheduler.tickNow();
  expect(timers).toBe(0);
  expect(runs).toBe(0);
  expect(scheduler.diagnostics()).toMatchObject({ enabled: false, lastRunDay: null });
  scheduler.stop();
});

test('test-universe Nexus enables nightly scheduling with a local simulation slot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-test-universe-nightly-'));
  const previousNightlyFlag = process.env.ELANOUS_EDGE_CREATOR_NIGHTLY;
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  const previousStateDirSource = process.env.ELANOUS_STATE_DIR_SOURCE;
  delete process.env.ELANOUS_EDGE_CREATOR_NIGHTLY;
  process.env.ELANOUS_STATE_DIR = join(root, 'test-universe');
  process.env.ELANOUS_STATE_DIR_SOURCE = 'derived';
  resetEffectiveInstanceRoot();
  let runs = 0;
  let scheduler: ReturnType<typeof startEdgeCreatorNightlyScheduler> | undefined;
  try {
    expect(resolveCurrentInstance().kind).toBe('test');
    scheduler = startEdgeCreatorNightlyScheduler({
      runOnStart: false, timeZone: 'Asia/Seoul', statePath: join(root, 'state.json'), head: () => 'a'.repeat(40),
      now: () => new Date('2026-11-09T18:00:00.000Z'),
      run: async () => {
        runs += 1;
        return { status: 'green', version: '0.3.9', plan: null, m2: null, e5: null,
          failures: [], unrecordedFailures: [], checklistCellIds: [], cellRecordingComplete: true };
      },
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: () => {}, onError: (error) => { throw error; },
    });
    expect(scheduler.diagnostics().enabled).toBe(true);
    await scheduler.tickNow();
    expect(runs).toBe(1);
    expect(scheduler.diagnostics().lastRunDay).toBe('2026-11-10');
  } finally {
    scheduler?.stop();
    if (previousNightlyFlag === undefined) delete process.env.ELANOUS_EDGE_CREATOR_NIGHTLY;
    else process.env.ELANOUS_EDGE_CREATOR_NIGHTLY = previousNightlyFlag;
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    if (previousStateDirSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE;
    else process.env.ELANOUS_STATE_DIR_SOURCE = previousStateDirSource;
    resetEffectiveInstanceRoot();
    rmSync(root, { recursive: true, force: true });
  }
});

test('nightly scheduler forwards measured changed paths into planner changedTouches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-scheduler-changed-paths-'));
  const changedTouch = 'src/ux-sim/edge-creator-nightly.ts';
  const seed = { incidentId: 'E1' as const, summary: 'scheduler changed path', touches: [changedTouch], severity: 'S1' as const,
    axes: { outcome: 'timeout' as const, interruption: 'receipt' as const, mutation: 'receipt' as const, environment: 'partial-shards' as const },
    invariant: 'completed-receipts-survive-interruption' };
  let scheduler: ReturnType<typeof startEdgeCreatorNightlyScheduler> | undefined;
  try {
    const head = 'scheduler-test-head';
    const changedPaths = ['src/ux-sim/unrelated.ts'];
    let readInput: { previousHead: string | null; head: string } | undefined;
    let result: EdgeCreatorNightlyResult | undefined;
    let simulationCalls = 0;
    scheduler = startEdgeCreatorNightlyScheduler({
      enabled: true, runOnStart: false, timeZone: 'UTC', statePath: join(root, 'state.json'),
      now: () => new Date('2026-11-10T03:00:00.000Z'), head: () => head,
      readChangedPaths: (previousHead, requestedHead) => {
        readInput = { previousHead, head: requestedHead };
        return changedPaths;
      },
      readIncidentHistory: () => ({}),
      onNightlyResult: (nightlyResult) => { result = nightlyResult; },
      nightlyDependencies: {
        seeds: [seed],
        runScenarioM2: async (_scenarioSeeds, scenario) => {
          simulationCalls += 1;
          return { runId: 'scheduler-test', status: 'done', executedIncidentIds: ['E1'], invariantEvidence: {
            E1: { seedInvariant: seed.invariant, passed: true },
          }, scenarioHash: scenario.scenarioHash, scenarioAxes: scenario.axes };
        },
      },
      requestIdleSimSlot: async ({ runId }) => ({ state: 'granted', leaseId: 'lease-test', host: 'sim-host', runId }),
      releaseIdleSimSlot: async () => {},
      setIntervalImpl: (() => undefined) as unknown as typeof setInterval,
      clearIntervalImpl: () => {}, onError: (error) => { throw error; },
    });

    await scheduler.tickNow();

    expect(readInput).toEqual({ previousHead: null, head });
    expect(result?.plan).not.toBeNull();
    expect(result?.plan?.scenarios).toHaveLength(0);
    expect(simulationCalls).toBe(0);
  } finally { scheduler?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('scheduler migrates the prior day-only state without rerunning that day', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-nightly-legacy-'));
  try {
    const statePath = join(root, 'state.json');
    writeFileSync(statePath, JSON.stringify({ schema: 1, day: '2026-11-09', status: 'red', checklistCellIds: ['existing'] }));
    let runs = 0;
    const scheduler = startEdgeCreatorNightlyScheduler({
      enabled: true, runOnStart: false, timeZone: 'Asia/Seoul', statePath,
      now: () => new Date('2026-11-08T18:00:00.000Z'), run: async () => {
        runs += 1;
        return { status: 'green', version: '0.3.8', plan: null, m2: null, e5: null,
          failures: [], unrecordedFailures: [], checklistCellIds: [], cellRecordingComplete: true };
      },
      requestIdleSimSlot: async ({ runId }) => ({ state: 'granted', leaseId: 'lease-test', host: 'sim-host', runId }),
      releaseIdleSimSlot: async () => {},
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: () => {}, onError: () => {},
    });
    await scheduler.tickNow();
    expect(runs).toBe(0);
    expect(scheduler.diagnostics()).toMatchObject({ lastRunDay: '2026-11-09' });
    scheduler.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M4 scheduler persists GREEN receipts keyed by commit and scenario hash for exact reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-receipts-'));
  try {
    const statePath = join(root, 'state.json');
    const plan = generateEdgeCreatorPlan();
    const scenario = plan.scenarios[0]!;
    const head = 'a'.repeat(40);
    const scheduler = startEdgeCreatorNightlyScheduler({
      enabled: true, runOnStart: false, timeZone: 'Asia/Seoul', statePath, now: () => new Date('2026-11-08T17:00:00.000Z'),
      head: () => head,
      run: async () => ({ status: 'green', version: '0.3.9', plan, m2: null, e5: null, failures: [], unrecordedFailures: [],
        checklistCellIds: [], cellRecordingComplete: true,
        completedScenarioReceipts: [{ head, scenarioHash: scenario.scenarioHash, status: 'green' }] }),
      requestIdleSimSlot: async ({ runId }) => ({ state: 'granted', leaseId: 'lease-test', host: 'sim-host', runId }),
      releaseIdleSimSlot: async () => {},
      setIntervalImpl: (() => 1) as unknown as typeof setInterval, clearIntervalImpl: () => {}, onError: () => {},
    });
    await scheduler.tickNow();
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { receipts: unknown[]; greenStreakByHash: Record<string, number> };
    expect(state.receipts).toContainEqual({ head, scenarioHash: scenario.scenarioHash, status: 'green' });
    expect(state.greenStreakByHash[scenario.scenarioHash]).toBe(1);
    scheduler.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M4 scheduler refreshes in-memory head and scenario traces between nightly runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-consecutive-runs-'));
  try {
    const statePath = join(root, 'state.json');
    const firstHead = 'b'.repeat(40);
    const secondHead = 'c'.repeat(40);
    let head = firstHead;
    let now = new Date('2026-11-08T17:00:00.000Z'); // 02:00 KST, Nov 9
    const seen: Array<{ lastRunHead: string | null; scenarioTraces: Readonly<Record<string, { nodeExitSequence: readonly string[] }>> }> = [];
    const trace = (node: string) => ({ nodeExitSequence: [node], stateWrites: [], environment: 'test',
      invariantObservations: {}, externalEffects: [] });
    const scheduler = startEdgeCreatorNightlyScheduler({
      enabled: true, runOnStart: false, timeZone: 'Asia/Seoul', statePath, now: () => now, head: () => head,
      run: async (_pending, previousState) => {
        seen.push(previousState!);
        const marker = seen.length === 1 ? 'first-run' : 'second-run';
        return { status: 'green', version: '0.3.9', plan: null, m2: null, e5: null, failures: [], unrecordedFailures: [],
          checklistCellIds: [], cellRecordingComplete: true, scenarioTraces: { marker: trace(marker) } };
      },
      requestIdleSimSlot: async ({ runId }) => ({ state: 'granted', leaseId: 'lease-test', host: 'sim-host', runId }),
      releaseIdleSimSlot: async () => {}, setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: () => {}, onError: () => {},
    });
    await scheduler.tickNow();
    head = secondHead;
    now = new Date('2026-11-09T17:00:00.000Z'); // 02:00 KST, Nov 10
    await scheduler.tickNow();
    expect(seen[0]).toMatchObject({ lastRunHead: null, scenarioTraces: {} });
    expect(seen[1]).toMatchObject({ lastRunHead: firstHead, scenarioTraces: { marker: { nodeExitSequence: ['first-run'] } } });
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ lastRunHead: secondHead,
      scenarioTraces: { marker: { nodeExitSequence: ['second-run'] } } });
    scheduler.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('current incident seed catalog remains the nightly run input', () => {
  expect(generateEdgeCreatorPlan(EDGE_CREATOR_INCIDENT_SEEDS).coveredIncidentIds).toEqual(
    EDGE_CREATOR_INCIDENT_SEEDS.map((seed) => seed.incidentId).sort(),
  );
});
