import { afterEach, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { join } from 'node:path';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';
import { subscribeEls } from './subscribe-client.js';

// ELS-DESKTOP-SIDETAB-SUBSCRIBE gap (a): the sidetab used to re-ask `ls` every second; the server now pushes the list
// on the connection when a pane or its state changes (`subscribe` op, read-only like `ls`).
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const fakePty = (): ElsPty => ({ id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
async function server() {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-sub-'));
  const started = await startElsServer({ stateRoot: root, spawn: fakePty, stall: false });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(async () => { await started.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, socket: elsSocketPath(root) };
}
const until = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};
const titles = (message: string): string[] => (JSON.parse(message) as { panes: { title: string }[] }).panes.map((p) => p.title);

test('subscribe pushes the current list at once, then a new list when a pane is created or closed — no re-asking', async () => {
  const { socket } = await server();
  const lists: string[] = [];
  const ends: string[] = [];
  const sub = subscribeEls(socket, { onList: (m) => lists.push(m), onEnd: (r) => ends.push(r) });
  cleanups.push(() => sub.close());
  await until(() => lists.length >= 1);
  expect(titles(lists[0]!)).toEqual([]);
  const made = await requestEls(socket, { op: 'new', ws: 'OP', cwd: '/w', command: ['eln'], title: 'PUSHED_ONE' });
  expect(made.exitCode).toBe(0);
  await until(() => lists.some((m) => titles(m).includes('PUSHED_ONE')), 1_500);
  const pane = (JSON.parse(made.message) as { pane: string }).pane;
  const before = lists.length;
  expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);   // the door lets only OP close a pane
  const closed = await requestEls(socket, { op: 'close', pane, confirmed: true } as never);
  expect(closed.exitCode, closed.message).toBe(0);
  await until(() => lists.length > before && !titles(lists.at(-1)!).includes('PUSHED_ONE'), 1_500);
  expect(ends).toEqual([]);
});

test('an unchanged list is not pushed again (identical events are not sent)', async () => {
  const { socket } = await server();
  const lists: string[] = [];
  const sub = subscribeEls(socket, { onList: (m) => lists.push(m), onEnd: () => {} });
  cleanups.push(() => sub.close());
  await until(() => lists.length === 1);
  await new Promise((r) => setTimeout(r, 400));
  expect(lists.length).toBe(1);
});

test('subscribe is read-only: it needs no token and writes nothing; closing the subscriber leaves the server and panes', async () => {
  const { socket } = await server();
  expect((await requestEls(socket, { op: 'new', ws: 'OP', cwd: '/w', command: ['eln'], title: 'KEEP_ME' })).exitCode).toBe(0);
  const lists: string[] = [];
  const sub = subscribeEls(socket, { onList: (m) => lists.push(m), onEnd: () => {} });
  await until(() => lists.length >= 1);
  expect(titles(lists[0]!)).toContain('KEEP_ME');
  sub.close();
  await new Promise((r) => setTimeout(r, 100));
  expect((await requestEls(socket, { op: 'ping' })).exitCode).toBe(0);
  expect((await requestEls(socket, { op: 'ls' })).message).toContain('KEEP_ME');
});

test('subscribe to a missing server ends with a reason and no list (the sidetab then keeps its 1 s poll)', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-sub-none-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ends: string[] = [];
  const lists: string[] = [];
  const sub = subscribeEls(elsSocketPath(root), { onList: (m) => lists.push(m), onEnd: (r) => ends.push(r) });
  cleanups.push(() => sub.close());
  await until(() => ends.length === 1);
  expect(lists).toEqual([]);
  expect(ends[0]).toContain('no els server');
});

test('an older server that answers «unknown request» ends the subscription as unsupported', async () => {
  const { createServer } = await import('node:net');
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-sub-old-'));
  const sock = join(root, 's.sock');
  const old = createServer((c) => { c.on('data', () => c.end(`${JSON.stringify({ exitCode: 2, message: 'els: unknown request' })}\n`)); });
  await new Promise<void>((r) => old.listen(sock, r));
  cleanups.push(() => new Promise<void>((r) => old.close(() => { rmSync(root, { recursive: true, force: true }); r(); })));
  const ends: string[] = [];
  const lists: string[] = [];
  const sub = subscribeEls(sock, { onList: (m) => lists.push(m), onEnd: (r) => ends.push(r) });
  cleanups.push(() => sub.close());
  await until(() => ends.length === 1);
  expect(lists).toEqual([]);
  expect(ends[0]).toContain('unknown request');
});

test('the server drops the subscriber when its connection closes (no timers left behind)', async () => {
  const { socket } = await server();
  const raw = createConnection(socket);
  await new Promise<void>((r) => raw.on('connect', () => r()));
  raw.write(`${JSON.stringify({ op: 'subscribe' })}\n`);
  await new Promise((r) => raw.once('data', r));
  raw.destroy();
  await new Promise((r) => setTimeout(r, 100));
  expect((await requestEls(socket, { op: 'new', ws: 'OP', cwd: '/w', command: ['eln'], title: 'AFTER_DROP' })).exitCode).toBe(0);
});
