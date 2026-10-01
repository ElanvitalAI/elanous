import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import { MAX_FRAME_BYTES } from './channel.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_CLIENTS_PER_SERVER = 8;
const BYTES_PER_SECOND = 1024 * 1024;
const BURST_BYTES = 2 * BYTES_PER_SECOND;
const PING_INTERVAL_MS = 30_000;
const DEAD_PEER_MS = 90_000;
const AUTH_TIMEOUT_MS = 10_000;

type SocketData = { role: 'host' | 'client'; serverId: string; clientId?: number; challenge?: string; authenticated: boolean; lastSeen: number; tokens: number; refillAt: number; authTimer?: ReturnType<typeof setTimeout> };
type Socket = ServerWebSocket<SocketData>;
type Room = { host?: Socket; clients: Map<number, Socket>; nextId: number; bytes: number; failures: Record<string, number> };

export interface RelayServerOptions {
  port?: number;
  hostname?: string;
  /** Ed25519 signing public keys (base64url raw 32 bytes), pinned by X25519-derived serverId. */
  trustedHostKeys?: ReadonlyMap<string, string>;
}

/** Load operator-provisioned pins, never keys claimed by connecting hosts. */
export function loadTrustedHostKeys(file: string): ReadonlyMap<string, string> {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid relay trusted host keys');
  const result = new Map<string, string>();
  for (const [id, key] of Object.entries(raw)) {
    if (!/^[a-f0-9]{64}$/.test(id) || typeof key !== 'string' || !decodeKey(key)) {
      throw new Error('invalid relay trusted host key entry');
    }
    result.set(id, key);
  }
  return result;
}

export function challengeMessage(serverId: string, nonce: string): Uint8Array {
  return Buffer.from(`elanous-relay-v1:${serverId}:${nonce}`, 'utf8');
}

function decodeKey(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value ? decoded : undefined;
}

function encodeClientId(id: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(payload.length + 4);
  new DataView(result.buffer).setUint32(0, id, false);
  result.set(payload, 4);
  return result;
}

/** The relay never parses or logs encrypted channel payloads. Host binary frames carry a
 * four-byte big-endian clientId prefix; phone binary frames are raw ciphertext. */
