// HQ-VAULT V1 · vault item metadata (내부 문서 `HQ-CREDENTIAL-VAULT` §3.1 · C2)
//
// `<vaultDir>/index.json` (0600 · dir 0700) holds metadata only. Values never enter this
// file: the serializer copies a closed list of fields, so an unknown key (or a value
// smuggled in by a caller) is dropped before it can reach disk.
//
// Lease records (V2 OAuth mirror lease · V3 static lease) hang off `itemId` from their
// own stores; this index is the item's identity and policy, not its lease state.

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireLockSync } from '../../../../storage/file-lock.js';

export const VAULT_META_VERSION = 1;

export type VaultItemKind = 'static' | 'oauth';

export interface VaultItemMeta {
  /** typed slot id (`cred:<id>.<field>`) or OAuth reference (`oauth:<provider>:<account>`). */
  readonly id: string;
  /** static = value sealed in a vault envelope · oauth = reference only (refresh stays with the owner store). */
  readonly kind: VaultItemKind;
  readonly provider: string;
  readonly ownerHost: string;
  /** Lease allow-list. Empty = default deny. */
  readonly allowedHosts: readonly string[];
  readonly expiresAt?: string;
  readonly rotateEveryDays?: number;
  readonly lastUsedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** +1 on every stored value; bound into the envelope AAD so a rolled-back envelope is refused. 0 = no value yet. */
  readonly generation: number;
  /** Last time the stored value changed (static only). */
  readonly rotatedAt?: string;
}

export interface VaultMetaFile {
  readonly version: typeof VAULT_META_VERSION;
  readonly items: readonly VaultItemMeta[];
}

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function assertVaultItemId(id: string): void {
  if (!ITEM_ID.test(id)) throw new Error('VAULT_ITEM_ID_INVALID');
}

export function normalizeVaultHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.local$/, '');
  if (!HOST.test(host)) throw new Error('VAULT_HOST_INVALID');
  return host;
}

function isoOrUndefined(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`VAULT_META_${field}_INVALID`);
  return new Date(Date.parse(value)).toISOString();
}

/** Closed-field copy: the only path by which metadata reaches disk. */
export function sanitizeVaultItemMeta(input: unknown): VaultItemMeta {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('VAULT_META_INVALID');
  const raw = input as Record<string, unknown>;
  const id = String(raw.id ?? '');
  assertVaultItemId(id);
  const kind = raw.kind;
  if (kind !== 'static' && kind !== 'oauth') throw new Error('VAULT_META_KIND_INVALID');
  const provider = String(raw.provider ?? '');
  if (!PROVIDER.test(provider)) throw new Error('VAULT_META_PROVIDER_INVALID');
  const ownerHost = normalizeVaultHost(String(raw.ownerHost ?? ''));
  if (!Array.isArray(raw.allowedHosts)) throw new Error('VAULT_META_ALLOWED_HOSTS_INVALID');
  const allowedHosts = [...new Set(raw.allowedHosts.map((host) => normalizeVaultHost(String(host))))].sort();
  const rotateEveryDays = raw.rotateEveryDays;
  if (rotateEveryDays !== undefined && (typeof rotateEveryDays !== 'number' || !Number.isInteger(rotateEveryDays) || rotateEveryDays < 1 || rotateEveryDays > 3650))
    throw new Error('VAULT_META_ROTATE_INVALID');
  const generation = raw.generation ?? 0;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) throw new Error('VAULT_META_GENERATION_INVALID');
  if (kind === 'oauth' && generation !== 0) throw new Error('VAULT_META_OAUTH_HAS_NO_VALUE');
  const createdAt = isoOrUndefined(raw.createdAt, 'CREATED_AT');
  const updatedAt = isoOrUndefined(raw.updatedAt ?? raw.createdAt, 'UPDATED_AT');
  if (!createdAt || !updatedAt) throw new Error('VAULT_META_CREATED_AT_INVALID');
  const expiresAt = isoOrUndefined(raw.expiresAt, 'EXPIRES_AT');
  const lastUsedAt = isoOrUndefined(raw.lastUsedAt, 'LAST_USED_AT');
  const rotatedAt = isoOrUndefined(raw.rotatedAt, 'ROTATED_AT');
  return {
    id, kind, provider, ownerHost, allowedHosts,
    ...(expiresAt ? { expiresAt } : {}),
    ...(rotateEveryDays !== undefined ? { rotateEveryDays } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    createdAt, updatedAt, generation,
    ...(rotatedAt ? { rotatedAt } : {}),
  };
}

export function vaultIndexPath(vaultDir: string): string {
  return join(vaultDir, 'index.json');
}

export function readVaultMeta(vaultDir: string): VaultMetaFile {
  const path = vaultIndexPath(vaultDir);
  if (!existsSync(path)) return { version: VAULT_META_VERSION, items: [] };
  let parsed: Partial<VaultMetaFile>;
  try { parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<VaultMetaFile>; }
  catch (error) { throw new Error('VAULT_META_UNREADABLE', { cause: error }); }
  if (parsed.version !== VAULT_META_VERSION || !Array.isArray(parsed.items)) throw new Error('VAULT_META_VERSION_INVALID');
  const items = parsed.items.map(sanitizeVaultItemMeta);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('VAULT_META_DUPLICATE_ID');
  return { version: VAULT_META_VERSION, items };
}

export function ensureVaultDir(vaultDir: string): void {
  mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  chmodSync(vaultDir, 0o700);
}

/** Atomic 0600 write (temp → fsync → rename → dir fsync). */
export function writeFileAtomic0600(path: string, dir: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function writeVaultMeta(vaultDir: string, items: readonly VaultItemMeta[]): void {
  ensureVaultDir(vaultDir);
  const sorted = items.map(sanitizeVaultItemMeta).sort((a, b) => a.id.localeCompare(b.id));
  writeFileAtomic0600(vaultIndexPath(vaultDir), vaultDir, `${JSON.stringify({ version: VAULT_META_VERSION, items: sorted }, null, 2)}\n`);
}

/** Read-modify-write under the index lock. `change` returns the next item (or null to delete). */
export function modifyVaultMeta<T>(
  vaultDir: string,
  id: string,
  change: (current: VaultItemMeta | undefined) => { next: VaultItemMeta | null; result: T },
): T {
  assertVaultItemId(id);
  ensureVaultDir(vaultDir);
  const release = acquireLockSync(`${vaultIndexPath(vaultDir)}.lock`);
  try {
    const items = [...readVaultMeta(vaultDir).items];
    const index = items.findIndex((item) => item.id === id);
    const { next, result } = change(index >= 0 ? items[index] : undefined);
    if (next === null) {
      if (index >= 0) { items.splice(index, 1); writeVaultMeta(vaultDir, items); }
      return result;
    }
    const clean = sanitizeVaultItemMeta(next);
    if (clean.id !== id) throw new Error('VAULT_META_ID_MISMATCH');
    if (index >= 0) items[index] = clean; else items.push(clean);
    writeVaultMeta(vaultDir, items);
    return result;
  } finally { release(); }
}
