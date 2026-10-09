import { expect, test } from 'bun:test';
import { GRAPH_EDITOR_NODE_GROUPS, graphEditorHref, graphEditorNodeGroups, resolveGraphEditorMode } from './graph-editor-mode';
import { createNexusClient, type GraphKindEntry } from '@/nexus/client';
import { CORE_GRAPH_KINDS, CORE_WORKFLOW_KINDS } from '@/lib/run-graph-yaml-edit';

test('mode query selects harness and defaults unknown or absent values to workflow', () => {
  expect(resolveGraphEditorMode('harness')).toBe('harness');
  expect(resolveGraphEditorMode('workflow')).toBe('workflow');
  expect(resolveGraphEditorMode('other')).toBe('workflow');
  expect(resolveGraphEditorMode(null)).toBe('workflow');
});

test('mode links preserve the chosen graph vocabulary in the address', () => {
  expect(graphEditorHref('workflow')).toBe('/app/editor/?mode=workflow');
  expect(graphEditorHref('harness')).toBe('/app/editor/?mode=harness');
});

test('node groups put workflow tasks and harness steps on one palette without losing wire graph identity', () => {
  const workflow: GraphKindEntry = { graph: 'workflow', kind: 'task', description: 'task', plugin: null, core: true };
  const harness: GraphKindEntry = { graph: 'harness', kind: 'agent', description: 'agent', plugin: null, core: true };
  const plugin: GraphKindEntry = { graph: 'harness', kind: 'p:custom', description: 'custom', plugin: 'p', core: false };
  const groups = graphEditorNodeGroups([harness, plugin, workflow]);
  expect(GRAPH_EDITOR_NODE_GROUPS.map(({ graph, label }) => ({ graph, label }))).toEqual([
    { graph: 'workflow', label: '작업 노드' },
    { graph: 'harness', label: '실행 단계 노드' },
  ]);
  expect(groups).toEqual([
    { graph: 'workflow', label: '작업 노드', kinds: [workflow], fallback: false },
    { graph: 'harness', label: '실행 단계 노드', kinds: [harness, plugin], fallback: false },
  ]);
  expect(groups[1]?.kinds[1]).toBe(plugin);
});

test('node groups fall back independently to existing core graph kinds', () => {
  const workflow: GraphKindEntry = { graph: 'workflow', kind: 'p:task', description: 'plugin task', plugin: 'p', core: false };
  const groups = graphEditorNodeGroups([workflow]);
  expect(groups[0]).toEqual({ graph: 'workflow', label: '작업 노드', kinds: [workflow], fallback: false });
  expect(groups[1]?.fallback).toBe(true);
  expect(groups[1]?.kinds.map((entry) => entry.kind)).toEqual([...CORE_GRAPH_KINDS]);
  expect(groups[1]?.kinds.every((entry) => entry.graph === 'harness' && entry.plugin === null && entry.core)).toBe(true);
  const empty = graphEditorNodeGroups([]);
  expect(empty.map((group) => group.kinds.map((entry) => entry.kind))).toEqual([
    [...CORE_WORKFLOW_KINDS], [...CORE_GRAPH_KINDS],
  ]);
  expect(empty.map((group) => group.fallback)).toEqual([true, true]);
});

test('graph vocabulary and validation use mode-scoped wire endpoints; 422 returns blocking errors', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client = createNexusClient({ baseUrl: 'http://localhost', fetchImpl: (async (input, init) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(path === '/v1/graphs/validate'
      ? { ok: false, errors: [{ path: 'nodes', message: 'bad kind' }], ignoredKeys: ['extra'] }
      : { kinds: [{ graph: 'harness', kind: 'p:custom', plugin: 'p', description: 'custom', core: false }] },
    { status: path === '/v1/graphs/validate' ? 422 : 200 });
  }) as typeof fetch });
  expect((await client.getGraphKinds('harness')).kinds[0]?.plugin).toBe('p');
  expect(await client.validateGraph('harness', 'graph_id: demo')).toEqual({
    ok: false, errors: [{ path: 'nodes', message: 'bad kind' }], ignoredKeys: ['extra'],
  });
  expect(calls).toEqual([
    { path: '/v1/graph/kinds?graph=harness', method: 'GET', body: null },
    { path: '/v1/graphs/validate', method: 'POST', body: { graph: 'harness', yaml: 'graph_id: demo' } },
  ]);
});
