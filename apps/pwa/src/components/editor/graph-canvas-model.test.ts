import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalGraphJson, parseGraphTemplateYaml } from '../../../../../src/self-implement/graph-yaml';
import { CORE_GRAPH_KINDS } from '@/lib/run-graph-yaml-edit';
import {
  addNode,
  connect,
  defaultOutcome,
  emptyGraph,
  failTarget,
  fromYaml,
  isBackEdge,
  mapServerIssues,
  removeNode,
  setEntry,
  setFailTarget,
  setTerminal,
  terminalNodes,
  toYaml,
  updateNode,
  validateGraph,
  type CanvasGraph,
} from './graph-canvas-model';
import { saveCanvasGraph, type CanvasSaveClient } from './graph-canvas-save';
import { NexusApiError } from '@/nexus/client';

function threeNodeLine(): CanvasGraph {
  let graph = emptyGraph('cge-demo');
  graph = addNode(graph, { kind: 'agent', id: 'A' }).graph;
  graph = addNode(graph, { kind: 'gate', id: 'B' }).graph;
  graph = addNode(graph, { kind: 'observe', id: 'C' }).graph;
  graph = connect(graph, 'A', 'B');
  return setTerminal(connect(graph, 'B', 'C'), 'C', true);
}

describe('graph canvas model (CGE-EDIT)', () => {
  test('judgment: A→B→C built from an empty canvas validates locally and through the harness loader', () => {
    const graph = threeNodeLine();
    expect(graph.entry).toBe('A');
    expect(terminalNodes(graph)).toEqual(['C']);
    expect(validateGraph(graph, CORE_GRAPH_KINDS)).toEqual({ ok: true, issues: [] });

    const yaml = toYaml(graph);
    const loaded = parseGraphTemplateYaml(yaml);
    expect(loaded.errors).toEqual([]);
    expect(loaded.template?.graphId).toBe('cge-demo');
    expect(loaded.template?.entryNode).toBe('A');
    expect(loaded.template?.terminalNodes).toEqual(['C']);
    expect(loaded.template?.nodes.map((node) => [node.nodeId, node.kind])).toEqual([['A', 'agent'], ['B', 'gate'], ['C', 'observe']]);
    expect(loaded.template?.edges).toEqual([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }]);
  });

  test('outcome edges serialize as one on/map edge per source and round-trip back onto the canvas', () => {
    let graph = threeNodeLine();
    graph = { ...graph, edges: graph.edges.filter((edge) => edge.from !== 'B') };
    graph = connect(graph, 'B', 'C', 'pass');
    graph = connect(graph, 'B', 'A', 'fail');
    const yaml = toYaml(graph);
    expect(parseGraphTemplateYaml(yaml).errors).toEqual([]);
    expect(parseYaml(yaml).edges).toEqual([{ from: 'A', to: 'B' }, { from: 'B', on: 'outcome', map: { pass: 'C', fail: 'A' } }]);
    const back = fromYaml(yaml);
    expect(back.edges).toEqual(graph.edges);
    expect(back.nodes.map((node) => [node.id, node.x])).toEqual([['A', 40], ['B', 300], ['C', 560]]);
  });

  test('negative: a dangling edge fails locally and in the harness loader, pinned to its source node', () => {
    const graph: CanvasGraph = { ...threeNodeLine(), edges: [...threeNodeLine().edges, { from: 'C', to: 'ghost', outcome: '' }] };
    const local = validateGraph(graph, CORE_GRAPH_KINDS);
    expect(local.ok).toBe(false);
    expect(local.issues.some((issue) => issue.nodeId === 'C' && issue.message.includes('ghost'))).toBe(true);

    const yaml = toYaml(graph);
    const server = parseGraphTemplateYaml(yaml);
    expect(server.errors.length).toBeGreaterThan(0);
    const mapped = mapServerIssues(yaml, { errors: server.errors.map(({ path, message }) => ({ path, message })) });
    expect(mapped.some((issue) => issue.nodeId === 'C' && issue.source === 'server')).toBe(true);
  });

  test('negative: duplicate node ids fail (the loader alone would accept them)', () => {
    const base = threeNodeLine();
    const graph: CanvasGraph = { ...base, nodes: [...base.nodes, { ...base.nodes[2]!, x: 0, y: 300 }] };
    const local = validateGraph(graph);
    expect(local.ok).toBe(false);
    expect(local.issues.map((issue) => issue.message)).toContain('노드 id «C» 가 겹칩니다');
    expect(() => addNode(base, { kind: 'agent', id: 'A' })).toThrow('이미 있는 노드 id');
    expect(() => updateNode(base, 'B', { id: 'A' })).toThrow('이미 있는 노드 id');
  });

  test('rename and delete keep edges and entry consistent; unknown kinds and missing end are reported', () => {
    let graph = updateNode(threeNodeLine(), 'A', { id: 'start', recipe: 'implement' });
    expect(graph.entry).toBe('start');
    expect(graph.edges[0]).toEqual({ from: 'start', to: 'B', outcome: '' });
    graph = removeNode(graph, 'start');
    expect(graph.entry).toBe('B');
    expect(graph.edges).toEqual([{ from: 'B', to: 'C', outcome: '' }]);

    const looped = connect(updateNode(graph, 'C', { kind: 'nope' }), 'C', 'B');
    const issues = validateGraph(looped, CORE_GRAPH_KINDS).issues.map((issue) => issue.message);
    expect(issues).toContain('팔레트에 없는 kind 입니다: nope');
    expect(issues.some((message) => message.startsWith('끝 노드가 없습니다'))).toBe(false);
    expect(validateGraph(setTerminal(looped, 'C', false), CORE_GRAPH_KINDS).issues.map((issue) => issue.message)
      .some((message) => message.startsWith('끝 노드가 없습니다'))).toBe(true);
    expect(() => connect(graph, 'B', 'B')).toThrow();
    expect(validateGraph(emptyGraph()).issues.map((issue) => issue.message)).toEqual(['노드가 하나도 없습니다']);
  });

  test('demo storyboard: plan→build→review with «review 실패 시 → build» fails without an end node, passes once review is marked', () => {
    let graph = emptyGraph('demo-review-mine');
    graph = addNode(graph, { kind: 'agent', id: 'plan' }).graph;
    graph = addNode(graph, { kind: 'agent', id: 'build' }).graph;
    graph = addNode(graph, { kind: 'judge', id: 'review' }).graph;
    graph = connect(connect(graph, 'plan', 'build'), 'build', 'review');
    graph = setFailTarget(graph, 'review', 'build');
    expect(failTarget(graph, 'review')).toBe('build');

    const before = validateGraph(graph, CORE_GRAPH_KINDS);
    expect(before.ok).toBe(false);
    expect(before.issues.map((issue) => issue.message)).toEqual(['끝 노드가 없습니다 — 노드를 골라 «끝 노드» 로 표시하세요']);
    expect(parseGraphTemplateYaml(toYaml(graph)).errors.map((error) => error.path)).toEqual(['<inline>/terminal_nodes']);

    graph = setTerminal(graph, 'review', true);
    expect(validateGraph(graph, CORE_GRAPH_KINDS)).toEqual({ ok: true, issues: [] });
    const yaml = toYaml(graph);
    const loaded = parseGraphTemplateYaml(yaml);
    expect(loaded.errors).toEqual([]);
    expect(loaded.template?.terminalNodes).toEqual(['review']);
    expect(loaded.template?.edges).toEqual([{ from: 'plan', to: 'build' }, { from: 'build', to: 'review' }, { from: 'review', on: 'outcome', map: { fail: 'build' } }]);
    expect(fromYaml(yaml)).toMatchObject({ graphId: 'demo-review-mine', entry: 'plan', terminals: ['review'], edges: graph.edges });
  });

  test('a fail route next to a plain edge turns that edge into the ok outcome (same as setRunGraphFailTarget)', () => {
    let graph = setFailTarget(threeNodeLine(), 'B', 'A');
    expect(graph.edges.filter((edge) => edge.from === 'B')).toEqual([{ from: 'B', to: 'C', outcome: 'ok' }, { from: 'B', to: 'A', outcome: 'fail' }]);
    expect(parseGraphTemplateYaml(toYaml(graph)).errors).toEqual([]);
    graph = setFailTarget(graph, 'B', null);
    expect(failTarget(graph, 'B')).toBeNull();
    expect(() => setFailTarget(graph, 'B', 'B')).toThrow();
  });
});

