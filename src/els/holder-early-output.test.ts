import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { connectHolderElsPty, type HolderMeta } from './holder.js';

// A fake wire is necessary to force output before the identity pong deterministically.
class Wire extends EventEmitter {
  destroyed = false;
  sent: string[] = [];
  write(line: string) { this.sent.push(JSON.parse(line).op); return true; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  receive(message: object) { this.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); }
}
const meta: HolderMeta = { paneId: 'pane', ptyId: 'generation', pid: 42, cwd: '/', command: ['fake'], title: 'fake', socketPath: '/fake', startedAt: 0, cols: 80, rows: 24 };
function setup() {
  const wire = new Wire();
  const pty = connectHolderElsPty('/fake', 'pane', meta, () => undefined, (() => wire as unknown as Socket) as never);
  const events: string[] = [];
  pty.onOutput?.((text) => events.push(text));
  pty.onExit(() => events.push('exit'));
  wire.emit('connect');
  return { wire, pty, events };
}
test('pre-pong output is private then delivered in wire order before exit', () => {
  const { wire, pty, events } = setup();
  wire.receive({type: 'output', paneId: 'pane', chunk: 'one'});
  wire.receive({type: 'output', paneId: 'pane', chunk: 'two'});
  wire.receive({type: 'exit', paneId: 'pane', exitCode: 0, screen: 'final'});
  expect(events).toEqual([]);
  wire.receive({type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42});
  expect(events).toEqual(['one', 'two', 'exit']);
  pty.detach?.();
});
test('early exit prevents reentrant output callback write and kill', () => {
  const { wire, pty, events } = setup();
  pty.onOutput?.(() => { pty.write('reentrant'); pty.kill(); });
  pty.write('queued');
  wire.receive({type: 'output', paneId: 'pane', chunk: 'one'});
  wire.receive({type: 'exit', paneId: 'pane', exitCode: 0, screen: 'final'});
  wire.receive({type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42});
  expect(events).toEqual(['one', 'exit']);
  expect(wire.sent).toEqual(['ping']);
  pty.detach?.();
});
test('reentrant output writes remain behind already queued controls', () => {
  const { wire, pty } = setup();
  pty.write('first');
  pty.kill();
  pty.onOutput?.(() => { pty.resize?.(80, 24); });
  wire.receive({type: 'output', paneId: 'pane', chunk: 'before'});
  wire.receive({type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42});
  expect(wire.sent).toEqual(['ping', 'input', 'kill', 'resize']);
  pty.detach?.();
});
test('pre-pong output stays private for mismatched generation', () => {
  const { wire, pty, events } = setup();
  wire.receive({type: 'output', paneId: 'pane', chunk: 'secret'});
  expect(events).toEqual([]);
  wire.receive({type: 'pong', paneId: 'pane', ptyId: 'wrong', pid: 42});
  expect(events).toEqual(['exit']);
  expect(wire.destroyed).toBe(true);
  pty.detach?.();
});
test('pre-pong output precedes post-pong output', () => {
  const { wire, pty, events } = setup();
  wire.receive({type: 'output', paneId: 'pane', chunk: 'before'});
  expect(events).toEqual([]);
  wire.receive({type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42});
  wire.receive({type: 'output', paneId: 'pane', chunk: 'after'});
  expect(events).toEqual(['before', 'after']);
  pty.detach?.();
});
test('overflow discards later output and pong in the same data batch', () => {
  const { wire, pty, events } = setup();
  // The holder protocol caps unverified output at 1 MiB; emit one data event to preserve the decoder batch.
  const messages = [
    { type: 'output', paneId: 'pane', chunk: 'x'.repeat(1024 * 1024 + 1) },
    { type: 'output', paneId: 'pane', chunk: 'must-not-escape' },
    { type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42 },
  ];
  wire.emit('data', Buffer.from(messages.map((message) => JSON.stringify(message)).join('\n') + '\n'));
  expect(wire.destroyed).toBe(true);
  expect(events).toEqual(['exit']);
  expect(pty.isAlive()).toBe(false);
  pty.detach?.();
});

test('an oversized incomplete pre-pong line fails closed', () => {
  const { wire, pty, events } = setup();
  wire.emit('data', Buffer.from('x'.repeat(1024 * 1024 + 1)));
  expect(wire.destroyed).toBe(true);
  expect(events).toEqual(['exit']);
  pty.detach?.();
});

test('an oversized unverified output fails closed without exposing it', () => {
  const { wire, pty, events } = setup();
  // The fixture exceeds the 1 MiB pre-handshake cap; no unverified text is emitted.
  wire.receive({type: 'output', paneId: 'pane', chunk: 'x'.repeat(1024 * 1024 + 1)});
  expect(wire.destroyed).toBe(true);
  expect(events).toEqual(['exit']);
  pty.detach?.();
});
