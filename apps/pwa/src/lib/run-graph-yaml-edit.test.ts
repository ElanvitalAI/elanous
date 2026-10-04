import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  addRunGraphEdge,
  addRunGraphNode,
  readRunGraphYaml,
  removeRunGraphEdge,
  removeRunGraphNode,
  runGraphFailRouteBlocked,
  runGraphFailTarget,
  setRunGraphFailTarget,
  setRunGraphNodeKind,
  setRunGraphNodeRecipe,
  writeRunGraphYaml,
} from './run-graph-yaml-edit';

const source = readFileSync(join(import.meta.dir, '../../../../graphs/research-loop.yaml'), 'utf8');

test('reading research-loop and writing it back is byte identical, and an added node keeps comment lines', () => {
  const untouched = readRunGraphYaml(source);
  expect(writeRunGraphYaml(untouched)).toBe(source);

  const edited = readRunGraphYaml(source);
  addRunGraphNode(edited, { nodeId: 'note', kind: 'observe', recipe: 'read-only', maxVisits: 1 });
  const text = writeRunGraphYaml(edited);
  expect(text).toContain('node_id: note');
  expect(parse(text).nodes.find((node: { node_id: string }) => node.node_id === 'note')).toMatchObject({
    kind: 'observe', recipe: 'read-only', max_visits: 1,
  });
  expect(text).toContain('# 📏 실측 2026-09-08 (원장 30일 · 전 우주 · 걸음 191개 소급): 이 노드의 «관측 최대»가 ***7*** 이었다.');
  expect(text).toContain('max_visits: 7');
  const commentLines = source.split('\n').filter((line) => line.trimStart().startsWith('#'));
  for (const line of commentLines) expect(text.split('\n')).toContain(line);
});

test('an added node with a recipe containing a comment marker round-trips', () => {
  const doc = readRunGraphYaml('nodes:\n  - node_id: a\n    kind: gate\n');
  addRunGraphNode(doc, { nodeId: 'b', kind: 'agent', recipe: 'implement # temp' });
  expect(parse(writeRunGraphYaml(doc)).nodes[1].recipe).toBe('implement # temp');
});

test('changing only an existing scalar preserves every unrelated source byte', () => {
  const input = 'nodes:\n  - { node_id: a, kind: gate, recipe: old } # node\n\n' +
    'edges:\n  - { from: a, on: outcome, map: { ok: a } } # edge\n';
  const doc = readRunGraphYaml(input);
  setRunGraphNodeRecipe(doc, 'a', 'implement');
  const written = writeRunGraphYaml(doc);
  expect(written).toBe(input.replace('recipe: old', 'recipe: implement'));
  expect(parse(written).nodes[0].recipe).toBe('implement');
});

test('kind, recipe, and map entries change in the document tree without dropping sibling comments', () => {
  const doc = readRunGraphYaml(source);
  setRunGraphNodeKind(doc, 'judge', 'observe');
  setRunGraphNodeRecipe(doc, 'judge', 'read-only');
  addRunGraphEdge(doc, { from: 'judge', outcome: 'again', to: 'investigate' });
  removeRunGraphEdge(doc, 'judge', 'again');
  removeRunGraphNode(doc, 'note');
  const text = writeRunGraphYaml(doc);
  expect(text).toContain('kind: observe');
  expect(text).toContain('recipe: read-only');
  expect(text).not.toContain('again: investigate');
  expect(text).toContain('# 📏 아래 둘은 «실측이 요구했다» — 오늘 첫 런이 실제로 밟았다.');
});

test('failure picker keeps an existing outcome map and comments when adding fail', () => {
  const input = `graph_id: route\nnodes:\n  - { node_id: start }\n  - { node_id: done }\n  - { node_id: failed }\nedges:\n  - from: start\n    on: outcome\n    map:\n      ok: done # preserve this route\n`;
  const doc = readRunGraphYaml(input);
  setRunGraphFailTarget(doc, 'start', 'failed');
  const written = writeRunGraphYaml(doc);
  expect(parse(written).edges[0].map).toEqual({ ok: 'done', fail: 'failed' });
  expect(written).toContain('# preserve this route');
  expect(runGraphFailTarget(readRunGraphYaml(written), 'start')).toBe('failed');
});

