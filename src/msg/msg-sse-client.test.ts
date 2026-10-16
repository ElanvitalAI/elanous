import { afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { MsgStore, type Message } from './msg-store.js';
import { startMsgSseServer } from './msg-sse-server.js';
import { subscribeMsgStream, type MsgStreamOptions } from './msg-sse-client.js';

setDefaultTimeout(30_000);
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'test-token';
const fast = { backoff: { initialMs: 20, maxMs: 80 }, pollMs: 15, idleTimeoutMs: 2000 } satisfies Partial<MsgStreamOptions>;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'msg-sse-client-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  cleanups.push(() => store.close());
  const serve = (port = 0) => {
    const server = startMsgSseServer({ store: new MsgStore(path, { readOnly: true }), token: TOKEN, port, pollMs: 10 });
    cleanups.push(() => server.stop());
    return server;
  };
  return { dir, path, store, serve, cursorPath: join(dir, 'cursor', 'COORDINATOR.json'),
    post: (body: string, to = 'COORDINATOR') => store.post({ from: 'UX', to, body }) };
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function subscribe(options: MsgStreamOptions) {
  const handle = subscribeMsgStream(options);
  cleanups.push(() => handle.stop());
  return handle;
}

test('SSE delivers live and, after the server restarts, replays from Last-Event-ID with no gap or repeat', async () => {
  const f = fixture();
  const server = f.serve();
  const port = server.port;
  const got: number[] = [];
  // No polling fallback here — only the SSE replay can fill the gap.
  subscribe({ address: 'COORDINATOR', url: `http://127.0.0.1:${port}`, token: () => TOKEN, cursorPath: f.cursorPath,
    openStore: () => { throw new Error('ledger hidden'); }, ...fast, onMessage: message => { got.push(message.id); } });
  f.post('one');
  await until(() => got.length === 1);
  server.stop();
  f.post('two'); f.post('three');
  f.serve(port);
  await until(() => got.length === 3);
  expect(got).toEqual([1, 2, 3]);
  expect(JSON.parse(readFileSync(f.cursorPath, 'utf8'))).toMatchObject({ address: 'COORDINATOR', lastEventId: 3 });
});

test('a rejected onMessage keeps the cursor and the same message comes again after reconnect', async () => {
  const f = fixture();
  const server = f.serve();
  const seen: number[] = [];
  let failures = 1;
  subscribe({ address: 'COORDINATOR', url: `http://127.0.0.1:${server.port}`, token: () => TOKEN, cursorPath: f.cursorPath,
    openStore: () => { throw new Error('ledger hidden'); }, ...fast,
    onMessage: async message => {
      seen.push(message.id);
      if (failures-- > 0) {
        expect(() => readFileSync(f.cursorPath, 'utf8')).toThrow();
        throw new Error('body failed');
      }
    } });
  f.post('retry me');
  await until(() => seen.length === 2);
  expect(seen).toEqual([1, 1]);
  await until(() => { try { return JSON.parse(readFileSync(f.cursorPath, 'utf8')).lastEventId === 1; } catch { return false; } });
});

test('no server falls back to ledger polling and logs fallback-poll; a bad token does the same', async () => {
  const log = spyOn(debug, 'log');
  try {
    for (const variant of ['absent', 'unauthorized'] as const) {
      const f = fixture();
      const server = variant === 'unauthorized' ? f.serve() : undefined;
      const url = server ? `http://127.0.0.1:${server.port}` : 'http://127.0.0.1:9';
      const got: Message[] = [];
      const handle = subscribe({ address: 'COORDINATOR', url, token: () => 'wrong', cursorPath: f.cursorPath,
        openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast, onMessage: message => { got.push(message); } });
      f.post('via ledger');
      f.post('not mine', 'OP');
      await until(() => got.length === 1);
      await handle.stop();
      expect(got.map(message => message.body)).toEqual(['via ledger']);
      const fallbacks = log.mock.calls.filter(call => call[0] === 'msg.sse-client' && call[1] === 'fallback-poll');
      expect(fallbacks.length).toBeGreaterThan(0);
      if (variant === 'unauthorized') expect(fallbacks.some(call => (call[2] as { reason?: string }).reason === 'unauthorized')).toBe(true);
    }
  } finally { log.mockRestore(); }
});

test('each real reconnect request has exactly one reconnect log', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log');
  try {
    let requests = 0;
    const handle = subscribe({ address: 'COORDINATOR', url: 'http://127.0.0.1:9', token: () => TOKEN, cursorPath: f.cursorPath,
      openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => { requests++; return fetch(input, init); }) as typeof fetch,
      onMessage: () => {} });
    await until(() => requests >= 3);
    await handle.stop();
    const reconnects = log.mock.calls.filter(call => call[0] === 'msg.sse-client' && call[1] === 'reconnect');
    expect(reconnects.length).toBe(requests - 1);
    expect(reconnects.map(call => (call[2] as { attempts: number }).attempts)).toEqual(Array.from({ length: requests - 1 }, (_, i) => i + 1));
    // A token provider that throws makes no request, so it records no reconnect either.
    log.mockClear();
    let tokenRequests = 0;
    let tokenTries = 0;
    const noToken = subscribe({ address: 'COORDINATOR', url: 'http://127.0.0.1:9', cursorPath: f.cursorPath,
      token: () => { tokenTries++; throw new Error('token unavailable'); },
      openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => { tokenRequests++; return fetch(input, init); }) as typeof fetch,
      onMessage: () => {} });
    await until(() => tokenTries >= 3);
    await noToken.stop();
    expect(tokenRequests).toBe(0);
    expect(log.mock.calls.filter(call => call[0] === 'msg.sse-client' && call[1] === 'reconnect')).toHaveLength(0);
  } finally { log.mockRestore(); }
});

