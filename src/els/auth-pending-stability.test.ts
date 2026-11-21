import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { serveConnection } from './server.js';

// Deterministic socket seam drives real line decoder and serveConnection while readiness is held.
class Peer extends EventEmitter {
  destroyed = false; writableEnded = false; output: string[] = [];
  write(data: string) { this.output.push(data); return true; }
  end(data?: string) { if (data) this.output.push(data); this.writableEnded = true; return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  data(s: string) { this.emit('data', Buffer.from(s)); }
}
function setup(kind: 'outsider' | 'hand' = 'outsider') {
  let resolve!: (core: any) => void;
  const ready = new Promise<any>(r => { resolve = r; });
  const peer = new Peer();
  const guard = { classify: () => kind === 'hand' ? { kind: 'hand', pane: 'p', seat: 'H', workspaces: [] } : { kind: 'outsider', note: '' }, authorize: () => ({ allow: true }), audit: () => {}, seatSet: () => ({ exitCode: 0, message: 'ok' }) } as never;
  serveConnection(ready, peer as unknown as Socket, '/tmp/unused-els-test', () => undefined, { current: guard });
  return { peer, resolve };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const core = { shellPids: () => [], paneProcessBinding: () => undefined };

test('auth pending rejects accumulated complete lines before ready', () => {
  const { peer } = setup();
  peer.data('{"op":"auth"}\n' + '{}\n'.repeat(400_000));
  expect(peer.writableEnded || peer.destroyed).toBe(true);
});
test('auth rejected closes without a following request', async () => {
  const { peer, resolve } = setup('hand');
  peer.data('{"op":"auth"}\n'); resolve(core); await flush();
  expect(peer.writableEnded).toBe(true);
  expect(JSON.parse(peer.output[0]!).exitCode).toBe(1);
});
test('a disconnected pending connection never writes or dispatches after ready', async () => {
  const { peer, resolve } = setup();
  peer.data('{"op":"auth"}\n{"op":"ping"}\n'); peer.destroy(); resolve(core); await flush();
  expect(peer.output).toEqual([]);
});
test('pipelined auth then ping retains response order', async () => {
  const { peer, resolve } = setup();
  peer.data('{"op":"auth"}\n{"op":"ping"}\n'); resolve(core); await flush();
  expect(peer.output.map(s => JSON.parse(s).message)).toEqual(['auth: outsider', `els server pid ${process.pid}`]);
  expect(peer.writableEnded).toBe(true);
});

// The queue budget covers object overhead as well as text and the unfinished decoder tail.
test('auth pending rejects too many tiny complete lines', () => {
  const { peer } = setup();
  peer.data('{"op":"auth"}\n' + '\n'.repeat(4097));
  expect(peer.writableEnded).toBe(true);
  expect(JSON.parse(peer.output[0]!).exitCode).toBe(2);
});
test('auth pending bounds queued lines plus incomplete tail together', () => {
  const { peer } = setup();
  peer.data('{"op":"auth"}\n' + 'x'.repeat(600_000) + '\n' + 'y'.repeat(500_000));
  expect(peer.writableEnded).toBe(true);
  expect(JSON.parse(peer.output[0]!).exitCode).toBe(2);
});
