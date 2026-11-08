import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyLike } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, constants as fsConstants } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  acceptDaemonChannel,
  challengeMessage,
  deserializeDaemonKeyPair,
  generateDaemonKeyPair,
  serializeDaemonKeyPair,
  serverIdFromPublicKey,
  type DaemonKeyPair,
  type EncryptedChannel,
} from './channel.js';
import { MAX_MUX_FRAME_BYTES, MuxDecoder, MuxEncoder, MuxStreamState, type MuxFrame } from './mux.js';
import { elanousConfigDir } from '../nexus/config/paths.js';

const CLIENT_ID_BYTES = 4;
const APP_RESPONSE_LIMIT = Math.floor((MAX_MUX_FRAME_BYTES - 1024) * 0.70);
const MAX_PENDING_REQUESTS_PER_CLIENT = 32;
const MAX_PENDING_REQUEST_BYTES_PER_CLIENT = 4 * 1024 * 1024;

export interface RelayHostResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** Base64 body keeps binary app responses intact across the mux JSON envelope. */
  readonly body: string;
}

export interface RelayHostConnectorOptions {
  readonly relayUrl: string;
  readonly daemonKeys: DaemonKeyPair;
  readonly hostSigningKey: KeyLike;
  readonly handleRequest: (request: Request) => Response | undefined | Promise<Response | undefined>;
  readonly webSocketFactory?: (url: string) => WebSocket;
  readonly onError?: (error: Error) => void;
  readonly onClose?: () => void;
  readonly signal?: AbortSignal;
  readonly readyTimeoutMs?: number;
}

export interface RelayHostIdentity {
  readonly daemonKeys: DaemonKeyPair;
  readonly hostSigningKey: KeyLike;
  readonly hostSigningPublicKey: string;
  readonly serverId: string;
}

export interface RelayHostConnection {
  readonly serverId: string;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
}

interface ClientChannel {
  readonly channel: EncryptedChannel;
  readonly decoder: MuxDecoder;
  readonly encoder: MuxEncoder;
  readonly pendingRequests: Map<number, PendingHttpRequest>;
  readonly activeRequests: Map<number, ActiveHttpRequest>;
  pendingRequestBytes: number;
  activeRequestBytes: number;
}

interface ActiveHttpRequest {
  readonly controller: AbortController;
  readonly byteLength: number;
}

interface PendingHttpRequest {
  readonly open: Extract<MuxFrame, { kind: 'open' }> & { protocol: 'http' };
  readonly url: URL;
  readonly chunks: Uint8Array[];
  readonly expectedLength?: number;
  byteLength: number;
}

const MAX_REQUEST_BODY_BYTES = MAX_MUX_FRAME_BYTES;

interface SerializedRelayHostIdentity {
  readonly version: 1;
  readonly daemonKeys: ReturnType<typeof serializeDaemonKeyPair>;
  readonly hostSigningPrivateKey: string;
  readonly hostSigningPublicKey: string;
}

function publicKeyB64url(key: KeyLike): string {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(-32).toString('base64url');
}

