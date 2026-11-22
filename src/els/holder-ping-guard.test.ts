import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { connectHolderElsPty, type HolderMeta } from './holder.js';

class FakeSocket extends EventEmitter {
  destroyed = false;
  sent: string[] = [];
  write(line: string) { this.sent.push(JSON.parse(line).op); return true; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  receive(message: object) { this.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); }
}
const meta: HolderMeta = { paneId: 'pane', ptyId: 'generation', pid: 42, cwd: '/', command: ['fake'], title: 'fake', socketPath: '/fake', startedAt: 0, cols: 80, rows: 24 };
function setup() {
  const socket = new FakeSocket();
  const pty = connectHolderElsPty('/fake', 'pane', meta, () => undefined, (() => socket as unknown as Socket) as never);
  return { socket, pty };
}
test('queued and subsequent operations wait for matching pong', async () => {
  const {socket, pty} = setup();
  pty.write('before');
  const screen = pty.renderScreen();
  pty.kill();
  socket.emit('connect');
  pty.resize?.(12, 13);
  expect(socket.sent).toEqual(['ping']);
  socket.receive({type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42});
  expect(socket.sent).toEqual(['ping', 'input', 'snapshot', 'kill', 'resize']);
  socket.receive({type: 'snapshot', paneId: 'pane', ptyId: 'generation', pid: 42, alive: true, bracketedPaste: false, lastOutputAt: null, screen: 'ok'});
  expect(await screen).toBe('ok');
  pty.detach?.();
});
test('mismatched generation discards queue and rejects pending work', async () => {
  const {socket, pty} = setup();
  const screen = pty.renderScreen();
  const rejected = screen.then(() => false, () => true);
  pty.kill();
  socket.emit('connect');
  socket.receive({type: 'pong', paneId: 'pane', ptyId: 'other', pid: 42});
  expect(await rejected).toBe(true);
  expect(socket.sent).toEqual(['ping']);
  expect(socket.destroyed).toBe(true);
});
test('non-pong cannot complete handshake or release the queue', () => {
  const {socket, pty} = setup();
  pty.write('queued');
  socket.emit('connect');
  socket.receive({type: 'snapshot', paneId: 'pane', ptyId: 'generation', pid: 42, alive: true, bracketedPaste: false, lastOutputAt: null, screen: ''});
  expect(socket.sent).toEqual(['ping']);
  pty.detach?.();
});
test('exit before matching pong is delivered without releasing queued effects', async () => {
  const {socket, pty} = setup();
  let exits = 0;
  pty.onExit(() => { exits++; });
  pty.write('queued');
  const pendingWrite = pty.writeAll?.('queued write').then(() => 'resolved', () => 'rejected');
  pty.kill();
  socket.emit('connect');
  socket.receive({type: 'exit', paneId: 'pane', exitCode: 0, screen: 'final screen'});
  expect(exits).toBe(0);
  expect(socket.sent).toEqual(['ping']);
  socket.receive({type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42});
  expect(exits).toBe(1);
  expect(await pendingWrite).toBe('rejected');
  expect(pty.isAlive()).toBe(false);
  expect(await pty.renderScreen()).toBe('final screen');
  expect(socket.sent).toEqual(['ping']);
  pty.detach?.();
});

test('exit before mismatched pong never exposes the unverified screen', async () => {
  const {socket, pty} = setup();
  pty.write('queued');
  socket.emit('connect');
  socket.receive({type: 'exit', paneId: 'pane', exitCode: 0, screen: 'unverified'});
  socket.receive({type: 'pong', paneId: 'pane', ptyId: 'other', pid: 42});
  expect(socket.sent).toEqual(['ping']);
  expect(pty.isAlive()).toBe(false);
  expect(await pty.renderScreen().then(() => false, () => true)).toBe(true);
  pty.detach?.();
});

test('missing pane identity fails closed', async () => {
  const {socket, pty} = setup();
  const screen = pty.renderScreen().then(() => false, () => true);
  pty.kill();
  socket.emit('connect');
  socket.receive({type: 'pong', ptyId: 'generation', pid: 42});
  expect(await screen).toBe(true);
  expect(socket.sent).toEqual(['ping']);
});
test('detaching before connect cancels all queued effects', () => {
  const {socket, pty} = setup();
  pty.write('queued');
  pty.kill();
  pty.detach?.();
  socket.emit('connect');
  expect(socket.destroyed).toBe(true);
  expect(socket.sent).toEqual([]);
});

test('reattach rejects known process birth mismatch before sending controls', async () => {
  const socket = new FakeSocket();
  const recorded = { ...meta, processStart: 'original-birth' };
  const lookup = () => ({ pid: 42, start: 'different-birth' }) as never;
  const pty = connectHolderElsPty('/fake', 'pane', recorded, lookup, (() => socket as unknown as Socket) as never);
  const screen = pty.renderScreen().then(() => false, () => true);
  pty.write('queued');
  socket.emit('connect');
  socket.receive({type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42, processStart: 'different-birth'});
  expect(socket.sent).toEqual(['ping']);
  expect(socket.destroyed).toBe(true);
  expect(await screen).toBe(true);
  pty.detach?.();
});
