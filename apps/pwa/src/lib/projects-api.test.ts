import { expect, test } from 'bun:test';
import { ProjectsApi } from './projects-api';

test('projects API lists, creates and assigns or clears membership using the authenticated client', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (init?.method === 'POST') return { project: { id: 'p', name: '새 일' } };
    return path === '/v1/projects' ? { projects: [] } : { ok: true };
  } };
  const api = new ProjectsApi(client as never);
  expect(await api.list()).toEqual({ projects: [] });
  expect((await api.create('새 일')).project.name).toBe('새 일');
  expect(await api.assign('id/a', 'p')).toEqual({ ok: true });
  await api.assign('id/a', null);
  expect(calls.map((c) => c.path)).toEqual(['/v1/projects', '/v1/projects', '/v1/sessions/store/id%2Fa', '/v1/sessions/store/id%2Fa']);
  expect(calls[1]?.init).toMatchObject({ method: 'POST', body: '{"name":"새 일"}' });
  expect(calls[2]?.init).toMatchObject({ method: 'PATCH', body: '{"projectId":"p"}' });
  expect(calls[3]?.init).toMatchObject({ method: 'PATCH', body: '{"projectId":null}' });
});

test('projects API browses remote folders with an encoded path (and defaults to the server home)', async () => {
  const calls: string[] = [];
  const client = { fetchJson: async (path: string) => {
    calls.push(path);
    return { path: '/srv/a & b', parent: '/srv', folders: [{ name: 'child', path: '/srv/a & b/child' }] };
  } };
  const api = new ProjectsApi(client as never);
  expect((await api.folders('/srv/a & b')).folders).toEqual([{ name: 'child', path: '/srv/a & b/child' }]);
  await api.folders();
  expect(calls).toEqual(['/v1/projects/folders?path=%2Fsrv%2Fa%20%26%20b', '/v1/projects/folders']);
});

test('projects API creates a project using a folder selected on the remote host', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return { project: { id: 'p', name: '새 일', primaryFolder: '/srv/work/a' } };
  } };
  const api = new ProjectsApi(client as never);
  expect((await api.create('새 일', '/srv/work/a')).project).toMatchObject({ id: 'p', name: '새 일', primaryFolder: '/srv/work/a' });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ path: '/v1/projects', init: {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"name":"새 일","primaryFolder":"/srv/work/a"}',
  } });
});
