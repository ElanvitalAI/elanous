// HQ-VAULT V1 · KEK held in the mshq login keychain (service `elanous-vault-kek`).
//
// Written and read through the keychain backend, whose write path sends the value over
// `security -i` stdin (never argv). Off macOS, or when `security` is missing, the vault
// does not open (fail-closed) — there is no on-disk KEK fallback.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createKeychainBackend } from '../keychain-backend.js';
import type { RunCli } from '../cli-helper.js';
import type { SecretBackend } from '../types.js';
import { VAULT_KEK_BYTES } from './envelope.js';

export const VAULT_KEK_SERVICE = 'elanous-vault-kek';

export interface VaultKekProvider {
  /** Existing KEK; throws VAULT_KEK_MISSING when none was created yet. */
  get(): Promise<Buffer>;
  /** Existing KEK or a fresh one stored in the keychain first. `created` feeds the audit event. */
  getOrCreate(): Promise<{ kek: Buffer; created: boolean }>;
}

export class VaultKekUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`VAULT_KEK_UNAVAILABLE:${reason}`);
    this.name = 'VaultKekUnavailableError';
  }
}

function decodeKek(encoded: string | undefined): Buffer | undefined {
  if (encoded === undefined || encoded === '') return undefined;
  const kek = Buffer.from(encoded, 'base64');
  if (kek.length !== VAULT_KEK_BYTES) throw new VaultKekUnavailableError('malformed');
  return kek;
}

export function createKeychainVaultKek(opts: {
  vaultDir: string;
  runCliImpl?: RunCli;
  platformOverride?: string;
  backend?: SecretBackend;
}): VaultKekProvider {
  // A separate sidecar index keeps the KEK id out of `eln secret list` on keychain-backed installs.
  const backend = opts.backend ?? createKeychainBackend({
    indexPath: join(opts.vaultDir, 'kek-keychain-index.json'),
    ...(opts.runCliImpl ? { runCliImpl: opts.runCliImpl } : {}),
    ...(opts.platformOverride ? { platformOverride: opts.platformOverride } : {}),
  });
  async function available(): Promise<void> {
    const availability = await backend.isAvailable();
    if (!availability.ok) throw new VaultKekUnavailableError('keychain-unavailable');
  }
  return {
    async get() {
      await available();
      const kek = decodeKek(await backend.get(VAULT_KEK_SERVICE));
      if (!kek) throw new VaultKekUnavailableError('missing');
      return kek;
    },
    async getOrCreate() {
      await available();
      const existing = decodeKek(await backend.get(VAULT_KEK_SERVICE));
      if (existing) return { kek: existing, created: false };
      const kek = randomBytes(VAULT_KEK_BYTES);
      await backend.set(VAULT_KEK_SERVICE, kek.toString('base64'));
      return { kek, created: true };
    },
  };
}
