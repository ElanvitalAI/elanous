import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { handleGraphsClone, handleGraphsGet, handleGraphsPut } from './graphs-api.js';
import { defaultGraphsDir } from '../../self-implement/graph-templates.js';

const headers = { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' };

function request(path: string, method = 'GET', authorized = true) {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  return routeRequest(new Request(`http://localhost${path}`, { method, headers: authorized ? headers : { 'sec-fetch-site': 'cross-site' } }), {
    state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false },
  }, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
}

test('GET /v1/graphs reads real YAML, retains labelled research branches and denies anonymous or write requests', async () => {
  const list = await request('/v1/graphs');
  expect(list?.status).toBe(200);
  const graphs = (await list!.json() as { graphs: Array<{ id: string; source: string; editable: boolean; nodeCount: number }> }).graphs;
  expect(graphs).toContainEqual({ id: 'research-loop', source: 'core', editable: false, nodeCount: 7 });

  const response = await request('/v1/graphs/research-loop');
  expect(response?.status).toBe(200);
  const detail = await response!.json() as {
    entry_node: string; terminal_nodes: string[];
    nodes: Array<{ node_id: string; kind: string; recipe: string; max_visits: number }>;
    edges: Array<{ from: string; on?: string; map?: Record<string, string> }>;
  };
  expect(detail.entry_node).toBe('investigate');
  expect(detail.terminal_nodes).toContain('merge');
  expect(detail.nodes).toContainEqual({ node_id: 'investigate', kind: 'agent', recipe: 'headless-goal-loop', max_visits: 7 });
  expect(detail.edges.find((edge) => edge.from === 'investigate')).toMatchObject({
    on: 'changed-files', map: { 'code-changed': 'gate', 'documents-only': 'judge', unknown: 'gate' },
  });
  expect((await request('/v1/graphs', 'GET', false))?.status).toBe(401);
  expect((await request('/v1/graphs/research-loop', 'GET', false))?.status).toBe(401);
  for (const method of ['POST', 'PUT', 'DELETE']) expect((await request('/v1/graphs/research-loop', method))?.status).toBe(405);
  expect((await request('/v1/graphs/not-present'))?.status).toBe(404);
  expect((await request('/v1/graphs/%2Fetc%2Fpasswd'))?.status).toBe(404);
});

test('missing YAML directory does not expose built-in fallback as core graph', async () => {
  const response = handleGraphsGet('/v1/graphs', '/nonexistent-core-graphs', { mineDir: '/nonexistent-mine-graphs' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'graphs-unavailable' });
});

test('PUT of a core id is refused and a clone can be saved then listed as mine', async () => {
  const mineDir = mkdtempSync(join(tmpdir(), 'elanous-mine-graphs-'));
  const coreDir = defaultGraphsDir();
  const deps = { coreDir, mineDir };
  const coreYaml = await handleGraphsGet('/v1/graphs/research-loop/yaml', coreDir, deps);
  expect(coreYaml.status).toBe(200);
  const original = (await coreYaml.json() as { yaml: string }).yaml;
  expect(original).toBe(readFileSync(join(coreDir, 'research-loop.yaml'), 'utf8'));

  const refused = await handleGraphsPut('/v1/graphs/research-loop/yaml', new Request('http://localhost/v1/graphs/research-loop/yaml', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: original }),
  }), deps);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: 'core-read-only', id: 'research-loop' });
  expect(readFileSync(join(coreDir, 'research-loop.yaml'), 'utf8')).toBe(original);

  const cloned = await handleGraphsClone('/v1/graphs/research-loop/clone', new Request('http://localhost/v1/graphs/research-loop/clone', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newId: 'research-loop-mine' }),
  }), deps);
  expect(cloned.status).toBe(201);
  const copied = readFileSync(join(mineDir, 'research-loop-mine.yaml'), 'utf8');
  expect(copied.replace('graph_id: research-loop-mine', 'graph_id: research-loop')).toBe(original);

  const savedText = copied.replace('max_visits: 7', 'max_visits: 8');
  const saved = await handleGraphsPut('/v1/graphs/research-loop-mine/yaml', new Request('http://localhost/v1/graphs/research-loop-mine/yaml', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: savedText }),
  }), deps);
  expect(saved.status).toBe(200);
  const list = await handleGraphsGet('/v1/graphs', coreDir, deps);
  const graphs = (await list.json() as { graphs: Array<{ id: string; source: string; editable: boolean }> }).graphs;
  expect(graphs).toContainEqual(expect.objectContaining({ id: 'research-loop', source: 'core', editable: false }));
  expect(graphs).toContainEqual(expect.objectContaining({ id: 'research-loop-mine', source: 'mine', editable: true }));
  expect((await handleGraphsGet('/v1/graphs/research-loop-mine/yaml', coreDir, deps)).status).toBe(200);

  const broken = await handleGraphsPut('/v1/graphs/research-loop-mine/yaml', new Request('http://localhost/v1/graphs/research-loop-mine/yaml', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: 'graph_id: research-loop-mine\n' }),
  }), deps);
  expect(broken.status).toBe(400);
  expect(await broken.json()).toMatchObject({ error: 'invalid-graph' });
  expect((await handleGraphsPut('/v1/graphs/%2Fetc%2Fpasswd/yaml', new Request('http://localhost', { method: 'PUT', body: '{}' }), deps)).status).toBe(400);
});
