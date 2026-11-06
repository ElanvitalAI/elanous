import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import type { SecretsFile } from '../types.js';

function scrypt(passphrase: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, length, options, (error, key) => error ? reject(error) : resolve(key));
  });
}
const FORMAT = 'elanous-secret-bundle';
const VERSION = 1;
const SCRYPT = { N: 32_768, r: 8, p: 1 } as const;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

interface EncryptedSecretBundle {
  format: typeof FORMAT;
  version: typeof VERSION;
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
}

function decodeBase64(value: unknown, bytes?: number): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid encrypted secret bundle');
  }
  const decoded = Buffer.from(value, 'base64');
  if (bytes !== undefined && decoded.length !== bytes) throw new Error('invalid encrypted secret bundle');
  return decoded;
}

function validateSecrets(value: unknown): SecretsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid secret bundle contents');
  const candidate = value as Partial<SecretsFile>;
  if (candidate.version !== 1 || !candidate.secrets || typeof candidate.secrets !== 'object' || Array.isArray(candidate.secrets)) {
    throw new Error('invalid secret bundle contents');
  }
  const entries = Object.entries(candidate.secrets);
  if (entries.length > 10_000 || entries.some(([id, secret]) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || typeof secret !== 'string' || !secret || secret.includes('\0'))) {
    throw new Error('invalid secret bundle contents');
  }
  return { version: 1, secrets: Object.fromEntries(entries) };
}

export async function encryptSecretBundle(secrets: SecretsFile, passphrase: string): Promise<string> {
  if (passphrase.length < 12 || passphrase.includes('\0')) throw new Error('passphrase must be at least 12 characters');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, 32, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }) as Buffer;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${FORMAT}:${VERSION}`));
  const plaintext = Buffer.from(JSON.stringify(validateSecrets(secrets)), 'utf8');
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const bundle: EncryptedSecretBundle = {
      format: FORMAT, version: VERSION,
      kdf: { name: 'scrypt', salt: salt.toString('base64'), ...SCRYPT },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
    };
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BUNDLE_BYTES) throw new Error('secret bundle exceeds the supported size');
    return serialized;
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

export async function decryptSecretBundle(serialized: string, passphrase: string): Promise<SecretsFile> {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BUNDLE_BYTES) throw new Error('invalid encrypted secret bundle');
  if (passphrase.length < 12 || passphrase.includes('\0')) throw new Error('invalid encrypted secret bundle or passphrase');
  let bundle: EncryptedSecretBundle;
  try { bundle = JSON.parse(serialized) as EncryptedSecretBundle; }
  catch { throw new Error('invalid encrypted secret bundle'); }
  if (!bundle || bundle.format !== FORMAT || bundle.version !== VERSION || bundle.kdf?.name !== 'scrypt'
    || bundle.kdf.N !== SCRYPT.N || bundle.kdf.r !== SCRYPT.r || bundle.kdf.p !== SCRYPT.p
    || bundle.cipher?.name !== 'aes-256-gcm') throw new Error('unsupported encrypted secret bundle');
  const salt = decodeBase64(bundle.kdf.salt, 16);
  const iv = decodeBase64(bundle.cipher.iv, 12);
  const tag = decodeBase64(bundle.cipher.tag, 16);
  const ciphertext = decodeBase64(bundle.cipher.ciphertext);
  const key = await scrypt(passphrase, salt, 32, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }) as Buffer;
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`${FORMAT}:${VERSION}`));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validateSecrets(JSON.parse(plaintext.toString('utf8')));
  } catch {
    throw new Error('encrypted secret bundle could not be opened');
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
