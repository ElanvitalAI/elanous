import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectWorkflowDir } from '../../workflow-runtime/discovery.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { listWorkflowHistory } from './workflow-history.js';
import { handleWorkflowHistoryList, handleWorkflowHistoryVersionGet } from './workflows.js';
import { debug } from '../../debug/log.js';

const oldCwd = process.cwd();
const roots: string[] = [];
afterEach(() => {
  process.chdir(oldCwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const oldYaml = 'name: my-flow\nnodes:\n  - id: start\n    manualTrigger: {}\n';
const newYaml = `${oldYaml}description: edited\n`;

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'workflow-history-routes-'));
  roots.push(cwd);
  process.chdir(cwd);
  const dir = getProjectWorkflowDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'my-flow.yaml');
  writeFileSync(file, oldYaml);
  return { cwd, dir, file };
}

function request(path: string, method = 'GET', yaml?: string, authorized = true): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: authorized ? { authorization: 'Bearer owner', 'content-type': 'application/json' } : {},
    ...(yaml === undefined ? {} : { body: JSON.stringify({ yaml }) }),
  });
}

async function dispatch(req: Request): Promise<Response> {
  return (await routeRequest(req, { metaApi: { bearerToken: 'owner' } } as NexusHttpServerOpts,
    {} as Parameters<typeof routeRequest>[2], null, createDevProxyRuntimeRef()))!;
}

test('owner-only history list/version routes preserve old YAML and report missing versions', async () => {
  const { cwd, file } = fixture();
  const path = '/v1/workflows/my-flow';
  expect((await dispatch(request(`${path}/history`, 'GET', undefined, false))).status).toBe(401);
  expect(handleWorkflowHistoryList(request(`${path}/history`, 'GET', undefined, false), 'my-flow', { bearerToken: 'owner' }).status).toBe(401);
  expect((await dispatch(request(`${path}/history/missing`, 'GET', undefined, false))).status).toBe(401);
  expect(handleWorkflowHistoryVersionGet(request(`${path}/history/missing`, 'GET', undefined, false), 'my-flow', 'missing', { bearerToken: 'owner' }).status).toBe(401);
  expect((await dispatch(request(path, 'PUT', newYaml))).status).toBe(200);
  expect(readFileSync(file, 'utf8')).toBe(newYaml);
  const versions = listWorkflowHistory('my-flow', { cwd });
  expect(versions).toHaveLength(1);
  const list = await dispatch(request(`${path}/history`));
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ versions });
  const version = await dispatch(request(`${path}/history/${encodeURIComponent(versions[0]!.id)}`));
  expect(version.status).toBe(200);
  expect(await version.json()).toEqual({ yaml: oldYaml });
  const missing = await dispatch(request(`${path}/history/missing`));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'not_found', name: 'my-flow', id: 'missing' });
  expect((await dispatch(request(`${path}/history/%2e%2e%5coutside`))).status).toBe(400);
});

test('history handlers and routes reject authenticated non-GET requests', async () => {
  const { cwd } = fixture();
  const path = '/v1/workflows/my-flow';
  expect((await dispatch(request(path, 'PUT', newYaml))).status).toBe(200);
  const versions = listWorkflowHistory('my-flow', { cwd });
  expect(versions).toHaveLength(1);
  for (const method of ['POST', 'DELETE']) {
    const listReq = request(`${path}/history`, method);
    const list = await dispatch(listReq);
    expect(list.status).toBe(405);
    expect(await list.json()).toEqual({ error: 'method-not-allowed', method });
    expect(handleWorkflowHistoryList(request(`${path}/history`, method), 'my-flow', { bearerToken: 'owner' }).status).toBe(405);

    const versionPath = `${path}/history/${encodeURIComponent(versions[0]!.id)}`;
    const version = await dispatch(request(versionPath, method));
    expect(version.status).toBe(405);
    expect(await version.json()).toEqual({ error: 'method-not-allowed', method });
    expect(handleWorkflowHistoryVersionGet(request(versionPath, method), 'my-flow', versions[0]!.id, { bearerToken: 'owner' }).status).toBe(405);
  }
  expect(listWorkflowHistory('my-flow', { cwd })).toEqual(versions);
});

test('failed snapshots do not alter accepted or rejected PUT status/body', async () => {
  const { cwd, dir, file } = fixture();
  writeFileSync(join(dir, '.history'), 'not a directory');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const accepted = await dispatch(request('/v1/workflows/my-flow', 'PUT', newYaml));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, path: file, scope: 'project' });
    expect(readFileSync(file, 'utf8')).toBe(newYaml);
    expect(log).toHaveBeenCalledWith('nexus.workflow-history', 'snapshot-failed',
      expect.objectContaining({ name: 'my-flow', scope: 'project' }), { level: 'warn' });
    const rejected = await dispatch(request('/v1/workflows/my-flow', 'PUT', 'invalid: yaml\n'));
    expect(rejected.status).toBe(422);
    expect((await rejected.json() as { error: string }).error).toBe('invalid_workflow');
    expect(readFileSync(file, 'utf8')).toBe(newYaml);
    expect(listWorkflowHistory('my-flow', { cwd })).toEqual([]);
  } finally {
    log.mockRestore();
  }
});