function descriptorPath(fd: number): string {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${fd}`;
  throw new Error('relay host identity descriptor paths are unsupported on this platform');
}

function openIdentityParent(file: string): { fd: number; path: string } {
  const configuredRoot = resolve(elanousConfigDir());
  const canonicalParent = realpathSync(dirname(configuredRoot));
  const rootName = basename(configuredRoot);
  let root = join(canonicalParent, rootName);
  try {
    if (lstatSync(root).isSymbolicLink()) throw new Error('relay host identity config directory must not use symlinks');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(root, { mode: 0o700 });
  }
  root = realpathSync(root);
  if (root !== join(canonicalParent, rootName)) throw new Error('relay host identity config directory must not use symlinks');
  const path = resolve(file);
  const rel = relative(configuredRoot, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/')) {
    throw new Error('relay host identity must stay inside the elanous config directory');
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  const directory = fsConstants.O_DIRECTORY;
  if (typeof noFollow !== 'number' || typeof directory !== 'number') throw new Error('relay host identity no-follow directory open is unavailable');
  const rootParts = relative(sep, root).split(sep).filter(Boolean);
  const parentParts = [...rootParts, ...dirname(rel).split(sep).filter(Boolean)];
  let fd = openSync(sep, fsConstants.O_RDONLY | directory | noFollow);
  try {
    for (const part of parentParts) {
      // Darwin's /dev/fd/N is readable by open/realpath but mkdir cannot create below it.
      // Resolve the already pinned directory descriptor to its canonical path there;
      // Linux keeps all child operations descriptor-relative through /proc/self/fd.
      const parentPath = process.platform === 'darwin' ? realpathSync(descriptorPath(fd)) : descriptorPath(fd);
      const child = join(parentPath, part);
      let next: number;
      try {
        next = openSync(child, fsConstants.O_RDONLY | directory | noFollow);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || (code === 'ENOTDIR' && lstatSync(child).isSymbolicLink())) {
          throw new Error('relay host identity parent directories must not use symlinks');
        }
        if (code !== 'ENOENT') throw error;
        mkdirSync(child, { mode: 0o700 });
        next = openSync(child, fsConstants.O_RDONLY | directory | noFollow);
      }
      const stat = fstatSync(next);
      if (!stat.isDirectory()) { closeSync(next); throw new Error('relay host identity parent must be a directory'); }
      if (process.platform === 'darwin') {
        try {
          const canonicalChild = realpathSync(child);
          if (canonicalChild !== child) throw new Error('relay host identity parent directories must not use symlinks');
          const named = statSync(child);
          if (named.dev !== stat.dev || named.ino !== stat.ino) throw new Error('relay host identity parent changed while opening');
        } catch (error) {
          closeSync(next);
          throw error;
        }
      }
      closeSync(fd);
      fd = next;
    }
    const parentPath = process.platform === 'darwin' ? realpathSync(descriptorPath(fd)) : descriptorPath(fd);
    return { fd, path: join(parentPath, basename(path)) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function existingIdentity(file: string): SerializedRelayHostIdentity {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') throw new Error('relay host identity no-follow open is unavailable');
  const fd = openSync(file, fsConstants.O_RDONLY | noFollow);
  let parsed: Partial<SerializedRelayHostIdentity>;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('relay host identity must be a regular file');
    if ((stat.mode & 0o077) !== 0) throw new Error('relay host identity permissions must be 0600');
    parsed = JSON.parse(readFileSync(fd, 'utf8')) as Partial<SerializedRelayHostIdentity>;
  } finally { closeSync(fd); }
  if (parsed.version !== 1 || typeof parsed.hostSigningPrivateKey !== 'string'
    || typeof parsed.hostSigningPublicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(parsed.hostSigningPublicKey)
    || typeof parsed.daemonKeys?.publicKey !== 'string' || typeof parsed.daemonKeys?.secretKey !== 'string') {
    throw new Error('invalid relay host identity file');
  }
  const signingKey = createPrivateKey(parsed.hostSigningPrivateKey);
  if (publicKeyB64url(signingKey) !== parsed.hostSigningPublicKey) throw new Error('relay host signing key pair mismatch');
  return parsed as SerializedRelayHostIdentity;
}

/** Load or create a private X25519 daemon key and Ed25519 signing key in a 0600 file. */
export async function loadOrCreateRelayHostIdentity(
  file = join(elanousConfigDir(), 'relay', 'host-key.json'),
): Promise<RelayHostIdentity> {
  const location = openIdentityParent(file);
  let serialized: SerializedRelayHostIdentity;
  try {
    try {
      serialized = existingIdentity(location.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const daemonKeys = await generateDaemonKeyPair();
      const signingKeys = generateKeyPairSync('ed25519');
      const record: SerializedRelayHostIdentity = {
        version: 1,
        daemonKeys: serializeDaemonKeyPair(daemonKeys),
        hostSigningPrivateKey: String(signingKeys.privateKey.export({ format: 'pem', type: 'pkcs8' })),
        hostSigningPublicKey: publicKeyB64url(signingKeys.privateKey),
      };
      let fileFd: number | undefined;
      try {
        fileFd = openSync(location.path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        writeFileSync(fileFd, `${JSON.stringify(record)}\n`, 'utf8');
        const written = fstatSync(fileFd);
        if ((written.mode & 0o077) !== 0 || written.nlink !== 1) throw new Error('relay host identity was not created privately');
        serialized = record;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        serialized = existingIdentity(location.path);
      } finally {
        if (fileFd !== undefined) closeSync(fileFd);
      }
    }
  } finally {
    closeSync(location.fd);
  }

  const daemon = await deserializeDaemonKeyPair(serialized.daemonKeys);
  if (!daemon.ok) throw new Error(`invalid relay daemon identity: ${daemon.reason}`);
  const hostSigningKey = createPrivateKey(serialized.hostSigningPrivateKey);
  return {
    daemonKeys: daemon.value,
    hostSigningKey,
    hostSigningPublicKey: serialized.hostSigningPublicKey,
    serverId: serverIdFromPublicKey(daemon.value.publicKey),
  };
}

function loopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function validateRelayUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('relayUrl must be a ws:// or wss:// URL'); }
  if (url.username || url.password || url.hash || (url.protocol !== 'wss:' && url.protocol !== 'ws:')) {
    throw new Error('relayUrl must be a ws:// or wss:// URL without credentials or fragment');
  }
  if (url.protocol === 'ws:' && !loopback(url.hostname.toLowerCase())) {
    throw new Error('non-loopback relay connections require wss://');
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/host';
  if (url.pathname !== '/host') throw new Error('relayUrl path must be /host');
  return url;
}

function binaryMessage(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function clientPrefixed(clientId: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(CLIENT_ID_BYTES + payload.length);
  new DataView(frame.buffer).setUint32(0, clientId, false);
  frame.set(payload, CLIENT_ID_BYTES);
  return frame;
}

function clientPrefix(data: Uint8Array): { clientId: number; payload: Uint8Array } | undefined {
  if (data.length <= CLIENT_ID_BYTES) return undefined;
  return {
    clientId: new DataView(data.buffer, data.byteOffset, CLIENT_ID_BYTES).getUint32(0, false),
    payload: data.subarray(CLIENT_ID_BYTES),
  };
}

function httpUrl(frame: Extract<MuxFrame, { kind: 'open' }>): URL | undefined {
  if (frame.protocol !== 'http') return undefined;
  const host = frame.headers.host;
  if (typeof host !== 'string' || !host || /[\s/@\\]/.test(host)) return undefined;
  try {
    const url = new URL(frame.path, `http://${host}`);
    if (url.origin !== `http://${host}` || url.username || url.password) return undefined;
    return url;
  } catch { return undefined; }
}