describe('saveCanvasGraph (create = POST /v1/graphs · update = PUT)', () => {
  function fakeClient(fail?: { status: number; body: unknown }) {
    const calls: string[] = [];
    const client: CanvasSaveClient = {
      createRunGraph: async (id) => { calls.push(`create:${id}`); if (fail) throw new NexusApiError(fail.status, '/v1/graphs', fail.body); return { id, version: 1 }; },
      putRunGraphYaml: async (id) => { calls.push(`put:${id}`); if (fail) throw new NexusApiError(fail.status, `/v1/graphs/${id}/yaml`, fail.body); return { id, source: 'mine', editable: true, saved: true }; },
    };
    return { client, calls };
  }

  test('a new graph is created, an existing one is updated; the optional version is carried', async () => {
    const created = fakeClient();
    expect(await saveCanvasGraph(created.client, 'demo-review-mine', 'x', 'create')).toEqual({ ok: true, id: 'demo-review-mine', created: true, version: 1 });
    expect(created.calls).toEqual(['create:demo-review-mine']);
    const updated = fakeClient();
    expect(await saveCanvasGraph(updated.client, 'demo-review-mine', 'x', 'update')).toEqual({ ok: true, id: 'demo-review-mine', created: false });
    expect(updated.calls).toEqual(['put:demo-review-mine']);
  });

  test('server refusals become readable issues, never a throw (missing create route, conflict, invalid graph)', async () => {
    const missing = await saveCanvasGraph(fakeClient({ status: 404, body: { error: 'not-found' } }).client, 'g', 'x', 'create');
    expect(missing.ok === false && missing.issues[0]!.message).toContain('아직 지원하지 않습니다');
    const conflict = await saveCanvasGraph(fakeClient({ status: 409, body: { error: 'conflict' } }).client, 'g', 'x', 'create');
    expect(conflict.ok === false && conflict.issues[0]!.message).toContain('이미 있는 그래프 id');
    const yaml = toYaml(threeNodeLine());
    const reserved = await saveCanvasGraph(fakeClient({ status: 400, body: { error: 'reserved-id' } }).client, 'recipes', 'x', 'create');
    expect(reserved.ok === false && reserved.issues[0]!.message).toContain('예약된 id');
    expect(validateGraph({ ...threeNodeLine(), graphId: 'recipes' }).issues.map((issue) => issue.message)).toEqual(['«recipes» 는 예약된 그래프 id 입니다']);
    const unprocessable = await saveCanvasGraph(fakeClient({ status: 422, body: { error: 'invalid-graph', errors: [{ path: '<inline>/terminal_nodes', message: 'no end' }] } }).client, 'g', 'x', 'create');
    expect(unprocessable).toEqual({ ok: false, issues: [{ message: 'no end', source: 'server' }] });
    const invalid = await saveCanvasGraph(fakeClient({ status: 400, body: { error: 'invalid-graph', errors: [{ path: '<inline>/nodes/1/kind', message: 'bad kind' }] } }).client, 'g', yaml, 'update');
    expect(invalid).toEqual({ ok: false, issues: [{ message: 'bad kind', source: 'server', nodeId: 'B' }] });
  });
});

