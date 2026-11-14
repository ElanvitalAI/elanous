/** Synthetic-first member backup boundary. Only the client functions ever see plaintext or keys. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import sodium from 'libsodium-wrappers';
import type { MemberStore } from './member-store.js';

export interface EncryptedMemberBackup {
  readonly version: 1;
  readonly id: string;
  readonly generation: number;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly sealedKey: string;
  readonly recoveryPublicKey: string;
  readonly sha256: string;
  readonly senderPublicKey: string;
  readonly senderSignature: string;
}

export interface BackupSenderKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COOKIE = '__Host-elanous_member_session';
// Transport safety bound, not the proposed free-tier quota or an entitlement.
export const MAX_BACKUP_WIRE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_BACKUP_WIRE_BYTES;
const AEAD_TAG_BYTES = 16;
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const aad = (id: string, generation: number) => Buffer.from(`elanous-member-backup-v1:${id}:${generation}`, 'utf8');

function signatureMessage(item: Omit<EncryptedMemberBackup, 'senderSignature'>): Uint8Array {
  return Buffer.from(JSON.stringify(['elanous-member-backup-v1-signature', item.version, item.id, item.generation,
    item.nonce, item.ciphertext, item.sealedKey, item.recoveryPublicKey, item.sha256, item.senderPublicKey]), 'utf8');
}

/** Exact JSON/base64 transport ceiling; this is not the proposed free-tier quota. */
export function maxBackupPlaintextBytes(id: string, generation: number): number {
  if (!ID.test(id) || !Number.isSafeInteger(generation) || generation < 1) throw new Error('BACKUP_INVALID');
  const fixed = JSON.stringify({ version: 1, id, generation, nonce: 'A'.repeat(32), ciphertext: '',
    sealedKey: 'A'.repeat(108), recoveryPublicKey: 'A'.repeat(44), sha256: '0'.repeat(64),
    senderPublicKey: 'A'.repeat(44), senderSignature: 'A'.repeat(88) });
  const availableBase64Bytes = MAX_BACKUP_WIRE_BYTES - Buffer.byteLength(fixed, 'utf8');
  return Math.max(0, 3 * Math.floor(availableBase64Bytes / 4) - AEAD_TAG_BYTES);
}

function decode(value: unknown, min: number, max: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 + 4
    || value.length % 4 !== 0) throw new Error('BACKUP_INVALID');
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (bytes.length < min || bytes.length > max || encode(bytes) !== value) throw new Error('BACKUP_INVALID');
  return bytes;
}

function validate(value: unknown): EncryptedMemberBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BACKUP_INVALID');
  const item = value as Record<string, unknown>;
  const keys = ['version', 'id', 'generation', 'nonce', 'ciphertext', 'sealedKey', 'recoveryPublicKey', 'sha256',
    'senderPublicKey', 'senderSignature'];
  if (Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || item.version !== 1 || typeof item.id !== 'string' || !ID.test(item.id)
    || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('BACKUP_INVALID');
  decode(item.nonce, 24, 24);
  const ciphertext = decode(item.ciphertext, 17, MAX_REQUEST_BYTES);
  decode(item.sealedKey, 80, 80); // sealed 32-byte key plus crypto_box_SEALBYTES
  decode(item.recoveryPublicKey, 32, 32);
  decode(item.senderPublicKey, 32, 32);
  decode(item.senderSignature, 64, 64);
  if (digest(ciphertext) !== item.sha256) throw new Error('BACKUP_INVALID');
  return item as unknown as EncryptedMemberBackup;
}

/** Generate the recovery pair on the client; the secret key must be stored out of band. */
export async function createBackupRecoveryKeyPair(): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

