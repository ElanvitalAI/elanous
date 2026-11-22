import { expect, test } from 'bun:test';
import { parsePaneRows, parseRemoteRows } from './attach-view.js';
import { buildTabDropdown, buildTabRow, dropdownOrder, layoutSpaceList } from './space-tabs-view.js';
import { createAttachApp } from './attach-app.js';

const pane = (ws: string, id: string) => ({ address: `${ws}/t/${id}`, workspace: ws, pane: id, title: id, state: 'idle' });
const local = (id: string) => JSON.stringify({ workspaces: [{ id: 'a' }, { id: 'b', role: id === 'b' ? 'coordinator' : undefined }, { id: 'c', role: id === 'c' ? 'coordinator' : undefined }], panes: [pane('a', 'a1'), pane('b', 'b1'), pane('c', 'c1'), pane('b', 'b2')] });
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

test('coordinator workspace is first, all its panes retain their order; marker follows role not OP name', () => {
  const rows = parsePaneRows(local('b'));
  expect(rows.map(r => r.pane)).toEqual(['b1', 'b2', 'a1', 'c1']);
  expect(rows.map(r => r.role)).toEqual(['coordinator', 'coordinator', undefined, undefined]);
  const list = layoutSpaceList(rows, 'b1', 28, 8);
  expect(list.spaces.map(s => s.pane)).toEqual(['b1', 'a1', 'c1']);
  expect(plain(list.lines[1]!)).toContain('🎼 B');
  expect(plain(buildTabRow(rows, 'b1', 80).line!)).toContain('🎼 🛠 B1');
  const dropdown = buildTabDropdown(rows, 'b1', 'b1', 60, 12);
  expect(plain(dropdown.line)).toContain('🎼 🛠 B1');
  expect(plain(dropdown.list[0]!)).toContain('🎼 b');
  expect(dropdownOrder(rows)).toEqual(['b1', 'b2', 'a1', 'c1']);
  expect(parsePaneRows(JSON.stringify({ workspaces: [{ id: 'a', name: 'OP' }], panes: [pane('a', 'a1')] }))[0]!.role).toBeUndefined();
});

test('remote coordinators are first within each host, not globally; old hosts have no marker', () => {
  const remote = (host: string, ws: string, id: string, role?: string) => ({ host, ws, pane: id, address: `${host}:${ws}/t/${id}`, title: id, state: 'idle', reach: 'up', role });
  const rows = parseRemoteRows(JSON.stringify({ panes: [remote('one', 'a', 'a'), remote('two', 'a', 'a'), remote('one', 'b', 'b', 'coordinator'), remote('two', 'b', 'b', 'coordinator'), remote('one', 'c', 'c')] }));
  expect(rows.map(r => r.wsId)).toEqual(['one:b', 'one:a', 'one:c', 'two:b', 'two:a']);
  expect(rows.map(r => r.role)).toEqual(['coordinator', undefined, undefined, 'coordinator', undefined]);
  expect(plain(layoutSpaceList(rows, 'one:b/t/b', 28, 10).lines[1]!)).toContain('🎼 ⇄ONE B');
});

test('local coordinator precedes an empty remote coordinator', () => {
  const rows = parsePaneRows(local('b'));
  const list = layoutSpaceList(rows, 'b1', 28, 10, undefined, 0, [
    { wsId: 'remote:chief', name: '⇄remote chief', remote: 'remote' },
  ]);
  const lines = list.lines.map(plain);
  expect(lines.findIndex(line => line.includes('🎼 B'))).toBeLessThan(lines.findIndex(line => line.includes('🎼 ⇄REMOTE CHIEF')));
});

test('empty coordinator is selectable without inventing an attachable pane', async () => {
  const listing = JSON.stringify({ workspaces: [{ id: 'empty', name: 'chief', role: 'coordinator' }, { id: 'a', name: 'a' }], panes: [pane('a', 'a1')] });
  const screens: string[] = [];
  const attached: string[] = [];
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: listing }),
    attach: p => { attached.push(p); return { input() {}, resize() {}, scroll() {}, detach() {} }; },
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start('a1');
  expect(screens.at(-1)!.split('\r\n')[1]).toContain('🎼 CHIEF');
  app.key('\u001b[<0;5;2M');
  expect(attached).toEqual(['a1']);
  expect(screens.at(-1)!).toContain('빈 작업공간');
  expect(screens.at(-1)!).not.toContain('🛠 A1');
  app.key('\u0002q');
});

