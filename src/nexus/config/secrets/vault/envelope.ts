// HQ-VAULT V1 · encryption at rest (내부 문서 `HQ-CREDENTIAL-VAULT` §3.1)
//
// One envelope per static item: a fresh random DEK seals the value (AES-256-GCM), the KEK
// (mshq keychain) wraps the DEK (AES-256-GCM). `itemId` and `generation` are bound as AAD
// on both layers, so swapping envelopes between items or replaying an older generation
// fails authentication instead of returning a stale value. No plaintext reaches disk.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const VAULT_ENVELOPE_FORMAT = 'elanous-vault-envelope';
export const VAULT_ENVELOPE_VERSION = 1;
export const VAULT_KEK_BYTES = 32;

interface SealedPart { readonly iv: string; readonly tag: string; readonly ciphertext: string }

export interface VaultEnvelope {
  readonly format: typeof VAULT_ENVELOPE_FORMAT;
  readonly version: typeof VAULT_ENVELOPE_VERSION;
  readonly itemId: string;
  readonly generation: number;
  readonly wrappedDek: SealedPart;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function aad(itemId: string, generation: number, layer: 'dek' | 'value'): Buffer {
  return Buffer.from(`${VAULT_ENVELOPE_FORMAT}/v${VAULT_ENVELOPE_VERSION}\u0000${layer}\u0000${itemId}\u0000${generation}`, 'utf-8');
}

function seal(key: Buffer, plaintext: Buffer, additional: Buffer): SealedPart {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additional);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function open(key: Buffer, part: SealedPart, additional: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(part.iv, 'base64'));
  decipher.setAAD(additional);
  decipher.setAuthTag(Buffer.from(part.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(part.ciphertext, 'base64')), decipher.final()]);
}

function assertKek(kek: Buffer): void {
  if (kek.length !== VAULT_KEK_BYTES) throw new Error('VAULT_KEK_INVALID');
}

export function sealVaultValue(kek: Buffer, itemId: string, generation: number, value: string): VaultEnvelope {
  assertKek(kek);
  const dek = randomBytes(32);
  try {
    const wrappedDek = seal(kek, dek, aad(itemId, generation, 'dek'));
    const body = seal(dek, Buffer.from(value, 'utf-8'), aad(itemId, generation, 'value'));
    return { format: VAULT_ENVELOPE_FORMAT, version: VAULT_ENVELOPE_VERSION, itemId, generation, wrappedDek, ...body };
  } finally { dek.fill(0); }
}

/** `expected` comes from the metadata index, never from the envelope itself. */
export function openVaultValue(kek: Buffer, envelope: unknown, expected: { itemId: string; generation: number }): string {
  assertKek(kek);
  const env = parseVaultEnvelope(envelope);
  if (env.itemId !== expected.itemId) throw new Error('VAULT_ENVELOPE_ITEM_MISMATCH');
  if (env.generation !== expected.generation) throw new Error('VAULT_ENVELOPE_GENERATION_MISMATCH');
  let dek: Buffer | undefined;
  try {
    dek = open(kek, env.wrappedDek, aad(expected.itemId, expected.generation, 'dek'));
    return open(dek, env, aad(expected.itemId, expected.generation, 'value')).toString('utf-8');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('VAULT_')) throw error;
    throw new Error('VAULT_ENVELOPE_AUTH_FAILED');
  } finally { dek?.fill(0); }
}

function isPart(value: unknown): value is SealedPart {
  const part = value as Partial<SealedPart> | null;
  return !!part && typeof part === 'object' && typeof part.iv === 'string' && typeof part.tag === 'string' && typeof part.ciphertext === 'string';
}

export function parseVaultEnvelope(value: unknown): VaultEnvelope {
  const env = value as Partial<VaultEnvelope> | null;
  if (!env || typeof env !== 'object' || env.format !== VAULT_ENVELOPE_FORMAT || env.version !== VAULT_ENVELOPE_VERSION
    || typeof env.itemId !== 'string' || typeof env.generation !== 'number' || !Number.isInteger(env.generation)
    || !isPart(env.wrappedDek) || !isPart(env)) throw new Error('VAULT_ENVELOPE_INVALID');
  return env as VaultEnvelope;
}
