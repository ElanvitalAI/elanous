import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { gateShardLedgerBatchComplete, type GateShardLedgerRow } from '../../src/release-loop/gate-shard-ledger.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runReleaseSimGateReceiptSeam, runReleaseSimRigIfFile, runReleaseSimRigScenario } from './release-sim-rig.js';
import { resolveScenarioFilePath } from './scenario.js';
import { runAutoApprove } from '../../scripts/release-loop/auto-approve-node.js';
import { writeGateVerdictRecord } from '../../scripts/release-loop/gate-node.js';

function retainCases(source: string, keep: string[]): string {
  const scenario = parseYaml(source) as { cases: Array<{ id: string }> };
  scenario.cases = scenario.cases.filter((item) => keep.includes(item.id));
  return stringifyYaml(scenario);
}

test('publish hold signals route measured auto-approval to a human before the fake publisher', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-publish-hold-sim-'));
  const repo = join(root, 'repo');
  const out = join(root, 'release', '0.3.7', 'prepared');
  mkdirSync(join(out, 'dist'), { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(repo, '.bun-version'), `${Bun.version}\n`);
  for (let index = 0; index < 5; index += 1) writeFileSync(join(out, 'dist', `file-${index}`), 'fixture');
  const graph = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    edges: Array<{ from: string; map?: Record<string, string> }>;
  };
  const route = graph.edges.find((edge) => edge.from === 'auto-approve')?.map;
  const base = {
    runId: 'publish-hold-simulation',
    input: { version: '0.3.7', previousVersion: '0.3.6' },
    outputs: {
      gate: { outcome: 'ok', introduced: [] },
      prepare: { outcome: 'ok', out, candidate: join(out, 'dist', 'elanous.tgz'), commit: 'a'.repeat(40) },
      upgrade: { outcome: 'ok' },
      tui: { outcome: 'ok', regress: { pass: 7, fail: 0,
        results: Array.from({ length: 7 }, (_, index) => ({ id: `R${index + 1}`, title: 'simulated', ok: true, reason: 'pass' })) } },
      docs: { outcome: 'ok', notes: '/tmp/0.3.7.md' },
      'notes-check': { outcome: 'ok' },
      'checklist-gate': { outcome: 'ok', publishBlockingYellow: [] },
    },
  } as const;
  try {
    const cases = [
      { name: 'traffic hold', input: { trafficHold: true } },
      { name: 'yellow publish blocker', outputs: { 'checklist-gate': { outcome: 'ok', publishBlockingYellow: ['RELEASE-GRAPH-LIFECYCLE-PROOF'] } } },
      { name: 'OP approval marker', input: { opApprovalMarker: 'OP: verify ledger before publish' } },
    ];
    for (const item of cases) {
      const context = { ...base, input: { ...base.input, ...item.input }, outputs: { ...base.outputs, ...item.outputs } };
      const decision = runAutoApprove(context as never, { instanceRoot: root, repo, bunVersion: Bun.version });
      const next = decision.outcome === 'ok' ? route?.ok : route?.fail;
      const publishCalls = next === 'publish' ? 1 : 0;
      expect({ outcome: decision.outcome, next, publishCalls }, item.name).toEqual({ outcome: 'fail', next: 'approve-publish', publishCalls: 0 });
    }
    const clear = runAutoApprove(base as never, { instanceRoot: root, repo, bunVersion: Bun.version });
    expect({ outcome: clear.outcome, next: clear.outcome === 'ok' ? route?.ok : route?.fail })
      .toEqual({ outcome: 'ok', next: 'publish' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release simulation merges a completed retry fragment into its incomplete original gate shard', () => {
  const batchId = 'sim-pod-70-retry-batch';
  const observedAt = '2026-11-07T00:00:00.000Z';
  const files = Array.from({ length: 97 }, (_, index) => `src/pod-70-${index}.test.ts`);
  const retryFiles = files.slice(-27);
  const row = (overrides: Partial<GateShardLedgerRow>): GateShardLedgerRow => ({ v: 1, version: '0.3.6', phase: 'cut',
    shardId: 'pod-70', files, host: 'aws1', executor: 'pod', imageDigest: 'sha256:' + 'a'.repeat(64),
    commit: '3cb140ec2cef82bbe024e54d0b0ad4f939d77485', envFingerprint: 'b'.repeat(64),
    startedAt: observedAt, endedAt: observedAt, observedAt, state: 'done', rc: 0, pass: 1021, fail: 0,
    errors: 0, ran: 1022, failureIds: null, errorIds: null, attribution: 'unmeasured', logPath: null,
    junitPath: null, stopReason: 'incomplete attempt recovered by retry', attemptId: 'attempt-incomplete', batchId, batchSize: 2,
    retryGroupId: 'attempt-incomplete',
    ...overrides });
  const rows = [row({ unmeasuredFiles: retryFiles }), row({ shardId: 'pod-70-n', files: retryFiles, pass: 375, ran: 376,
    failureIds: [], errorIds: [], attribution: 'complete',
    stopReason: null, attemptId: 'attempt-retry', retryGroupId: 'attempt-incomplete', batchId: undefined, batchSize: undefined }), row({ shardId: 'pod-71', files: ['src/pod-71.test.ts'], pass: 1, ran: 1,
    failureIds: [], errorIds: [], attribution: 'complete', stopReason: null, attemptId: 'attempt-sibling' })];
  const expected = { batchId, version: '0.3.6', commit: '3cb140ec2cef82bbe024e54d0b0ad4f939d77485',
    phase: 'cut' as const, observedAt, shardIds: ['pod-70', 'pod-71'] };
  expect(gateShardLedgerBatchComplete(rows, expected)).toBe(true);
  expect(gateShardLedgerBatchComplete(rows.map((entry) => entry.shardId === 'pod-70-n'
    ? { ...entry, fail: 1, rc: 1, failureIds: ['src/pod-70-96.test.ts > failed'] } : entry), expected)).toBe(false);
  expect(gateShardLedgerBatchComplete(rows.map((entry) => entry.shardId === 'pod-70'
    ? { ...entry, unmeasuredFiles: [...retryFiles, files[0]!] } : entry), expected)).toBe(false);
  const runningRetry = { ...rows[1]!, state: 'running' as const, attribution: 'unmeasured' as const, endedAt: null,
    pass: null, fail: null, errors: null, ran: null, failureIds: null, errorIds: null };
  expect(gateShardLedgerBatchComplete([rows[0]!, runningRetry, rows[1]!, rows[2]!], expected)).toBe(true);
  for (const changedIdentity of [{ envFingerprint: 'c'.repeat(64) }, { commit: 'd'.repeat(40) },
    { imageDigest: 'sha256:' + 'e'.repeat(64) }, { executor: 'host' as const }]) {
    expect(gateShardLedgerBatchComplete(rows.map((entry) => entry.shardId === 'pod-70-n'
      ? { ...entry, ...changedIdentity } : entry), expected)).toBe(false);
  }
  expect(gateShardLedgerBatchComplete(rows.map((entry) => entry.shardId === 'pod-70-n'
    ? { ...entry, files: retryFiles.slice(1) } : entry), expected)).toBe(false);
  expect(gateShardLedgerBatchComplete([...rows, { ...rows[1]!, attemptId: 'attempt-prior-run', retryGroupId: 'attempt-prior-run' }], expected)).toBe(true);
  expect(gateShardLedgerBatchComplete([...rows, { ...rows[1]! }], expected)).toBe(false);
  expect(gateShardLedgerBatchComplete(rows.map((entry) => entry.shardId === 'pod-70-n'
    ? { ...entry, startedAt: 'not-a-time' } : entry), expected)).toBe(false);
  expect(gateShardLedgerBatchComplete([...rows, { ...rows[1]!, endedAt: 'not-a-time' }], expected)).toBe(false);
  expect(gateShardLedgerBatchComplete([...rows, { ...rows[1]!, startedAt: '2026-11-07T00:01:00.000Z',
    endedAt: '2026-11-07T00:00:00.000Z' }], expected)).toBe(false);
  expect(gateShardLedgerBatchComplete([...rows, { ...rows[1]!, state: 'running', attribution: 'unmeasured', endedAt: null,
    pass: null, fail: null, errors: null, ran: null, failureIds: null, errorIds: null }], expected)).toBe(false);
  expect(gateShardLedgerBatchComplete([...rows, { ...rows[1]!, shardId: 'pod-70-n2' }], expected)).toBe(false);
  expect(gateShardLedgerBatchComplete([...rows, { ...rows[1]!, attemptId: 'attempt-retry-duplicate' }], expected)).toBe(false);
  expect(gateShardLedgerBatchComplete([...rows, rows[0]!], expected)).toBe(false);
});

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
    const unknownPublish = result.cases.find((item) => item.id === 'publish-status-unknown-pauses-for-approval');
    expect(unknownPublish?.pass).toBe(true);
    expect(unknownPublish?.status).toBe('awaiting-approval');
    expect(unknownPublish?.path.slice(-2)).toEqual(['publish', 'approve-continue']);
    expect(unknownPublish?.path).not.toContain('npm-publish');
    expect(result.cases.filter((item) => !item.pass).map(({ id, status, checks }) => ({ id, status, checks }))).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.universe).toBe(root);
    expect(result.artifactPath).toBe(join(root, 'ux-sim', 'evidence', 'release-sim-rig-0241.json'));
    expect(existsSync(result.artifactPath)).toBe(true);
    expect(result.cases).toHaveLength(26);
    expect(result.cases.every((item) => item.pass && item.unexpectedEdges.length === 0)).toBe(true);
    expect(result.cases.find((item) => item.id === 'baseline-full-graph')).toMatchObject({
      checks: { events: true }, injectedEvidence: { eventTrace: { pass: true, matched: 2, missing: [] } },
    });
    expect(result.cases.find((item) => item.id === 'gate-attribution-incomplete')).toMatchObject({
      pass: true, status: 'failed', path: ['version-release', 'traffic-cut-start', 'cutoff', 'pre-gate-join', 'gate', 'gate-triage', 'traffic-failed-restore', 'failed'],
      injectedEvidence: { actualGateTriage: { gate: { outcome: 'error', introduced: [] }, triage: { outcome: 'ok', classification: 'unmeasured' } } },
    });
    const threeRegressions = result.cases.find((item) => item.id === 'gate-three-new-regressions')!;
    expect(threeRegressions).toMatchObject({ pass: true, status: 'failed', checks: { adaptiveRepair: true },
      injectedEvidence: { adaptiveRepair: { disposition: 'append-repair-and-resume', appendCount: 1 } } });
    expect(threeRegressions.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(2);
    expect(threeRegressions.path.some((nodeId, index, path) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId)
      && path[index + 1] === 'gate')).toBe(true);

    expect(result.cases.find((item) => item.id === 'baseline-full-graph')?.ledgerEvents.some((event) => event.observedBy === 'GraphEventBus')).toBe(true);
    expect(result.cases.every((item) => item.dispatchedNodes.every((node) => item.path.includes(node) ||
      Object.values(item.fanOuts ?? {}).some((fanout) => Object.hasOwn(fanout.branches, node))))).toBe(true);
    expect(result.table.every((row) => row.unexpectedEdges === 'none')).toBe(true);
    const macrophage = result.cases.find((item) => item.id === 'macrophage-scrap-live-and-simulation')!;
    expect(macrophage).toMatchObject({ pass: true, status: 'done', checks: { status: true, mustVisit: true, mustNotVisit: true, overlap: true, ledgerEvents: true } });
    expect(macrophage.ledgerEvents).toHaveLength(15);
    const expectedMacrophageEvents = [
      ['pr-repair', 'repair recipe=retry-review', 'planned attempt-repair; no cleanup applied'],
      ['draft-stale', 'existing draft policy approved close', 'planned triage-draft; no cleanup applied'],
      ['test-repeated', 'consecutive failures=5; owner=seat-c', 'planned open-cell; no cleanup applied'],
      ['test-timeout', 'flaky=unknown; timeoutBurned=true', 'planned quarantine-test; no cleanup applied'],
      ['artifact-stale', 'source=new; generated=old', 'planned regenerate; no cleanup applied'],
      ['worktree-orphan', 'kind=orphan-worktree; branch merged to main; clean and inactive worktree verified', 'planned remove-resource; no cleanup applied'],
      ['pod-orphan', 'kind=orphan-pod; owner run=failed; ownership verified', 'planned remove-resource; no cleanup applied'],
      ['job-orphan', 'kind=orphan-job; owner run=done; ownership verified', 'planned remove-resource; no cleanup applied'],
      ['hold-expired', 'hold expired at=2026-11-05T00:00:00.000Z; owner=seat-d', 'planned release-hold; no cleanup applied'],
      ['hold-live-owner', 'hold owner run=running; expiry=2026-11-05T00:00:00Z; owner=seat-e', 'planned retain; no cleanup applied'],
      ['draft-live-owner', 'draft owner run=running; owner=seat-f', 'planned retain; no cleanup applied'],
      ['receipt-stale', 'stale and verified; owner run=done', 'planned archive-receipt; no cleanup applied'],
      ['worktree-live', 'kind=orphan-worktree; owner run=running; owner=seat-live', 'planned retain; no cleanup applied'],
      ['land-row-merged', 'PR merged; exact queued row verified (land-row-merged)', 'planned remove-queue-row; no cleanup applied'],
      ['receipt-unverified', 'stale=true; verified=false; owner run=done', 'planned retain; no cleanup applied'],
    ];
    expect(macrophage.ledgerEvents.map((event) => [event.id, event.evidence, event.result])).toEqual(expectedMacrophageEvents);
    expect(macrophage.ledgerEvents.every((event) => event.applied === false)).toBe(true);
    expect(macrophage.injectedEvidence.overlap).toEqual({ expected: false, actual: false });
    expect((macrophage.injectedEvidence.simulation as { remaining: string[] }).remaining).toContain('worktree-live');
    expect((macrophage.injectedEvidence.simulation as { remaining: string[] }).remaining).toContain('receipt-unverified');
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
        sameCommitCarryOk: true, sameCommitResume: { inspectionKind: 'valid', inspectedReceiptCount: 4,
          expectedCarry: ['pod-0', 'pod-1', 'pod-2', 'pod-3'], carriedShardIds: ['pod-0', 'pod-1', 'pod-2', 'pod-3'],
          rerunShardIds: [], totalPods: 0, output: expect.stringContaining('Ran 4 tests across 4 files.'), events: [
            { event: 'receipt-preflight', kind: 'valid', receiptCount: 4 },
            { event: 'shard-carried', shardId: 'pod-0' }, { event: 'shard-carried', shardId: 'pod-1' },
            { event: 'shard-carried', shardId: 'pod-2' }, { event: 'shard-carried', shardId: 'pod-3' },
            { event: 'gate-sweep-complete', rc: 0, totalPods: 0 },
          ] },
        carryRegressionFixture: { source: 'OPT #35384 draft body + preserved AWS evidence',
          expected: { carriedShardIds: ['pod-0', 'pod-1', 'pod-2', 'pod-3'], rerunShardIds: [], totalPods: 0 },
          draftObserved: { host: 'node-b', rerunShardIds: ['pod-0', 'pod-1', 'pod-2'], totalPods: 3 },
          optObserved: { head40: 'acb26b11af8dac1b4592d9b0f5081a5d48005212', host: 'aws1', cohort: 2, introduced: 1, preexisting: 3,
            reason: 'pinned graph or recipe SHA absent' } },
        formalReceiptInspection: { kind: 'absent' }, receiptCase: {
          formalReceiptDecision: { kind: 'absent', reason: 'formal-receipt-set-absent' },
          formalGateRun: { outcome: 'ok', formalReceiptDecision: 'formal-receipt-set-absent', baselineVersion: '0.3.0', cutSweepCount: 1, fullSweep: true },
        } },
    });
    const alternateBaselineScenario = readFileSync(scenarioPath, 'utf8')
      .replace('id: release-sim-rig-0241', 'id: release-sim-alternate-baseline-34922')
      .replace("previousVersion: '0.3.0'", "previousVersion: '0.2.99'");
    const alternateBaseline = await runReleaseSimRigScenario(retainCases(alternateBaselineScenario,
      ['append-receipt-set-absent-and-continuous-radius']));
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
    const appendedTipRegate = result.cases.find((item) => item.id === 'appended-tip-regate-before-waiver')!;
    expect(appendedTipRegate).toMatchObject({ pass: true, status: 'done', checks: {
      status: true, mustVisit: true, mustNotVisit: true, ledgerEvents: true,
    }, injectedEvidence: {
      invalidWaiverRejected: true, invalidAttemptUnchanged: true, movedTipWaiverRefused: true, movedTipAttemptUnchanged: true,
      regateFailed: true, regatePartial: { requested: true, applied: false, auto: true },
      gateRuns: 2, sameTipWaiver: true, acceptedIssuesOk: true, notesOk: true, releaseTailOk: true,
    } });
    const measuredRegression = result.cases.find((item) => item.id === 'gate-measured-regression-adaptive-repair')!;
    expect(measuredRegression).toMatchObject({ pass: true, status: 'failed', checks: { adaptiveRepair: true }, injectedEvidence: {
      actualGateTriage: { triage: { classification: 'regression', adaptiveHeal: { disposition: { action: 'append-repair-and-resume' } } } },
      adaptiveRepair: { disposition: 'append-repair-and-resume', appendCount: 1 },
    } });
    expect(measuredRegression.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(2);
    expect(measuredRegression.path.some((nodeId, index, path) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId)
      && path[index + 1] === 'gate')).toBe(true);
    const ownerWaiverCase = result.cases.find((item) => item.id === 'owner-waive-unmeasured-gate')!;
    expect(ownerWaiverCase).toMatchObject({
      pass: true, status: 'done', injectedEvidence: { ownerRecordOk: true, publishReached: true,
        actualGateTriage: { classification: 'unmeasured' }, waiverResult: { nodeId: 'gate', ownerWaived: true, approvedBy: 'OP' } },
    });
    const ledgerPath = String(ownerWaiverCase.injectedEvidence?.ownerLedgerPath);
    expect(ledgerPath).toContain(join(root, 'graph-runs', 'release-loop'));
    const persistedRun = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { nodes: Array<{ nodeId: string; waiver?: { ownerWaived?: boolean; approvedBy?: string; reason?: string } }> };
    expect(persistedRun.nodes.find((node) => node.nodeId === 'gate')?.waiver).toMatchObject({
      ownerWaived: true, approvedBy: 'OP', reason: ownerWaiverCase.injectedEvidence?.reason,
    });
    const unmeasuredStatePaths = new Set<string>();
    for (const [id, expected] of [
      ['owner-waive-stopped-gate', /^stopped:/],
      ['owner-waive-killed-gate', /^no-verdict:.*SIGTERM/],
      ['waive-sweep-incomplete-gate', /^sweep incomplete:/],
    ] as const) {
      const simulated = result.cases.find((item) => item.id === id)!;
      expect(simulated).toMatchObject({ pass: true, status: 'done', checks: {
        waiverOriginalPersisted: true, gateNotRerun: true, missingReasonRejected: true, secondWaiverRejected: true,
      } });
      const original = simulated.injectedEvidence?.originalGateRecord as { exit?: number | null; executionId?: string; output?: string; error?: string };
      if (id === 'owner-waive-stopped-gate') {
        expect(original).toMatchObject({ exit: null, error: expect.stringContaining('stopped') });
        expect(original.output).toBeUndefined();
      } else if (id === 'owner-waive-killed-gate') {
        expect(original).toMatchObject({ exit: null, error: expect.stringContaining('SIGTERM') });
        const output = JSON.parse(String(original.output)) as { executionId?: string; error?: string };
        expect(output).toMatchObject({ executionId: original.executionId, error: 'process terminated by SIGTERM' });
      } else {
        expect(original).toMatchObject({ exit: 1, error: 'bash exit 1' });
        expect(JSON.parse(original.output ?? 'null')).toMatchObject({ outcome: 'error', error: 'pod sweep incomplete: stalled shards 3',
          stalledShards: [{ shard: 3, files: ['a.test.ts'], reason: 'no-output' }] });
      }
      expect(simulated.injectedEvidence?.waiverResult).toMatchObject({ nodeId: 'gate', reason: expect.any(String) });
      expect(simulated.injectedEvidence?.sharedRunId).toBe('release-sim-release-sim-rig-0241-unmeasured-gate-shared');
      expect(simulated.injectedEvidence?.sharedInitialGraphRuns).toBe(1);
      expect(simulated.injectedEvidence?.releaseNotesOk).toBe(true);
      expect(String(simulated.injectedEvidence?.releaseNotes)).toContain(`- ${String(simulated.injectedEvidence?.reason)}`);
      const unmeasured = (simulated.injectedEvidence?.waiverResult as { unmeasured?: string }).unmeasured ?? '';
      expect(unmeasured).toMatch(expected);
      unmeasuredStatePaths.add(String(simulated.statePath));
      const persistedRun = JSON.parse(readFileSync(String(simulated.statePath), 'utf8')) as { nodes: Array<{ nodeId: string; waiver?: { original?: unknown } }> };
      const persisted = persistedRun.nodes.find((node) => node.nodeId === 'gate')?.waiver;
      expect(persisted?.original).toEqual(original && {
        exit: original.exit, ...(original.output === undefined ? {} : { output: original.output }), ...(original.error === undefined ? {} : { error: original.error }),
      });
      expect(JSON.stringify(persisted)).toBe(JSON.stringify(simulated.injectedEvidence?.persistedWaiver));
    }
    expect(unmeasuredStatePaths.size).toBe(3);
    const fixtureOwnerCase = result.cases.find((item) => item.id === 'owner-waive-0246-verdict-fixture')!;
    expect(fixtureOwnerCase).toMatchObject({ pass: true, status: 'done', injectedEvidence: {
      ownerRecordOk: true, releaseTailOk: true, publishReached: true, actualGateTriage: { classification: 'exhausted' },
    } });
    expect(fixtureOwnerCase.ledgerEvents.filter((event) => event.observedBy === 'GraphEventBus').some((event) =>
      event.event === 'node-end' && event.nodeId === 'verify' && event.ok === true)).toBe(true);
    expect(fixtureOwnerCase.injectedEvidence?.introducedIds).toHaveLength(101);
    expect(fixtureOwnerCase.injectedEvidence?.npmPublishEvidence).toMatchObject({
      publishNodeResult: { outcome: 'ok', verdict: 'pass', tag: 'v0.2.46' },
      publishNodeExternalCalls: expect.arrayContaining([expect.stringContaining('bun bin/elanous.mjs release publish')]),
    });
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
    const negativeOverlap = await runReleaseSimRigScenario(retainCases(negativeOverlapSource, ['cut-tip-moved-after-resume']));
    expect(negativeOverlap.pass).toBe(false);
    expect(negativeOverlap.cases.find((item) => item.id === 'cut-tip-moved-after-resume')).toMatchObject({
      pass: false, checks: { status: true, overlap: false },
    });
    const wrongRefusalExpectation = readFileSync(scenarioPath, 'utf8')
      .replace('id: release-sim-rig-0241', 'id: release-sim-negative-status-0245')
      .replace('      mustNotVisit: [cutoff, gate, publish]\n',
        '      mustNotVisit: [cutoff, gate, publish]\n      refusalIncludes: expected-but-different\n');
    const statusRegression = await runReleaseSimRigScenario(retainCases(wrongRefusalExpectation, ['cut-tip-moved-after-resume']));
    expect(statusRegression.pass).toBe(false);
    expect(statusRegression.cases.find((item) => item.id === 'cut-tip-moved-after-resume')?.checks.status).toBe(false);
    const wrongEventExpectation = readFileSync(scenarioPath, 'utf8')
      .replace('id: release-sim-rig-0241', 'id: release-sim-negative-resume-events-0245')
      .replace('      mustNotVisit: [cutoff, gate, publish]\n',
        '      mustNotVisit: [cutoff, gate, publish]\n      events: [{ event: node-start, node: never-started }]\n');
    const eventRegression = await runReleaseSimRigScenario(retainCases(wrongEventExpectation, ['cut-tip-moved-after-resume']));
    expect(eventRegression.pass).toBe(false);
    expect(eventRegression.cases.find((item) => item.id === 'cut-tip-moved-after-resume')?.checks)
      .toMatchObject({ status: true, events: false });
    const unattributedGate = result.cases.find((item) => item.id === 'gate-attribution-incomplete')!;
    expect(unattributedGate.path).toContain('traffic-failed-restore');
    const unattributedRun = JSON.parse(readFileSync(unattributedGate.statePath, 'utf8')) as {
      nodes: Array<{ nodeId: string; output?: string }>;
    };
    expect(JSON.parse(unattributedRun.nodes.find((node) => node.nodeId === 'gate')!.output!)).not.toHaveProperty('autoheal');
    const prefetchWarning = result.cases.find((item) => item.id === 'prefetch-warning-failure-overlaps-checklist')!;
    expect(prefetchWarning.path.indexOf('pre-gate-join')).toBeLessThan(prefetchWarning.path.indexOf('gate'));
    expect(prefetchWarning.fanOuts?.['cutoff:ok']?.branches).toMatchObject({
      'checklist-gate': { status: 'done' }, prefetch: { status: 'failed' },
    });
    const prefetchWarningTimings = prefetchWarning.nodeTimings!;
    expect(prefetchWarningTimings['checklist-gate']!.startedAtMs).toBeLessThan(prefetchWarningTimings.prefetch!.endedAtMs);
    expect(prefetchWarningTimings.prefetch!.startedAtMs).toBeLessThan(prefetchWarningTimings['checklist-gate']!.endedAtMs);
    const needsFailure = result.cases.find((item) => item.id === 'needs-prep-required-failure-preserves-sibling')!;
    expect(needsFailure).toMatchObject({ pass: true, status: 'failed', checks: { overlap: true } });
    expect(needsFailure.fanOuts?.['cutoff:ok']?.branches).toMatchObject({
      'checklist-gate': { status: 'failed', output: expect.any(String) },
      prefetch: { status: 'done', output: expect.any(String) },
    });
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
    const pwaFailurePreservesSibling = result.cases.find((item) => item.id === 'pwa-failure-preserves-mac-smoke-result')!;
    expect(pwaFailurePreservesSibling).toMatchObject({ pass: true, status: 'failed', checks: { overlap: true, events: true } });
    expect(pwaFailurePreservesSibling.fanOuts?.['traffic-gate-passed:ok']?.branches).toMatchObject({
      'mac-smoke': { status: 'done' }, pwa: { status: 'failed' },
    });
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);

