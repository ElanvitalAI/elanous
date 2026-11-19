/**
 * HQ-VAULT V2 — minimal lease record store (values-free).
 *
 * 🔗 내부 문서 `HQ-CREDENTIAL-VAULT` §3.3 «원장» · §3.5 칸 목록.
 * File: `<owner state root>/secret-leases.json` (0600). One row per lease:
 *   { leaseId, kind: 'oauth', provider: 'codex', account, target, owner, issuedAt, expiresAt, renewedAt?, revokedAt?, podCard? }
 * ⛔ There is NO value column. Nothing here can carry a token.
 *
 * V1 absorption: V1 (vault metadata · `eln secret inventory`) reads these rows as the `lastLeaseAt`/lease state of an
 * `oauth:codex:<account>` item, then moves them into its index (`vault/index.json`) and leaves this file read-only.
 * The row shape is deliberately the §3.5 audit column subset so that move is a copy, not a translation.
 */
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { withFileLockSync } from '../storage/file-lock.js';

export const SECRET_LEASE_STORE_FILE = 'secret-leases.json';
export const SECRET_LEASE_STORE_VERSION = 1;

export type LeaseTarget =
  | { readonly kind: 'config-dir'; readonly path: string }
  | { readonly kind: 'host'; readonly host: string; readonly remoteDir: string };

export interface LeaseRecord {
  readonly leaseId: string;
  readonly kind: 'oauth';
  readonly provider: 'codex';
  readonly account: string;
  readonly target: LeaseTarget;
  readonly owner: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly renewedAt?: number;
  readonly renewCount?: number;
  readonly revokedAt?: number;
  /** #38815 ② — Pod 카드 id(Job 이름): 이 임대가 어느 Pod 발사에 주입됐는지. 값(토큰)은 없다. */
  readonly podCard?: string;
}

interface LeaseStoreFile { version: number; leases: LeaseRecord[] }

export function secretLeaseStorePath(stateRoot: string): string { return join(stateRoot, SECRET_LEASE_STORE_FILE); }

/** Same target identity for config dirs and hosts — used to find the live lease for `--to X`. */
export function leaseTargetKey(target: LeaseTarget): string {
  return target.kind === 'config-dir' ? `config-dir:${target.path}` : `host:${target.host}:${target.remoteDir}`;
}

export function readLeaseRecords(path: string): LeaseRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LeaseStoreFile>;
    return Array.isArray(parsed.leases) ? parsed.leases.filter((row): row is LeaseRecord =>
      Boolean(row) && typeof row.leaseId === 'string' && typeof row.expiresAt === 'number' && typeof row.issuedAt === 'number') : [];
  } catch {
    // A corrupt ledger must not be silently replaced by an empty one.
    throw new Error(`secret lease store is unreadable: ${path}`);
  }
}

function writeAtomic0600(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, body, 'utf8');
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* already renamed */ }
    throw error;
  }
}

/** Read-modify-write under the store lock. `mutate` returns the new list. */
export function updateLeaseRecords<T>(path: string, mutate: (rows: LeaseRecord[]) => { rows: LeaseRecord[]; result: T }): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${path}.lock`, () => {
    const { rows, result } = mutate(readLeaseRecords(path));
    // Values-free invariant — enforce the column set at the one writer.
    const clean = rows.map((row) => ({
      leaseId: row.leaseId, kind: row.kind, provider: row.provider, account: row.account,
      target: row.target.kind === 'config-dir' ? { kind: 'config-dir', path: row.target.path } : { kind: 'host', host: row.target.host, remoteDir: row.target.remoteDir },
      owner: row.owner, issuedAt: row.issuedAt, expiresAt: row.expiresAt,
      ...(row.renewedAt !== undefined ? { renewedAt: row.renewedAt } : {}),
      ...(row.renewCount !== undefined ? { renewCount: row.renewCount } : {}),
      ...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt } : {}),
      ...(row.podCard !== undefined ? { podCard: row.podCard } : {}),
    }));
    writeAtomic0600(path, `${JSON.stringify({ version: SECRET_LEASE_STORE_VERSION, leases: clean }, null, 2)}\n`);
    return result;
  }, { breakDeadHolder: true });
}

/** The newest not-revoked lease for this target (expired rows included — the caller judges expiry). */
export function findActiveLease(rows: readonly LeaseRecord[], target: LeaseTarget): LeaseRecord | undefined {
  const key = leaseTargetKey(target);
  return rows.filter((row) => row.revokedAt === undefined && leaseTargetKey(row.target) === key)
    .sort((a, b) => b.issuedAt - a.issuedAt)[0];
}
