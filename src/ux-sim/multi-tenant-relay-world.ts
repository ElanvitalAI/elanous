import { createFakeAppDbWorld } from './fake-app-db-world.js';
import { createFakeAppStorage } from './fake-app-storage.js';
import { createFakeAppTraffic } from './fake-app-traffic.js';
import { createFakeDnsCert } from './fake-dns-cert.js';

export interface MultiTenantRelayUserConfig {
  readonly id: string;
  readonly apps: readonly string[];
  readonly trafficLimitBytes: number;
  readonly storageLimitBytes: number;
  readonly capacity: number;
  readonly region?: string;
  readonly costLimitMicros?: number;
  readonly tokenTtlMs?: number;
}

export type MultiTenantIncident =
  | 'certificate-expired'
  | 'dns-failure'
  | 'relay-disconnected'
  | 'quota-exceeded'
  | 'user-machine-down'
  | 'token-expired'
  | 'token-revoked'
  | 'account-suspended'
  | 'abuse-reported-and-takedown'
  | 'data-deletion-request'
  | 'region-outage'
  | 'cost-spike';
export type MultiTenantQuotaResource = 'storage' | 'traffic';
export const MULTI_TENANT_INVENTORY_SCENARIOS = [
  { id: 'routing', label: '공개 호스트 분배·unknown 404·offline 503', incidents: ['certificate-expired', 'dns-failure', 'relay-disconnected', 'user-machine-down', 'region-outage'] },
  { id: 'app-data-storage', label: '공유 Nexus 앱 데이터·저장소·Drive·tenant quota', incidents: ['quota-exceeded', 'data-deletion-request'] },
  { id: 'oauth-token-lifecycle', label: '동일 issuer OAuth refresh·logout·만료·취소', incidents: ['token-expired', 'token-revoked', 'account-suspended'] },
  { id: 'term', label: '공유 daemon /term PTY·stream·scrollback·control', incidents: ['user-machine-down', 'region-outage'] },
  { id: 'relay-burst', label: 'tenant relay 사용량·연결 폭주와 제한 격리', incidents: ['quota-exceeded', 'cost-spike', 'abuse-reported-and-takedown'] },
  { id: 'receipt-funnel', label: 'tenant 영수증·퍼널 집계·PII 없는 관측', incidents: ['account-suspended', 'abuse-reported-and-takedown', 'data-deletion-request'] },
] as const;
export interface MultiTenantIncidentRecord {
  readonly incident: MultiTenantIncident;
  readonly userId: string;
  readonly resource?: MultiTenantQuotaResource;
  readonly previousQuotaLimitBytes?: number;
  readonly previousCostMicros?: number;
  readonly affectedUserIds: readonly string[];
  readonly isolated: boolean;
  readonly recovery: string;
  readonly recovered: boolean;
  readonly recovering?: boolean;
}

export interface MultiTenantUserView {
  readonly id: string;
  readonly homeHost: string;
  readonly dnsNames: readonly string[];
  readonly appHosts: Readonly<Record<string, string>>;
  readonly fakeGoogleSubject: string;
  readonly token: string;
  readonly sessionId: string;
  readonly certificateExpiresAt: number;
  readonly certificateValid: boolean;
  readonly dnsAvailable: boolean;
  readonly machineOnline: boolean;
  readonly accountSuspended: boolean;
  readonly abuseTakedown: boolean;
  readonly dataDeletionRequested: boolean;
  region: string;
  readonly trafficBytesUsed: number;
  readonly costMicrosUsed: number;
  readonly limits: { readonly trafficBytes: number; readonly storageBytes: number; readonly capacity: number; readonly costMicros: number };
  readonly relayConnected: boolean;
}

