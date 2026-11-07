import { createHmac, timingSafeEqual } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AppManifest, AppStorageDeclaration } from './app-contract.js';
import { appObjectKey, createObjectStore, resolveStorageConfig, type ObjectStore, type RunFn, type StorageConfig } from '../../storage/object-store.js';

const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_ANONYMOUS_UPLOADS_PER_MINUTE = 10;
const MAX_SIGNED_URL_TTL_MS = 15 * 60_000;
const MAX_OBSERVATIONS = 1_000;
const MINUTE_MS = 60_000;
const SIGNED_URL_ORIGIN = 'https://storage.invalid';
const DEFAULT_CONTENT_TYPES = ['application/json', 'audio/mpeg', 'audio/wav', 'audio/webm', 'image/jpeg', 'image/png'];

type AppStorageResponse = {
  readonly status: 200 | 201 | 400 | 403 | 404 | 413 | 415 | 429 | 500 | 503;
  readonly body?: Uint8Array;
  readonly bytes?: number;
  readonly retryable?: boolean;
  readonly reason?: string;
  readonly contentType?: string;
  readonly filename?: string;
};

export interface AppStorageOptions {
  readonly store?: ObjectStore;
  readonly config?: StorageConfig;
  readonly run?: RunFn;
  readonly now?: () => number;
  readonly signingKey: string;
  readonly signedUrlOrigin?: string;
  readonly defaultQuotaBytes?: number;
  readonly defaultMaxUploadBytes?: number;
  readonly anonymousUploadsPerMinute?: number;
  /** Shared SQLite path on a POSIX-locking filesystem used by every writer; required for remote providers. */
  readonly quotaLedgerPath?: string;
}

export interface AppStorage {
  upload(input: { readonly appSlug: string; readonly key: string; readonly body: Uint8Array; readonly contentType: string; readonly role?: string; readonly anonymous?: boolean }): AppStorageResponse;
  authorizeSignedUpload(input: { readonly url: string; readonly method: string; readonly appSlug: string }): { readonly status: 200; readonly appSlug: string; readonly anonymous: boolean } | { readonly status: 403 | 429 | 503; readonly reason: string };
  uploadSigned(input: { readonly url: string; readonly method: string; readonly body: Uint8Array; readonly contentType: string; readonly rateLimitReserved?: boolean }): AppStorageResponse;
  maxUploadBytes(appSlug: string): number | undefined;
  read(input: { readonly appSlug: string; readonly key: string }): AppStorageResponse;
  list(appSlug: string): { readonly status: 200; readonly files: string[] } | { readonly status: 404 | 503; readonly reason: string; readonly retryable: boolean };
  signUploadUrl(input: { readonly appSlug: string; readonly key: string; readonly expiresInMs: number; readonly role?: string; readonly anonymous?: boolean; readonly origin?: string }): string;
  observationLedger(): readonly { readonly appSlug: string; readonly bytes: number; readonly status: number }[];
  close(): void;
}

interface AppDefinition {
  readonly slug: string;
  readonly storage: AppStorageDeclaration;
  readonly roles: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
}

type StoredObjectMetadata = { object_key: string; content_type: string | null; filename: string | null };

interface SignedClaims {
  readonly v: 1;
  readonly appSlug: string;
  readonly key: string;
  readonly role?: string;
  readonly anonymous?: boolean;
  readonly method: 'PUT';
  readonly expiresAt: number;
  readonly origin: string;
}

function canonicalContentType(value: string): string { return value.split(';', 1)[0]!.trim().toLowerCase(); }

function safeSlug(slug: string): boolean { return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug); }

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function tokenFor(claims: SignedClaims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

function readSignedClaims(token: string, key: string, now: number): SignedClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = Buffer.from(sign(parts[0], key));
  const supplied = Buffer.from(parts[1]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Partial<SignedClaims>;
    if (value.v !== 1 || typeof value.appSlug !== 'string' || !safeSlug(value.appSlug)
      || typeof value.key !== 'string' || (value.anonymous === true ? value.role !== undefined : (typeof value.role !== 'string' || value.role.length === 0))
      || value.method !== 'PUT' || typeof value.origin !== 'string' || typeof value.expiresAt !== 'number'
      || !Number.isSafeInteger(value.expiresAt) || now >= value.expiresAt) return null;
    return value as SignedClaims;
  } catch { return null; }
}

