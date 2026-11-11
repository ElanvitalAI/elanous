import { expect, test } from 'bun:test';
import type { GraphRunState } from '../src/graph-runner/runner.js';
import type { ViewLedgers } from '../plugins/graph-instance-view/handlers/project-ledgers.js';
import { handleGraphInstanceViewGet } from '../plugins/graph-instance-view/handlers/http-get.js';
import { routeRequest } from '../src/nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../src/nexus/api/admin-dev-proxy.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listGraphRuns } from '../src/graph-runner/runner.js';
import { loadRunLedger } from '../src/self-implement/run-ledger.js';
import { runLedgerDir } from '../src/self-implement/run-ledger-paths.js';
import { readResourceLedger, resourceLedgerPath } from '../src/resource-ledger/resource-ledger.js';
import { projectGraphRun, projectResources, projectView, readCloudStatesAsync } from '../plugins/graph-instance-view/handlers/project-ledgers.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { setUserConfigOverlay } from '../src/user-config.js';

const at = '2026-11-10T07:00:00.000Z';
const fakeGraph: GraphRunState = { graphId: 'demo', runId: 'g1', startedAt: at, status: 'running', path: ['plan'],
  nodes: [{ nodeId: 'plan', ok: true, exit: 0, executed: true }], currentNode: { nodeId: 'build', startedAt: at },
  executed: 1, dryRun: false, statePath: '/fake/graph-runs/demo/g1.json' };
const fakeRelease: GraphRunState = { ...fakeGraph, graphId: 'release-loop', runId: 'r1', status: 'failed',
  path: ['gate'], nodes: [{ nodeId: 'gate', ok: false, exit: 1, executed: true }], currentNode: undefined };
const ledgers: ViewLedgers = {
  graphRuns: () => [fakeGraph, fakeRelease],
  harness: id => id === 'h1' ? [
    { runId: id, timestamp: at, event: 'node-enter', data: { nodeId: 'read' } },
    { runId: id, timestamp: at, event: 'node-exit', data: { nodeId: 'read' } },
    { runId: id, timestamp: at, event: 'node-enter', data: { nodeId: 'review' } },
  ] : null,
  resources: () => [{ event: 'lease-created', at, lease: { id: 'l1', fp: 'fp_123456', host: 'aws1', lane: 'gate',
    resources: {}, mission: { cell: 'R-SURFACE' }, ttlMs: 1000, heartbeatAt: at, startedAt: at } }],
  hosts: () => ['aws1', 'mbp'], now: () => at,
  cloudStates: () => ({ aws1: 'stopped' }),
};
const get = (query: string) => handleGraphInstanceViewGet(new Request(`http://localhost/v1/graph-instance-view?${query}`), { operator: true }, ledgers);

