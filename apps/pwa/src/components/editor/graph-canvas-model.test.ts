import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalGraphJson, parseGraphTemplateYaml } from '../../../../../src/self-implement/graph-yaml';
import { CORE_GRAPH_KINDS } from '@/lib/run-graph-yaml-edit';
import {
  CANVAS_NODE_SIZE,
  addNode,
  applyCanvasRunStep,
  applyCanvasRunSteps,
  autoLayoutToFit,
  canvasUnitNames,
  canvasUnitOf,
  collapseCanvasUnits,
  connect,
  canvasGroupGraph,
  projectCanvasGroups,
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
import type { RunStep } from '../../../../../src/self-implement/run-step-projection';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { ReactFlow } from '@xyflow/react';
import { GraphCanvasEditor, type GraphCanvasContext } from './GraphCanvasEditor';
import { groupBoxes } from './graph-groups';

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
    expect(back.edges.map(({ sourceMapIndex: _sourceMapIndex, ...edge }) => edge)).toEqual(graph.edges);
    // Layered layout ranks by forward edges only (GRAPH-EDGE-TIDY): the B→A fail route does not reorder the line.
    const [a, b, c] = back.nodes.map((node) => node.x);
    expect(a! < b! && b! < c!).toBe(true);
  });

  test('outcome edges preserve distinct on maps and add new outcomes to the matching existing map', () => {
    const source = `graph_id: cge-demo\nentry: A\nnodes:\n  - node_id: A\n    kind: agent\n    recipe: a\n  - node_id: B\n    kind: gate\n    recipe: b\n  - node_id: C\n    kind: observe\n    recipe: c\nterminal_nodes: [C]\nedges:\n  - from: A\n    on: heal_action\n    map:\n      failed: B\n  - from: A\n    on: pod_result\n    map:\n      failed: C\n  - from: B\n    on: outcome\n    map:\n      pass: C\n`;
    let graph = fromYaml(source);
    graph = connect(graph, 'B', 'A', 'fail');
    const yaml = toYaml(graph);
    const edges = parseYaml(yaml).edges;
    expect(parseGraphTemplateYaml(yaml).errors).toEqual([]);
    expect(edges).toEqual([
      { from: 'A', on: 'heal_action', map: { failed: 'B' } },
      { from: 'A', on: 'pod_result', map: { failed: 'C' } },
      { from: 'B', on: 'outcome', map: { pass: 'C', fail: 'A' } },
    ]);
    const back = fromYaml(yaml);
    expect(back.edges.map(({ sourceMapIndex: _sourceMapIndex, ...edge }) => edge)).toEqual(
      graph.edges.map(({ sourceMapIndex: _sourceMapIndex, ...edge }) => edge),
    );
  });

  test('plain edges with the same source and target serialize only once', () => {
    const graph = { ...threeNodeLine(), edges: [...threeNodeLine().edges, { from: 'A', to: 'B', outcome: '' }] };
    expect(parseYaml(toYaml(graph)).edges).toEqual([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }]);
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

describe('editor unit views', () => {
  test('group tags round-trip through the YAML ledger; expanded boxes keep original positions and edges', () => {
    const original = threeNodeLine();
    const tagged = { ...original, nodes: original.nodes.map((node, index) => index < 2
      ? { ...node, extra: { group: 'planning', contract: { visits: 2 } } } : node) };
    const yaml = toYaml(tagged);
    const loaded = fromYaml(yaml);
    expect(loaded.nodes[0]?.extra).toEqual({ group: 'planning', contract: { visits: 2 } });
    expect(canvasGroupGraph(loaded).nodes.map((node) => node.group)).toEqual(['planning', 'planning', undefined]);
    expect(projectCanvasGroups(loaded, new Set())).toBe(loaded);
    expect(projectCanvasGroups(loaded, new Set(['unknown']))).toBe(loaded);
    expect(toYaml(projectCanvasGroups(loaded, new Set()))).toBe(yaml);
  });

  test('folded view has one clickable unit id and rewired edges; opening shows only inside edges, without changing YAML', () => {
    const base = threeNodeLine();
    const tagged = { ...base, nodes: base.nodes.map((node, index) => index < 2 ? { ...node, extra: { group: 'planning' } } : node) };
    const before = toYaml(tagged);
    const folded = projectCanvasGroups(tagged, new Set(['planning']));
    expect(folded.nodes.map((node) => node.id)).toEqual(['group:planning', 'C']);
    expect(folded.edges).toEqual([{ from: 'group:planning', to: 'C', outcome: '' }]);
    expect(folded.entry).toBe('group:planning');
    expect(folded.terminals).toEqual(['C']);
    expect(folded.nodes[0]?.recipe).toBe('묶음 · 노드 2개');
    const inside = projectCanvasGroups(tagged, new Set(['planning']), 'planning');
    expect(inside.nodes.map((node) => node.id)).toEqual(['A', 'B']);
    expect(inside.edges).toEqual([{ from: 'A', to: 'B', outcome: '' }]);
    expect(toYaml(tagged)).toBe(before);
    const ending = { ...tagged, terminals: ['B'] };
    expect(projectCanvasGroups(ending, new Set(['planning'])).terminals).toEqual(['group:planning']);
  });
});

test('GraphCanvasEditor routes global fold, unit click, breadcrumb and per-box fold without editing YAML', () => {
  const base = threeNodeLine();
  const graph = { ...base, nodes: base.nodes.map((node, index) => index < 2 ? { ...node, extra: { group: 'planning' } } : node) };
  const before = toYaml(graph);
  const state: { context?: GraphCanvasContext } = {};
  let root!: ReturnType<typeof create>;
  const globals = globalThis as Record<string, unknown>;
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globals.window;
  const previousResize = globals.ResizeObserver;
  const previousRaf = globals.requestAnimationFrame;
  const noop = () => {};
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);
  globals.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  globals.window ??= { requestAnimationFrame: globals.requestAnimationFrame, cancelAnimationFrame: clearTimeout, addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) };
  try {
    act(() => { root = create(createElement(GraphCanvasEditor, { palette: [], client: null, initialGraph: graph, onChange: (context) => { state.context = context; } })); });
    const flow = () => root.root.findByType(ReactFlow);
    expect(flow().props.nodes.filter((node: { type: string }) => node.type === 'groupBox')).toHaveLength(1);
    const box = flow().props.nodes.find((node: { type: string }) => node.type === 'groupBox');
    expect(box.data).toMatchObject({ group: 'planning', state: 'pending', stepCount: 2 });
    act(() => { root.update(createElement(GraphCanvasEditor, { palette: [], client: null, initialGraph: graph, nodeStatus: { A: 'done', B: 'failed' } })); });
    expect(flow().props.nodes.find((node: { type: string }) => node.type === 'groupBox').data.state).toBe('failed');
    act(() => { root.update(createElement(GraphCanvasEditor, { palette: [], client: null, initialGraph: graph, nodeStatus: { A: 'running', B: 'failed' } })); });
    expect(flow().props.nodes.find((node: { type: string }) => node.type === 'groupBox').data.state).toBe('running');
    act(() => { box.data.onCollapse('planning'); });
    expect(flow().props.nodes.map((node: { id: string }) => node.id)).toContain('group:planning');
    const unit = flow().props.nodes.find((node: { id: string }) => node.id === 'group:planning');
    act(() => { flow().props.onNodeClick({}, unit); });
    expect(root.root.findByProps({ 'aria-label': '유닛 보기' }).findAllByType('span').some((span) => span.children.includes('planning'))).toBe(true);
    expect(flow().props.nodes.map((node: { id: string }) => node.id)).toEqual(['A', 'B']);
    act(() => { root.root.findByProps({ 'aria-label': '부모 그래프' }).props.onClick(); });
    expect(flow().props.nodes.map((node: { id: string }) => node.id)).toContain('group:planning');
    act(() => { root.root.findByProps({ 'data-testid': 'editor-toggle-units' }).props.onClick(); });
    expect(flow().props.nodes.filter((node: { type: string }) => node.type === 'groupBox')).toHaveLength(1);
    expect(state.context?.yaml).toBe(before);
    act(() => root.unmount());
  } finally {
    if (previousAct === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
    else globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    if (previousWindow === undefined) delete globals.window; else globals.window = previousWindow;
    if (previousResize === undefined) delete globals.ResizeObserver; else globals.ResizeObserver = previousResize;
    if (previousRaf === undefined) delete globals.requestAnimationFrame; else globals.requestAnimationFrame = previousRaf;
  }
});

