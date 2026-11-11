import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runMacrophageHeal, type MacrophageScrap } from '../release-loop/macrophage-heal.js';
import { planMacrophageIncident, simulateMacrophageRecovery } from '../release-loop/macrophage-incident-recovery.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { runReleaseMacrophageIncidentSim } from './release-sim-rig.js';

const incidents = [
  { id: 'a-export-check-failures', source: 'release-graph', signature: 'export-check: missing ELANOUS_GRAPH_CONTEXT and PWA type error (two signatures)', evidence: 'unmeasured' },
  { id: 'b-shard-ledger-config', source: 'release-graph', signature: 'gate: HQ shard ledger is not configured', evidence: 'unmeasured' },
  { id: 'c-three-file-regression', source: 'release-graph', signature: 'gate: 38 to 3 introduced; three independent source files', evidence: 'introduced',
    sourceFiles: ['apps/pwa/src/meta.ts', 'scripts/release-loop/gate-pod-stall.ts', 'src/ux-sim/release-sim-rig.test.ts'], independentFiles: true, causePr: 35259 },
  { id: 'd-receipt-reuse-zero-of-81', source: 'release-graph', signature: 'gate: changed-source-missing-at-current-head and receipt-context-missing', evidence: 'introduced',
    sourceFiles: ['scripts/release-loop/gate-shard-receipts.ts'], causePr: 35626 },
  { id: 'e-cli-image-scope-owner', source: 'release-graph', signature: 'stale CLI, image pin, run scope, and branch owner evidence', evidence: 'unmeasured' },
  { id: 'f-train-solo-starvation', source: 'train', signature: 'needs_solo was scheduled ahead of ready bundle', evidence: 'external' },
  { id: 'g-worker-run-id-collision', source: 'train', signature: 'gcp2 worker exit: run-id prefix collision', evidence: 'unmeasured' },
  { id: 'h-main-tsc-rules-ratchet', source: 'train', signature: 'main tsc and rules-contract ratchet block train', evidence: 'introduced',
    sourceFiles: ['scripts/ci-typecheck-main-delta.sh', 'test/rules-contract.test.ts'], causePr: 35649, revertSafe: true, priorRepairStepsFailed: 1 },
  { id: 'i-review-cap-loop', source: 'host', signature: 'review cap exhausted; owner decision required', evidence: 'unmeasured' },
  { id: 'j-mbp-overload', source: 'host', signature: 'host saturation without release-loop resource signal', evidence: 'external' },
] as const;

