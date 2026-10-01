import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_FRAME_BYTES, serverIdFromPublicKey } from './channel.js';
import { challengeMessage, loadTrustedHostKeys, startRelayServer } from './relay-server.js';

type Relay = ReturnType<typeof startRelayServer>;
type Message = string | Uint8Array;
const servers: Relay[] = [];
const openSockets: WebSocket[] = [];
const inbox = new WeakMap<WebSocket, Message[]>();
const waiters = new WeakMap<WebSocket, (value: Message) => void>();
const closeEvents = new WeakMap<WebSocket, CloseEvent>();
const closeWaiters = new WeakMap<WebSocket, (value: CloseEvent) => void>();
const signing = () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pair, publicKey, id: serverIdFromPublicKey(new Uint8Array(generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))) };
};
function relay(key: ReturnType<typeof signing>) {
  const instance = startRelayServer({ trustedHostKeys: new Map([[key.id, key.publicKey]]) });
  servers.push(instance);
  return instance;
}
function connected(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.push(ws);
    ws.binaryType = 'arraybuffer';
    inbox.set(ws, []);
    ws.addEventListener('message', event => {
      const value = typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const waiter = waiters.get(ws);
      if (waiter) { waiters.delete(ws); waiter(value); }
      else inbox.get(ws)!.push(value);
    });
    ws.addEventListener('close', event => {
      closeEvents.set(ws, event);
      closeWaiters.get(ws)?.(event);
      closeWaiters.delete(ws);
    });
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('connection failed')), { once: true });
  });
}
function next(ws: WebSocket): Promise<Message> {
  const queued = inbox.get(ws)?.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 2000);
    waiters.set(ws, value => { clearTimeout(timer); resolve(value); });
  });
}
function closed(ws: WebSocket): Promise<CloseEvent> {
  const event = closeEvents.get(ws);
  if (event) return Promise.resolve(event);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), 2000);
    closeWaiters.set(ws, event => { clearTimeout(timer); resolve(event); });
  });
}
async function host(server: Relay, key: ReturnType<typeof signing>) {
  const ws = await connected(`ws://127.0.0.1:${server.port}/host?serverId=${key.id}`);
  const challenge = JSON.parse(await next(ws) as string) as { type: string; nonce: string };
  expect(challenge.type).toBe('challenge');
  const signature = sign(null, challengeMessage(key.id, challenge.nonce), key.pair.privateKey).toString('base64url');
  ws.send(JSON.stringify({ type: 'auth', publicKey: key.publicKey, signature }));
  expect(JSON.parse(await next(ws) as string)).toEqual({ type: 'authenticated' });
  return { ws, key };
}
afterEach(() => {
  for (const ws of openSockets.splice(0)) ws.close();
  for (const server of servers.splice(0)) server.stop();
});

