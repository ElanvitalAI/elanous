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
import { importSecretsFileRaw } from './file-backend.js';

export * from './types.js';
export * from './registry.js';
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
  await currentBackend().set(id, value);
}

export async function deleteSecretAsync(id: string): Promise<boolean> {
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
  // Use the async backend's set under the hood (file backend's set is
  // synchronous internally · the await resolves immediately).
  void currentBackend().set(id, value);
  return id;
}

export function deleteSecret(id: string): boolean {
  // Probe sync first (file backend); if not supported, fail loud.
  const b = syncOrThrow();
  const exists = b.syncReadable!.getSync(id) !== undefined;
  if (!exists) return false;
  void currentBackend().delete(id);
  return true;
}
