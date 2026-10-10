import { expect, test } from 'bun:test';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { handleGraphsGet } from './graphs-api.js';
import { registerNodeKind } from '../../graph-kinds/registry.js';

const harnessYaml = `graph_id: example\nversion: 1\nentry_node: a\nterminal_nodes: [a]\nnodes:\n  - node_id: a\n    kind: agent\n    recipe: r\n    max_visits: 1\n    colour: blue\nedges: []\n`;
const workflowYaml = `name: sample\ndescription: Sample workflow\n_meta:\n  missionId: mission:a\n  surprise: x\nnodes:\n  - id: first\n    bash: echo hello\n    colour: blue\n`;

function request(path: string, method = 'GET', body?: unknown, authorized = true) {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  return routeRequest(new Request(`http://localhost${path}`, {
    method, headers: authorized ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'cross-site' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), {
    state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false },
  }, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
}

test('owner-only GET kinds exposes separately scoped core catalogs', async () => {
  const all = await request('/v1/graph/kinds');
  expect(all?.status).toBe(200);
  const entries = (await all!.json() as { kinds: Array<{ graph: string; kind: string; description: string; core: boolean }> }).kinds;
  expect(entries.filter((entry) => entry.graph === 'harness' && entry.core)).toHaveLength(8); // #25170 — prompt 종류가 더해졌다.
  // W8 둘째 조각 #23226 — subworkflow(하위 워크플로 노드)가 core 종류에 더해졌다.
  expect(entries.filter((entry) => entry.graph === 'workflow' && entry.core)).toHaveLength(24);
  expect(entries.every((entry) => entry.description.length > 0)).toBe(true);
  expect((await (await request('/v1/graph/kinds?graph=workflow'))!.json() as { kinds: Array<{ graph: string }> }).kinds.every((entry) => entry.graph === 'workflow')).toBe(true);
  const added = registerNodeKind({ graph: 'workflow', kind: 'palette-probe:node', plugin: 'palette-probe', core: false, description: 'A plugin node', schema: { type: 'object' } });
  expect(added).toEqual({ ok: true });
  const pluginKinds = (await (await request('/v1/graph/kinds?graph=workflow'))!.json() as { kinds: Array<{ kind: string; plugin?: string; schema?: unknown }> }).kinds;
  expect(pluginKinds).toContainEqual(expect.objectContaining({ kind: 'palette-probe:node', plugin: 'palette-probe', schema: { type: 'object' } }));
  expect((await request('/v1/graph/kinds?graph=other'))?.status).toBe(400);
  expect((await request('/v1/graph/kinds', 'GET', undefined, false))?.status).toBe(401);
  expect((await request('/v1/graphs'))?.status).toBe(200);
  expect((await request('/v1/graphs/validate', 'GET'))?.status).toBe(404);
});

test('owner-only POST validation reports dropped harness fields, workflow metadata and parser errors without writing', async () => {
  const harness = await request('/v1/graphs/validate', 'POST', { graph: 'harness', yaml: harnessYaml });
  expect(harness?.status).toBe(200);
  expect(await harness!.json()).toEqual({ ok: true, errors: [], ignoredKeys: ['nodes[0].colour'] });
  const workflow = await request('/v1/graphs/validate', 'POST', { graph: 'workflow', yaml: workflowYaml });
  expect(workflow?.status).toBe(200);
  expect(await workflow!.json()).toEqual({ ok: true, errors: [], ignoredKeys: ['_meta.surprise'] });
  const invalid = await request('/v1/graphs/validate', 'POST', { graph: 'harness', yaml: harnessYaml.replace('kind: agent', 'kind: alien') });
  expect(invalid?.status).toBe(422);
  expect((await invalid!.json() as { errors: Array<{ path: string }> }).errors.some((issue) => issue.path.endsWith('/kind'))).toBe(true);
  expect((await request('/v1/graphs/validate', 'POST', { graph: 'harness', yaml: harnessYaml }, false))?.status).toBe(401);
  expect((await request('/v1/graphs/validate', 'POST', { graph: 'other', yaml: harnessYaml }))?.status).toBe(400);
  expect((await request('/v1/graphs/validate', 'POST', { graph: 'harness' }))?.status).toBe(400);
  expect((await request('/v1/graphs/validate', 'POST', { graph: 'harness', yaml: '[' }))?.status).toBe(422);
  expect((await request('/v1/graphs/validate', 'POST', { graph: 'workflow', yaml: '[' }))?.status).toBe(422);
  expect(JSON.stringify(await (await request('/v1/graphs/research-loop'))!.json())).toBe(JSON.stringify(await handleGraphsGet('/v1/graphs/research-loop').json()));
});
