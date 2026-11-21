import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { serveConnection } from './server.js';

// Deterministic socket and held promise: exercise the real decoder, door and attach dispatch.
class Peer extends EventEmitter {
  destroyed = false; writableEnded = false; writableLength = 0; output: string[] = [];
  write(data: string) { this.output.push(data); return true; }
  end(data?: string) { if (data) this.output.push(data); this.writableEnded = true; return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  data(s: string) { this.emit('data', Buffer.from(s)); }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const input = (s: string) => JSON.stringify({ op: 'input', bytes: s }) + '\n';
async function setup() {
  const peer = new Peer();
  const calls: string[] = [];
  const core = { shellPids: () => [], paneExists: () => 'p', frame: async () => ({exitCode: 0, message: 'screen'}),
    paneSize: () => ({cols: 80, rows: 24}), paneIsLive: () => true,
    input: (_: string, bytes: string) => { calls.push(bytes); return {exitCode: 0, message: ''}; } };
  const guard = { classify: () => ({kind: 'owner', note: 'fixture'}), authorize: () => ({allow: true}), audit: () => {} } as never;
  serveConnection(Promise.resolve(core as never), peer as unknown as Socket, '/tmp/unused-els-test', () => undefined, {current: guard});
  peer.data('{"op":"auth"}\n'); await flush();
  peer.output.length = 0;
  return {peer, calls};
}
// 출처: server.ts MAX_PENDING_LINES=4096, MAX_REQUEST_CHARS=1<<20.
test('attach readiness accepts 4096 complete input lines in order', async () => {
  const {peer, calls} = await setup();
  peer.data('{"op":"attach","pane":"p"}\n');
  peer.data(Array.from({length: 4096}, (_, i) => input(String(i))).join(''));
  expect(peer.writableEnded).toBe(false);
  await flush();
  expect(calls).toEqual(Array.from({length: 4096}, (_, i) => String(i)));
  peer.destroy();
});
test('attach readiness rejects line 4097 and never dispatches buffered input', async () => {
  const {peer, calls} = await setup();
  peer.data('{"op":"attach","pane":"p"}\n');
  peer.data(input('must-not-run').repeat(4097));
  expect(peer.writableEnded).toBe(true);
  expect(JSON.parse(peer.output[0]!).exitCode).toBe(2);
  await flush();
  expect(calls).toEqual([]);
  peer.destroy();
});
test('attach readiness rejects complete line plus unfinished tail over total budget without dispatch', async () => {
  const {peer, calls} = await setup();
  peer.data('{"op":"attach","pane":"p"}\n');
  peer.data(input('must-not-run') + 'x'.repeat(600_000) + '\n' + 'y'.repeat(500_000));
  expect(peer.writableEnded).toBe(true);
  expect(JSON.parse(peer.output[0]!).exitCode).toBe(2);
  await flush();
  expect(calls).toEqual([]);
  peer.destroy();
});
test('attach readiness after disconnect never dispatches queued input', async () => {
  const {peer, calls} = await setup();
  peer.data('{"op":"attach","pane":"p"}\n');
  peer.data(input('must-not-run'));
  peer.destroy(); await flush();
  expect(calls).toEqual([]);
  expect(peer.output).toEqual([]);
});