export function startRelayServer(options: RelayServerOptions = {}) {
  if (!options.trustedHostKeys?.size) throw new Error('relay trusted host keys required');
  const trustedHostKeys = new Map(options.trustedHostKeys);
  for (const [id, key] of trustedHostKeys) {
    if (!/^[a-f0-9]{64}$/.test(id) || !decodeKey(key)) throw new Error('invalid relay trusted host key entry');
  }
  const rooms = new Map<string, Room>();
  const sockets = new Set<Socket>();
  const roomFor = (id: string): Room => {
    let room = rooms.get(id);
    if (!room) { room = { clients: new Map(), nextId: 1, bytes: 0, failures: {} }; rooms.set(id, room); }
    return room;
  };
  const fail = (room: Room, reason: string) => { room.failures[reason] = (room.failures[reason] ?? 0) + 1; };
  const sendControl = (ws: Socket, value: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const drop = (ws: Socket) => {
    const data = ws.data;
    if (data.authTimer) clearTimeout(data.authTimer);
    sockets.delete(ws);
    const room = rooms.get(data.serverId);
    if (!room) return;
    if (!data.authenticated) {
      if (!room.host && room.clients.size === 0 &&
          !Array.from(sockets).some(peer => peer.data.serverId === data.serverId)) rooms.delete(data.serverId);
      return;
    }
    if (data.role === 'host' && room.host === ws) {
      room.host = undefined;
      const clients = [...room.clients.values()];
      room.clients.clear();
      for (const client of clients) client.close(1012, 'host disconnected');
    } else if (data.role === 'client' && data.clientId !== undefined && room.clients.get(data.clientId) === ws) {
      room.clients.delete(data.clientId);
      if (room.host) sendControl(room.host, { type: 'client-disconnected', clientId: data.clientId });
    }
    if (!room.host && room.clients.size === 0 &&
        !Array.from(sockets).some(peer => peer.data.serverId === data.serverId)) rooms.delete(data.serverId);
  };
  const capacity = (ws: Socket, length: number): boolean => {
    const data = ws.data;
    const now = Date.now();
    data.tokens = Math.min(BURST_BYTES, data.tokens + (now - data.refillAt) * BYTES_PER_SECOND / 1000);
    data.refillAt = now;
    if (length > data.tokens) return false;
    data.tokens -= length;
    return true;
  };
  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== '/host' && url.pathname !== '/client') return new Response('not found', { status: 404 });
      const serverId = url.searchParams.get('serverId');
      if (!serverId || !/^[a-f0-9]{64}$/.test(serverId)) return new Response('invalid serverId', { status: 400 });
      if (!trustedHostKeys.has(serverId)) return new Response('unknown serverId', { status: 403 });
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('upgrade required', { status: 426 });
      const role = url.pathname === '/host' ? 'host' : 'client';
      const now = Date.now();
      if (!server.upgrade(req, { data: { role, serverId, authenticated: false, lastSeen: now, tokens: BURST_BYTES, refillAt: now } })) {
        return new Response('upgrade required', { status: 426 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES + 4,
      open(ws) {
        sockets.add(ws);
        const data = ws.data;
        const room = roomFor(data.serverId);
        if (data.role === 'host') {
          if (room.host) { fail(room, 'duplicate-host'); ws.close(1008, 'host already connected'); return; }
          data.challenge = randomBytes(32).toString('base64url');
          sendControl(ws, { type: 'challenge', nonce: data.challenge });
        } else {
          if (!room.host || room.clients.size >= MAX_CLIENTS_PER_SERVER) {
            fail(room, !room.host ? 'host-offline' : 'client-limit');
            ws.close(1008, !room.host ? 'host offline' : 'client limit reached');
            return;
          }
          const id = room.nextId++;
          data.clientId = id;
          data.authenticated = true;
          room.clients.set(id, ws);
          sendControl(ws, { type: 'connected', clientId: id });
          sendControl(room.host, { type: 'client-connected', clientId: id });
        }
        if (!data.authenticated) data.authTimer = setTimeout(() => ws.close(1008, 'authentication timeout'), AUTH_TIMEOUT_MS);
      },
      message(ws, message) {
        const data = ws.data;
        const room = rooms.get(data.serverId);
        if (!room) { ws.close(1008, 'room missing'); return; }
        data.lastSeen = Date.now();
        if (!data.authenticated) {
          if (data.role !== 'host' || typeof message !== 'string') { fail(room, 'invalid-auth'); ws.close(1008, 'authentication required'); return; }
          let auth: unknown;
          try { auth = JSON.parse(message); } catch { /* reject below */ }
          const value = auth as { type?: unknown; publicKey?: unknown; signature?: unknown } | undefined;
          const key = typeof value?.publicKey === 'string' ? decodeKey(value.publicKey) : undefined;
          const signature = typeof value?.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value.signature)
            ? Buffer.from(value.signature, 'base64url') : undefined;
          const expected = trustedHostKeys.get(data.serverId);
          let valid = false;
          if (value?.type === 'auth' && key && signature?.length === 64 && data.challenge &&
              value.publicKey === expected) {
            try {
              valid = verify(null, challengeMessage(data.serverId, data.challenge),
                createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: 'der', type: 'spki' }), signature);
            } catch { /* invalid public key */ }
          }
          if (!valid || (room.host && room.host !== ws)) { fail(room, 'invalid-auth'); ws.close(1008, 'invalid host signature'); return; }
          data.authenticated = true;
          data.challenge = undefined;
          if (data.authTimer) clearTimeout(data.authTimer);
          room.host = ws;
          sendControl(ws, { type: 'authenticated' });
          return;
        }
        if (typeof message === 'string') { fail(room, 'plaintext-data'); ws.close(1003, 'binary ciphertext required'); return; }
        const bytes = new Uint8Array(message);
        if (bytes.length > MAX_FRAME_BYTES + (data.role === 'host' ? 4 : 0) || bytes.length < (data.role === 'host' ? 5 : 1)) {
          fail(room, 'invalid-frame'); ws.close(1009, 'invalid frame size'); return;
        }
        if (!capacity(ws, bytes.length)) { fail(room, 'rate-limit'); ws.close(1008, 'rate limit exceeded'); return; }
        if (data.role === 'client') {
          if (!room.host || data.clientId === undefined) { ws.close(1012, 'host offline'); return; }
          room.bytes += bytes.length;
          room.host.send(encodeClientId(data.clientId, bytes));
        } else {
          if (room.host !== ws) { ws.close(1008, 'host replaced'); return; }
          const clientId = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
          const client = room.clients.get(clientId);
          if (!client) { fail(room, 'unknown-client'); return; }
          room.bytes += bytes.length - 4;
          client.send(bytes.subarray(4));
        }
      },
      pong(ws) { ws.data.lastSeen = Date.now(); },
      close(ws) { drop(ws); },
    },
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (Date.now() - ws.data.lastSeen > DEAD_PEER_MS) ws.close(1001, 'heartbeat timeout');
      else ws.ping();
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();
  return {
    server,
    get port() { return server.port; },
    stats(serverId: string) {
      const room = rooms.get(serverId);
      return room ? { host: !!room.host, clients: room.clients.size, bytes: room.bytes, failures: { ...room.failures } } :
        { host: false, clients: 0, bytes: 0, failures: {} as Record<string, number> };
    },
    stop() {
      clearInterval(heartbeat);
      for (const ws of sockets) ws.close(1001, 'relay stopping');
      server.stop(true);
    },
  };
}
