import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { listGraphRuns } from '../../graph-runner/runner.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { resetUserConfig } from '../../user-config.js';

const roots: string[] = [];
const priorStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  resetElanousConfigDir();
  resetUserConfig();
  if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = priorStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-api-trigger-contract-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ operator: { enabled: true, proxySecretFile: join(root, 'unused-secret') } }));
  resetUserConfig();
  const plugin = join(root, 'plugins', 'local', 'fixture', '1.0.0');
  mkdirSync(plugin, { recursive: true });
  const graph = join(plugin, 'flow.yaml');
  const graphYaml = `graph_id: fixture
version: 1
triggers:
  api:
    auth: operator
    run_scope: instance
    input_schema:
      type: object
      required: [item]
      properties:
        item: { type: string }
entry_node: done
terminal_nodes: [done]
nodes:
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges: []
`;
  writeFileSync(graph, graphYaml);
  writeFileSync(join(plugin, 'recipes.yaml'), '{}\n');
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', extensions: {
    'ai.elanous': { graphs: ['./flow.yaml'], graphManifests: { fixture: {
      purpose: 'Isolated API trigger contract', allow: { recipes: [] }, hitl: [],
    } } },
  } }));
  const call = (body: string, key: string, token?: string) => {
    const bus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    state.bus = bus;
    return routeRequest(new Request('http://localhost/v1/graph-plugins/fixture/run', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'idempotency-key': key, 'sec-fetch-site': 'cross-site',
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }), { state, registry: new TabRegistry(state), eventBus: bus,
      metaApi: { bearerToken: 'owner-secret', noAuth: false } },
    { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  };
  return { root, graph, graphYaml, call };
}

test('Request to declared API trigger runs once in the instance; rejected requests dispatch zero', async () => {
  const { root, graph, graphYaml, call } = fixture();
  const runs = () => listGraphRuns(root).runs.filter(run => run.graphId === 'fixture');
  expect((await call('{"item":"ok"}', 'request-0001'))?.status).toBe(403);
  expect((await call('{"item":1}', 'request-0001', 'owner-secret'))?.status).toBe(422);
  expect((await call('{"item":"ok"}', 'short', 'owner-secret'))?.status).toBe(400);
  expect(runs()).toHaveLength(0);

  writeFileSync(graph, graphYaml.replace('run_scope: instance', 'run_scope: global'));
  expect((await call('{"item":"ok"}', 'request-0001', 'owner-secret'))?.status).toBe(503);
  expect(runs()).toHaveLength(0);
  writeFileSync(graph, graphYaml);

  const started = await call('{"item":"ok"}', 'request-0001', 'owner-secret');
  expect(started?.status).toBe(202);
  const { runId } = await started!.json() as { runId: string };
  expect(runId).toBeString();
  const duplicate = await call('{"item":"ok"}', 'request-0001', 'owner-secret');
  expect(duplicate?.status).toBe(202);
  expect((await duplicate!.json()).runId).toBe(runId);
  expect((await call('{"item":"changed"}', 'request-0001', 'owner-secret'))?.status).toBe(409);
  const runFile = join(root, 'graph-runs', 'fixture', `${runId}.json`);
  let saved: { input: unknown; status: string } | undefined;
  for (let i = 0; i < 100; i++) {
    try { saved = JSON.parse(readFileSync(runFile, 'utf8')) as { input: unknown; status: string }; }
    catch { /* registration can precede the first run-state write */ }
    if (saved?.status === 'done' || saved?.status === 'failed') break;
    await Bun.sleep(10);
  }
  expect(runs()).toHaveLength(1);
  expect(saved?.status).toBe('done');
  expect(saved?.input).toEqual({ item: 'ok' });
});
