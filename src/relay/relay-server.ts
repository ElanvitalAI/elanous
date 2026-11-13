import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import { debug } from '../debug/log.js';
import { challengeMessage, createPhoneChannel, MAX_FRAME_BYTES, serverIdFromPublicKey } from './channel.js';
export { challengeMessage } from './channel.js';
import { MAX_MUX_FRAME_BYTES, MuxDecoder, MuxEncoder, MuxStreamState } from './mux.js';
import { buildPublicDispatchRoutes, type PublicDispatchRoute } from './public-dispatch.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_CLIENTS_PER_SERVER = 8;
// Public HTTP requests are short-lived and must admit a 50-person audience burst.
// Keep the independent private WebSocket client limit at eight.
// Source: OP #92435 approves a bounded 64-slot public cap for KAIST-APP-SERVE-LOAD-50.
const MAX_PUBLIC_REQUESTS_PER_SERVER = 64;
// Source: #36294 relay member gate; the cap covers the existing public burst,
// eight private clients and one host without unbounded Nexus introspection.
const MAX_MEMBER_CHECKS = MAX_PUBLIC_REQUESTS_PER_SERVER + MAX_CLIENTS_PER_SERVER + 1;
const BYTES_PER_SECOND = 1024 * 1024;
const BURST_BYTES = 2 * BYTES_PER_SECOND;
const PING_INTERVAL_MS = 30_000;
const DEAD_PEER_MS = 90_000;
const AUTH_TIMEOUT_MS = 10_000;

export type RelayTrafficCapConfig =
  | { readonly free: { readonly memberBytesPerMinute: number; readonly connectionBytesPerMinute: number } }
  | { readonly mode: 'measure-only' };

export type RelayTrafficDirection = 'ingress' | 'egress';
export interface RelayTrafficUsage {
  readonly minute: number;
  readonly ingressBytes: number;
  readonly egressBytes: number;
}
export interface RelayTrafficStore {
  read(memberId: string, minute: number): { readonly ingressBytes: number; readonly egressBytes: number };
  /** Atomically compare the persisted member total with the cap, then add accepted bytes. */
  charge(event: { readonly memberId: string; readonly connectionId: string; readonly minute: number;
    readonly direction: RelayTrafficDirection; readonly bytes: number }, memberLimit?: number):
    { readonly status: 'allowed' | 'limited'; readonly usage: { readonly ingressBytes: number; readonly egressBytes: number } };
  close?(): void;
}

export interface RelayCustomDomainRoute {
  readonly app: string;
  readonly user: string;
  /** Set only after TXT ownership proof and CNAME target have been observed. */
  readonly ownershipVerified: boolean;
  /** The TLS edge must have an active certificate before requests are routed. */
  readonly certificateReady: boolean;
}

/** Owner-controlled opt-in file for the single pinned public user. */
export function loadRelayPublicListing(path: string): ReadonlySet<string> {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw new Error('relay public listing safe open is unavailable');
  }
  // Source: POSIX nonblocking open prevents a swapped FIFO from hanging relay startup before fstat.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const stat = fstatSync(fd);
    // Source: loadRelayTrafficCap owner-only file policy; POSIX mode 0600 keeps app selection private until published.
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('relay public listing config must be owner-only regular file');
    raw = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join() !== 'apps'
    || !Array.isArray((parsed as { apps?: unknown }).apps)
    || !(parsed as { apps: unknown[] }).apps.every(app => typeof app === 'string')) {
    throw new Error('invalid relay public listing config');
  }
  const apps = (parsed as { apps: string[] }).apps;
  if (new Set(apps).size !== apps.length) throw new Error('duplicate public listing app id');
  return new Set(apps);
}