test('with no post office configured it polls the ledger and resumes from the saved cursor', async () => {
  const f = fixture();
  const got: number[] = [];
  const log = spyOn(debug, 'log');
  try {
    const first = subscribe({ address: 'COORDINATOR', cursorPath: f.cursorPath,
      openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast, onMessage: message => { got.push(message.id); } });
    f.post('a'); f.post('b');
    await until(() => got.length === 2);
    await new Promise(resolve => setTimeout(resolve, 60));
    await first.stop();
    // Many polls, one interval: fallback-poll is logged once on entry.
    expect(log.mock.calls.filter(call => call[0] === 'msg.sse-client' && call[1] === 'fallback-poll')).toHaveLength(1);
  } finally { log.mockRestore(); }
  f.post('c');
  subscribe({ address: 'COORDINATOR', cursorPath: f.cursorPath,
    openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast, onMessage: message => { got.push(message.id); } });
  await until(() => got.length === 3);
  expect(got).toEqual([1, 2, 3]);
});

test('a server that accepts but never answers headers times out into ledger polling', async () => {
  const f = fixture();
  const silent = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
  cleanups.push(() => silent.stop(true));
  const got: number[] = [];
  subscribe({ address: 'COORDINATOR', url: `http://127.0.0.1:${silent.port}`, token: () => TOKEN, cursorPath: f.cursorPath,
    openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast, idleTimeoutMs: 100, onMessage: message => { got.push(message.id); } });
  f.post('delivered anyway');
  await until(() => got.length === 1);
  expect(got).toEqual([1]);
});

test('the operating default reads no env: without a url argument it polls even when env names a server', async () => {
  const f = fixture();
  const server = f.serve();
  const saved = process.env.ELANOUS_MSG_SSE_PORT;
  process.env.ELANOUS_MSG_SSE_PORT = String(server.port);
  const got: number[] = [];
  const log = spyOn(debug, 'log');
  try {
    const handle = subscribe({ address: 'COORDINATOR', cursorPath: f.cursorPath, token: () => TOKEN,
      openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast, onMessage: message => { got.push(message.id); } });
    f.post('polled');
    await until(() => got.length === 1);
    await handle.stop();
    expect(log.mock.calls.some(call => call[0] === 'msg.sse-client' && call[1] === 'connect')).toBe(false);
    expect(server.stats().subscribers).toBe(0);
  } finally {
    log.mockRestore();
    if (saved === undefined) delete process.env.ELANOUS_MSG_SSE_PORT; else process.env.ELANOUS_MSG_SSE_PORT = saved;
  }
});

test('a cursor file written for another address is ignored, so nothing is skipped', async () => {
  const f = fixture();
  const shared = join(f.dir, 'cursor', 'shared.json');
  f.post('for coordinator');  // #1 — a borrowed OP cursor (3) would skip it
  const ops: number[] = [];
  const op = subscribe({ address: 'OP', cursorPath: shared, openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast,
    onMessage: message => { ops.push(message.id); } });
  f.post('one', 'OP'); f.post('two', 'OP');
  await until(() => ops.length === 2);
  await op.stop();
  expect(JSON.parse(readFileSync(shared, 'utf8'))).toMatchObject({ address: 'OP', lastEventId: 3 });
  const got: number[] = [];
  const log = spyOn(debug, 'log');
  try {
    subscribe({ address: 'COORDINATOR', cursorPath: shared, openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast,
      onMessage: message => { got.push(message.id); } });
    await until(() => got.length === 1);
    expect(got).toEqual([1]);
    expect(log.mock.calls.find(call => call[0] === 'msg.sse-client' && call[1] === 'cursor-address-mismatch')?.[2])
      .toMatchObject({ address: 'COORDINATOR', fileAddress: 'OP' });
  } finally { log.mockRestore(); }
});

test('stop() ends delivery — no callback after it, over SSE or polling', async () => {
  const f = fixture();
  const server = f.serve();
  const got: number[] = [];
  const handle = subscribe({ address: 'COORDINATOR', url: `http://127.0.0.1:${server.port}`, token: () => TOKEN, cursorPath: f.cursorPath,
    openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast, onMessage: message => { got.push(message.id); } });
  f.post('before');
  await until(() => got.length === 1);
  await handle.stop();
  f.post('after');
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(got).toEqual([1]);
  // Polling path: same promise without any post office.
  const polled: number[] = [];
  const polling = subscribe({ address: 'COORDINATOR', cursorPath: join(f.dir, 'cursor', 'poll.json'),
    openStore: () => new MsgStore(f.path, { readOnly: true }), ...fast, onMessage: message => { polled.push(message.id); } });
  await until(() => polled.length === 2);
  await polling.stop();
  f.post('after polling stop');
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(polled).toEqual([1, 2]);
});
