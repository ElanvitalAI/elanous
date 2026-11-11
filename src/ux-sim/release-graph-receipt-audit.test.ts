import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditGateFileReceiptSet, planGateFileReceipts, gateFileReceiptIdentityFromClosure, type GateFileReceipt, type GateFileReceiptEnvelope, type GateFileReceiptIdentity } from '../../scripts/release-loop/gate-file-receipts.js';
import { makeGateFileReceiptSimulationReceipt } from './gate-receipt-file-closure-cas.js';
import { createGraphEventBus } from '../graph-runner/graph-events.js';
import { runGraph } from '../graph-runner/runner.js';
import { auditGateFileReceipts } from '../../scripts/release-loop/gate-file-receipt-audit-node.js';
import { gateTriageShadowFromContext } from '../../scripts/release-loop/gate-triage-node.js';
import { planAdaptiveGateHeal } from '../../scripts/release-loop/adaptive-gate-heal.js';
import { latestGateOutput, type GraphContext } from '../../scripts/release-loop/node-verdict.js';

const IMAGE = 'sha256:' + 'a'.repeat(64);
const receiptAuditUnit = [
  'graph_id: release-receipt-audit-unit',
  'version: 1',
  'entry_node: receipt-audit',
  'terminal_nodes: [done, failed]',
  'nodes:',
  '  - { node_id: receipt-audit, kind: gate, recipe: "cmd:receipt-audit", max_visits: 5 }',
  '  - { node_id: residual-run, kind: gate, recipe: "cmd:residual-run", max_visits: 4 }',
  '  - { node_id: regression-triage, kind: gate, recipe: "cmd:regression-triage", max_visits: 1 }',
  '  - { node_id: gate-skip-by-evidence, kind: gate, recipe: "cmd:gate-skip-by-evidence", max_visits: 1 }',
  '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
  '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
  'edges:',
  '  - { from: receipt-audit, on: outcome, map: { ok: regression-triage, fail: residual-run, error: failed } }',
  '  - { from: residual-run, on: outcome, map: { ok: receipt-audit, fail: failed, error: failed } }',
  '  - { from: regression-triage, on: outcome, map: { ok: gate-skip-by-evidence, fail: failed, error: failed } }',
  '  - { from: gate-skip-by-evidence, on: outcome, map: { ok: done, fail: failed, error: failed } }',
  '',
].join('\n');

const releaseGraph = [
  'graph_id: release-receipt-audit-sim',
  'version: 1',
  'entry_node: cutoff',
  'terminal_nodes: [done, failed]',
  'nodes:',
  '  - { node_id: cutoff, kind: gate, recipe: "cmd:cutoff", max_visits: 1 }',
  '  - { node_id: receipt-audit-loop, kind: gate, recipe: "cmd:receipt-audit-loop", max_visits: 1 }',
  '  - { node_id: artifact-checks, kind: gate, recipe: "cmd:artifact-checks", max_visits: 1 }',
  '  - { node_id: receipt-artifact-join, kind: gate, recipe: none, max_visits: 1, needs: [receipt-audit-loop, artifact-checks] }',
  '  - { node_id: publish-approval, kind: hitl, recipe: "approval:publish", max_visits: 1 }',
  '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
  '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
  'edges:',
  '  - from: cutoff',
  '    on: outcome',
  '    branches: { ok: [receipt-audit-loop, artifact-checks] }',
  '    map: { fail: failed, error: failed }',
  '    join: receipt-artifact-join',
  '  - { from: receipt-artifact-join, on: outcome, map: { ok: publish-approval, fail: failed, error: failed } }',
  '  - { from: publish-approval, on: outcome, map: { ok: done, fail: failed, error: failed } }',
  '',
].join('\n');

type GateSkipEvidence = {
  commit: string;
  measurement: { complete: boolean; totalFiles: number; coveredFiles: number; unmeasuredFiles: string[] };
  introduced: string[];
  ledgerDefects: Array<{ kind: string; detail: string }>;
  otherFailures: string[];
};

