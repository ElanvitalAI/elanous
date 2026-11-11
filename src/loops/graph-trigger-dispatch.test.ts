import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphEventBus, type GraphEvent } from '../graph-runner/graph-events.js';
import { listGraphRuns, runGraph } from '../graph-runner/runner.js';
import { dispatchGraphEventToDeclaredTargets } from './graph-trigger-dispatch.js';

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
