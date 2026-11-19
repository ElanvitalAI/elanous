import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphEventBus, type GraphEvent } from '../graph-runner/graph-events.js';
import { listGraphRuns, runGraph } from '../graph-runner/runner.js';
import { dispatchGraphEventToDeclaredTargets, dispatchSupervisorEventToDeclaredTargets,
  type SupervisorTriggerEvent } from './graph-trigger-dispatch.js';
import { claimGraphTriggerDispatchLease, registerGraphTriggerDispatchBinding,
  releaseGraphTriggerDispatchLease } from './graph-trigger-dispatch-lease.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(eventType = 'demo.ready') {
  const root = mkdtempSync(join(tmpdir(), 'graph-event-trigger-router-'));
  roots.push(root);
  const graphs = join(root, 'graphs');
  mkdirSync(graphs, { recursive: true });
  writeFileSync(join(graphs, 'recipes.yaml'), '{}\n');
  const sourcePath = join(graphs, 'source.yaml');
  writeFileSync(sourcePath, `graph_id: source\nversion: 1\nentry_node: emit\nterminal_nodes: [done]\nnodes:\n  - node_id: emit\n    kind: agent\n    recipe: handler:emit-event\n    max_visits: 1\n    emits: [${eventType}]\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: emit, on: outcome, map: { ok: done } }\n`);
  const bus = createGraphEventBus();
  bus.registerType(eventType);
  const emitted: GraphEvent[] = [];
  bus.subscribe(event => { if (event.type === eventType) emitted.push(event); });
  return { root, graphs, sourcePath, bus, emitted, eventType };
}

function writeTarget(graphs: string, id: string, from: string, on: string) {
  const path = join(graphs, `${id}.yaml`);
  writeFileSync(path, `graph_id: ${id}\nversion: 1\ntriggers:\n  event: { from: ${from}, on: ${on} }\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n`);
}

async function runSource(f: ReturnType<typeof fixture>) {
  return runGraph(f.sourcePath, { runId: 'source-run', eventBus: f.bus, graphEventTriggerRoot: f.root, deps: {
    root: f.root,
    inProcessHandlers: { 'emit-event': async (context) => {
      await context.emitEvent?.(f.eventType, { item: 'one' });
      return { ok: true, outcome: 'ok' };
    } },
  } });
}

test('a published event starts its declared target once and duplicate delivery adds no run', async () => {
  const f = fixture();
  writeTarget(f.graphs, 'target', 'source', 'demo.ready');
  await runSource(f);

  expect(f.emitted).toHaveLength(1);
  const runsAfterRunGraph = listGraphRuns(f.root).runs.filter(run => run.graphId === 'target');
  expect(runsAfterRunGraph).toHaveLength(1);
  expect(runsAfterRunGraph[0]?.status).toBe('done');

  const duplicate = await dispatchGraphEventToDeclaredTargets(f.emitted[0]!, {
    graphRoot: f.root, registryRoot: f.root, stateRoot: f.root,
  });
  expect(duplicate).toHaveLength(1);
  expect(duplicate[0]?.mode).toBeUndefined();
  expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(1);
});

test('one event starts every exact {from,on} match and ignores nonmatching declarations', async () => {
  const f = fixture();
  writeTarget(f.graphs, 'target-a', 'source', 'demo.ready');
  writeTarget(f.graphs, 'target-b', 'source', 'demo.ready');
  writeTarget(f.graphs, 'wrong-source', 'another-graph', 'demo.ready');
  writeTarget(f.graphs, 'wrong-event', 'source', 'demo.other');
  await runSource(f);

  expect(listGraphRuns(f.root).runs.filter(run => run.graphId.startsWith('target-')).map(run => run.graphId).sort())
    .toEqual(['target-a', 'target-b']);
  expect(listGraphRuns(f.root).runs.some(run => run.graphId === 'wrong-source' || run.graphId === 'wrong-event')).toBe(false);
});

test('duplicate declared target IDs refuse delivery before any target starts, then replay after repair', async () => {
  const f = fixture();
  writeTarget(f.graphs, 'target', 'source', 'demo.ready');
  writeFileSync(join(f.graphs, 'duplicate.yaml'), readFileSync(join(f.graphs, 'target.yaml'), 'utf8'));
  await runSource(f);

  expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(0);
  const sourceStatePath = join(f.root, 'graph-runs', 'source', 'source-run.json');
  expect((JSON.parse(readFileSync(sourceStatePath, 'utf8')) as { pendingGraphEvents: GraphEvent[] }).pendingGraphEvents)
    .toHaveLength(1);
  await expect(dispatchGraphEventToDeclaredTargets(f.emitted[0]!, {
    graphRoot: f.root, registryRoot: f.root, stateRoot: f.root,
  })).rejects.toThrow('duplicate graph event target id: target');

  rmSync(join(f.graphs, 'duplicate.yaml'));
  await dispatchGraphEventToDeclaredTargets(f.emitted[0]!, { graphRoot: f.root, registryRoot: f.root, stateRoot: f.root });
  expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(1);
});

