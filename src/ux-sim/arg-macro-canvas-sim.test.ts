import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createGraphEventBus, type GraphEvent } from '../graph-runner/graph-events.js';
import { decideGraphApproval, runGraph, type GraphRunOptions } from '../graph-runner/runner.js';
import { createMacrophageRuntime } from '../release-loop/macrophage-heal-node.js';
import { runMacrophageHeal } from '../release-loop/macrophage-heal.js';
import { planMacrophageIncident } from '../release-loop/macrophage-incident-recovery.js';
import { planMacrophageRepairLadder } from '../release-loop/macrophage-repair-ladder.js';
import { classifyGateShadow } from '../../scripts/release-loop/gate-triage-node.js';
import { runArgMacroCanvasRig } from './release-sim-rig.js';
import type { ArgMacroCanvasIncident, ArgMacroCanvasManifest } from './arg-macro-canvas-sim.js';

type Scenario = {
  canvas: { graph: string; macrophage: string; graphId: string; runId: string };
  inject: { failureId: string; commit: string };
  expect: {
    declared: { gateFailure: string; macrophageWake: { event: string; nodeId: string; action: string }; argReturn: string };
    macrophage: { sourceNode: string; signature: string };
    path: { beforeResume: string[]; afterResume: string[] };
  };
};

function appearsInOrder(actual: readonly string[], expected: readonly string[]): boolean {
  let cursor = 0;
  for (const nodeId of expected) {
    const position = actual.indexOf(nodeId, cursor);
    if (position < 0) return false;
    cursor = position + 1;
  }
  return true;
}

test('declared canvas path order rejects a missing first node', () => {
  expect(appearsInOrder(['emergency-switch', 'gate-triage'], ['gate', 'emergency-switch', 'gate-triage'])).toBe(false);
});

