import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObjectStore, type RunFn, type StorageConfig, type StorageProvider } from '../storage/object-store.js';

const APP_PREFIX = 'apps';
const SIGNED_URL_ORIGIN = 'https://storage.invalid';
const MINUTE_MS = 60_000;
const DEFAULT_CONTENT_TYPES = ['application/json', 'audio/mpeg', 'audio/wav', 'audio/webm', 'image/jpeg', 'image/png'] as const;

export interface AppStorageOptions {
  readonly rootDir?: string;
  readonly provider?: StorageProvider;
  readonly run?: RunFn;
  readonly now?: () => number;
  readonly signingKey?: string;
  readonly appQuotaBytes?: number;
  readonly anonymousUploadsPerMinute?: number;
  readonly allowedContentTypes?: readonly string[];
  readonly providerFailureStatus?: 403 | 503;
}

export interface AppStorageUploadInput {
  readonly appSlug: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly anonymous?: boolean;
}

export interface AppStorageResponse {
  readonly status: 200 | 201 | 400 | 403 | 404 | 413 | 415 | 429 | 500 | 503;
  readonly body?: Uint8Array;
  readonly bytes?: number;
  readonly retryable?: boolean;
  readonly reason?: string;
}

export interface AppStoragePort {
  upload(input: AppStorageUploadInput): AppStorageResponse;
  uploadSigned(input: { readonly url: string; readonly method: string; readonly body: Uint8Array; readonly contentType: string; readonly anonymous?: boolean }): AppStorageResponse;
  read(input: { readonly appSlug: string; readonly key: string }): AppStorageResponse;
  list(appSlug: string): string[];
  signUploadUrl(input: { readonly appSlug: string; readonly key: string; readonly expiresInMs: number }): string;
  advanceTime(ms: number): void;
  ledger(): readonly { readonly appSlug: string; readonly bytes: number; readonly status: number }[];
  providerCalls(): number;
  close(): void;
}

export interface AppStorageContractCase {
  readonly id: string;
  readonly name: string;
  readonly options?: Pick<AppStorageOptions, 'appQuotaBytes' | 'anonymousUploadsPerMinute' | 'provider' | 'providerFailureStatus' | 'run'>;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
}

export interface AppStorageContractResult {
  readonly id: string;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly actual: Readonly<Record<string, unknown>>;
  readonly passed: boolean;
}

export interface AppStorageContractPortFactory {
  create(options: AppStorageContractCase['options'] & { readonly rootDir: string }): AppStoragePort;
}