test('failure picker creates one outcome edge when the node had no edge', () => {
  const doc = readRunGraphYaml(`nodes: [{ node_id: start }, { node_id: failed }]\nedges: []\n`);
  setRunGraphFailTarget(doc, 'start', 'failed');
  const written = writeRunGraphYaml(doc);
  expect(parse(written).edges).toEqual([{ from: 'start', on: 'outcome', map: { fail: 'failed' } }]);
  expect(runGraphFailTarget(readRunGraphYaml(written), 'start')).toBe('failed');
});

test('failure picker refuses to overwrite another condition on the same edge', () => {
  const input = `nodes: [{ node_id: start }, { node_id: failed }]\nedges:\n  - { from: start, on: changed-files, map: { unknown: failed } }\n`;
  const doc = readRunGraphYaml(input);
  expect(() => setRunGraphFailTarget(doc, 'start', 'failed')).toThrow('failure route requires an outcome edge');
  expect(writeRunGraphYaml(doc)).toBe(input);
});

test('failure picker writes and reads the existing outcome fail map across YAML round trips', () => {
  const input = `graph_id: route\nversion: 1\nentry_node: start\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: start, kind: agent, recipe: 'cmd:start', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: start, to: done }\n`;
  const doc = readRunGraphYaml(input);
  expect(runGraphFailTarget(doc, 'start')).toBeUndefined();
  expect((doc.toJS() as { edges: Array<{ to: string }> }).edges[0]?.to).toBe('done');
  setRunGraphFailTarget(doc, 'start', 'failed');
  expect((doc.toJS() as { edges: Array<{ map: Record<string, string> }> }).edges[0]?.map).toEqual({ ok: 'done', fail: 'failed' });
  const written = writeRunGraphYaml(doc);
  const parsed = parse(written);
  expect(parsed.edges).toEqual([{ from: 'start', on: 'outcome', map: { ok: 'done', fail: 'failed' } }]);
  expect(runGraphFailTarget(readRunGraphYaml(written), 'start')).toBe('failed');
  const changed = readRunGraphYaml(written);
  setRunGraphFailTarget(changed, 'start', 'done');
  expect(runGraphFailTarget(readRunGraphYaml(writeRunGraphYaml(changed)), 'start')).toBe('done');
  const cleared = readRunGraphYaml(writeRunGraphYaml(changed));
  setRunGraphFailTarget(cleared, 'start', null);
  expect(parse(writeRunGraphYaml(cleared)).edges[0].map).toEqual({ ok: 'done' });
});

const mini = (edges: string) => `graph_id: mini
nodes:
  - { node_id: a, kind: gate }
  - { node_id: b, kind: gate }
  - { node_id: c, kind: gate }
  - { node_id: d, kind: gate }
edges:
${edges}`;

test('a generic edge edit never rewrites an earlier plain edge from the same node', () => {
  const doc = readRunGraphYaml(mini('  - from: a\n    to: b\n  - from: a\n    on: outcome\n    map:\n      ok: c\n'));
  addRunGraphEdge(doc, { from: 'a', outcome: 'retry', to: 'd' });
  const edges = parse(writeRunGraphYaml(doc)).edges;
  expect(edges[0]).toEqual({ from: 'a', to: 'b' });
  expect(edges[1].map).toEqual({ ok: 'c', retry: 'd' });
});

test('adding fail to an existing block outcome map survives serialization', () => {
  const input = mini('  - from: a\n    on: outcome\n    map:\n      ok: b # original\n');
  const doc = readRunGraphYaml(input);
  addRunGraphEdge(doc, { from: 'a', outcome: 'fail', to: 'c' });
  const written = writeRunGraphYaml(doc);
  expect(parse(written).edges[0].map).toEqual({ ok: 'b', fail: 'c' });
  expect(written).toBe(input.replace('      ok: b # original\n', '      ok: b # original\n      fail: c\n'));
});