describe('Bun encrypted-frame relay', () => {
  test('relay serve starts from CLI with operator-pinned keys and rejects unregistered IDs', async () => {
    const key = signing();
    const dir = mkdtempSync(join(tmpdir(), 'relay-cli-'));
    const file = join(dir, 'trusted.json');
    writeFileSync(file, JSON.stringify({ [key.id]: key.publicKey }));
    const child = spawn(process.execPath, [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', 'relay', 'serve', '--port', '0', '--trusted-host-keys', file], {
      cwd: resolve(import.meta.dir, '../..'), env: { ...process.env, NODE_ENV: 'test', ELANOUS_CONFIG_DIR: dir, ELANOUS_STATE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const address = await new Promise<number>((resolvePort, reject) => {
        const timer = setTimeout(() => reject(new Error('relay CLI startup timeout')), 8000);
        child.stdout!.on('data', (chunk: Buffer) => {
          const match = chunk.toString().match(/relay listening on 127\.0\.0\.1:(\d+)/);
          if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`relay CLI exited ${code}`)); });
      });
      expect((await fetch(`http://127.0.0.1:${address}/host?serverId=${signing().id}`)).status).toBe(403);
      const daemon = await connected(`ws://127.0.0.1:${address}/host?serverId=${key.id}`);
      const challenge = JSON.parse(await next(daemon) as string) as { nonce: string };
      daemon.send(JSON.stringify({ type: 'auth', publicKey: key.publicKey,
        signature: sign(null, challengeMessage(key.id, challenge.nonce), key.pair.privateKey).toString('base64url') }));
      expect(JSON.parse(await next(daemon) as string)).toEqual({ type: 'authenticated' });
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>(resolveExit => { if (child.exitCode !== null || child.signalCode !== null) resolveExit(); else child.once('exit', () => resolveExit()); });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('requires a fresh correctly signed challenge bound to serverId and rejects unauthenticated traffic', async () => {
    const key = signing();
    const server = relay(key);
    const impostor = signing();
    const url = `ws://127.0.0.1:${server.port}/host?serverId=${key.id}`;
    const attacker = await connected(url);
    const first = JSON.parse(await next(attacker) as string) as { nonce: string };
    const invalid = closed(attacker);
    attacker.send(JSON.stringify({ type: 'auth', publicKey: key.publicKey,
      signature: sign(null, challengeMessage(key.id, first.nonce), impostor.pair.privateKey).toString('base64url') }));
    expect((await invalid).code).toBe(1008);
    const replay = await connected(url);
    const second = JSON.parse(await next(replay) as string) as { nonce: string };
    expect(second.nonce).not.toBe(first.nonce);
    const rejected = closed(replay);
    replay.send(JSON.stringify({ type: 'auth', publicKey: key.publicKey,
      signature: sign(null, challengeMessage(key.id, first.nonce), key.pair.privateKey).toString('base64url') }));
    expect((await rejected).code).toBe(1008);
    const unauthenticated = await connected(url);
    await next(unauthenticated);
    const dataRejected = closed(unauthenticated);
    unauthenticated.send(new Uint8Array([1]));
    expect((await dataRejected).code).toBe(1008);
    expect((await host(server, key)).ws.readyState).toBe(WebSocket.OPEN);
  });

  test('pins a separate signing key to an X25519-derived serverId', async () => {
    const key = signing();
    const other = signing();
    const serverId = key.id;
    const dir = mkdtempSync(join(tmpdir(), 'relay-keys-'));
    const file = join(dir, 'trusted.json');
    writeFileSync(file, JSON.stringify({ [serverId]: key.publicKey }));
    const server = startRelayServer({ trustedHostKeys: loadTrustedHostKeys(file) });
    rmSync(dir, { recursive: true });
    servers.push(server);
    expect((await fetch(`http://127.0.0.1:${server.port}/host?serverId=${other.id}`)).status).toBe(403);
    expect(() => startRelayServer()).toThrow();
    const url = `ws://127.0.0.1:${server.port}/host?serverId=${serverId}`;
    const attacker = await connected(url);
    const challenge = JSON.parse(await next(attacker) as string) as { nonce: string };
    const rejected = closed(attacker);
    attacker.send(JSON.stringify({ type: 'auth', publicKey: other.publicKey,
      signature: sign(null, challengeMessage(serverId, challenge.nonce), other.pair.privateKey).toString('base64url') }));
    expect((await rejected).code).toBe(1008);
    const daemon = await connected(url);
    const fresh = JSON.parse(await next(daemon) as string) as { nonce: string };
    daemon.send(JSON.stringify({ type: 'auth', publicKey: key.publicKey,
      signature: sign(null, challengeMessage(serverId, fresh.nonce), key.pair.privateKey).toString('base64url') }));
    expect(JSON.parse(await next(daemon) as string)).toEqual({ type: 'authenticated' });
  });

  test('routes opaque ciphertext between one authenticated host and multiple clients, then cleans up', async () => {
    const key = signing();
    const server = relay(key);
    const { ws: daemon } = await host(server, key);
    const duplicate = await connected(`ws://127.0.0.1:${server.port}/host?serverId=${key.id}`);
    expect((await closed(duplicate)).code).toBe(1008);
    const client1 = await connected(`ws://127.0.0.1:${server.port}/client?serverId=${key.id}`);
    const c1 = JSON.parse(await next(client1) as string) as { clientId: number };
    expect(JSON.parse(await next(daemon) as string)).toEqual({ type: 'client-connected', clientId: c1.clientId });
    const client2 = await connected(`ws://127.0.0.1:${server.port}/client?serverId=${key.id}`);
    const c2 = JSON.parse(await next(client2) as string) as { clientId: number };
    expect(JSON.parse(await next(daemon) as string)).toEqual({ type: 'client-connected', clientId: c2.clientId });
    expect(c1.clientId).not.toBe(c2.clientId);
    const bytes = new Uint8Array([0, 255, 39, 72, 41]);
    const toDaemon = next(daemon);
    client2.send(bytes);
    const tagged = toIdBytes(c2.clientId, bytes);
    expect(await toDaemon).toEqual(tagged);
    const toClient = next(client1);
    daemon.send(toIdBytes(c1.clientId, bytes));
    expect(await toClient).toEqual(bytes);
    expect(server.stats(key.id)).toMatchObject({ host: true, clients: 2, bytes: bytes.length * 2 });
    const hostClosed = closed(client1);
    daemon.close();
    expect((await hostClosed).code).toBe(1012);
    expect((await closed(client2)).code).toBe(1012);
    const replacement = await host(server, key);
    expect(server.stats(key.id).clients).toBe(0);
    const client3 = await connected(`ws://127.0.0.1:${server.port}/client?serverId=${key.id}`);
    const c3 = JSON.parse(await next(client3) as string) as { clientId: number };
    expect(JSON.parse(await next(replacement.ws) as string)).toEqual({ type: 'client-connected', clientId: c3.clientId });
    expect(server.stats(key.id).clients).toBe(1);
    const toReplacement = next(replacement.ws);
    client3.send(bytes);
    expect(await toReplacement).toEqual(toIdBytes(c3.clientId, bytes));
  });

  test('rejects oversized client frames, plaintext, offline clients and enforces client capacity', async () => {
    const key = signing();
    const server = relay(key);
    const offline = await connected(`ws://127.0.0.1:${server.port}/client?serverId=${key.id}`);
    expect((await closed(offline)).code).toBe(1008);
    const { ws: daemon } = await host(server, key);
    const clients: WebSocket[] = [];
    for (let i = 0; i < 8; i++) {
      const ws = await connected(`ws://127.0.0.1:${server.port}/client?serverId=${key.id}`);
      await next(ws);
      await next(daemon);
      clients.push(ws);
    }
    const full = await connected(`ws://127.0.0.1:${server.port}/client?serverId=${key.id}`);
    expect((await closed(full)).code).toBe(1008);
    const plaintextClose = closed(clients[0]!);
    clients[0]!.send('Bearer must never be relayed');
    expect((await plaintextClose).code).toBe(1003);
    const oversize = closed(clients[1]!);
    clients[1]!.send(new Uint8Array(MAX_FRAME_BYTES + 1));
    expect((await oversize).code).toBe(1009);
    expect(server.stats(key.id).failures['plaintext-data']).toBe(1);
  });
});

function toIdBytes(id: number, payload: Uint8Array) {
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, id);
  frame.set(payload, 4);
  return frame;
}
