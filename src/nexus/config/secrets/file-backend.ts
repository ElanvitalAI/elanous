// NEXUS · FileBackend (Phase N-3.5 PR σ)
//
// Reads / writes `~/.elanous/secrets.json` (0o600). Implementation moved
// from src/nexus/config/secrets.ts so the registry can swap backends
// without touching caller code. The legacy module re-exports this
// backend's accessor functions to preserve backwards compatibility.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { acquireLockSync } from '../../../storage/file-lock.js';
import { SECRETS_VERSION, type SecretsFile } from '../types.js';
import { secretsPath } from '../paths.js';
import { assertSharedSecretId, isAppSecretId, type SecretBackend, type SecretBackendAvailability, type SyncReadableBackend } from './types.js';
import { appSecretId, appSecretIdForExistingApp, appSecretLockKeyForLegacyId, beginAppSecretEvent, createAppSecretEvent, finishAppSecretEvent, hasAppSecretEventForId, hasCommittedAppSecretRevoke, recoverAppSecretEvents, syncAppSecretLedgerDurability, withAppSecretLock, withAppSecretLockSync } from './app-secret-ledger.js';

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

export interface AppSecretMutationTestHooks {
  beforeSecretsDirectorySync?: () => void;
  beforeLedgerDirectorySync?: () => void;
  beforeLedgerRollback?: () => void;
  beforeAbsentStateDurabilitySync?: () => void;
  afterRevokeIntent?: () => void;
  afterRevokeTargetsListed?: () => Promise<void>;
}

export interface AppSecretRevokeResult {
  revoked: number;
  alreadyAbsent: boolean;
}

