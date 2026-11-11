import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadReleaseGraphManifest, assertReleaseRecipeAllowed } from '../graph-runner/release-graph-manifest.js';
import { runGraph } from '../graph-runner/runner.js';
import { prepareSameRunGateRecheck } from '../../scripts/release-loop/gate-same-run-recheck-node.js';
import { runHandResponseNode } from '../../scripts/release-loop/hand-response-node.js';
import { judgeGate, runGateNode, type GateResult } from '../../scripts/release-loop/gate-runtime.js';
import type { GateRunner } from '../../scripts/release-loop/gate-node.js';
import { gateEnvFingerprint } from '../../scripts/release-loop/gate-baseline-receipt.js';
import { gateShardRuntimeIdentityKey } from '../../scripts/release-loop/gate-shard-dispatch.js';
import { markGateShardUnmeasured, saveGateShardResult } from '../../scripts/release-loop/gate-shard-receipts.js';
import { writeRecheckPlan } from '../../scripts/release-loop/gate-partial.js';
import { stalledGateEvidence } from '../../scripts/release-loop/gate-stalled-evidence.js';
import { runExportCheck } from '../../scripts/release-loop/export-check-node.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { runReleaseSimRigScenario, type ReleaseSimRigResult } from './release-sim-rig.js';

const REPO_ROOT = join(import.meta.dir, '../..');
const SCENARIO_PATH = join(REPO_ROOT, 'scenarios/ux-sim/release-day-0307-replay.yaml');
const MANIFEST_PATH = join(REPO_ROOT, 'graphs/release/plugin.json');
const GRAPH_PATH = join(REPO_ROOT, 'graphs/release/release-loop.yaml');
const RECIPES_PATH = join(REPO_ROOT, 'graphs/release/recipes.yaml');
const EXPECTED_IDS = Array.from({ length: 15 }, (_, index) => `A${index + 1}`);
const REPLAY_GATE_FILES = ['test/completed.test.ts', 'test/stalled.test.ts'];

export interface ReleaseDay0307ReplayEvent {
  readonly id: string;
  readonly type: string;
  readonly action: string;
  readonly binding: string;
  readonly mechanism: 'recipe' | 'domain-pack' | 'edge' | 'hitl';
  readonly rationale: string;
  readonly runId?: string;
  readonly recipe?: string;
  readonly introduced?: string[];
  readonly pickShas?: string[];
  readonly changedFiles?: string[];
  readonly receiptCosts?: { readonly partialMs: number; readonly fullMs: number; readonly source: 'simulation-same-ledger' };
  readonly [key: string]: unknown;
}

