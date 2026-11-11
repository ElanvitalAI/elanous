import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadReleaseGraphManifest, assertReleaseRecipeAllowed, bindReleaseGraphInstance } from '../graph-runner/release-graph-manifest.js';
import { type GraphRunState } from '../graph-runner/runner.js';
import { runHandResponseNode } from '../../scripts/release-loop/hand-response-node.js';
import { prepareSameRunGateRecheck } from '../../scripts/release-loop/gate-same-run-recheck-node.js';
import { stalledGateEvidence } from '../../scripts/release-loop/gate-stalled-evidence.js';
import { writeRecheckPlan } from '../../scripts/release-loop/gate-partial.js';
import { selectGateAppendRecheckEdge } from '../../scripts/release-loop/gate-partial.js';
import { releaseResumeGateWaiverCoverage } from '../../scripts/release-loop/resume.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { proposeGraphForUnseenEvent, runReleaseDay0307Replay, writeSameRunReplayReceiptFixture } from './release-day-0307-replay.js';

const REPO_ROOT = join(import.meta.dir, '../..');
const SCENARIO_PATH = join(REPO_ROOT, 'scenarios/ux-sim/release-day-0307-replay.yaml');
const MANIFEST_PATH = join(REPO_ROOT, 'graphs/release/plugin.json');
const GRAPH_PATH = join(REPO_ROOT, 'graphs/release/release-loop.yaml');

type ReleaseGraphFixture = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

function replayRouteFailures(graph: ReleaseGraphFixture): string[] {
  const nodeForRecipe = (recipe: string) => graph.nodes.find((node) => node.recipe === recipe);
  const outcomeMap = (nodeId: unknown) => {
    const edge = graph.edges.find((candidate) => candidate.from === nodeId && candidate.on === 'outcome');
    return edge?.map && typeof edge.map === 'object' ? edge.map as Record<string, unknown> : {};
  };
  const cutover = nodeForRecipe('cmd:gate-cutover-switch');
  const autoApprove = nodeForRecipe('cmd:auto-approve');
  const receiptAudit = nodeForRecipe('cmd:receipt-audit');
  const publishApproval = graph.nodes.find((node) => node.kind === 'hitl' && node.recipe === 'approval:publish');
  const auditTarget = outcomeMap(cutover?.node_id).audit;
  const approvalTarget = outcomeMap(autoApprove?.node_id).fail;
  const failures: string[] = [];
  if (!receiptAudit || auditTarget !== receiptAudit.node_id) failures.push('cutover audit edge must target the cmd:receipt-audit node');
  if (!publishApproval || approvalTarget !== publishApproval.node_id) failures.push('auto-approve failure edge must target the approval:publish HITL node');
  return failures;
}

test('RELEASE-GRAPH-ABSORB-ALL graph semantics: audit and publication approval routes follow node recipes', () => {
  const graph = parseYaml(readFileSync(GRAPH_PATH, 'utf8')) as ReleaseGraphFixture;
  expect(replayRouteFailures(graph)).toEqual([]);
});

test('RELEASE-GRAPH-ABSORB-ALL graph semantics: routing to another HITL does not satisfy publication approval', () => {
  const graph = structuredClone(parseYaml(readFileSync(GRAPH_PATH, 'utf8'))) as ReleaseGraphFixture;
  const autoApprove = graph.nodes.find((node) => node.recipe === 'cmd:auto-approve');
  const continueApproval = graph.nodes.find((node) => node.kind === 'hitl' && node.recipe === 'approval:continue-publish');
  const edge = graph.edges.find((candidate) => candidate.from === autoApprove?.node_id && candidate.on === 'outcome');
  expect(edge?.map && typeof edge.map === 'object').toBe(true);
  (edge!.map as Record<string, unknown>).fail = continueApproval?.node_id;
  expect(replayRouteFailures(graph)).toContain('auto-approve failure edge must target the approval:publish HITL node');
});