export interface MultiTenantRelayWorld {
  readonly externalGoogleCalls: 0;
  readonly externalNetworkCalls: 0;
  users(): readonly MultiTenantUserView[];
  user(id: string): MultiTenantUserView | undefined;
  dispatch(host: string, requestBytes?: number): { status: 200 | 401 | 403 | 404 | 423 | 429 | 503; userId?: string; app?: string };
  write(userId: string, app: string, key: string, body: string): number;
  read(userId: string, app: string, key: string): string | undefined;
  appDataPut(userId: string, app: string, key: string, value: string): boolean;
  appDataGet(userId: string, app: string, key: string): string | undefined;
  drivePut(userId: string, key: string, body: string): void;
  driveGet(userId: string, key: string): string | undefined;
  spendTraffic(userId: string, bytes: number): number;
  inject(userId: string, incident: MultiTenantIncident, resource?: MultiTenantQuotaResource): MultiTenantIncidentRecord;
  recover(userId: string, incident: MultiTenantIncident, resource?: MultiTenantQuotaResource): Promise<boolean>;
  incidents(): readonly MultiTenantIncidentRecord[];
  receipts(): readonly { readonly userId: string; readonly kind: string; readonly status: number }[];
  close(): void;
}

interface UserState {
  readonly config: MultiTenantRelayUserConfig;
  readonly googleOAuth: FakeGoogleOAuthAccount;
  readonly appHosts: Map<string, string>;
  readonly dnsCert: ReturnType<typeof createFakeDnsCert>;
  readonly storage: ReturnType<typeof createFakeAppStorage>;
  readonly db: ReturnType<typeof createFakeAppDbWorld>;
  traffic: ReturnType<typeof createFakeAppTraffic>;
  readonly drive: Map<string, string>;
  relayConnected: boolean;
  requestBytes: number;
  storageBytesUsed: number;
  readonly storageObjectBytes: Map<string, number>;
  storageLimitBytes: number;
  readonly region: string;
  dnsAvailable: boolean;
  machineOnline: boolean;
  accountSuspended: boolean;
  abuseTakedown: boolean;
  dataDeletionRequested: boolean;
  costMicrosUsed: number;
  readonly costLimitMicros: number;
  readonly clock: { offsetMs: number; now(): number; advancePast(timestamp: number): void };
  readonly certificateClock: { offsetMs: number; now(): number; advancePast(timestamp: number): void };
}

const TOKEN_TTL_MS = 60 * 60_000;
const CERTIFICATE_LIFETIME_MS = 90 * 24 * 60 * 60_000;
const DEFAULT_COST_LIMIT_MICROS = 1_000_000;

interface FakeGoogleOAuthAccount {
  readonly subject: string;
  readonly sessionId: string;
  token: string;
  expiresAt: number;
  revoked: boolean;
  revoke(): void;
  reauthorize(now: number, ttlMs: number): void;
}

/** Follows the injectable fake-provider seam used by the existing OAuth UX simulator. */
function createFakeGoogleOAuthAccount(userId: string, now: number, ttlMs: number): FakeGoogleOAuthAccount {
  let generation = 1;
  return {
    subject: `fake-google-subject:${userId}`,
    sessionId: `fake-google-session:${userId}`,
    token: `fake-google-access:${userId}:${generation}`,
    expiresAt: now + ttlMs,
    revoked: false,
    revoke() { this.revoked = true; },
    reauthorize(at, ttl) {
      this.revoked = false;
      this.expiresAt = at + ttl;
      this.token = `fake-google-access:${userId}:${++generation}`;
    },
  };
}

function validPart(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) && !value.includes('--');
}

function requirePositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function createTraffic(config: MultiTenantRelayUserConfig): ReturnType<typeof createFakeAppTraffic> {
  return createFakeAppTraffic({
    windowMs: 60_000,
    warningBytes: Math.floor(config.trafficLimitBytes / 3),
    throttleBytes: Math.floor((config.trafficLimitBytes * 2) / 3),
    blockBytes: config.trafficLimitBytes,
  });
}

/**
 * A test-only multi-tenant world. Google OAuth, DNS, certificates, storage,
 * app data, drive, traffic, and receipts are all local devices. No live Google
 * client or network transport is imported or called.
 */