test('release-sim-rig: ten 0.3.6 macrophage incidents traverse detection, attribution, repair/HITL, same-run resume, and JSONL receipt', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-macrophage-incident-sim-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
  const runId = 'release-sim-macrophage-incidents-1107';
  const result = await runReleaseMacrophageIncidentSim({ runId, incidents,
    repairLandedIds: ['c-three-file-regression', 'd-receipt-reuse-zero-of-81'],
    hitlApprovedIds: ['a-export-check-failures', 'b-shard-ledger-config', 'e-cli-image-scope-owner', 'g-worker-run-id-collision',
      'h-main-tsc-rules-ratchet', 'i-review-cap-loop'] });
  expect(result.pass, JSON.stringify({ graphState: result.graphState.status, path: result.graphState.path,
    repairFiles: result.graphRepairInputFiles, repairFailureIds: result.graphRepairFailureIds,
    repairInputFailureIds: result.graphRepairInputFailureIds,
    repairAttributions: result.graphRepairAttributions, graphRepairMeasured: result.graphRepairMeasured, graphRepairChecks: result.graphRepairChecks,
    cases: result.cases.map((item) => ({ id: item.signal.id, pass: item.pass, events: item.eventNames })) })).toBe(true);
  expect(result.runId).toBe(runId);
  expect(result.graphState).toMatchObject({ runId, status: 'done' });
  expect(result.graphState.path.filter((node) => node === 'gate')).toHaveLength(2);
  expect(result.graphState.path.some((node) => /^gate-repair-[a-f0-9]{12}$/.test(node))).toBe(true);
  expect(result.graphDrivenIncidentId).toBe('c-three-file-regression');
  expect(result.graphRepairFailureIds).toEqual(incidents[2].sourceFiles.map((file) => `${file}.test.ts > injected R2 regression in ${file}`));
  expect(result.graphRepairInputFailureIds).toEqual(incidents[2].sourceFiles.map((file) => `${file} > ${file}.test.ts > injected R2 regression in ${file}`));
  expect(result.cases.find(({ signal }) => signal.id === 'c-three-file-regression')?.receipt)
    .toMatchObject({ disposition: 'resumed-after-land', gateVisit: 2, rerunFiles: incidents[2].sourceFiles });
  const repairLanded = result.eventTrace.find((event) => event.type === 'release.macrophage.repair-pr-landed'
    && event.data?.incidentId === 'c-three-file-regression');
  expect(repairLanded?.data?.nodeId).toEqual(result.graphState.adaptiveGateNodeAppends?.[0]?.request.node.nodeId);
  expect(result.statePath).toContain(join(root, 'graph-runs', 'release-loop'));
  expect(existsSync(result.receiptPath)).toBe(true);
  expect(result.receiptPath).toBe(`${result.statePath}.contexts/macrophage.jsonl`);
  expect(existsSync(result.recoveryReceiptPath)).toBe(true);
  const runtimeReceiptRows = readFileSync(result.receiptPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(runtimeReceiptRows.some((row) => row.runId === runId && row.data?.id === 'simulated-stale-output'
    && row.data?.applied === true)).toBe(true);
  expect(runtimeReceiptRows.some((row) => row.runId === runId && row.data?.id === 'release-failure:gate:type-error'
    && row.data?.action === 'attempt-repair' && row.data?.applied === false
    && result.eventTrace.some((event) => event.eventId === row.data?.sourceEventId && event.type === 'node-end'
      && event.source.nodeId === 'gate' && event.data?.ok === false))).toBe(true);
  expect(result.cases).toHaveLength(10);
  expect(result.eventTrace.filter((event) => event.type === 'release.macrophage.incident.injected')).toHaveLength(10);
  expect(result.runtimeDecisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ runId, type: 'release.macrophage.decision', data: expect.objectContaining({
      id: 'simulated-stale-output', action: 'regenerate', applied: true,
    }) }),
  ]));
  expect(result.runtimeDecisions.some((decision) => {
    const sourceEventId = decision.data?.sourceEventId;
    const sourceEvent = typeof sourceEventId === 'string' ? result.eventTrace.find((event) => event.eventId === sourceEventId) : undefined;
    return decision.runId === runId && decision.type === 'release.macrophage.decision' && decision.data?.sourceNodeId === 'gate'
      && decision.data?.failureSignature === 'type-error' && decision.data.action === 'attempt-repair'
      && sourceEvent?.type === 'node-end' && sourceEvent.data?.ok === false
      && sourceEvent.source.kind === 'node' && sourceEvent.source.nodeId === 'gate';
  })).toBe(true);
  const macrophageChartRows = (loadRunLedger(runId, runLedgerDir(root)) ?? [])
    .filter((entry) => entry.event === 'run-chart-cell' && entry.data.device === 'macrophage');
  expect(macrophageChartRows).toHaveLength(result.runtimeDecisions.length);
  for (const decision of result.runtimeDecisions) {
    const evidence = typeof decision.data?.evidence === 'string'
      ? decision.data.evidence : JSON.stringify(decision.data?.evidence ?? {});
    expect(macrophageChartRows).toContainEqual(expect.objectContaining({
      runId,
      event: 'run-chart-cell',
      data: expect.objectContaining({
        device: 'macrophage',
        stopKey: decision.eventId,
        observed: expect.stringContaining(evidence.slice(0, 240)),
        verdict: decision.data?.action,
      }),
    }));
  }
  expect(result.graphState.path.filter((node) => node === 'gate')).toHaveLength(2);
  expect(result.cases.map(({ signal, plan }) => [signal.id, plan.label, plan.step])).toEqual([
    ['a-export-check-failures', 'hitl', 'R4-hitl'],
    ['b-shard-ledger-config', 'hitl', 'R4-hitl'],
    ['c-three-file-regression', 'fix', 'R2-split-files'],
    ['d-receipt-reuse-zero-of-81', 'fix', 'R1-single-file'],
    ['e-cli-image-scope-owner', 'hitl', 'R4-hitl'],
    ['f-train-solo-starvation', 'noise', 'none'],
    ['g-worker-run-id-collision', 'hitl', 'R4-hitl'],
    ['h-main-tsc-rules-ratchet', 'hitl', 'R3-revert-proposal'],
    ['i-review-cap-loop', 'hitl', 'R4-hitl'],
    ['j-mbp-overload', 'noise', 'none'],
  ]);
  expect(result.cases.every((item) => item.resumed && item.receipt?.runId === runId && item.eventNames.includes('release.macrophage.receipt-written'))).toBe(true);
  expect(result.cases.find((item) => item.signal.id === 'c-three-file-regression')?.receipt).toMatchObject({
    disposition: 'resumed-after-land', gateVisit: 2, rerunFiles: incidents[2].sourceFiles,
  });
  expect(result.cases.find((item) => item.signal.id === 'h-main-tsc-rules-ratchet')?.receipt?.disposition).toBe('resumed-after-hitl');
  expect(result.jsonl.trim().split('\n')).toHaveLength(10);
  for (const row of result.jsonl.trim().split('\n')) expect(JSON.parse(row)).toMatchObject({ schema: 'elanous.release.macrophage-receipt.v1', runId });
  const unrepaired = simulateMacrophageRecovery({ runId: 'unrepaired', plan: planMacrophageIncident(incidents[3]),
    changedShardId: 'changed', carriedShardIds: ['unchanged'] });
  const unapproved = simulateMacrophageRecovery({ runId: 'unapproved', plan: planMacrophageIncident(incidents[0]),
    changedShardId: 'changed', carriedShardIds: ['unchanged'] });
  expect(unrepaired).toMatchObject({ resumed: false, receipt: { receiptIds: [] } });
  expect(unapproved).toMatchObject({ resumed: false, receipt: { receiptIds: [] } });
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test('MACRO-REPAIR-LADDER: failed R1/R2 steps route safe revert candidates to R3 HITL', () => {
  expect(planMacrophageIncident({ id: 'failed-single-file-repair', source: 'release-graph', signature: 'repair failed',
    evidence: 'introduced', sourceFiles: ['src/one.ts'], causePr: 77, revertSafe: true, priorRepairStepsFailed: 1 }))
    .toMatchObject({ label: 'hitl', step: 'R3-revert-proposal' });
});