test('adding a recipe to a node with only a kind survives serialization', () => {
  const input = 'nodes:\n  - node_id: a\n    kind: gate # keep\n';
  const doc = readRunGraphYaml(input);
  setRunGraphNodeRecipe(doc, 'a', 'implement');
  const written = writeRunGraphYaml(doc);
  expect(parse(written).nodes[0]).toMatchObject({ node_id: 'a', kind: 'gate', recipe: 'implement' });
  expect(written).toBe(input + '    recipe: implement\n');
});

test('a new recipe requiring YAML quoting survives a block-map save', () => {
  const input = 'nodes:\n  - node_id: a\n    kind: gate # keep\n';
  const doc = readRunGraphYaml(input);
  setRunGraphNodeRecipe(doc, 'a', 'implement # temp');
  const written = writeRunGraphYaml(doc);
  expect(parse(written).nodes[0].recipe).toBe('implement # temp');
  expect(written).toContain('kind: gate # keep');
});

test('a new recipe requiring YAML quoting survives a flow-map save', () => {
  const doc = readRunGraphYaml('nodes:\n  - { node_id: a, kind: gate }\n');
  setRunGraphNodeRecipe(doc, 'a', 'implement # temp');
  expect(parse(writeRunGraphYaml(doc)).nodes[0].recipe).toBe('implement # temp');
});

test('adding recipe inside a flow node map preserves its style and neighbors', () => {
  const input = 'nodes:\n  - { node_id: a, kind: gate } # keep\n';
  const doc = readRunGraphYaml(input);
  setRunGraphNodeRecipe(doc, 'a', 'implement');
  const written = writeRunGraphYaml(doc);
  expect(parse(written).nodes[0]).toEqual({ node_id: 'a', kind: 'gate', recipe: 'implement' });
  expect(written).toBe(input.replace('kind: gate }', 'kind: gate, recipe: implement }'));
});

test('adding retry inside a flow outcome map preserves ok and the flow syntax', () => {
  const doc = readRunGraphYaml(mini('  - from: a\n    on: outcome\n    map: { ok: b } # keep\n'));
  addRunGraphEdge(doc, { from: 'a', outcome: 'retry', to: 'a' });
  const written = writeRunGraphYaml(doc);
  expect(parse(written).edges[0].map).toEqual({ ok: 'b', retry: 'a' });
  expect(written).toContain('map: { ok: b, retry: a } # keep');
});

test('a flow map whose closing brace follows a comment falls back without losing the new outcome', () => {
  const input = mini('  - from: a\n    on: outcome\n    map: { ok: b # keep\n    }\n');
  const doc = readRunGraphYaml(input);
  const originalDebug = console.debug;
  const calls: unknown[][] = [];
  console.debug = (...args: unknown[]) => { calls.push(args); };
  try {
    addRunGraphEdge(doc, { from: 'a', outcome: 'fail', to: 'c' });
    const written = writeRunGraphYaml(doc);
    expect(parse(written).edges[0].map).toEqual({ ok: 'b', fail: 'c' });
    expect(calls).toContainEqual(['run-graph-yaml', 'fallback-to-string', { reason: 'flow-map-comment-before-close' }]);
  } finally {
    console.debug = originalDebug;
  }
});

test('multiple new flow outcomes survive one save', () => {
  const doc = readRunGraphYaml(mini('  - from: a\n    on: outcome\n    map: { ok: b }\n'));
  addRunGraphEdge(doc, { from: 'a', outcome: 'fail', to: 'c' });
  addRunGraphEdge(doc, { from: 'a', outcome: 'retry', to: 'd' });
  expect(parse(writeRunGraphYaml(doc)).edges[0].map).toEqual({ ok: 'b', fail: 'c', retry: 'd' });
});

