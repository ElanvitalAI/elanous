import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { logDiagnostic } from './diagnostic-sink.js';
import { redactSecrets } from '../../debug/secret-redaction.js';
import { getDefaultLogStore, logsDbPath, type LogStoreRow } from './log-store.js';
import { readLogInstances } from './instance-registry.js';
import { redactLogRecord } from './redaction.js';
import type { LogRecord } from './record.js';
import { acquireLockAsync, withFileLockSync } from '../../storage/file-lock.js';

type IngestTokenApi = {
  matchIngestAuthorization(request: Request): { name: string } | null;
  revokeIngestToken(name: string): boolean;
};

function ingestTokenApi(): IngestTokenApi {
  const modulePath: string = '../../nexus/api/ingest-token.js';
  return require(modulePath) as IngestTokenApi;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BATCH_LIMIT = 200;
const MAX_BATCH_BYTES = 900_000;
const POLL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

type FederationConfig = { instance: string; senderId: string; endpoint: string; tokenFile: string; afterId: number; enabled: boolean };
const federationDir = () => dirname(logsDbPath());
const configPath = () => join(federationDir(), 'federation.json');
const registryPath = () => join(federationDir(), 'federated-instances.json');
const revocationReceiptsPath = () => join(federationDir(), 'federation-revocations.json');
const configLockPath = () => `${configPath()}.lock`;

function withConfigLock<T>(action: () => T): T {
  mkdirSync(federationDir(), { recursive: true, mode: 0o700 });
  return withFileLockSync(configLockPath(), action);
}

async function withConfigLockAsync<T>(action: (stillHeld: () => boolean) => T | Promise<T>): Promise<T> {
  mkdirSync(federationDir(), { recursive: true, mode: 0o700 });
  const lock = await acquireLockAsync(configLockPath());
  try { return await action(() => lock.stillHeld()); }
  finally { lock.release(); }
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error(`${label} returned invalid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid response`);
  return value as Record<string, unknown>;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function writePrivate(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function loadConfig(): FederationConfig | null {
  const parsed = readJson(configPath()) as Partial<FederationConfig> | null;
  if (!parsed) return null;
  if (typeof parsed.instance !== 'string' || !NAME.test(parsed.instance)
    || typeof parsed.senderId !== 'string' || !parsed.senderId
    || typeof parsed.endpoint !== 'string' || typeof parsed.tokenFile !== 'string'
    || !Number.isSafeInteger(parsed.afterId) || Number(parsed.afterId) < 0
    || (parsed.enabled !== undefined && typeof parsed.enabled !== 'boolean')) {
    throw new Error('invalid log federation configuration');
  }
  return { ...(parsed as FederationConfig), enabled: parsed.enabled !== false };
}

function normalizeEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new Error('HQ endpoint must not contain credentials, query, or fragment');
  if (url.pathname !== '/') throw new Error('HQ endpoint must be the Nexus origin without a path prefix');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('HQ federation endpoint requires HTTPS (HTTP is allowed only for loopback tests)');
  return url.origin;
}

export function configureLogFederation(input: { instance: string; endpoint: string; token: string; consent: boolean }): void {
  if (!input.consent) throw new Error('explicit --consent is required to send local logs to HQ');
  if (!NAME.test(input.instance)) throw new Error('invalid federation instance name');
  withConfigLock(() => {
    if (loadConfig()) throw new Error('log federation is already configured; disconnect it before replacing credentials');
    const endpoint = normalizeEndpoint(input.endpoint);
    const token = input.token.trim();
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('invalid scoped ingest token');
    const tokenFile = join(federationDir(), `federation-${input.instance}.token`);
    if (existsSync(tokenFile)) throw new Error('a federation token file already exists; inspect or revoke it before reconnecting');
    writePrivate(tokenFile, token);
    try {
      writePrivate(configPath(), JSON.stringify({ instance: input.instance, senderId: randomUUID(), endpoint, tokenFile, afterId: 0, enabled: true } satisfies FederationConfig, null, 2) + '\n');
    } catch (error) {
      unlinkSync(tokenFile);
      throw error;
    }
  });
}

export async function disconnectLogFederation(fetcher: typeof fetch = fetch): Promise<string | null> {
  const config = await withConfigLockAsync((stillHeld) => {
    const current = loadConfig();
    if (!current) return null;
    if (current.enabled) {
      if (!stillHeld()) throw new Error('federation configuration lock was lost before pause');
      writePrivate(configPath(), JSON.stringify({ ...current, enabled: false }, null, 2) + '\n');
    }
    return current;
  });
  if (!config) return null;
  const stat = lstatSync(config.tokenFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('local federation is paused; token file must be a private regular file');
  const token = readFileSync(config.tokenFile, 'utf8').trim();
  let response: Response;
  try {
    response = await fetcher(`${config.endpoint}/v1/log-federation/revoke`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
  } catch (error) {
    throw new Error(`local federation is paused; HQ revoke is pending: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`local federation is paused; HQ revoke is pending (HTTP ${response.status})`);
  const receipt = await readJsonResponse(response, 'HQ revoke');
  if (receipt.ok !== true || receipt.revoked !== config.instance) {
    throw new Error('local federation is paused; HQ revoke response did not confirm the expected instance');
  }
  await withConfigLockAsync((stillHeld) => {
    const current = loadConfig();
    if (!current) return;
    if (current.senderId !== config.senderId || current.instance !== config.instance || current.tokenFile !== config.tokenFile || current.enabled) {
      throw new Error('local federation is paused; configuration changed before revoke cleanup');
    }
    if (!stillHeld()) throw new Error('federation configuration lock was lost before revoke cleanup');
    unlinkSync(config.tokenFile);
    unlinkSync(configPath());
  });
  return config.instance;
}

export function readLogFederationStatus(): Omit<FederationConfig, 'tokenFile'> | null {
  const config = loadConfig();
  if (!config) return null;
  return { instance: config.instance, senderId: config.senderId, endpoint: config.endpoint, afterId: config.afterId, enabled: config.enabled };
}

export function readFederatedLogInstances(): string[] {
  const parsed = readJson(registryPath()) as { instances?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.instances)) return [];
  return parsed.instances.filter((name): name is string => typeof name === 'string' && NAME.test(name));
}

export function registerFederatedLogInstance(instance: string): void {
  if (!NAME.test(instance)) throw new Error('invalid federation instance name');
  const names = new Set(readFederatedLogInstances());
  names.add(instance);
  writePrivate(registryPath(), JSON.stringify({ instances: [...names].sort() }, null, 2) + '\n');
}

function redactFederatedRecord(record: LogRecord): LogRecord {
  return scrubUserPaths(redactSecrets(redactLogRecord(record))) as LogRecord;
}

function rowToRecord(row: LogStoreRow): LogRecord {
  let data: unknown;
  if (row.data !== null) { try { data = JSON.parse(row.data); } catch { data = row.data; } }
  return {
    ts: row.ts, level: row.level as LogRecord['level'], category: row.category, event: row.event,
    ...(data !== undefined ? { data } : {}),
    ...(row.session_id ? { session_id: row.session_id } : {}),
    ...(row.trace_id ? { trace_id: row.trace_id } : {}),
    ...(row.host_id ? { host_id: row.host_id } : {}),
    source: { platform: row.surface },
  };
}

/** The local logs.db is the durable spool. The cursor advances only after HQ commits the batch. */
export function registerLogFederationWorker(opts: { fetcher?: typeof fetch; pollMs?: number; retryBaseMs?: number; store?: () => ReturnType<typeof getDefaultLogStore> } = {}): () => void {
  const fetcher = opts.fetcher ?? fetch;
  let running = false;
  let stopped = false;
  let retryAt = 0;
  let failures = 0;
  const pump = async (): Promise<void> => {
    if (running || stopped || Date.now() < retryAt) return;
    let config: FederationConfig | null;
    let store: ReturnType<typeof getDefaultLogStore>;
    try {
      config = loadConfig();
      if (!config || !config.enabled) return;
      store = (opts.store ?? getDefaultLogStore)();
      if (!store) return;
    } catch (error) {
      logDiagnostic('logs.federate', 'configuration-error', { reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    running = true;
    try {
      const rows = store.query({ instances: [store.instance], afterId: config.afterId, limit: BATCH_LIMIT });
      if (rows.length === 0) { failures = 0; return; }
      const payload: Array<{ sourceId: string; record: LogRecord }> = [];
      let latest = config.afterId;
      let skippedThrough = config.afterId;
      for (const row of rows) {
        const entry = { sourceId: `${config.senderId}:${row.id}`, record: redactFederatedRecord(rowToRecord(row)) };
        const singleBytes = new TextEncoder().encode(JSON.stringify({ instance: config.instance, records: [entry] })).byteLength;
        const candidate = JSON.stringify({ instance: config.instance, records: [...payload, entry] });
        const bytes = new TextEncoder().encode(candidate).byteLength;
        if (bytes <= MAX_BATCH_BYTES) {
          payload.push(entry);
          latest = row.id;
          continue;
        }
        if (singleBytes <= MAX_BATCH_BYTES) break;
        // A single oversized log stays in the local logs.db and is explicitly skipped for federation
        // so it cannot poison the spool and block later, smaller rows forever.
        skippedThrough = row.id;
        logDiagnostic('logs.federate', 'oversized-row-skipped', { instance: config.instance, rowId: row.id, bytes: singleBytes, maxBytes: MAX_BATCH_BYTES });
      }
      if (payload.length === 0 && skippedThrough === config.afterId) return;
      if (payload.length === 0) latest = skippedThrough;
      const tokenStat = lstatSync(config.tokenFile);
      if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0) throw new Error('federation token file must be a private regular file');
      const token = readFileSync(config.tokenFile, 'utf8').trim();
      if (payload.length > 0) {
        const response = await fetcher(`${config.endpoint}/v1/log-federation/batch`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ instance: config.instance, records: payload }), signal: AbortSignal.timeout(10_000), redirect: 'error',
        });
        if (!response.ok) throw new Error(`HQ returned ${response.status}`);
        const receipt = await readJsonResponse(response, 'HQ batch');
        if (receipt.ok !== true || receipt.instance !== config.instance || receipt.accepted !== payload.length) {
          throw new Error('HQ batch response did not confirm the expected instance and accepted count');
        }
      }
      await withConfigLockAsync((stillHeld) => {
        const current = loadConfig();
        if (!current || !current.enabled || current.senderId !== config.senderId) return;
        if (!stillHeld()) throw new Error('federation configuration lock was lost before cursor update');
        const through = Math.max(latest, skippedThrough);
        writePrivate(configPath(), JSON.stringify({ ...current, afterId: Math.max(current.afterId, through) }, null, 2) + '\n');
      });
      failures = 0;
      logDiagnostic('logs.federate', 'batch-sent', { instance: config.instance, count: payload.length, afterId: latest, skippedThrough });
    } catch (error) {
      failures += 1;
      retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, (opts.retryBaseMs ?? POLL_MS) * (2 ** Math.min(failures, 4)));
      logDiagnostic('logs.federate', 'batch-retry', { reason: error instanceof Error ? error.message : String(error), retryMs: retryAt - Date.now() });
    } finally { running = false; }
  };
  const timer = setInterval(() => { void pump(); }, opts.pollMs ?? POLL_MS);
  timer.unref?.();
  void pump();
  return () => { stopped = true; clearInterval(timer); };
}

export async function handleLogFederationBatch(req: Request, deps: {
  authorize?: (request: Request) => string | null;
  store?: () => ReturnType<typeof getDefaultLogStore>;
} = {}): Promise<Response> {
  const instance = (deps.authorize ?? ((request) => ingestTokenApi().matchIngestAuthorization(request)?.name ?? null))(req);
  if (!instance) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'content-type': 'application/json' } });
  let body: unknown;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 1_000_000) return new Response(JSON.stringify({ error: 'batch too large' }), { status: 413, headers: { 'content-type': 'application/json' } });
    body = JSON.parse(raw);
  } catch { return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400 }); }
  const input = body as { instance?: unknown; records?: unknown } | null;
  if (!input || input.instance !== instance || !Array.isArray(input.records) || input.records.length > BATCH_LIMIT) {
    return new Response(JSON.stringify({ error: 'invalid federation batch' }), { status: 400 });
  }
  const store = (deps.store ?? getDefaultLogStore)();
  if (!store) return new Response(JSON.stringify({ error: 'log store unavailable' }), { status: 503 });
  if (instance === store.instance || (readLogInstances().some((view) => view.name === instance) && !readFederatedLogInstances().includes(instance))) {
    return new Response(JSON.stringify({ error: 'instance name conflicts with a local log instance' }), { status: 409, headers: { 'content-type': 'application/json' } });
  }
  const rows: Array<{ rec: LogRecord; surface: string; instance: string; federatedId: string; hostId?: string }> = [];
  for (const item of input.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return new Response(JSON.stringify({ error: 'invalid federation record' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const candidate = item as { sourceId?: unknown; record?: unknown };
    const record = candidate.record as LogRecord | null;
    if (typeof candidate.sourceId !== 'string' || candidate.sourceId.length === 0 || candidate.sourceId.length > 160 || !record || typeof record !== 'object'
      || typeof record.ts !== 'string' || typeof record.category !== 'string' || typeof record.event !== 'string') {
      return new Response(JSON.stringify({ error: 'invalid federation record' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const redacted = redactFederatedRecord(record);
    const hostId = typeof (record as LogRecord & { host_id?: unknown }).host_id === 'string' ? (record as LogRecord & { host_id: string }).host_id : undefined;
    rows.push({ rec: redacted, surface: typeof record.source?.platform === 'string' ? record.source.platform : 'remote', instance, federatedId: candidate.sourceId, ...(hostId ? { hostId } : {}) });
  }
  try {
    store.insertBatch(rows, { preserveRows: true });
    registerFederatedLogInstance(instance);
    return new Response(JSON.stringify({ ok: true, instance, accepted: rows.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ error: 'federation store failed' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
}

function scrubUserPaths(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/(\/Users\/)[^/\s]+/g, '$1<redacted>')
    .replace(/(\/home\/)[^/\s]+/g, '$1<redacted>')
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/g, '$1<redacted>');
  if (Array.isArray(value)) return value.map(scrubUserPaths);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubUserPaths(item)]));
  return value;
}

function readRevocationReceipts(): Record<string, string> {
  const parsed = readJson(revocationReceiptsPath()) as { receipts?: unknown } | null;
  if (!parsed || !parsed.receipts || typeof parsed.receipts !== 'object' || Array.isArray(parsed.receipts)) return {};
  return Object.fromEntries(Object.entries(parsed.receipts).filter(([hash, name]) => /^[a-f0-9]{64}$/.test(hash) && typeof name === 'string' && NAME.test(name))) as Record<string, string>;
}

export async function handleLogFederationRevoke(req: Request, deps: { authorize?: (request: Request) => string | null } = {}): Promise<Response> {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'content-type': 'application/json' } });
  const authorization = req.headers.get('authorization') ?? '';
  const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)?.[1];
  if (!bearer) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const tokenHash = createHash('sha256').update(bearer).digest('hex');
  const instance = (deps.authorize ?? ((request) => ingestTokenApi().matchIngestAuthorization(request)?.name ?? null))(req);
  if (instance) {
    const receipts = readRevocationReceipts();
    receipts[tokenHash] = instance;
    writePrivate(revocationReceiptsPath(), JSON.stringify({ receipts }, null, 2) + '\n');
    ingestTokenApi().revokeIngestToken(instance);
    return new Response(JSON.stringify({ ok: true, revoked: instance }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const revokedInstance = readRevocationReceipts()[tokenHash];
  if (revokedInstance) return new Response(JSON.stringify({ ok: true, revoked: revokedInstance, alreadyRevoked: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
}
