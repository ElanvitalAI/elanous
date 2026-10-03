import { afterAll, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { ReactFlow } from '@xyflow/react';
import type { GraphKindEntry } from '@/nexus/client';
import { workflowToLayout, type WorkflowDefinitionLike } from './workflow-graph-layout';
import { DRAG_MIME, addNodeAt, decodeDrag, encodeDrag } from './graph-drop';
import { MINIMAP_MIN_NODES, WorkflowGraph, droppedEntry, showMiniMap } from './WorkflowGraph';

const core: GraphKindEntry = { graph: 'workflow', kind: 'bash', core: true, plugin: null, description: 'Shell' };
const plugin: GraphKindEntry = { graph: 'workflow', kind: 'demo:step', core: false, plugin: 'demo', description: 'Step' };

const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousWindow = globals.window;
const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
globals.window = { addEventListener: () => undefined, removeEventListener: () => undefined };
globals.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
  else globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

test('drag payload round-trips known entries and rejects malformed or unknown values', () => {
  expect(DRAG_MIME).toBe('application/x-elanous-node');
  expect(decodeDrag(encodeDrag(core))).toEqual(core);
  expect(decodeDrag(encodeDrag(plugin))).toEqual(plugin);
  for (const invalid of ['', '{broken', 'null', '[]', '{}',
    '{"graph":"harness","kind":"bash","core":true,"description":"x"}',
    '{"graph":"workflow","kind":"surprise","core":true,"description":"x"}',
    '{"graph":"workflow","kind":"not-a-plugin","core":false,"description":"x"}',
  ]) expect(decodeDrag(invalid)).toBeNull();
});

test('addNodeAt inserts one fresh node at the dropped coordinates without changing existing nodes', () => {
  const original: WorkflowDefinitionLike = {
    name: 'example', nodes: [{ id: 'bash-1', bash: 'echo hi' }],
    _meta: { layout: { 'bash-1': { x: 4, y: 5 } } },
  };
  const { def, id } = addNodeAt(original, core, { x: 143.6, y: -20.2 });
  expect(id).toBe('bash-2');
  expect(def.nodes).toHaveLength(2);
  expect(def.nodes[0]).toEqual(original.nodes[0]);
  expect(def.nodes[1]).toEqual({ id, bash: 'echo todo' });
  expect((def._meta as { layout: Record<string, unknown> }).layout).toEqual({
    'bash-1': { x: 4, y: 5 }, 'bash-2': { x: 144, y: -20 },
  });
  expect(workflowToLayout(def).nodes.find((n) => n.id === id)?.position).toEqual({ x: 144, y: -20 });
  expect(original.nodes).toHaveLength(1);
  expect(original._meta).toEqual({ layout: { 'bash-1': { x: 4, y: 5 } } });
  const inserted = addNodeAt(def, plugin, { x: 32, y: 60 });
  expect(inserted.def.nodes.at(-1)).toEqual({ id: inserted.id, kind: 'demo:step', inputs: {} });
  expect((inserted.def._meta as { layout: Record<string, unknown> }).layout[inserted.id]).toEqual({ x: 32, y: 60 });
});

function definition(count: number): WorkflowDefinitionLike {
  return { name: 'example', nodes: Array.from({ length: count }, (_, i) => ({ id: `bash-${i + 1}`, bash: 'echo hi' })) };
}

// ⚠️ React Flow with nodes loops («Maximum update depth») under react-test-renderer with the minimal window stub, so the canvas is exercised through exported helpers ⊕ the empty-graph panel, and the real
// drag is checked live in a browser (W3c harvest).

test('palette chips are draggable and carry the palette MIME; click-to-add still works', async () => {
  let yaml = '';
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(WorkflowGraph, { yaml: 'name: example\nnodes: []\n', definition: definition(0), editable: true, palette: [core], onChangeYaml: (value: string) => { yaml = value; } })); });
  const button = renderer.root.findAllByType('button').find((b) => b.children.includes('+ bash'))!;
  expect(button.props.draggable).toBe(true);
  const sent: Record<string, string> = {};
  button.props.onDragStart({ dataTransfer: { setData: (key: string, value: string) => { sent[key] = value; }, effectAllowed: '' } });
  expect(decodeDrag(sent[DRAG_MIME])).toEqual(core);
  button.props.onClick(); // outside act: the one-node graph is not committed, so React Flow does not mount
  expect(yaml).toContain('bash-1');
  await act(async () => renderer.unmount());
});

test('droppedEntry accepts only our MIME and entries this palette offers', () => {
  const ours = (value: string, types = [DRAG_MIME]) => ({ dataTransfer: { types, getData: () => value } });
  expect(droppedEntry(ours(encodeDrag(core)), [core])).toEqual(core);
  expect(droppedEntry(ours(encodeDrag(core), ['text/plain']), [core])).toBeNull();
  expect(droppedEntry(ours('{broken'), [core])).toBeNull();
  expect(droppedEntry(ours(encodeDrag(plugin)), [core])).toBeNull();
  expect(droppedEntry(ours(encodeDrag(plugin)), [core, plugin])).toEqual(plugin);
  expect(droppedEntry(ours(encodeDrag(core)), undefined)).toEqual(core);
  expect(droppedEntry(ours(encodeDrag(plugin)), undefined)).toBeNull();
});

test('empty editable canvas takes a palette drop and places the first node at the origin', async () => {
  let yaml = '';
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(WorkflowGraph, { yaml: 'name: example\nnodes: []\n', definition: definition(0), editable: true, palette: [core], onChangeYaml: (value: string) => { yaml = value; } })); });
  expect(renderer.root.findAllByType(ReactFlow)).toHaveLength(0);
  const panel = renderer.root.find((n) => typeof n.props.onDrop === 'function');
  let prevented = 0;
  panel.props.onDragOver({ dataTransfer: { types: ['text/plain'], dropEffect: '' }, preventDefault: () => { prevented++; } });
  expect(prevented).toBe(0);
  panel.props.onDragOver({ dataTransfer: { types: [DRAG_MIME], dropEffect: '' }, preventDefault: () => { prevented++; } });
  expect(prevented).toBe(1);
  panel.props.onDrop({ dataTransfer: { types: [DRAG_MIME], getData: () => encodeDrag(core) }, preventDefault: () => {} }); // outside act (see above)
  expect(yaml).toContain('bash-1');
  expect(yaml).toContain('x: 0');
  await act(async () => renderer.unmount());
});

test('read-only empty canvas has no palette and ignores drops', async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(WorkflowGraph, { yaml: 'name: example\nnodes: []\n', definition: definition(0), editable: false, palette: [core], onChangeYaml: () => { throw new Error('read-only mutation'); } })); });
  expect(renderer.root.findAllByType('button').filter((b) => b.children.includes('+ bash'))).toHaveLength(0);
  const panel = renderer.root.find((n) => typeof n.props.onDrop === 'function');
  let prevented = false;
  const event = { dataTransfer: { types: [DRAG_MIME], getData: () => encodeDrag(core), dropEffect: '' }, preventDefault: () => { prevented = true; } };
  panel.props.onDragOver(event);
  panel.props.onDrop(event);
  expect(prevented).toBe(false);
  await act(async () => renderer.unmount());
});

test('minimap shows from ten nodes', () => {
  expect(MINIMAP_MIN_NODES).toBe(10);
  expect(showMiniMap(9)).toBe(false);
  expect(showMiniMap(10)).toBe(true);
});