/** Owner-only projection of domains whose DNS ownership and TLS certificate are already verified. */
export function loadRelayCustomDomainRoutes(path: string): ReadonlyMap<string, RelayCustomDomainRoute> {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw new Error('relay custom domain safe open is unavailable');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('relay custom domain config must be owner-only regular file');
    }
    raw = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join() !== 'domains'
    || !Array.isArray((parsed as { domains?: unknown }).domains)) throw new Error('invalid relay custom domain config');
  const routes = new Map<string, RelayCustomDomainRoute>();
  for (const entry of (parsed as { domains: unknown[] }).domains) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join() !== 'app,certificateReady,hostname,ownershipVerified,user') {
      throw new Error('invalid relay custom domain route entry');
    }
    const route = entry as RelayCustomDomainRoute & { hostname: string };
    if (typeof route.hostname !== 'string' || typeof route.app !== 'string' || typeof route.user !== 'string'
      || route.ownershipVerified !== true || route.certificateReady !== true) throw new Error('custom domain route is not verified');
    const hostname = route.hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!hostname || routes.has(hostname)) throw new Error('duplicate or invalid custom domain route');
    routes.set(hostname, { app: route.app, user: route.user, ownershipVerified: true, certificateReady: true });
  }
  return routes;
}

export function loadRelayTrafficCap(path: string): RelayTrafficCapConfig {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('relay traffic cap config must be owner-only regular file');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid relay traffic cap config');
  }
  if (Object.keys(parsed).join() === 'mode' && (parsed as { mode?: unknown }).mode === 'measure-only') {
    return { mode: 'measure-only' };
  }
  if (Object.keys(parsed).join() !== 'free') throw new Error('invalid relay traffic cap config');
  const free = (parsed as { free?: unknown }).free;
  if (!free || typeof free !== 'object' || Array.isArray(free)
    || Object.keys(free).sort().join() !== 'connectionBytesPerMinute,memberBytesPerMinute') {
    throw new Error('invalid relay traffic cap config');
  }
  const config = { free: free as Extract<RelayTrafficCapConfig, { free: unknown }>['free'] };
  createRelayTrafficMeter(config);
  return config;
}

/** Fixed UTC minute windows; limit values come from operator config, never a public response. */
export function createRelayTrafficMeter(config: RelayTrafficCapConfig, now: () => number = Date.now,
  store?: RelayTrafficStore) {
  const limits = 'free' in config ? config.free : undefined;
  const memberBytesPerMinute = limits?.memberBytesPerMinute;
  const connectionBytesPerMinute = limits?.connectionBytesPerMinute;
  if (limits && ![memberBytesPerMinute, connectionBytesPerMinute].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) {
    throw new Error('invalid relay traffic cap config');
  }
  if (!limits && (!('mode' in config) || config.mode !== 'measure-only' || !store)) {
    throw new Error('measure-only relay traffic requires a ledger');
  }
  let minute = -1;
  const members = new Map<string, number>();
  const connections = new Map<string, number>();
  const usage = new Map<string, { ingressBytes: number; egressBytes: number }>();
  const currentMinute = () => Math.floor(now() / 60_000);
  const rollWindow = () => {
    const current = currentMinute();
    if (current !== minute) { minute = current; members.clear(); connections.clear(); usage.clear(); }
  };
  return {
    charge(memberId: string | null | undefined, connectionId: string, bytes: number,
      direction: RelayTrafficDirection = 'ingress'): 'allowed' | 'limited' | 'member-required' | 'ledger-unavailable' {
      if (!memberId) return 'member-required';
      if (!connectionId || !Number.isSafeInteger(bytes) || bytes < 0 || !['ingress', 'egress'].includes(direction)) {
        throw new Error('invalid relay traffic measurement');
      }
      rollWindow();
      const connectionTotal = connections.get(connectionId) ?? 0;
      if (connectionBytesPerMinute !== undefined && connectionTotal + bytes > connectionBytesPerMinute) return 'limited';
      if (store) {
        let result: ReturnType<RelayTrafficStore['charge']>;
        try { result = store.charge({ memberId, connectionId, minute, direction, bytes }, memberBytesPerMinute); }
        catch { return 'ledger-unavailable'; }
        if (result.status === 'limited') return 'limited';
        usage.set(memberId, { ...result.usage });
      } else {
        const memberTotal = members.get(memberId) ?? 0;
        if (memberBytesPerMinute !== undefined && memberTotal + bytes > memberBytesPerMinute) return 'limited';
        members.set(memberId, memberTotal + bytes);
        const currentUsage = usage.get(memberId) ?? { ingressBytes: 0, egressBytes: 0 };
        currentUsage[direction === 'ingress' ? 'ingressBytes' : 'egressBytes'] += bytes;
        usage.set(memberId, currentUsage);
      }
      connections.set(connectionId, connectionTotal + bytes);
      return 'allowed';
    },
    usage(memberId: string): RelayTrafficUsage {
      rollWindow();
      const value = store?.read(memberId, minute) ?? usage.get(memberId);
      return { minute, ingressBytes: value?.ingressBytes ?? 0, egressBytes: value?.egressBytes ?? 0 };
    },
    forgetConnection(connectionId: string): void { connections.delete(connectionId); },
  };
}