test('release receipt and waiver modes reject expectations absent from the GraphEventBus trace', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-event-negative-test-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    const source = readFileSync(resolveScenarioFilePath('scenarios/ux-sim/release-sim-rig.yaml'), 'utf8');
    const scenario = parseYaml(source) as { id: string; cases: Array<{ id: string; expect: Record<string, unknown> }> };
    scenario.id = 'release-sim-event-negative';
    scenario.cases = scenario.cases.filter((item) => item.id === 'append-receipt-set-absent-and-continuous-radius'
      || item.id === 'gate-measured-regression-adaptive-repair');
    for (const item of scenario.cases) item.expect.events = [{ event: 'node-start', nodeId: 'never-started' }];
    const result = await runReleaseSimRigScenario(stringifyYaml(scenario));
    expect(result.pass).toBe(false);
    expect(result.cases).toHaveLength(2);
    expect(result.cases.every((item) => item.pass === false && item.checks.events === false)).toBe(true);
    expect(result.cases.every((item) => (item.injectedEvidence.eventTrace as { pass?: boolean } | undefined)?.pass === false)).toBe(true);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);



test('release sim preserves a completed gate verdict when a later same-run gate is interrupted', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-interrupted-verdict-sim-'));
  const verdict = join(root, 'release', '0.3.7', 'gate-verdict.json');
  const completed = { version: '0.3.7', commit: 'a'.repeat(40), outcome: 'regression',
    baselineReceipt: { schema: 2, valid: true, commit: 'a'.repeat(40), shards: 80 },
    introduced: ['src/new.test.ts > known regression'] };
  const interrupted = { version: '0.3.7', commit: 'b'.repeat(40), outcome: 'error',
    stalledShards: [{ id: 'pod-0', files: ['src/a.test.ts'], reason: 'timeout' }],
    partialFailures: { failures: [], errors: [] }, partialSummary: { pass: 0, fail: 0, errors: 0, ran: 0, files: 1 },
    baselineReceipt: { fullSweep: false, commit: 'b'.repeat(40), shards: 80 } };
  try {
    writeGateVerdictRecord(verdict, completed);
    writeGateVerdictRecord(verdict, interrupted);
    expect(JSON.parse(readFileSync(verdict, 'utf8'))).toEqual(completed);
    const attempts = readFileSync(join(root, 'release', '0.3.7', 'gate-verdict-attempts.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(attempts).toContainEqual(interrupted);
    expect(attempts).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
