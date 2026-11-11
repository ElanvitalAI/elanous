import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLockSync } from '../../../storage/file-lock.js';
import { elanousConfigDir } from '../paths.js';
import { parseCredentialSlotId } from './cred-slot-schema.js';

export const CODEX_CREDENTIAL_SLOT = 'cred:codex-login';
export const CODEX_CREDENTIAL_OWNER_HOST = 'mbp';

export interface CredentialOwnerMirror {
  readonly host: string;
  readonly mode: 'access-only';
  readonly recordedAt: string;
}
export interface CredentialOwnerRecord {
  readonly slot: string;
  readonly ownerHost: string;
  readonly mirrors: readonly CredentialOwnerMirror[];
}
interface OwnerLedger { readonly version: 1; readonly slots: CredentialOwnerRecord[] }

export function normalizeCredentialHost(value: string): string {
  const host = value.trim().replace(/\.local$/i, '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(host)) throw new Error('CREDENTIAL_OWNER_HOST_INVALID');
  return host;
}

function assertSlot(slot: string): void {
  if (slot !== CODEX_CREDENTIAL_SLOT && !parseCredentialSlotId(slot)) throw new Error('CREDENTIAL_OWNER_SLOT_INVALID');
}

export function credentialOwnerLedgerPath(root = elanousConfigDir()): string {
  return join(root, 'credential-owner-ledger.json');
}

function readLedger(path: string): OwnerLedger {
  if (!existsSync(path)) return { version: 1, slots: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('CREDENTIAL_OWNER_LEDGER_CORRUPT'); }
  const ledger = parsed as Partial<OwnerLedger>;
  if (ledger?.version !== 1 || !Array.isArray(ledger.slots)) throw new Error('CREDENTIAL_OWNER_LEDGER_CORRUPT');
  const slots = ledger.slots.map((row) => {
    if (!row || typeof row.slot !== 'string' || typeof row.ownerHost !== 'string' || !Array.isArray(row.mirrors))
      throw new Error('CREDENTIAL_OWNER_LEDGER_CORRUPT');
    assertSlot(row.slot);
    const ownerHost = normalizeCredentialHost(row.ownerHost);
    const mirrors = row.mirrors.map((mirror) => {
      if (!mirror || typeof mirror.host !== 'string' || mirror.mode !== 'access-only'
        || typeof mirror.recordedAt !== 'string' || !Number.isFinite(Date.parse(mirror.recordedAt)))
        throw new Error('CREDENTIAL_OWNER_LEDGER_CORRUPT');
      return { host: normalizeCredentialHost(mirror.host), mode: 'access-only' as const, recordedAt: mirror.recordedAt };
    });
    if (new Set(mirrors.map((mirror) => mirror.host)).size !== mirrors.length || mirrors.some((mirror) => mirror.host === ownerHost))
      throw new Error('CREDENTIAL_OWNER_LEDGER_CORRUPT');
    if (row.slot === CODEX_CREDENTIAL_SLOT && ownerHost !== CODEX_CREDENTIAL_OWNER_HOST)
      throw new Error('CREDENTIAL_OWNER_LEDGER_CORRUPT');
    return { slot: row.slot, ownerHost, mirrors };
  });
  if (new Set(slots.map((row) => row.slot)).size !== slots.length) throw new Error('CREDENTIAL_OWNER_LEDGER_CORRUPT');
  return { version: 1, slots };
}

function copyRecord(row: CredentialOwnerRecord): CredentialOwnerRecord {
  return { slot: row.slot, ownerHost: row.ownerHost, mirrors: row.mirrors.map((mirror) => ({ ...mirror })) };
}

/** Value-free slot ownership inventory. This never reads a credential backend or serializes a token. */
export function readCredentialOwner(slot: string, path = credentialOwnerLedgerPath()): CredentialOwnerRecord | undefined {
  assertSlot(slot);
  const row = readLedger(path).slots.find((entry) => entry.slot === slot);
  return row ? copyRecord(row) : undefined;
}

/** Called only after a mirror install succeeds; one original host is immutable for a slot. */
export function recordCredentialMirror(input: {
  readonly slot: string;
  readonly ownerHost: string;
  readonly mirrorHost: string;
  readonly recordedAt?: string;
}, path = credentialOwnerLedgerPath()): CredentialOwnerRecord {
  assertSlot(input.slot);
  const ownerHost = normalizeCredentialHost(input.ownerHost);
  const mirrorHost = normalizeCredentialHost(input.mirrorHost);
  if (ownerHost === mirrorHost) throw new Error('credential owner cannot be a mirror');
  if (input.slot === CODEX_CREDENTIAL_SLOT && ownerHost !== CODEX_CREDENTIAL_OWNER_HOST)
    throw new Error('Codex owner host must be mbp');
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('CREDENTIAL_OWNER_TIME_INVALID');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquireLockSync(`${path}.lock`);
  try {
    const ledger = readLedger(path);
    const rows = ledger.slots.map(copyRecord);
    const index = rows.findIndex((row) => row.slot === input.slot);
    const previous = rows[index];
    if (previous && previous.ownerHost !== ownerHost) throw new Error('credential slot already has another owner host');
    const mirrors = previous?.mirrors.filter((mirror) => mirror.host !== mirrorHost) ?? [];
    const next: CredentialOwnerRecord = { slot: input.slot, ownerHost,
      mirrors: [...mirrors, { host: mirrorHost, mode: 'access-only', recordedAt }] };
    if (index < 0) rows.push(next);
    else rows[index] = next;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, slots: rows }), { flag: 'wx', mode: 0o600 });
      chmodSync(temporary, 0o600);
      const fd = openSync(temporary, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const dirFd = openSync(dirname(path), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return copyRecord(next);
  } finally { release(); }
}
