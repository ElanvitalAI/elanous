import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { listProjects } from '../../project/project-store.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { isPublicRoute } from './public-routes.js';

const token = 'projects-test-owner';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elanous-projects-route-'));
  setElanousConfigDir(root);
});
afterEach(() => {
  resetElanousConfigDir();
  rmSync(root, { recursive: true, force: true });
});

async function request(method: string, body?: unknown, bearer = token): Promise<Response> {
  const req = new Request('http://nexus.test/v1/projects', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const response = await routeRequest(req, { metaApi: { bearerToken: token, noAuth: false } } as NexusHttpServerOpts,
    {} as never, null, createDevProxyRuntimeRef());
  if (!response) throw new Error('no response from projects route');
  return response;
}

test('GET and POST /v1/projects require owner authentication and stay off the public routes', async () => {
  for (const method of ['GET', 'POST']) {
    expect(isPublicRoute(method, '/v1/projects', { setupMode: false })).toBe(false);
    expect(isPublicRoute(method, '/v1/projects', { setupMode: true })).toBe(false);
    const res = await request(method, method === 'POST' ? { name: 'Not written' } : undefined, '');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    const wrongBearer = await request(method, method === 'POST' ? { name: 'Not written' } : undefined, 'wrong-owner');
    expect(wrongBearer.status).toBe(401);
  }
  expect(listProjects()).toEqual([]);
});

test('authenticated POST persists a project and GET lists it from the project store', async () => {
  const folder = join(root, 'source');
  const created = await request('POST', { name: 'A', primaryFolder: folder });
  expect(created.status).toBe(201);
  const { project } = await created.json() as { project: { id: string; name: string; primaryFolder: string; createdAt: string } };
  expect(project).toMatchObject({ name: 'A', primaryFolder: folder });
  expect(project.id).toBeTruthy();
  expect(project.createdAt).toBeTruthy();
  expect(listProjects()).toEqual([project]);
  const listed = await request('GET');
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ projects: [project] });
  const max = await request('POST', { name: 'N'.repeat(80) });
  expect(max.status).toBe(201);
  expect((await max.json() as { project: { name: string; primaryFolder?: string } }).project)
    .toEqual(expect.objectContaining({ name: 'N'.repeat(80) }));
  expect(listProjects()).toHaveLength(2);
});

test('POST rejects missing, blank, oversized, and non-string names before writing', async () => {
  for (const name of [undefined, '', '  ', 'N'.repeat(81), 123, null]) {
    const res = await request('POST', { name });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_name' });
  }
  expect(listProjects()).toEqual([]);
});

test('POST rejects invalid JSON and non-absolute primaryFolder before writing', async () => {
  const malformed = await request('POST', '{oops');
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: 'invalid_json' });
  const relative = await request('POST', { name: 'Test', primaryFolder: '../wrong' });
  expect(relative.status).toBe(400);
  expect(await relative.json()).toEqual({ error: 'invalid_primary_folder' });
  expect(listProjects()).toEqual([]);
});
