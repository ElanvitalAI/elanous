/** Member-scoped, client-encrypted static-secret backup. The Nexus API only sees signed ciphertext. */
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { constants } from 'node:fs';
import { createBackupRecoveryKeyPair, createBackupSenderKeyPair, decryptMemberBackup, encryptMemberBackup,
  MAX_BACKUP_WIRE_BYTES, type EncryptedMemberBackup } from '../nexus/members/cloud-backup-e2e.js';
import { getSecretAsync, importSecretBatchAsync, listSecretIdsAsync } from '../nexus/config/secrets/index.js';
import { assertDistinctMigrationStaticIds, isExportableMigrationStaticId } from './credentials-migration-bundle.js';
import { acquireLockAsync } from '../storage/file-lock.js';

interface BackupIdentity {
  version: 1;
  id: string;
  generation: number;
  recoveryPublicKey: string;
  recoverySecretKey: string;
  senderPublicKey: string;
  senderSecretKey: string;
}

export interface SecretBackupDeps {
  fetch?: typeof fetch;
  listSecrets?: () => Promise<string[]>;
  getSecret?: (id: string) => Promise<string | undefined>;
  importSecrets?: typeof importSecretBatchAsync;
  /** Test-universe override; production uses the fixed whole-request ceiling. */
  timeoutMs?: number;
  /** Synthetic fault injection for the identity durability boundary. */
  fsyncIdentity?: (fd: number) => void;
  /** Synthetic cross-process lock-order observer. */
  onIdentityLockWait?: () => void;
}

