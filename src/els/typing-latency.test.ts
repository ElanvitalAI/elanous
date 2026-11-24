// ELS-TYPING-LATENCY (CEO P0 «typing inside els feels slow»): three behaviours on the typing path, literal expectations
// (rule 11 — independent of product constants):
//   1. the server never drops a pane's output while a frame is in flight — the echo of the LAST typed key reaches the
//      client without waiting for the pane's next output (before: it waited for the next keystroke);
//   2. a bracketed paste reaches the pane as ONE write — markers kept for a pane that asked for bracketed paste,
//      stripped for one that did not;
//   3. a pane frame repaints the pane only — the side chrome (sidebar, baton read) is not recomputed per echo.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { requestEls } from './client.js';
import type { ElsPty, ElsResult } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';
import type { AttachHandlers, Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import { createAppFrameWriter } from './attach-view.js';
import { createKeyRouter } from './attach-keys.js';

const scrubbedElsEnv: Array<[string, string]> = [];
for (const name of Object.keys(process.env)) {
  if (!name.startsWith('ELANOUS_ELS_')) continue;
  const value = process.env[name];
  if (value !== undefined) scrubbedElsEnv.push([name, value]);
  delete process.env[name];
}
afterAll(() => { for (const [name, value] of scrubbedElsEnv) process.env[name] = value; });

const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (check: () => boolean, ms = 4_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 5)); }
};

async function bootServer(opts: { paste: boolean; renderGate?: () => Promise<void> }) {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-typing-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const state = { screen: 'ready', writes: [] as string[], renders: 0 };
  const listeners = new Set<(data: string) => void>();
  const pty: ElsPty = {
    id: 'pty_1', isAlive: () => true, write: (text) => { state.writes.push(text); },
    bracketedPasteEnabled: () => opts.paste,
    // The screen is read when the render STARTS (the emulator snapshot); the answer comes back after the gate.
    renderScreen: async () => { const shot = state.screen; state.renders++; if (opts.renderGate) await opts.renderGate(); return shot; },
    onExit: () => {}, kill: () => {}, resize: () => {},
    onOutput: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
  };
  const started = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  const pane = (JSON.parse(created.message) as { pane: string }).pane;
  const output = (text: string): void => { for (const cb of [...listeners]) cb(text); };
  return { root, state, pane, output };
}

function rawAttach(root: string, pane: string): { lines: Record<string, unknown>[]; send: (value: object) => void } {
  const lines: Record<string, unknown>[] = [];
  const token = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  const socket = net.createConnection(elsSocketPath(root));
  const send = (value: object): void => { socket.write(`${JSON.stringify(value)}\n`); };
  send({ op: 'auth', token, pid: process.pid });
  send({ op: 'attach', pane, cols: 100, rows: 30 });
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) { lines.push(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>); buffer = buffer.slice(nl + 1); }
  });
  cleanups.push(() => { socket.destroy(); });
  return { lines, send };
}

test('output that lands while a frame is rendering is not dropped: the final echo arrives with no further pane output', async () => {
  let release: (() => void) | undefined;
  let hold = false;
  const renderGate = (): Promise<void> => hold ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  const { root, state, pane, output } = await bootServer({ paste: false, renderGate });
  const wire = rawAttach(root, pane);
  await until(() => wire.lines.some((line) => line.type === 'frame' && line.screen === 'ready'));
  hold = true;
  state.screen = 'ready a';
  output('a');                                   // first echo chunk: a render starts and is held
  await until(() => release !== undefined);
  state.screen = 'ready ab';
  output('b');                                   // second chunk lands while that render is in flight
  hold = false;
  release!();
  // No more output after this point: the screen with «ab» must still reach the client.
  await until(() => wire.lines.some((line) => line.type === 'frame' && line.screen === 'ready ab'), 2_000);
  expect(wire.lines.filter((line) => line.type === 'frame').map((line) => line.screen)).toEqual(['ready', 'ready a', 'ready ab']);
});

