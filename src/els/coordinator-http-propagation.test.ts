import { expect, test } from 'bun:test';
import type { ElsCore } from './core.js';
import { createFederation } from './federation.js';
import { routeElsHttp } from './http.js';

test('HTTP and federation carry coordinator to every pane of the matching workspace only', async () => {
  const panes = [
    { address: 'w1/t1/p1', tab: 't1', pane: 'p1', title: '', cwd: '', state: 'idle' },
    { address: 'w1/t2/p2', tab: 't2', pane: 'p2', title: '', cwd: '', state: 'idle' },
    { address: 'w2/t3/p3', tab: 't3', pane: 'p3', title: '', cwd: '', state: 'idle' },
  ];
  const core = { list: () => ({ exitCode: 0, message: JSON.stringify({ workspaces: [{ id: 'w1', role: 'coordinator' }, { id: 'w2' }], panes }) }) } as unknown as ElsCore;
  const http = await routeElsHttp(core, 'remote', 'GET', '/els/ls');
  expect(http.status).toBe(200);
  const body = JSON.parse(http.body);
  expect(body.panes.map((p: { role?: string }) => p.role)).toEqual(['coordinator', 'coordinator', undefined]);
  const fed = createFederation({ localHost: 'local',
    askLocal: async () => ({ exitCode: 0, message: JSON.stringify({ workspaces: [], tabs: [], panes: [] }) }),
    registry: { hosts: [{ name: 'remote', baseUrl: 'http://127.0.0.1:8790' }], rejected: [] },
    fetchJson: async () => ({ status: http.status, body }) });
  const result = await fed.list();
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.message).panes;
  expect(rows.map((p: { role?: string }) => p.role)).toEqual(['coordinator', 'coordinator', undefined]);
  expect(rows.map((p: { address: string }) => p.address)).toEqual(['remote:w1/t1/p1', 'remote:w1/t2/p2', 'remote:w2/t3/p3']);
});
