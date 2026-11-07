import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { SecretBackendId } from './types.js';
import { acquireLockSync } from '../../../storage/file-lock.js';
import { elanousConfigDir } from '../paths.js';

export type AppSecretEvent = {
  readonly id: string;
  readonly action: 'issued' | 'revoked';
  readonly app: string;
  readonly name: string;
  readonly secretId?: string;
  readonly backend: SecretBackendId;
  readonly at: string;
  readonly state: 'pending' | 'committed' | 'aborted';
};

type LedgerFile = { version: 1; events: AppSecretEvent[] };

const RESERVED_APP_SLUGS = new Set(['www', 'docs', 'api', 'admin', 'relay', 'mail']);

function assertSafeAppSlug(app: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(app)) throw new Error('invalid app slug');
}

export function appSecretIdForExistingApp(app: string, name: string): string {
  assertSafeAppSlug(app);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new Error('invalid app secret name');
  return `app/${app}/${name}`;
}

export function appSecretLockKeyForLegacyId(id: string): string {
  if (!id.startsWith('app/')) throw new Error('ELANOUS_APP_SECRET_ID_REQUIRED');
  const candidate = id.split('/')[1] ?? '';
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate) ? candidate : 'legacy';
}

export function hasCommittedAppSecretRevoke(app: string, name?: string): boolean {
  return readLedger(ledgerPath()).events.some((event) => event.app === app && (name === undefined || event.name === name)
    && event.action === 'revoked' && event.state === 'committed');
}

export function hasAppSecretEventForId(id: string): boolean {
  return readLedger(ledgerPath()).events.some((event) => {
    if (event.secretId === id) return true;
    try { return appSecretIdForExistingApp(event.app, event.name) === id; }
    catch { return false; }
  });
}

/** Re-establish durability before a retry accepts a visible committed ledger entry. */
export function syncAppSecretLedgerDurability(): void {
  const path = ledgerPath();
  if (existsSync(path)) {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); }
  finally { closeSync(dirFd); }
}

/** App secrets have their own namespace, separate from shared `cred:*` slots. */
export function appSecretId(app: string, name: string): string {
  assertSafeAppSlug(app);
  if (app.includes('--') || app.startsWith('xn--') || /-pr\d+$/.test(app) || RESERVED_APP_SLUGS.has(app)) throw new Error('invalid app slug');
  return appSecretIdForExistingApp(app, name);
}

function ledgerPath(): string {
  const dir = elanousConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'app-secret-ledger.json');
}

function readLedger(path: string): LedgerFile {
  if (!existsSync(path)) return { version: 1, events: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LedgerFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.events)) throw new Error('invalid app secret ledger');
  return { version: 1, events: parsed.events };
}

function writeLedger(
  path: string,
  ledger: LedgerFile,
  beforeRename?: (tempPath: string, ledgerPath: string) => void,
  beforeDirectorySync?: (directory: string) => void,
  beforeRollback?: () => void,
): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const rollback = `${path}.${randomUUID()}.rollback.tmp`;
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  try {
    writeFileSync(temp, JSON.stringify(ledger, null, 2), { mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); }
    finally { closeSync(fd); }
    beforeRename?.(temp, path);
    renameSync(temp, path);
    try {
      beforeDirectorySync?.(dirname(path));
      const dirFd = openSync(dirname(path), 'r');
      try { fsyncSync(dirFd); }
      finally { closeSync(dirFd); }
    } catch (error) {
      // A renamed state is not a durable commit until the directory is synced.
      // Restore the last durable bytes so recovery still sees the pending intent.
      beforeRollback?.();
      if (previous === undefined) unlinkSync(path);
      else {
        writeFileSync(rollback, previous, { mode: 0o600, flag: 'wx' });
        const rollbackFd = openSync(rollback, 'r');
        try { fsyncSync(rollbackFd); }
        finally { closeSync(rollbackFd); }
        renameSync(rollback, path);
      }
      const restoreDirFd = openSync(dirname(path), 'r');
      try { fsyncSync(restoreDirFd); }
      finally { closeSync(restoreDirFd); }
      throw error;
    }
  } finally {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* cleanup only */ }
    try { if (existsSync(rollback)) unlinkSync(rollback); } catch { /* cleanup only */ }
  }
}

