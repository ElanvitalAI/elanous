import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { validJournal } from './journal.js';
import { emptyJournal, type SpaceJournal } from './space.js';
import { createAttachApp } from './attach-app.js';
import { RECONNECT_NOTE } from './attach-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startElsServer, elsSocketPath } from './server.js';
import { requestEls } from './client.js';

test('focus is journalled, survives reload and may outlive a closed pane', () => {
  let saved: SpaceJournal = emptyJournal();
  let n = 0;
  const pty = (): ElsPty => ({ id: `pty${++n}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
  const make = () => createElsCore({ load: () => validJournal(JSON.parse(JSON.stringify(saved))), save: next => { saved = next; }, spawn: pty, mailBadges: () => new Map() });
  const first = make();
  expect(first.start()).toBeUndefined();
  const created = JSON.parse(first.newPane({ ws: 'space', cwd: '/tmp', command: ['sh'] }).message) as { pane: string };
  first.rememberFocus(created.pane);
  const focus = { workspaceId: saved.workspaces[0]!.id, tabId: saved.tabs[0]!.id, paneId: created.pane };
  expect(saved.lastFocus).toEqual(focus);
  const second = make();
  expect(second.start()).toBeUndefined();
  expect(JSON.parse(second.list().message).lastFocus).toEqual(focus);
  second.close(created.pane);
  expect(validJournal(saved).lastFocus).toEqual(focus);
  first.stopAll(); second.stopAll();
});

test('legacy journal loads without lastFocus', () => {
  expect(validJournal(emptyJournal()).lastFocus).toBeUndefined();
});


test('empty workspace focus survives reload and rejects populated or unknown spaces', () => {
  let saved = { ...emptyJournal(), workspaces: [{ id: 'w', name: 'empty', rootCwd: '/tmp', purpose: '', host: 'local' }] } as SpaceJournal;
  const core = createElsCore({ load: () => validJournal(saved), save: next => { saved = next; }, spawn: () => { throw new Error('unexpected'); }, mailBadges: () => new Map() });
  core.start(); core.rememberEmptyWorkspace('w');
  expect(validJournal(JSON.parse(JSON.stringify(saved))).lastFocus).toEqual({ workspaceId: 'w' });
  core.rememberEmptyWorkspace('absent'); expect(saved.lastFocus).toEqual({ workspaceId: 'w' });
  core.stopAll();
});

test('attach restores and reconnect falls back to the original space coordinator', async () => {
  const workspaces = [{ id: 'w1', name: 'one' }, { id: 'w2', name: 'two' }];
  const row = (ws: string, tab: string, pane: string, coordinator = false) => ({ address: `${ws}/${tab}/${pane}`, workspace: ws === 'w1' ? 'one' : 'two', tab, pane, title: pane, state: 'idle', ...(coordinator ? { spaceCoordinator: true } : {}) });
  let panes = [row('w2', 'other', 'other'), row('w1', 'tc', 'coord', true), row('w1', 'tt', 'target')];
  const lastFocus = { workspaceId: 'w1', tabId: 'tt', paneId: 'target' };
  let tick: () => void = () => {}; let end: (code: 0 | 1 | 2, reason: string) => void = () => {};
  const attached: string[] = []; const screens: string[] = [];
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: JSON.stringify({ workspaces, panes, lastFocus }) }),
    attach: (pane, _size, handlers) => { attached.push(pane); end = handlers.onEnd; return { input() {}, resize() {}, scroll() {}, detach() {} }; },
    write: text => screens.push(text), size: () => ({ cols: 100, rows: 12 }), cwd: '/tmp', env: {},
    setInterval: callback => { tick = callback; return 0; }, clearInterval() {}, pollMs: 1000, chatCommand: ['eln'], memory: { load: () => ({}), save() {} } });
  await app.start(); expect(attached).toEqual(['target']);
  end(1, 'the server is stopping'); expect(screens.at(-1)).toContain(RECONNECT_NOTE);
  panes = panes.filter(p => p.pane !== 'target'); tick(); await Bun.sleep(20);
  expect(attached).toEqual(['target', 'coord']); app.key('\u0002q');
});

test('select empty workspace then re-open restores empty screen without creating a pane', async () => {
  let focus: { workspaceId: string; tabId?: string; paneId?: string } | undefined;
  const workspaces = [{ id: 'chief', name: 'chief', role: 'coordinator' }, { id: 'a', name: 'a' }];
  const panes = [{ address: 'a/t/p', workspace: 'a', tab: 't', pane: 'p', title: 'p', state: 'idle' }];
  const attached: string[] = []; const screens: string[] = []; let creates = 0;
  const make = () => createAttachApp({ request: async request => {
    if (request.op === 'focus-empty') { focus = { workspaceId: request.ws }; return { exitCode: 0, message: 'ok' }; }
    if (request.op === 'new') { creates++; return { exitCode: 1, message: 'unexpected' }; }
    return { exitCode: 0, message: JSON.stringify({ workspaces, panes, lastFocus: focus }) };
  }, attach: p => { attached.push(p); return { input() {}, resize() {}, scroll() {}, detach() {} }; },
  write: s => screens.push(s), size: () => ({ cols: 100, rows: 12 }), cwd: '/a', env: {},
  setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  const first = make(); await first.start('p'); first.key('\u001b[<0;5;2M'); await Bun.sleep(20);
  expect(focus).toEqual({ workspaceId: 'chief' }); first.key('\u0002q');
  const second = make(); await second.start(); await Bun.sleep(20);
  expect(screens.at(-1)).toContain('빈 작업공간'); expect(attached).toEqual(['p']); expect(creates).toBe(0);
  second.key('\u0002q');
});

test('owner-only empty selection survives actual server restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-focus-'));
  const originalOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const originalPane = process.env.ELANOUS_ELS_PANE_TOKEN;
  let running: Awaited<ReturnType<typeof startElsServer>> | undefined;
  const fake: ElsPty = { id: 'fake', isAlive: () => true, write() {}, renderScreen: async () => '', onExit() {}, kill() {} };
  try {
    delete process.env.ELANOUS_ELS_PANE_TOKEN;
    running = await startElsServer({ stateRoot: root, spawn: () => fake, stall: false, mailWake: false });
    if ('exitCode' in running) throw new Error(running.message);
    const pane = JSON.parse(running.core.newPane({ ws: 'space', cwd: '/tmp', command: ['sh'] }).message).pane as string;
    const ws = (JSON.parse(running.core.list().message) as { workspaces: { id: string }[] }).workspaces[0]!.id;
    running.core.close(pane);
    const token = process.env.ELANOUS_ELS_OWNER_TOKEN!;
    delete process.env.ELANOUS_ELS_OWNER_TOKEN;
    const denied = await requestEls(elsSocketPath(root), { op: 'focus-empty', ws });
    expect(denied.exitCode).toBe(1);
    process.env.ELANOUS_ELS_OWNER_TOKEN = token;
    expect((await requestEls(elsSocketPath(root), { op: 'focus-empty', ws })).exitCode).toBe(0);
    await running.close(); running = undefined;
    running = await startElsServer({ stateRoot: root, spawn: () => fake, stall: false, mailWake: false });
    if ('exitCode' in running) throw new Error(running.message);
    expect(JSON.parse(running.core.list().message).lastFocus).toEqual({ workspaceId: ws });
  } finally {
    if (running && !('exitCode' in running)) await running.close();
    if (originalOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = originalOwner;
    if (originalPane === undefined) delete process.env.ELANOUS_ELS_PANE_TOKEN; else process.env.ELANOUS_ELS_PANE_TOKEN = originalPane;
    rmSync(root, { recursive: true, force: true });
  }
});

test('server reconnect reattaches the same surviving pane', async () => {
  const pane = { address: 'w/t/p', workspace: 'space', tab: 't', pane: 'p', title: 'p', state: 'idle' };
  let tick: () => void = () => {}; let end: (code: 0 | 1 | 2, reason: string) => void = () => {};
  const attached: string[] = [];
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: JSON.stringify({ workspaces: [{ id: 'w', name: 'space' }], panes: [pane], lastFocus: { workspaceId: 'w', tabId: 't', paneId: 'p' } }) }),
    attach: (id, _size, handlers) => { attached.push(id); end = handlers.onEnd; return { input() {}, resize() {}, scroll() {}, detach() {} }; },
    write() {}, size: () => ({ cols: 100, rows: 12 }), cwd: '/tmp', env: {}, setInterval: cb => { tick = cb; return 0; }, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start(); end(1, 'the server is stopping'); tick(); await Bun.sleep(20);
  expect(attached).toEqual(['p', 'p']); app.key('\u0002q');
});

test('last empty coordinator space alone does not auto-create a pane', async () => {
  let creates = 0; const screens: string[] = [];
  const app = createAttachApp({ request: async request => {
    if (request.op === 'new') creates++;
    return { exitCode: 0, message: JSON.stringify({ workspaces: [{ id: 'w', name: 'space', role: 'coordinator' }], panes: [], lastFocus: { workspaceId: 'w' } }) };
  }, attach: () => { throw new Error('unexpected attach'); }, write: s => screens.push(s), size: () => ({ cols: 100, rows: 12 }), cwd: '/tmp', env: {},
  setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} } });
  await app.start(); expect(creates).toBe(0); expect(screens.at(-1)).toContain('빈 작업공간'); app.key('\u0002q');
});
