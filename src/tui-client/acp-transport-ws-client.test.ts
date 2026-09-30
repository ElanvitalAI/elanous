import { afterEach, expect, test } from 'bun:test';
import { connectWebSocketClient, type ConnectWebSocketClientOpts } from './acp-transport-ws-client.js';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serveWebSocket(onOpen: (ws: import('bun').ServerWebSocket<unknown>) => void,
  onMessage: (ws: import('bun').ServerWebSocket<unknown>, message: string | Buffer) => void) {
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      server.upgrade(req);
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(ws) { onOpen(ws); },
      message(ws, message) { onMessage(ws, message); },
    },
  });
  servers.push(server);
  return `ws://127.0.0.1:${server.port}/v1/acp`;
}

test('authenticated connection notifies exactly once after daemon close, including the last message id', async () => {
  const url = serveWebSocket(() => {}, (ws, message) => {
    const auth = JSON.parse(String(message)) as { kind: string; token: string };
    expect(auth).toMatchObject({ kind: 'auth', token: 'secret' });
    ws.send(JSON.stringify({ ok: true }));
    ws.send(JSON.stringify({ id: 'event-42', method: 'session/update' }) + '\n');
    setTimeout(() => ws.close(1001), 10);
  });
  const events: Parameters<NonNullable<ConnectWebSocketClientOpts['onDisconnect']>>[0][] = [];
  let notify!: () => void;
  const notified = new Promise<void>((resolve) => { notify = resolve; });
  const conn = await connectWebSocketClient({
    url,
    token: 'secret',
    onDisconnect(info) { events.push(info); notify(); },
  });
  await Promise.race([
    notified,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('disconnect not observed')), 1500)),
  ]);
  await conn.readable.getReader().read();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ reason: 'close', code: 1001, lastEventId: 'event-42' });
  expect(events[0]!.afterMs).toBeGreaterThanOrEqual(0);
  expect(new Date(events[0]!.at).toISOString()).toBe(events[0]!.at);
});

test('oversized NDJSON line cannot replace last id; raw stream still delivers all frames', async () => {
  const prior = JSON.stringify({ id: 'prior' }) + '\n';
  const large = JSON.stringify({ id: 'x'.repeat(100_000) }) + '\n';
  const frames = [prior, large.slice(0, 40_000), large.slice(40_000, 80_000), large.slice(80_000)];
  const url = serveWebSocket(() => {}, (ws) => {
    ws.send(JSON.stringify({ ok: true }));
    for (const frame of frames) ws.send(frame);
    setTimeout(() => ws.close(1001), 20);
  });
  const events: Parameters<NonNullable<ConnectWebSocketClientOpts['onDisconnect']>>[0][] = [];
  const conn = await connectWebSocketClient({ url, token: 'secret', onDisconnect: (info) => { events.push(info); } });
  const received: Uint8Array[] = [];
  for await (const chunk of conn.readable) received.push(chunk);
  expect(new TextDecoder().decode(Buffer.concat(received))).toBe(frames.join(''));
  expect(events).toHaveLength(1);
  expect(events[0]?.lastEventId).toBe('prior');
});

test('id tracking resumes after an oversized line and preserves frame-spanning small ids', async () => {
  const url = serveWebSocket(() => {}, (ws) => {
    ws.send(JSON.stringify({ ok: true }));
    ws.send('z'.repeat(80_000) + '\n' + '{"id":"new');
    ws.send('-id"}\n');
    setTimeout(() => ws.close(1001), 20);
  });
  const events: Parameters<NonNullable<ConnectWebSocketClientOpts['onDisconnect']>>[0][] = [];
  const conn = await connectWebSocketClient({ url, token: 'secret', onDisconnect: (info) => { events.push(info); } });
  for await (const _chunk of conn.readable) { /* drain */ }
  expect(events).toHaveLength(1);
  expect(events[0]?.lastEventId).toBe('new-id');
});

test('close before authentication rejects with the original message and never notifies', async () => {
  const url = serveWebSocket((ws) => ws.close(1000), () => {});
  const events: unknown[] = [];
  await expect(connectWebSocketClient({
    url,
    token: 'secret',
    onDisconnect: (info) => { events.push(info); },
  })).rejects.toThrow(`server accepted the socket but never answered the auth handshake: closed before ready (${url})`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toHaveLength(0);
});
