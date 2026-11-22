import { expect, test } from 'bun:test';
import { createAttachApp } from './attach-app.js';
import { createElsCore } from './core.js';
import type { SpaceJournal } from './space.js';
import type { ElsRequest } from './server.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

test('closing selected empty coordinator uses workspace id and restores the real OP default', async () => {
  let disk: SpaceJournal = {
    version: 1,
    workspaces: [
      { id: 'chief-id', name: 'chief', rootCwd: '/chief', purpose: '', host: 'local', role: 'coordinator' },
      { id: 'op-id', name: 'OP', rootCwd: '/hq/seats/OP', purpose: '', host: 'local' },
    ],
    tabs: [{ id: 't', workspaceId: 'op-id', label: 'shell', focusPaneId: 'p' }],
    panes: [{ id: 'p', tabId: 't', kind: 'pty', title: 'shell', cwd: '/hq/seats/OP', command: ['sh'], state: 'idle', restore: 'cwd', ptyId: '', scrollback: '' }],
  };
  const core = createElsCore({ load: () => disk, save: value => { disk = value; }, spawn: () => { throw new Error('unexpected spawn'); }, mailBadges: () => new Map() });
  expect(core.start()).toBeUndefined();
  const requests: ElsRequest[] = []; const screens: string[] = [];
  const app = createAttachApp({
    request: async r => { requests.push(r); if (r.op === 'ls') return core.list(); if (r.op === 'close-workspace') return core.closeWorkspace(r.ws); throw new Error(`unexpected ${r.op}`); },
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }),
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} },
  });
  await app.start('p');
  const y = screens.at(-1)!.split('\r\n').findIndex(line => line.includes('🎼 CHIEF')) + 1;
  expect(y).toBeGreaterThan(0);
  app.key(`\u001b[<0;5;${y}M`);
  app.key('\u0002D');
  expect(screens.at(-1)!).toContain('작업공간 «chief»');
  app.key('n');
  expect(requests.filter(r => r.op === 'close-workspace')).toHaveLength(0);
  app.key('\u0002D'); app.key('y'); await Bun.sleep(20);
  expect(requests.filter(r => r.op === 'close-workspace')).toEqual([{ op: 'close-workspace', ws: 'chief-id', confirmed: true }]);
  const listed = JSON.parse(core.list().message) as { workspaces: { id: string; role?: string }[] };
  expect(listed.workspaces.map(w => [w.id, w.role])).toEqual([['op-id', 'coordinator']]);
  expect(screens.at(-1)!).toContain('🎼 OP');
  app.key('\u0002q');
});

test('empty remote workspace cannot be closed by keyboard or quit', async () => {
  const requests: ElsRequest[] = []; const screens: string[] = [];
  const local = JSON.stringify({ workspaces: [{ id: 'a', name: 'a' }], panes: [{ address: 'a/t/p', workspace: 'a', pane: 'p', title: 'p', state: 'idle' }] });
  const remote = JSON.stringify({ hosts: [{ name: 'other', reach: 'up' }], panes: [], remoteWorkspaces: [{ host: 'other', id: 'chief', name: 'chief', role: 'coordinator', reach: 'up' }] });
  const app = createAttachApp({ request: async r => { requests.push(r); return { exitCode: 0, message: local }; },
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }),
    remote: { list: async () => ({ exitCode: 0, message: remote }), read: async () => ({ exitCode: 0, message: '' }) },
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start('p'); await Bun.sleep(20);
  const y = screens.at(-1)!.split('\r\n').findIndex(line => line.includes('🎼 ⇄OTHER CHIEF')) + 1;
  expect(y).toBeGreaterThan(0);
  app.key(`\u001b[<0;5;${y}M`);
  app.key('\u0002D'); expect(screens.at(-1)!).toContain('여기서 닫을 수 없음');
  app.key('\u0002Q'); expect(screens.at(-1)!).toContain('여기서 닫을 수 없음');
  expect(requests.filter(r => r.op === 'close-workspace')).toHaveLength(0);
  app.key('\u0002q');
});