test('empty remote coordinator survives repeated host failure and clears on authoritative recovery', async () => {
  let tick = () => {};
  let remote = JSON.stringify({ hosts: [{ name: 'other', reach: 'up' }], panes: [], remoteWorkspaces: [
    { host: 'other', id: 'chief', name: 'chief', role: 'coordinator', reach: 'up' },
  ] });
  const screens: string[] = [];
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: local('b') }),
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }),
    remote: { list: async () => ({ exitCode: 0, message: remote }), read: async () => ({ exitCode: 0, message: '' }) },
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: cb => { tick = cb; return 0; }, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start('a1'); await Bun.sleep(20);
  expect(screens.at(-1)!).toContain('🎼 ⇄OTHER CHIEF');
  remote = JSON.stringify({ hosts: [{ name: 'other', reach: 'down' }], panes: [] });
  for (let i = 0; i < 2; i++) {
    tick(); await Bun.sleep(20);
    expect(screens.at(-1)!).toContain('✕ 🎼 ⇄OTHER CHIEF');
  }
  remote = JSON.stringify({ hosts: [{ name: 'other', reach: 'up' }], panes: [], remoteWorkspaces: [] });
  tick(); await Bun.sleep(20);
  expect(screens.at(-1)!).not.toContain('🎼 ⇄OTHER CHIEF');
  app.key('\u0002q');
});

test('folded HERDR keeps its coordinator visible before ordinary HERDR spaces', () => {
  const rows = parseRemoteRows(JSON.stringify({ panes: [
    { host: 'herdr', ws: 'ordinary', pane: 'a', address: 'herdr:ordinary/t/a', title: 'ordinary · a', state: 'idle', reach: 'up' },
    { host: 'herdr', ws: 'chief', pane: 'b', address: 'herdr:chief/t/b', title: 'chief · b', state: 'idle', reach: 'up', role: 'coordinator' },
  ] }));
  const ordinary = parsePaneRows(JSON.stringify({ workspaces: [{ id: 'local' }], panes: [pane('local', 'l1')] }));
  const list = layoutSpaceList([...rows, ...ordinary], 'l1', 28, 8);
  expect(list.spaces.map(s => s.ws)).toEqual(['herdr:chief', 'local']);
  expect(plain(list.lines[1]!)).toContain('🎼 ⇄HERDR CHIEF');
  expect(list.lines.join('\n')).toContain('HERDR · 1');
});

test('attach repaints a changed coordinator without changing the selected pane or click targets', async () => {
  let listing = local('b');
  let tick = () => {};
  const screens: string[] = [];
  const attached: string[] = [];
  const app = createAttachApp({
    request: async () => ({ exitCode: 0, message: listing }),
    attach: (p) => { attached.push(p); return { input() {}, resize() {}, scroll() {}, detach() {} }; },
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: cb => { tick = cb; return 0; }, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} },
  });
  await app.start('a1');
  expect(screens.at(-1)!.split('\r\n')[1]).toContain('🎼 B');
  listing = local('c'); tick(); await Bun.sleep(20);
  expect(screens.at(-1)!.split('\r\n')[1]).toContain('🎼 C');
  expect(screens.at(-1)!).not.toContain('🎼 B');
  expect(attached.at(-1)).toBe('a1');
  app.key('\u001b[<0;5;2M');
  expect(attached.at(-1)).toBe('c1');
  app.key('\u0002q');
});