test('every shipped run graph survives load onto the canvas and back without losing loader fields', () => {
  const dir = join(import.meta.dir, '../../../../../graphs');
  const files = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
  let compared = 0;
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    const original = parseGraphTemplateYaml(text);
    if (!original.template) continue;
    const again = parseGraphTemplateYaml(toYaml(fromYaml(text)));
    expect({ name, errors: again.errors }).toEqual({ name, errors: [] });
    expect(canonicalGraphJson(again.template!)).toBe(canonicalGraphJson(original.template));
    compared++;
  }
  expect(compared).toBeGreaterThan(0);
});

test('runner shape (graphs/demo/inside-seed): cmd:<id> recipes, ok/rework outcome edges, a done gate as the end', () => {
  let graph = emptyGraph('demo-review-mine');
  for (const [id, kind] of [['plan', 'agent'], ['build', 'agent'], ['review', 'judge'], ['done', 'gate']] as const) {
    graph = addNode(graph, { kind, id }).graph;
  }
  expect(graph.nodes.map((node) => node.recipe)).toEqual(['cmd:plan', 'cmd:build', 'cmd:review', 'cmd:done']);
  expect(defaultOutcome(graph, 'plan')).toBe('ok');
  graph = connect(graph, 'plan', 'build', defaultOutcome(graph, 'plan'));
  graph = connect(graph, 'build', 'review', 'ok');
  graph = connect(graph, 'review', 'done', defaultOutcome(graph, 'review'));
  expect(defaultOutcome(graph, 'review')).toBe('rework');
  graph = connect(graph, 'review', 'build', 'rework');
  graph = updateNode(graph, 'build', { maxVisits: 2 });
  graph = setEntry(setTerminal(graph, 'done', true), 'plan');

  expect(validateGraph(graph, CORE_GRAPH_KINDS)).toEqual({ ok: true, issues: [] });
  const yaml = toYaml(graph);
  const loaded = parseGraphTemplateYaml(yaml);
  expect(loaded.errors).toEqual([]);
  expect(loaded.template?.edges).toEqual([
    { from: 'plan', on: 'outcome', map: { ok: 'build' } },
    { from: 'build', on: 'outcome', map: { ok: 'review' } },
    { from: 'review', on: 'outcome', map: { ok: 'done', rework: 'build' } },
  ]);
  expect(loaded.template?.terminalNodes).toEqual(['done']);

  // A recipe left at its default follows a rename; an edited one stays.
  expect(updateNode(graph, 'plan', { id: 'design' }).nodes[0]!.recipe).toBe('cmd:design');
  expect(updateNode(updateNode(graph, 'plan', { recipe: 'cmd:x' }), 'plan', { id: 'design' }).nodes[0]!.recipe).toBe('cmd:x');
});

test('tap-added nodes line up in reading order; the rework edge is the only back edge (wide and phone flow)', () => {
  for (const flow of ['horizontal', 'vertical'] as const) {
    let graph = emptyGraph('g');
    for (const id of ['plan', 'build', 'review']) graph = addNode(graph, { kind: 'agent', id, flow }).graph;
    graph = connect(connect(connect(graph, 'plan', 'build', 'ok'), 'build', 'review', 'ok'), 'review', 'build', 'rework');
    expect(graph.edges.map((edge) => isBackEdge(graph, edge, flow))).toEqual([false, false, true]);
    const [a, b] = graph.nodes;
    expect(flow === 'vertical' ? [a!.x === b!.x, a!.y < b!.y] : [a!.y === b!.y, a!.x < b!.x]).toEqual([true, true]);
  }
});