/** Distinct sender signing key; caller pins its public half at client registration. */
export async function createBackupSenderKeyPair(): Promise<BackupSenderKeyPair> {
  await sodium.ready;
  const pair = sodium.crypto_sign_keypair();
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Client only: encrypt before any network request. No plaintext or secret key enters the API body. */
export async function encryptMemberBackup(
  plaintext: Uint8Array, recoveryPublicKey: Uint8Array, sender: BackupSenderKeyPair,
  input: { id?: string; generation?: number } = {},
): Promise<EncryptedMemberBackup> {
  await sodium.ready;
  if (!(plaintext instanceof Uint8Array) || plaintext.length === 0
    || !(recoveryPublicKey instanceof Uint8Array) || recoveryPublicKey.length !== sodium.crypto_box_PUBLICKEYBYTES
    || !(sender?.publicKey instanceof Uint8Array) || sender.publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES
    || !(sender.privateKey instanceof Uint8Array) || sender.privateKey.length !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new Error('BACKUP_INVALID');
  }
  const id = input.id ?? randomUUID();
  const generation = input.generation ?? 1;
  if (plaintext.length > maxBackupPlaintextBytes(id, generation)) throw new Error('BACKUP_INVALID');
  const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  try {
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad(id, generation), null, nonce, key);
    const sealedKey = sodium.crypto_box_seal(key, recoveryPublicKey);
    const unsigned = { version: 1 as const, id, generation, nonce: encode(nonce), ciphertext: encode(ciphertext),
      sealedKey: encode(sealedKey), recoveryPublicKey: encode(recoveryPublicKey), sha256: digest(ciphertext),
      senderPublicKey: encode(sender.publicKey) };
    const message = signatureMessage(unsigned);
    const senderSignature = sodium.crypto_sign_detached(message, sender.privateKey);
    if (!sodium.crypto_sign_verify_detached(senderSignature, message, sender.publicKey)) throw new Error('BACKUP_INVALID');
    const envelope = { ...unsigned, senderSignature: encode(senderSignature) };
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_BACKUP_WIRE_BYTES) throw new Error('BACKUP_INVALID');
    return envelope;
  } finally { sodium.memzero(key); }
}

/** Client only: caller supplies a locally retained generation floor to reject server rollback. */
export async function decryptMemberBackup(
  value: unknown, recovery: { publicKey: Uint8Array; secretKey: Uint8Array },
  expected: { id: string; minGeneration: number; trustedSenderPublicKey: Uint8Array },
): Promise<Uint8Array> {
  await sodium.ready;
  const item = validate(value);
  if (item.id !== expected.id || !Number.isSafeInteger(expected.minGeneration)
    || expected.minGeneration < 1 || item.generation < expected.minGeneration
    || !(recovery.publicKey instanceof Uint8Array) || recovery.publicKey.length !== 32
    || !(recovery.secretKey instanceof Uint8Array) || recovery.secretKey.length !== 32
    || encode(recovery.publicKey) !== item.recoveryPublicKey
    || !(expected.trustedSenderPublicKey instanceof Uint8Array)
    || expected.trustedSenderPublicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES
    || encode(expected.trustedSenderPublicKey) !== item.senderPublicKey) throw new Error('BACKUP_RECOVERY_DENIED');
  let key: Uint8Array | undefined;
  try {
    const { senderSignature, ...unsigned } = item;
    if (!sodium.crypto_sign_verify_detached(decode(senderSignature, 64, 64), signatureMessage(unsigned),
      expected.trustedSenderPublicKey)) throw new Error('BACKUP_RECOVERY_DENIED');
    const opened = sodium.crypto_box_seal_open(decode(item.sealedKey, 80, 80), recovery.publicKey, recovery.secretKey);
    if (!opened) throw new Error('BACKUP_RECOVERY_DENIED');
    key = opened;
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, decode(item.ciphertext, 17, MAX_REQUEST_BYTES),
      aad(item.id, item.generation), decode(item.nonce, 24, 24), key);
  } catch { throw new Error('BACKUP_RECOVERY_DENIED'); }
  finally { if (key) sodium.memzero(key); }
}