function gateSkipByEvidence(evidence: GateSkipEvidence, expectedCommit: string) {
  const ledgerOnly = evidence.ledgerDefects.every(({ kind }) => ['receipt-write', 'verdict-write', 'baseline-write'].includes(kind));
  const ok = evidence.commit === expectedCommit && evidence.measurement.complete
    && evidence.measurement.totalFiles === evidence.measurement.coveredFiles
    && evidence.measurement.unmeasuredFiles.length === 0 && evidence.introduced.length === 0
    && evidence.otherFailures.length === 0 && ledgerOnly;
  return { outcome: ok ? 'ok' as const : 'fail' as const, knownIssues: [] as string[], ledgerDefects: evidence.ledgerDefects };
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function identity(file: string): GateFileReceiptIdentity {
  return { file, closureFiles: [file], contentHashes: { [file]: contentHash(file) }, imageDigest: IMAGE };
}

type HistoricalReplay = {
  runId: string;
  commit: string;
  files: string[];
  priorPassFiles: string[];
  corruptFiles?: string[];
  completedPerResidualBatch: number[];
  blockedReason?: string;
  ledgerDefects?: GateSkipEvidence['ledgerDefects'];
  artifactOutcome?: 'ok' | 'fail';
  expectedUnitPath: string[];
  expectedParentStatus: 'failed' | 'awaiting-approval';
};

const replays: readonly HistoricalReplay[] = [
  {
    runId: '037237b6-470a-40f8-a77a-b0719d5d12c7', commit: '303f318f12f4c3bb34539ca32f1ce5066c0b2776',
    files: ['scripts/release-loop/gate-a.test.ts', 'scripts/release-loop/gate-b.test.ts'], priorPassFiles: [],
    completedPerResidualBatch: [0], blockedReason: 'guardian lease conflict before shard execution',
    expectedUnitPath: ['receipt-audit', 'residual-run', 'failed'], expectedParentStatus: 'failed',
  },
  {
    runId: 'c159bb8d-1d60-4965-af62-cfe75f26fa68', commit: '02c6d5381274fed0a99cf156dd6b5c0894e98e7f',
    files: ['src/ux-sim/pod-17-replay.test.ts', 'scripts/lib/tui-streaming-e2e.test.ts', 'scripts/release-loop/covered.test.ts'],
    priorPassFiles: ['scripts/release-loop/covered.test.ts'], completedPerResidualBatch: [1, 1],
    ledgerDefects: [{ kind: 'receipt-write', detail: 'historical batch append warning' }],
    expectedUnitPath: ['receipt-audit', 'residual-run', 'receipt-audit', 'residual-run', 'receipt-audit', 'regression-triage', 'gate-skip-by-evidence', 'done'],
    expectedParentStatus: 'awaiting-approval',
  },
  {
    runId: '1475eed8-679b-464d-b8fd-acf23ccb1a09', commit: '3502f1d4dc4d2db6dd93a18a72d7c4b1e79c5dce',
    files: ['scripts/release-loop/pod-1-replay.test.ts', 'scripts/release-loop/covered.test.ts'],
    priorPassFiles: ['scripts/release-loop/covered.test.ts'], corruptFiles: ['scripts/release-loop/pod-1-replay.test.ts'],
    completedPerResidualBatch: [1],
    expectedUnitPath: ['receipt-audit', 'residual-run', 'receipt-audit', 'regression-triage', 'gate-skip-by-evidence', 'done'],
    expectedParentStatus: 'awaiting-approval',
  },
  {
    runId: '3f5dbada-6129-47d0-9d89-9d4919437101', commit: '3502f1d4dc4d2db6dd93a18a72d7c4b1e79c5dce',
    files: ['scripts/release-loop/gate-a.test.ts', 'scripts/release-loop/gate-b.test.ts'], priorPassFiles: [],
    completedPerResidualBatch: [0], blockedReason: 'recovery rejected by OP',
    expectedUnitPath: ['receipt-audit', 'residual-run', 'failed'], expectedParentStatus: 'failed',
  },
];

async function replayHistoricalRun(replay: HistoricalReplay) {
  const root = mkdtempSync(join(tmpdir(), 'release-receipt-audit-sim-'));
  const graphDir = join(root, 'graph');
  const unitDir = join(graphDir, 'units');
  mkdirSync(unitDir, { recursive: true });
  const graphPath = join(graphDir, 'release-loop.yaml');
  writeFileSync(graphPath, releaseGraph);
  writeFileSync(join(unitDir, 'release-receipt-audit.yaml'), receiptAuditUnit);
  writeFileSync(join(graphDir, 'recipes.yaml'), [
    'cutoff:', '  command: fake cutoff', 'receipt-audit-loop:', '  command: fake receipt audit loop',
    'artifact-checks:', '  command: fake artifact checks', 'publish:', '  approval: Publish 0.3.7?', '',
  ].join('\n'));
  writeFileSync(join(unitDir, 'recipes.yaml'), [
    'receipt-audit:', '  command: fake receipt audit', 'residual-run:', '  command: fake residual run',
    'regression-triage:', '  command: fake regression triage', 'gate-skip-by-evidence:', '  command: fake gate skip by evidence', '',
  ].join('\n'));

  const identities = replay.files.map(identity);
  let receipts: GateFileReceipt[] = replay.priorPassFiles.map((file) => makeGateFileReceiptSimulationReceipt(
    identities.find((row) => row.file === file)!, replay.commit, replay.runId, 'cut'));
  for (const file of replay.corruptFiles ?? []) {
    const receipt = makeGateFileReceiptSimulationReceipt(identities.find((row) => row.file === file)!, replay.commit, replay.runId, 'cut');
    receipts.push({ ...receipt, key: 'f'.repeat(64) });
  }
  const timeline: string[] = [];
  const calls: Array<{ graphId: string; nodeId: string; files?: string[]; evidence?: unknown }> = [];
  const eventBus = createGraphEventBus();
  eventBus.subscribe((event) => {
    if (['node-start', 'node-end', 'node-arrival'].includes(event.type))
      timeline.push(event.type + ':' + event.graphId + ':' + event.source.nodeId);
  });
  let barrierArrivals = 0;
  let releaseBarrier!: () => void;
  let rejectBarrier!: (error: Error) => void;
  let barrierTimer: ReturnType<typeof setTimeout>;
  const branchStartBarrier = new Promise<void>((resolve, reject) => {
    releaseBarrier = resolve;
    rejectBarrier = reject;
    barrierTimer = setTimeout(() => reject(new Error('receipt and artifact branches did not start together')), 5000);
  });
  const awaitBranchPeer = async () => {
    barrierArrivals++;
    if (barrierArrivals === 2) {
      clearTimeout(barrierTimer);
      releaseBarrier();
    }
    if (barrierArrivals > 2) rejectBarrier(new Error('unexpected extra fanout branch'));
    await branchStartBarrier;
  };
  let residualIndex = 0;
  let unitState: { status: string; path: string[] } | undefined;
  try {
    const state = await runGraph(graphPath, {
      runId: replay.runId,
      input: { version: '0.3.7', commit: replay.commit, historicalRunId: replay.runId },
      eventBus,
      deps: {
        root,
        runBash: async (_command, options) => {
          const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
          if (!contextPath) throw new Error('graph context missing in receipt audit simulation');
          const context = JSON.parse(readFileSync(contextPath, 'utf8')) as {
            graphId: string; nodeId: string; input?: { commit?: string }; outputs?: Record<string, unknown>;
          };
          const { graphId, nodeId } = context;
          if (graphId === 'release-receipt-audit-sim' && nodeId === 'receipt-audit-loop') {
            const cutoff = context.outputs?.cutoff as { commit?: string } | undefined;
            if (cutoff?.commit !== context.input?.commit) throw new Error('receipt audit commit differs from cutoff commit');
            await awaitBranchPeer();
            unitState = await runGraph(join(unitDir, 'release-receipt-audit.yaml'), {
              runId: replay.runId + '-receipt-audit', input: context.input,
              eventBus,
              deps: {
                root,
                runBash: async (_innerCommand, innerOptions) => {
                  const innerPath = innerOptions.env?.ELANOUS_GRAPH_CONTEXT;
                  if (!innerPath) throw new Error('inner graph context missing in receipt audit simulation');
                  const inner = JSON.parse(readFileSync(innerPath, 'utf8')) as {
                    graphId: string; nodeId: string; input?: { commit?: string; historicalRunId?: string };
                    outputs?: Record<string, unknown>;
                  };
                  const commit = inner.input?.commit ?? '';
                  const output = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value) + '\n', stderr: '' });
                  if (inner.nodeId === 'receipt-audit') {
                    const plan = planGateFileReceipts({ current: identities, receipts });
                    const audit = auditGateFileReceiptSet({ identities, receipts });
                    const evidence: GateSkipEvidence = {
                      commit, measurement: { complete: audit.ok, totalFiles: identities.length,
                        coveredFiles: identities.length - plan.measure.length, unmeasuredFiles: plan.measure.map((row) => row.file) },
                      introduced: [], ledgerDefects: replay.ledgerDefects ?? [], otherFailures: [],
                    };
                    calls.push({ graphId: inner.graphId, nodeId: inner.nodeId, files: evidence.measurement.unmeasuredFiles, evidence });
                    return { ...output({ outcome: audit.ok ? 'ok' : 'fail', audit, ...evidence }), exitCode: audit.ok ? 0 : 1 };
                  }
                  if (inner.nodeId === 'residual-run') {
                    const plan = planGateFileReceipts({ current: identities, receipts });
                    const maxCompleted = replay.completedPerResidualBatch[residualIndex++] ?? plan.measure.length;
                    const completed = replay.blockedReason ? [] : plan.measure.slice(0, maxCompleted);
                    for (const row of completed) {
                      receipts = receipts.filter((receipt) => receipt.file !== row.file);
                      receipts.push(makeGateFileReceiptSimulationReceipt(row, commit, replay.runId, 'cut'));
                    }
                    calls.push({ graphId: inner.graphId, nodeId: inner.nodeId, files: completed.map((row) => row.file) });
                    const ok = completed.length > 0;
                    return { ...output({ outcome: ok ? 'ok' : 'fail', files: completed.map((row) => row.file),
                      ...(replay.blockedReason ? { blockedReason: replay.blockedReason } : {}) }), exitCode: ok ? 0 : 1 };
                  }
                  const auditEvidence = inner.outputs?.['receipt-audit'] as GateSkipEvidence | undefined;
                  if (!auditEvidence) throw new Error('receipt-audit evidence missing from downstream graph context');
                  if (inner.nodeId === 'regression-triage') {
                    const triage = { outcome: auditEvidence.introduced.length === 0 && auditEvidence.otherFailures.length === 0 ? 'ok' : 'fail',
                      introduced: auditEvidence.introduced, otherFailures: auditEvidence.otherFailures };
                    calls.push({ graphId: inner.graphId, nodeId: inner.nodeId, evidence: triage });
                    return { ...output(triage), exitCode: triage.outcome === 'ok' ? 0 : 1 };
                  }
                  if (inner.nodeId === 'gate-skip-by-evidence') {
                    const decision = gateSkipByEvidence(auditEvidence, commit);
                    calls.push({ graphId: inner.graphId, nodeId: inner.nodeId, evidence: decision });
                    return { ...output(decision), exitCode: decision.outcome === 'ok' ? 0 : 1 };
                  }
                  throw new Error('unexpected audit unit node: ' + inner.nodeId);
                },
              },
            });
            calls.push({ graphId, nodeId, evidence: unitState.status });
            return { exitCode: unitState.status === 'done' ? 0 : 1,
              stdout: JSON.stringify({ outcome: unitState.status === 'done' ? 'ok' : 'fail', path: unitState.path }) + '\n', stderr: '' };
          }
          if (graphId === 'release-receipt-audit-sim' && nodeId === 'artifact-checks') {
            await awaitBranchPeer();
            calls.push({ graphId, nodeId });
            return { exitCode: replay.artifactOutcome === 'fail' ? 1 : 0,
              stdout: JSON.stringify({ outcome: replay.artifactOutcome ?? 'ok' }) + '\n', stderr: '' };
          }
          if (nodeId === 'cutoff') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: replay.commit }) + '\n', stderr: '' };
          throw new Error('unexpected parent graph node: ' + nodeId);
        },
      },
    });
    if (!unitState) throw new Error('receipt audit loop did not execute');
    return { state, unitState, timeline, calls, barrierArrivals };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('release receipt audit replays four 0.3.7 runs using production receipt planning and fail-closed skip evidence', async () => {
  const results = [];
  for (const replay of replays) results.push(await replayHistoricalRun(replay));
  expect(results.map(({ state }) => state.status)).toEqual(replays.map((replay) => replay.expectedParentStatus));
  expect(results.map(({ unitState }) => unitState.status)).toEqual(replays.map((replay) => replay.expectedParentStatus === 'failed' ? 'failed' : 'done'));
  expect(results.map(({ unitState }) => unitState.path)).toEqual(replays.map((replay) => replay.expectedUnitPath));
  expect(results.every((result) => result.barrierArrivals === 2)).toBe(true);
  expect(results[1]?.calls.filter((call) => call.nodeId === 'residual-run').map((call) => call.files)).toEqual([
    ['src/ux-sim/pod-17-replay.test.ts'], ['scripts/lib/tui-streaming-e2e.test.ts'],
  ]);
  expect(results[2]?.calls.filter((call) => call.nodeId === 'residual-run').map((call) => call.files)).toEqual([
    ['scripts/release-loop/pod-1-replay.test.ts'],
  ]);
  for (const [index, result] of results.entries()) {
    const parentJoin = result.timeline.indexOf('node-start:release-receipt-audit-sim:receipt-artifact-join');
    const gateEnd = result.timeline.indexOf('node-end:release-receipt-audit-sim:receipt-audit-loop');
    const artifactEnd = result.timeline.indexOf('node-end:release-receipt-audit-sim:artifact-checks');
    expect(parentJoin).toBeGreaterThan(gateEnd);
    expect(parentJoin).toBeGreaterThan(artifactEnd);
    expect(result.state.path).not.toContain('gate-same-run-recheck');
    expect(result.state.path).not.toContain('publish-command');
    if (index === 1 || index === 2) {
      const graph = 'release-receipt-audit-unit';
      const lastAudit = result.timeline.lastIndexOf('node-end:' + graph + ':receipt-audit');
      const triageStart = result.timeline.indexOf('node-start:' + graph + ':regression-triage');
      const skipStart = result.timeline.indexOf('node-start:' + graph + ':gate-skip-by-evidence');
      const unitDone = result.timeline.indexOf('node-start:' + graph + ':done');
      expect(lastAudit).toBeLessThan(triageStart);
      expect(triageStart).toBeLessThan(skipStart);
      expect(skipStart).toBeLessThan(unitDone);
      expect(result.calls.find((call) => call.nodeId === 'gate-skip-by-evidence')?.evidence).toMatchObject({ outcome: 'ok', knownIssues: [] });
    } else {
      expect(result.timeline.some((event) => event.endsWith(':gate-skip-by-evidence'))).toBe(false);
    }
    if (replays[index]!.expectedParentStatus === 'failed') expect(result.state.path).not.toContain('publish-approval');
  }
  expect(results[1]?.state.path).toContain('publish-approval');
  expect(results[2]?.state.path).toContain('publish-approval');
});

