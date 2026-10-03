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