export interface SecretBackupOptions {
  baseUrl: string;
  sessionFile: string;
  identityFile: string;
}

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const endpoint = '/v1/members/secret-backups';
// Source: #36826 untrusted E2E storage boundary; these transport bounds are not free-tier quotas.
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = MAX_BACKUP_WIRE_BYTES + 1024;
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
function decode(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string' || value.length > 128) throw new Error('BACKUP_IDENTITY_INVALID');
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (bytes.length !== length || encode(bytes) !== value) throw new Error('BACKUP_IDENTITY_INVALID');
  return bytes;
}
function privateText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid))
      throw new Error('BACKUP_PRIVATE_FILE_REQUIRED');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function readIdentity(path: string): BackupIdentity {
  const value = JSON.parse(privateText(path)) as Record<string, unknown>;
  if (value.version !== 1 || typeof value.id !== 'string' || !idPattern.test(value.id)
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) throw new Error('BACKUP_IDENTITY_INVALID');
  decode(value.recoveryPublicKey, 32); decode(value.recoverySecretKey, 32);
  decode(value.senderPublicKey, 32); decode(value.senderSecretKey, 64);
  return value as unknown as BackupIdentity;
}
function writeIdentity(path: string, value: BackupIdentity, sync: (fd: number) => void = fsyncSync): void {
  const directory = dirname(path); // Caller supplies an existing private directory; no undurable recursive mkdir.
  if (existsSync(path)) {
    const prior = readIdentity(path);
    if (prior.id !== value.id || prior.recoveryPublicKey !== value.recoveryPublicKey
      || prior.senderPublicKey !== value.senderPublicKey || prior.generation > value.generation)
      throw new Error('BACKUP_IDENTITY_CHANGED');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); sync(fd); } finally { closeSync(fd); }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try { sync(directoryFd); } finally { closeSync(directoryFd); }
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function readDurableIdentity(path: string, sync: (fd: number) => void = fsyncSync): BackupIdentity {
  const identity = readIdentity(path);
  // A previous rename may have succeeded while its directory fsync failed. Re-establish
  // both durability edges before relying on the identity for any upload or restore.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { sync(fd); } finally { closeSync(fd); }
  const directoryFd = openSync(dirname(path), constants.O_RDONLY);
  try { sync(directoryFd); } finally { closeSync(directoryFd); }
  return identity;
}
async function withIdentityLock<T>(path: string, deps: SecretBackupDeps, action: (assertHeld: () => void) => Promise<T>): Promise<T> {
  const lock = await acquireLockAsync(`${path}.lock`, { breakDeadHolder: true,
    onWait: () => deps.onIdentityLockWait?.() });
  const assertHeld = () => { if (!lock.stillHeld()) throw new Error('BACKUP_IDENTITY_LOCK_LOST'); };
  try { return await action(assertHeld); } finally { lock.release(); }
}
async function identityForPush(path: string, assertHeld: () => void, sync?: (fd: number) => void): Promise<BackupIdentity> {
  if (existsSync(path)) return readDurableIdentity(path, sync);
  const [recovery, sender] = await Promise.all([createBackupRecoveryKeyPair(), createBackupSenderKeyPair()]);
  const value: BackupIdentity = { version: 1, id: randomUUID(), generation: 0,
    recoveryPublicKey: encode(recovery.publicKey), recoverySecretKey: encode(recovery.secretKey),
    senderPublicKey: encode(sender.publicKey), senderSecretKey: encode(sender.privateKey) };
  assertHeld();
  writeIdentity(path, value, sync); // The sender pin is durable before any upload.
  return value;
}
function requestContext(options: SecretBackupOptions, deps: SecretBackupDeps) {
  const url = new URL(options.baseUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('BACKUP_URL_INVALID');
  const session = privateText(options.sessionFile).trim();
  if (!session || /[\s;\r\n]/.test(session)) throw new Error('BACKUP_SESSION_INVALID');
  const client = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS)
    throw new Error('BACKUP_TIMEOUT_INVALID');
  return async (path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; value: unknown }> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error('BACKUP_TIMEOUT'));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener('abort', fail, { once: true });
    });
    try {
      const response = await Promise.race([client(new URL(path, url), {
        ...init, signal: controller.signal, redirect: 'error',
        headers: { cookie: `__Host-elanous_member_session=${encodeURIComponent(session)}`,
          ...(init.headers as Record<string, string> | undefined) },
      }), aborted]);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('BACKUP_RESPONSE_TOO_LARGE');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('BACKUP_RESPONSE_INVALID');
      const chunks: Uint8Array[] = [];
      let size = 0;
      let completed = false;
      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) { completed = true; break; }
          size += value.length;
          if (size > MAX_RESPONSE_BYTES) throw new Error('BACKUP_RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } finally {
        if (!completed) void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* aborted read may still hold the lock */ }
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      return { ok: response.ok, status: response.status, value: JSON.parse(raw) as unknown };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  };
}
function keys(identity: BackupIdentity) {
  return { recovery: { publicKey: decode(identity.recoveryPublicKey, 32), secretKey: decode(identity.recoverySecretKey, 32) },
    sender: { publicKey: decode(identity.senderPublicKey, 32), privateKey: decode(identity.senderSecretKey, 64) } };
}
function signedBackup(value: unknown): EncryptedMemberBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BACKUP_RESPONSE_INVALID');
  const backup = (value as { backup?: unknown }).backup;
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('BACKUP_RESPONSE_INVALID');
  return backup as EncryptedMemberBackup;
}
async function readCurrent(call: ReturnType<typeof requestContext>, identity: BackupIdentity): Promise<{
  backup: EncryptedMemberBackup; plaintext: Uint8Array;
} | null> {
  const response = await call(`${endpoint}/${identity.id}`);
  if (response.status === 404) {
    if (identity.generation > 0) throw new Error('BACKUP_RECOVERY_DENIED');
    return null;
  }
  if (!response.ok) throw new Error('BACKUP_REMOTE_UNAVAILABLE');
  const backup = signedBackup(response.value);
  const { recovery, sender } = keys(identity);
  const plaintext = await decryptMemberBackup(backup, recovery,
    { id: identity.id, minGeneration: Math.max(1, identity.generation), trustedSenderPublicKey: sender.publicKey });
  return { backup, plaintext };
}