test('RELEASE-GRAPH-ABSORB-ALL graph semantics: bypassing the receipt-audit recipe fails the route contract', () => {
  const graph = structuredClone(parseYaml(readFileSync(GRAPH_PATH, 'utf8'))) as ReleaseGraphFixture;
  const cutover = graph.nodes.find((node) => node.recipe === 'cmd:gate-cutover-switch');
  const trafficGate = graph.nodes.find((node) => node.recipe === 'cmd:traffic-gate-passed');
  const edge = graph.edges.find((candidate) => candidate.from === cutover?.node_id && candidate.on === 'outcome');
  expect(edge?.map && typeof edge.map === 'object').toBe(true);
  (edge!.map as Record<string, unknown>).audit = trafficGate?.node_id;
  expect(replayRouteFailures(graph)).toContain('cutover audit edge must target the cmd:receipt-audit node');
});

test('RELEASE-GRAPH-ABSORB-ALL: actual same-run recheck accepts only complete local receipt evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-day-receipt-proof-'));
  const prepare = (receiptRoot: string, receiptRunId: string, contextRunId: string) => {
    const fixture = writeSameRunReplayReceiptFixture(receiptRoot, receiptRunId, 'a'.repeat(40), 'b'.repeat(40));
    const completedFileCount = fixture.completed.files.length;
    const noCompletedFailures = completedFileCount - completedFileCount;
    const result = prepareSameRunGateRecheck({ runId: contextRunId, nodeId: 'gate-same-run-recheck',
      input: { version: '0.3.7', previousVersion: '0.3.6' },
      outputs: { gate: { outcome: 'error', summary: 'shard result batch is incomplete', commit: fixture.head40,
        partialSummary: { pass: completedFileCount, fail: noCompletedFailures, errors: noCompletedFailures, ran: completedFileCount, files: completedFileCount },
        partialFailures: { failures: [], errors: [] }, preservedShardCount: completedFileCount,
        stalledShards: [{ shard: Number(fixture.stalled.id.slice(4)), files: fixture.stalled.files, reason: 'incomplete' }] },
        cutoff: { baseline: { sha: fixture.base40 } } },
    }, { repo: REPO_ROOT, roots: [receiptRoot.slice(0, receiptRoot.indexOf('/release/'))],
      ledgerRoot: receiptRoot.slice(0, receiptRoot.indexOf('/release/')),
      pinnedImageDigest: () => fixture.imageDigest, lockfileHash: () => fixture.lockfileHash,
      testsAtCommit: () => fixture.allFiles, existsAtCommit: () => true,
      inspect: (input) => stalledGateEvidence({ ...input, expectedTests: () => fixture.allFiles }), write: writeRecheckPlan });
    return { fixture, result };
  };
  try {
    const accepted = prepare(join(root, 'accepted/release/0.3.7/gate-logs/cut/receipts'), 'same-run', 'same-run');
    expect(accepted.result).toMatchObject({ outcome: 'ok', reusedShardCount: 1, remeasureFiles: ['test/stalled.test.ts'] });
    const foreign = prepare(join(root, 'foreign/release/0.3.7/gate-logs/cut/receipts'), 'foreign-run', 'expected-run');
    expect(foreign.result).toMatchObject({ outcome: 'ok', reusedShardCount: 0, fullSweepFallback: true });
    const missing = prepare(join(root, 'missing/release/0.3.7/gate-logs/cut/receipts'), 'same-run', 'same-run');
    rmSync(join(missing.fixture.receiptRoot, 'pod-0.receipt.json'));
    rmSync(join(root, 'missing/release/0.3.7/gate-partial.json'));
    const rejected = prepareSameRunGateRecheck({ runId: 'same-run', nodeId: 'gate-same-run-recheck',
      input: { version: '0.3.7', previousVersion: '0.3.6' },
      outputs: { gate: { outcome: 'error', summary: 'shard result batch is incomplete', commit: missing.fixture.head40 },
        cutoff: { baseline: { sha: missing.fixture.base40 } } },
    }, { repo: REPO_ROOT, roots: [join(root, 'missing')], ledgerRoot: join(root, 'missing'),
      pinnedImageDigest: () => missing.fixture.imageDigest, lockfileHash: () => missing.fixture.lockfileHash,
      testsAtCommit: () => missing.fixture.allFiles, existsAtCommit: () => true,
      inspect: (input) => stalledGateEvidence({ ...input, expectedTests: () => missing.fixture.allFiles }), write: writeRecheckPlan });
    expect(rejected).toMatchObject({ outcome: 'ok', reusedShardCount: 0, fullSweepFallback: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-GRAPH-ABSORB-ALL: release-day replay stays in declared recipes, policies, graph edges and HITL', async () => {
  const scenario = parseYaml(readFileSync(SCENARIO_PATH, 'utf8')) as {
    scenario: string; version: string; runId: string;
    policies: Record<string, unknown>; events: Array<Record<string, unknown>>;
  };
  const manifest = loadReleaseGraphManifest(MANIFEST_PATH);
  expect(scenario.scenario).toBe('release-day-0307-replay');
  expect(scenario.version).toBe('0.3.7');
  const replayRoot = mkdtempSync(join(tmpdir(), 'release-day-0307-device-'));
  const previousTestRoot = getTestStateRoot();
  setTestStateRoot(replayRoot);
  try {
    const replay = await runReleaseDay0307Replay();
    if (!replay.pass) throw new Error(JSON.stringify({ failures: replay.contractFailures, proposal: replay.proposal,
      graphStatus: replay.graphRun.cases.map((item) => ({ id: item.id, status: item.status, path: item.path })),
      action: replay.actionGraph }));
    expect(replay.runId).toBe(scenario.runId);
    expect(replay.events.map(({ id }) => id)).toEqual(Array.from({ length: 15 }, (_, index) => `A${index + 1}`));
    expect(replay.eventTrace).toHaveLength(15);
    expect(replay.eventTrace.every(({ observer, runId, rationale }) => observer === 'RLA' && runId === replay.runId && rationale.length > 0)).toBe(true);
    expect(replay.graphRun.pass).toBe(true);
    expect(replay.graphPath).toContain('approve-publish');
    expect(replay.hitlPath).toEqual(['approve-publish']);
    const proposal = replay.proposal;
    expect(proposal.pass).toBe(true);
    expect(proposal.graphSourceSame).toBe(true);
    expect(proposal.eventType).toBe('release.gate.receipt-gap-observed');
    expect(proposal.promotedPath).toContain('event-policy-full-recheck');
    expect(proposal.promotedPath).not.toContain('event-policy-append-recheck');
    expect(proposal.appendPath).toContain('event-policy-append-recheck');
    expect(proposal.appendPath).toContain('event-policy-append-run');
    expect(proposal.appendPath).not.toContain('event-policy-full-recheck');
    expect(proposal.promotedHitlPath).toEqual(['approve-publish']);
    expect(proposal.appendHitlPath).toEqual(['approve-publish']);
    expect(proposal.promotedRecheck).toMatchObject({ nodeId: 'event-policy-full-recheck', ok: true });
    expect(proposal.appendPlan).toMatchObject({ nodeId: 'event-policy-append-recheck', ok: true });
    // Source: 내부 문서 `RFC-release-loop-autonomy-and-coordinator` §3 requires same-run receipt reuse.
    expect((proposal.appendPlan.output as { reusedShardCount?: number }).reusedShardCount).toBeGreaterThan(0);
    expect(proposal.appendRecheck).toMatchObject({ nodeId: 'event-policy-append-run', ok: true });
    // Source: 내부 문서 `RFC-release-loop-autonomy-and-coordinator` §3 requires same-run receipt reuse.
    expect((proposal.appendRecheck.output as { gateResult?: { partial?: { files: number }; trainReceiptReuse?: { source?: string; carried?: number; remeasure?: number } } }).gateResult).toMatchObject({ partial: { files: 1 }, trainReceiptReuse: { carried: 1, remeasure: 1 } });
    expect((proposal.appendRecheck.output as { sweptFiles?: string[] }).sweptFiles).toEqual(['test/stalled.test.ts']);
    expect(proposal.foreignReceiptPlan.output).toMatchObject({ fullSweepFallback: true, reusedShardCount: 0 });
    expect(proposal.foreignReceiptRecheck.output).toMatchObject({ sweptFiles: ['test/completed.test.ts', 'test/stalled.test.ts'],
      gateResult: { trainReceiptReuse: { carried: 0, total: 2, remeasure: 2 } } });
    expect(proposal.missingReceiptPlan.output).toMatchObject({ fullSweepFallback: true, reusedShardCount: 0 });
    expect(proposal.missingReceiptRecheck.output).toMatchObject({ sweptFiles: ['test/completed.test.ts', 'test/stalled.test.ts'],
      gateResult: { trainReceiptReuse: { carried: 0, total: 2, remeasure: 2 } } });
    expect(proposal.promotedRecheck.output).not.toEqual(proposal.appendRecheck.output);
    const actionGraph = replay.actionGraph;
    expect(actionGraph).toMatchObject({ runId: `${scenario.runId}-proposed-promoted`, status: 'awaiting-approval',
      eventPath: [...scenario.events.slice(0, -1).map((event) => `event-${String(event.id).toLowerCase()}`), 'approve-publish'],
      hitlPath: ['approve-publish'] });
    expect(actionGraph.path).toContain('event-policy-full-recheck');
    expect(actionGraph.path[0]).toBe('event-release-gate-receipt-gap-observed');
    expect(actionGraph.path.indexOf('gate-triage')).toBeLessThan(actionGraph.path.indexOf('event-a1'));
    expect(actionGraph.nodeResults.find(({ nodeId }) => nodeId === 'gate-triage')?.ok).toBe(true);
    expect(actionGraph.path.at(-1)).toBe('approve-publish');
    const recipes = parseYaml(readFileSync(join(REPO_ROOT, 'graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string }>;
    const expectedCommands = scenario.events.flatMap((event): string[] => {
      if (typeof event.recipe !== 'string') return [];
      const command = recipes[event.recipe]?.command;
      const commands = typeof command === 'string' ? [command] : [];
      return event.id === 'A8' ? [...commands, recipes.gate!.command!] : commands;
    });
    expectedCommands.unshift(recipes['gate-triage']!.command!);
    expect(actionGraph.commands.filter((command) => !command.includes('gate-append-recheck-plan-node.ts'))).toEqual(expectedCommands);
    expect(actionGraph.commands.some((command) => command.includes('gate-append-recheck-plan-node.ts'))).toBe(true);
    expect(actionGraph.commands.filter((command) => command.includes('gate-node.ts')))
      .toHaveLength(scenario.events.filter((event) => event.recipe === 'gate').length + 1);
    expect(actionGraph.commands.filter((command) => command.includes('gate-same-run-recheck-node.ts')))
      .toHaveLength(scenario.events.filter((event) => event.recipe === 'gate-same-run-recheck').length);
    expect(actionGraph.pass).toBe(true);
    expect(replay.contractFailures).toEqual([]);
  } finally {
    if (previousTestRoot === undefined) setTestStateRoot(null);
    else setTestStateRoot(previousTestRoot);
    rmSync(replayRoot, { recursive: true, force: true });
  }
  expect(() => proposeGraphForUnseenEvent(readFileSync(GRAPH_PATH, 'utf8'), {
    type: 'release.unrecognized-event', nodeId: 'gate-triage', matchNodeId: 'gate', rationale: 'unsupported test event',
  }, [], { eventNodeId: 'proposed-event', planNodeId: 'proposal-plan', fullRecheckNodeId: 'full-recheck',
    appendPlanNodeId: 'append-plan', appendRunNodeId: 'append-run' })).toThrow('unsupported release event type');
  expect(manifest.graph).toBe('release-loop');
  expect(manifest.identity).toBe('elanous-0.x-release');
  expect(manifest.inputs).toEqual(['manual', 'release.cut.due']);
  expect(manifest.hitlNodes).toEqual(['approve-publish', 'approve-continue', 'gate-repair-recovery', 'gate-heal-decision']);
  expect(manifest.domainPackRules.filter((id) => id.startsWith('release-gate:'))).toHaveLength(6);
  expect(manifest.domainPackRules).toContain('release-gate:fail-unmeasured-disjoint');
  expect(manifest.edgeVocabulary).toEqual(['outcome', 'heal', 'retry', 'detour', 'rejoin', 'append-recheck', 'accept', 'escalate']);
  expect(manifest.terminalStates).toEqual(['done', 'failed']);
  for (const recipe of manifest.recipes) assertReleaseRecipeAllowed(manifest, recipe);
  expect(() => assertReleaseRecipeAllowed(manifest, 'gate-append-recheck-plan')).not.toThrow();
  expect(() => assertReleaseRecipeAllowed(manifest, 'unlisted-repair')).toThrow('rejects undeclared recipe');

  const deniedManifest = { ...manifest, recipes: manifest.recipes.filter((recipe) => recipe !== 'gate') };
  expect(() => assertReleaseRecipeAllowed(deniedManifest, 'gate')).toThrow('rejects undeclared recipe');

  const invalidGraphRoot = mkdtempSync(join(tmpdir(), 'release-graph-invalid-schema-'));
  try {
    for (const file of ['plugin.json', 'release-loop.yaml', 'release-loop-fanout.yaml', 'recipes.yaml',
      'release-gate-domain-pack.yaml', 'release-edge-vocabulary.yaml', 'release-graph.schema.yaml'])
      copyFileSync(join(REPO_ROOT, 'graphs/release', file), join(invalidGraphRoot, file));
    const invalidGraph = readFileSync(join(invalidGraphRoot, 'release-loop.yaml'), 'utf8').replace('map: { ok: traffic-cut-start', 'map: { ok: missing-node');
    writeFileSync(join(invalidGraphRoot, 'release-loop.yaml'), invalidGraph);
    expect(() => loadReleaseGraphManifest(join(invalidGraphRoot, 'plugin.json'))).toThrow('graph schema rejects edge target: missing-node');
  } finally {
    rmSync(invalidGraphRoot, { recursive: true, force: true });
  }

  const graphInstance = bindReleaseGraphInstance(manifest, { runId: scenario.runId, graphSha: 'b'.repeat(40),
    policyOverrides: scenario.policies });
  expect(graphInstance).toMatchObject({ runId: scenario.runId, template: 'release-day@0.3.8' });
  expect(() => bindReleaseGraphInstance(manifest, { runId: scenario.runId, graphSha: 'b'.repeat(40),
    policyOverrides: { hiddenPolicy: true } })).toThrow('rejects undeclared policy');
  const waiverEvent = scenario.events.find(({ id }) => id === 'A3');
  if (!waiverEvent || !Array.isArray(waiverEvent.introduced)) throw new Error('scenario is missing gate waiver coverage event');
  const introduced = waiverEvent.introduced as string[];
  const gateVerdict = { outcome: 'fail', verdict: 'fail', introduced, preexisting: 1, knownEnv: 0, durationMs: 1200,
    stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [], unmeasuredErrors: [], rcNonzeroNoFailures: [], abortedShards: 0 };
  const gateState = { path: ['version-release', 'gate', 'gate-triage', 'failed'], nodes: [
    { nodeId: 'version-release', ok: true, executed: true },
    { nodeId: 'gate', ok: false, executed: true, exit: 1, output: JSON.stringify(gateVerdict) },
    { nodeId: 'gate-triage', ok: true, executed: true }, { nodeId: 'failed', ok: true, executed: false },
    ], input: { version: '0.3.8' }, statePath: '/sim/release-run.json' } as unknown as GraphRunState;
  expect(releaseResumeGateWaiverCoverage(gateState, introduced.map((id) => ({ id, note: 'simulated accepted regression' }))))
    .toMatchObject({ eligible: true, introducedIds: introduced, missingIds: [] });
  expect(releaseResumeGateWaiverCoverage(gateState, [{ id: introduced[0]!, note: 'partial coverage' }]))
    .toMatchObject({ eligible: false, missingIds: introduced.slice(1) });
  const appendScenario = scenario.events.find(({ id }) => id === 'A8');
  if (!appendScenario) throw new Error('scenario is missing append-radius-recheck event');
  const simulationReceiptCosts = appendScenario.receiptCosts as { partialMs: number; fullMs: number; source: 'simulation-same-ledger' };
  const radiusInput = { radiusFiles: ['src/changed.test.ts'], receiptCosts: {
    partialMs: simulationReceiptCosts.partialMs, fullMs: simulationReceiptCosts.fullMs, source: 'same-ledger-receipts' as const,
  } };
  const pickShas = appendScenario.pickShas as string[];
  const appendCalls: Array<{ command: string; args: string[] }> = [];
  const appendContext = { graphId: 'release-loop', nodeId: 'cut-append', runId: scenario.runId,
    input: { version: '0.3.8', previousVersion: '0.3.7' }, nodeInput: { pickShas }, outputs: {} };
  expect(await runHandResponseNode('cut-append', { ELANOUS_GRAPH_CONTEXT: JSON.stringify(appendContext) }, {
    run: async (command, args) => { appendCalls.push({ command, args }); return { status: 0, stdout: '{}', stderr: '' }; },
  })).toBe(0);
  expect(appendCalls).toHaveLength(0);
  expect(await runHandResponseNode('cut-append', { ELANOUS_GRAPH_CONTEXT: JSON.stringify({ ...appendContext,
    nodeInput: { pickShas, apply: true, approvedAction: 'cut-append' } }) }, {
    run: async (command, args) => { appendCalls.push({ command, args }); return { status: 0, stdout: '{}', stderr: '' }; },
  })).toBe(0);
  expect(appendCalls).toEqual([{ command: 'eln', args: ['release', 'cut-branch', '--version', '0.3.8', '--append',
    '--pick', pickShas[0]!, '--json'] }]);

  const resumeEvent = scenario.events.find(({ id }) => id === 'A2');
  if (!resumeEvent || resumeEvent.runId !== scenario.runId) throw new Error('resume event must continue the scenario run');
  const resumePickShas = resumeEvent.pickShas as string[];
  const resumeCalls: Array<{ command: string; args: string[] }> = [];
  const resumeContext = { graphId: 'release-loop', nodeId: 'rla-release-recover', runId: scenario.runId,
    input: { version: '0.3.8', previousVersion: '0.3.7' }, nodeInput: { runId: resumeEvent.runId, pickShas: resumePickShas }, outputs: {} };
  expect(await runHandResponseNode('rla-release-recover', { ELANOUS_GRAPH_CONTEXT: JSON.stringify(resumeContext) }, {
    run: async (command, args) => { resumeCalls.push({ command, args }); return { status: 0, stdout: '{}', stderr: '' }; },
  })).toBe(0);
  expect(resumeCalls).toHaveLength(0);
  expect(await runHandResponseNode('rla-release-recover', { ELANOUS_GRAPH_CONTEXT: JSON.stringify({ ...resumeContext,
    nodeInput: { ...resumeContext.nodeInput, apply: true, approvedAction: 'rla-release-recover' } }) }, {
    run: async (command, args) => { resumeCalls.push({ command, args }); return { status: 0, stdout: '{}', stderr: '' }; },
  })).toBe(0);
  expect(resumeCalls).toEqual([{ command: 'eln', args: ['release', 'recover', '--run', scenario.runId,
    '--pick', resumePickShas[0]!, '--json'] }]);
  const gatePlan = (overrides: Partial<Parameters<typeof selectGateAppendRecheckEdge>[0]> = {}) => selectGateAppendRecheckEdge({
    changedFiles: ['scripts/release-loop/hand-response-node.ts'], radiusFiles: ['src/changed.test.ts'],
    closureOpaque: false,
    receiptCosts: radiusInput.receiptCosts, ...overrides,
  });
  expect(gatePlan()).toMatchObject({ edge: 'append-recheck', promoted: [] });
  expect(gatePlan({ changedFiles: ['package.json'] })).toMatchObject({ edge: 'full-recheck', promoted: ['dep-layer'] });
  expect(gatePlan({ changedFiles: ['scripts/release-loop/gate-node.ts'] })).toMatchObject({ edge: 'full-recheck', promoted: ['verdict-files'] });
  expect(gatePlan({ closureOpaque: true })).toMatchObject({ edge: 'full-recheck', promoted: ['opaque-closure'] });
  expect(gatePlan({ receiptCosts: { partialMs: 5, fullMs: 5, source: 'same-ledger-receipts' } }))
    .toMatchObject({ edge: 'full-recheck', promoted: ['cost-crossover'] });
  expect(gatePlan({ promoteToFull: [] })).toMatchObject({ edge: 'append-recheck', promoted: [] });
  expect(selectGateAppendRecheckEdge({ changedFiles: ['scripts/hand-response-node.ts'], radiusFiles: ['src/changed.test.ts'] }))
    .toMatchObject({ edge: 'full-recheck' });

}, 90_000);
