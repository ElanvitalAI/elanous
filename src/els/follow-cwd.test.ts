import { expect, test } from 'bun:test';
import { createAttachApp } from './attach-app.js';
import type { ElsRequest } from './server.js';
import { createElsCore, type ElsPty, type ElsResult } from './core.js';
import { emptyJournal } from './space.js';
import { handOffToEls } from './nesting.js';
import { herdrImportRows } from './herdr-import.js';

const listing = (cwd?: string, state = 'idle', root = '/workspace') => JSON.stringify({
  workspaces: [{ id: 'w', name: 'project', rootCwd: root }],
  panes: [{ address: 'w/t/p', workspace: 'project', pane: 'p', title: 'shell', state, ...(cwd ? { cwd } : {}) }],
});

async function createAfter(initial: string, latest: string) {
  const requests: ElsRequest[] = [];
  let current = initial;
  const app = createAttachApp({
    request: async request => { requests.push(request); return request.op === 'ls' ? { exitCode: 0, message: current } : { exitCode: 1, message: 'test refusal' }; },
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }), write() {}, size: () => ({ cols: 80, rows: 24 }),
    cwd: '/caller', env: { HOME: '/home/test', SHELL: '/bin/sh' }, setInterval: () => 0, clearInterval() {}, pollMs: 1000,
    chatCommand: ['eln'], memory: { load: () => ({}), save() {} },
  });
  await app.start('p'); current = latest;
  app.key('\u0002c\r'); await Bun.sleep(20); app.key('\u0002q');
  return requests.find((r): r is Extract<ElsRequest, { op: 'new' }> => r.op === 'new');
}

test('fresh selected cwd wins over root and caller after cd', async () => {
  expect((await createAfter(listing('/old'), listing('/new')))?.cwd).toBe('/new');
});
test('missing or exited focused cwd falls back to workspace root', async () => {
  expect((await createAfter(listing(), listing()))?.cwd).toBe('/workspace');
  expect((await createAfter(listing('/old'), listing('/stale', 'exited')))?.cwd).toBe('/workspace');
});
test('missing focused cwd and workspace root falls back to HOME', async () => {
  expect((await createAfter(listing(undefined, 'idle', ''), listing(undefined, 'idle', '')))?.cwd).toBe('/home/test');
});

test('failed fresh cwd lookup never creates a pane with stale cwd', async () => {
  const requests: ElsRequest[] = [];
  let count = 0;
  const app = createAttachApp({
    request: async request => {
      requests.push(request);
      if (request.op === 'ls') return ++count === 1
        ? { exitCode: 0, message: listing('/old') }
        : { exitCode: 1, message: 'owner unavailable' };
      return { exitCode: 0, message: '{}' };
    },
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }), write() {}, size: () => ({ cols: 80, rows: 24 }),
    cwd: '/caller', env: { HOME: '/home/test', SHELL: '/bin/sh' }, setInterval: () => 0, clearInterval() {}, pollMs: 1000,
    chatCommand: ['eln'], memory: { load: () => ({}), save() {} },
  });
  await app.start('p');
  app.key('\u0002c\r');
  await Bun.sleep(20);
  expect(requests.filter(request => request.op === 'new')).toEqual([]);
  app.key('\u0002q');
});

test('synthetic OSC 7 cd flows from owner to focused new tab spawn', async () => {
  let journal = emptyJournal();
  const events = new Set<(data: string) => void>();
  const spawned: string[] = [];
  const core = createElsCore({
    load: () => journal, save: value => { journal = value; },
    isCwdDirectory: async path => path === '/synthetic/live',
    spawn: (_command, cwd) => {
      spawned.push(cwd);
      const pty: ElsPty = { id: `pty-${spawned.length}`, isAlive: () => true, write() {}, renderScreen: async () => '',
        onExit() {}, kill() {}, onOutput: cb => { events.add(cb); return { dispose: () => { events.delete(cb); } }; } };
      return pty;
    },
  });
  core.start();
  const first = JSON.parse(core.newPane({ ws: 'project', cwd: '/synthetic/root', command: ['sh'] }).message) as { pane: string };
  const app = createAttachApp({
    request: async req => req.op === 'ls' ? core.list() : req.op === 'new' ? core.newPane(req) : { exitCode: 1, message: 'unexpected' },
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }), write() {}, size: () => ({ cols: 80, rows: 24 }),
    cwd: '/caller', env: { HOME: '/home/test', SHELL: '/bin/sh' }, setInterval: () => 0, clearInterval() {}, pollMs: 1000,
    chatCommand: ['eln'], memory: { load: () => ({}), save() {} },
  });
  try {
    await app.start(first.pane);
    for (const emit of events) emit('\u001b]7;file:///synthetic/live\u0007');
    for (let i = 0; i < 30 && journal.panes[0]?.cwd !== '/synthetic/live'; i++) await Bun.sleep(10);
    expect(journal.panes[0]?.cwd).toBe('/synthetic/live');
    app.key('\u0002c\r');
    for (let i = 0; i < 30 && spawned.length < 2; i++) await Bun.sleep(10);
    expect(spawned).toEqual(['/synthetic/root', '/synthetic/live']);
    console.log('synthetic=true event=OSC7 cwd=/synthetic/live new-tab-spawn=/synthetic/live');
  } finally { app.key('\u0002q'); core.stopAll(); }
});