export const APP_STORAGE_CONTRACT_CASES: readonly AppStorageContractCase[] = [
  {
    id: 'path-escape', name: 'reject absolute, traversal, and caller-supplied app prefixes',
    input: { appSlug: 'notes', keys: ['../outside.wav', '/etc/passwd', 'apps/other/secret.wav', '..\\outside.wav'] },
    expected: { statuses: [400, 400, 400, 400], appKeys: [], otherAppRead: 404, physicalFiles: [] },
  },
  {
    id: 'app-quota', name: 'reject an over-quota write without changing stored bytes',
    options: { appQuotaBytes: 5 },
    input: { appSlug: 'notes', firstKey: 'audio/clip.wav', overflowKey: 'audio/overflow.wav', firstBody: 'abc', overwriteBody: '12345', oversizedOverwriteBody: '123456' },
    expected: { statuses: [201, 201, 413], storedBody: '12345', overflowRead: 404, storedBytes: 5, physicalFiles: ['store/private/apps/notes/audio/clip.wav'], physicalBody: '12345' },
  },
  {
    id: 'app-isolation', name: 'isolate identical keys across apps with similar slug prefixes',
    input: { appSlug: 'notes', similarAppSlug: 'notes-team', key: 'audio/clip.wav', firstBody: 'one', secondBody: 'two' },
    expected: { statuses: [201, 201], bodies: ['one', 'two'], appKeys: [['audio/clip.wav'], ['audio/clip.wav']] },
  },
  {
    id: 'content-type', name: 'allow declared audio and reject unlisted media types before writing',
    input: { appSlug: 'notes', acceptedKey: 'audio/clip.webm', rejectedKey: 'audio/script.js', acceptedType: 'audio/webm', rejectedType: 'application/javascript' },
    expected: { statuses: [201, 415], acceptedRead: 200, rejectedRead: 404 },
  },
  {
    id: 'signed-url', name: 'accept a valid signed PUT and reject expiry, tampering, and method changes',
    input: { appSlug: 'notes', key: 'audio/signed.webm', body: 'recording', expiresInMs: 10 },
    expected: { statuses: [201, 403, 403, 403], storedBody: 'recording' },
  },
  {
    id: 'anonymous-rate-limit', name: 'limit anonymous uploads per app and leave another app unaffected',
    options: { anonymousUploadsPerMinute: 2 },
    input: { appSlug: 'notes', otherAppSlug: 'tasks' },
    expected: { statuses: [201, 201, 429, 201] },
  },
  {
    id: 'anonymous-provider-failure', name: 'count anonymous attempts before a failing provider lookup',
    options: { provider: 's3', anonymousUploadsPerMinute: 1, run: () => { throw new Error('503 Service Unavailable'); } },
    input: { appSlug: 'notes' },
    expected: { statuses: [503, 429], providerCalls: 1 },
  },
  {
    id: 's3-provider-5xx', name: 'surface a fake S3 5xx as retryable without network access',
    options: { provider: 's3', providerFailureStatus: 503 },
    input: { appSlug: 'notes', key: 'generated/result.json', body: 'result' },
    expected: { status: 503, retryable: true, providerCalls: 3 },
  },
  {
    id: 's3-provider-403', name: 'surface a fake S3 authorization rejection as non-retryable',
    options: { provider: 's3', providerFailureStatus: 403 },
    input: { appSlug: 'notes', key: 'generated/result.json', body: 'result' },
    expected: { status: 403, retryable: false, providerCalls: 3 },
  },
];

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);
}

function cleanKey(key: string): string | null {
  if (!key || key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.startsWith(`${APP_PREFIX}/`)) return null;
  const parts = key.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) return null;
  return parts.join('/');
}

function appObjectKey(appSlug: string, key: string): string | null {
  if (!isValidSlug(appSlug)) return null;
  const clean = cleanKey(key);
  return clean ? `${APP_PREFIX}/${appSlug}/${clean}` : null;
}

function canonicalContentType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

interface SignedClaims {
  readonly v: 1;
  readonly appSlug: string;
  readonly key: string;
  readonly method: 'PUT';
  readonly expiresAt: number;
}

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
    if (value.v !== 1 || typeof value.appSlug !== 'string' || !isValidSlug(value.appSlug)
      || typeof value.key !== 'string' || !cleanKey(value.key) || value.method !== 'PUT'
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || now >= value.expiresAt) return null;
    return value as SignedClaims;
  } catch { return null; }
}

