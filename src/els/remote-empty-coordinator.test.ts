import { expect, test } from 'bun:test';
import { createAttachApp } from './attach-app.js';
import { emptyRemoteCoordinators, parseRemoteRows } from './attach-view.js';
import type { ElsCore } from './core.js';
import { createFederation } from './federation.js';
import { routeElsHttp } from './http.js';
import { layoutSpaceList } from './space-tabs-view.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const local = { workspaces: [{ id: 'local', name: 'local' }], tabs: [], panes: [{ address: 'local/t/l', workspace: 'local', pane: 'l', title: 'l', state: 'idle' }] };
const origin = { workspaces: [{ id: 'chief', name: 'boss', role: 'coordinator' }, { id: 'other', name: 'other' }], panes: [{ address: 'other/t/p', tab: 't', pane: 'p', title: 'p', cwd: '', state: 'idle' }] };

test('empty remote coordinator travels HTTP → federation → real sidebar without a fabricated pane', async () => {
  const core = { list: () => ({ exitCode: 0, message: JSON.stringify(origin) }) } as unknown as ElsCore;
  const http = await routeElsHttp(core, 'r', 'GET', '/els/ls');
  const body = JSON.parse(http.body);
  expect(body.workspaces).toEqual([{ id: 'chief', name: 'boss', role: 'coordinator' }]);
  const fed = createFederation({ localHost: 'local', askLocal: async () => ({ exitCode: 0, message: JSON.stringify(local) }),
    registry: { hosts: [{ name: 'r', baseUrl: 'http://127.0.0.1:8790' }], rejected: [] },
    fetchJson: async () => ({ status: 200, body }) });
  const result = await fed.list();
  const data = JSON.parse(result.message);
  expect(data.panes).toHaveLength(2);
  expect(data.remoteWorkspaces).toEqual([{ host: 'r', id: 'chief', name: 'boss', role: 'coordinator', reach: 'up' }]);
  const rows = parseRemoteRows(result.message);
  const empty = emptyRemoteCoordinators(result.message, rows);
  const layout = layoutSpaceList(rows, undefined, 28, 10, undefined, 0, empty);
  expect(plain(layout.lines[1]!)).toContain('🎼 ⇄R BOSS');
  expect(plain(layout.lines[2]!)).toContain('⇄R OTHER');
  expect(layout.spaces.map(x => x.ws)).toEqual(['r:other']);
  const screens: string[] = [], attached: string[] = [];
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: JSON.stringify(local) }), remote: { list: () => fed.list(), read: async () => ({ exitCode: 0, message: '' }) },
    attach: p => { attached.push(p); return { input() {}, resize() {}, scroll() {}, detach() {} }; },
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start('l'); await Bun.sleep(30);
  expect(screens.at(-1)).toContain('🎼 ⇄R BOSS');
  app.key('\u0002q');
  expect(attached).toEqual(['l']);
});

test('legacy hosts, duplicate pane workspaces and malformed optional metadata remain safe', async () => {
  const make = (workspaces?: unknown) => createFederation({ localHost: 'local', askLocal: async () => ({ exitCode: 0, message: JSON.stringify(local) }),
    registry: { hosts: [{ name: 'r', baseUrl: 'http://127.0.0.1:8790' }], rejected: [] },
    fetchJson: async () => ({ status: 200, body: { host: 'r', panes: [{ ws: 'other', tab: 't', pane: 'p', title: '', cwd: '', state: 'idle' }], workspaces } }) });
  for (const spaces of [undefined, null, [{ id: '../bad', name: 'x', role: 'coordinator' }]]) {
    const listed = await make(spaces).list();
    expect(JSON.parse(listed.message).hosts[1].reach).toBe('up');
    expect(emptyRemoteCoordinators(listed.message, parseRemoteRows(listed.message))).toEqual([]);
  }
  const listed = await make([{ id: 'other', name: 'other', role: 'coordinator' }]).list();
  expect(emptyRemoteCoordinators(listed.message, parseRemoteRows(listed.message))).toEqual([]);
});
