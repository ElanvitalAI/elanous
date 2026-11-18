// HQ-VAULT V1 · `eln secret inventory` collector (내부 문서 `HQ-CREDENTIAL-VAULT` §7 C1)
//
// Read only. Vault items come from the metadata index (values never in it); envelope
// presence and every external location are observed with lstat/readdir only — the fs
// seam below has no read/open method, so contents cannot be opened by construction.
// Symlinks are reported, never followed.

import { join } from 'node:path';
import type { VaultItemKind, VaultItemMeta } from './meta.js';

export interface InventoryStat {
  readonly mode: number;
  readonly uid: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Deliberately stat-only: no readFile/open/createReadStream. */
export interface InventoryFs {
  lstat(path: string): InventoryStat | undefined;
  readdir(path: string): readonly string[];
}

export type InventoryFlag =
  | 'plaintext-file' | 'world-readable' | 'group-readable' | 'not-owned-by-user' | 'symlink' | 'duplicate'
  | 'envelope-missing' | 'expired' | 'expiring' | 'rotation-due';

export interface InventoryVaultRow {
  readonly source: 'vault';
  readonly id: string;
  readonly kind: VaultItemKind;
  readonly provider: string;
  readonly ownerHost: string;
  readonly allowedHosts: readonly string[];
  readonly expiresAt?: string;
  readonly rotateEveryDays?: number;
  readonly lastUsedAt?: string;
  readonly createdAt: string;
  readonly generation: number;
  /** sealed = envelope present · reference = OAuth (no envelope by design) · empty = metadata only · missing = generation>0 but no envelope. */
  readonly presence: 'sealed' | 'reference' | 'empty' | 'missing';
  readonly mode?: string;
  readonly flags: readonly InventoryFlag[];
}

export interface InventoryExternalRow {
  readonly source: 'external';
  /** `~`-relative display path. */
  readonly path: string;
  readonly location: string;
  readonly kind: VaultItemKind;
  readonly provider: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly mode: string;
  readonly uid: number;
  readonly flags: readonly InventoryFlag[];
}

export interface SecretInventory {
  readonly version: 1;
  readonly generatedAt: string;
  readonly host: string;
  readonly items: readonly InventoryVaultRow[];
  readonly external: readonly InventoryExternalRow[];
  readonly summary: { readonly items: number; readonly external: number; readonly risky: number; readonly flags: Readonly<Record<string, number>> };
}

export interface InventoryInput {
  readonly home: string;
  readonly configDir: string;
  readonly vaultDir: string;
  readonly items: readonly VaultItemMeta[];
  readonly envelopePath: (id: string) => string;
  readonly fs: InventoryFs;
  readonly now: Date;
  readonly uid: number;
  readonly host: string;
  /** Warn window for `expiring` (default 7 days). */
  readonly expiringWithinMs?: number;
}

interface KnownLocation { readonly location: string; readonly path: string; readonly kind: VaultItemKind; readonly provider: string }

const DAY_MS = 86_400_000;
const API_KEY_CACHE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})_api_key$/;

/** Known credential locations from the design doc (§3.6 pattern list), expanded with readdir only. */
export function knownCredentialLocations(home: string, configDir: string, fs: InventoryFs): KnownLocation[] {
  const out: KnownLocation[] = [];
  const add = (location: string, path: string, kind: VaultItemKind, provider: string) => out.push({ location, path, kind, provider });
  for (const name of safeReaddir(fs, join(home, '.cache'))) {
    const match = API_KEY_CACHE.exec(name);
    if (match) add('cache-api-key', join(home, '.cache', name), 'static', match[1]!.toLowerCase());
  }
  for (const name of safeReaddir(fs, home)) {
    if (name === '.codex' || name.startsWith('.codex-')) add('codex-auth', join(home, name, 'auth.json'), 'oauth', 'codex');
  }
  add('elanous-file-backend', join(configDir, 'secrets.json'), 'static', 'elanous-file-backend');
  add('elanous-file-backend', join(configDir, 'secrets.json.bak'), 'static', 'elanous-file-backend');
  add('elanous-auth', join(configDir, 'auth.json'), 'oauth', 'elanous');
  add('grok-auth', join(home, '.grok', 'auth.json'), 'oauth', 'grok');
  add('claude-credentials', join(home, '.claude', '.credentials.json'), 'oauth', 'claude');
  add('gh-hosts', join(home, '.config', 'gh', 'hosts.yml'), 'oauth', 'github');
  add('aws-credentials', join(home, '.aws', 'credentials'), 'static', 'aws');
  add('gcloud-adc', join(home, '.config', 'gcloud', 'application_default_credentials.json'), 'oauth', 'gcloud');
  add('gcloud-credentials-db', join(home, '.config', 'gcloud', 'credentials.db'), 'oauth', 'gcloud');
  const remoteParent = join(configDir, 'remote-parent-credentials');
  for (const name of safeReaddir(fs, remoteParent)) add('remote-parent-mirror', join(remoteParent, name), 'oauth', 'remote-parent');
  return out;
}

function safeReaddir(fs: InventoryFs, path: string): readonly string[] {
  try { return [...fs.readdir(path)].sort(); } catch { return []; }
}

