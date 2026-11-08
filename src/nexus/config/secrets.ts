// NEXUS · secrets module facade (Phase N-3.5 PR σ)
//
// Pre-PR σ this file owned the file-backed implementation. PR σ moved
// the implementation into `secrets/{file-backend,registry,index}.ts`
// behind a swappable backend interface. This module re-exports the
// public surface so existing consumers (`src/nexus/api/config.ts`,
// `src/nexus/supervisor/index.ts`, tests) continue to work without
// touching their imports.

export {
  // Async (recommended)
  getSecretAsync,
  setSecretAsync,
  deleteSecretAsync,
  listSecretIdsAsync,
  // Shared credential slots (typed writer and metadata-only inventory)
  setCredentialSlotAsync,
  setCredentialSlotBatchAsync,
  deleteCredentialSlotAsync,
  listCredentialSlotsAsync,
  parseCredentialSlotId,
  type CredentialSlotId,
  type CredentialSlotStatus,
  // Sync (legacy / file backend only)
  getSecret,
  setSecret,
  deleteSecret,
  listSecretIds,
  // Raw file accessors (file backend only · used by env-derive's hot path)
  readSecrets,
  writeSecrets,
  // Backend introspection
  type SecretBackend,
  type SecretBackendId,
  type SyncReadableBackend,
  SecretBackendError,
  registerBackend,
  getBackend,
  listBackendIds,
  currentBackend,
  currentBackendId,
  useBackend,
  selectBackendFromConfig,
  resetBackendRegistry,
} from './secrets/index.js';