function makeUrl(claims: SignedClaims, key: string): string {
  const encodedKey = claims.key.split('/').map(encodeURIComponent).join('/');
  return `${claims.origin}/_app-storage/${encodeURIComponent(claims.appSlug)}/${encodedKey}?token=${encodeURIComponent(tokenFor(claims, key))}`;
}

function parseUrlPath(url: URL, origin: string): { appSlug: string; key: string } | null {
  if (url.origin !== origin) return null;
  try {
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (parts.length < 3 || parts[0] !== '_app-storage') return null;
    return { appSlug: parts[1]!, key: parts.slice(2).join('/') };
  } catch { return null; }
}

function providerFailure(error: unknown): { status: 403 | 404 | 500 | 503; retryable: boolean } {
  const text = String(error);
  if (/\b403\b|forbidden|accessdenied/i.test(text)) return { status: 403, retryable: false };
  if (/\b404\b|not.?found|nosuchkey|객체가 없다/i.test(text)) return { status: 404, retryable: false };
  const transient = /\b(500|502|503|504)\b|5xx|timeout|tempor|unavailable/i.test(text);
  return { status: transient ? 503 : 500, retryable: transient };
}

/** App-scoped object storage over the canonical ObjectStore key and provider interface. */
export function createAppStorage(manifests: readonly AppManifest[], options: AppStorageOptions): AppStorage {
  const config = options.config ?? resolveStorageConfig();
  const configuredQuotaLedgerPath = options.quotaLedgerPath ?? config.quotaLedgerPath;
  if (config.provider !== 'local' && !configuredQuotaLedgerPath) {
    throw new Error('remote object storage requires a shared quotaLedgerPath for every writer');
  }
  if (!options.signingKey) throw new Error('app storage requires a stable signingKey');
  let providerError: unknown;
  const run: RunFn | undefined = options.run ? ((bin, args, runOptions) => {
    try { return options.run!(bin, args, runOptions); }
    catch (error) { providerError = error; throw error; }
  }) : undefined;
  const store = options.store ?? createObjectStore(config, { ...(run ? { run } : {}) });
  const quotaLedgerPath = configuredQuotaLedgerPath ?? join(config.localDir, '.app-storage-quota.sqlite');
  mkdirSync(dirname(quotaLedgerPath), { recursive: true, mode: 0o700 });
  const quotaDb = new Database(quotaLedgerPath);
  quotaDb.exec('PRAGMA busy_timeout = 5000');
  // Rollback-journal locking works across processes on a shared POSIX-locking filesystem;
  // WAL's shared-memory index is local-host only and cannot coordinate remote writers.
  quotaDb.exec('PRAGMA journal_mode = DELETE');
  quotaDb.exec(`CREATE TABLE IF NOT EXISTS app_storage_usage (
    app_slug TEXT NOT NULL,
    object_key TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    PRIMARY KEY (app_slug, object_key)
  )`);
  const usageColumns = new Set((quotaDb.query('PRAGMA table_info(app_storage_usage)').all() as Array<{ name: string }>).map(column => column.name));
  if (!usageColumns.has('content_type')) quotaDb.exec('ALTER TABLE app_storage_usage ADD COLUMN content_type TEXT');
  if (!usageColumns.has('filename')) quotaDb.exec('ALTER TABLE app_storage_usage ADD COLUMN filename TEXT');
  quotaDb.exec(`CREATE TABLE IF NOT EXISTS app_storage_anonymous_attempts (
    app_slug TEXT NOT NULL,
    attempted_at INTEGER NOT NULL
  )`);
  quotaDb.exec('CREATE INDEX IF NOT EXISTS app_storage_anonymous_attempts_by_app_time ON app_storage_anonymous_attempts(app_slug, attempted_at)');
  const origin = options.signedUrlOrigin ?? SIGNED_URL_ORIGIN;
  let parsedOrigin: URL;
  try { parsedOrigin = new URL(origin); }
  catch { throw new Error('signedUrlOrigin must be a valid absolute URL'); }
  if (parsedOrigin.protocol !== 'https:' && parsedOrigin.protocol !== 'http:') throw new Error('signedUrlOrigin must use http or https');
  const signedOrigin = parsedOrigin.origin;
  const signingKey = options.signingKey;
  if (Buffer.byteLength(signingKey) < 32) throw new Error('signingKey must contain at least 32 bytes');
  const defaultQuota = options.defaultQuotaBytes ?? DEFAULT_QUOTA_BYTES;
  const defaultMaxUpload = options.defaultMaxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const anonymousLimit = options.anonymousUploadsPerMinute ?? DEFAULT_ANONYMOUS_UPLOADS_PER_MINUTE;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(defaultQuota) || defaultQuota <= 0) throw new Error('defaultQuotaBytes must be a positive safe integer');
  if (!Number.isSafeInteger(defaultMaxUpload) || defaultMaxUpload <= 0) throw new Error('defaultMaxUploadBytes must be a positive safe integer');
  if (!Number.isSafeInteger(anonymousLimit) || anonymousLimit < 0) throw new Error('anonymousUploadsPerMinute must be a nonnegative safe integer');

  const apps = new Map<string, AppDefinition>();
  for (const manifest of manifests) {
    if (!safeSlug(manifest.slug) || apps.has(manifest.slug)) throw new Error(`invalid or duplicate app slug: ${manifest.slug}`);
    const rawStorage = manifest.storage as AppStorageDeclaration | undefined;
    if (!rawStorage) continue;
    if (rawStorage.prefix !== `apps/${manifest.slug}/`) throw new Error(`invalid app storage prefix: ${manifest.slug}`);
    if (rawStorage.quotaBytes !== undefined && (!Number.isSafeInteger(rawStorage.quotaBytes) || rawStorage.quotaBytes <= 0)) {
      throw new Error(`invalid app storage quota: ${manifest.slug}`);
    }
    const upload = rawStorage.upload;
    const roles = new Set(upload?.allow ?? []);
    const types = new Set((upload?.types ?? DEFAULT_CONTENT_TYPES).map(canonicalContentType));
    if (upload && (roles.size === 0 || types.size === 0)) throw new Error(`invalid app storage upload policy: ${manifest.slug}`);
    if (upload?.maxBytes !== undefined && (!Number.isSafeInteger(upload.maxBytes) || upload.maxBytes <= 0)) {
      throw new Error(`invalid app upload size limit: ${manifest.slug}`);
    }
    apps.set(manifest.slug, { slug: manifest.slug, storage: rawStorage, roles, types });
  }

  const observations: Array<{ appSlug: string; bytes: number; status: number }> = [];
  let closed = false;

  function record(appSlug: string, bytes: number, response: AppStorageResponse): AppStorageResponse {
    if (observations.length >= MAX_OBSERVATIONS) observations.shift();
    observations.push({ appSlug: safeSlug(appSlug) ? appSlug : 'invalid-app', bytes, status: response.status });
    return response;
  }

  function reject(appSlug: string, status: AppStorageResponse['status'], reason: string, retryable = false): AppStorageResponse {
    return record(appSlug, 0, { status, reason, ...(retryable ? { retryable: true } : {}) });
  }

  function headObject(key: string): { exists: boolean; bytes?: number } {
    providerError = undefined;
    const head = store.head(key);
    if (providerError) {
      const failure = providerFailure(providerError);
      if (failure.status !== 404) throw providerError;
      providerError = undefined;
      return { exists: false };
    }
    return head;
  }

  function reserveAndPut(appSlug: string, targetKey: string, body: Uint8Array, contentType: string, quota: number): boolean {
    const prefix = `apps/${appSlug}/`;
    quotaDb.exec('BEGIN IMMEDIATE');
    try {
      // Reconcile while holding a SQLite write lock. Processes sharing this ledger serialize
      // the read/check/put/update sequence, and a prior crash after put is recovered by listing.
      providerError = undefined;
      const keys = store.list(prefix).filter(key => key.startsWith(prefix));
      const sizes = new Map<string, number>();
      for (const key of keys) {
        const head = headObject(key);
        if (head.exists) {
          if (head.bytes === undefined || !Number.isSafeInteger(head.bytes) || head.bytes < 0) throw new Error('stored object size unavailable');
          sizes.set(key, head.bytes);
        }
      }
      if (!sizes.has(targetKey)) {
        const existing = headObject(targetKey);
        if (existing.exists) {
          if (existing.bytes === undefined || !Number.isSafeInteger(existing.bytes) || existing.bytes < 0) throw new Error('stored object size unavailable');
          sizes.set(targetKey, existing.bytes);
        }
      }
      const previousMetadata = quotaDb.query('SELECT object_key, content_type, filename FROM app_storage_usage WHERE app_slug = ?').all(appSlug) as StoredObjectMetadata[];
      const metadata = new Map(previousMetadata.map(row => [row.object_key, row]));
      quotaDb.query('DELETE FROM app_storage_usage WHERE app_slug = ?').run(appSlug);
      const insert = quotaDb.query('INSERT INTO app_storage_usage(app_slug, object_key, bytes, content_type, filename) VALUES (?, ?, ?, ?, ?)');
      for (const [key, bytes] of sizes) {
        const prior = metadata.get(key);
        insert.run(appSlug, key, bytes, prior?.content_type ?? null, prior?.filename ?? null);
      }
      const usage = quotaDb.query('SELECT COALESCE(SUM(bytes), 0) AS total FROM app_storage_usage WHERE app_slug = ?').get(appSlug) as { total: number };
      if (!Number.isSafeInteger(usage.total) || usage.total < 0) throw new Error('stored object size unavailable');
      const prior = sizes.get(targetKey) ?? 0;
      if (Number(usage.total) - prior + body.byteLength > quota) { quotaDb.exec('ROLLBACK'); return false; }
      store.put(targetKey, body, { contentType });
      quotaDb.query('INSERT INTO app_storage_usage(app_slug, object_key, bytes, content_type, filename) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_slug, object_key) DO UPDATE SET bytes = excluded.bytes, content_type = excluded.content_type, filename = excluded.filename')
        .run(appSlug, targetKey, body.byteLength, contentType, basename(targetKey));
      quotaDb.exec('COMMIT');
      return true;
    } catch (error) {
      try { quotaDb.exec('ROLLBACK'); } catch { /* preserve the provider or database failure */ }
      throw error;
    }
  }

  function allowAnonymousAttempt(appSlug: string): boolean {
    if (anonymousLimit === 0) return false;
    const attemptedAt = now();
    quotaDb.exec('BEGIN IMMEDIATE');
    try {
      quotaDb.query('DELETE FROM app_storage_anonymous_attempts WHERE app_slug = ? AND attempted_at <= ?')
        .run(appSlug, attemptedAt - MINUTE_MS);
      const row = quotaDb.query('SELECT COUNT(*) AS count FROM app_storage_anonymous_attempts WHERE app_slug = ?').get(appSlug) as { count: number };
      if (Number(row.count) >= anonymousLimit) { quotaDb.exec('ROLLBACK'); return false; }
      quotaDb.query('INSERT INTO app_storage_anonymous_attempts(app_slug, attempted_at) VALUES (?, ?)').run(appSlug, attemptedAt);
      quotaDb.exec('COMMIT');
      return true;
    } catch (error) {
      try { quotaDb.exec('ROLLBACK'); } catch { /* preserve the database failure */ }
      throw error;
    }
  }

  function upload(input: { appSlug: string; key: string; body: Uint8Array; contentType: string; role?: string; anonymous?: boolean; rateLimitReserved?: boolean }): AppStorageResponse {
    if (closed) return reject(input.appSlug, 500, 'storage is closed');
    const app = apps.get(input.appSlug);
    if (!app) return reject(input.appSlug, 404, 'app storage is not configured');
    let fullKey: string;
    try { fullKey = appObjectKey(input.appSlug, input.key); }
    catch { return reject(input.appSlug, 400, 'invalid app slug or app-relative object key'); }
    const uploadPolicy = app.storage.upload;
    if (!uploadPolicy) return reject(input.appSlug, 403, 'app upload is not declared');
    if (input.anonymous ? uploadPolicy.anonymous !== true : (!input.role || !app.roles.has(input.role))) {
      return reject(input.appSlug, 403, 'app role is not allowed to upload');
    }
    const contentType = canonicalContentType(input.contentType);
    if (!app.types.has(contentType)) return reject(input.appSlug, 415, 'content type is not allowed');
    if (!(input.body instanceof Uint8Array)) return reject(input.appSlug, 400, 'body must be bytes');
    const quota = app.storage.quotaBytes ?? defaultQuota;
    const maxUpload = uploadPolicy.maxBytes ?? defaultMaxUpload;
    if (input.body.byteLength > maxUpload) return reject(input.appSlug, 413, 'upload size limit exceeded');
    if (input.anonymous && !input.rateLimitReserved) {
      try {
        if (!allowAnonymousAttempt(input.appSlug)) return reject(input.appSlug, 429, 'anonymous upload rate limit exceeded');
      } catch { return reject(input.appSlug, 503, 'anonymous upload rate limit unavailable', true); }
    }
    try {
      if (!reserveAndPut(input.appSlug, fullKey, input.body, contentType, quota)) return reject(input.appSlug, 413, 'app storage quota exceeded');
      return record(input.appSlug, input.body.byteLength, { status: 201, bytes: input.body.byteLength });
    } catch (error) {
      const failure = store.provider === 'local' ? { status: 500 as const, retryable: false } : providerFailure(error);
      return reject(input.appSlug, failure.status, store.provider === 'local' ? 'local storage write failed' : 'storage provider rejected upload', failure.retryable);
    }
  }

  return {
    upload,
    authorizeSignedUpload(input) {
      let parsed: URL;
      try { parsed = new URL(input.url); } catch { return { status: 403, reason: 'invalid signed URL' }; }
      const claims = readSignedClaims(parsed.searchParams.get('token') ?? '', signingKey, now());
      const path = claims ? parseUrlPath(parsed, claims.origin) : null;
      if (!path || !claims || path.appSlug !== claims.appSlug || path.key !== claims.key || input.method !== claims.method || claims.appSlug !== input.appSlug) {
        return { status: 403, reason: 'signed URL is invalid, expired, or method-mismatched' };
      }
      if (!claims.anonymous) return { status: 200, appSlug: claims.appSlug, anonymous: false };
      try {
        return allowAnonymousAttempt(claims.appSlug)
          ? { status: 200, appSlug: claims.appSlug, anonymous: true }
          : { status: 429, reason: 'anonymous upload rate limit exceeded' };
      } catch { return { status: 503, reason: 'anonymous upload rate limit unavailable' }; }
    },
    uploadSigned(input) {
      let parsed: URL;
      try { parsed = new URL(input.url); }
      catch { return reject('invalid-app', 403, 'invalid signed URL'); }
      const token = parsed.searchParams.get('token') ?? '';
      const claims = readSignedClaims(token, signingKey, now());
      const path = claims ? parseUrlPath(parsed, claims.origin) : null;
      if (!path || !claims || path.appSlug !== claims.appSlug || path.key !== claims.key || input.method !== claims.method) {
        return reject('invalid-app', 403, 'signed URL is invalid, expired, or method-mismatched');
      }
      return upload({ appSlug: claims.appSlug, key: claims.key, body: input.body, contentType: input.contentType, ...(claims.role ? { role: claims.role } : {}), anonymous: claims.anonymous, rateLimitReserved: input.rateLimitReserved });
    },
    maxUploadBytes(appSlug) {
      const app = apps.get(appSlug);
      return app?.storage.upload?.maxBytes ?? (app ? defaultMaxUpload : undefined);
    },
    read(input) {
      if (closed) return reject(input.appSlug, 500, 'storage is closed');
      if (!apps.has(input.appSlug)) return reject(input.appSlug, 404, 'app storage is not configured');
      let fullKey: string;
      try { fullKey = appObjectKey(input.appSlug, input.key); }
      catch { return reject(input.appSlug, 400, 'invalid app slug or app-relative object key'); }
      const tempDir = mkdtempSync(join(tmpdir(), 'app-storage-read-'));
      try {
        const destination = join(tempDir, 'object.bin');
        store.get(fullKey, destination);
        const body = readFileSync(destination);
        const metadata = quotaDb.query('SELECT content_type, filename FROM app_storage_usage WHERE app_slug = ? AND object_key = ?').get(input.appSlug, fullKey) as Pick<StoredObjectMetadata, 'content_type' | 'filename'> | null;
        return record(input.appSlug, 0, {
          status: 200, body, bytes: body.byteLength,
          contentType: metadata?.content_type ?? 'application/octet-stream',
          filename: metadata?.filename ?? basename(input.key),
        });
      } catch (error) {
        const failure = store.provider === 'local' && /객체가 없다/.test(String(error))
          ? { status: 404 as const, retryable: false }
          : providerFailure(error);
        return reject(input.appSlug, failure.status, failure.status === 404 ? 'object not found' : 'storage provider read failed', failure.retryable);
      } finally { rmSync(tempDir, { recursive: true, force: true }); }
    },
    list(appSlug) {
      if (closed) return { status: 503, reason: 'storage is closed', retryable: false };
      if (!apps.has(appSlug)) return { status: 404, reason: 'app storage is not configured', retryable: false };
      const prefix = `apps/${appSlug}/`;
      try {
        providerError = undefined;
        return { status: 200, files: store.list(prefix).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).sort() };
      } catch (error) {
        const failure = providerFailure(error);
        return { status: 503, reason: 'storage provider list failed', retryable: failure.retryable };
      }
    },
    signUploadUrl(input) {
      const app = apps.get(input.appSlug);
      const anonymous = input.anonymous === true;
      if (!app || !app.storage.upload || (anonymous ? app.storage.upload.anonymous !== true : (!input.role || !app.roles.has(input.role)))) throw new Error('app role is not allowed to upload');
      try { appObjectKey(input.appSlug, input.key); }
      catch { throw new Error('invalid app slug or app-relative object key'); }
      if (!Number.isSafeInteger(input.expiresInMs) || input.expiresInMs <= 0 || input.expiresInMs > MAX_SIGNED_URL_TTL_MS) {
        throw new Error(`expiresInMs must be between 1 and ${MAX_SIGNED_URL_TTL_MS}`);
      }
      let origin = signedOrigin;
      if (input.origin !== undefined) {
        let parsed: URL;
        try { parsed = new URL(input.origin); }
        catch { throw new Error('origin must be a valid absolute URL'); }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('origin must use http or https');
        origin = parsed.origin;
      }
      return makeUrl({ v: 1, appSlug: input.appSlug, key: input.key, ...(input.role ? { role: input.role } : {}), ...(anonymous ? { anonymous: true } : {}), method: 'PUT', expiresAt: now() + input.expiresInMs, origin }, signingKey);
    },
    observationLedger() { return observations.map(entry => ({ ...entry })); },
    close() { if (!closed) { closed = true; quotaDb.close(); } },
  };
}
