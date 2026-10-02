// NEXUS · FileBackend (Phase N-3.5 PR σ)
//
// Reads / writes `~/.elanous/secrets.json` (0o600). Implementation moved
// from src/nexus/config/secrets.ts so the registry can swap backends
// without touching caller code. The legacy module re-exports this
// backend's accessor functions to preserve backwards compatibility.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { acquireLockSync } from '../../../storage/file-lock.js';
import { SECRETS_VERSION, type SecretsFile } from '../types.js';
import { secretsPath } from '../paths.js';
import type { SecretBackend, SecretBackendAvailability, SyncReadableBackend } from './types.js';

function defaultSecrets(): SecretsFile {
  return { version: SECRETS_VERSION, secrets: {} };
}

function readSecretsFile(): SecretsFile {
  const path = secretsPath();
  if (!existsSync(path)) return defaultSecrets();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SecretsFile>;
    if (parsed?.version !== SECRETS_VERSION || !parsed.secrets || typeof parsed.secrets !== 'object'
      || Array.isArray(parsed.secrets) || Object.values(parsed.secrets).some(value => typeof value !== 'string')) {
      throw new Error('invalid secrets file version or contents');
    }
    return { version: SECRETS_VERSION, secrets: parsed.secrets };
  } catch (error) {
    throw new Error(`cannot read secrets file at ${path}`, { cause: error });
  }
}

function writeSecretsFile(s: SecretsFile): void {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const backupTmp = `${path}.${randomUUID()}.bak.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600, flag: 'wx' });
    if (existsSync(path)) {
      copyFileSync(path, backupTmp);
      chmodSync(backupTmp, 0o600);
      renameSync(backupTmp, `${path}.bak`);
    }
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
    if (existsSync(backupTmp)) unlinkSync(backupTmp);
  }
}

function modifySecretsFile(change: (s: SecretsFile) => boolean): boolean {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLockSync(`${path}.lock`);
  try {
    const s = readSecretsFile();
    if (!change(s)) return false;
    writeSecretsFile(s);
    return true;
  } finally {
    release();
  }
}

const syncReadable: SyncReadableBackend = {
  getSync(id) { return readSecretsFile().secrets[id]; },
  listSync() { return Object.keys(readSecretsFile().secrets); },
};

export const fileBackend: SecretBackend = {
  id: 'file',
  async get(id) { return syncReadable.getSync(id); },
  async set(id, value) {
    modifySecretsFile(s => { s.secrets[id] = value; return true; });
  },
  async delete(id) {
    return modifySecretsFile(s => {
      if (!Object.hasOwn(s.secrets, id)) return false;
      delete s.secrets[id];
      return true;
    });
  },
  async list() { return syncReadable.listSync(); },
  async isAvailable(): Promise<SecretBackendAvailability> {
    // FileBackend is always available — the file system is part of the
    // OS contract. Returns ok=true even when the file doesn't yet exist
    // (a write will create it).
    return { ok: true };
  },
  syncReadable,
};

/** Convenience for callers that want the raw SecretsFile object (the
 *  pre-PR σ patten). Equivalent to fileBackend + manual file read. */
export function readSecretsFileRaw(): SecretsFile {
  return readSecretsFile();
}

export function writeSecretsFileRaw(s: SecretsFile): void {
  if (s.version !== SECRETS_VERSION || !s.secrets || typeof s.secrets !== 'object'
    || Array.isArray(s.secrets) || Object.values(s.secrets).some(value => typeof value !== 'string')) {
    throw new Error('invalid secrets file version or contents');
  }
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLockSync(`${path}.lock`);
  try {
    writeSecretsFile(s);
  } finally {
    release();
  }
}
