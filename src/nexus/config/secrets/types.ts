// NEXUS · Secret backend interface (Phase N-3.5 PR σ)
//
// PR μ shipped a single FileBackend (`~/.elanous/secrets.json`). PR σ
// generalises the interface so PR υ can plug in Keychain / AWS Secrets
// Manager / GCP Secret Manager / 1Password without touching any
// caller. The default selection stays 'file' for zero-cost migration.
//
// Two access shapes:
//   - **Async** (canonical): every backend supports get/set/delete/list
//     as Promises. Cloud backends are inherently async.
//   - **Sync-readable** (file-only optimisation): FileBackend exposes
//     a SyncReadable interface so the supervisor's spawn primitive can
//     resolve secret-refs without an await on every child spawn. Other
//     backends return undefined; callers must use the async path.

export type SecretBackendId =
  | 'file'
  | 'keychain'
  | 'aws'
  | 'gcp'
  | '1password';

export function isAppSecretId(id: string): boolean {
  return id.startsWith('app/');
}

export function assertSharedSecretId(id: string): void {
  if (isAppSecretId(id)) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
}

export class SecretBackendError extends Error {
  constructor(public readonly backend: SecretBackendId, public readonly secretId: string, message: string) {
    super(`[${backend}:${secretId}] ${message}`);
    this.name = 'SecretBackendError';
  }
}

export interface SecretBackendAvailability {
  ok: boolean;
  /** Human-readable reason when ok=false (e.g., "missing op CLI"). */
  reason?: string;
}

export interface SecretBackend {
  readonly id: SecretBackendId;
  /** Promise-based primary API — every backend implements. */
  get(secretId: string): Promise<string | undefined>;
  set(secretId: string, value: string): Promise<void>;
  delete(secretId: string): Promise<boolean>;
  list(): Promise<string[]>;
  /** Reports whether the backend's external dependencies are usable
   *  (CLI installed · auth configured · network reachable). Backends
   *  should make this cheap (no actual secret fetches). */
  isAvailable(): Promise<SecretBackendAvailability>;
  /** When present, callers may use the sync path for hot loops
   *  (supervisor spawn). FileBackend implements; cloud backends
   *  intentionally don't. */
  syncReadable?: SyncReadableBackend;
}

export interface SyncReadableBackend {
  getSync(secretId: string): string | undefined;
  /** Returns all secret ids without leaking values — caller can iterate
   *  and probe with getSync per id. Cheaper than (await list()) for the
   *  hot env-derive path. */
  listSync(): string[];
}
