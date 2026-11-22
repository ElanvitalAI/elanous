import { expect, test } from 'bun:test';
import { createAttachApp } from './attach-app.js';
import type { ElsRequest } from './server.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const listing = JSON.stringify({ workspaces: [{ id: 'chief', name: 'chief', role: 'coordinator' }, { id: 'a', name: 'a' }], panes: [{ address: 'a/t/p', workspace: 'a', pane: 'p', title: 'p', state: 'idle' }] });
const remote = JSON.stringify({ hosts: [{ name: 'other', reach: 'up' }], panes: [], remoteWorkspaces: [{ host: 'other', id: 'chief', name: 'chief', role: 'coordinator', reach: 'up' }] });

function setup() {
  const screens: string[] = []; const requests: ElsRequest[] = []; const attached: string[] = [];
  const app = createAttachApp({
    request: async r => { requests.push(r); return r.op === 'new' ? { exitCode: 1, message: 'refused' } : { exitCode: 0, message: listing }; },
    attach: p => { attached.push(p); return { input() {}, resize() {}, scroll() {}, detach() {} }; },
    remote: { list: async () => ({ exitCode: 0, message: remote }), read: async () => ({ exitCode: 0, message: '' }) },
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/chief', env: {},
    setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: ['eln'], memory: { load: () => ({}), save() {} },
  });
  return { app, screens, requests, attached };
}

for (const key of ['c', 'a', 'N'] as const) for (const location of ['local', 'remote'] as const) {
  test(`empty ${location} coordinator allows ${key} creation with correct local target`, async () => {
    const { app, screens, requests } = setup();
    await app.start('p'); await Bun.sleep(20);
    const name = location === 'local' ? '🎼 CHIEF' : '🎼 ⇄OTHER CHIEF';
    const y = screens.at(-1)!.split('\r\n').findIndex(line => line.includes(name)) + 1;
    expect(y).toBeGreaterThan(0);
    app.key(`\u001b[<0;5;${y}M`);
    expect(screens.at(-1)!.split('\r\n')[0]!.split('│')[1]).toContain(location === 'local' ? '🎼 chief' : '🎼 ⇄other chief');
    app.key(`\u0002${key}`);
    if (key === 'c' && location === 'local') app.key('\r');
    await Bun.sleep(20);
    const created = requests.filter((r): r is Extract<ElsRequest, { op: 'new' }> => r.op === 'new');
    expect(created).toHaveLength(1);
    if (key !== 'N' && location === 'local') expect(created[0]!.ws).toBe('chief');
    if (key !== 'N' && location === 'remote') expect(created[0]!.ws).not.toBe('other:chief');
    if (key === 'N') expect(created[0]!.ws).toBe('chief-2');
    if (key === 'a') expect(created[0]!.command).toEqual(['eln']);
    app.key('\u0002q');
  });
}

test('workspace cycling includes local and remote empty coordinators in list order', async () => {
  const { app, screens, attached } = setup();
  await app.start('p'); await Bun.sleep(20);
  app.key('\u0002w');
  expect(screens.at(-1)!.split('\r\n')[0]!.split('│')[1]).toContain('🎼 ⇄other chief');
  app.key('\u0002w');
  expect(screens.at(-1)!.split('\r\n')[0]!.split('│')[1]).toContain('🎼 chief');
  app.key('\u0002w');
  expect(attached).toEqual(['p', 'p']);
  app.key('\u0002q');
});