test('selection changing during cwd lookup cancels creation instead of using an obsolete pane', async () => {
  const requests: ElsRequest[] = [];
  let tick: () => void = () => {};
  let resolveLookup!: (result: ElsResult) => void;
  let lists = 0;
  const app = createAttachApp({
    request: async request => {
      requests.push(request);
      if (request.op !== 'ls') return { exitCode: 1, message: 'unexpected' };
      lists++;
      if (lists === 2) return new Promise<ElsResult>(resolve => { resolveLookup = resolve; });
      if (lists === 3) return { exitCode: 0, message: JSON.stringify({ workspaces: [{ id: 'w', name: 'project', rootCwd: '/workspace' }], panes: [{ address: 'w/t/q', workspace: 'project', pane: 'q', title: 'other', state: 'idle', cwd: '/other' }] }) };
      return { exitCode: 0, message: listing('/old') };
    },
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }), write() {}, size: () => ({ cols: 80, rows: 24 }),
    cwd: '/caller', env: { HOME: '/home/test', SHELL: '/bin/sh' }, setInterval: cb => { tick = cb; return 0; }, clearInterval() {}, pollMs: 1000,
    chatCommand: ['eln'], memory: { load: () => ({}), save() {} },
  });
  try {
    await app.start('p');
    app.key('\u0002c\r');
    tick();
    await Bun.sleep(0);
    resolveLookup({ exitCode: 0, message: listing('/old') });
    await Bun.sleep(10);
    expect(requests.filter(request => request.op === 'new')).toEqual([]);
  } finally { app.key('\u0002q'); }
});

test('handoff reopens the session with its explicitly supplied cwd', async () => {
  const requests: unknown[] = [];
  const result = await handOffToEls({ env: {}, sessionId: 'synthetic-session', ws: 'project', cwd: '/session/live',
    request: async req => { requests.push(req); return { exitCode: 0, message: '{}' }; }, launchOuter: async () => true });
  expect(result.kind).toBe('handed-off');
  expect(requests).toEqual([{ op: 'new', ws: 'project', cwd: '/session/live', command: ['eln', '--resume', 'synthetic-session'], title: 'eln' }]);
});

test('split panes in an imported tab retain their own cwd for reopening', async () => {
  const parsed = herdrImportRows({ result: { workspaces: [{ workspace_id: 'w1', label: 'project' }],
    tabs: [{ tab_id: 'w1:t1', label: 'shell' }], panes: [
      { workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', cwd: '/left' },
      { workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p2', cwd: '/right' },
    ] } });
  expect(parsed?.rows.map(row => [row.herdrPane, row.cwd])).toEqual([['w1:p1', '/left'], ['w1:p2', '/right']]);
});

test('malformed successful owner response does not create using a stale or fallback cwd', async () => {
  const requests: ElsRequest[] = [];
  let count = 0;
  const app = createAttachApp({
    request: async request => {
      requests.push(request);
      return request.op === 'ls' ? { exitCode: 0, message: ++count === 1 ? listing('/old') : '{}' } : { exitCode: 0, message: '{}' };
    },
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }), write() {}, size: () => ({ cols: 80, rows: 24 }),
    cwd: '/caller', env: { HOME: '/home/test', SHELL: '/bin/sh' }, setInterval: () => 0, clearInterval() {}, pollMs: 1000,
    chatCommand: ['eln'], memory: { load: () => ({}), save() {} },
  });
  try {
    await app.start('p'); app.key('\u0002c\r'); await Bun.sleep(10);
    expect(requests.filter(request => request.op === 'new')).toEqual([]);
  } finally { app.key('\u0002q'); }
});