function safeLstat(fs: InventoryFs, path: string): InventoryStat | undefined {
  try { return fs.lstat(path); } catch { return undefined; }
}

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function permissionFlags(stat: InventoryStat, uid: number): InventoryFlag[] {
  const flags: InventoryFlag[] = [];
  if (stat.mode & 0o004) flags.push('world-readable');
  if (stat.mode & 0o040) flags.push('group-readable');
  if (uid >= 0 && stat.uid !== uid) flags.push('not-owned-by-user');
  return flags;
}

function displayPath(home: string, path: string): string {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function collectSecretInventory(input: InventoryInput): SecretInventory {
  const nowMs = input.now.getTime();
  const expiringWithin = input.expiringWithinMs ?? 7 * DAY_MS;

  const items = input.items.map((meta): InventoryVaultRow & { flags: InventoryFlag[] } => {
    const flags: InventoryFlag[] = [];
    let presence: InventoryVaultRow['presence'];
    let mode: string | undefined;
    if (meta.kind === 'oauth') presence = 'reference';
    else {
      const stat = safeLstat(input.fs, input.envelopePath(meta.id));
      if (stat) {
        mode = modeString(stat.mode);
        flags.push(...permissionFlags(stat, input.uid));
        if (stat.isSymbolicLink()) flags.push('symlink');
      }
      presence = meta.generation === 0 ? (stat ? 'sealed' : 'empty') : stat ? 'sealed' : 'missing';
      if (presence === 'missing') flags.push('envelope-missing');
    }
    if (meta.expiresAt) {
      const left = Date.parse(meta.expiresAt) - nowMs;
      if (left <= 0) flags.push('expired');
      else if (left <= expiringWithin) flags.push('expiring');
    }
    if (meta.rotateEveryDays !== undefined && meta.kind === 'static') {
      const since = Date.parse(meta.rotatedAt ?? meta.createdAt);
      if (nowMs - since >= meta.rotateEveryDays * DAY_MS) flags.push('rotation-due');
    }
    return {
      source: 'vault', id: meta.id, kind: meta.kind, provider: meta.provider, ownerHost: meta.ownerHost,
      allowedHosts: meta.allowedHosts,
      ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
      ...(meta.rotateEveryDays !== undefined ? { rotateEveryDays: meta.rotateEveryDays } : {}),
      ...(meta.lastUsedAt ? { lastUsedAt: meta.lastUsedAt } : {}),
      createdAt: meta.createdAt, generation: meta.generation, presence,
      ...(mode ? { mode } : {}), flags,
    };
  });

  const external = knownCredentialLocations(input.home, input.configDir, input.fs).flatMap((loc) => {
    const stat = safeLstat(input.fs, loc.path);
    if (!stat) return [];
    const type: InventoryExternalRow['type'] = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    const flags: InventoryFlag[] = [];
    if (type === 'file') flags.push('plaintext-file');
    if (type === 'symlink') flags.push('symlink');
    flags.push(...permissionFlags(stat, input.uid));
    return [{ source: 'external' as const, path: displayPath(input.home, loc.path), location: loc.location, kind: loc.kind,
      provider: loc.provider, type, mode: modeString(stat.mode), uid: stat.uid, flags }];
  });

  // Duplicate copies: one static provider held in more than one place on this host
  // (vault envelope ⊕ plaintext cache, or several caches). OAuth homes are distinct accounts.
  const staticHolders = new Map<string, number>();
  const holderKey = (provider: string) => provider.replace(/[._-]/g, '');
  for (const row of items) if (row.kind === 'static' && row.presence === 'sealed') staticHolders.set(holderKey(row.provider), (staticHolders.get(holderKey(row.provider)) ?? 0) + 1);
  for (const row of external) if (row.location === 'cache-api-key') staticHolders.set(holderKey(row.provider), (staticHolders.get(holderKey(row.provider)) ?? 0) + 1);
  for (const row of items) if (row.kind === 'static' && row.presence === 'sealed' && (staticHolders.get(holderKey(row.provider)) ?? 0) > 1) row.flags.push('duplicate');
  for (const row of external) if (row.location === 'cache-api-key' && (staticHolders.get(holderKey(row.provider)) ?? 0) > 1) row.flags.push('duplicate');

  const flagCounts: Record<string, number> = {};
  let risky = 0;
  for (const row of [...items, ...external]) {
    if (row.flags.length > 0) risky += 1;
    for (const flag of row.flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
  }
  return {
    version: 1, generatedAt: input.now.toISOString(), host: input.host,
    items, external,
    summary: { items: items.length, external: external.length, risky, flags: flagCounts },
  };
}

export function renderSecretInventory(inventory: SecretInventory): string[] {
  const lines = [`secret inventory · host=${inventory.host} · items=${inventory.summary.items} · external=${inventory.summary.external} · risky=${inventory.summary.risky} · values=0`];
  for (const row of inventory.items) {
    lines.push(['vault', row.id, row.kind, row.provider, `owner=${row.ownerHost}`, `allow=${row.allowedHosts.join(',') || '-'}`,
      row.presence, `gen=${row.generation}`, row.mode ? `mode=${row.mode}` : 'mode=-',
      row.expiresAt ? `expires=${row.expiresAt}` : 'expires=-', row.lastUsedAt ? `used=${row.lastUsedAt}` : 'used=-',
      `flags=${row.flags.join(',') || '-'}`].join('\t'));
  }
  for (const row of inventory.external) {
    lines.push(['external', row.path, row.kind, row.provider, row.type, `mode=${row.mode}`, `uid=${row.uid}`,
      `flags=${row.flags.join(',') || '-'}`].join('\t'));
  }
  return lines;
}