test('a new outcome in a block map before its sibling retains its parent', () => {
  const input = 'edges:\n  - from: a\n    on: outcome\n    map:\n      ok: b\n    observed: 1 # keep\n';
  const doc = readRunGraphYaml(input);
  addRunGraphEdge(doc, { from: 'a', outcome: 'fail', to: 'c' });
  const written = writeRunGraphYaml(doc);
  expect(parse(written).edges[0]).toEqual({ from: 'a', on: 'outcome', map: { ok: 'b', fail: 'c' }, observed: 1 });
  expect(written).toContain('observed: 1 # keep');
});

test('multiple new keys in the same existing map survive a single save', () => {
  const doc = readRunGraphYaml(mini('  - from: a\n    on: outcome\n    map:\n      ok: b\n'));
  addRunGraphEdge(doc, { from: 'a', outcome: 'fail', to: 'c' });
  addRunGraphEdge(doc, { from: 'a', outcome: 'retry', to: 'd' });
  expect(parse(writeRunGraphYaml(doc)).edges[0].map).toEqual({ ok: 'b', fail: 'c', retry: 'd' });
});

test('a new outcome key with YAML punctuation round-trips without damaging its neighbor', () => {
  const doc = readRunGraphYaml(mini('  - from: a\n    on: outcome\n    map: { ok: b }\n'));
  addRunGraphEdge(doc, { from: 'a', outcome: 'retry:later', to: 'c' });
  expect(parse(writeRunGraphYaml(doc)).edges[0].map).toEqual({ ok: 'b', 'retry:later': 'c' });
});

test('adding to a map nested two levels deep keeps the new value', () => {
  const doc = readRunGraphYaml('edges:\n  - from: a\n    on: outcome\n    map:\n      ok: b\n');
  addRunGraphEdge(doc, { from: 'a', outcome: 'retry', to: 'c' });
  const written = writeRunGraphYaml(doc);
  expect(parse(written).edges[0].map).toEqual({ ok: 'b', retry: 'c' });
  expect(written).toContain('      retry: c');
});

test('removing an existing flow outcome keeps its sibling and untouched bytes', () => {
  const input = 'edges:\n  - from: a\n    on: outcome\n    map: { ok: b, fail: c } # keep\n\n';
  const doc = readRunGraphYaml(input);
  removeRunGraphEdge(doc, 'a', 'fail');
  const written = writeRunGraphYaml(doc);
  expect(parse(written).edges[0].map).toEqual({ ok: 'b' });
  expect(written).toBe(input.replace(', fail: c', ''));
  const first = readRunGraphYaml(input);
  removeRunGraphEdge(first, 'a', 'ok');
  expect(parse(writeRunGraphYaml(first)).edges[0].map).toEqual({ fail: 'c' });
});

test('an empty flow map falls back instead of discarding its new outcome', () => {
  const doc = readRunGraphYaml(mini('  - from: a\n    on: outcome\n    map: {}\n'));
  const originalDebug = console.debug;
  const calls: unknown[][] = [];
  console.debug = (...args: unknown[]) => { calls.push(args); };
  try {
    addRunGraphEdge(doc, { from: 'a', outcome: 'fail', to: 'c' });
    expect(parse(writeRunGraphYaml(doc)).edges[0].map.fail).toBe('c');
    expect(calls).toContainEqual(['run-graph-yaml', 'fallback-to-string', { reason: 'missing-map-range' }]);
  } finally {
    console.debug = originalDebug;
  }
});

test('the failure picker is blocked on a non-outcome edge and converts only through its own path', () => {
  const blocked = readRunGraphYaml(mini('  - { from: a, on: changed-files, map: { docs: b } }\n'));
  expect(runGraphFailRouteBlocked(blocked, 'a')).toContain('changed-files');
  expect(() => setRunGraphFailTarget(blocked, 'a', 'c')).toThrow('failure route requires an outcome edge');
  const plain = readRunGraphYaml(mini('  - { from: a, to: b }\n'));
  expect(runGraphFailRouteBlocked(plain, 'a')).toBeNull();
  setRunGraphFailTarget(plain, 'a', 'c');
  expect(parse(writeRunGraphYaml(plain)).edges).toEqual([{ from: 'a', on: 'outcome', map: { ok: 'b', fail: 'c' } }]);
});