describe('canvas run steps', () => {
  const ts = '2026-10-09T00:00:00.000Z';

  test('re-entry after exit clears the previous outcome and exitedAt until the new visit exits', () => {
    const source = threeNodeLine();
    const entered = applyCanvasRunSteps(source, [
      { seq: 4, ts: '2026-10-09T00:04:00.000Z', type: 'node-enter', node: 'A', visit: 2 },
      { seq: 2, ts: '2026-10-09T00:02:00.000Z', type: 'node-exit', node: 'A', outcome: 'rework' },
      { seq: 1, ts: '2026-10-09T00:01:00.000Z', type: 'node-enter', node: 'A', visit: 1 },
      { seq: 3, ts: '2026-10-09T00:03:00.000Z', type: 'node-skipped', node: 'A', reason: 'condition' },
    ]);
    expect(entered.nodes.A).toEqual({
      visit: 2, enteredAt: '2026-10-09T00:04:00.000Z', outcome: undefined,
      exitedAt: undefined, skipped: undefined,
    });
    expect(entered.lastSeq).toBe(4);
    expect(entered.graph).toBe(source);
    const exited = applyCanvasRunStep(entered, { seq: 5, ts, type: 'node-exit', node: 'A', outcome: 'ok' });
    expect(exited.nodes.A).toMatchObject({ visit: 2, outcome: 'ok', exitedAt: ts });
    expect(entered.nodes.A?.outcome).toBeUndefined();
  });

  test('replays the shared format by seq through the final step without mutating the YAML graph', () => {
    const source = threeNodeLine();
    const before = toYaml(source);
    const steps: RunStep[] = [
      { seq: 8, ts, type: 'node-exit', node: 'B', outcome: 'ok' },
      { seq: 1, ts, type: 'node-enter', node: 'A', visit: 1 },
      { seq: 4, ts, type: 'node-skipped', node: 'C', reason: 'condition', condition: 'skip' },
      { seq: 3, ts, type: 'edge-taken', from: 'A', to: 'B', via: 'outcome' },
      { seq: 2, ts, type: 'node-exit', node: 'A', outcome: 'ok' },
    ];
    const result = applyCanvasRunSteps(source, steps);
    expect(result.lastSeq).toBe(8);
    expect(result.nodes.A).toMatchObject({ visit: 1, outcome: 'ok', enteredAt: ts, exitedAt: ts });
    expect(result.nodes.B?.outcome).toBe('ok');
    expect(result.nodes.C?.skipped).toEqual({ reason: 'condition', condition: 'skip', at: ts });
    expect(result.taken).toEqual([{ seq: 3, ts, type: 'edge-taken', from: 'A', to: 'B', via: 'outcome' }]);
    expect(result.graph).toBe(source);
    expect(toYaml(source)).toBe(before);
    expect(applyCanvasRunStep(result, steps[0]!)).toBe(result);
  });

  test('structural changes and childRunId-linked units apply in order; static positions and loader fields survive', () => {
    const source = threeNodeLine();
    const original = { ...source, extra: { version: 3, loop: { max_visits: 2 } } };
    const steps: RunStep[] = [
      { seq: 6, ts, type: 'unit-collapsed', node: 'B', resolution: 0, decider: 'supervisor', reason: 'finished' },
      { seq: 2, ts, type: 'edge-rerouted', from: 'A', outcome: '', was: 'B', to: 'D', decider: 'supervisor', reason: 'branch' },
      { seq: 1, ts, type: 'node-added', node: 'D', kind: 'agent', decider: 'supervisor', reason: 'need work' },
      { seq: 3, ts, type: 'unit-expanded', node: 'B', unit: 'unit@1', childRunId: 'child-run-1', resolution: 1, decider: 'supervisor', reason: 'zoom' },
      { seq: 4, ts, type: 'unit-expanded', node: 'C', unit: 'unit@2', childRunId: 'child-run-2', resolution: 2, decider: 'supervisor', reason: 'zoom' },
      { seq: 5, ts, type: 'unit-expanded', node: 'B', unit: 'unit@1', childRunId: 'child-run-3', resolution: 2, decider: 'supervisor', reason: 'retry' },
    ];
    const result = applyCanvasRunSteps(original, steps);
    expect(result.graph.nodes.map(({ id }) => id)).toEqual(['A', 'B', 'C', 'D']);
    expect(result.graph.nodes.slice(0, 3)).toEqual(original.nodes);
    expect(result.graph.edges[0]).toEqual({ from: 'A', to: 'D', outcome: '' });
    expect(result.graph.extra).toEqual(original.extra);
    expect(result.units).toEqual([
      { node: 'C', unit: 'unit@2', childRunId: 'child-run-2', resolution: 2, expanded: true },
      { node: 'B', unit: 'unit@1', childRunId: 'child-run-3', resolution: 0, expanded: false },
    ]);
    expect(result.lastSeq).toBe(6);
    expect(original.edges[0]?.to).toBe('B');
    expect(parseYaml(toYaml(original)).version).toBe(3);
    expect(fromYaml(toYaml(original)).nodes.map(({ id }) => id)).toEqual(['A', 'B', 'C']);
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

function unitGraph(): CanvasGraph {
  const yaml = `graph_id: cge-units
entry_node: intake-1
terminal_nodes: [merge]
nodes:
  - { node_id: intake-1, kind: observe, recipe: r, max_visits: 1, group: intake }
  - { node_id: intake-2, kind: observe, recipe: r, max_visits: 1, group: intake }
  - { node_id: build, kind: agent, recipe: r, max_visits: 1 }
  - { node_id: gate, kind: gate, recipe: r, max_visits: 1 }
  - { node_id: open-pr, kind: git, recipe: r, max_visits: 2, group: land }
  - { node_id: merge, kind: git, recipe: r, max_visits: 2, group: land }
edges:
  - { from: intake-1, to: intake-2 }
  - { from: intake-2, to: build }
  - { from: build, to: gate }
  - from: gate
    on: outcome
    map: { pass: open-pr, fail: build }
  - { from: open-pr, to: merge }
`;
  return fromYaml(yaml);
}

describe('unit views (CGE-UNITS)', () => {
  test('units come from the `group:` node tags in first-declared order; a graph without tags has none', () => {
    const graph = unitGraph();
    expect(canvasUnitNames(graph)).toEqual(['intake', 'land']);
    expect(canvasUnitOf(graph).get('intake-1')).toBe('intake');
    expect(canvasUnitOf(graph).get('build')).toBeUndefined();
    expect(canvasUnitNames(threeNodeLine())).toEqual([]);
    // The tag survives the canvas round trip, so a saved unit graph keeps its units.
    expect(canvasUnitNames(fromYaml(toYaml(graph)))).toEqual(['intake', 'land']);
    expect(parseGraphTemplateYaml(toYaml(graph)).errors).toEqual([]);
  });

  test('folding reuses graph-groups collapseGroups: one node per folded unit, outer edges rewired, nothing duplicated', () => {
    const graph = unitGraph();
    expect(collapseCanvasUnits(graph, new Set())).toBe(graph);
    const folded = collapseCanvasUnits(graph, new Set(['intake', 'land']));
    expect([...folded.nodes.map((node) => node.id)].sort()).toEqual(['build', 'gate', 'group:intake', 'group:land']);
    const intake = folded.nodes.find((node) => node.id === 'group:intake')!;
    expect(intake).toMatchObject({ kind: 'subgraph', recipe: '묶음 · 노드 2개', maxVisits: 1 });
    expect(folded.nodes.filter((node) => node.id === 'group:intake')).toHaveLength(1);
    expect(folded.entry).toBe('group:intake');
    expect(folded.terminals).toEqual(['group:land']);
    expect(folded.edges.map((edge) => `${edge.from}->${edge.to}(${edge.outcome})`).sort()).toEqual([
      'build->gate()', 'gate->build(fail)', 'gate->group:land(pass)', 'group:intake->build()',
    ]);
    // A view, not an edit: the source graph still has all six nodes and its own entry.
    expect(graph.nodes).toHaveLength(6);
    expect(graph.entry).toBe('intake-1');
  });

  test('folding one unit replaces only that unit — the other keeps its member nodes', () => {
    const folded = collapseCanvasUnits(unitGraph(), new Set(['land']));
    expect([...folded.nodes.map((node) => node.id)].sort()).toEqual(['build', 'gate', 'group:land', 'intake-1', 'intake-2']);
    expect(folded.entry).toBe('intake-1');
    expect(folded.terminals).toEqual(['group:land']);
    expect(folded.edges.map((edge) => `${edge.from}->${edge.to}(${edge.outcome})`).sort()).toEqual([
      'build->gate()', 'gate->build(fail)', 'gate->group:land(pass)', 'intake-1->intake-2()', 'intake-2->build()',
    ]);
  });

  test('opening a folded unit gives the expanded box a fitView target that exists in the rendered node set', () => {
    const graph = unitGraph();
    const unitOf = canvasUnitOf(graph);
    const sizeOf = (nodes: CanvasGraph['nodes']) =>
      nodes.map((node) => ({ id: node.id, position: { x: node.x, y: node.y }, ...CANVAS_NODE_SIZE }));
    // Before the click both units are folded — no box anywhere, so there is nothing to fit yet.
    const before = autoLayoutToFit(collapseCanvasUnits(graph, new Set(['intake', 'land'])), 'horizontal', undefined);
    expect(groupBoxes(sizeOf(before.nodes), unitOf)).toEqual([]);
    // onNodeClick → openUnit('land'): what stays folded is intake alone — the exact view the editor renders.
    const viewGraph = autoLayoutToFit(collapseCanvasUnits(graph, new Set(['intake'])), 'horizontal', undefined);
    const boxes = groupBoxes(sizeOf(viewGraph.nodes), unitOf);
    const target = boxes.find((box) => box.group === 'land');
    expect(target).toBeDefined();
    // The canvas renders exactly these ids (boxNodes + flowNodes); the fit target is the box the opened unit
    // actually got — a hand-built id that missed this set would make fitView a silent no-op.
    expect(boxes.some((box) => box.id === target!.id)).toBe(true);
    expect(viewGraph.nodes.some((node) => node.id === target!.id)).toBe(false);
    expect([...target!.members].sort()).toEqual(['merge', 'open-pr']);
    expect(target!.width).toBeGreaterThan(0);
    expect(target!.height).toBeGreaterThan(0);
    // Still-folded intake has no box — nothing to fit and nothing opened.
    expect(boxes.some((box) => box.group === 'intake')).toBe(false);
  });
});