test('a bracketed paste reaches a paste-mode pane as ONE write with its markers', async () => {
  const { root, state, pane } = await bootServer({ paste: true });
  const wire = rawAttach(root, pane);
  await until(() => wire.lines.some((line) => line.type === 'frame'));
  wire.send({ op: 'input', bytes: '\u001b[200~line one\nline two\u001b[201~' });
  await until(() => state.writes.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(state.writes).toEqual(['\u001b[200~line one\nline two\u001b[201~']);
});

test('a bracketed paste into a pane without paste mode is ONE write of the text, markers stripped', async () => {
  const { root, state, pane } = await bootServer({ paste: false });
  const wire = rawAttach(root, pane);
  await until(() => wire.lines.some((line) => line.type === 'frame'));
  wire.send({ op: 'input', bytes: '\u001b[200~echo hi\u001b[201~' });
  await until(() => state.writes.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(state.writes).toEqual(['echo hi']);
});

test('the app view forwards a pasted chunk to the pane as one input', async () => {
  const inputs: string[] = [];
  const handlers: AttachHandlers[] = [];
  const listing = JSON.stringify({ workspaces: [], tabs: [], panes: [{ address: 'w1/t1/p1', workspace: 'name-w1', pane: 'p1', title: 'one', state: 'idle' }] });
  const view = createAttachApp({
    request: async (request): Promise<ElsResult> => ({ exitCode: 0, message: request.op === 'ls' ? listing : '' }),
    attach: (_pane, _size, h): Attached => { handlers.push(h); return { input: (bytes) => { inputs.push(bytes); }, resize: () => {}, scroll: () => {}, detach: () => {} }; },
    write: () => {}, size: () => ({ cols: 80, rows: 24 }), cwd: '/work', env: { SHELL: '/bin/zsh' },
    setInterval: () => 0, clearInterval: () => {}, pollMs: 1000, chatCommand: ['/opt/elanous/bin/elanous'],
    memory: { load: () => ({}), save: () => {} }, actingSeat: () => undefined,
  });
  await view.start();
  view.key('\u001b[200~first line\rsecond line\u001b[201~');
  expect(inputs).toEqual(['\u001b[200~first line\rsecond line\u001b[201~']);
  inputs.length = 0;
  const content = `${'x'.repeat(1997)}\u0002q\n`;
  view.key('\u001b[20');
  view.key(`0~${content.slice(0, 900)}`);
  view.key(`${content.slice(900)}\u001b[201~`);
  expect(inputs).toEqual([`\u001b[200~${content}\u001b[201~`]);
});

test('a paste split across terminal reads is one literal input, including prefix and mouse bytes', () => {
  const router = createKeyRouter();
  const events: import('./attach-keys.js').KeyEvent[] = [];
  const receive = (event: import('./attach-keys.js').KeyEvent) => events.push(event);
  router.feed('\u001b[20', false, receive);
  router.feed('0~line one\n\u0002q\u001b[<0;1;1M', false, receive);
  expect(events).toEqual([]);
  router.feed('end\u001b[20', false, receive);
  router.feed('1~', false, receive);
  expect(events).toEqual([{ kind: 'input', bytes: '\u001b[200~line one\n\u0002q\u001b[<0;1;1Mend\u001b[201~' }]);
});

test('a standalone Escape is delivered after the paste-prefix wait', async () => {
  const router = createKeyRouter();
  const events: import('./attach-keys.js').KeyEvent[] = [];
  router.feed('\u001b', false, event => events.push(event));
  await until(() => events.length === 1);
  expect(events).toEqual([{ kind: 'input', bytes: '\u001b' }]);
});

test('a timed-out paste discards late shell commands until the split end marker', async () => {
  const router = createKeyRouter({ pasteTimeoutMs: 20 });
  const events: import('./attach-keys.js').KeyEvent[] = [];
  const receive = (event: import('./attach-keys.js').KeyEvent) => events.push(event);
  router.feed('\u001b[200~partial\ndangerous command', false, receive);
  expect(events).toEqual([]);
  await until(() => events.length === 1);
  expect(events).toEqual([{ kind: 'paste-incomplete' }]);
  router.feed('late\ncommand\n\u001b[20', false, receive);
  expect(events).toEqual([{ kind: 'paste-incomplete' }]);
  router.feed('1~next', false, receive);
  expect(events).toEqual([{ kind: 'paste-incomplete' }, { kind: 'paste-discarded' }, { kind: 'input', bytes: 'next' }]);
});

test('a paste end marker split across the inactivity timeout ends quarantine', async () => {
  const router = createKeyRouter({ pasteTimeoutMs: 20 });
  const events: import('./attach-keys.js').KeyEvent[] = [];
  const receive = (event: import('./attach-keys.js').KeyEvent) => events.push(event);
  router.feed('\u001b[200~content\u001b[20', false, receive);
  await until(() => events.length === 1);
  router.feed('1~safe', false, receive);
  expect(events).toEqual([{ kind: 'paste-incomplete' }, { kind: 'paste-discarded' }, { kind: 'input', bytes: 'safe' }]);
});

test('a completed paste cancels its inactivity timeout', async () => {
  const router = createKeyRouter({ pasteTimeoutMs: 20 });
  const events: import('./attach-keys.js').KeyEvent[] = [];
  const receive = (event: import('./attach-keys.js').KeyEvent) => events.push(event);
  router.feed('\u001b[200~hello', false, receive);
  router.feed('\u001b[201~', false, receive);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(events).toEqual([{ kind: 'input', bytes: '\u001b[200~hello\u001b[201~' }]);
});

test('a pane frame repaints without recomputing the side chrome; a listing poll still recomputes it', async () => {
  let chromeReads = 0;
  let poll: (() => void) | undefined;
  const handlers: AttachHandlers[] = [];
  const out: string[] = [];
  const listing = JSON.stringify({ workspaces: [], tabs: [], panes: [{ address: 'w1/t1/p1', workspace: 'name-w1', pane: 'p1', title: 'one', state: 'idle' }] });
  const view = createAttachApp({
    request: async (request): Promise<ElsResult> => ({ exitCode: 0, message: request.op === 'ls' ? listing : '' }),
    attach: (_pane, _size, h): Attached => { handlers.push(h); return { input: () => {}, resize: () => {}, scroll: () => {}, detach: () => {} }; },
    write: createAppFrameWriter((text) => { out.push(text); }), size: () => ({ cols: 100, rows: 24 }), cwd: '/work', env: { SHELL: '/bin/zsh' },
    setInterval: (callback) => { poll = callback; return 0; }, clearInterval: () => {}, pollMs: 1000, chatCommand: ['/opt/elanous/bin/elanous'],
    memory: { load: () => ({}), save: () => {} },
    actingSeat: () => { chromeReads++; return undefined; },     // read once per side-chrome build
  });
  await view.start();
  const frame = (text: string): void => handlers[0]!.onFrame({ pane: 'p1', seq: 1, cols: 70, rows: 23, back: 0, screen: `[screen 70x23 cursor=(row 0, col 0, visible true)]\n${text}` });
  frame('$ ');
  const before = chromeReads;
  const writesBefore = out.length;
  for (const typed of ['$ e', '$ ec', '$ ech', '$ echo']) frame(typed);
  expect(chromeReads).toBe(before);                              // four echoes, zero chrome rebuilds
  expect(out.length - writesBefore).toBe(4);                     // each echo is still painted
  expect(out.at(-1)!.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')).toContain('$ echo');
  poll!();
  await until(() => chromeReads > before);                       // the listing poll rebuilds the chrome
});