test('selecting empty remote coordinator detaches local pane without attaching or reading a fake pane', async () => {
  const attached: string[] = []; const reads: string[] = []; const screens: string[] = []; let detached = 0;
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: local('b') }),
    attach: p => { attached.push(p); return { input() {}, resize() {}, scroll() {}, detach() { detached++; } }; },
    remote: { list: async () => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'other', reach: 'up' }], panes: [], remoteWorkspaces: [{ host: 'other', id: 'chief', name: 'chief', role: 'coordinator', reach: 'up' }] }) }),
      read: async p => { reads.push(p); return { exitCode: 0, message: '' }; } },
    write: s => screens.push(s), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start('a1'); await Bun.sleep(20);
  expect(attached).toEqual(['a1']); expect(detached).toBe(0);
  const lines = screens.at(-1)!.split('\r\n');
  const y = lines.findIndex(line => plain(line).includes('🎼 ⇄OTHER CHIEF')) + 1;
  expect(y).toBeGreaterThan(0);
  const beforeDetach = detached; const beforeAttach = [...attached];
  expect(beforeAttach.at(-1)).toBe('a1');
  app.key(`\u001b[<0;5;${y}M`);
  expect(detached).toBe(beforeDetach + 1); expect(attached).toEqual(beforeAttach); expect(reads).toEqual([]);
  expect(screens.at(-1)!).toContain('빈 작업공간');
  expect(screens.at(-1)!).not.toContain('🛠 A1');
  expect(screens.at(-1)!.split('\r\n').find(line => plain(line).includes('🎼 ⇄OTHER CHIEF'))).toContain('\u001b[7m');
  app.key('\u0002q');
});

test('a selected empty local coordinator follows its newly created pane, not the remembered pane', async () => {
  let tick = () => {};
  let listing = JSON.stringify({ workspaces: [{ id: 'chief', name: 'chief', role: 'coordinator' }, { id: 'a' }], panes: [pane('a', 'a1')] });
  const attached: string[] = [];
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: listing }),
    attach: p => { attached.push(p); return { input() {}, resize() {}, scroll() {}, detach() {} }; },
    write() {}, size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: cb => { tick = cb; return 0; }, clearInterval() {}, pollMs: 1000, chatCommand: [],
    memory: { load: () => ({ lastPane: 'a1' }), save() {} } });
  await app.start('a1');
  app.key('\u001b[<0;5;2M');
  listing = JSON.stringify({ workspaces: [{ id: 'chief', name: 'chief', role: 'coordinator' }, { id: 'a' }], panes: [pane('a', 'a1'), pane('chief', 'chief1')] });
  tick(); await Bun.sleep(20);
  expect(attached.at(-1)).toBe('chief1');
  app.key('\u0002q');
});

test('remote list failure remains visible while a local empty coordinator is selected', async () => {
  let tick = () => {}; let failed = false;
  const screens: string[] = [];
  const listing = JSON.stringify({ workspaces: [{ id: 'chief', name: 'chief', role: 'coordinator' }, { id: 'a' }], panes: [pane('a', 'a1')] });
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: listing }),
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }),
    remote: { list: async () => failed ? { exitCode: 1, message: 'offline' } : { exitCode: 0, message: '{"hosts":[],"panes":[]}' },
      read: async () => ({ exitCode: 0, message: '' }) },
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: cb => { tick = cb; return 0; }, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start('a1'); await Bun.sleep(20);
  app.key('\u001b[<0;5;2M');
  failed = true; tick(); await Bun.sleep(20);
  expect(screens.at(-1)!).toContain('원격 목록 확인 불가');
  expect(screens.at(-1)!).toContain('빈 작업공간');
  app.key('\u0002q');
});

test('polling does not automatically create a local pane while viewing an empty remote coordinator', async () => {
  let tick = () => {}; let creates = 0;
  const screens: string[] = [];
  const app = createAttachApp({ request: async request => {
    if (request.op === 'new') { creates++; return { exitCode: 1, message: 'not sent', transport: { outcome: 'not-sent', reason: 'connect' } }; }
    return { exitCode: 0, message: '{"workspaces":[],"panes":[]}' };
  },
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }),
    remote: { list: async () => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'other', reach: 'up' }], panes: [], remoteWorkspaces: [{ host: 'other', id: 'chief', name: 'chief', role: 'coordinator', reach: 'up' }] }) }),
      read: async () => ({ exitCode: 0, message: '' }) },
    write: s => screens.push(plain(s)), size: () => ({ cols: 100, rows: 12 }), cwd: '/x', env: {},
    setInterval: cb => { tick = cb; return 0; }, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start(); await Bun.sleep(20);
  expect(creates).toBe(1);
  const y = screens.at(-1)!.split('\r\n').findIndex(line => line.includes('🎼 ⇄OTHER CHIEF')) + 1;
  expect(y).toBeGreaterThan(0);
  app.key(`\u001b[<0;5;${y}M`);
  expect(screens.at(-1)!).toContain('빈 작업공간');
  tick(); await Bun.sleep(20);
  expect(creates).toBe(1);
  app.key('\u0002q');
});