type SocketData = { role: 'host' | 'client'; serverId: string; clientId?: number; challenge?: string; authenticated: boolean; lastSeen: number; tokens: number; refillAt: number; memberId?: string; connectionId: string; authTimer?: ReturnType<typeof setTimeout> };
type Socket = ServerWebSocket<SocketData>;
type PublicResponse = { status: number; headers: Record<string, string>; body: string };
type PublicRequest = { channel: import('./channel.js').EncryptedChannel; decoder: MuxDecoder; resolve: (response: Response) => void; timer: ReturnType<typeof setTimeout>; publicHost: string; internalHost: string; memberId?: string; connectionId: string; releaseSlot: () => void; response?: PublicResponse };
type AppKillSwitch = Pick<ReturnType<typeof import('./app-kill-switch.js').createAppKillSwitch>, 'applyIncident' | 'isDown' | 'close'>;
type Room = { host?: Socket; hostPublicKey?: Uint8Array; clients: Map<number, Socket>; publicRequests: Map<number, PublicRequest>; publicSlots: number; nextId: number; bytes: number; failures: Record<string, number> };

export interface RelayServerOptions {
  port?: number;
  hostname?: string;
  /** Ed25519 signing public keys (base64url raw 32 bytes), pinned by X25519-derived serverId. */
  trustedHostKeys?: ReadonlyMap<string, string>;
  /** Rollout switch. Existing relay behavior remains active until enabled. */
  memberRequired?: boolean;
  /** Server IDs are pinned to the owning Nexus member, independent of caller claims. */
  hostOwnerMemberIds?: ReadonlyMap<string, string>;
  /** Introspects relay.connect on every connection, so expiry and revocation take effect. */
  validateMemberToken?: (token: string, serverId: string) => Promise<{ memberId: string } | null>;
  /** Operator-provided private free-tier limits. The server never returns these values. */
  trafficCap?: RelayTrafficCapConfig;
  /** Optional synchronous private usage store; read/write failure rejects the measured frame. */
  trafficStore?: RelayTrafficStore;
  /** @internal Deterministic clock for traffic-window simulations. */
  trafficNowForTesting?: () => number;
  /** Durable app stop ledger used by the public report route and request gate. */
  appKillSwitch?: Pick<AppKillSwitch, 'applyIncident' | 'isDown'> & Partial<Pick<AppKillSwitch, 'close'>>;
  /** Apps whose owner explicitly opted in to public search; the default is empty. */
  publicListedApps?: ReadonlySet<string>;
  /** Opt in to the invited-app reverse proxy for exactly this public domain. */
  publicDomain?: 'elanous.app' | 'elanous.ai';
  /** Legacy single-user public host pin. */
  publicServerId?: string;
  /** Legacy single-user public label. */
  publicUserId?: string;
  /** Operator-pinned public labels for multiple authenticated Nexus hosts. */
  publicDispatchRoutes?: ReadonlyMap<string, PublicDispatchRoute>;
  /** Verified custom hostnames from the domain/certificate control plane; absent entries fail closed. */
  customDomainRoutes?: ReadonlyMap<string, RelayCustomDomainRoute>;
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

/** Public app URLs and the relay must use one configured user label. */
export function resolvePublicAppUserId(explicit?: string, environmentValue = process.env.ELANOUS_PUBLIC_APP_USER_ID): string | undefined {
  const shared = environmentValue?.trim();
  if (shared && explicit && shared !== explicit) throw new Error('--public-user-id must match ELANOUS_PUBLIC_APP_USER_ID');
  const userId = shared || explicit;
  if (userId !== undefined && (userId.length < 3 || userId.length > 20 || userId.includes('--')
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(userId))) {
    throw new Error('ELANOUS_PUBLIC_APP_USER_ID must be a valid public app user label');
  }
  return userId;
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
  if (options.memberRequired && (!options.validateMemberToken || !options.hostOwnerMemberIds
    || [...trustedHostKeys.keys()].some(id => !options.hostOwnerMemberIds?.get(id)))) {
    throw new Error('relay member gate requires a token verifier and owner for every trusted host');
  }
  if (options.trafficCap && !options.memberRequired) throw new Error('relay traffic cap requires member authentication');
  if (options.trafficCap && !options.trafficStore) throw new Error('relay traffic cap requires a durable traffic ledger');
  if (options.trafficStore && !options.trafficCap) throw new Error('relay traffic store requires traffic cap');
  const trafficMeter = options.trafficCap
    ? createRelayTrafficMeter(options.trafficCap, options.trafficNowForTesting, options.trafficStore) : null;
  const multiUser = options.publicDispatchRoutes !== undefined;
  if (multiUser && (!options.publicDomain || options.publicServerId || options.publicUserId
    || !options.memberRequired || !options.hostOwnerMemberIds)) {
    throw new Error('multi-user public dispatch requires a domain and member gate without a single-user pin');
  }
  const publicRoutes = multiUser
    ? buildPublicDispatchRoutes(options.publicDispatchRoutes!, new Set(trustedHostKeys.keys()), options.hostOwnerMemberIds!)
    : undefined;
  if (options.publicDomain !== undefined) {
    if (!multiUser && (!options.publicServerId || !trustedHostKeys.has(options.publicServerId)
      || !options.publicUserId || options.publicUserId.length < 3 || options.publicUserId.length > 20
      || options.publicUserId.includes('--') || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.publicUserId))) {
      throw new Error('public relay requires a pinned publicServerId and valid publicUserId');
    }
    if (options.hostname && !['127.0.0.1', '::1', 'localhost'].includes(options.hostname)) {
      throw new Error('public relay listener must stay loopback behind the TLS edge');
    }
  } else if (options.publicServerId !== undefined || options.publicUserId !== undefined || multiUser) {
    throw new Error('publicServerId and publicUserId require publicDomain');
  }
  const publicListedApps = new Set(options.publicListedApps ?? []);
  if (publicListedApps.size && !options.publicDomain) throw new Error('public app listing requires public relay mode');
  if (publicListedApps.size && multiUser) throw new Error('multi-user public listing requires per-user opt-in');
  for (const app of publicListedApps) {
    if (parsePublicAppHost(`${app}--${options.publicUserId}.${options.publicDomain}`, options.publicDomain)?.app !== app) {
      throw new Error('invalid public listing app id');
    }
  }
  const customDomainRoutes = new Map<string, RelayCustomDomainRoute>();
  for (const [rawHostname, route] of options.customDomainRoutes ?? []) {
    const hostname = rawHostname.trim().toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname.includes(':') || hostname.includes('/') || hostname.includes('..')
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
      || (!!options.publicDomain && !!parsePublicAppHost(hostname, options.publicDomain))
      || !options.publicDomain || !(publicRoutes?.has(route.user) || route.user === options.publicUserId)
      || !route.ownershipVerified || !route.certificateReady
      || parsePublicAppHost(`${route.app}--${route.user}.${options.publicDomain}`, options.publicDomain)?.app !== route.app) {
      throw new Error('invalid or unverified custom domain route');
    }
    if (customDomainRoutes.has(hostname)) throw new Error('duplicate custom domain route');
    customDomainRoutes.set(hostname, { ...route });
  }
  const rooms = new Map<string, Room>();
  const sockets = new Set<Socket>();
  let activeMemberChecks = 0;
  const roomFor = (id: string): Room => {
    let room = rooms.get(id);
    if (!room) { room = { clients: new Map(), publicRequests: new Map(), publicSlots: 0, nextId: 1, bytes: 0, failures: {} }; rooms.set(id, room); }
    return room;
  };
  const fail = (room: Room, reason: string) => { room.failures[reason] = (room.failures[reason] ?? 0) + 1; };
  type MemberCredential = { token: string; source: 'protocol' | 'authorization' };
  const memberCredentials = (req: Request): MemberCredential[] => {
    const credentials: MemberCredential[] = [];
    const bearer = /^Bearer\s+(emt_[A-Za-z0-9_-]+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (bearer) credentials.push({ token: bearer, source: 'authorization' });
    const protocol = req.headers.get('sec-websocket-protocol')?.split(',').map(value => value.trim())
      .find(value => /^emt_[A-Za-z0-9_-]+$/.test(value));
    if (protocol) credentials.push({ token: protocol, source: 'protocol' });
    return credentials;
  };
  type MemberGate = { status: 'allowed'; consumed: MemberCredential[] } | { status: 'denied' | 'busy'; consumed: [] };
  const memberAuthorized = async (req: Request, serverId: string): Promise<MemberGate> => {
    if (!options.memberRequired) return { status: 'allowed', consumed: [] };
    const credentials = memberCredentials(req);
    if (!credentials.length) return { status: 'denied', consumed: [] };
    if (activeMemberChecks >= MAX_MEMBER_CHECKS) return { status: 'busy', consumed: [] };
    activeMemberChecks += 1;
    const consumed: MemberCredential[] = [];
    try {
      const ownerId = options.hostOwnerMemberIds!.get(serverId);
      if (!ownerId) return { status: 'denied', consumed: [] };
      for (const credential of credentials) {
        let member: { memberId: string } | null = null;
        try { member = await options.validateMemberToken!(credential.token, serverId); } catch { /* fail closed */ }
        if (member?.memberId === ownerId) consumed.push(credential);
      }
    }
    finally { activeMemberChecks -= 1; }
    return consumed.length ? { status: 'allowed', consumed } : { status: 'denied', consumed: [] };
  };
  const sendControl = (ws: Socket, value: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const drop = (ws: Socket) => {
    const data = ws.data;
    trafficMeter?.forgetConnection(data.connectionId);
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
    const hostHeader = req.headers.get('host') ?? '';
    const normalizedHost = hostHeader.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const customRoute = customDomainRoutes.get(normalizedHost);
    const publicApp = parsePublicAppHost(hostHeader, options.publicDomain)
      ?? (customRoute ? { app: customRoute.app, user: customRoute.user } : undefined);
    if (!publicApp) {
      const legacyRoom = options.publicServerId ? rooms.get(options.publicServerId) : undefined;
      if (legacyRoom) fail(legacyRoom, 'public-invalid-host');
      return new Response('Not found', { status: 404 });
    }
    const serverId = publicRoutes?.get(publicApp.user)?.serverId ??
      (publicApp.user === options.publicUserId ? options.publicServerId : undefined);
    if (!serverId) {
      const legacyRoom = options.publicServerId ? rooms.get(options.publicServerId) : undefined;
      if (legacyRoom) fail(legacyRoom, 'public-user-mismatch');
      return new Response('Not found', { status: 404 });
    }
    const room = rooms.get(serverId);
    if (new URL(req.url).pathname === '/.well-known/elanous/apps') {
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      // Source: 내부 문서 `nexus-backend-in-a-box` APP-PUBLIC-LISTING; owner opt-in defaults off.
      const apps = [...publicListedApps].filter(app => !options.appKillSwitch?.isDown(publicApp.user, app))
        .sort().map(app => `https://${app}--${publicApp.user}.${options.publicDomain}`);
      return new Response(JSON.stringify({ apps }), { status: 200, headers: {
        'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
      } });
    }
    const reportPath = new URL(req.url).pathname === '/.well-known/elanous/report';
    if (reportPath) {
      const origin = req.headers.get('origin');
      if (origin !== 'https://elanous.app' && origin !== 'https://elanous.ai') return new Response('Forbidden', { status: 403 });
      const reportHeaders = { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type', vary: 'Origin', 'cache-control': 'no-store' };
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: reportHeaders });
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: reportHeaders });
      if (!options.appKillSwitch) return new Response('Unavailable', { status: 503, headers: reportHeaders });
      // Source: 내부 문서 `nexus-backend-in-a-box` APP-ABUSE-REPORT; bounded category-only ingress.
      const maxReportBytes = 1_024;
      if (Number(req.headers.get('content-length') ?? 0) > maxReportBytes || !req.body) {
        return new Response('Invalid report', { status: 400, headers: reportHeaders });
      }
      let raw = '';
      let bytes = 0;
      const decoder = new TextDecoder();
      const reader = req.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxReportBytes) { await reader.cancel(); return new Response('Invalid report', { status: 400, headers: reportHeaders }); }
          raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
      } catch { return new Response('Invalid report', { status: 400, headers: reportHeaders }); }
      finally { reader.releaseLock(); }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { return new Response('Invalid report', { status: 400, headers: reportHeaders }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).join() !== 'category'
        || !['abuse', 'phishing', 'spam'].includes((payload as { category?: unknown }).category as string)) {
        return new Response('Invalid report', { status: 400, headers: reportHeaders });
      }
      try {
        options.appKillSwitch.applyIncident({ userId: publicApp.user, appId: publicApp.app, incident: 'abuse-report',
          reason: (payload as { category: string }).category, requestedBy: 'public-report' });
        for (const [id, pending] of room?.publicRequests ?? []) {
          const target = parsePublicAppHost(pending.publicHost, options.publicDomain);
          if (target?.app !== publicApp.app || target.user !== publicApp.user) continue;
          clearTimeout(pending.timer); room?.publicRequests.delete(id); pending.releaseSlot();
          pending.resolve(new Response('App unavailable', { status: 403 }));
          if (room?.host) sendControl(room.host, { type: 'client-disconnected', clientId: id });
        }
      } catch { return new Response('Unavailable', { status: 503, headers: reportHeaders }); }
      return new Response(JSON.stringify({ received: true }), { status: 202,
        headers: { ...reportHeaders, 'content-type': 'application/json' } });
    }
    const memberGate = await memberAuthorized(req, serverId);
    if (memberGate.status !== 'allowed') {
      debug.log('relay.auth', 'member-denied', { serverId, route: 'public' });
      return new Response(memberGate.status === 'busy' ? 'busy' : 'unauthorized', { status: memberGate.status === 'busy' ? 429 : 401 });
    }
    if (options.appKillSwitch?.isDown(publicApp.user, publicApp.app)) return new Response('App unavailable', { status: 403 });
    const publicHost = hostHeader.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const internalHost = `${publicApp.app}.app.localhost`;
    if (!room?.host || !room.hostPublicKey) {
      if (room) fail(room, 'public-host-offline');
      return new Response('Host unavailable', { status: 503 });
    }
    if (room.publicSlots >= MAX_PUBLIC_REQUESTS_PER_SERVER) return new Response('Public request capacity reached', { status: 429 });
    room.publicSlots += 1;
    const connectionId = randomUUID();
    const memberId = options.memberRequired ? options.hostOwnerMemberIds!.get(serverId) : undefined;
    let slotHeld = true;
    const releaseSlot = () => { if (slotHeld) { slotHeld = false; room.publicSlots = Math.max(0, room.publicSlots - 1); trafficMeter?.forgetConnection(connectionId); } };
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
      memberId,
      connectionId,
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
    let trafficFailure: 'limited' | 'ledger-unavailable' | undefined;
    const send = (bytes: Uint8Array): boolean => {
      if (!room.host || room.host.readyState !== WebSocket.OPEN) return false;
      if (trafficMeter) {
        const result = trafficMeter.charge(memberId, connectionId, bytes.byteLength);
        if (result !== 'allowed') { trafficFailure = result === 'ledger-unavailable' ? result : 'limited'; return false; }
      }
      room.bytes += bytes.byteLength;
      room.host.send(encodeClientId(clientId, bytes));
      return true;
    };
    const forwardedHeaders = new Headers(req.headers);
    const connectionTokens = (forwardedHeaders.get('connection') ?? '').split(',').map(token => token.trim().toLowerCase())
      .filter(token => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token));
    for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionTokens]) {
      forwardedHeaders.delete(name);
    }
    if (memberGate.consumed.some(credential => credential.source === 'authorization')) forwardedHeaders.delete('authorization');
    const relayProtocols = new Set(memberGate.consumed.filter(credential => credential.source === 'protocol').map(credential => credential.token));
    if (relayProtocols.size) {
      const appProtocols = (forwardedHeaders.get('sec-websocket-protocol') ?? '').split(',').map(value => value.trim())
        .filter(value => value && !relayProtocols.has(value));
      if (appProtocols.length) forwardedHeaders.set('sec-websocket-protocol', appProtocols.join(', '));
      else forwardedHeaders.delete('sec-websocket-protocol');
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
      return new Response(trafficFailure === 'limited' ? 'Traffic limited' : 'Bad gateway',
        { status: trafficFailure === 'limited' ? 429 : trafficFailure ? 503 : 502 });
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
      return new Response(trafficFailure === 'limited' ? 'Traffic limited' : 'Bad gateway',
        { status: trafficFailure === 'limited' ? 429 : trafficFailure ? 503 : 502 });
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
    async fetch(req, server) {
      const url = new URL(req.url);
      const isWebSocket = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (options.publicDomain && !isWebSocket) return publicFetch(req);
      if (url.pathname !== '/host' && url.pathname !== '/client') {
        return new Response('not found', { status: 404 });
      }
      const serverId = url.searchParams.get('serverId');
      if (!serverId || !/^[a-f0-9]{64}$/.test(serverId)) return new Response('invalid serverId', { status: 400 });
      if (!trustedHostKeys.has(serverId)) return new Response('unknown serverId', { status: 403 });
      const memberGate = await memberAuthorized(req, serverId);
      if (memberGate.status !== 'allowed') {
        debug.log('relay.auth', 'member-denied', { serverId, route: url.pathname });
        return new Response(memberGate.status === 'busy' ? 'busy' : 'unauthorized', { status: memberGate.status === 'busy' ? 429 : 401 });
      }
      if (!isWebSocket) return new Response('upgrade required', { status: 426 });
      const role = url.pathname === '/host' ? 'host' : 'client';
      const now = Date.now();
      if (!server.upgrade(req, { data: { role, serverId, authenticated: false, lastSeen: now, tokens: BURST_BYTES, refillAt: now,
        memberId: options.memberRequired ? options.hostOwnerMemberIds!.get(serverId) : undefined, connectionId: randomUUID() } })) {
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
          const traffic = trafficMeter?.charge(data.memberId, data.connectionId, bytes.length);
          if (traffic && traffic !== 'allowed') {
            fail(room, traffic === 'ledger-unavailable' ? 'traffic-ledger' : 'traffic-cap');
            ws.close(traffic === 'ledger-unavailable' ? 1011 : 1008,
              traffic === 'ledger-unavailable' ? 'usage ledger unavailable' : 'traffic limited'); return;
          }
          room.bytes += bytes.length;
          room.host.send(encodeClientId(data.clientId, bytes));
        } else {
          if (room.host !== ws) { ws.close(1008, 'host replaced'); return; }
          const clientId = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
          const client = room.clients.get(clientId);
          const pending = room.publicRequests.get(clientId);
          if (!client && !pending) { fail(room, 'unknown-client'); return; }
          const traffic = trafficMeter?.charge(client ? client.data.memberId : pending?.memberId,
            client ? client.data.connectionId : pending?.connectionId ?? '', bytes.length - 4, 'egress');
          if (traffic && traffic !== 'allowed') {
            fail(room, traffic === 'ledger-unavailable' ? 'traffic-ledger' : 'traffic-cap');
            if (pending) {
              clearTimeout(pending.timer); room.publicRequests.delete(clientId); pending.releaseSlot();
              pending.resolve(new Response(traffic === 'ledger-unavailable' ? 'Bad gateway' : 'Traffic limited',
                { status: traffic === 'ledger-unavailable' ? 503 : 429 }));
            } else client?.close(traffic === 'ledger-unavailable' ? 1011 : 1008,
              traffic === 'ledger-unavailable' ? 'usage ledger unavailable' : 'traffic limited');
            return;
          }
          room.bytes += bytes.length - 4;
          if (client) {
            client.send(bytes.subarray(4));
            return;
          }
          if (!pending) return;
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
    trafficUsage(memberId: string): RelayTrafficUsage | undefined { return trafficMeter?.usage(memberId); },
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
      options.trafficStore?.close?.();
      options.appKillSwitch?.close?.();
    },
  };
}
