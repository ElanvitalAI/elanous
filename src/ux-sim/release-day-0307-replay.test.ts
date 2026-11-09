import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadReleaseGraphManifest, assertReleaseRecipeAllowed, bindReleaseGraphInstance } from '../graph-runner/release-graph-manifest.js';
import { type GraphRunState } from '../graph-runner/runner.js';
import { runHandResponseNode } from '../../scripts/release-loop/hand-response-node.js';
import { selectGateAppendRecheckEdge } from '../../scripts/release-loop/gate-partial.js';
import { releaseResumeGateWaiverCoverage } from '../../scripts/release-loop/resume.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runReleaseDay0307Replay } from './release-day-0307-replay.js';

const REPO_ROOT = join(import.meta.dir, '../..');
const SCENARIO_PATH = join(REPO_ROOT, 'scenarios/ux-sim/release-day-0307-replay.yaml');
const MANIFEST_PATH = join(REPO_ROOT, 'graphs/release/plugin.json');

test('RELEASE-GRAPH-ABSORB-ALL: release-day replay stays in declared recipes, policies, graph edges and HITL', async () => {
  const scenario = parseYaml(readFileSync(SCENARIO_PATH, 'utf8')) as {
    scenario: string; runId: string;
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
    expect(replay.pass).toBe(true);
    expect(replay.runId).toBe(scenario.runId);
    expect(replay.events.map(({ id }) => id)).toEqual(Array.from({ length: 15 }, (_, index) => `A${index + 1}`));
    expect(replay.eventTrace).toHaveLength(15);
    expect(replay.eventTrace.every(({ observer, runId, rationale }) => observer === 'RLA' && runId === replay.runId && rationale.length > 0)).toBe(true);
    expect(replay.graphRun.pass).toBe(true);
    expect(replay.graphPath).toContain('approve-publish');
    expect(replay.hitlPath).toEqual(['approve-publish']);
    expect(replay.contractFailures).toEqual([]);
  } finally {
    if (previousTestRoot === undefined) setTestStateRoot(null);
    else setTestStateRoot(previousTestRoot);
    rmSync(replayRoot, { recursive: true, force: true });
  }
  expect(manifest.graph).toBe('release-loop');
  expect(manifest.identity).toBe('elanous-0.x-release');
  expect(manifest.inputs).toEqual(['manual', 'release.cut.due']);
  expect(manifest.hitlNodes).toEqual(['approve-publish', 'approve-continue', 'gate-repair-recovery', 'gate-heal-decision']);
  expect(manifest.domainPackRules.filter((id) => id.startsWith('release-gate:'))).toHaveLength(6);
  expect(manifest.domainPackRules).toContain('release-gate:fail-unmeasured-disjoint');
  expect(manifest.edgeVocabulary).toEqual(['outcome', 'heal', 'retry', 'detour', 'rejoin', 'append-recheck', 'accept', 'escalate']);
  expect(manifest.terminalStates).toEqual(['done', 'failed']);
  for (const recipe of manifest.recipes) assertReleaseRecipeAllowed(manifest, recipe);
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
