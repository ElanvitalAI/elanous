import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import type { ModelSpec, ProviderRegistration } from './types.js';

export const CATALOG_SERVER_URL = 'https://storage.googleapis.com/elanous-catalog/v1/catalog.json';
export const CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_STARTUP_TIMEOUT_MS = 2_000;

export interface SignedCatalogPayload {
  catalogVersion: number;
  generatedAt: string;
  providers: ProviderRegistration[];
  models: ModelSpec[];
}

export interface SignedCatalogDocument extends SignedCatalogPayload {
  signature: string;
}

export interface VerifiedCatalog {
  payload: SignedCatalogPayload;
  stale: boolean;
}

function catalogVersionFromFile(path: string): number | undefined {
  try {
    const match = readFileSync(path, 'utf8').match(/^catalogVersion:\s*(\d+)\s*$/m);
    const version = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(version) && version >= 1 ? version : undefined;
  } catch { return undefined; }
}

function bundledCatalogVersion(): number | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'catalog', 'meta', 'catalogVersion.yaml');
    if (existsSync(candidate)) return catalogVersionFromFile(candidate);
    current = dirname(current);
  }
  return undefined;
}

export function catalogCachePath(): string {
  const override = process.env.ELANOUS_CATALOG_SERVER_CACHE?.trim();
  if (override) return override;
  return join(getElanousConfigDir(), 'catalog', 'cache.json');
}

function bundledPublicKeyPath(): string {
  const override = process.env.ELANOUS_CATALOG_PUBLIC_KEY_FILE?.trim();
  if (override) return override;
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'catalog', 'signing', 'catalog-signing-public.pem');
    if (existsSync(candidate)) return candidate;
    current = dirname(current);
  }
  return join(dirname(fileURLToPath(import.meta.url)), '../../catalog/signing/catalog-signing-public.pem');
}

export function canonicalCatalogPayload(payload: SignedCatalogPayload): string {
  return JSON.stringify({
    catalogVersion: payload.catalogVersion,
    generatedAt: payload.generatedAt,
    providers: payload.providers,
    models: payload.models,
  });
}

export function signCatalogPayload(payload: SignedCatalogPayload, privateKey: string | Buffer | KeyObject): SignedCatalogDocument {
  return { ...payload, signature: sign(null, Buffer.from(canonicalCatalogPayload(payload)), privateKey).toString('base64') };
}

function parsePayload(value: unknown): SignedCatalogPayload | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.catalogVersion) || (raw.catalogVersion as number) < 1) return null;
  if (typeof raw.generatedAt !== 'string' || !Number.isFinite(Date.parse(raw.generatedAt))) return null;
  if (!Array.isArray(raw.providers) || !Array.isArray(raw.models)) return null;
  if (!raw.providers.every((p) => p && typeof p === 'object' && typeof (p as Record<string, unknown>).id === 'string')) return null;
  if (!raw.models.every((m) => m && typeof m === 'object'
    && typeof (m as Record<string, unknown>).id === 'string'
    && typeof (m as Record<string, unknown>).provider === 'string')) return null;
  return {
    catalogVersion: raw.catalogVersion as number,
    generatedAt: raw.generatedAt,
    providers: raw.providers as ProviderRegistration[],
    models: raw.models as ModelSpec[],
  };
}

export function verifyCatalogDocument(
  value: unknown,
  publicKeyPem: string,
): SignedCatalogPayload | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.signature !== 'string') return null;
  const payload = parsePayload(raw);
  if (!payload) return null;
  try {
    const signature = Buffer.from(raw.signature, 'base64');
    return verify(null, Buffer.from(canonicalCatalogPayload(payload)), createPublicKey(publicKeyPem), signature)
      ? payload
      : null;
  } catch {
    return null;
  }
}

export function readVerifiedCatalogCache(opts: {
  cachePath?: string;
  publicKeyPem?: string;
  now?: number;
} = {}): VerifiedCatalog | null {
  const path = opts.cachePath ?? catalogCachePath();
  try {
    const key = opts.publicKeyPem ?? readFileSync(bundledPublicKeyPath(), 'utf8');
    const payload = verifyCatalogDocument(JSON.parse(readFileSync(path, 'utf8')), key);
    if (!payload) return null;
    const age = Math.max(0, (opts.now ?? Date.now()) - Date.parse(payload.generatedAt));
    const stale = age > CATALOG_REFRESH_INTERVAL_MS;
    debug.log('registry.catalog', 'catalog.source', { source: 'server-cache', stale, catalogVersion: payload.catalogVersion });
    if (stale) debug.log('registry.catalog', 'catalog.stale', { source: 'server-cache', stale: true, ageMs: age, catalogVersion: payload.catalogVersion }, { level: 'warn' });
    return { payload, stale };
  } catch {
    return null;
  }
}