function writeSecretsFile(s: SecretsFile, beforeDirectorySync?: () => void): void {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const backupTmp = `${path}.${randomUUID()}.bak.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    const tmpFd = openSync(tmp, 'r');
    try { fsyncSync(tmpFd); }
    finally { closeSync(tmpFd); }
    if (existsSync(path)) {
      let backupContents: string | undefined;
      let previous: SecretsFile | undefined;
      try {
        previous = readSecretsFile();
      } catch {
        if (existsSync(join(dirname(path), 'app-secret-ledger.json'))) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
      }
      if (previous) {
        const restorable = Object.fromEntries(Object.entries(previous.secrets).filter(([id]) => !isAppSecretId(id) || !hasAppSecretEventForId(id)));
        backupContents = JSON.stringify({ ...previous, secrets: restorable }, null, 2);
      }
      if (backupContents === undefined) copyFileSync(path, backupTmp);
      else writeFileSync(backupTmp, backupContents, { mode: 0o600, flag: 'wx' });
      chmodSync(backupTmp, 0o600);
      const backupFd = openSync(backupTmp, 'r');
      try { fsyncSync(backupFd); }
      finally { closeSync(backupFd); }
      renameSync(backupTmp, `${path}.bak`);
    }
    renameSync(tmp, path);
    beforeDirectorySync?.();
    const dirFd = openSync(dirname(path), 'r');
    try { fsyncSync(dirFd); }
    finally { closeSync(dirFd); }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
    if (existsSync(backupTmp)) unlinkSync(backupTmp);
  }
}

function syncSecretsFileDurability(): void {
  const path = secretsPath();
  if (existsSync(path)) {
    const fileFd = openSync(path, 'r');
    try { fsyncSync(fileFd); }
    finally { closeSync(fileFd); }
  }
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); }
  finally { closeSync(dirFd); }
}

function modifySecretsFile(change: (s: SecretsFile) => boolean, beforeDirectorySync?: () => void): boolean {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLockSync(`${path}.lock`);
  try {
    const s = readSecretsFile();
    if (!change(s)) return false;
    writeSecretsFile(s, beforeDirectorySync);
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
    assertSharedSecretId(id);
    modifySecretsFile(s => { s.secrets[id] = value; return true; });
  },
  async delete(id) {
    const remove = (): boolean => modifySecretsFile(s => {
      if (!Object.hasOwn(s.secrets, id)) return false;
      delete s.secrets[id];
      return true;
    });
    if (!isAppSecretId(id)) return remove();
    return withAppSecretLock(appSecretLockKeyForLegacyId(id), async (assertHeld) => {
      if (hasAppSecretEventForId(id)) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
      assertHeld();
      return remove();
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
    let existingAppSecrets: Record<string, string>;
    try {
      existingAppSecrets = Object.fromEntries(Object.entries(readSecretsFile().secrets).filter(([id]) => isAppSecretId(id)));
    } catch (error) {
      // Preserve the legacy explicit-recovery path when no app ledger exists.
      // If a ledger exists, the unreadable file may contain live app values.
      if (existsSync(join(dirname(path), 'app-secret-ledger.json'))) throw error;
      existingAppSecrets = {};
    }
    const nextAppSecrets = Object.fromEntries(Object.entries(s.secrets).filter(([id]) => isAppSecretId(id)));
    if (JSON.stringify(existingAppSecrets) !== JSON.stringify(nextAppSecrets)) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
    writeSecretsFile(s);
  } finally {
    release();
  }
}

/** Sync compatibility path for pre-ledger app IDs. Managed IDs are protected by the journal ownership check. */
export function deleteLegacyAppSecretValueSync(id: string): boolean {
  if (!isAppSecretId(id)) throw new Error('ELANOUS_APP_SECRET_ID_REQUIRED');
  return withAppSecretLockSync(appSecretLockKeyForLegacyId(id), () => {
    const path = secretsPath();
    mkdirSync(dirname(path), { recursive: true });
    const release = acquireLockSync(`${path}.lock`);
    try {
      if (hasAppSecretEventForId(id)) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
      const secrets = readSecretsFile();
      if (!Object.hasOwn(secrets.secrets, id)) return false;
      delete secrets.secrets[id];
      writeSecretsFile(secrets);
      return true;
    } finally {
      release();
    }
  });
}

/** Atomically merge imported values under the same lock used by set/rm. */
export function importSecretsFileRaw(
  secrets: Readonly<Record<string, string>>,
  overwrite: boolean,
  expectedConflicts?: readonly string[],
): { imported: boolean; conflicts: string[]; changedSinceConfirmation: boolean } {
  if (Object.keys(secrets).some(isAppSecretId)) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLockSync(`${path}.lock`);
  try {
    const file = readSecretsFile();
    const conflicts = Object.keys(secrets).filter((id) => Object.hasOwn(file.secrets, id)).sort();
    if (expectedConflicts && (conflicts.length !== expectedConflicts.length
      || conflicts.some((id, index) => id !== [...expectedConflicts].sort()[index]))) {
      return { imported: false, conflicts, changedSinceConfirmation: true };
    }
    if (conflicts.length && !overwrite) return { imported: false, conflicts, changedSinceConfirmation: false };
    Object.assign(file.secrets, secrets);
    writeSecretsFile(file);
    return { imported: true, conflicts, changedSinceConfirmation: false };
  } finally {
    release();
  }
}

/** App-scoped mutation API. It owns the lock and durable journal so direct callers cannot bypass them. */
export async function setAppSecretValue(id: string, value: string, testHooks: AppSecretMutationTestHooks = {}): Promise<void> {
  const [namespace, app, name, ...extra] = id.split('/');
  if (namespace !== 'app' || !app || !name || extra.length || appSecretId(app, name) !== id) throw new Error('ELANOUS_APP_SECRET_ID_REQUIRED');
  await withAppSecretLock(app!, async (assertHeld) => {
    await recoverAppSecretEvents(app!, async (secretName, _backend, event) => {
      syncSecretsFileDurability();
      return syncReadable.getSync(event.secretId ?? appSecretId(app!, secretName)) !== undefined;
    }, assertHeld, name);
    assertHeld();
    if (syncReadable.getSync(id) !== undefined) throw new Error('app secret already exists');
    const intent = beginAppSecretEvent(createAppSecretEvent('issued', app!, name!, 'file'));
    assertHeld();
    try {
      modifySecretsFile((secrets) => { secrets.secrets[id] = value; return true; }, testHooks.beforeSecretsDirectorySync);
      assertHeld();
      finishAppSecretEvent(intent.id, 'committed', undefined, testHooks.beforeLedgerDirectorySync, testHooks.beforeLedgerRollback);
    } catch (error) {
      throw error;
    }
  });
}

export async function deleteAppSecretValue(id: string, testHooks: AppSecretMutationTestHooks = {}): Promise<boolean> {
  if (!id.startsWith('app/') || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('ELANOUS_APP_SECRET_ID_REQUIRED');
  const app = appSecretLockKeyForLegacyId(id);
  const canonical = id.match(/^app\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/([A-Z][A-Z0-9_]{0,63})$/);
  const name = canonical?.[2] ?? `LEGACY_${createHash('sha256').update(id).digest('hex').slice(0, 32).toUpperCase()}`;
  return withAppSecretLock(app!, async (assertHeld) => {
    await recoverAppSecretEvents(app!, async (secretName, _backend, event) => {
      syncSecretsFileDurability();
      return syncReadable.getSync(event.secretId ?? appSecretIdForExistingApp(app!, secretName)) !== undefined;
    }, assertHeld, name);
    assertHeld();
    if (syncReadable.getSync(id) === undefined) {
      if (hasCommittedAppSecretRevoke(app!, name!)) {
        testHooks.beforeAbsentStateDurabilitySync?.();
        syncSecretsFileDurability();
        syncAppSecretLedgerDurability();
      }
      return false;
    }
    const intent = beginAppSecretEvent(createAppSecretEvent('revoked', app, name, 'file', id));
    assertHeld();
    testHooks.afterRevokeIntent?.();
    const removed = modifySecretsFile((secrets) => {
      if (!Object.hasOwn(secrets.secrets, id)) return false;
      delete secrets.secrets[id];
      return true;
    }, testHooks.beforeSecretsDirectorySync);
    assertHeld();
    finishAppSecretEvent(intent.id, removed ? 'committed' : 'aborted', undefined, testHooks.beforeLedgerDirectorySync, testHooks.beforeLedgerRollback);
    return removed;
  });
}

/** Revoke one or all app secrets while holding a single app lock across recovery, listing, and deletion. */
export async function revokeAppSecretValues(app: string, name?: string, testHooks: AppSecretMutationTestHooks = {}): Promise<AppSecretRevokeResult> {
  appSecretIdForExistingApp(app, 'LOCK');
  return withAppSecretLock(app, async (assertHeld) => {
    const recovered = await recoverAppSecretEvents(app, async (secretName, _backend, event) => {
      syncSecretsFileDurability();
      return syncReadable.getSync(event.secretId ?? appSecretIdForExistingApp(app, secretName)) !== undefined;
    }, assertHeld, name);
    const recoveredCount = recovered.filter((event) => event.action === 'revoked' && event.state === 'committed'
      && (name === undefined || event.name === name)).length;
    const prefix = `app/${app}/`;
    const targets = name === undefined
      ? syncReadable.listSync().filter((id) => id === `app/${app}` || id.startsWith(prefix))
      : [appSecretIdForExistingApp(app, name)].filter((id) => syncReadable.getSync(id) !== undefined);
    await testHooks.afterRevokeTargetsListed?.();
    let deleted = 0;
    for (const id of targets) {
      assertHeld();
      const secretName = /^[A-Z][A-Z0-9_]{0,63}$/.test(id.slice(prefix.length)) ? id.slice(prefix.length)
        : `LEGACY_${createHash('sha256').update(id).digest('hex').slice(0, 32).toUpperCase()}`;
      const intent = beginAppSecretEvent(createAppSecretEvent('revoked', app, secretName, 'file', id));
      assertHeld();
      testHooks.afterRevokeIntent?.();
      const removed = modifySecretsFile((secrets) => {
        if (!Object.hasOwn(secrets.secrets, id)) return false;
        delete secrets.secrets[id];
        return true;
      }, testHooks.beforeSecretsDirectorySync);
      assertHeld();
      finishAppSecretEvent(intent.id, removed ? 'committed' : 'aborted', undefined, testHooks.beforeLedgerDirectorySync, testHooks.beforeLedgerRollback);
      if (removed) deleted += 1;
    }
    if (targets.length === 0 && hasCommittedAppSecretRevoke(app, name)) {
      syncSecretsFileDurability();
      syncAppSecretLedgerDurability();
    }
    const revoked = recoveredCount + deleted;
    return { revoked, alreadyAbsent: targets.length === 0 && revoked === 0 };
  });
}