export interface ReleaseDay0307ReplayResult {
  readonly pass: boolean;
  readonly runId: string;
  readonly events: readonly ReleaseDay0307ReplayEvent[];
  readonly eventTrace: readonly { readonly event: 'release.day.0307.intervention'; readonly observer: 'RLA'; readonly runId: string;
    readonly sequence: number; readonly id: string; readonly action: string; readonly rationale: string; readonly mechanism: string }[];
  readonly graphRun: ReleaseSimRigResult;
  readonly graphPath: readonly string[];
  readonly hitlPath: readonly string[];
  readonly actionGraph: { readonly runId: string; readonly status: string; readonly path: readonly string[];
    readonly eventPath: readonly string[]; readonly commands: readonly string[]; readonly hitlPath: readonly string[];
    readonly nodeResults: readonly { readonly nodeId: string; readonly ok: boolean; readonly output?: unknown }[]; readonly pass: boolean };
  readonly proposal: { readonly pass: boolean; readonly graphSourceSame: boolean; readonly eventType: string;
    readonly promotedPath: readonly string[]; readonly appendPath: readonly string[];
    readonly promotedHitlPath: readonly string[]; readonly appendHitlPath: readonly string[];
    readonly promotedRecheck: { readonly nodeId: string; readonly ok: boolean; readonly output?: unknown };
    readonly appendPlan: { readonly nodeId: string; readonly ok: boolean; readonly output?: unknown };
    readonly appendRecheck: { readonly nodeId: string; readonly ok: boolean; readonly output?: unknown };
    readonly foreignReceiptPlan: { readonly nodeId: string; readonly ok: boolean; readonly output?: unknown };
    readonly foreignReceiptRecheck: { readonly nodeId: string; readonly ok: boolean; readonly output?: unknown };
    readonly missingReceiptPlan: { readonly nodeId: string; readonly ok: boolean; readonly output?: unknown };
    readonly missingReceiptRecheck: { readonly nodeId: string; readonly ok: boolean; readonly output?: unknown } };
  readonly contractFailures: readonly string[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

type ProposalNodeIds = {
  eventNodeId: string;
  planNodeId: string;
  fullRecheckNodeId: string;
  appendPlanNodeId: string;
  appendRunNodeId: string;
};

type ReplayReceiptFixture = { receiptRoot: string; runId: string; head40: string; base40: string; envKey: string;
  lockfileHash: string; imageDigest: string; completed: { id: string; files: string[] }; stalled: { id: string; files: string[] };
  allFiles: string[] };

export function writeSameRunReplayReceiptFixture(receiptRoot: string, runId: string, head40: string, base40: string): ReplayReceiptFixture {
  const completed = { id: 'pod-0', files: ['test/completed.test.ts'] };
  const stalled = { id: 'pod-1', files: ['test/stalled.test.ts'] };
  const envFingerprint = gateEnvFingerprint(process.env);
  const lockfileHash = createHash('sha256').update('release-day-0307-lockfile').digest('hex');
  const imageDigest = `sha256:${createHash('sha256').update('release-day-0307-image').digest('hex')}`;
  const runtimeIdentity = { bunVersion: process.versions.bun ?? '1.4.2', platform: process.platform,
    architecture: process.arch, envFingerprint, baseImageDigest: `sha256:${'a'.repeat(64)}` };
  const envKey = gateShardRuntimeIdentityKey(runtimeIdentity, lockfileHash)!;
  const common = { version: '0.3.7', graphRunId: runId, graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64),
    graphEntry: 'gate-entry-v1', recipeCommand: 'bun scripts/release-loop/gate-node.ts --json',
    // Source: 내부 문서 `RFC-release-loop-autonomy-and-coordinator` A8; fixture process bound only.
    recipeTimeoutMs: 1000,
    head40, base40, host: 'sim-host', envKey, envFingerprint, imageDigest, lockfileHash, runtimeIdentity,
    measuredAt: '2026-11-10T00:00:00.000Z', attempt: 1 };
  saveGateShardResult(receiptRoot, { receipt: { ...common, ...completed,
    testedFileHashes: Object.fromEntries(completed.files.map((file) => [file, createHash('sha256').update(file).digest('hex')])),
    executions: [{ branch: 'sim', attemptId: 'same-run-pod-0', host: 'sim-host', imageDigest, runtimeIdentity }],
    status: 'complete', failureIds: [], errorIds: [], evidencePath: 'pending', evidenceSha256: '0'.repeat(64) },
    runs: [{ output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1,
      files: 1, passedIds: [`${completed.files[0]} > measured pass`] }] });
  markGateShardUnmeasured(receiptRoot, { ...common, ...stalled, status: 'unmeasured', failureIds: [], errorIds: [],
    evidencePath: 'pending', evidenceSha256: '0'.repeat(64) });
  return { receiptRoot, runId, head40, base40, envKey, lockfileHash, imageDigest, completed, stalled,
    allFiles: [...completed.files, ...stalled.files] };
}

export function proposeGraphForUnseenEvent(graphSource: string, event: { type: string; nodeId: string; rationale: string; matchNodeId: string },
  events: readonly ReleaseDay0307ReplayEvent[], nodeIds: ProposalNodeIds) {
  const graph = asRecord(parseYaml(graphSource), 'release graph proposal base');
  const nodes = graph.nodes as Array<Record<string, unknown>>;
  const edges = graph.edges as Array<Record<string, unknown>>;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !nodes.some((node) => node.node_id === event.nodeId))
    throw new Error('RLA graph proposal requires a valid graph and a declared triage node');
  if (event.type !== 'release.gate.receipt-gap-observed') throw new Error(`unsupported release event type: ${event.type}`);
  if (!event.rationale.trim()) throw new Error('unsupported release event routing proposal');
  const triage = nodes.find((node) => node.node_id === event.nodeId)!;
  const subscriptions = Array.isArray(triage.subscribes) ? triage.subscribes as Array<Record<string, unknown>> : [];
  if (subscriptions.some((subscription) => subscription.event === event.type))
    throw new Error(`event type is already declared: ${event.type}`);
  triage.subscribes = [...subscriptions, { event: event.type, match: { nodeId: event.matchNodeId }, action: 'reroute' }];
  const eventNodes = events.filter((item) => item.id !== 'A15').map((item) => ({
    node_id: actionIdForEvent(item.id), kind: 'gate', recipe: item.recipe ? `cmd:${item.recipe}` : 'none', max_visits: 1,
    input: { ...item, action: item.recipe,
      ...(item.recipe === 'rla-train-worker-restart' ? { host: 'aws1', slot: '1', stopAt: '202611090000' } : {}) },
  }));
  if (events.length !== EXPECTED_IDS.length || events.some((item, index) => item.id !== EXPECTED_IDS[index]))
    throw new Error('RLA proposal requires the complete A1-A15 incident sequence');
  const append = events.find((item) => item.id === 'A8');
  if (!append || !Array.isArray(append.changedFiles) || !append.receiptCosts) throw new Error('RLA proposal requires measured A8 append inputs');
  const policyNode = { node_id: nodeIds.planNodeId, kind: 'gate', recipe: 'cmd:gate-append-recheck-plan', max_visits: 1,
    input: { changedFiles: append.changedFiles, radiusFiles: ['src/ux-sim/proposed-event.test.ts'],
      closureOpaque: append.closureOpaque ?? false,
      receiptCosts: { partialMs: append.receiptCosts.partialMs, fullMs: append.receiptCosts.fullMs, source: 'same-ledger-receipts' } } };
  const branchNodes = [
    { node_id: nodeIds.fullRecheckNodeId, kind: 'gate', recipe: 'cmd:gate', max_visits: 1 },
    { node_id: nodeIds.appendPlanNodeId, kind: 'gate', recipe: 'cmd:gate-same-run-recheck', max_visits: 1 },
    { node_id: nodeIds.appendRunNodeId, kind: 'gate', recipe: 'cmd:gate', max_visits: 1 },
  ];
  const eventNodeId = nodeIds.eventNodeId;
  const eventNode = { node_id: eventNodeId, kind: 'agent', recipe: 'handler:emit-release-gap', max_visits: 1,
    emits: [event.type] };
  const triageNode = nodes.find((node) => node.node_id === event.nodeId)!;
  triageNode.subscribes = [{ event: event.type, match: { nodeId: eventNodeId }, action: 'reroute' }];
  const triageOutcomeEdge = edges.findIndex((edge) => edge.from === event.nodeId && edge.on === 'outcome');
  if (triageOutcomeEdge < 0) throw new Error('release graph proposal requires the real gate-triage outcome edge');
  edges[triageOutcomeEdge] = { from: event.nodeId, on: 'outcome', map: { ok: actionIdForEvent('A1'), fail: 'failed', error: 'failed' } };
  graph.graph_id = 'release-day-0307-proposal';
  graph.entry_node = eventNodeId;
  graph.nodes = [...nodes, ...eventNodes, policyNode, ...branchNodes, eventNode];
  const actionEdges = events.filter((item) => item.id !== 'A15').map((item, index) => {
    if (item.id === 'A8') return { from: actionIdForEvent(item.id), on: 'outcome', map: { ok: policyNode.node_id, fail: 'failed', error: 'failed' } };
    if (item.id === 'A14') return { from: actionIdForEvent(item.id), on: 'outcome', map: { ok: 'approve-publish', fail: 'failed', error: 'failed' } };
    return { from: actionIdForEvent(item.id), on: 'outcome', map: { ok: actionIdForEvent(events[index + 1]!.id), fail: 'failed', error: 'failed' } };
  });
  edges.push(...actionEdges,
    { from: eventNodeId, on: 'outcome', map: { ok: 'failed', fail: 'failed', error: 'failed' } },
    { from: policyNode.node_id, on: 'outcome', map: { 'full-recheck': nodeIds.fullRecheckNodeId, 'append-recheck': nodeIds.appendPlanNodeId, fail: 'failed', error: 'failed' } },
    { from: nodeIds.fullRecheckNodeId, on: 'outcome', map: { ok: actionIdForEvent('A9'), fail: 'failed', error: 'failed' } },
    { from: nodeIds.appendPlanNodeId, on: 'outcome', map: { ok: nodeIds.appendRunNodeId, fail: 'failed', error: 'failed' } },
    { from: nodeIds.appendRunNodeId, on: 'outcome', map: { ok: actionIdForEvent('A9'), fail: 'failed', error: 'failed' } });
  return { graphSource: stringifyYaml(graph) };
}

