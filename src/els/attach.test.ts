import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachEls, type AttachFrame } from './attach-client.js';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (check: () => boolean, ms = 4_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'els-att-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const state = { screen: 'ready\n', writes: [] as string[], sizes: [] as [number, number][], alive: true, exit: () => {} };
  const pty: ElsPty = { id: 'pty_1', isAlive: () => state.alive, write: (text) => { state.writes.push(text); }, renderScreen: async () => state.screen,
    onExit: (cb) => { state.exit = () => { state.alive = false; cb(); }; }, kill: () => {}, resize: (cols, rows) => { state.sizes.push([cols, rows]); } };
  return { root, state, pty };
}

async function boot() {
  const { root, state, pty } = setup();
  const started = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  const pane = (JSON.parse(created.message) as { pane: string }).pane;
  return { root, state, pane };
}

function open(root: string, pane: string, size = { cols: 100, rows: 30 }) {
  const frames: AttachFrame[] = [];
  const ends: [number, string][] = [];
  const errors: string[] = [];
  const attached = attachEls(elsSocketPath(root), pane, size, { onFrame: (frame) => frames.push(frame), onEnd: (code, reason) => ends.push([code, reason]), onError: (message) => errors.push(message) });
  cleanups.push(() => attached.detach());
  return { attached, frames, ends, errors };
}

test('attach: the first frame arrives at once, a frame is sent only when the screen changed, and seq counts frames', async () => {
  const { root, state, pane } = await boot();
  const view = open(root, pane);
  await until(() => view.frames.length === 1);
  expect(view.frames[0]).toEqual({ pane, seq: 1, cols: 100, rows: 30, screen: 'ready\n' });
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(view.frames).toHaveLength(1);
  state.screen = 'ready\n$ ls\n';
  await until(() => view.frames.length === 2);
  expect(view.frames[1]).toMatchObject({ seq: 2, screen: 'ready\n$ ls\n' });
});

test('attach: input goes to the PTY as typed, resize reaches the PTY, a bad line is refused and the attach stays open', async () => {
  const { root, state, pane } = await boot();
  const view = open(root, pane);
  await until(() => view.frames.length === 1);
  expect(state.sizes).toEqual([[100, 30]]);
  view.attached.input('echo hi\r');
  view.attached.resize(120, 40);
  await until(() => state.writes.length === 1 && state.sizes.length === 2);
  expect(state.writes).toEqual(['echo hi\r']);
  expect(state.sizes[1]).toEqual([120, 40]);
  await until(() => view.frames.length === 2);
  expect(view.frames[1]).toMatchObject({ cols: 120, rows: 40 });
  view.attached.resize(5, 5);
  await until(() => view.errors.length === 1);
  expect(view.errors[0]).toContain('cols 10-500');
  view.attached.input('still works');
  await until(() => state.writes.length === 2);
  expect(view.ends).toEqual([]);
});

test('attach: an unknown pane is refused with an end line; a pane that exits ends the stream with its last screen', async () => {
  const { root, state, pane } = await boot();
  const bad = open(root, 'pdeadbeef');
  await until(() => bad.ends.length === 1);
  expect(bad.ends[0]![0]).toBe(1);
  expect(bad.ends[0]![1]).toContain('unknown pane');
  const view = open(root, pane);
  await until(() => view.frames.length === 1);
  state.screen = 'bye\n';
  state.exit();
  await until(() => view.ends.length === 1);
  expect(view.ends[0]).toEqual([0, 'pane exited']);
  expect(view.frames.at(-1)!.screen).toContain('bye');
});

test('attach: detaching (closing the connection) leaves the pane running; a second client can attach and type', async () => {
  const { root, state, pane } = await boot();
  const first = open(root, pane);
  await until(() => first.frames.length === 1);
  first.attached.detach();
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(state.alive).toBe(true);
  const listed = JSON.parse((await requestEls(elsSocketPath(root), { op: 'ls' })).message) as { panes: { state: string; ptyId: string }[] };
  expect([listed.panes[0]!.state === 'exited', listed.panes[0]!.ptyId]).toEqual([false, 'pty_1']);
  const second = open(root, pane);
  await until(() => second.frames.length === 1);
  second.attached.input('x');
  await until(() => state.writes.length === 1);
});