export async function createMultiTenantRelayWorld(configs: readonly MultiTenantRelayUserConfig[], options: { now?: () => number } = {}): Promise<MultiTenantRelayWorld> {
  const now = options.now ?? Date.now;
  const users = new Map<string, UserState>();
  const receiptRows: Array<{ userId: string; kind: string; status: number }> = [];
  const incidentRows: MultiTenantIncidentRecord[] = [];
  const seenHosts = new Set<string>();
  const allocatedStorages: Array<ReturnType<typeof createFakeAppStorage>> = [];
  const allocatedDbs: Array<ReturnType<typeof createFakeAppDbWorld>> = [];

  try {
    for (const config of configs) {
    if (!validPart(config.id) || config.id.length < 3 || config.id.length > 20) throw new Error(`invalid tenant id: ${config.id}`);
    if (users.has(config.id)) throw new Error(`duplicate tenant id: ${config.id}`);
    requirePositive(config.trafficLimitBytes, 'trafficLimitBytes');
    requirePositive(config.storageLimitBytes, 'storageLimitBytes');
    requirePositive(config.capacity, 'capacity');
    const ttl = config.tokenTtlMs ?? TOKEN_TTL_MS;
    requirePositive(ttl, 'tokenTtlMs');
    const costLimitMicros = config.costLimitMicros ?? DEFAULT_COST_LIMIT_MICROS;
    requirePositive(costLimitMicros, 'costLimitMicros');
    const appHosts = new Map<string, string>();
    for (const app of config.apps) {
      if (!validPart(app) || app.length > 24) throw new Error(`invalid app slug: ${app}`);
      const host = `${app}--${config.id}.elanous.app`;
      if (seenHosts.has(host)) throw new Error(`duplicate public host: ${host}`);
      seenHosts.add(host);
      appHosts.set(app, host);
    }
    const homeHost = `${config.id}.elanous.app`;
    if (seenHosts.has(homeHost)) throw new Error(`duplicate public host: ${homeHost}`);
    seenHosts.add(homeHost);
    const clock = {
      offsetMs: 0,
      now() { return now() + this.offsetMs; },
      advancePast(timestamp: number) { this.offsetMs += Math.max(0, timestamp - this.now() + 1); },
    };
    const certificateClock = {
      offsetMs: 0,
      now() { return now() + this.offsetMs; },
      advancePast(timestamp: number) { this.offsetMs += Math.max(0, timestamp - this.now() + 1); },
    };
    const dnsCert = createFakeDnsCert({ now: () => certificateClock.now(), certificateLifetimeMs: CERTIFICATE_LIFETIME_MS });
    dnsCert.registerApp(homeHost);
    for (const host of appHosts.values()) dnsCert.registerApp(host);
    const certificate = await dnsCert.issueCertificate();
    if (certificate.status !== 'issued') throw new Error(`fake certificate issuance failed for tenant ${config.id}: ${certificate.status}`);
    // The world owns the aggregate tenant quota across apps; this local port only stores objects.
    const storage = createFakeAppStorage({ appQuotaBytes: Number.MAX_SAFE_INTEGER });
    allocatedStorages.push(storage);
    const manifests = config.apps.map((slug) => ({
      apiVersion: 'elanous.app/v0', slug, title: slug,
      tables: { docs: { columns: { id: { type: 'text', primary: true }, content: { type: 'text' } } } },
      rpc: {
        putDoc: { sql: 'INSERT OR REPLACE INTO docs (id, content) VALUES (:id, :content)', allow: ['owner'], params: { id: { type: 'text' }, content: { type: 'text' } } },
        getDoc: { sql: 'SELECT content FROM docs WHERE id = :id', allow: ['owner'], params: { id: { type: 'text' } } },
      },
    })) as never;
    const db = createFakeAppDbWorld(manifests);
    allocatedDbs.push(db);
    users.set(config.id, {
      config, googleOAuth: createFakeGoogleOAuthAccount(config.id, clock.now(), ttl), clock, certificateClock,
      appHosts, dnsCert, storage, db,
      traffic: createTraffic(config),
      drive: new Map(),
      relayConnected: true, requestBytes: 0,
      storageBytesUsed: 0, storageObjectBytes: new Map(), storageLimitBytes: config.storageLimitBytes,
      region: config.region ?? 'default', dnsAvailable: true, machineOnline: true,
      accountSuspended: false, abuseTakedown: false, dataDeletionRequested: false,
      costMicrosUsed: 0, costLimitMicros,
    });
    }
  } catch (error) {
    for (const storage of allocatedStorages) storage.close();
    for (const db of allocatedDbs) db.close();
    throw error;
  }

  function record(userId: string, kind: string, status: number): void { receiptRows.push({ userId, kind, status }); }
  function regionUnavailable(region: string): boolean {
    return incidentRows.some((row) => row.incident === 'region-outage' && !row.recovered
      && users.get(row.userId)?.region === region);
  }
  function refreshRelayConnectivity(): void {
    const relayBlocking = new Set<MultiTenantIncident>([
      'relay-disconnected', 'user-machine-down', 'token-expired', 'token-revoked',
      'account-suspended', 'abuse-reported-and-takedown', 'region-outage',
    ]);
    for (const [userId, state] of users) {
      state.relayConnected = !incidentRows.some((row) => !row.recovered && relayBlocking.has(row.incident)
        && (row.userId === userId || (row.incident === 'region-outage' && users.get(row.userId)?.region === state.region)));
    }
  }
  function view(id: string, state: UserState): MultiTenantUserView {
    const certificate = state.dnsCert.certificate();
    return {
      id, homeHost: `${id}.elanous.app`, appHosts: Object.fromEntries(state.appHosts), token: state.googleOAuth.token,
      fakeGoogleSubject: state.googleOAuth.subject,
      sessionId: state.googleOAuth.sessionId, dnsNames: state.dnsCert.apps(), relayConnected: state.relayConnected,
      certificateExpiresAt: certificate?.expiresAt ?? 0,
      certificateValid: !!certificate && state.certificateClock.now() < certificate.expiresAt,
      dnsAvailable: state.dnsAvailable, machineOnline: state.machineOnline,
      accountSuspended: state.accountSuspended, abuseTakedown: state.abuseTakedown,
      dataDeletionRequested: state.dataDeletionRequested, region: state.region,
      trafficBytesUsed: state.requestBytes,
      costMicrosUsed: state.costMicrosUsed,
      limits: { trafficBytes: state.config.trafficLimitBytes, storageBytes: state.storageLimitBytes, capacity: state.config.capacity, costMicros: state.costLimitMicros },
    };
  }
  function authorize(state: UserState): boolean {
    const tokenIncidentActive = incidentRows.some((row) => row.userId === state.config.id
      && (row.incident === 'token-expired' || row.incident === 'token-revoked') && !row.recovered);
    return !tokenIncidentActive && !state.googleOAuth.revoked && state.clock.now() < state.googleOAuth.expiresAt;
  }
  function affectedBy(state: UserState, incident: MultiTenantIncident, resource?: MultiTenantQuotaResource): boolean {
    if (incident === 'certificate-expired') {
      const certificate = state.dnsCert.certificate();
      return !certificate || state.certificateClock.now() >= certificate.expiresAt;
    }
    if (incident === 'dns-failure') return !state.dnsAvailable;
    if (incident === 'relay-disconnected') return incidentRows.some((row) => row.userId === state.config.id
      && row.incident === incident && !row.recovered);
    if (incident === 'user-machine-down') return !state.machineOnline;
    if (incident === 'token-expired') return state.clock.now() >= state.googleOAuth.expiresAt
      || incidentRows.some((row) => row.userId === state.config.id && row.incident === incident && !row.recovered);
    if (incident === 'token-revoked') return state.googleOAuth.revoked
      || incidentRows.some((row) => row.userId === state.config.id && row.incident === incident && !row.recovered);
    if (incident === 'account-suspended') return state.accountSuspended;
    if (incident === 'abuse-reported-and-takedown') return state.abuseTakedown;
    if (incident === 'data-deletion-request') return state.dataDeletionRequested;
    if (incident === 'region-outage') return regionUnavailable(state.region);
    if (incident === 'cost-spike') return state.costMicrosUsed > state.costLimitMicros;
    if (incident === 'quota-exceeded') return resource === 'storage'
      ? state.storageBytesUsed > state.storageLimitBytes
      : state.traffic.usage(`tenant-${state.config.id}`).totalBytes > state.config.trafficLimitBytes;
    return false;
  }
  function write(userId: string, app: string, key: string, body: string): number {
    const state = users.get(userId);
    if (!state || !state.appHosts.has(app)) return 404;
    const objectId = `${app}/${key}`;
    if (state.dataDeletionRequested) { record(userId, 'app-storage-write', 423); return 423; }
    const previousBytes = state.storageObjectBytes.get(objectId) ?? 0;
    const nextBytes = Buffer.byteLength(body);
    if (state.storageBytesUsed - previousBytes + nextBytes > state.storageLimitBytes) {
      record(userId, 'app-storage-write', 413);
      return 413;
    }
    const result = state.storage.upload({ appSlug: app, key, body: Buffer.from(body), contentType: 'application/json' });
    if (result.status === 201) {
      state.storageBytesUsed += nextBytes - previousBytes;
      state.storageObjectBytes.set(objectId, nextBytes);
    }
    record(userId, 'app-storage-write', result.status);
    return result.status;
  }

  return {
    externalGoogleCalls: 0,
    externalNetworkCalls: 0,
    users: () => [...users].map(([id, state]) => view(id, state)),
    user: (id) => { const state = users.get(id); return state ? view(id, state) : undefined; },
    dispatch: (host, requestBytes = 1) => {
      const normalized = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
      const route = [...users].flatMap(([userId, state]) => [
        { userId, app: undefined, name: `${userId}.elanous.app`, state },
        ...[...state.appHosts].map(([app, name]) => ({ userId, app, name, state })),
      ])
        .find((candidate) => candidate.name === normalized);
      if (!route) return { status: 404 };
      const certificate = route.state.dnsCert.certificate();
      if (!certificate || route.state.certificateClock.now() >= certificate.expiresAt) { record(route.userId, 'dispatch', 503); return { status: 503, userId: route.userId, ...(route.app ? { app: route.app } : {}) }; }
      if (!route.state.dnsAvailable || !route.state.machineOnline || regionUnavailable(route.state.region)) { record(route.userId, 'dispatch', 503); return { status: 503, userId: route.userId, ...(route.app ? { app: route.app } : {}) }; }
      if (route.state.abuseTakedown) { record(route.userId, 'dispatch', 404); return { status: 404, userId: route.userId, ...(route.app ? { app: route.app } : {}) }; }
      if (route.state.accountSuspended) { record(route.userId, 'dispatch', 403); return { status: 403, userId: route.userId, ...(route.app ? { app: route.app } : {}) }; }
      if (!authorize(route.state)) { record(route.userId, 'dispatch', 401); return { status: 401, userId: route.userId, ...(route.app ? { app: route.app } : {}) }; }
      if (!route.state.relayConnected) { record(route.userId, 'dispatch', 503); return { status: 503, userId: route.userId, ...(route.app ? { app: route.app } : {}) }; }
      if (route.state.costMicrosUsed > route.state.costLimitMicros) { record(route.userId, 'dispatch', 429); return { status: 429, userId: route.userId, ...(route.app ? { app: route.app } : {}) }; }
      const traffic = route.state.traffic.beginRequest(`tenant-${route.userId}`, requestBytes);
      route.state.requestBytes += requestBytes;
      if (!traffic.decision.accepted) { record(route.userId, 'dispatch', 429); return { status: 429, userId: route.userId, ...(route.app ? { app: route.app } : {}) }; }
      traffic.stream?.finish(200);
      record(route.userId, 'dispatch', 200);
      return { status: 200, userId: route.userId, ...(route.app ? { app: route.app } : {}) };
    },
    write,
    read: (userId, app, key) => {
      const state = users.get(userId);
      if (!state || !state.appHosts.has(app)) return undefined;
      const result = state.storage.read({ appSlug: app, key });
      return result.status === 200 ? Buffer.from(result.body ?? '').toString('utf8') : undefined;
    },
    appDataPut: (userId, app, key, value) => {
      const state = users.get(userId);
      if (!state || !state.appHosts.has(app)) return false;
      state.db.rpc(app, 'putDoc', { id: key, content: value }, 'owner');
      record(userId, 'app-data-write', 200);
      return true;
    },
    appDataGet: (userId, app, key) => {
      const state = users.get(userId);
      if (!state || !state.appHosts.has(app)) return undefined;
      const rows = state.db.rpc(app, 'getDoc', { id: key }, 'owner') as Array<{ content: string }>;
      return rows[0]?.content;
    },
    drivePut: (userId, key, body) => { const state = users.get(userId); if (state) state.drive.set(key, body); },
    driveGet: (userId, key) => users.get(userId)?.drive.get(key),
    spendTraffic: (userId, bytes) => {
      const state = users.get(userId);
      if (!state || !Number.isSafeInteger(bytes) || bytes < 0) return 404;
      const request = state.traffic.beginRequest(`tenant-${userId}`, bytes);
      state.requestBytes += bytes;
      request.stream?.finish(request.decision.status);
      record(userId, 'traffic', request.decision.status);
      return request.decision.status;
    },
    inject: (userId, incident, resource = 'traffic') => {
      const state = users.get(userId);
      if (!state) throw new Error(`unknown tenant: ${userId}`);
      const resourceKey = incident === 'quota-exceeded' ? resource : undefined;
      if (incidentRows.some((row) => row.userId === userId && row.incident === incident
        && row.resource === resourceKey && !row.recovered)) {
        throw new Error(`tenant ${userId} already has an active ${incident}${resourceKey ? ` (${resourceKey})` : ''} incident`);
      }
      let recovery = '';
      let incidentResource: MultiTenantQuotaResource | undefined;
      let previousQuotaLimitBytes: number | undefined;
      let previousCostMicros: number | undefined;
      if (incident === 'certificate-expired') {
        const certificate = state.dnsCert.certificate();
        if (!certificate) throw new Error(`tenant ${userId} has no certificate to expire`);
        state.certificateClock.advancePast(certificate.expiresAt);
        recovery = 'renew the tenant wildcard certificate';
      } else if (incident === 'quota-exceeded' && resource === 'storage') {
        if (state.storageBytesUsed <= 0) throw new Error(`tenant ${userId} needs stored bytes to inject a storage quota incident`);
        previousQuotaLimitBytes = state.storageLimitBytes;
        state.storageLimitBytes = Math.min(state.storageLimitBytes - 1, state.storageBytesUsed - 1);
        incidentResource = 'storage';
        recovery = 'restore this tenant storage quota to its prior configured value';
      } else if (incident === 'quota-exceeded') {
        const usage = state.traffic.usage(`tenant-${userId}`);
        const bytesToOverrun = Math.max(1, state.config.trafficLimitBytes - usage.totalBytes + 1);
        const request = state.traffic.beginRequest(`tenant-${userId}`, bytesToOverrun);
        state.requestBytes += bytesToOverrun;
        request.stream?.finish(request.decision.status);
        if (request.decision.status !== 429) throw new Error(`quota incident did not exceed tenant ${userId}'s configured limit`);
        incidentResource = 'traffic';
        recovery = 'restore quota window or raise this tenant limit';
      } else if (incident === 'dns-failure') {
        state.dnsAvailable = false;
        recovery = 'restore this tenant DNS answers';
      } else if (incident === 'relay-disconnected') {
        recovery = 'reconnect this tenant relay';
      } else if (incident === 'user-machine-down') {
        state.machineOnline = false;
        recovery = 'boot this tenant machine and reconnect its relay';
      } else if (incident === 'token-expired') {
        state.clock.advancePast(state.googleOAuth.expiresAt);
        recovery = 'refresh this tenant Google token and reconnect its relay';
      } else if (incident === 'account-suspended') {
        state.accountSuspended = true;
        recovery = 'reinstate this tenant account and reconnect its relay';
      } else if (incident === 'abuse-reported-and-takedown') {
        state.abuseTakedown = true;
        recovery = 'review the report, restore this tenant listing, and reconnect its relay';
      } else if (incident === 'data-deletion-request') {
        state.dataDeletionRequested = true;
        recovery = 'cancel the pending deletion request before the deletion job runs';
      } else if (incident === 'region-outage') {
        recovery = 'restore this tenant region and reconnect its relay';
      } else if (incident === 'cost-spike') {
        previousCostMicros = state.costMicrosUsed;
        state.costMicrosUsed = state.costLimitMicros + 1;
        recovery = 'restore this tenant cost usage to its prior measured value';
      } else {
        state.googleOAuth.revoke();
        recovery = 'reauthorize this Google account and reconnect its Nexus';
      }
      const row: MultiTenantIncidentRecord = {
        incident, userId, ...(incidentResource ? { resource: incidentResource } : {}), affectedUserIds: [],
        ...(previousQuotaLimitBytes !== undefined ? { previousQuotaLimitBytes } : {}),
        ...(previousCostMicros !== undefined ? { previousCostMicros } : {}),
        isolated: false,
        recovery, recovered: false,
      };
      incidentRows.push(row);
      refreshRelayConnectivity();
      const affectedUserIds = [...users].filter(([, tenant]) => affectedBy(tenant, incident, incidentResource)).map(([id]) => id);
      const completedRow = {
        ...row, affectedUserIds,
        isolated: affectedUserIds.length === 1 && affectedUserIds[0] === userId,
      };
      incidentRows[incidentRows.length - 1] = completedRow;
      record(userId, `incident:${incident}`, 1);
      return completedRow;
    },
    recover: async (userId, incident, resource = 'traffic') => {
      const state = users.get(userId);
      if (!state) return false;
      let index = incidentRows.length - 1;
      while (index >= 0 && !(incidentRows[index]!.userId === userId
        && incidentRows[index]!.incident === incident
        && incidentRows[index]!.resource === (incident === 'quota-exceeded' ? resource : undefined)
        && !incidentRows[index]!.recovering
        && !incidentRows[index]!.recovered)) index--;
      if (index < 0) return false;
      incidentRows[index] = { ...incidentRows[index]!, recovering: true };
      let recovered = false;
      try {
        if (incident === 'certificate-expired') {
          const renewed = await state.dnsCert.issueCertificate();
          if (renewed.status !== 'issued') return false;
        } else if (incident === 'quota-exceeded') {
          if (resource === 'storage') {
            const previousLimit = incidentRows[index]!.previousQuotaLimitBytes;
            if (previousLimit === undefined) return false;
            state.storageLimitBytes = previousLimit;
          } else {
            state.traffic = createTraffic(state.config);
            state.requestBytes = 0;
          }
        } else if (incident === 'dns-failure') {
          state.dnsAvailable = true;
        } else if (incident === 'relay-disconnected' || incident === 'region-outage') {
          // Connectivity is derived from all active incidents in refreshRelayConnectivity().
        } else if (incident === 'user-machine-down') {
          state.machineOnline = true;
        } else if (incident === 'token-expired' || incident === 'token-revoked') {
          state.googleOAuth.reauthorize(state.clock.now(), state.config.tokenTtlMs ?? TOKEN_TTL_MS);
        } else if (incident === 'account-suspended') {
          state.accountSuspended = false;
          state.googleOAuth.reauthorize(state.clock.now(), state.config.tokenTtlMs ?? TOKEN_TTL_MS);
        } else if (incident === 'abuse-reported-and-takedown') {
          state.abuseTakedown = false;
        } else if (incident === 'data-deletion-request') {
          state.dataDeletionRequested = false;
        } else if (incident === 'cost-spike') {
          const previous = incidentRows[index]!.previousCostMicros;
          if (previous === undefined) return false;
          state.costMicrosUsed = previous;
        } else {
          state.googleOAuth.reauthorize(state.clock.now(), state.config.tokenTtlMs ?? TOKEN_TTL_MS);
        }
        recovered = true;
        record(userId, `recover:${incident}`, 200);
        return true;
      } finally {
        incidentRows[index] = {
          ...incidentRows[index]!, recovering: false,
          ...(recovered ? { recovered: true } : {}),
        };
        refreshRelayConnectivity();
      }
    },
    incidents: () => incidentRows.map((row) => ({ ...row })),
    receipts: () => receiptRows.map((row) => ({ ...row })),
    close: () => { for (const state of users.values()) { state.storage.close(); state.db.close(); } },
  };
}
