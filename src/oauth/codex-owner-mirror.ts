import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { loadTokens, type ProviderAuthState } from './store.js';

export const CODEX_OWNER_MIRROR_RELATIVE_PATH = join('remote-parent-credentials', 'cli-mirror', 'auth.json');
export const CODEX_OWNER_MIRROR_REQUIRED = 'Codex owner access mirror rejected — inspect llm.codex/owner-mirror-rejected for the precise reason';

export function codexOwnerMirrorAuthPath(): string {
  const stateRoot = elanousStateRoot();
  const derivedPath = join(stateRoot, CODEX_OWNER_MIRROR_RELATIVE_PATH);
  const configuredPath = process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY === '1'
    ? process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH?.trim()
    : undefined;
  const path = configuredPath && isAbsolute(configuredPath) ? configuredPath : derivedPath;
  try {
    debug.log('llm.codex', 'owner-mirror-path-compared', {
      source: path === derivedPath ? 'state-root' : 'remote-explicit',
      stateRootSha256: rootFingerprint(stateRoot),
      derivedMirrorRootSha256: rootFingerprint(dirname(dirname(dirname(derivedPath)))),
      resolvedMirrorRootSha256: rootFingerprint(dirname(dirname(dirname(path)))),
      explicitPathAccepted: Boolean(configuredPath && path === configuredPath),
    });
  } catch { /* diagnostics must not block auth */ }
  return path;
}

function rootFingerprint(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

function normalizedHost(value: string): string {
  return value.trim().replace(/\.local$/i, '').toLowerCase();
}

/** The HQ-configured machine identity is the stable short name used by the lease. */
export function isCodexTokenOwnerHost(config = getUserConfig(), machine = hostname()): boolean {
  const owner = normalizedHost(config.llm.codexTokenOwnerHost || 'mbp');
  const local = normalizedHost(config.hq?.hostName || machine);
  return local === owner;
}

/** Read only a fresh, access-only HQ snapshot. This helper never performs OAuth refresh. */
export function readCodexOwnerAccessMirror(
  storeKey: string,
  opts: { path?: string; now?: number } = {},
): ProviderAuthState {
  const path = opts.path ?? codexOwnerMirrorAuthPath();
  const now = opts.now ?? Date.now();
  let state: ProviderAuthState | null = null;
  let readFailure: 'missing-file' | 'read-error' | 'invalid-json' | undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    try { JSON.parse(raw); } catch { readFailure = 'invalid-json'; }
  } catch (error) {
    readFailure = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-file' : 'read-error';
  }
  if (!readFailure) {
    try { state = loadTokens(storeKey, path); } catch { /* classify safely below */ }
  }
  const tokenFields = state?.tokens as (ProviderAuthState['tokens'] & { refresh_token?: unknown }) | undefined;
  const expiresAt = state?.tokens.expiresAt;
  const reason = readFailure ?? (!state || !state.tokens ? 'no-access'
      : state.authMode !== 'chatgpt' ? 'authMode'
      : !state.tokens.accessToken ? 'no-access'
      : typeof tokenFields?.refreshToken !== 'string' || typeof tokenFields?.refresh_token !== 'string' ? 'refresh-missing'
      : tokenFields.refreshToken !== '' || tokenFields.refresh_token !== '' ? 'refresh-not-empty'
      : typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now + 120_000 ? 'expiry'
      : undefined);
  if (reason) {
    const root = dirname(dirname(dirname(path)));
    try { debug.log('llm.codex', 'owner-mirror-rejected', { reason, storeKey, rootSha256: rootFingerprint(root) }, { level: 'warn' }); } catch { /* fail-soft */ }
    throw new Error(`${CODEX_OWNER_MIRROR_REQUIRED} (reason=${reason}; storeKey=${storeKey}; rootSha256=${rootFingerprint(root)})`);
  }
  return state!;
}