test('ARG and macrophage follow the declared release canvas through append and same-run re-gate', async () => {
  const repoRoot = join(import.meta.dir, '../..');
  const scenario = parseYaml(readFileSync(join(repoRoot, 'scenarios/ux-sim/arg-macro-canvas.yaml'), 'utf8')) as Scenario;
  const graphPath = join(repoRoot, scenario.canvas.graph);
  const graph = parseYaml(readFileSync(graphPath, 'utf8')) as {
    edges: Array<{ from: string; on: string; map?: Record<string, string> }>;
  };
  const subscriber = parseYaml(readFileSync(join(repoRoot, scenario.canvas.macrophage), 'utf8')) as {
    nodes: Array<{ node_id: string; subscribes?: Array<{ event: string; match?: { nodeId?: string; ok?: boolean }; action: string }> }>;
  };
  const gateEdge = graph.edges.find((edge) => edge.from === 'gate' && edge.on === 'outcome');
  const gateFailureRoute = gateEdge?.map?.fail;
  const argAppendNode = scenario.expect.path.beforeResume.at(-1)!;
  const normalEmergencyRoute = graph.edges.find((edge) => edge.from === gateFailureRoute && edge.on === 'outcome');
  expect(gateFailureRoute).toBe('emergency-switch');
  expect(normalEmergencyRoute?.map?.['stay-normal']).toBe(argAppendNode);
  expect(scenario.expect.declared.gateFailure).toBe(argAppendNode);
  const wake = subscriber.nodes.flatMap((node) => node.subscribes ?? []).find((item) =>
    item.event === scenario.expect.declared.macrophageWake.event && item.match?.ok === false);
  expect(wake?.action).toBe(scenario.expect.declared.macrophageWake.action);

  const root = mkdtempSync(join(tmpdir(), 'arg-macro-canvas-'));
  const bus = createGraphEventBus();
  const events: GraphEvent[] = [];
  bus.subscribe((event) => { if (event.graphId === scenario.canvas.graphId && event.runId === scenario.canvas.runId) events.push(event); });
  const macrophage = createMacrophageRuntime({ root, runId: scenario.canvas.runId, graphId: scenario.canvas.graphId,
    eventBus: bus, mode: 'simulation', inventory: () => [] });
  let gateVisits = 0;
  let repairVisits = 0;
  const failure = scenario.inject.failureId;
  const commit = scenario.inject.commit;
  const failedGate = { outcome: 'regression' as const, commit, introduced: [failure], preexisting: 0,
    fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
  const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (command, opts) => {
    if (command.includes('gate-node.ts --json')) {
      gateVisits++;
      return gateVisits === 1
        ? { exitCode: 1, stdout: JSON.stringify(failedGate), stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit, introduced: [] }), stderr: '' };
    }
    if (command.includes('gate-triage-node.ts')) {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
      return { exitCode: 0, stdout: JSON.stringify({ ...classifyGateShadow(failedGate),
        gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
    }
    if (command.includes('gate-repair-node.ts')) {
      repairVisits++;
      return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail' }), stderr: 'injected repair failure' };
    }
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
  };
  const input = { version: '0.3.9', previousVersion: '0.3.8', gateExecutor: 'pod' };
  try {
    const first = await runGraph(graphPath, { runId: scenario.canvas.runId, input, eventBus: bus,
      deps: { root, runBash, releaseGraphEventAdapters: true }, quiet: true });
    await bus.flush({ graphId: scenario.canvas.graphId, runId: scenario.canvas.runId });
    expect(first.status).toBe('awaiting-approval');
    expect(first.pending?.nodeId).toBe('gate-heal-decision');
    const repairNode = first.path.find((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId));
    expect(repairNode).toBeDefined();
    expect(appearsInOrder(first.path, [scenario.expect.path.beforeResume[0]!, gateFailureRoute!, ...scenario.expect.path.beforeResume.slice(1)])).toBe(true);
    expect(first.adaptiveGateNodeAppends?.[0]?.request).toMatchObject({ graphId: scenario.canvas.graphId,
      runId: scenario.canvas.runId, afterNodeId: argAppendNode,
      resumeFrom: repairNode, rerunGateAt: scenario.expect.declared.argReturn });
    expect(first.subscriptionGraphAppends?.[0]?.proposal).toMatchObject({ entryNodeId: repairNode,
      returnTo: scenario.expect.declared.argReturn });
    const decision = macrophage.decisions.find((event) => event.data?.sourceNodeId === scenario.expect.macrophage.sourceNode);
    expect(decision?.data).toMatchObject({ failureSignature: scenario.expect.macrophage.signature,
      phaseNodeId: scenario.expect.macrophage.sourceNode });
    const source = events.find((event) => event.eventId === decision?.data?.sourceEventId);
    expect(source).toMatchObject({ type: 'node-end', source: { kind: 'node', nodeId: scenario.expect.declared.macrophageWake.nodeId },
      data: { ok: false } });
    expect(source!.sequence).toBeLessThan(decision!.sequence);

    decideGraphApproval(scenario.canvas.graphId, scenario.canvas.runId, 'approved', 'sim-test', root);
    const resumed = await runGraph(graphPath, { resumeRunId: scenario.canvas.runId,
      input, eventBus: bus, deps: { root, runBash, releaseGraphEventAdapters: true }, quiet: true });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(expect.arrayContaining(scenario.expect.path.afterResume));
    expect(resumed.path.lastIndexOf(scenario.expect.path.afterResume[0]!)).toBeLessThan(
      resumed.path.lastIndexOf(scenario.expect.path.afterResume[1]!));
    expect(resumed.adaptiveGateNodeAppends?.[0]?.request.eventId).toBe(first.adaptiveGateNodeAppends?.[0]?.request.eventId);
    expect(repairVisits).toBe(1);
  } finally {
    macrophage.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

const fiveIncidentScenario = parseYaml(readFileSync(join(import.meta.dir, '../../scenarios/ux-sim/arg-macro-canvas.yaml'), 'utf8')) as {
  manifest: ArgMacroCanvasManifest;
  cases: Array<ArgMacroCanvasIncident & { id: string; simulatedTerminal: 'healed' | 'hitl'; expect: {
    macrophageAction: string; policy: { label: string; step: string }; ladder: { action: string; step: string };
  } }>;
};

for (const item of fiveIncidentScenario.cases) {
  test(`ARG macrophage canvas ${item.id}: runner executes simulator proposal or disposition`, async () => {
    const runId = `sim-arg-macro-${item.id}`;
    const macrophage = runMacrophageHeal({ phase: 'idle', mode: 'simulation', now: new Date('2026-11-08T00:00:00.000Z'),
      consecutiveFailureLimit: 3, inventory: [item.scrap] });
    const action = macrophage.events.find((event) => event.id === item.id)?.action;
    const policy = planMacrophageIncident(item.signal);
    const ladder = planMacrophageRepairLadder({ ...item.ladder, runId, signature: item.signal.signature });
    expect(action).toBe(item.expect.macrophageAction);
    expect({ label: policy.label, step: policy.step }).toEqual(item.expect.policy);
    expect({ action: ladder.action, step: ladder.step }).toEqual(item.expect.ladder);
    const result = runArgMacroCanvasRig({ runId, manifest: fiveIncidentScenario.manifest, incidents: [item],
      now: new Date('2026-11-08T00:00:00.000Z') });
    expect(result.ledger[0]?.detail).toBe(`${item.expect.macrophageAction}:${item.expect.policy.label}:${item.expect.ladder.step}`);
    const append = result.appended.find((row) => row.incidentId === item.id);
    if (item.simulatedTerminal === 'healed') {
      expect(append).toBeDefined();
      expect(append?.afterNodeId).toBe(item.afterNodeId);
      expect(result.graph.nodes).toEqual(append?.proposal.nodes);
      expect(result.graph.edges).toContainEqual({ from: item.afterNodeId, to: append?.proposal.entryNodeId });
      expect(result.graph.edges).toContainEqual(append?.proposal.edges[0]);
      expect(result.graph.nodes[0]?.recipe).toBe(item.recipe);
      expect(append?.proposal.edges[0]?.map).toEqual({ ok: fiveIncidentScenario.manifest.rejoinNode,
        fail: fiveIncidentScenario.manifest.hitlNode, error: fiveIncidentScenario.manifest.hitlNode });
      expect(append?.proposal.returnTo).toBe(fiveIncidentScenario.manifest.rejoinNode);
      expect(result.ledger.map((row) => row.event)).toEqual(['macrophage.classified', 'graph.edge-added',
        'graph.recipe-simulated', 'graph.rejoin']);
    } else {
      expect(append).toBeUndefined();
      expect(result.graph).toEqual({ nodes: [], edges: [{ from: item.afterNodeId, to: fiveIncidentScenario.manifest.hitlNode }] });
      expect(result.ledger.map((row) => row.event)).toEqual(['macrophage.classified', 'graph.policy-denied',
        'graph.edge-added', 'graph.escalate']);
      expect(result.ledger.some((row) => row.event === 'graph.recipe-simulated')).toBe(false);
    }
    expect(result.simulatedTerminal[item.id]).toBe(item.simulatedTerminal);
    expect(result.ledger.every((row) => row.runId === runId && row.graphId === fiveIncidentScenario.manifest.graphId
      && row.edgeRef === fiveIncidentScenario.manifest.edgeRef && row.eventId === result.ledger[0]?.eventId)).toBe(true);

    const root = mkdtempSync(join(tmpdir(), `arg-macro-runner-${item.id}-`));
    const graph = join(root, 'graph.yaml');
    const graphId = `arg-macro-runner-${item.id}`;
    writeFileSync(join(root, 'recipes.yaml'), [
      'release-gate:', '  command: "exit 1"', 'macrophage-triage:', '  command: "exit 0"',
      'repair-recovery:', '  approval: "review the simulator-classified incident before resuming?"',
      ...fiveIncidentScenario.manifest.appendRecipes.flatMap((recipe) => [
        `${recipe.slice('cmd:'.length)}:`, '  command: "exit 0"',
      ]), '',
    ].join('\n'));
    writeFileSync(graph, [
      `graph_id: ${graphId}`, 'version: 1', 'entry_node: gate',
      'terminal_nodes: [done, failed]', 'nodes:',
      '  - node_id: gate', '    kind: agent', '    recipe: handler:release-gate', '    max_visits: 2',
      '    emits: [release.gate.failed]',
      '  - node_id: gate-triage', '    kind: agent', '    recipe: handler:macrophage-triage', '    max_visits: 1',
      '    subscribes:', '      - event: release.gate.failed', '        match: { nodeId: gate }', '        action: reroute',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: gate-repair-recovery, kind: hitl, recipe: "approval:repair-recovery", max_visits: 1 }',
      'edges:',
      '  - from: gate', '    on: outcome', '    map: { ok: done, fail: failed }',
      '  - from: gate-triage', '    on: outcome', '    map: { ok: gate, fail: gate-repair-recovery }', '',
    ].join('\n'));
    const eventBus = createGraphEventBus();
    eventBus.registerType('release.gate.failed');
    const dispositionEdge = result.graph.edges.find((edge) => edge.from === item.afterNodeId);
    const triageOutcome = dispositionEdge?.to === fiveIncidentScenario.manifest.hitlNode ? 'fail' : 'ok';
    let gateVisits = 0;
    const appendDispositions: string[] = [];
    const edgeDispositions: string[] = [];
    try {
      const state = await runGraph(graph, { runId, input: { incidentId: item.id }, eventBus,
        deps: {
          root,
          inProcessHandlers: {
            'release-gate': async (context) => {
              gateVisits++;
              if (gateVisits === 1) {
                await context.emitEvent?.('release.gate.failed', { incidentId: item.id });
                return { ok: false, outcome: 'fail' };
              }
              return { ok: true, outcome: 'ok' };
            },
            'macrophage-triage': async () => ({ ok: triageOutcome === 'ok', outcome: triageOutcome }),
          },
          dispatchGraphSubscription: async (dispatch) => {
            if (dispatch.nodeId !== 'gate-triage' || dispatch.event.type !== 'release.gate.failed') return;
            if (!dispatch.proposeEdge) throw new Error('runner did not provide its adaptive edge API');
            const edge = await dispatch.proposeEdge({ from: 'gate', to: 'gate-triage',
              triggerEvent: dispatch.event.type, rationale: `simulator disposition for ${item.id}` });
            edgeDispositions.push(edge.disposition);
            if (append) {
              if (!dispatch.appendGraph) throw new Error('runner did not provide its append API');
              const appended = await dispatch.appendGraph(append.proposal);
              appendDispositions.push(appended.disposition);
            }
          },
        }, quiet: true });
      expect(edgeDispositions).toEqual(['added']);
      expect(state.path).toContain('gate-triage');
      expect(state.adaptiveGraphEdges).toMatchObject([{ from: 'gate', to: 'gate-triage', triggerEvent: 'release.gate.failed' }]);
      if (item.simulatedTerminal === 'healed') {
        expect(appendDispositions).toEqual(['appended']);
        expect(state.path).toContain(append!.proposal.entryNodeId);
        expect(state.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(2);
        expect(state.status).toBe('done');
      } else {
        expect(appendDispositions).toEqual([]);
        expect(state.path).toContain(fiveIncidentScenario.manifest.hitlNode);
        expect(state.status).toBe('awaiting-approval');
        expect(gateVisits).toBe(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('ARG macrophage runner routes an executed repair failure to recovery HITL', async () => {
  const item = fiveIncidentScenario.cases.find((candidate) => candidate.id === 'parked-pr')!;
  const runId = 'sim-arg-macro-repair-failure';
  const result = runArgMacroCanvasRig({ runId, manifest: fiveIncidentScenario.manifest, incidents: [item],
    now: new Date('2026-11-08T00:00:00.000Z') });
  const append = result.appended.find((row) => row.incidentId === item.id)!;
  const root = mkdtempSync(join(tmpdir(), 'arg-macro-repair-failure-'));
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), [
    'repair-recovery:', '  approval: "review the failed repair before resuming?"',
    'parked-pr-repair:', '  command: "exit 0"', '',
  ].join('\n'));
  writeFileSync(graph, [
    'graph_id: arg-macro-repair-failure', 'version: 1', 'entry_node: gate', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - node_id: gate', '    kind: agent', '    recipe: handler:release-gate', '    max_visits: 2', '    emits: [release.gate.failed]',
    '  - node_id: gate-triage', '    kind: agent', '    recipe: handler:macrophage-triage', '    max_visits: 1',
    '    subscribes:', '      - event: release.gate.failed', '        match: { nodeId: gate }', '        action: reroute',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: gate-repair-recovery, kind: hitl, recipe: "approval:repair-recovery", max_visits: 1 }',
    'edges:', '  - from: gate', '    on: outcome', '    map: { ok: done, fail: failed }',
    '  - from: gate-triage', '    on: outcome', '    map: { ok: gate, fail: gate-repair-recovery }', '',
  ].join('\n'));
  const eventBus = createGraphEventBus();
  eventBus.registerType('release.gate.failed');
  let gateVisits = 0;
  try {
    const state = await runGraph(graph, { runId, eventBus, deps: {
      root,
      inProcessHandlers: {
        'release-gate': async (context) => {
          gateVisits++;
          if (gateVisits === 1) {
            await context.emitEvent?.('release.gate.failed', { incidentId: item.id });
            return { ok: false, outcome: 'fail' };
          }
          return { ok: true, outcome: 'ok' };
        },
        'macrophage-triage': async () => ({ ok: true, outcome: 'ok' }),
      },
      runBash: async () => ({ exitCode: 1, stdout: '{"outcome":"fail"}', stderr: 'simulated repair failure' }),
      dispatchGraphSubscription: async (dispatch) => {
        if (dispatch.nodeId !== 'gate-triage' || dispatch.event.type !== 'release.gate.failed') return;
        const edge = await dispatch.proposeEdge?.({ from: 'gate', to: 'gate-triage',
          triggerEvent: dispatch.event.type, rationale: 'runner verifies the repair-failure route' });
        expect(edge?.disposition).toBe('added');
        const appended = await dispatch.appendGraph?.(append.proposal);
        expect(appended?.disposition).toBe('appended');
      },
    }, quiet: true });
    expect(state.path).toContain(append.proposal.entryNodeId);
    expect(state.path).toContain(fiveIncidentScenario.manifest.hitlNode);
    expect(state.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(1);
    expect(state.status).toBe('awaiting-approval');
    expect(gateVisits).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('incidents at one source cannot create conflicting unconditional graph edges in a shared run', () => {
  expect(() => runArgMacroCanvasRig({ runId: 'sim-arg-macro-five-incidents', manifest: fiveIncidentScenario.manifest,
    incidents: fiveIncidentScenario.cases, now: new Date('2026-11-08T00:00:00.000Z') }))
    .toThrow('ARG canvas incidents sharing gate-triage require separate graph runs');
});

test('manifest denies an unlisted recipe or excess depth before node append', () => {
  const scenario = parseYaml(readFileSync(join(import.meta.dir, '../../scenarios/ux-sim/arg-macro-canvas.yaml'), 'utf8')) as {
    manifest: ArgMacroCanvasManifest;
    cases: Array<ArgMacroCanvasIncident & { id: string }>;
  };
  const incident = scenario.cases.find((item) => item.id === 'parked-pr')!;
  for (const [reason, manifest, candidate] of [
    ['recipe', { ...scenario.manifest, allowRecipes: [] }, incident],
    ['depth', scenario.manifest, { ...incident, depth: scenario.manifest.maxDepth + 1 }],
  ] as const) {
    const result = runArgMacroCanvasRig({ runId: `sim-arg-macro-denied-${reason}`,
      manifest, incidents: [candidate] });
    expect(result.appended).toEqual([]);
    expect(result.graph).toEqual({ nodes: [], edges: [{ from: incident.afterNodeId, to: manifest.hitlNode }] });
    expect(result.simulatedTerminal[incident.id]).toBe('hitl');
    expect(result.ledger.map((row) => row.event)).toEqual(['macrophage.classified', 'graph.manifest-denied',
      'graph.edge-added', 'graph.escalate']);
  }
});
