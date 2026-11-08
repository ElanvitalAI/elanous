import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import { challengeMessage, createPhoneChannel, MAX_FRAME_BYTES, serverIdFromPublicKey } from './channel.js';
export { challengeMessage } from './channel.js';
import { MAX_MUX_FRAME_BYTES, MuxDecoder, MuxEncoder, MuxStreamState } from './mux.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_CLIENTS_PER_SERVER = 8;
const BYTES_PER_SECOND = 1024 * 1024;
const BURST_BYTES = 2 * BYTES_PER_SECOND;
const PING_INTERVAL_MS = 30_000;
const DEAD_PEER_MS = 90_000;
const AUTH_TIMEOUT_MS = 10_000;

type SocketData = { role: 'host' | 'client'; serverId: string; clientId?: number; challenge?: string; authenticated: boolean; lastSeen: number; tokens: number; refillAt: number; authTimer?: ReturnType<typeof setTimeout> };
type Socket = ServerWebSocket<SocketData>;
type PublicResponse = { status: number; headers: Record<string, string>; body: string };
type PublicRequest = { channel: import('./channel.js').EncryptedChannel; decoder: MuxDecoder; resolve: (response: Response) => void; timer: ReturnType<typeof setTimeout>; publicHost: string; internalHost: string; releaseSlot: () => void; response?: PublicResponse };
type Room = { host?: Socket; hostPublicKey?: Uint8Array; clients: Map<number, Socket>; publicRequests: Map<number, PublicRequest>; publicSlots: number; nextId: number; bytes: number; failures: Record<string, number> };

export interface RelayServerOptions {
  port?: number;
  hostname?: string;
  /** Ed25519 signing public keys (base64url raw 32 bytes), pinned by X25519-derived serverId. */
  trustedHostKeys?: ReadonlyMap<string, string>;
  /** Opt in to the invited-app reverse proxy for exactly this public domain. */
  publicDomain?: 'elanous.app';
  /** One pinned Nexus host receives requests for its configured user id only. */
  publicServerId?: string;
  /** User label bound to the pinned public Nexus host; multi-user dispatch belongs to ops relay. */
  publicUserId?: string;
  /** @internal Short timeout for focused relay lifecycle tests. */
  publicRequestTimeoutMsForTesting?: number;
}