export type RefreshCatalogResult =
  | { ok: true; payload: SignedCatalogPayload }
  | { ok: false; reason: 'key-unavailable' | 'fetch-failed' | 'http-error' | 'invalid-json' | 'signature-rejected' | 'version-rejected' | 'cache-write-failed' };

export async function refreshServerCatalog(opts: {
  fetchImpl?: typeof fetch;
  url?: string;
  cachePath?: string;
  publicKeyPem?: string;
  timeoutMs?: number;
} = {}): Promise<RefreshCatalogResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cachePath = opts.cachePath ?? catalogCachePath();
  const timeoutMs = opts.timeoutMs ?? CATALOG_STARTUP_TIMEOUT_MS;
  let key: string;
  try {
    key = opts.publicKeyPem ?? readFileSync(bundledPublicKeyPath(), 'utf8');
  } catch (error) {
    debug.log('registry.catalog', 'catalog.refresh-failed', { source: 'server', reason: 'key-unavailable', message: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return { ok: false, reason: 'key-unavailable' };
  }
  const previous = readVerifiedCatalogCache({ cachePath, publicKeyPem: key });
  let response: Response;
  try {
    response = await fetchImpl(opts.url ?? CATALOG_SERVER_URL, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    debug.log('registry.catalog', 'catalog.refresh-failed', { source: 'server', reason: 'fetch-failed', message: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return { ok: false, reason: 'fetch-failed' };
  }
  if (!response.ok) return { ok: false, reason: 'http-error' };
  let document: unknown;
  try { document = await response.json(); }
  catch { return { ok: false, reason: 'invalid-json' }; }
  const payload = verifyCatalogDocument(document, key);
  if (!payload) {
    debug.log('registry.catalog', 'catalog.signature-rejected', { source: 'server', reason: 'invalid-signature-or-schema' }, { level: 'warn' });
    return { ok: false, reason: 'signature-rejected' };
  }
  // A cold install has no signed server receipt yet, so the packaged catalog is its rollback floor.
  const versionFloor = Math.max(previous?.payload.catalogVersion ?? 0,
    bundledCatalogVersion() ?? 0);
  if (payload.catalogVersion < versionFloor) {
    debug.log('registry.catalog', 'catalog.version-rejected', {
      source: 'server', reason: 'version-rollback', currentVersion: versionFloor, receivedVersion: payload.catalogVersion,
    }, { level: 'warn' });
    return { ok: false, reason: 'version-rejected' };
  }
  const signedDocument = document as SignedCatalogDocument;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(signedDocument, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, cachePath);
  } catch (error) {
    debug.log('registry.catalog', 'catalog.refresh-failed', { source: 'server', reason: 'cache-write-failed', message: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return { ok: false, reason: 'cache-write-failed' };
  }
  const ageMs = Math.max(0, Date.now() - Date.parse(payload.generatedAt));
  debug.log('registry.catalog', 'catalog.source', {
    source: 'server', stale: ageMs > CATALOG_REFRESH_INTERVAL_MS, catalogVersion: payload.catalogVersion,
  });
  return { ok: true, payload };
}

let scheduledRefresh: Promise<void> | null = null;
let lastRefreshAttempt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Kick remote refresh behind startup; the callback rebuilds the catalog only after a verified cache write. */
export function scheduleServerCatalogRefresh(onUpdated: () => void): void {
  if (process.env.NODE_ENV === 'test') return;
  if (scheduledRefresh || refreshTimer) return;
  const now = Date.now();
  const cached = readVerifiedCatalogCache();
  const cacheAgeMs = cached ? Math.max(0, now - Date.parse(cached.payload.generatedAt)) : Number.POSITIVE_INFINITY;
  const untilCacheStale = cached && !cached.stale ? Math.max(1_000, CATALOG_REFRESH_INTERVAL_MS - cacheAgeMs) : 0;
  const untilRetry = Math.max(0, CATALOG_REFRESH_INTERVAL_MS - (now - lastRefreshAttempt));
  const delay = Math.max(untilCacheStale, untilRetry);
  if (delay > 0) {
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      scheduleServerCatalogRefresh(onUpdated);
    }, delay);
    refreshTimer.unref?.();
    return;
  }
  lastRefreshAttempt = now;
  scheduledRefresh = refreshServerCatalog().then((result) => {
    if (result.ok) onUpdated();
  }).finally(() => {
    scheduledRefresh = null;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      scheduleServerCatalogRefresh(onUpdated);
    }, CATALOG_REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  });
}