function tamperToken(token: string): string {
  const dot = token.lastIndexOf('.');
  if (dot < 0 || dot + 1 >= token.length) return `${token}x`;
  const at = dot + 1;
  return `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
}

function makeUrl(claims: SignedClaims, key: string): string {
  const encodedKey = claims.key.split('/').map(encodeURIComponent).join('/');
  const token = tokenFor(claims, key);
  return `${SIGNED_URL_ORIGIN}/${encodeURIComponent(claims.appSlug)}/${encodedKey}?token=${encodeURIComponent(token)}`;
}

function parseUrlPath(url: URL): { appSlug: string; key: string } | null {
  if (url.origin !== SIGNED_URL_ORIGIN) return null;
  try {
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (parts.length < 2) return null;
    return { appSlug: parts[0]!, key: parts.slice(1).join('/') };
  } catch { return null; }
}

export function createFakeAppStorage(options: AppStorageOptions = {}): AppStoragePort {
  const provider = options.provider ?? 'local';
  if (provider !== 'local' && !options.run) throw new Error('non-local app storage requires an injected fake RunFn');
  const rootDir = options.rootDir ?? mkdtempSync(join(tmpdir(), 'ux-sim-app-storage-'));
  const ownsRoot = options.rootDir === undefined;
  const storeConfig: StorageConfig = { provider, localDir: rootDir, bucket: 'private', publicBucket: '', prefix: 'apps', ...(provider === 's3' ? { s3: { region: 'us-east-1' } } : {}) };
  let providerCallCount = 0;
  let providerError: unknown;
  const run: RunFn | undefined = options.run ? ((bin, args, runOptions) => {
    providerCallCount++;
    try { return options.run!(bin, args, runOptions); }
    catch (error) { providerError = error; throw error; }
  }) : undefined;
  const store = createObjectStore(storeConfig, { run, which: (name) => name });
  const now = options.now ?? Date.now;
  const signingKey = options.signingKey ?? randomBytes(32).toString('base64url');
  const appQuotaBytes = options.appQuotaBytes ?? 10 * 1024 * 1024;
  const anonymousLimit = options.anonymousUploadsPerMinute ?? 10;
  const allowedContentTypes = new Set((options.allowedContentTypes ?? DEFAULT_CONTENT_TYPES).map(canonicalContentType));
  const anonymousAttempts = new Map<string, number[]>();
  const records: Array<{ appSlug: string; bytes: number; status: number }> = [];
  let timeOffset = 0;
  let closed = false;

  function currentTime(): number { return now() + timeOffset; }
  function providerStatus(error: unknown): { status: 403 | 404 | 500 | 503; retryable: boolean } {
    const text = String(error);
    if (/\b403\b|forbidden|accessdenied/i.test(text)) return { status: 403, retryable: false };
    if (/\b404\b|not.?found|nosuchkey/i.test(text)) return { status: 404, retryable: false };
    const transient = /\b(500|502|503|504)\b|5xx|timeout|tempor|unavailable/i.test(text);
    return { status: transient ? 503 : 500, retryable: transient };
  }
  function listObjects(prefix: string): string[] {
    providerError = undefined;
    const keys = store.list(prefix);
    if (providerError) throw providerError;
    return keys;
  }
  function headObject(key: string): ReturnType<typeof store.head> {
    providerError = undefined;
    const head = store.head(key);
    if (providerError && providerStatus(providerError).status !== 404) throw providerError;
    providerError = undefined;
    return head;
  }
  function totalBytes(appSlug: string): number {
    const prefix = `${APP_PREFIX}/${appSlug}/`;
    let total = 0;
    for (const key of listObjects(prefix)) {
      const head = headObject(key);
      if (!head.exists || head.bytes === undefined) throw new Error('stored object size unavailable');
      total += head.bytes;
    }
    return total;
  }
  function safeSlug(slug: string): string { return isValidSlug(slug) ? slug : 'invalid-app'; }
  function record(appSlug: string, bytes: number, response: AppStorageResponse): AppStorageResponse {
    records.push({ appSlug: safeSlug(appSlug), bytes, status: response.status });
    return response;
  }
  function reject(appSlug: string, status: AppStorageResponse['status'], reason: string, retryable = false): AppStorageResponse {
    return record(appSlug, 0, { status, reason, ...(retryable ? { retryable: true } : {}) });
  }

  function upload(input: AppStorageUploadInput): AppStorageResponse {
    if (closed) return reject(input.appSlug, 500, 'storage is closed');
    const fullKey = appObjectKey(input.appSlug, input.key);
    if (!fullKey) return reject(input.appSlug, 400, 'invalid app slug or app-relative object key');
    const contentType = canonicalContentType(input.contentType);
    if (!allowedContentTypes.has(contentType)) return reject(input.appSlug, 415, 'content type is not allowed');
    if (!(input.body instanceof Uint8Array)) return reject(input.appSlug, 400, 'body must be bytes');
    if (!Number.isSafeInteger(appQuotaBytes) || appQuotaBytes < 0) return reject(input.appSlug, 500, 'invalid app quota');
    if (input.anonymous) {
      const cutoff = currentTime() - MINUTE_MS;
      const active = (anonymousAttempts.get(input.appSlug) ?? []).filter((attempt) => attempt > cutoff);
      if (active.length >= anonymousLimit) return reject(input.appSlug, 429, 'anonymous upload rate limit exceeded');
      active.push(currentTime());
      anonymousAttempts.set(input.appSlug, active);
    }
    let storedBytes: number;
    let priorBytes = 0;
    try {
      storedBytes = totalBytes(input.appSlug);
      const prior = headObject(fullKey);
      if (prior.exists) {
        if (prior.bytes === undefined) throw new Error('stored object size unavailable');
        priorBytes = prior.bytes;
      }
    } catch (error) {
      const failure = provider !== 'local' ? providerStatus(error) : { status: 500 as const, retryable: false };
      return reject(input.appSlug, failure.status, 'stored object size unavailable', failure.retryable);
    }
    if (storedBytes - priorBytes + input.body.byteLength > appQuotaBytes) {
      return reject(input.appSlug, 413, 'app storage quota exceeded');
    }
    try {
      store.put(fullKey, input.body, { contentType });
    } catch (error) {
      const providerFailure = provider !== 'local';
      const failure = providerFailure ? providerStatus(error) : { status: 500 as const, retryable: false };
      return reject(input.appSlug, failure.status, providerFailure ? 'storage provider rejected upload' : 'local storage write failed', failure.retryable);
    }
    return record(input.appSlug, input.body.byteLength, { status: 201, bytes: input.body.byteLength });
  }

  function read(input: { appSlug: string; key: string }): AppStorageResponse {
    const fullKey = appObjectKey(input.appSlug, input.key);
    if (!fullKey) return reject(input.appSlug, 400, 'invalid app slug or app-relative object key');
    const tempDir = mkdtempSync(join(tmpdir(), 'ux-sim-app-storage-read-'));
    try {
      const destination = join(tempDir, 'object.bin');
      store.get(fullKey, destination);
      const body = readFileSync(destination);
      return record(input.appSlug, 0, { status: 200, body, bytes: body.byteLength });
    } catch (error) {
      const failure = provider !== 'local' ? providerStatus(error) : { status: 404 as const, retryable: false };
      return reject(input.appSlug, failure.status, failure.status === 404 ? 'object not found' : 'storage provider read failed', failure.retryable);
    }
    finally { rmSync(tempDir, { recursive: true, force: true }); }
  }

  function signUploadUrl(input: { appSlug: string; key: string; expiresInMs: number }): string {
    if (!appObjectKey(input.appSlug, input.key)) throw new Error('invalid app slug or app-relative object key');
    if (!Number.isSafeInteger(input.expiresInMs) || input.expiresInMs <= 0) throw new Error('expiresInMs must be a positive integer');
    return makeUrl({ v: 1, appSlug: input.appSlug, key: input.key, method: 'PUT', expiresAt: currentTime() + input.expiresInMs }, signingKey);
  }

  function uploadSigned(input: { url: string; method: string; body: Uint8Array; contentType: string; anonymous?: boolean }): AppStorageResponse {
    let parsed: URL;
    try { parsed = new URL(input.url); } catch { return reject('invalid-app', 403, 'invalid signed URL'); }
    const path = parseUrlPath(parsed);
    const token = parsed.searchParams.get('token') ?? '';
    const claims = readSignedClaims(token, signingKey, currentTime());
    if (!path || !claims || path.appSlug !== claims.appSlug || path.key !== claims.key || input.method !== claims.method) {
      return reject('invalid-app', 403, 'signed URL is invalid, expired, or method-mismatched');
    }
    return upload({ appSlug: claims.appSlug, key: claims.key, body: input.body, contentType: input.contentType, anonymous: input.anonymous });
  }

  return {
    upload,
    uploadSigned,
    read,
    list(appSlug) {
      if (!isValidSlug(appSlug)) return [];
      const prefix = `${APP_PREFIX}/${appSlug}/`;
      try { return listObjects(prefix).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort(); }
      catch { return []; }
    },
    signUploadUrl,
    advanceTime(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('advanceTime requires a nonnegative finite duration');
      timeOffset += ms;
    },
    ledger() { return records.map((entry) => ({ ...entry })); },
    providerCalls() { return providerCallCount; },
    close() {
      if (closed) return;
      closed = true;
      if (ownsRoot) rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function body(value: unknown): Uint8Array { return new TextEncoder().encode(String(value)); }
function text(value?: Uint8Array): string { return value ? new TextDecoder().decode(value) : ''; }

export function runAppStorageContractCase(contract: AppStorageContractCase, factory: AppStorageContractPortFactory): AppStorageContractResult {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'ux-sim-app-storage-contract-'));
  const rootDir = join(fixtureDir, 'store');
  mkdirSync(rootDir);
  let port: AppStoragePort | undefined;
  let actual: Readonly<Record<string, unknown>>;
  try {
    port = factory.create({ ...contract.options, rootDir });
    switch (contract.id) {
      case 'path-escape': {
        const input = contract.input as { appSlug: string; keys: string[] };
        const activePort = port;
        const statuses = input.keys.map((key) => activePort.upload({ appSlug: input.appSlug, key, body: body('secret'), contentType: 'audio/wav' }).status);
        actual = { statuses, appKeys: port.list(input.appSlug), otherAppRead: port.read({ appSlug: 'other', key: 'secret.wav' }).status };
        break;
      }
      case 'app-quota': {
        const input = contract.input as { appSlug: string; firstKey: string; overflowKey: string; firstBody: string; overwriteBody: string; oversizedOverwriteBody: string };
        const first = port.upload({ appSlug: input.appSlug, key: input.firstKey, body: body(input.firstBody), contentType: 'audio/wav' });
        port.close();
        port = factory.create({ ...contract.options, rootDir });
        const overwrite = port.upload({ appSlug: input.appSlug, key: input.firstKey, body: body(input.overwriteBody), contentType: 'audio/wav' });
        const oversized = port.upload({ appSlug: input.appSlug, key: input.firstKey, body: body(input.oversizedOverwriteBody), contentType: 'audio/wav' });
        const stored = port.read({ appSlug: input.appSlug, key: input.firstKey });
        const missing = port.read({ appSlug: input.appSlug, key: input.overflowKey });
        actual = { statuses: [first.status, overwrite.status, oversized.status], storedBody: text(stored.body), overflowRead: missing.status, storedBytes: stored.bytes };
        break;
      }
      case 'app-isolation': {
        const input = contract.input as { appSlug: string; similarAppSlug: string; key: string; firstBody: string; secondBody: string };
        const first = port.upload({ appSlug: input.appSlug, key: input.key, body: body(input.firstBody), contentType: 'audio/wav' });
        const second = port.upload({ appSlug: input.similarAppSlug, key: input.key, body: body(input.secondBody), contentType: 'audio/wav' });
        actual = {
          statuses: [first.status, second.status],
          bodies: [text(port.read({ appSlug: input.appSlug, key: input.key }).body), text(port.read({ appSlug: input.similarAppSlug, key: input.key }).body)],
          appKeys: [port.list(input.appSlug), port.list(input.similarAppSlug)],
        };
        break;
      }
      case 'content-type': {
        const input = contract.input as { appSlug: string; acceptedKey: string; rejectedKey: string; acceptedType: string; rejectedType: string };
        const accepted = port.upload({ appSlug: input.appSlug, key: input.acceptedKey, body: body('ok'), contentType: input.acceptedType });
        const rejected = port.upload({ appSlug: input.appSlug, key: input.rejectedKey, body: body('bad'), contentType: input.rejectedType });
        actual = { statuses: [accepted.status, rejected.status], acceptedRead: port.read({ appSlug: input.appSlug, key: input.acceptedKey }).status, rejectedRead: port.read({ appSlug: input.appSlug, key: input.rejectedKey }).status };
        break;
      }
      case 'signed-url': {
        const input = contract.input as { appSlug: string; key: string; body: string; expiresInMs: number };
        const valid = port.signUploadUrl({ appSlug: input.appSlug, key: input.key, expiresInMs: input.expiresInMs });
        const accepted = port.uploadSigned({ url: valid, method: 'PUT', body: body(input.body), contentType: 'audio/webm' });
        const storedBody = text(port.read({ appSlug: input.appSlug, key: input.key }).body);
        const expired = port.signUploadUrl({ appSlug: input.appSlug, key: 'audio/expired.webm', expiresInMs: input.expiresInMs });
        port.advanceTime(input.expiresInMs);
        const expiredResult = port.uploadSigned({ url: expired, method: 'PUT', body: body('expired'), contentType: 'audio/webm' });
        const tamperedBase = port.signUploadUrl({ appSlug: input.appSlug, key: 'audio/tampered.webm', expiresInMs: 10_000 });
        const tamperedUrl = new URL(tamperedBase);
        const token = tamperedUrl.searchParams.get('token') ?? '';
        tamperedUrl.searchParams.set('token', tamperToken(token));
        const tamperedResult = port.uploadSigned({ url: tamperedUrl.toString(), method: 'PUT', body: body('tampered'), contentType: 'audio/webm' });
        const wrongMethodUrl = port.signUploadUrl({ appSlug: input.appSlug, key: 'audio/method.webm', expiresInMs: 10_000 });
        const wrongMethod = port.uploadSigned({ url: wrongMethodUrl, method: 'GET', body: body('wrong-method'), contentType: 'audio/webm' });
        actual = { statuses: [accepted.status, expiredResult.status, tamperedResult.status, wrongMethod.status], storedBody };
        break;
      }
      case 'anonymous-rate-limit': {
        const input = contract.input as { appSlug: string; otherAppSlug: string };
        const first = port.upload({ appSlug: input.appSlug, key: 'a.wav', body: body('a'), contentType: 'audio/wav', anonymous: true });
        const second = port.upload({ appSlug: input.appSlug, key: 'b.wav', body: body('b'), contentType: 'audio/wav', anonymous: true });
        const limited = port.upload({ appSlug: input.appSlug, key: 'c.wav', body: body('c'), contentType: 'audio/wav', anonymous: true });
        const other = port.upload({ appSlug: input.otherAppSlug, key: 'a.wav', body: body('a'), contentType: 'audio/wav', anonymous: true });
        actual = { statuses: [first.status, second.status, limited.status, other.status] };
        break;
      }
      case 'anonymous-provider-failure': {
        const input = contract.input as { appSlug: string };
        const activePort = port;
        const upload = (key: string) => activePort.upload({ appSlug: input.appSlug, key, body: body('x'), contentType: 'audio/wav', anonymous: true });
        actual = { statuses: [upload('first.wav').status, upload('second.wav').status], providerCalls: activePort.providerCalls() };
        break;
      }
      case 's3-provider-5xx':
      case 's3-provider-403': {
        const input = contract.input as { appSlug: string; key: string; body: string };
        const response = port.upload({ appSlug: input.appSlug, key: input.key, body: body(input.body), contentType: 'application/json' });
        actual = { status: response.status, retryable: response.retryable === true, providerCalls: port.providerCalls() };
        break;
      }
      default: throw new Error(`unknown app storage contract: ${contract.id}`);
    }
    if (Object.hasOwn(contract.expected, 'physicalFiles')) {
      const physicalFiles: string[] = [];
      const walk = (directory: string, relative = '') => {
        if (!existsSync(directory)) return;
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          const key = relative ? `${relative}/${name}` : name;
          if (statSync(path).isDirectory()) walk(path, key);
          else physicalFiles.push(key);
        }
      };
      walk(fixtureDir);
      const physicalBodyPath = join(rootDir, 'private', 'apps', 'notes', 'audio', 'clip.wav');
      actual = { ...actual, physicalFiles, ...(existsSync(physicalBodyPath) ? { physicalBody: readFileSync(physicalBodyPath, 'utf8') } : {}) };
    }
    const passed = JSON.stringify(actual) === JSON.stringify(contract.expected);
    return { id: contract.id, expected: contract.expected, actual, passed };
  } finally { port?.close(); rmSync(fixtureDir, { recursive: true, force: true }); }
}

export function runAppStorageContractMatrix(factory: AppStorageContractPortFactory): AppStorageContractResult[] {
  return APP_STORAGE_CONTRACT_CASES.map((contract) => runAppStorageContractCase(contract, factory));
}