export function parsePublicAppHost(value: string, domain = 'elanous.app'): { app: string; user: string } | undefined {
  const hostname = value.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const suffix = `.${domain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const label = hostname.slice(0, -suffix.length);
  if (!label || label.includes('.')) return undefined;
  const parts = label.split('--');
  if (parts.length !== 2) return undefined;
  const [app, user] = parts as [string, string];
  const valid = (part: string, max: number) => part.length <= max && !part.includes('--')
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part);
  if (!valid(app, 24) || !valid(user, 20) || user.length < 3 || /-pr\d+$/.test(app)) return undefined;
  if (['www', 'docs', 'api', 'admin', 'relay', 'mail'].includes(app)) return undefined;
  return { app, user };
}

function responseFromPublicEnvelope(value: PublicResponse | undefined, publicHost: string, internalHost: string): Response {
  if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599
    || typeof value.body !== 'string' || !/^(?:[A-Za-z0-9+/]*={0,2})$/.test(value.body)) {
    return new Response('Bad gateway', { status: 502 });
  }
  const connectionTokens = new Set((Object.entries(value.headers).find(([name]) => name.toLowerCase() === 'connection')?.[1] ?? '')
    .split(',').map(token => token.trim().toLowerCase()).filter(token => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token)));
  const headers = new Headers();
  for (const [name, raw] of Object.entries(value.headers)) {
    const lower = name.toLowerCase();
    if (['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'].includes(lower) || connectionTokens.has(lower)) continue;
    if (lower === 'set-cookie') {
      for (const cookie of raw.split(/,(?=[^;,]+=)/)) headers.append('set-cookie', cookie.replace(/;\s*domain=[^;]*/ig, ''));
    } else if (lower === 'x-nexus-app-origin' || lower === 'access-control-allow-origin') {
      headers.set(name, raw === `http://${internalHost}` ? `https://${publicHost}` : raw);
    } else if (lower === 'x-nexus-app-host') headers.set(name, publicHost);
    else if (lower === 'location' || lower === 'content-location') {
      try {
        const candidate = raw.trim();
        if (candidate.startsWith('//')) {
          const url = new URL(`http:${candidate}`);
          if (url.host.toLowerCase() === internalHost) {
            headers.set(name, `https://${publicHost}${url.pathname}${url.search}${url.hash}`);
          } else headers.set(name, raw);
          continue;
        }
        const url = new URL(candidate);
        if (url.protocol === 'http:' && url.host.toLowerCase() === internalHost) {
          url.protocol = 'https:';
          url.host = publicHost;
          headers.set(name, url.toString());
        } else headers.set(name, raw);
      } catch { headers.set(name, raw); }
    }
    else headers.set(name, raw);
  }
  const body = Buffer.from(value.body, 'base64');
  if (body.byteLength > MAX_MUX_FRAME_BYTES) return new Response('Response too large', { status: 502 });
  return new Response([204, 205, 304].includes(value.status) ? null : body, { status: value.status, headers });
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
  if (options.publicDomain !== undefined) {
    if (!options.publicServerId || !trustedHostKeys.has(options.publicServerId)
      || !options.publicUserId || options.publicUserId.length < 3 || options.publicUserId.length > 20
      || options.publicUserId.includes('--') || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.publicUserId)) {
      throw new Error('public relay requires a pinned publicServerId and valid publicUserId');
    }
    if (options.hostname && !['127.0.0.1', '::1', 'localhost'].includes(options.hostname)) {
      throw new Error('public relay listener must stay loopback behind the TLS edge');
    }
  } else if (options.publicServerId !== undefined || options.publicUserId !== undefined) {
    throw new Error('publicServerId and publicUserId require publicDomain');
  }
  const rooms = new Map<string, Room>();
  const sockets = new Set<Socket>();
  const roomFor = (id: string): Room => {
    let room = rooms.get(id);
    if (!room) { room = { clients: new Map(), publicRequests: new Map(), publicSlots: 0, nextId: 1, bytes: 0, failures: {} }; rooms.set(id, room); }
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
      room.hostPublicKey = undefined;
      for (const request of room.publicRequests.values()) {
        clearTimeout(request.timer);
        request.releaseSlot();
        request.resolve(new Response('Host unavailable', { status: 502 }));
      }
      room.publicRequests.clear();
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
  const publicFetch = async (req: Request): Promise<Response> => {
    const serverId = options.publicServerId!;
    const room = rooms.get(serverId);
    const hostHeader = req.headers.get('host') ?? '';
    const publicApp = parsePublicAppHost(hostHeader, options.publicDomain);
    if (!publicApp) {
      if (room) fail(room, 'public-invalid-host');
      return new Response('Not found', { status: 404 });
    }
    if (publicApp.user !== options.publicUserId) {
      if (room) fail(room, 'public-user-mismatch');
      return new Response('Not found', { status: 404 });
    }
    const publicHost = hostHeader.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const internalHost = `${publicApp.app}.app.localhost`;
    if (!room?.host || !room.hostPublicKey) {
      if (room) fail(room, 'public-host-offline');
      return new Response('Host unavailable', { status: 503 });
    }
    if (room.publicSlots >= MAX_CLIENTS_PER_SERVER) return new Response('Public request capacity reached', { status: 429 });
    room.publicSlots += 1;
    let slotHeld = true;
    const releaseSlot = () => { if (slotHeld) { slotHeld = false; room.publicSlots = Math.max(0, room.publicSlots - 1); } };
    try {
    if (req.signal.aborted) { releaseSlot(); return new Response('Request cancelled', { status: 499 }); }
    const body = new Uint8Array(await req.arrayBuffer());
    if (req.signal.aborted) { releaseSlot(); return new Response('Request cancelled', { status: 499 }); }
    if (body.byteLength > MAX_MUX_FRAME_BYTES - 1024) { releaseSlot(); return new Response('Request too large', { status: 413 }); }
    const phoneResult = await createPhoneChannel(room.hostPublicKey, room.hostPublicKey);
    if (req.signal.aborted) { releaseSlot(); return new Response('Request cancelled', { status: 499 }); }
    if (!phoneResult.ok) { releaseSlot(); return new Response('Host unavailable', { status: 503 }); }
    const phone = phoneResult.value;
    const clientId = room.nextId++;
    const streams = new MuxStreamState();
    const encoder = new MuxEncoder(streams);
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>(done => { resolve = done; });
    const pending: PublicRequest = {
      channel: phone.channel,
      decoder: new MuxDecoder(streams),
      resolve,
      timer: setTimeout(() => {
        room.publicRequests.delete(clientId);
        releaseSlot();
        if (room.host) sendControl(room.host, { type: 'client-disconnected', clientId });
        resolve(new Response('Gateway timeout', { status: 504 }));
      }, options.publicRequestTimeoutMsForTesting ?? 30_000),
      publicHost,
      internalHost,
      releaseSlot,
    };
    room.publicRequests.set(clientId, pending);
    req.signal.addEventListener('abort', () => {
      clearTimeout(pending.timer);
      room.publicRequests.delete(clientId);
      releaseSlot();
      if (room.host) sendControl(room.host, { type: 'client-disconnected', clientId });
      pending.resolve(new Response('Request cancelled', { status: 499 }));
    }, { once: true });
    if (req.signal.aborted) {
      clearTimeout(pending.timer);
      room.publicRequests.delete(clientId);
      releaseSlot();
      return new Response('Request cancelled', { status: 499 });
    }
    const send = (bytes: Uint8Array): boolean => {
      if (!room.host || room.host.readyState !== WebSocket.OPEN) return false;
      room.bytes += bytes.byteLength;
      room.host.send(encodeClientId(clientId, bytes));
      return true;
    };
    const forwardedHeaders = new Headers(req.headers);
    const connectionTokens = (forwardedHeaders.get('connection') ?? '').split(',').map(token => token.trim().toLowerCase())
      .filter(token => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token));
    for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionTokens]) {
      forwardedHeaders.delete(name);
    }
    forwardedHeaders.set('host', internalHost);
    const requestOrigin = forwardedHeaders.get('origin');
    if (requestOrigin) {
      try {
        const parsedOrigin = new URL(requestOrigin);
        if (requestOrigin === parsedOrigin.origin && parsedOrigin.origin === `https://${publicHost}`) forwardedHeaders.set('origin', `http://${internalHost}`);
      } catch { /* preserve malformed origins so the app-host rejects them */ }
    }
    const opened = encoder.encode({ streamId: 1, kind: 'open', protocol: 'http', method: req.method,
      path: `${new URL(req.url).pathname}${new URL(req.url).search}`,
      headers: Object.fromEntries(forwardedHeaders.entries()) });
    if (!opened.ok || !send(phone.phonePublicKey)) {
      clearTimeout(pending.timer); room.publicRequests.delete(clientId); releaseSlot();
      return new Response('Bad gateway', { status: 502 });
    }
    const sendFrame = (frame: Parameters<typeof encoder.encode>[0]): boolean => {
      const encoded = encoder.encode(frame);
      if (!encoded.ok) return false;
      const sealed = phone.channel.seal(encoded.value);
      return sealed.ok && send(sealed.value);
    };
    const sealedOpen = phone.channel.seal(opened.value);
    if (!sealedOpen.ok || !send(sealedOpen.value)
      || (body.byteLength > 0 && !sendFrame({ streamId: 1, kind: 'data', data: body }))
      || !sendFrame({ streamId: 1, kind: 'end' })) {
      clearTimeout(pending.timer); room.publicRequests.delete(clientId); releaseSlot();
      sendControl(room.host, { type: 'client-disconnected', clientId });
      return new Response('Bad gateway', { status: 502 });
    }
    return response;
    } catch {
      releaseSlot();
      return new Response('Bad gateway', { status: 502 });
    }
  };
  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 0,
    maxRequestBodySize: MAX_MUX_FRAME_BYTES,
    fetch(req, server) {
      const url = new URL(req.url);
      const isWebSocket = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (options.publicDomain && !isWebSocket) return publicFetch(req);
      if (url.pathname !== '/host' && url.pathname !== '/client') {
        return new Response('not found', { status: 404 });
      }
      const serverId = url.searchParams.get('serverId');
      if (!serverId || !/^[a-f0-9]{64}$/.test(serverId)) return new Response('invalid serverId', { status: 400 });
      if (!trustedHostKeys.has(serverId)) return new Response('unknown serverId', { status: 403 });
      if (!isWebSocket) return new Response('upgrade required', { status: 426 });
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
          room.hostPublicKey = undefined;
          sendControl(ws, options.publicDomain
            ? { type: 'authenticated', capabilities: ['public-http-v1'] }
            : { type: 'authenticated' });
          return;
        }
        if (typeof message === 'string') {
          if (data.role === 'host' && options.publicDomain) {
            let value: { type?: unknown; publicKey?: unknown };
            try { value = JSON.parse(message) as typeof value; } catch { value = {}; }
            const publicKey = typeof value.publicKey === 'string' ? decodeKey(value.publicKey) : undefined;
            if (value.type === 'host-public-key' && publicKey && serverIdFromPublicKey(publicKey) === data.serverId) {
              room.hostPublicKey = publicKey;
              sendControl(ws, { type: 'host-public-key-accepted' });
              return;
            }
          }
          fail(room, 'plaintext-data'); ws.close(1003, 'binary ciphertext required'); return;
        }
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
          room.bytes += bytes.length - 4;
          if (client) {
            client.send(bytes.subarray(4));
            return;
          }
          const pending = room.publicRequests.get(clientId);
          if (!pending) { fail(room, 'unknown-client'); return; }
          const opened = pending.channel.open(bytes.subarray(4));
          if (!opened.ok) {
            clearTimeout(pending.timer); room.publicRequests.delete(clientId); pending.releaseSlot();
            pending.resolve(new Response('Bad gateway', { status: 502 }));
            return;
          }
          const decoded = pending.decoder.decode(opened.value);
          if (!decoded.ok) {
            clearTimeout(pending.timer); room.publicRequests.delete(clientId); pending.releaseSlot();
            pending.resolve(new Response('Bad gateway', { status: 502 }));
            return;
          }
          if (decoded.value.kind === 'data') {
            try { pending.response = JSON.parse(new TextDecoder().decode(decoded.value.data)) as PublicResponse; }
            catch {
              clearTimeout(pending.timer); room.publicRequests.delete(clientId); pending.releaseSlot();
              pending.resolve(new Response('Bad gateway', { status: 502 }));
            }
          } else if (decoded.value.kind === 'close') {
            clearTimeout(pending.timer); room.publicRequests.delete(clientId); pending.releaseSlot();
            pending.resolve(responseFromPublicEnvelope(pending.response, pending.publicHost, pending.internalHost));
            sendControl(ws, { type: 'client-disconnected', clientId });
          }
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
      return room ? { host: !!room.host, clients: room.clients.size, publicRequests: room.publicRequests.size,
        publicSlots: room.publicSlots, bytes: room.bytes, failures: { ...room.failures } } :
        { host: false, clients: 0, publicRequests: 0, publicSlots: 0, bytes: 0, failures: {} as Record<string, number> };
    },
    stop() {
      clearInterval(heartbeat);
      for (const ws of sockets) ws.close(1001, 'relay stopping');
      for (const room of rooms.values()) {
        for (const pending of room.publicRequests.values()) {
          clearTimeout(pending.timer);
          pending.releaseSlot();
          pending.resolve(new Response('Relay stopping', { status: 503 }));
        }
        room.publicRequests.clear();
      }
      server.stop(true);
    },
  };
}