async function simulateGraphProposal(graphSource: string, runId: string, policy: readonly string[],
  manifest: ReturnType<typeof loadReleaseGraphManifest>, events: readonly ReleaseDay0307ReplayEvent[], nodeIds: ProposalNodeIds, triageNodeId: string,
  dispatchMode: 'accept' | 'ignore' = 'accept', receiptMode: 'valid' | 'foreign' | 'missing' = 'valid') {
  const eventNodeId = nodeIds.eventNodeId;
  const stateRoot = getTestStateRoot();
  if (!stateRoot) throw new Error('graph-definition proposal simulation requires --test isolated mode');
  const commands: string[] = [];
  const proposalRoot = join(stateRoot, `release-day-proposal-${runId}`);
  mkdirSync(proposalRoot, { recursive: true });
  const proposalPath = join(proposalRoot, 'release-proposal.yaml');
  const ledgerRoot = join(proposalRoot, 'ledger');
  const receiptRoot = join(ledgerRoot, 'release/0.3.7/gate-logs/cut/receipts');
  const gateRepo = join(proposalRoot, 'gate-repo');
  mkdirSync(join(gateRepo, 'test'), { recursive: true });
  writeFileSync(join(gateRepo, 'package.json'), JSON.stringify({ name: 'release-recheck-sim', version: '0.3.7' }) + '\n');
  writeFileSync(join(gateRepo, 'bun.lock'), 'lockfileVersion = 1\n');
  const completedFile = 'test/completed.test.ts', stalledFile = 'test/stalled.test.ts';
  writeFileSync(join(gateRepo, completedFile), "import { expect, test } from 'bun:test'; test('completed', () => expect(true).toBe(true));\n");
  writeFileSync(join(gateRepo, stalledFile), "import { expect, test } from 'bun:test'; test('stalled', () => expect(true).toBe(true));\n");
  const git = (args: string[]) => { const result = spawnSync('git', args, { cwd: gateRepo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); };
  git(['init', '-q']); git(['config', 'user.name', 'Release simulation']); git(['config', 'user.email', 'release-sim@example.invalid']);
  git(['add', '.']); git(['commit', '-qm', 'gate recheck baseline']); const gateBase = git(['rev-parse', 'HEAD']);
  writeFileSync(join(gateRepo, 'cut-marker.txt'), 'same-run recheck\n'); git(['add', '.']); git(['commit', '-qm', 'gate recheck cut']);
  const gateHead = git(['rev-parse', 'HEAD']);
  const receiptFixture = writeSameRunReplayReceiptFixture(receiptRoot, runId, gateHead, gateBase);
  const universeRoot = join(proposalRoot, 'universe');
  mkdirSync(join(universeRoot, 'release/0.3.6'), { recursive: true });
  writeFileSync(join(universeRoot, 'release/0.3.6/release.json'), JSON.stringify({ sourceCommit: gateBase }));
  writeFileSync(proposalPath, graphSource);
  for (const file of ['release-loop.yaml', 'recipes.yaml', 'release-graph.schema.yaml', 'release-edge-vocabulary.yaml', 'release-gate-domain-pack.yaml'])
    copyFileSync(join(REPO_ROOT, 'graphs/release', file), join(proposalRoot, file));
  const plugin = asRecord(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')), 'release graph plugin');
  const extensions = asRecord(plugin.extensions, 'plugin extensions');
  const elanous = asRecord(extensions['ai.elanous'], 'Elanous plugin extension');
  const graphs = Array.isArray(elanous.graphs) ? elanous.graphs as string[] : [];
  elanous.graphs = [...graphs, './release-proposal.yaml'];
  const graphManifests = asRecord(elanous.graphManifests, 'graph manifests');
  const proposalManifest = asRecord(graphManifests['release-loop'], 'release-loop graph manifest');
  const proposalAllow = asRecord(proposalManifest.allow, 'release-loop graph allowlist');
  const allowedRecipes = Array.isArray(proposalAllow.recipes) ? proposalAllow.recipes as string[] : [];
  graphManifests['release-day-0307-proposal'] = { ...proposalManifest,
    allow: { ...proposalAllow, recipes: [...allowedRecipes, 'handler:emit-release-gap'] } };
  writeFileSync(join(proposalRoot, 'plugin.json'), `${JSON.stringify(plugin, null, 2)}\n`);
  try {
    const reroutes: Array<{ source: string; nodeId: string; event: string }> = [];
    const state = await runGraph(proposalPath, { runId, input: { version: '0.3.7', previousVersion: '0.3.6', policyOverrides: {
    'gate.plan.promoteToFull': [...policy],
  } }, pinChildUniverse: true, quiet: true, deps: { root: join(stateRoot, `proposal-${runId}`),
    inProcessHandlers: { 'emit-release-gap': async (context) => {
      await context.emitEvent?.('release.gate.receipt-gap-observed', { rationale: 'same-run receipt gap was observed in the simulated gate' });
      return { ok: true, outcome: 'ok', evidence: { eventEmitted: true } };
    } },
    dispatchGraphSubscription: async (dispatch) => {
      if (dispatch.action === 'reroute' && dispatchMode === 'accept' && dispatch.proposeEdge) {
        const result = await dispatch.proposeEdge({ from: dispatch.event.source.nodeId ?? '', to: dispatch.nodeId,
          triggerEvent: dispatch.event.type, rationale: 'replay proves the observed receipt-gap reroute through the real runner' });
        if (result.disposition === 'added') reroutes.push({ source: dispatch.event.source.nodeId ?? '',
          nodeId: dispatch.nodeId, event: dispatch.event.type });
      }
    },
    runBash: async (command, options) => {
      commands.push(command);
      if (command.includes('gate-append-recheck-plan-node.ts')) {
        const env = { ...process.env, ...options?.env };
        const actual = spawnSync('bun', ['scripts/release-loop/gate-append-recheck-plan-node.ts'], {
          cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000,
        });
        return { stdout: actual.stdout ?? '', stderr: actual.stderr ?? '', exitCode: actual.status ?? 1 };
      }
      const contextSource = options?.env?.ELANOUS_GRAPH_CONTEXT;
      const context = contextSource ? JSON.parse(contextSource.trimStart().startsWith('{') ? contextSource : readFileSync(contextSource, 'utf8')) as Record<string, any> : undefined;
      const nodeId = String(context?.nodeId ?? '');
      if (command.includes('gate-same-run-recheck-node.ts')) {
        if (receiptMode === 'missing') rmSync(join(receiptRoot, 'pod-0.receipt.json'), { force: true });
        if (receiptMode === 'foreign') {
          const receiptPath = join(receiptRoot, 'pod-0.receipt.json');
          const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
          receipt.graphRunId = `${runId}-foreign`;
          writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
        }
        const completedFileCount = receiptFixture.completed.files.length;
        const noCompletedFailures = completedFileCount - completedFileCount;
        const gateOutput = { outcome: 'error', summary: 'shard result batch is incomplete', commit: receiptFixture.head40,
          partialSummary: { pass: completedFileCount, fail: noCompletedFailures, errors: noCompletedFailures,
            ran: completedFileCount, files: completedFileCount },
          partialFailures: { failures: [], errors: [] }, preservedShardCount: completedFileCount,
          stalledShards: [{ shard: Number(receiptFixture.stalled.id.slice(4)), files: receiptFixture.stalled.files, reason: 'incomplete' }] };
        const result = prepareSameRunGateRecheck({ runId, nodeId, input: { version: '0.3.7', previousVersion: '0.3.6' },
          outputs: { gate: gateOutput, cutoff: { baseline: { sha: receiptFixture.base40 } } } },
        { repo: gateRepo, roots: [ledgerRoot], ledgerRoot, pinnedImageDigest: () => receiptFixture.imageDigest,
          lockfileHash: () => receiptFixture.lockfileHash, testsAtCommit: () => receiptFixture.allFiles,
          existsAtCommit: () => true, inspect: (input) => stalledGateEvidence({ ...input, expectedTests: () => receiptFixture.allFiles }),
          write: writeRecheckPlan });
        return { stdout: JSON.stringify(result), stderr: '', exitCode: result.outcome === 'ok' ? 0 : 1 };
      }
      if (command.includes('export-check-node.ts')) {
        const exportFixtureRoot = join(proposalRoot, 'export-check-fixture');
        mkdirSync(join(exportFixtureRoot, 'node_modules'), { recursive: true });
        mkdirSync(join(exportFixtureRoot, 'apps/pwa/node_modules'), { recursive: true });
        writeFileSync(join(exportFixtureRoot, 'package.json'), JSON.stringify({ version: '0.3.7' }));
        const result = runExportCheck((binary, args, cwd) => {
          if (binary === 'git' && args[0] === 'worktree' && args[1] === 'add') {
            const source = args.at(-2)!;
            mkdirSync(source, { recursive: true });
            writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '0.3.7' }));
            return { status: 0, stdout: '', stderr: '' };
          }
          if (binary === 'git' && args[0] === 'worktree' && args[1] === 'remove') return { status: 0, stdout: '', stderr: '' };
          if (binary === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
          if (binary === 'bun' && args[0] === 'scripts/public-export.ts') {
            const output = args[args.indexOf('--out') + 1]!;
            mkdirSync(join(output, 'apps/pwa'), { recursive: true });
            return { status: 0, stdout: '', stderr: '' };
          }
          if (binary === 'bun' && args[0] === 'bin/elanous.mjs') {
            mkdirSync(join(cwd ?? '', 'apps/pwa/out'), { recursive: true });
            writeFileSync(join(cwd ?? '', 'apps/pwa/out/index.html'), '<!doctype html>');
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: `unexpected export-check command: ${binary} ${args.join(' ')}` };
        }, exportFixtureRoot, { commit: 'a'.repeat(40), version: '0.3.7' });
        return { stdout: JSON.stringify(result), stderr: '', exitCode: result.outcome === 'ok' ? 0 : 1 };
      }
      if (command.includes('gate-node.ts')) {
        const gateContext = { ...context, runId, outputs: { ...context?.outputs,
          'version-release': { commit: receiptFixture.head40 }, gate: { outcome: 'ok', commit: receiptFixture.head40,
            introduced: [], stalledEnv: [], stalledShards: [], loadFlaky: [] } } };
        const diagnostics: string[] = [];
        const originalError = console.error;
        const previousStateDir = process.env.ELANOUS_STATE_DIR;
        const previousStateDirSource = process.env.ELANOUS_STATE_DIR_SOURCE;
        const gateStateRoot = effectiveInstanceRoot();
        process.env.ELANOUS_STATE_DIR = gateStateRoot;
        process.env.ELANOUS_STATE_DIR_SOURCE = 'explicit';
        console.error = (...values: unknown[]) => diagnostics.push(values.map(String).join(' '));
        let gateExit: number;
        let gateResult: GateResult | undefined;
        const sweptFiles: string[] = [];
        const gateRunner: GateRunner = {
          async command() { return { rc: 0, output: '' }; },
          async localCommand() { return { rc: 0, output: '' }; },
          async sweep(tree, _logDir, _pod, only) {
            const files = only ?? receiptFixture.allFiles;
            sweptFiles.push(...files);
            return { rc: 0, output: files.length + ' pass\n0 fail\n0 errors\nRan ' + files.length + ' tests across ' + files.length + ' files.\n' };
          },
          async add() {}, async remove() {}, async snapshot() {}, async removeSnapshot() {},
        };
        try {
          gateExit = await runGateNode(['--json'], { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(gateContext),
            ELANOUS_INSTANCE_ROOT: gateStateRoot, ELANOUS_STATE_DIR: gateStateRoot, ELANOUS_STATE_DIR_SOURCE: 'explicit' }, gateRunner,
          async (opts, runner, imageProbe) => {
            gateResult = await judgeGate({ ...opts, commit: receiptFixture.head40, baselineCommit: receiptFixture.base40,
              repo: gateRepo, instanceRoot: universeRoot, ledgerRoot, scratchOnly: false, graphRunId: runId },
            runner, imageProbe);
            return gateResult;
          }, () => receiptFixture.imageDigest);
        } finally {
          console.error = originalError;
          if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
          else process.env.ELANOUS_STATE_DIR = previousStateDir;
          if (previousStateDirSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE;
          else process.env.ELANOUS_STATE_DIR_SOURCE = previousStateDirSource;
        }
        return { stdout: JSON.stringify({ outcome: gateExit === 0 ? 'ok' : 'fail', verdict: gateExit === 0 ? 'pass' : 'fail',
          summary: gateResult?.error ?? (gateResult?.outcome === 'ok' ? 'actual gate runtime completed the planned recheck' : 'release gate failed before judge result'), gateResult, sweptFiles, diagnostics }), stderr: '', exitCode: gateExit };
      }
      if (command.includes('hand-response-node.ts')) {
        const action = String(context?.nodeInput?.action ?? '') as Parameters<typeof runHandResponseNode>[0];
        const nodeInput = action === 'cut-append'
          ? { ...context?.nodeInput, action, pickShas: ['c'.repeat(40)], apply: false }
          : { ...context?.nodeInput, action };
        const status = await runHandResponseNode(action, { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ ...context, nodeId: action, nodeInput }) ?? '{}',
          ELANOUS_STATE_DIR: join(proposalRoot, 'universe'), ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_INSTANCE_ROOT: join(proposalRoot, 'universe') },
          { run: () => ({ status: 0, stdout: '{}', stderr: '' }) });
        return { stdout: JSON.stringify({ outcome: status === 0 ? 'ok' : 'error', status, approved: false }), stderr: '', exitCode: status };
      }
      if (command.includes('gate-triage-node.ts')) {
        const triageContext = { ...context, runId, input: { ...context?.input, version: '0.3.7', previousVersion: '0.3.6',
          adaptiveHealVisitState: { gate: 1, gateTriage: 1 } },
          outputs: { ...context?.outputs, gate: { outcome: 'regression', commit: 'a'.repeat(40),
            introduced: ['test/completed.test.ts'], stalledEnv: [], stalledShards: [], loadFlaky: [] } } };
        const env = { ...process.env, ...options?.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(triageContext),
          ELANOUS_STATE_DIR: join(proposalRoot, 'universe'), ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_INSTANCE_ROOT: join(proposalRoot, 'universe') };
        const actual = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 });
        return { stdout: actual.stdout ?? '', stderr: actual.stderr ?? '', exitCode: actual.status ?? 1 };
      }
      return { stdout: '', stderr: `unimplemented simulated recipe command: ${command}`, exitCode: 127 };
    } } });
    const eventPath = state.path.filter((nodeId) => events.some((event) => actionIdForEvent(event.id) === nodeId));
    const hitlPath = state.path.filter((nodeId) => manifest.hitlNodes.includes(nodeId));
    const expectedEventPath = events.map((event) => actionIdForEvent(event.id));
    const recheckResult = (nodeId: string) => {
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      let output: unknown = node?.output;
      if (typeof output === 'string') {
        try { output = JSON.parse(output); } catch { /* preserve non-JSON node output as evidence */ }
      }
      return { nodeId, ok: node?.ok === true, ...(output === undefined ? {} : { output }) };
    };
    return { state, commands, eventPath, hitlPath,
      recheckResult: recheckResult(policy.includes('verdict-files') ? nodeIds.fullRecheckNodeId : nodeIds.appendRunNodeId),
      appendPlanResult: recheckResult(nodeIds.appendPlanNodeId),
      reroutes, pass: state.status === 'awaiting-approval' && reroutes.some((edge) => edge.source === eventNodeId
        && edge.nodeId === triageNodeId && edge.event === 'release.gate.receipt-gap-observed')
        && state.path.includes(triageNodeId) && state.nodes.some((node) => node.nodeId === triageNodeId && node.ok)
        && JSON.stringify(eventPath) === JSON.stringify(expectedEventPath)
        && hitlPath.length === 1 && hitlPath[0] === 'approve-publish' };
  } finally {
    rmSync(proposalRoot, { recursive: true, force: true });
  }
}

