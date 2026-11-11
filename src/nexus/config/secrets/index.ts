// NEXUS · Secret backend public API (Phase N-3.5 PR σ)
//
// Single import surface for callers. The legacy `src/nexus/config/secrets.ts`
// module re-exports the same accessors so existing consumers stay
// unchanged.
//
// Two access shapes:
//   - **Async**: getSecretAsync / setSecretAsync / deleteSecretAsync /
//     listSecretIdsAsync — works with every backend.
//   - **Sync** (legacy / hot-path): getSecret / setSecret / deleteSecret /
//     listSecretIds — only the file backend supports sync; cloud
//     backends throw a helpful error pointing at the async API.

import {
  currentBackend,
  currentBackendId,
} from './registry.js';
import { deleteAppSecretValue, deleteLegacyAppSecretValueSync, importSecretsFileRaw, setAppSecretValue } from './file-backend.js';
import { appSecretId } from './app-secret-ledger.js';
import { assertSharedSecretId } from './types.js';
import { hasAppSecretEventForId } from './app-secret-ledger.js';
import { assertCredentialSlotId } from './cred-slots.js';

export * from './types.js';
export {
  registerBackend,
  getBackend,
  listBackendIds,
  currentBackend,
  currentBackendId,
  useBackend,
  selectBackendFromConfig,
  resetBackendRegistry,
} from './registry.js';
export * from './cred-slots.js';

export interface GithubMirrorCredential { readonly repository: string; readonly token: string }

export function canonicalGithubRepository(repository: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)
    || repository.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('ELANOUS_GITHUB_MIRROR_REPOSITORY_INVALID');
  }
  return repository.toLowerCase();
}

/** App-owned, ledger-backed token binding; the repository is checked again at push time. */
export async function registerGithubMirrorCredentialAsync(appSlug: string, credential: GithubMirrorCredential): Promise<void> {
  const id = appSecretId(appSlug, 'GITHUB_MIRROR_TOKEN');
  const repository = canonicalGithubRepository(credential.repository);
  if (!credential.token.trim() || /[\r\n\0]/.test(credential.token)) throw new Error('ELANOUS_GITHUB_MIRROR_TOKEN_INVALID');
  if (currentBackendId() !== 'file') throw new Error('ELANOUS_GITHUB_MIRROR_BACKEND_UNSUPPORTED');
  await setAppSecretValue(id, JSON.stringify({ version: 1, repository, token: credential.token }));
}

export async function readGithubMirrorCredentialAsync(appSlug: string): Promise<GithubMirrorCredential | undefined> {
  if (currentBackendId() !== 'file') throw new Error('ELANOUS_GITHUB_MIRROR_BACKEND_UNSUPPORTED');
  const raw = await getSecretAsync(appSecretId(appSlug, 'GITHUB_MIRROR_TOKEN'));
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1 || typeof value.repository !== 'string' || typeof value.token !== 'string'
      || canonicalGithubRepository(value.repository) !== value.repository || !value.token.trim()
      || /[\r\n\0]/.test(value.token)) throw new Error('invalid');
    return { repository: value.repository, token: value.token };
  } catch { throw new Error('ELANOUS_GITHUB_MIRROR_CREDENTIAL_CORRUPT'); }
}

export async function revokeGithubMirrorCredentialAsync(appSlug: string): Promise<boolean> {
  if (currentBackendId() !== 'file') throw new Error('ELANOUS_GITHUB_MIRROR_BACKEND_UNSUPPORTED');
  return deleteAppSecretValue(appSecretId(appSlug, 'GITHUB_MIRROR_TOKEN'));
}
export {
  readSecretsFileRaw as readSecrets,
  writeSecretsFileRaw as writeSecrets,
  importSecretsFileRaw,
} from './file-backend.js';

// ---------------------------------------------------------------------------
// Async API — the recommended path for new callers
// ---------------------------------------------------------------------------

export async function getSecretAsync(id: string): Promise<string | undefined> {
  return currentBackend().get(id);
}

export async function setSecretAsync(id: string, value: string): Promise<void> {
  assertSharedSecretId(id);
  if (id.startsWith('cred:')) {
    assertCredentialSlotId(id);
    throw new Error('ELANOUS_CREDENTIAL_SLOT_WRITER_REQUIRED');
  }
  await currentBackend().set(id, value);
}

export async function deleteSecretAsync(id: string): Promise<boolean> {
  if (id.startsWith('cred:')) {
    assertCredentialSlotId(id);
    throw new Error('ELANOUS_CREDENTIAL_SLOT_WRITER_REQUIRED');
  }
  if (id.startsWith('app/') && hasAppSecretEventForId(id)) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
  return currentBackend().delete(id);
}

export async function listSecretIdsAsync(): Promise<string[]> {
  return currentBackend().list();
}

/** Imports need a storage-level lock so confirmed name conflicts cannot race with another writer. */
export async function importSecretBatchAsync(
  secrets: Readonly<Record<string, string>>,
  overwrite: boolean,
  expectedConflicts?: readonly string[],
): Promise<{ imported: boolean; conflicts: string[]; changedSinceConfirmation: boolean }> {
  if (currentBackendId() !== 'file') throw new Error('ELANOUS_IMPORT_BACKEND_UNSUPPORTED');
  // App-scoped credentials require their lifecycle ledger; bulk import must not
  // create or overwrite values outside that audited path.
  if (Object.keys(secrets).some((id) => id.startsWith('app/'))) throw new Error('ELANOUS_APP_SECRET_IMPORT_UNSUPPORTED');
  if (Object.keys(secrets).some((id) => id.startsWith('cred:'))) throw new Error('ELANOUS_CREDENTIAL_SLOT_IMPORT_UNSUPPORTED');
  return importSecretsFileRaw(secrets, overwrite, expectedConflicts);
}

// ---------------------------------------------------------------------------
// Sync API — legacy compat. Only file backend supports it.
// ---------------------------------------------------------------------------

function syncOrThrow() {
  const b = currentBackend();
  if (!b.syncReadable) {
    throw new Error(
      `current secret backend '${currentBackendId()}' does not support sync access; use the async API (getSecretAsync etc.)`,
    );
  }
  return b;
}

export function getSecret(id: string): string | undefined {
  return syncOrThrow().syncReadable!.getSync(id);
}

export function listSecretIds(): string[] {
  return syncOrThrow().syncReadable!.listSync();
}

/** Sync set/delete — file backend only. Backed by the underlying file
 *  read/write so it stays compat with the pre-PR σ semantics. */
export function setSecret(id: string, value: string): string {
  assertSharedSecretId(id);
  if (id.startsWith('cred:')) {
    assertCredentialSlotId(id);
    throw new Error('ELANOUS_CREDENTIAL_SLOT_WRITER_REQUIRED');
  }
  // Use the async backend's set under the hood (file backend's set is
  // synchronous internally · the await resolves immediately).
  void currentBackend().set(id, value);
  return id;
}

export function deleteSecret(id: string): boolean {
  // Probe sync first (file backend); if not supported, fail loud.
  const b = syncOrThrow();
  if (id.startsWith('cred:')) {
    assertCredentialSlotId(id);
    throw new Error('ELANOUS_CREDENTIAL_SLOT_WRITER_REQUIRED');
  }
  if (id.startsWith('app/')) {
    if (hasAppSecretEventForId(id)) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
    return deleteLegacyAppSecretValueSync(id);
  }
  const exists = b.syncReadable!.getSync(id) !== undefined;
  if (!exists) return false;
  void currentBackend().delete(id);
  return true;
}
