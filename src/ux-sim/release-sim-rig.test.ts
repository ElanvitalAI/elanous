import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runReleaseSimGateReceiptSeam, runReleaseSimRigIfFile, runReleaseSimRigScenario } from './release-sim-rig.js';
import { resolveScenarioFilePath } from './scenario.js';

test('receipt seam blocks fake publish when the final injected gate outcome fails', () => {
  const commit = 'a'.repeat(40);
  const stage = runReleaseSimGateReceiptSeam({ stage: 'injected-failure', tests: ['test/only.test.ts'], receipts: [],
    priorCommit: commit, commit, selectedFiles: [] }, () => ({ gateOutcome: 'fail' }));
  expect(stage).toMatchObject({ aggregate: 'complete', gateOutcome: 'fail', publishDecision: 'blocked',
    plan: { fullSweep: true, carriedShardIds: [], rerunShardIds: ['pod-0'] } });
});

test('receipt seam blocks publish when production gate fails, errors, or contradicts receipt inspection', () => {
  const commit = 'a'.repeat(40);
  const common = { stage: 'gate-cut', tests: ['test/only.test.ts'], receipts: [], priorCommit: commit, commit,
    selectedFiles: [], formalReceiptInspection: { kind: 'absent' as const } };
  const failed = runReleaseSimGateReceiptSeam({ ...common, formalGateRun: {
    outcome: 'regression', formalReceiptDecision: 'formal-receipt-set-absent', cutSweepCount: 1, fullSweep: true,
  } });
  expect(failed).toMatchObject({ aggregate: 'complete', gateOutcome: 'fail', publishDecision: 'blocked' });
  const errored = runReleaseSimGateReceiptSeam({ ...common, formalGateRun: {
    outcome: 'error', formalReceiptDecision: 'formal-receipt-set-absent', cutSweepCount: 0, fullSweep: false,
  } });
  expect(errored).toMatchObject({ gateOutcome: 'unmeasured', publishDecision: 'blocked' });
  const failedWithoutInspection = runReleaseSimGateReceiptSeam({ ...common, formalReceiptInspection: undefined, formalGateRun: {
    outcome: 'regression', cutSweepCount: 1, fullSweep: true,
  } });
  expect(failedWithoutInspection).toMatchObject({ gateOutcome: 'fail', publishDecision: 'blocked' });
  const erroredWithoutInspection = runReleaseSimGateReceiptSeam({ ...common, formalReceiptInspection: undefined, formalGateRun: {
    outcome: 'error', cutSweepCount: 0, fullSweep: false,
  } });
  expect(erroredWithoutInspection).toMatchObject({ gateOutcome: 'unmeasured', publishDecision: 'blocked' });
  const inconsistent = runReleaseSimGateReceiptSeam({ ...common, formalGateRun: {
    outcome: 'ok', cutSweepCount: 1, fullSweep: true,
  } });
  expect(inconsistent).toMatchObject({ gateOutcome: 'fail', publishDecision: 'blocked' });
  const invalidInspection = runReleaseSimGateReceiptSeam({ ...common, formalReceiptInspection: { kind: 'invalid', reason: 'receipt mismatch' },
    formalGateRun: { outcome: 'ok', cutSweepCount: 1, fullSweep: true } });
  expect(invalidInspection).toMatchObject({ gateOutcome: 'fail', publishDecision: 'blocked' });
});