/** Replay the publication-day event ledger against the checked-in release graph and its real runner. */
export async function runReleaseDay0307Replay(): Promise<ReleaseDay0307ReplayResult> {
  const scenario = asRecord(parseYaml(readFileSync(SCENARIO_PATH, 'utf8')), 'release-day scenario');
  const events = scenario.events as ReleaseDay0307ReplayEvent[];
  if (!Array.isArray(events)) throw new Error('release-day scenario requires events');
  const manifest = loadReleaseGraphManifest(MANIFEST_PATH);
  const graph = asRecord(parseYaml(readFileSync(GRAPH_PATH, 'utf8')), 'release graph');
  const recipes = asRecord(parseYaml(readFileSync(RECIPES_PATH, 'utf8')), 'release recipes');
  const graphNodeRecords = graph.nodes as Array<Record<string, unknown>>;
  const graphNodes = graphNodeRecords.map((node) => String(node.node_id));
  const graphEdges = graph.edges as Array<Record<string, unknown>>;
  const runId = String(scenario.runId);
  const contractFailures: string[] = [];
  if (scenario.scenario !== 'release-day-0307-replay' || scenario.version !== '0.3.7') contractFailures.push('scenario identity/version mismatch');
  if (events.length !== EXPECTED_IDS.length || events.some((event, index) => event.id !== EXPECTED_IDS[index])) {
    contractFailures.push('the incident sequence must contain A1-A15 exactly once and in order');
  }
  for (const event of events) {
    if (!event.type || !event.action || !event.rationale || !event.binding) contractFailures.push(`${event.id} lacks typed action, binding, or rationale`);
    if (event.runId !== undefined && event.runId !== runId) contractFailures.push(`${event.id} changes the release runId`);
    if (event.mechanism === 'recipe') {
      if (!event.recipe || !Object.hasOwn(recipes, event.recipe)) contractFailures.push(`${event.id} references an undeclared recipe`);
      else {
        try { assertReleaseRecipeAllowed(manifest, event.recipe); }
        catch { contractFailures.push(`${event.id} recipe is outside the release manifest`); }
      }
    } else if (event.mechanism === 'domain-pack' && !manifest.domainPackRules.includes(event.binding)) {
      contractFailures.push(`${event.id} references an undeclared domain-pack rule`);
    } else if (event.mechanism === 'edge' && !manifest.edgeVocabulary.includes(event.binding)) {
      contractFailures.push(`${event.id} references an undeclared graph edge kind`);
    } else if (event.mechanism === 'hitl' && (!manifest.hitlNodes.includes(event.binding) || event.binding !== 'approve-publish')) {
      contractFailures.push(`${event.id} is not the declared publication approval boundary`);
    }
  }
  const nodeForRecipe = (recipe: string) => graphNodeRecords.find((node) => node.recipe === recipe);
  const nodeId = (node: Record<string, unknown> | undefined) => typeof node?.node_id === 'string' ? node.node_id : undefined;
  const edgeOutcomeMap = (from: string | undefined) => {
    const edge = from ? graphEdges.find((candidate) => candidate.from === from && candidate.on === 'outcome') : undefined;
    return edge ? asRecord(edge.map, `edge map from ${from}`) : undefined;
  };
  const releaseGate = graphNodeRecords.find((node) => {
    const notify = node.notify && typeof node.notify === 'object' && !Array.isArray(node.notify)
      ? node.notify as Record<string, unknown> : {};
    return node.recipe === 'cmd:gate' && Array.isArray(notify.on) && notify.on.includes('fail');
  });
  const releaseGateId = nodeId(releaseGate);
  const gateOutcome = edgeOutcomeMap(releaseGateId);
  const cutoverId = typeof gateOutcome?.ok === 'string' ? gateOutcome.ok : undefined;
  const cutoverOutcome = edgeOutcomeMap(cutoverId);
  const receiptAuditId = typeof cutoverOutcome?.audit === 'string' ? cutoverOutcome.audit : undefined;
  const exportCheckId = nodeId(nodeForRecipe('cmd:export-check'));
  const autoApproveId = nodeId(nodeForRecipe('cmd:auto-approve'));
  const autoApproveOutcome = edgeOutcomeMap(autoApproveId);
  const publishApprovalId = typeof autoApproveOutcome?.fail === 'string' && manifest.hitlNodes.includes(autoApproveOutcome.fail)
    ? autoApproveOutcome.fail : undefined;
  const gateNode = releaseGate;
  const gateNeeds = Array.isArray(gateNode?.needs) ? gateNode.needs : [];
  if (exportCheckId && gateNeeds.includes(exportCheckId)) contractFailures.push('gate must remain independent of export-check');
  if (!releaseGateId || !cutoverId || !receiptAuditId) contractFailures.push('the graph must declare a successful gate route through its audit cutover');
  const independentExportCheck = events.find((event) => event.id === 'A7');
  if (!independentExportCheck || independentExportCheck.mechanism !== 'edge' || independentExportCheck.binding !== 'outcome') {
    contractFailures.push('A7 must identify the release graph outcome edge used by the independent gate audit route');
  }

  const mustVisit = [nodeId(nodeForRecipe('cmd:version-release')), nodeId(nodeForRecipe('cmd:traffic-cut-start')),
    nodeId(nodeForRecipe('cmd:cutoff')), releaseGateId, cutoverId, receiptAuditId, autoApproveId, publishApprovalId]
    .filter((value): value is string => Boolean(value));
  const mustNotVisit = [...manifest.hitlNodes.filter((id) => id !== publishApprovalId), nodeId(nodeForRecipe('cmd:npm-publish'))]
    .filter((value): value is string => Boolean(value));
  const graphScenario = stringifyYaml({ version: 1, kind: 'release-graph', id: 'release-day-0307-replay', isolation: 'test',
    input: { version: scenario.version, previousVersion: scenario.previousVersion, graphCutover: 'audit', graphCutoverEvidenceId: 'release-day-0307-sim' },
    cases: [{ id: 'replay', mode: 'baseline', nodeOutcomes: { [autoApproveId ?? 'auto-approve']: { outcome: 'fail' } },
      expect: { status: 'awaiting-approval', mustVisit, mustNotVisit } }] });
  const graphRun = await runReleaseSimRigScenario(graphScenario);
  const graphCase = graphRun.cases.find((item) => item.id === 'replay');
  const graphPath = graphCase?.path ?? [];
  const hitlPath = graphPath.filter((nodeId) => manifest.hitlNodes.includes(nodeId));
  const proposalInput = asRecord(scenario.proposal, 'release-day graph proposal');
  const unseenEvent = { type: String(proposalInput.type ?? ''), nodeId: String(proposalInput.nodeId ?? ''),
    matchNodeId: String(proposalInput.matchNodeId ?? ''), rationale: String(proposalInput.rationale ?? '') };
  const proposalNodes: ProposalNodeIds = {
    eventNodeId: String(proposalInput.eventNodeId ?? ''), planNodeId: String(proposalInput.planNodeId ?? ''),
    fullRecheckNodeId: String(proposalInput.fullRecheckNodeId ?? ''), appendPlanNodeId: String(proposalInput.appendPlanNodeId ?? ''),
    appendRunNodeId: String(proposalInput.appendRunNodeId ?? ''),
  };
  if (!unseenEvent.type || !unseenEvent.nodeId || !unseenEvent.matchNodeId || !unseenEvent.rationale
    || Object.values(proposalNodes).some((value) => !value))
    contractFailures.push('release-day graph proposal must declare event type, node id, and rationale');
  const scenarioPolicies = asRecord(scenario.policies, 'release-day scenario policies');
  const policy = scenarioPolicies['gate.plan.promoteToFull'];
  if (!Array.isArray(policy) || policy.some((value) => typeof value !== 'string'))
    contractFailures.push('release-day scenario must declare gate.plan.promoteToFull');
  const proposal = proposeGraphForUnseenEvent(readFileSync(GRAPH_PATH, 'utf8'), unseenEvent, events, proposalNodes);
  const promotedPolicy = Array.isArray(policy) ? policy as string[] : [];
  const appendPolicy: string[] = [];
  const promotedRun = await simulateGraphProposal(proposal.graphSource, `${runId}-proposed-promoted`, promotedPolicy, manifest, events, proposalNodes, unseenEvent.nodeId);
  const appendRun = await simulateGraphProposal(proposal.graphSource, `${runId}-proposed-append`, appendPolicy, manifest, events, proposalNodes, unseenEvent.nodeId);
  const foreignReceiptRun = await simulateGraphProposal(proposal.graphSource, `${runId}-proposed-foreign-receipt`, appendPolicy, manifest, events, proposalNodes, unseenEvent.nodeId, 'accept', 'foreign');
  const missingReceiptRun = await simulateGraphProposal(proposal.graphSource, `${runId}-proposed-missing-receipt`, appendPolicy, manifest, events, proposalNodes, unseenEvent.nodeId, 'accept', 'missing');
  const rejectedDispatchRun = await simulateGraphProposal(proposal.graphSource, `${runId}-proposed-dispatch-rejected`, appendPolicy, manifest, events, proposalNodes, unseenEvent.nodeId, 'ignore');
  const actionGraph = promotedRun;
  const observedEvents = actionGraph.eventPath.map((nodeId) => events.find((event) => actionIdForEvent(event.id) === nodeId))
    .filter((event): event is ReleaseDay0307ReplayEvent => Boolean(event));
  const eventTrace = observedEvents.map((event, index) => ({ event: 'release.day.0307.intervention' as const, observer: 'RLA' as const,
    runId, sequence: index + 1, id: event.id, action: event.action, rationale: event.rationale, mechanism: event.mechanism }));
  const proposalPass = promotedRun.pass && appendRun.pass && !rejectedDispatchRun.pass
    && !rejectedDispatchRun.state.path.includes(unseenEvent.nodeId)
    && promotedRun.state.path.includes(proposalNodes.fullRecheckNodeId)
    && !promotedRun.state.path.includes(proposalNodes.appendPlanNodeId)
    && appendRun.state.path.includes(proposalNodes.appendPlanNodeId)
    && !appendRun.state.path.includes(proposalNodes.fullRecheckNodeId)
    && promotedRun.state.graphId === appendRun.state.graphId
    && promotedRun.recheckResult.nodeId === proposalNodes.fullRecheckNodeId && promotedRun.recheckResult.ok
    && appendRun.appendPlanResult.nodeId === proposalNodes.appendPlanNodeId && appendRun.appendPlanResult.ok
    && Number((appendRun.appendPlanResult.output as Record<string, unknown> | undefined)?.reusedShardCount) > 0
    && appendRun.recheckResult.nodeId === proposalNodes.appendRunNodeId && appendRun.recheckResult.ok
    && JSON.stringify(promotedRun.recheckResult.output) !== JSON.stringify(appendRun.recheckResult.output)
    && (foreignReceiptRun.appendPlanResult.output as Record<string, unknown> | undefined)?.fullSweepFallback === true
    && (missingReceiptRun.appendPlanResult.output as Record<string, unknown> | undefined)?.fullSweepFallback === true
    && (foreignReceiptRun.appendPlanResult.output as Record<string, unknown> | undefined)?.reusedShardCount === 0
    && (missingReceiptRun.appendPlanResult.output as Record<string, unknown> | undefined)?.reusedShardCount === 0
    && JSON.stringify((foreignReceiptRun.recheckResult.output as Record<string, unknown> | undefined)?.sweptFiles) === JSON.stringify(REPLAY_GATE_FILES)
    && JSON.stringify((missingReceiptRun.recheckResult.output as Record<string, unknown> | undefined)?.sweptFiles) === JSON.stringify(REPLAY_GATE_FILES);
  const graphProposal = { pass: proposalPass, graphSourceSame: true, eventType: unseenEvent.type,
    promotedPath: promotedRun.state.path, appendPath: appendRun.state.path,
    promotedHitlPath: promotedRun.hitlPath, appendHitlPath: appendRun.hitlPath,
    promotedRecheck: promotedRun.recheckResult, appendPlan: appendRun.appendPlanResult, appendRecheck: appendRun.recheckResult,
    foreignReceiptPlan: foreignReceiptRun.appendPlanResult, foreignReceiptRecheck: foreignReceiptRun.recheckResult,
    missingReceiptPlan: missingReceiptRun.appendPlanResult, missingReceiptRecheck: missingReceiptRun.recheckResult };
  if (!proposalPass) contractFailures.push('the same proposed graph must preserve publish HITL while policies alone select different graph-runner paths');
  if (!actionGraph.pass) contractFailures.push('the proposed intervention graph must execute A1-A15 in order and stop at the A15 publish HITL');
  if (graphNodes.length === 0 || !graphCase || graphCase.status !== 'awaiting-approval'
    || !exportCheckId || !graphCase.dispatchedNodes.includes(exportCheckId)) {
    contractFailures.push('the actual release-loop runner did not reach the pre-publish graph and export branch');
  }
  if (hitlPath.length !== 1 || hitlPath[0] !== publishApprovalId) contractFailures.push('the replay must stop at the graph-declared publication approval as its only HITL visit');
  return { pass: graphRun.pass && graphProposal.pass && actionGraph.pass && contractFailures.length === 0, runId, events, eventTrace, graphRun,
    graphPath, hitlPath, actionGraph: { runId: actionGraph.state.runId, status: actionGraph.state.status, path: actionGraph.state.path,
      eventPath: actionGraph.eventPath, commands: actionGraph.commands, hitlPath: actionGraph.hitlPath,
      nodeResults: actionGraph.state.nodes.map((node) => ({ nodeId: node.nodeId, ok: node.ok, output: node.output })), pass: actionGraph.pass },
    proposal: graphProposal, contractFailures };
}

function actionIdForEvent(id: string): string { return id === 'A15' ? 'approve-publish' : `event-${id.toLowerCase()}`; }