function requestFromPending(pending: PendingHttpRequest, signal: AbortSignal): Request | undefined {
  if (pending.expectedLength !== undefined && pending.expectedLength !== pending.byteLength) return undefined;
  const method = pending.open.method.toUpperCase();
  if ((method === 'GET' || method === 'HEAD') && pending.byteLength > 0) return undefined;
  try {
    const headers = new Headers(pending.open.headers);
    const body = pending.byteLength > 0 ? Buffer.concat(pending.chunks.map(chunk => Buffer.from(chunk))) : undefined;
    return new Request(pending.url, { method, headers, signal, ...(body ? { body } : {}) });
  } catch { return undefined; }
}

async function responseEnvelope(response: Response | undefined): Promise<RelayHostResponse> {
  if (!response) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Not Found').toString('base64') };
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > APP_RESPONSE_LIMIT) {
    return { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Response too large').toString('base64') };
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(body).toString('base64'),
  };
}

/**
 * Register this daemon as an outbound authenticated host and serve encrypted HTTP mux requests
 * through the supplied local request boundary. Public TLS termination and plain HTTP relay mode
 * are intentionally owned by the later relay-public-mode card.
 */
export async function connectRelayHost(options: RelayHostConnectorOptions): Promise<RelayHostConnection> {
  if (options.signal?.aborted) throw new Error('relay host connection aborted before start');
  const relayUrl = validateRelayUrl(options.relayUrl);
  const serverId = serverIdFromPublicKey(options.daemonKeys.publicKey);
  const requestedServerId = relayUrl.searchParams.get('serverId');
  if (requestedServerId && requestedServerId !== serverId) throw new Error('relayUrl serverId does not match daemon public key');
  relayUrl.searchParams.set('serverId', serverId);
  const socket = (options.webSocketFactory ?? (url => new WebSocket(url)))(relayUrl.toString());
  const clients = new Map<number, ClientChannel>();
  const clientQueues = new Map<number, Promise<void>>();
  let closed = false;
  let authenticated = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => rejectReady(new Error('relay host authentication timed out')), options.readyTimeoutMs ?? 10_000);
  const reportError = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    options.onError?.(normalized);
    if (!authenticated) rejectReady(normalized);
  };
  const abortConnection = () => {
    rejectReady(new Error('relay host connection aborted'));
    const closeWhenOpen = () => { if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'host connector aborted'); };
    if (socket.readyState === WebSocket.CONNECTING) socket.addEventListener('open', closeWhenOpen, { once: true });
    else closeWhenOpen();
  };
  options.signal?.addEventListener('abort', abortConnection, { once: true });
  if (options.signal?.aborted) abortConnection();

  const sendResponse = async (clientId: number, state: ClientChannel, streamId: number, response: Response | undefined) => {
    if (clients.get(clientId) !== state) return;
    const envelope = await responseEnvelope(response);
    const data = state.encoder.encode({ streamId, kind: 'data', data: new TextEncoder().encode(JSON.stringify(envelope)) });
    if (!data.ok) throw new Error(`relay response mux encode failed: ${data.reason}`);
    const sealed = state.channel.seal(data.value);
    if (!sealed.ok) throw new Error(`relay response encryption failed: ${sealed.reason}`);
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(clientPrefixed(clientId, sealed.value));
    const close = state.encoder.encode({ streamId, kind: 'close', reason: '' });
    if (!close.ok) throw new Error(`relay response mux close failed: ${close.reason}`);
    const sealedClose = state.channel.seal(close.value);
    if (!sealedClose.ok) throw new Error(`relay response close encryption failed: ${sealedClose.reason}`);
    socket.send(clientPrefixed(clientId, sealedClose.value));
  };

  const dispatchRequest = (clientId: number, state: ClientChannel, streamId: number, pending: PendingHttpRequest, active: ActiveHttpRequest) => {
    const request = requestFromPending(pending, active.controller.signal);
    if (!request) {
      state.activeRequests.delete(streamId);
      state.activeRequestBytes -= active.byteLength;
      void sendResponse(clientId, state, streamId, new Response('Invalid HTTP request body', { status: 400 })).catch(reportError);
      return;
    }
    void (async () => {
      let response: Response | undefined;
      try { response = await options.handleRequest(request); }
      catch (error) {
        if (!active.controller.signal.aborted) reportError(error);
        response = new Response('Host request failed', { status: 502 });
      }
      if (!active.controller.signal.aborted) await sendResponse(clientId, state, streamId, response);
    })().catch(error => { if (!active.controller.signal.aborted) reportError(error); })
      .finally(() => {
        if (state.activeRequests.get(streamId) === active) {
          state.activeRequests.delete(streamId);
          state.activeRequestBytes = Math.max(0, state.activeRequestBytes - active.byteLength);
        }
      });
  };

  const processBinary = async (clientId: number, payload: Uint8Array) => {
    let current = clients.get(clientId);
    if (!current) {
      if (payload.length !== 32) throw new Error(`relay client ${clientId} sent an invalid channel key`);
      const accepted = await acceptDaemonChannel(options.daemonKeys, payload);
      if (!accepted.ok) throw new Error(`relay client ${clientId} channel rejected: ${accepted.reason}`);
      const streams = new MuxStreamState();
      clients.set(clientId, {
        channel: accepted.value,
        decoder: new MuxDecoder(streams),
        encoder: new MuxEncoder(streams),
        pendingRequests: new Map(),
        activeRequests: new Map(),
        pendingRequestBytes: 0,
        activeRequestBytes: 0,
      });
      return;
    }

    const opened = current.channel.open(payload);
    if (!opened.ok) throw new Error(`relay client ${clientId} frame rejected: ${opened.reason}`);
    const decoded = current.decoder.decode(opened.value);
    if (!decoded.ok) throw new Error(`relay client ${clientId} mux rejected: ${decoded.reason}`);
    const frame = decoded.value;
    if (frame.kind === 'open') {
      const url = httpUrl(frame);
      const streamId = frame.streamId;
      if (!url || frame.protocol !== 'http') {
        await sendResponse(clientId, current, streamId, new Response('Unsupported relay request', { status: 400 }));
        return;
      }
      if (current.activeRequests.has(streamId)) {
        await sendResponse(clientId, current, streamId, new Response('Request stream is still cancelling', { status: 429 }));
        return;
      }
      if (current.pendingRequests.size + current.activeRequests.size >= MAX_PENDING_REQUESTS_PER_CLIENT) {
        await sendResponse(clientId, current, streamId, new Response('Too many pending requests', { status: 429 }));
        return;
      }
      const lengthEntry = Object.entries(frame.headers).find(([name]) => name.toLowerCase() === 'content-length');
      const lengthHeader = lengthEntry?.[1];
      if (lengthHeader !== undefined && !/^\d+$/.test(lengthHeader)) {
        await sendResponse(clientId, current, streamId, new Response('Invalid Content-Length', { status: 400 }));
        return;
      }
      const expectedLength = lengthHeader === undefined ? undefined : Number(lengthHeader);
      if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_REQUEST_BODY_BYTES)) {
        await sendResponse(clientId, current, streamId, new Response('Request body too large', { status: 413 }));
        return;
      }
      current.pendingRequests.set(streamId, {
        open: frame,
        url,
        chunks: [],
        ...(expectedLength !== undefined ? { expectedLength } : {}),
        byteLength: 0,
      });
      return;
    }

    if (frame.kind === 'data') {
      const pending = current.pendingRequests.get(frame.streamId);
      if (!pending) throw new Error(`relay client ${clientId} sent body data before HTTP open`);
      const nextLength = pending.byteLength + frame.data.byteLength;
      const pendingBytesExceeded = current.pendingRequestBytes + current.activeRequestBytes + frame.data.byteLength > MAX_PENDING_REQUEST_BYTES_PER_CLIENT;
      if (nextLength > MAX_REQUEST_BODY_BYTES
        || (pending.expectedLength !== undefined && nextLength > pending.expectedLength)
        || pendingBytesExceeded) {
        current.pendingRequests.delete(frame.streamId);
        current.pendingRequestBytes -= pending.byteLength;
        const status = pendingBytesExceeded ? 429 : 413;
        await sendResponse(clientId, current, frame.streamId, new Response(status === 429 ? 'Pending request memory limit reached' : 'Request body too large', { status }));
        return;
      }
      pending.byteLength = nextLength;
      current.pendingRequestBytes += frame.data.byteLength;
      pending.chunks.push(new Uint8Array(frame.data));
      return;
    }

    if (frame.kind === 'close') {
      const pending = current.pendingRequests.get(frame.streamId);
      if (pending) {
        current.pendingRequests.delete(frame.streamId);
        current.pendingRequestBytes -= pending.byteLength;
        return;
      }
      current.activeRequests.get(frame.streamId)?.controller.abort(new Error('relay request cancelled by peer'));
      return;
    }

    if (frame.kind === 'end') {
      const pending = current.pendingRequests.get(frame.streamId);
      if (!pending) return;
      current.pendingRequests.delete(frame.streamId);
      current.pendingRequestBytes -= pending.byteLength;
      const active: ActiveHttpRequest = { controller: new AbortController(), byteLength: pending.byteLength };
      current.activeRequests.set(frame.streamId, active);
      current.activeRequestBytes += pending.byteLength;
      dispatchRequest(clientId, current, frame.streamId, pending, active);
    }
  };

  const onControl = (raw: string) => {
    if (options.signal?.aborted) return;
    let control: { type?: unknown; nonce?: unknown; clientId?: unknown; capabilities?: unknown };
    try { control = JSON.parse(raw) as typeof control; } catch { throw new Error('invalid relay control message'); }
    if (!authenticated && control.type === 'challenge' && typeof control.nonce === 'string' && control.nonce) {
      const signature = sign(null, challengeMessage(serverId, control.nonce), options.hostSigningKey);
      socket.send(JSON.stringify({ type: 'auth', publicKey: publicKeyB64url(options.hostSigningKey),
        signature: Buffer.from(signature).toString('base64url') }));
      return;
    }
    if (control.type === 'authenticated') {
      authenticated = true;
      clearTimeout(readyTimer);
      if (Array.isArray(control.capabilities) && control.capabilities.includes('public-http-v1')) {
        socket.send(JSON.stringify({ type: 'host-public-key', publicKey: Buffer.from(options.daemonKeys.publicKey).toString('base64url') }));
      }
      resolveReady();
    }
    if (control.type === 'client-disconnected' && Number.isInteger(control.clientId)) {
      const client = clients.get(control.clientId as number);
      if (client) {
        for (const active of client.activeRequests.values()) active.controller.abort(new Error('relay client disconnected'));
        client.pendingRequests.clear();
        client.pendingRequestBytes = 0;
      }
      clients.delete(control.clientId as number);
      clientQueues.delete(control.clientId as number);
    }
  };

  socket.addEventListener('message', event => {
    if (typeof event.data === 'string') {
      try { onControl(event.data); } catch (error) { reportError(error); }
      return;
    }
    const bytes = binaryMessage(event.data);
    const prefixed = bytes && clientPrefix(bytes);
    if (!prefixed) return;
    const previous = clientQueues.get(prefixed.clientId) ?? Promise.resolve();
    const next = previous.then(() => processBinary(prefixed.clientId, prefixed.payload)).catch(reportError);
    clientQueues.set(prefixed.clientId, next);
    void next.then(() => {
      if (clientQueues.get(prefixed.clientId) === next) clientQueues.delete(prefixed.clientId);
    });
  });
  socket.addEventListener('error', () => {
    if (authenticated) options.onError?.(new Error('relay host WebSocket error'));
  });
  socket.addEventListener('close', event => {
    closed = true;
    clearTimeout(readyTimer);
    options.signal?.removeEventListener('abort', abortConnection);
    for (const client of clients.values()) {
      for (const active of client.activeRequests.values()) active.controller.abort(new Error('relay host connection closed'));
      client.pendingRequests.clear();
      client.pendingRequestBytes = 0;
    }
    clients.clear();
    clientQueues.clear();
    if (!authenticated) rejectReady(new Error(`relay host connection closed before authentication (${event.code}: ${event.reason || 'no reason'})`));
    else options.onClose?.();
  });

  try {
    await ready;
  } catch (error) {
    clearTimeout(readyTimer);
    options.signal?.removeEventListener('abort', abortConnection);
    try { socket.close(); } catch { /* already closed or connecting */ }
    throw error;
  }

  return {
    serverId,
    get readyState() { return socket.readyState; },
    close(code = 1000, reason = 'host connector stopped') {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      options.signal?.removeEventListener('abort', abortConnection);
      for (const client of clients.values()) {
        for (const active of client.activeRequests.values()) active.controller.abort(new Error('relay host connector stopped'));
        client.pendingRequests.clear();
        client.pendingRequestBytes = 0;
      }
      clients.clear();
      clientQueues.clear();
      socket.close(code, reason);
    },
  };
}