/** Atomically add a value-free intent before changing the secret backend. */
export function beginAppSecretEvent(event: Omit<AppSecretEvent, 'id' | 'state'>): AppSecretEvent {
  const path = ledgerPath();
  const release = acquireLockSync(`${path}.lock`);
  try {
    const ledger = readLedger(path);
    const complete: AppSecretEvent = { ...event, id: randomUUID(), state: 'pending' };
    ledger.events.push(complete);
    writeLedger(path, ledger);
    return complete;
  } finally { release(); }
}

/** Update a journal entry atomically. A pending entry remains recoverable if this write fails. */
export function finishAppSecretEvent(
  id: string,
  state: Exclude<AppSecretEvent['state'], 'pending'>,
  beforeRename?: (tempPath: string, ledgerPath: string) => void,
  beforeDirectorySync?: (directory: string) => void,
  beforeRollback?: () => void,
): void {
  const path = ledgerPath();
  const release = acquireLockSync(`${path}.lock`);
  try {
    const ledger = readLedger(path);
    const index = ledger.events.findIndex((event) => event.id === id);
    if (index < 0) throw new Error('app secret journal entry not found');
    ledger.events[index] = { ...ledger.events[index]!, state };
    writeLedger(path, ledger, beforeRename, beforeDirectorySync, beforeRollback);
  } finally { release(); }
}

/** Resolve interrupted app operations from the durable intent and current backend state. */
export async function recoverAppSecretEvents(
  app: string,
  hasSecret: (name: string, backend: SecretBackendId, event: AppSecretEvent) => Promise<boolean>,
  assertHeld: () => void = () => {},
  onlyName?: string,
): Promise<AppSecretEvent[]> {
  const path = ledgerPath();
  const pending = readLedger(path).events.filter((event) => event.app === app && event.state === 'pending'
    && (onlyName === undefined || event.name === onlyName));
  const recovered: AppSecretEvent[] = [];
  for (const event of pending) {
    assertHeld();
    // Old/foreign remote pending entries cannot be attributed to a specific
    // completed request. Never infer completion from a matching value alone.
    if (event.backend !== 'file') throw new Error(`app secret recovery is indeterminate for backend ${event.backend}`);
    const exists = await hasSecret(event.name, event.backend, event);
    assertHeld();
    const committed = event.action === 'issued' ? exists : !exists;
    const state = committed ? 'committed' : 'aborted';
    finishAppSecretEvent(event.id, state);
    recovered.push({ ...event, state });
  }
  return recovered;
}

export function createAppSecretEvent(action: AppSecretEvent['action'], app: string, name: string, backend: SecretBackendId, secretId?: string): Omit<AppSecretEvent, 'id' | 'state'> {
  return { action, app, name, backend, at: new Date().toISOString(), ...(secretId === undefined ? {} : { secretId }) };
}

/** Serialize app-scoped value changes with their journal events across CLI processes. */
export async function withAppSecretLock<T>(app: string, operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
  assertSafeAppSlug(app);
  const dir = elanousConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, `app-secret-${app}.lock.sqlite`);
  const db = new Database(lockPath, { create: true, strict: true });
  try {
    chmodSync(lockPath, 0o600);
    db.exec('PRAGMA busy_timeout = 0');
    const deadline = Date.now() + 120_000;
    while (true) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const assertHeld = (): void => {
      if (!db.inTransaction) throw new Error('app secret lock was lost');
    };
    try { return await operation(assertHeld); }
    finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}

/** Synchronous compatibility lock. It fails fast on contention instead of blocking an async holder on this event loop. */
export function withAppSecretLockSync<T>(app: string, operation: (assertHeld: () => void) => T): T {
  assertSafeAppSlug(app);
  const dir = elanousConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, `app-secret-${app}.lock.sqlite`);
  const db = new Database(lockPath, { create: true, strict: true });
  try {
    chmodSync(lockPath, 0o600);
    db.exec('PRAGMA busy_timeout = 0');
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_BUSY') throw new Error('ELANOUS_APP_SECRET_LOCK_BUSY');
      throw error;
    }
    const assertHeld = (): void => {
      if (!db.inTransaction) throw new Error('app secret lock was lost');
    };
    try { return operation(assertHeld); }
    finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}