test('artifact failure blocks publish approval after both parallel branches finish', async () => {
  const replay = { ...replays[2]!, runId: 'sim-artifact-fail', artifactOutcome: 'fail' as const };
  const result = await replayHistoricalRun(replay);
  expect(result.state.status).toBe('failed');
  const join = result.timeline.indexOf('node-start:release-receipt-audit-sim:receipt-artifact-join');
  expect(join).toBeGreaterThan(result.timeline.indexOf('node-end:release-receipt-audit-sim:receipt-audit-loop'));
  expect(join).toBeGreaterThan(result.timeline.indexOf('node-end:release-receipt-audit-sim:artifact-checks'));
  expect(result.state.path).not.toContain('publish-approval');
});

test('gate skip by evidence accepts only complete same-commit measurements with ledger-only defects', () => {
  const complete: GateSkipEvidence = { commit: 'a'.repeat(40), measurement: { complete: true, totalFiles: 2, coveredFiles: 2, unmeasuredFiles: [] },
    introduced: [], ledgerDefects: [{ kind: 'receipt-write', detail: 'append failed after all test outcomes were measured' }], otherFailures: [] };
  expect(gateSkipByEvidence(complete, 'a'.repeat(40))).toEqual({ outcome: 'ok', knownIssues: [], ledgerDefects: complete.ledgerDefects });
  const rejects: GateSkipEvidence[] = [
    { ...complete, commit: 'b'.repeat(40) },
    { ...complete, measurement: { ...complete.measurement, complete: false } },
    { ...complete, measurement: { ...complete.measurement, coveredFiles: 1, unmeasuredFiles: ['test/missing.test.ts'] } },
    { ...complete, introduced: ['test/regression.test.ts > new failure'] },
    { ...complete, otherFailures: ['host preflight failed'] },
    { ...complete, ledgerDefects: [{ kind: 'test-failure', detail: 'not a ledger failure' }] },
  ];
  for (const evidence of rejects) expect(gateSkipByEvidence(evidence, 'a'.repeat(40))).toMatchObject({ outcome: 'fail', knownIssues: [] });
});