test('graph edges are taken only for adjacent path transitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-instance-path-'));
  try {
    const graphPath = join(root, 'graph.yaml');
    writeFileSync(graphPath, 'graph_id: demo\nversion: 1\nentry_node: a\nterminal_nodes: [c]\nnodes: [{ node_id: a, kind: gate, recipe: none, max_visits: 2 }, { node_id: b, kind: gate, recipe: none, max_visits: 2 }, { node_id: c, kind: gate, recipe: none, max_visits: 2 }]\nedges: [{ from: a, to: b }, { from: a, to: c }, { from: b, to: c }]\n');
    const view = projectGraphRun({ ...fakeGraph, graphPath, path: ['a', 'b', 'c'] }, 'graph', at);
    expect(view.edges.find(edge => edge.from === 'a' && edge.to === 'c')?.state).toBe('planned');
    expect(view.edges.find(edge => edge.from === 'b' && edge.to === 'c')?.state).toBe('taken');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('delayed cloud status command does not block timers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-instance-cloud-'));
  try {
    const command = join(root, 'status');
    writeFileSync(command, '#!/bin/sh\nsleep 0.2\necho "aws1 x x x x running"\n');
    chmodSync(command, 0o755);
    const pending = readCloudStatesAsync(command, ['aws1']);
    let completed = false;
    void pending.then(() => { completed = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    expect(completed).toBe(false);
    expect(await pending).toEqual({ aws1: 'on' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resource projection includes the measured local host outside the configured fleet', () => {
  const view = projectResources([], [], at, { host: 'newhost', cpuCores: 4, loadavg: [1, 0, 0],
    memory: { usedBytes: 512, totalBytes: 1024 } });
  expect(view.nodes.find(node => node.id === 'newhost')).toMatchObject({ state: 'on',
    resource: { hostKind: 'local', cpuCores: 4, memory: { usedBytes: 512, totalBytes: 1024 } } });
});

test('fake graph, harness, release and resource ledgers project one JSON v1 shape', async () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dir, '../plugins/graph-instance-view/schema/view-model.v1.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const cases = [
    ['source=graph&graphId=demo&runId=g1', 'graph', 'running'],
    ['source=harness&runId=h1', 'harness', 'running'],
    ['source=release&graphId=release-loop&runId=r1', 'release', 'failed'],
    ['source=resource', 'resource', 'unknown'],
  ];
  for (const [query, source, state] of cases) {
    const response = get(query!);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-graph-instance-view-version')).toBe('1');
    const view = await response.json();
    expect(validate(view), JSON.stringify(validate.errors)).toBe(true);
    expect(view.schemaVersion).toBe(1);
    expect(view.instance.source).toBe(source);
    expect(view.instance.state).toBe(state);
    expect(view.instance.observedAt).toBe(at);
    expect(Array.isArray(view.nodes)).toBe(true);
    expect(Array.isArray(view.edges)).toBe(true);
    expect(Array.isArray(view.logs)).toBe(true);
  }
  const resource = await get('source=resource').json();
  expect(resource.nodes.find((node: { id: string }) => node.id === 'aws1').resource.tasks[0].kind).toBe('gate');
  expect(resource.nodes.find((node: { id: string }) => node.id === 'aws1').state).toBe('stopped');
});

test('route rejects malformed identities and contains ledger errors', async () => {
  expect(get('source=graph&graphId=../secret&runId=g1').status).toBe(400);
  expect(get('source=resource&runId=x').status).toBe(400);
  expect(get('source=release&graphId=demo&runId=r1').status).toBe(400);
  expect(get('source=graph&runId=g1').status).toBe(200);
  expect(get('source=release&runId=r1').status).toBe(200);
  expect(get('source=harness&runId=missing').status).toBe(404);
  const failing: ViewLedgers = { ...ledgers, graphRuns: () => { throw new Error('/private/ledger/path'); } };
  const response = handleGraphInstanceViewGet(new Request('http://localhost/v1/graph-instance-view?source=graph&graphId=demo&runId=g1'), { operator: true }, failing);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('/private/ledger/path');
});

test('Nexus requires owner bearer and operator status for fleet data', async () => {
  const options = { metaApi: { bearerToken: 'owner', noAuth: false } } as never;
  const url = 'http://127.0.0.1/v1/graph-instance-view?source=resource';
  const denied = await routeRequest(new Request(url), options, {} as never, null, createDevProxyRuntimeRef());
  expect(denied?.status).toBe(401);
  const owner = () => routeRequest(new Request(url, { headers: { authorization: 'Bearer owner' } }),
    options, {} as never, null, createDevProxyRuntimeRef());
  expect((await owner())?.status).toBe(403);
  const dir = mkdtempSync(join(tmpdir(), 'graph-instance-operator-'));
  const secret = join(dir, 'operator-secret');
  writeFileSync(secret, 'op-proxy-secret-0123456789abcdef'); chmodSync(secret, 0o600);
  setUserConfigOverlay(cfg => ({ ...cfg, raw: { ...cfg.raw, operator: { enabled: true, proxySecretFile: secret } } }));
  try {
    const accepted = await owner();
    expect(accepted?.status).toBe(200);
    expect((await accepted?.json() as { schemaVersion: number }).schemaVersion).toBe(1);
    const proxy = await routeRequest(new Request(url, { headers: { 'x-elanous-operator': 'op-proxy-secret-0123456789abcdef' } }),
      options, {} as never, null, createDevProxyRuntimeRef());
    expect(proxy?.status).toBe(401);
    const forged = await routeRequest(new Request(url, { headers: { 'x-elanous-operator': 'forged-forged-forged-forged' } }),
      options, {} as never, null, createDevProxyRuntimeRef());
    expect(forged?.status).toBe(401);
  } finally { setUserConfigOverlay(null); rmSync(dir, { recursive: true, force: true }); }
});

test('real readers project isolated JSON and JSONL ledgers without changing their bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-instance-ledgers-'));
  try {
    const graphDir = join(root, 'graph-runs', 'demo');
    const harnessDir = runLedgerDir(root);
    const resourceFile = resourceLedgerPath(root);
    mkdirSync(graphDir, { recursive: true });
    mkdirSync(harnessDir, { recursive: true });
    mkdirSync(join(root, 'resource-ledger'), { recursive: true });
    const files = [join(graphDir, 'g1.json'), join(harnessDir, 'h1.jsonl'), resourceFile];
    writeFileSync(files[0]!, JSON.stringify(fakeGraph));
    writeFileSync(files[1]!, JSON.stringify({ runId: 'h1', timestamp: at, event: 'node-enter', data: { nodeId: 'read' } }) + '\n');
    writeFileSync(files[2]!, JSON.stringify(ledgers.resources()[0]) + '\n');
    const digest = () => files.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
    const before = digest();
    const observed: ViewLedgers = {
      graphRuns: () => listGraphRuns(root).runs,
      harness: id => loadRunLedger(id, harnessDir),
      resources: () => readResourceLedger(resourceFile),
      hosts: () => ['aws1'], now: () => at,
    };
    expect(projectView({ source: 'graph', graphId: 'demo', runId: 'g1' }, observed)?.nodes.map(node => node.id)).toContain('plan');
    expect(projectView({ source: 'harness', runId: 'h1' }, observed)?.nodes.map(node => node.id)).toContain('read');
    expect(projectView({ source: 'resource' }, observed)?.nodes.find(node => node.id === 'aws1')?.resource?.tasks[0]?.kind).toBe('gate');
    expect(digest()).toEqual(before);
    expect(readdirSync(graphDir)).toEqual(['g1.json']);
    expect(readdirSync(harnessDir)).toEqual(['h1.jsonl']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