test('rla-macrophage-heal-timeout-stale-output: simulation quarantines burned timeout tests and regenerates stale output', () => {
  const inventory: MacrophageScrap[] = [
    { id: 'timeout-budget-burned', kind: 'flaky-timeout-test', evidence: { timeoutBurned: true } },
    { id: 'generated-output-stale', kind: 'stale-generated-artifact',
      evidence: { sourceFingerprint: 'source-current', generatedFingerprint: 'artifact-old' } },
  ];
  const simulated = runMacrophageHeal({ phase: 'idle', mode: 'simulation', now: new Date('2026-11-08T00:00:00Z'),
    consecutiveFailureLimit: 3, inventory });

  expect(simulated.status).toBe('simulated');
  expect(simulated.events.map(({ id, action, applied, result }) => [id, action, applied, result])).toEqual([
    ['timeout-budget-burned', 'quarantine-test', true, 'simulated quarantine-test'],
    ['generated-output-stale', 'regenerate', true, 'simulated regenerate'],
  ]);
  expect(simulated.remaining).toEqual([]);

  const live = runMacrophageHeal({ phase: 'idle', mode: 'live', now: new Date('2026-11-08T00:00:00Z'),
    consecutiveFailureLimit: 3, inventory });
  expect(live.events.every(({ applied }) => applied === false)).toBe(true);
  expect(live.remaining).toEqual(['timeout-budget-burned', 'generated-output-stale']);
});