test('attach: no server → the end line says how to start one, nothing is started', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-att-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const view = open(root, 'p1');
  await until(() => view.ends.length === 1);
  expect(view.ends[0]![1]).toContain('no els server is running');
});

test('attach: lines that arrive in the same chunk as the attach line (input, resize) are kept and applied in order, none dropped', async () => {
  const { root, state, pane } = await boot();
  const { createConnection } = await import('node:net');
  const socket = createConnection(elsSocketPath(root));
  cleanups.push(() => { socket.destroy(); });
  let received = '';
  socket.on('data', (chunk) => { received += chunk.toString(); });
  // One write: attach + two input lines + a resize, as a fast client sends them before the owner is «ready».
  await new Promise<void>((resolve) => socket.on('connect', () => {
    socket.write([{ op: 'attach', pane }, { op: 'input', bytes: 'one' }, { op: 'resize', cols: 111, rows: 33 }, { op: 'input', bytes: 'two' }].map((line) => `${JSON.stringify(line)}\n`).join(''));
    resolve();
  }));
  await until(() => state.writes.length === 2 && state.sizes.some(([cols, rows]) => cols === 111 && rows === 33));
  expect(state.writes).toEqual(['one', 'two']);
  await until(() => received.includes('"cols":111'));
});

test('attach: a client that connects and goes away before the owner answers leaves no timer behind and the pane alone', async () => {
  const { root, state, pane } = await boot();
  const { createConnection } = await import('node:net');
  for (let index = 0; index < 5; index++) {
    const socket = createConnection(elsSocketPath(root));
    await new Promise<void>((resolve) => socket.on('connect', () => { socket.write(`${JSON.stringify({ op: 'attach', pane })}\n`); socket.destroy(); resolve(); }));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(state.alive).toBe(true);
  const view = open(root, pane);
  await until(() => view.frames.length === 1);
});

test('non-object JSON (null, a number, a string, an array) is refused on that connection only — as the first request and inside an attach — and the owner keeps serving', async () => {
  const { root, state, pane } = await boot();
  const { createConnection } = await import('node:net');
  const talk = (lines: string[]) => new Promise<string>((resolve) => {
    const socket = createConnection(elsSocketPath(root));
    let received = '';
    socket.on('connect', () => socket.write(lines.map((line) => `${line}\n`).join('')));
    socket.on('data', (chunk) => { received += chunk.toString(); });
    socket.on('close', () => resolve(received));
    setTimeout(() => { socket.destroy(); }, 600);
  });
  for (const body of ['null', '7', '"text"', '[]', '[null]', 'true']) {
    const answer = JSON.parse((await talk([body])).trim().split('\n')[0]!) as { exitCode: number; message: string };
    expect([answer.exitCode, answer.message]).toEqual([2, 'els: malformed request']);
  }
  const inside = await talk([JSON.stringify({ op: 'attach', pane }), 'null', '7', '[1]', JSON.stringify({ op: 'input', bytes: 'after' })]);
  expect(inside.split('\n').filter((line) => line.includes('malformed line'))).toHaveLength(3);
  await until(() => state.writes.includes('after'));
  expect((await requestEls(elsSocketPath(root), { op: 'ping' })).exitCode).toBe(0);
});

test('attach client: input and resize called before the connection is up follow the attach line in order — none overtakes it, none is lost', async () => {
  const { root, state, pane } = await boot();
  const view = open(root, pane);
  // No wait at all: the socket is still connecting.
  view.attached.input('fast');
  view.attached.resize(101, 31);
  view.attached.input('typing');
  await until(() => state.writes.length === 2 && state.sizes.some(([cols, rows]) => cols === 101 && rows === 31));
  expect(state.writes).toEqual(['fast', 'typing']);
  expect(view.errors).toEqual([]);
  await until(() => view.frames.length >= 1);
});
