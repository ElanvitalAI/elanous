// NEXUS · SecretBackend registry (Phase N-3.5 PR σ)
//
// Singleton mapping `SecretBackendId → SecretBackend` plus a "current"
// pointer driven by `global.secrets.backend` SwitchRegistry value. The
// boot path (runNexus) calls `selectBackendFromConfig()` once after
// builtins load; tests can override directly via `useBackend(id)`.

import { assertSharedSecretId, type SecretBackend, type SecretBackendId } from './types.js';
import { appSecretLockKeyForLegacyId, hasAppSecretEventForId, withAppSecretLock } from './app-secret-ledger.js';
import { fileBackend } from './file-backend.js';
import { readUserConfig, readSwitchValue } from '../user-config.js';

const backends = new Map<SecretBackendId, SecretBackend>();
const guardedBackends = new Map<SecretBackendId, SecretBackend>();
const guardedBackendObjects = new WeakSet<object>();

function guardBackend(backend: SecretBackend): SecretBackend {
  if (guardedBackendObjects.has(backend)) return backend;
  const mutable = backend as SecretBackend;
  const set = backend.set.bind(backend);
  const remove = backend.delete.bind(backend);
  mutable.set = (id, value) => { assertSharedSecretId(id); return set(id, value); };
  mutable.delete = async (id) => {
    if (!id.startsWith('app/')) return remove(id);
    const deleteLegacy = async (assertHeld: () => void): Promise<boolean> => {
      if (await hasAppSecretEventForId(id)) throw new Error('ELANOUS_APP_SECRET_LEDGER_REQUIRED');
      assertHeld();
      return remove(id);
    };
    if (backend.id === 'file') {
      // FileBackend acquires the same app lock itself before checking ownership.
      return deleteLegacy(() => {});
    }
    return withAppSecretLock(appSecretLockKeyForLegacyId(id), deleteLegacy);
  };
  guardedBackendObjects.add(backend);
  return backend;
}
let currentId: SecretBackendId = 'file';

// Always register FileBackend (always available; default).
backends.set('file', fileBackend);
guardedBackends.set('file', guardBackend(fileBackend));

export function registerBackend(backend: SecretBackend): void {
  backends.set(backend.id, backend);
  guardedBackends.set(backend.id, guardBackend(backend));
}

export function getBackend(id: SecretBackendId): SecretBackend | undefined {
  return guardedBackends.get(id);
}

export function listBackendIds(): SecretBackendId[] {
  return [...backends.keys()];
}

export function currentBackend(): SecretBackend {
  const b = guardedBackends.get(currentId);
  if (!b) throw new Error(`secret backend not registered: ${currentId}`);
  return b;
}

export function currentBackendId(): SecretBackendId {
  return currentId;
}

/** Tests + boot path use this to switch the active backend. Throws when
 *  the backend isn't registered (PR σ ships only 'file'; PR υ adds the
 *  rest). */
export function useBackend(id: SecretBackendId): void {
  if (!backends.has(id)) {
    throw new Error(`secret backend not registered: ${id} (registered: ${[...backends.keys()].join(',')})`);
  }
  currentId = id;
}

/** Reads `global.secrets.backend` from UserConfig and switches. Falls
 *  back to 'file' when unset / unknown. Returns the resolved id. */
export function selectBackendFromConfig(): SecretBackendId {
  const cfg = readUserConfig();
  const raw = readSwitchValue(cfg, 'global.secrets.backend');
  const id = typeof raw === 'string' && backends.has(raw as SecretBackendId)
    ? (raw as SecretBackendId)
    : 'file';
  currentId = id;
  return id;
}

/** Test seam — clears non-file backends and resets current to 'file'. */
export function resetBackendRegistry(): void {
  for (const id of [...backends.keys()]) {
    if (id !== 'file') { backends.delete(id); guardedBackends.delete(id); }
  }
  currentId = 'file';
}