type Row = { generation: number; deleted: number; envelope: string; sha256: string };
function response(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
function session(request: Request): string | null {
  const part = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`));
  if (!part) return null;
  try { return decodeURIComponent(part.slice(COOKIE.length + 1)); } catch { return null; }
}
function match(request: Request): number | null {
  const raw = request.headers.get('if-match');
  if (!raw || !/^"(?:0|[1-9][0-9]*)"$/.test(raw)) return null;
  const n = Number(raw.slice(1, -1));
  return Number.isSafeInteger(n) ? n : null;
}

async function readLimitedJson(request: Request): Promise<{ raw: string; value: unknown }> {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new Error('BACKUP_INVALID');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('BACKUP_INVALID');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new Error('BACKUP_INVALID'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  return { raw, value: JSON.parse(raw) as unknown };
}

/** Fake-server-compatible HTTP boundary. SQLite stores ciphertext, envelope and opaque metadata only. */
export function createMemberCloudBackupApi(options: {
  dbPath: string;
  memberStore: Pick<MemberStore, 'memberForSession'>;
  now?: () => Date;
}) {
  mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(options.dbPath, { create: true });
  chmodSync(options.dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS member_backup (
      owner TEXT NOT NULL, id TEXT NOT NULL, generation INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      envelope TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(owner,id)
    );
    CREATE TABLE IF NOT EXISTS member_backup_retry (
      owner TEXT NOT NULL, retry_key TEXT NOT NULL, request_sha TEXT NOT NULL,
      response TEXT NOT NULL, PRIMARY KEY(owner,retry_key)
    );`);
  const row = (owner: string, id: string) => db.query('SELECT generation,deleted,envelope,sha256 FROM member_backup WHERE owner=? AND id=?')
    .get(owner, id) as Row | null;
  const now = () => (options.now?.() ?? new Date()).toISOString();
  return {
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const base = '/v1/members/secret-backups';
      if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return undefined;
      if (url.search || url.hash) return response({ error: 'invalid-request' }, 400);
      let owner: string | null = null;
      try {
        const token = session(request);
        owner = token ? options.memberStore.memberForSession(token, now())?.id ?? null : null;
      } catch { return response({ error: 'unavailable' }, 503); }
      if (!owner) return response({ error: 'unauthorized' }, 401);
      const id = url.pathname === base ? null : url.pathname.slice(base.length + 1);
      if (id !== null && !ID.test(id)) return response({ error: 'not-found' }, 404);
      if (request.method === 'GET' && id === null) {
        const rows = db.query('SELECT id,generation,sha256 FROM member_backup WHERE owner=? AND deleted=0 ORDER BY id')
          .all(owner) as Array<{ id: string; generation: number; sha256: string }>;
        return response({ backups: rows });
      }
      if (request.method === 'GET' && id !== null) {
        const found = row(owner, id);
        return found && !found.deleted ? response({ backup: JSON.parse(found.envelope) as EncryptedMemberBackup }, 200)
          : response({ error: 'not-found' }, 404);
      }
      if (request.method === 'POST' && id === null || request.method === 'PUT' && id !== null) {
        const retryKey = request.headers.get('idempotency-key');
        const expected = match(request);
        if (!retryKey || retryKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(retryKey) || expected === null)
          return response({ error: 'precondition-required' }, 428);
        let raw: string;
        let item: EncryptedMemberBackup;
        try {
          const body = await readLimitedJson(request);
          raw = body.raw;
          item = validate(body.value);
        } catch { return response({ error: 'invalid-request' }, 400); }
        if (id !== null && item.id !== id) return response({ error: 'invalid-request' }, 400);
        const requestSha = digest(Buffer.from(`${request.method}:${item.id}:${expected}:${raw}`, 'utf8'));
        try {
          return db.transaction(() => {
            const retry = db.query('SELECT request_sha,response FROM member_backup_retry WHERE owner=? AND retry_key=?')
              .get(owner, retryKey) as { request_sha: string; response: string } | null;
            if (retry) {
              if (retry.request_sha !== requestSha) return response({ error: 'idempotency-conflict' }, 409);
              const original = JSON.parse(retry.response) as { id: string; generation: number; sha256: string };
              const latest = row(owner, original.id);
              // A repeated request is safe only while that committed generation is
              // still current. Never report a deleted or superseded backup as live.
              if (!latest || latest.deleted || latest.generation !== original.generation || latest.sha256 !== original.sha256)
                return response({ error: 'generation-conflict' }, 409);
              return response(original);
            }
            const old = row(owner, item.id);
            if (old?.deleted || (old?.generation ?? 0) !== expected || item.generation !== expected + 1)
              return response({ error: 'generation-conflict' }, 409);
            db.query(`INSERT INTO member_backup(owner,id,generation,envelope,sha256) VALUES (?,?,?,?,?)
              ON CONFLICT(owner,id) DO UPDATE SET generation=excluded.generation,envelope=excluded.envelope,sha256=excluded.sha256`)
              .run(owner, item.id, item.generation, JSON.stringify(item), item.sha256);
            const result = { id: item.id, generation: item.generation, sha256: item.sha256 };
            db.query('INSERT INTO member_backup_retry(owner,retry_key,request_sha,response) VALUES (?,?,?,?)')
              .run(owner, retryKey, requestSha, JSON.stringify(result));
            return response(result, old ? 200 : 201);
          }).immediate();
        } catch { return response({ error: 'unavailable' }, 503); }
      }
      if (request.method === 'DELETE' && id !== null) {
        const expected = match(request);
        if (expected === null) return response({ error: 'precondition-required' }, 428);
        try {
          return db.transaction(() => {
            const old = row(owner, id);
            if (!old || old.deleted) return response({ error: 'not-found' }, 404);
            if (old.generation !== expected) return response({ error: 'generation-conflict' }, 409);
            db.query("UPDATE member_backup SET deleted=1,envelope='',sha256='' WHERE owner=? AND id=? AND generation=?")
              .run(owner, id, expected);
            return response({ id, deleted: true });
          }).immediate();
        } catch { return response({ error: 'unavailable' }, 503); }
      }
      return response({ error: 'method-not-allowed' }, 405);
    },
    close() { db.close(); },
  };
}