test('release simulation runs the real release graph with injected node outcomes in isolated test state', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-sim-rig-test-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    expect(await runReleaseSimRigIfFile('scenarios/ux-sim/provider-4xx-no-provider.yaml')).toBeNull();
    const scenarioPath = resolveScenarioFilePath('scenarios/ux-sim/release-sim-rig.yaml');
    const result = await runReleaseSimRigIfFile(scenarioPath);
    expect(result).not.toBeNull();
    if (!result) throw new Error('release graph scenario was not classified');
    expect(result.pass).toBe(true);
    expect(result.universe).toBe(root);
    expect(result.artifactPath).toBe(join(root, 'ux-sim', 'evidence', 'release-sim-rig-0241.json'));
    expect(existsSync(result.artifactPath)).toBe(true);
    expect(result.cases).toHaveLength(18);
    expect(result.cases.every((item) => item.pass && item.unexpectedEdges.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.dispatchedNodes.every((node) => item.path.includes(node) ||
      Object.values(item.fanOuts ?? {}).some((fanout) => Object.hasOwn(fanout.branches, node))))).toBe(true);
    expect(result.table.every((row) => row.unexpectedEdges === 'none')).toBe(true);
    const realCutoff = result.cases.find((item) => item.id === 'cutoff-notes-empty-real-cli')!;
    expect(realCutoff).toMatchObject({ pass: true, status: 'failed', path: ['version-release', 'traffic-cut-start', 'cutoff', 'traffic-failed-restore', 'failed'],
      injectedEvidence: { actualCli: 'version-node.ts release → node-verdict.ts cutoff → cutoff.ts' } });
    expect(String(realCutoff.injectedEvidence.actualVersionReleaseCliOutput)).toContain('release/0.3.1');
    expect(String(realCutoff.injectedEvidence.actualCutoffCliOutput)).toContain('cutoff notes-empty');
    const realDocs = result.cases.find((item) => item.id === 'docs-node-real-cli-in-sim')!;
    expect(realDocs).toMatchObject({ pass: true, status: 'done',
      injectedEvidence: { actualCli: 'bun scripts/release-loop/docs-node.ts --json', cliStatus: 0,
        remote: 'local-bare-only', branch: 'release-docs/0.3.1', cliOutcome: 'ok', cliBranch: 'release-docs/0.3.1',
        notesRegistered: true, pagesRegistered: true, markerFlipped: true } });
    expect(realDocs.path).toContain('docs');
    expect(realDocs.path).toContain('verify');
    expect(realDocs.path).toContain('done');
    expect(realDocs.dispatchedNodes).toContain('docs-land');
    const appendReceiptCase = result.cases.find((item) => item.id === 'append-receipt-set-absent-and-continuous-radius')!;
    expect(appendReceiptCase).toMatchObject({
      pass: true, status: 'done', checks: { status: true, mustVisit: true, mustNotVisit: true, ledgerEvents: true },
      path: ['cut', 'gate-cut', 'append-a', 'resume-a', 'gate-a', 'append-b', 'resume-b', 'gate-b', 'publish', 'done'],
      injectedEvidence: { universe: 'test', releaseVersion: '0.3.1', appendedOnlyChangedTestRadius: true, fakePublish: 'eligible',
        formalReceiptInspection: { kind: 'absent' }, receiptCase: {
          formalReceiptDecision: { kind: 'absent', reason: 'formal-receipt-set-absent' },
          formalGateRun: { outcome: 'ok', formalReceiptDecision: 'formal-receipt-set-absent', baselineVersion: '0.3.0', cutSweepCount: 1, fullSweep: true },
        } },
    });
    const alternateBaselineScenario = readFileSync(scenarioPath, 'utf8')
      .replace('id: release-sim-rig-0241', 'id: release-sim-alternate-baseline-34922')
      .replace("previousVersion: '0.3.0'", "previousVersion: '0.2.99'");
    const alternateBaseline = await runReleaseSimRigScenario(alternateBaselineScenario);
    const alternateReceiptCase = alternateBaseline.cases.find((item) => item.id === 'append-receipt-set-absent-and-continuous-radius')!;
    expect(alternateReceiptCase.injectedEvidence).toMatchObject({ receiptCase: { formalGateRun: { baselineVersion: '0.2.99' } } });
    const appendEvidence = appendReceiptCase.injectedEvidence as { receiptCase: { plan: { rerunShardIds: string[] }; aggregate: string; receiptIds: string[] };
      appendA: { plan: { carriedShardIds: string[]; rerunShardIds: string[] }; aggregate: string; receiptIds: string[] };
      appendB: { plan: { carriedShardIds: string[]; rerunShardIds: string[] }; aggregate: string; receiptIds: string[] } };
    expect(appendEvidence.receiptCase.plan.rerunShardIds).toHaveLength(81);
    expect(appendEvidence.receiptCase).toMatchObject({ aggregate: 'complete', receiptIds: expect.arrayContaining(['pod-0', 'pod-80']) });
    expect(appendEvidence.appendA.plan.carriedShardIds).toHaveLength(80);
    expect(appendEvidence.appendA).toMatchObject({ aggregate: 'complete', plan: { rerunShardIds: ['pod-0'] }, receiptIds: expect.arrayContaining(['pod-1', 'pod-80']) });
    expect(appendEvidence.appendB.plan.carriedShardIds).toHaveLength(80);
    expect(appendEvidence.appendB).toMatchObject({ aggregate: 'complete', plan: { rerunShardIds: ['pod-1'] }, receiptIds: expect.arrayContaining(['pod-0', 'pod-80']) });
    expect(result.cases.find((item) => item.id === 'cut-tip-moved-after-resume')).toMatchObject({
      status: 'resume-refused', dispatchedNodes: ['version-release'], checks: { mustVisit: true, mustNotVisit: true },
    });
    expect(result.cases.find((item) => item.id === 'gate-measured-regression-waive')).toMatchObject({
      pass: true, status: 'done', injectedEvidence: { waived: true, publishReached: true, initialStatus: 'failed' },
    });
    const ownerWaiverCase = result.cases.find((item) => item.id === 'owner-waive-malformed-gate-schema')!;
    expect(ownerWaiverCase).toMatchObject({
      pass: true, status: 'done', injectedEvidence: { ownerRecordOk: true, publishReached: true },
    });
    const ledgerPath = String(ownerWaiverCase.injectedEvidence?.ownerLedgerPath);
    expect(ledgerPath).toContain(join(root, 'graph-runs', 'release-loop'));
    const persistedRun = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { nodes: Array<{ nodeId: string; waiver?: { ownerWaived?: boolean; approvedBy?: string; reason?: string } }> };
    expect(persistedRun.nodes.find((node) => node.nodeId === 'gate')?.waiver).toMatchObject({
      ownerWaived: true, approvedBy: 'OP', reason: ownerWaiverCase.injectedEvidence?.reason,
    });
    const fixtureOwnerCase = result.cases.find((item) => item.id === 'owner-waive-0246-verdict-fixture')!;
    expect(fixtureOwnerCase).toMatchObject({ pass: true, status: 'done', injectedEvidence: { ownerRecordOk: true, releaseTailOk: true, publishReached: true } });
    expect(fixtureOwnerCase.injectedEvidence?.introducedIds).toHaveLength(101);
    expect(fixtureOwnerCase.injectedEvidence?.npmPublishEvidence).toMatchObject({ result: { outcome: 'ok', npm: 'published' }, publishedCommands: [expect.any(String)] });
    expect(fixtureOwnerCase.injectedEvidence?.verifyEvidence).toMatchObject({ result: { outcome: 'ok' }, npmLatest: '0.2.46' });
    const fixtureLedgerPath = String(fixtureOwnerCase.injectedEvidence?.ownerLedgerPath);
    const fixtureLedger = JSON.parse(readFileSync(fixtureLedgerPath, 'utf8')) as { nodes: Array<{ nodeId: string; waiver?: { introducedIds?: string[] } }> };
    expect(fixtureLedger.nodes.find((node) => node.nodeId === 'gate')?.waiver?.introducedIds).toHaveLength(101);
    const negativeOverlapSource = readFileSync(scenarioPath, 'utf8')
      .replace('id: release-sim-rig-0241', 'id: release-sim-negative-overlap-0245').replace(
      '      mustNotVisit: [cutoff, gate, publish]\n',
      '      mustNotVisit: [cutoff, gate, publish]\n      overlap: [checklist-gate, prefetch]\n',
    );
    const negativeOverlap = await runReleaseSimRigScenario(negativeOverlapSource);
    expect(negativeOverlap.pass).toBe(false);
    expect(negativeOverlap.cases.find((item) => item.id === 'cut-tip-moved-after-resume')).toMatchObject({
      pass: false, checks: { status: true, overlap: false },
    });
    const wrongRefusalExpectation = readFileSync(scenarioPath, 'utf8')
      .replace('id: release-sim-rig-0241', 'id: release-sim-negative-status-0245')
      .replace('      mustNotVisit: [cutoff, gate, publish]\n',
        '      mustNotVisit: [cutoff, gate, publish]\n      refusalIncludes: expected-but-different\n');
    const statusRegression = await runReleaseSimRigScenario(wrongRefusalExpectation);
    expect(statusRegression.pass).toBe(false);
    expect(statusRegression.cases.find((item) => item.id === 'cut-tip-moved-after-resume')?.checks.status).toBe(false);
    const unattributedGate = result.cases.find((item) => item.id === 'gate-attribution-incomplete')!;
    expect(unattributedGate.path).toContain('traffic-failed-restore');
    const unattributedRun = JSON.parse(readFileSync(unattributedGate.statePath, 'utf8')) as {
      nodes: Array<{ nodeId: string; output?: string }>;
    };
    expect(JSON.parse(unattributedRun.nodes.find((node) => node.nodeId === 'gate')!.output!)).not.toHaveProperty('autoheal');
    const prefetchWarning = result.cases.find((item) => item.id === 'prefetch-warning-failure-overlaps-checklist')!;
    expect(prefetchWarning.path.indexOf('pre-gate-join')).toBeLessThan(prefetchWarning.path.indexOf('gate'));
    expect(prefetchWarning.fanOuts?.['export-check:ok']?.branches).toMatchObject({
      'checklist-gate': { status: 'done' }, prefetch: { status: 'failed' },
    });
    const prefetchWarningTimings = prefetchWarning.nodeTimings!;
    expect(prefetchWarningTimings['checklist-gate']!.startedAtMs).toBeLessThan(prefetchWarningTimings.prefetch!.endedAtMs);
    expect(prefetchWarningTimings.prefetch!.startedAtMs).toBeLessThan(prefetchWarningTimings['checklist-gate']!.endedAtMs);
    const macWarning = result.cases.find((item) => item.id === 'mac-smoke-warning-failure-overlaps-pwa')!;
    expect(macWarning.path.indexOf('pre-prepare-join')).toBeLessThan(macWarning.path.indexOf('prepare'));
    expect(macWarning.fanOuts?.['traffic-gate-passed:ok']?.branches).toMatchObject({
      'mac-smoke': { status: 'failed' }, pwa: { status: 'done' },
    });
    const macWarningTimings = macWarning.nodeTimings!;
    expect(macWarningTimings['mac-smoke']!.startedAtMs).toBeLessThan(macWarningTimings.pwa!.endedAtMs);
    expect(macWarningTimings.pwa!.startedAtMs).toBeLessThan(macWarningTimings['mac-smoke']!.endedAtMs);
    const exportFailure = result.cases.find((item) => item.id === 'public-export-leak')!;
    expect(exportFailure.path).not.toContain('prefetch');
    expect(exportFailure.path).toContain('traffic-failed-restore');
    const pwaFailure = result.cases.find((item) => item.id === 'pwa-node-times-out')!;
    expect(pwaFailure.fanOuts?.['traffic-gate-passed:ok']?.branches.pwa).toMatchObject({ status: 'failed' });
    expect(pwaFailure.path).toContain('traffic-failed-restore');
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