export async function pushSecretBackup(options: SecretBackupOptions, deps: SecretBackupDeps = {}): Promise<{ id: string; generation: number }> {
  return withIdentityLock(options.identityFile, deps, assertHeld => pushSecretBackupLocked(options, deps, assertHeld));
}
async function pushSecretBackupLocked(options: SecretBackupOptions, deps: SecretBackupDeps, assertHeld: () => void): Promise<{ id: string; generation: number }> {
  const call = requestContext(options, deps);
  let identity = await identityForPush(options.identityFile, assertHeld, deps.fsyncIdentity);
  const ids = (await (deps.listSecrets ?? listSecretIdsAsync)()).filter(isExportableMigrationStaticId).sort();
  if (!ids.length) throw new Error('BACKUP_EMPTY');
  assertDistinctMigrationStaticIds(ids);
  const entries: Record<string, string> = {};
  for (const id of ids) {
    const value = await (deps.getSecret ?? getSecretAsync)(id);
    if (value === undefined) throw new Error('BACKUP_LISTED_SECRET_MISSING');
    if (!value) throw new Error('BACKUP_CONTENT_INVALID');
    entries[id] = value;
  }
  if (!Object.keys(entries).length) throw new Error('BACKUP_EMPTY');
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, entries }));
  let current: Awaited<ReturnType<typeof readCurrent>> = null;
  try {
    // A POST may have committed before its response was lost. Always inspect the remote slot,
    // even while the local anchor is zero; only the locally pinned sender may reconcile it.
    current = await readCurrent(call, identity);
    const observedHigher = !!current && current.backup.generation > identity.generation;
    if (observedHigher && current) {
      assertHeld();
      identity = { ...identity, generation: current.backup.generation };
      writeIdentity(options.identityFile, identity, deps.fsyncIdentity);
    }
    if (observedHigher && current
      && current.plaintext.length === plaintext.length
      && current.plaintext.every((byte, index) => byte === plaintext[index])) {
      return { id: identity.id, generation: current.backup.generation };
    }
    const generation = (current?.backup.generation ?? 0) + 1;
    const envelope = await encryptMemberBackup(plaintext, keys(identity).recovery.publicKey, keys(identity).sender,
      { id: identity.id, generation });
    assertHeld();
    const response = await call(current ? `${endpoint}/${identity.id}` : endpoint, {
      method: current ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${current?.backup.generation ?? 0}"`,
        'idempotency-key': randomUUID() },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error('BACKUP_UPLOAD_FAILED');
    const result = response.value as { id?: unknown; generation?: unknown; sha256?: unknown };
    if (!result || result.id !== identity.id || result.generation !== generation || result.sha256 !== envelope.sha256)
      throw new Error('BACKUP_RESPONSE_INVALID');
    assertHeld();
    writeIdentity(options.identityFile, { ...identity, generation }, deps.fsyncIdentity);
    return { id: identity.id, generation };
  } finally { plaintext.fill(0); current?.plaintext.fill(0); }
}

export async function restoreSecretBackup(options: SecretBackupOptions & { overwrite?: boolean }, deps: SecretBackupDeps = {}): Promise<{ count: number; generation: number }> {
  return withIdentityLock(options.identityFile, deps, assertHeld => restoreSecretBackupLocked(options, deps, assertHeld));
}
async function restoreSecretBackupLocked(options: SecretBackupOptions & { overwrite?: boolean }, deps: SecretBackupDeps,
  assertHeld: () => void): Promise<{ count: number; generation: number }> {
  const identity = readDurableIdentity(options.identityFile, deps.fsyncIdentity);
  const current = await readCurrent(requestContext(options, deps), identity);
  if (!current) throw new Error('BACKUP_REMOTE_UNAVAILABLE');
  const { backup, plaintext } = current;
  let entries: Record<string, string>;
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as { version?: unknown; entries?: unknown };
    if (payload.version !== 1 || !payload.entries || typeof payload.entries !== 'object' || Array.isArray(payload.entries))
      throw new Error('BACKUP_CONTENT_INVALID');
    entries = payload.entries as Record<string, string>;
    if (!Object.entries(entries).length || Object.entries(entries).some(([id, value]) =>
      !isExportableMigrationStaticId(id) || typeof value !== 'string' || !value)) throw new Error('BACKUP_CONTENT_INVALID');
    assertDistinctMigrationStaticIds(Object.keys(entries));
  } finally { plaintext.fill(0); }
  assertHeld();
  if (backup.generation > identity.generation)
    writeIdentity(options.identityFile, { ...identity, generation: backup.generation }, deps.fsyncIdentity);
  assertHeld();
  const result = await (deps.importSecrets ?? importSecretBatchAsync)(entries, options.overwrite ?? false);
  if (!result.imported) throw new Error('BACKUP_IMPORT_CONFLICT');
  return { count: Object.keys(entries).length, generation: backup.generation };
}

export async function statusSecretBackup(options: SecretBackupOptions, deps: SecretBackupDeps = {}): Promise<{ remote: string; generation: number | null; localGeneration: number | null }> {
  const identity = existsSync(options.identityFile) ? readIdentity(options.identityFile) : null;
  const response = await requestContext(options, deps)(endpoint);
  if (!response.ok) throw new Error('BACKUP_REMOTE_UNAVAILABLE');
  const body = response.value as { backups?: unknown };
  if (!body || !Array.isArray(body.backups)) throw new Error('BACKUP_RESPONSE_INVALID');
  const match = identity && body.backups.find((item: unknown) => item && typeof item === 'object'
    && (item as { id?: unknown }).id === identity.id) as { generation?: unknown } | undefined;
  const generation = match && Number.isSafeInteger(match.generation) ? match.generation as number : null;
  return { remote: match ? 'present' : !identity && body.backups.length ? 'unknown' : 'absent',
    generation, localGeneration: identity?.generation ?? null };
}
