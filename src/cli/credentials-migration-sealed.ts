import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { assertDistinctMigrationStaticIds, isExportableMigrationStaticId, migrationStaticSlots } from './credentials-migration-bundle.js';

const FORMAT = 'elanous-static-sealed-v1';
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const machinePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;

interface SealedMetadata {
  format: typeof FORMAT;
  bundleId: string;
  targetMachine: string;
  targetKeyVersion: number;
  targetFingerprint: string;
  createdAt: number;
  expiresAt: number;
}

interface SealedEnvelope extends SealedMetadata { ciphertext: string }
interface SealedContents extends SealedMetadata { staticSecrets: Record<string, string> }

/** The backend must compare empty slots and commit the entire batch plus marker in one transaction. */
export interface AtomicSealedStaticBackend {
  readonly atomicBatchAndMarker: true;
  commitEmptyStaticBatch(input: {
    readonly bundleId: string;
    readonly envelopeSha256: string;
    readonly staticSecrets: Readonly<Record<string, string>>;
  }): Promise<'applied' | 'already-applied' | 'conflict'>;
}

export interface SealedImportApproval {
  readonly mode: 'manual-untrusted';
  /** Compared with an out-of-band copy before the operator approves. */
  readonly envelopeSha256: string;
  readonly sourceConfirmedOutOfBand: true;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function reject(): never { throw new Error('SEALED_MIGRATION_REFUSED'); }

function validKey(value: Uint8Array): boolean { return value instanceof Uint8Array && value.length === 32; }

function equalHex(left: string, right: string): boolean {
  return fingerprintPattern.test(left) && fingerprintPattern.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function validateMetadata(value: SealedMetadata, now: number): void {
  if (value.format !== FORMAT || !/^[0-9a-f-]{36}$/.test(value.bundleId)
    || !machinePattern.test(value.targetMachine) || !Number.isSafeInteger(value.targetKeyVersion)
    || value.targetKeyVersion < 1 || !fingerprintPattern.test(value.targetFingerprint)
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
    || value.createdAt > now || value.expiresAt <= now
    || value.expiresAt - value.createdAt > MAX_LIFETIME_MS) reject();
}

function validateStaticSecrets(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 128
    || entries.some(([id, secret]) => !isExportableMigrationStaticId(id)
      || migrationStaticSlots(id)?.includes('telegram')
      || typeof secret !== 'string' || !secret || secret.includes('\0'))) reject();
  try { assertDistinctMigrationStaticIds(entries.map(([id]) => id)); } catch { reject(); }
}

function decodeCiphertext(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) reject();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length <= sodium.crypto_box_SEALBYTES || bytes.length > MAX_ENVELOPE_BYTES) reject();
  return bytes;
}

/** Explicit fingerprint pin is required until authenticated machine registration exists. */
export async function sealStaticMigration(input: {
  targetMachine: string;
  targetKeyVersion: number;
  targetPublicKey: Uint8Array;
  pinnedFingerprint: string;
  staticSecrets: Readonly<Record<string, string>>;
  now?: number;
}): Promise<string> {
  await sodium.ready;
  const now = input.now ?? Date.now();
  if (!validKey(input.targetPublicKey) || !equalHex(sha256(input.targetPublicKey), input.pinnedFingerprint)) reject();
  const metadata: SealedMetadata = { format: FORMAT, bundleId: randomUUID(), targetMachine: input.targetMachine,
    targetKeyVersion: input.targetKeyVersion, targetFingerprint: input.pinnedFingerprint,
    createdAt: now, expiresAt: now + MAX_LIFETIME_MS };
  validateMetadata(metadata, now);
  validateStaticSecrets(input.staticSecrets);
  const plaintext: SealedContents = { ...metadata, staticSecrets: { ...input.staticSecrets } };
  const ciphertext = sodium.crypto_box_seal(Buffer.from(JSON.stringify(plaintext), 'utf8'), input.targetPublicKey);
  const serialized = JSON.stringify({ ...metadata, ciphertext: Buffer.from(ciphertext).toString('base64') });
  if (Buffer.byteLength(serialized) > MAX_ENVELOPE_BYTES) reject();
  return serialized;
}

/** No real backend is wired here. Import is manual-untrusted and requires atomic batch+marker capability. */
export async function importSealedStaticMigration(input: {
  serialized: string;
  targetMachine: string;
  targetKeyVersion: number;
  targetPublicKey: Uint8Array;
  targetPrivateKey: Uint8Array;
  pinnedFingerprint: string;
  approval: SealedImportApproval;
  backend?: AtomicSealedStaticBackend;
  now?: number;
}): Promise<{ bundleId: string; envelopeSha256: string; staticCount: number; status: 'applied' | 'already-applied' }> {
  await sodium.ready;
  const now = input.now ?? Date.now();
  if (!input.backend || input.backend.atomicBatchAndMarker !== true
    || typeof input.backend.commitEmptyStaticBatch !== 'function'
    || input.approval?.mode !== 'manual-untrusted' || input.approval.sourceConfirmedOutOfBand !== true
    || !validKey(input.targetPublicKey) || !validKey(input.targetPrivateKey)
    || !equalHex(sha256(input.targetPublicKey), input.pinnedFingerprint)) reject();
  if (typeof input.serialized !== 'string' || Buffer.byteLength(input.serialized) > MAX_ENVELOPE_BYTES
    || !equalHex(sha256(input.serialized), input.approval.envelopeSha256)) reject();
  let envelope: SealedEnvelope;
  try { envelope = JSON.parse(input.serialized); } catch { reject(); }
  if (!envelope || typeof envelope !== 'object') reject();
  validateMetadata(envelope, now);
  if (envelope.targetMachine !== input.targetMachine || envelope.targetKeyVersion !== input.targetKeyVersion
    || !equalHex(envelope.targetFingerprint, input.pinnedFingerprint)) reject();
  let contents: SealedContents;
  try {
    const opened = sodium.crypto_box_seal_open(decodeCiphertext(envelope.ciphertext),
      input.targetPublicKey, input.targetPrivateKey);
    if (!opened) reject();
    contents = JSON.parse(Buffer.from(opened).toString('utf8'));
  } catch { reject(); }
  if (!contents || typeof contents !== 'object') reject();
  validateMetadata(contents, now);
  for (const key of ['format', 'bundleId', 'targetMachine', 'targetKeyVersion', 'targetFingerprint', 'createdAt', 'expiresAt'] as const) {
    if (contents[key] !== envelope[key]) reject();
  }
  validateStaticSecrets(contents.staticSecrets);
  // The backend's single transaction must reject occupied aliases, changed markers and partial state.
  const envelopeSha256 = sha256(input.serialized);
  let status: 'applied' | 'already-applied' | 'conflict';
  try {
    status = await input.backend.commitEmptyStaticBatch({ bundleId: contents.bundleId,
      envelopeSha256, staticSecrets: contents.staticSecrets });
  } catch { reject(); }
  if (status !== 'applied' && status !== 'already-applied') reject();
  return { bundleId: contents.bundleId, envelopeSha256, staticCount: Object.keys(contents.staticSecrets).length, status };
}
