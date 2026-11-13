import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { loadTokens } from './store.js';

function recordPath(storePath: string, storeKey: string, credentialFingerprint: string): string {
  const key = createHash('sha256').update(storeKey).digest('hex');
  return join(dirname(storePath), 'codex-account-health', `${key}-${credentialFingerprint}.json`);
}

function fingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

/** Access-only mirrors have no refresh grant; their access token identifies the rejected snapshot. */
export function codexHealthCredential(tokens: { refreshToken?: string; accessToken?: string }): string {
  return tokens.refreshToken || tokens.accessToken || '';
}

/** A rejected refresh grant stays excluded until a new grant replaces it. No credential bytes are persisted. */
export function recordCodexUnauthorized(storePath: string, storeKey: string, refreshToken: string): void {
  if (!refreshToken) return;
  // A delayed 401 from the former grant must not reject a replacement already in the store.
  const current = loadTokens(storeKey, storePath);
  if (codexHealthCredential(current?.tokens ?? {}) !== refreshToken) return;
  const path = recordPath(storePath, storeKey, fingerprint(refreshToken));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ fingerprint: fingerprint(refreshToken), at: Date.now() }), { mode: 0o600 });
    if (codexHealthCredential(loadTokens(storeKey, storePath)?.tokens ?? {}) !== refreshToken) return;
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) rmSync(temporary); }
}

export function isCodexUnauthorized(
  storePath: string, storeKey: string, refreshToken: string,
  defaultStorePath = join(homedir(), '.elanous', 'auth.json'),
): boolean {
  if (!refreshToken) return false;
  // The selected credential may live in the default auth root while the caller uses a config root.
  // Fingerprints still bind the rejection to the exact credential, never just the account name.
  for (const candidatePath of new Set([storePath, defaultStorePath])) {
    try {
      const data: unknown = JSON.parse(readFileSync(recordPath(candidatePath, storeKey, fingerprint(refreshToken)), 'utf8'));
      if (!!data && typeof data === 'object' && 'fingerprint' in data
        && data.fingerprint === fingerprint(refreshToken)) return true;
    } catch { /* the next store root may hold the selected credential */ }
  }
  return false;
}