test('custom events using lifecycle-like prefixes still route', async () => {
  for (const eventType of ['node-custom', 'release.custom']) {
    const f = fixture(eventType);
    writeTarget(f.graphs, 'target', 'source', eventType);
    await runSource(f);
    expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(1);
  }
});

test('multi-document non-graph YAML does not block declared event routing', async () => {
  const f = fixture();
  writeFileSync(join(f.graphs, 'overlay.yaml'), 'overlay_id: first\n---\noverlay_id: second\n');
  writeTarget(f.graphs, 'target', 'source', 'demo.ready');
  const source = await runSource(f);

  expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(1);
  expect(source.pendingGraphEvents).toEqual([]);
});

test('unreadable or malformed event declarations leave source events pending for replay after repair', async () => {
  const malformedTargets = [
    'graph_id: target\ntriggers: [broken\n',
    'graph_id: target\ntriggers:\n  event: { from: source, on: 42 }\n',
    'graph_id: target\ntriggers:\n  event: [{ from: source, on: demo.ready }]\n',
  ];
  for (const malformedTarget of malformedTargets) {
    const f = fixture();
    const targetPath = join(f.graphs, 'target.yaml');
    writeFileSync(targetPath, malformedTarget);
    await runSource(f);
    expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(0);
    const sourceStatePath = join(f.root, 'graph-runs', 'source', 'source-run.json');
    expect((JSON.parse(readFileSync(sourceStatePath, 'utf8')) as { pendingGraphEvents: GraphEvent[] }).pendingGraphEvents)
      .toHaveLength(1);

    writeTarget(f.graphs, 'target', 'source', 'demo.ready');
    await dispatchGraphEventToDeclaredTargets(f.emitted[0]!, { graphRoot: f.root, registryRoot: f.root, stateRoot: f.root });
    expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(1);
  }
});

const supervisorEvent: SupervisorTriggerEvent = { supervisorId: 'loop:rla@1', targetGraphId: 'release-loop',
  targetRunId: 'release-run', eventId: 'gate-failed-1', type: 'supervisor.complete',
  emittedAt: '2026-11-18T00:00:00.000Z', data: { operation: 'reroute' } };

test('one simulated supervisor event starts its declared target once and redelivery adds no run', async () => {
  const f = fixture();
  writeTarget(f.graphs, 'target', "'loop:rla@1'", 'supervisor.complete');
  writeTarget(f.graphs, 'wrong-supervisor', "'loop:other@1'", 'supervisor.complete');
  writeTarget(f.graphs, 'wrong-type', "'loop:rla@1'", 'supervisor.input_required');
  const options = { graphRoot: f.root, registryRoot: f.root, stateRoot: f.root };

  const first = await dispatchSupervisorEventToDeclaredTargets(supervisorEvent, options);
  expect(first.map(result => [result.registration.graphId, result.claimed, result.mode]))
    .toEqual([['target', true, 'start']]);
  expect(first[0]?.state?.input).toEqual({ supervisorEvent });
  expect(listGraphRuns(f.root).runs.map(run => run.graphId)).toEqual(['target']);

  const duplicate = await dispatchSupervisorEventToDeclaredTargets(supervisorEvent, options);
  expect(duplicate).toHaveLength(1);
  expect(duplicate[0]?.mode).toBeUndefined();
  expect(duplicate[0]?.registration.runId).toBe(first[0]?.registration.runId);
  expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(1);
});

test('supervisor event dispatch waits on a live dispatch lease and runs once after release', async () => {
  const f = fixture();
  writeTarget(f.graphs, 'target', "'loop:rla@1'", 'supervisor.complete');
  const options = { graphRoot: f.root, registryRoot: f.root, stateRoot: f.root };
  const identity = { triggerId: 'event:loop:rla@1:supervisor.complete:target',
    dedupeKey: 'loop:rla@1:release-loop:release-run:gate-failed-1', graphId: 'target' };
  const binding = registerGraphTriggerDispatchBinding(identity, { registryRoot: f.root, stateRoot: f.root });
  const held = claimGraphTriggerDispatchLease({ ...identity, runId: binding.runId }, { registryRoot: f.root, stateRoot: f.root });
  if (!held.claimed) throw new Error('fixture lease was not claimed');

  const blocked = await dispatchSupervisorEventToDeclaredTargets(supervisorEvent, options);
  expect(blocked.map(result => result.claimed)).toEqual([false]);
  expect(listGraphRuns(f.root).runs).toHaveLength(0);

  releaseGraphTriggerDispatchLease(held.lease);
  const released = await dispatchSupervisorEventToDeclaredTargets(supervisorEvent, options);
  expect(released.map(result => [result.claimed, result.mode, result.registration.runId]))
    .toEqual([[true, 'start', binding.runId]]);
  expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'target')).toHaveLength(1);
});

test('supervisor event routing refuses an event without its routing identity', async () => {
  const f = fixture();
  await expect(dispatchSupervisorEventToDeclaredTargets({ ...supervisorEvent, supervisorId: ' ' },
    { graphRoot: f.root, registryRoot: f.root, stateRoot: f.root }))
    .rejects.toThrow('supervisor event routing requires supervisorId');
});
