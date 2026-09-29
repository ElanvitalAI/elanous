import { expect, test } from 'bun:test';
import { graphEditorHref, resolveGraphEditorMode } from './graph-editor-mode';
import { createNexusClient } from '@/nexus/client';

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
