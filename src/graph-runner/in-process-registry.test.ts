import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function graphFixture(secondRecipe = 'none'): { root: string; graph: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-handler-registry-'));
  roots.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, `graph_id: handler-registry\nversion: 1\nentry_node: readiness\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: readiness, kind: agent, recipe: 'handler:readiness', max_visits: 1 }\n  - { node_id: later, kind: agent, recipe: '${secondRecipe}', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: readiness, on: outcome, map: { full: done, fail: failed } }\n  - { from: later, on: outcome, map: { ok: done, fail: failed } }\n`);
  return { root, graph };
}

test('runGraph dispatches a registered in-process recipe and persists its named outcome', async () => {
  const { root, graph } = graphFixture();
  const called: string[] = [];
  const state = await runGraph(graph, { input: { substrate: 'local' }, deps: {
    root,
    runBash: async () => { throw new Error('handler escaped to shell'); },
    inProcessHandlers: { readiness: async (context) => {
      called.push(`${context.graphId}/${context.nodeId}/${context.runId}`);
      expect(context.input).toEqual({ substrate: 'local' });
      return { ok: true, outcome: 'full', evidence: { reason: 'observed' } };
    } },
  } });
  expect(called).toHaveLength(1);
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['readiness', 'done']);
  expect(state.nodes[0]).toMatchObject({ nodeId: 'readiness', ok: true, executed: true });
  expect(JSON.parse(state.nodes[0]!.output as string)).toMatchObject({ outcome: 'full', evidence: { reason: 'observed' } });
});

test('unknown in-process recipe rejects before any handler executes', async () => {
  const { root, graph } = graphFixture('handler:missing');
  let calls = 0;
  await expect(runGraph(graph, { deps: { root, inProcessHandlers: { readiness: async () => {
    calls++;
    return { ok: true, outcome: 'full' };
  } } } })).rejects.toThrow('unknown in-process handler for later: missing');
  expect(calls).toBe(0);
});

test('malformed handler recipe is rejected before execution', async () => {
  const { root, graph } = graphFixture('handler:Bad_Name');
  await expect(runGraph(graph, { deps: { root, inProcessHandlers: { readiness: async () =>
    ({ ok: true, outcome: 'full' }) } } })).rejects.toThrow('invalid in-process handler recipe');
});

test('an explicit failed handler result persists the failure and follows its named edge', async () => {
  const { root, graph } = graphFixture();
  const state = await runGraph(graph, { deps: { root, inProcessHandlers: {
    readiness: async () => ({ ok: false, outcome: 'fail', error: 'not-ready' }),
  } } });
  expect(state.status).toBe('failed');
  expect(state.path).toEqual(['readiness', 'failed']);
  expect(state.nodes[0]).toMatchObject({ nodeId: 'readiness', ok: false, exit: 1,
    error: 'not-ready', failure: { errorCode: 'GRAPH_NODE_FAILED' } });
});

test('a throwing handler records a failed node and follows the declared failure edge', async () => {
  const { root, graph } = graphFixture();
  const state = await runGraph(graph, { deps: { root, inProcessHandlers: {
    readiness: async () => { throw new Error('probe unavailable'); },
  } } });
  expect(state.status).toBe('failed');
  expect(state.path).toEqual(['readiness', 'failed']);
  expect(state.nodes[0]).toMatchObject({ nodeId: 'readiness', ok: false, executed: true,
    error: 'probe unavailable', failure: { errorCode: 'GRAPH_NODE_FAILED' } });
  expect(JSON.parse(state.nodes[0]!.output as string)).toMatchObject({ outcome: 'fail' });
});