test('production release-loop re-entry audits same-run receipts and keeps failed residuals before traffic/publish', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const commit = 'a'.repeat(40);
  const runProduction = async (residualFails: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'release-production-receipt-audit-'));
    const runId = residualFails ? 'receipt-audit-failing-reentry' : 'receipt-audit-passing-reentry';
    const file = 'scripts/fixture.test.ts';
    const closure = { files: [file], read: (path: string) => path === file ? file : undefined, preload: [] as string[] };
    const currentIdentity = gateFileReceiptIdentityFromClosure(closure, file, IMAGE)!;
    let receipts: GateFileReceipt[] = [];
    let trafficPassed = false;
    let publishCalled = false;
    try {
      const state = await runGraph(graphPath, { runId, input: { version: '0.3.8', previousVersion: '0.3.7',
        cutSha: commit, candidatePath: 'sim:receipt-audit' }, deps: { root,
        runBash: async (_command, options) => {
          const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
          if (!contextPath) throw new Error('production graph context missing');
          const context = JSON.parse(readFileSync(contextPath, 'utf8')) as GraphContext;
          const output = (value: unknown, exitCode = 0) => ({ stdout: JSON.stringify(value) + '\n', stderr: '', exitCode });
          if (context.graphId === 'pod-reuse-prep') return output({ outcome: 'legacy', verdict: 'legacy',
            reason: 'prep-body-pending', receiptPath: '' });
          if (context.nodeId === 'gate-cutover-switch') return output({ outcome: 'audit' });
          if (context.nodeId === 'version-release' || context.nodeId === 'cutoff') return output({ outcome: 'ok', commit });
          if (context.nodeId === 'gate') return output({ outcome: 'ok', commit, introduced: [] });
          if (context.nodeId === 'receipt-audit' || context.nodeId === 'receipt-audit-recheck') {
            const audit = auditGateFileReceipts(context, { repo: process.cwd(), roots: { instance: root, ledger: root },
              testsAtCommit: () => [file], closureTree: () => closure, pinnedImage: () => IMAGE,
              readReceipt: (_dir, key) => (receipts.find((receipt) => receipt.key === key) as GateFileReceiptEnvelope | undefined) ?? null });
            return output(audit, audit.outcome === 'ok' ? 0 : audit.outcome === 'fail' ? 1 : 2);
          }
          if (context.nodeId === 'residual-run') {
            if (!residualFails) receipts = [makeGateFileReceiptSimulationReceipt(currentIdentity, commit, runId, 'cut')];
            const verdict = residualFails
              ? { outcome: 'fail', commit, introduced: [file + ' > introduced fixture failure'], failureIds: ['fixture-failure'] }
              : { outcome: 'ok', commit, introduced: [] };
            return output(verdict, residualFails ? 1 : 0);
          }
          if (context.nodeId === 'gate-triage') {
            const gate = latestGateOutput(context);
            if (!gate) throw new Error('production gate triage did not receive the current gate visit');
            const triageContext = { ...context, outputs: { ...context.outputs, gate } };
            const shadow = gateTriageShadowFromContext(triageContext);
            const adaptiveHeal = planAdaptiveGateHeal({ version: context.input.version, runId, gate: gate as never,
              triage: shadow, sourceOutcome: gate.outcome as never, visitState: { gate: 2, gateTriage: 1 }, gateExecutor: 'pod' });
            const outcome = adaptiveHeal.disposition.action === 'decision-required' ? 'fail' : shadow.outcome;
            return output({ ...shadow, outcome, adaptiveHeal, prescription: adaptiveHeal.disposition }, outcome === 'ok' ? 0 : 1);
          }
          if (context.nodeId === 'traffic-gate-passed') trafficPassed = true;
          if (context.nodeId === 'publish') publishCalled = true;
          return output({ outcome: 'ok', summary: 'simulated external boundary ' + context.nodeId });
        } } });
      return { state, trafficPassed, publishCalled };
    } finally { rmSync(root, { recursive: true, force: true }); }
  };

  const recovered = await runProduction(false);
  expect(recovered.state.path).toContain('receipt-audit');
  expect(recovered.state.path).toContain('residual-run');
  expect(recovered.state.path).toContain('receipt-audit-recheck');
  expect(recovered.trafficPassed).toBe(true);
  expect(recovered.publishCalled).toBe(true);

  const blocked = await runProduction(true);
  expect(blocked.state.path).toContain('receipt-audit');
  expect(blocked.state.path).toContain('residual-run');
  expect(blocked.state.path).toContain('gate-triage');
  expect(blocked.state.path).not.toContain('receipt-audit-recheck');
  expect(blocked.trafficPassed).toBe(false);
  expect(blocked.publishCalled).toBe(false);
});
