import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config/reader.js';
import { CODEX_CREDENTIAL_OWNER_HOST, CODEX_CREDENTIAL_SLOT, normalizeCredentialHost, readCredentialOwner, recordCredentialMirror, type CredentialOwnerRecord } from '../nexus/config/secrets/cred-owner.js';
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

/** The HQ-configured machine identity is the stable short name used by the lease. */
export function isCodexTokenOwnerHost(config = getUserConfig(), machine = hostname()): boolean {
  try {
    const owner = normalizeCredentialHost(config.llm.codexTokenOwnerHost || CODEX_CREDENTIAL_OWNER_HOST);
    const local = normalizeCredentialHost(config.hq?.hostName || machine);
    return owner === CODEX_CREDENTIAL_OWNER_HOST && local === owner;
  } catch { return false; }
}

/** Run the existing install on an owner host, then record only slot and host metadata. */
export function deliverCodexMirrorAndRecord(
  targetHost: string,
  deliver: () => void,
  options: { readonly config?: ReturnType<typeof getUserConfig>; readonly machine?: string; readonly ledgerPath?: string } = {},
): CredentialOwnerRecord {
  if (!isCodexTokenOwnerHost(options.config ?? getUserConfig(), options.machine ?? hostname()))
    throw new Error('Codex owner host must be mbp');
  const mirrorHost = normalizeCredentialHost(targetHost);
  if (mirrorHost === CODEX_CREDENTIAL_OWNER_HOST) throw new Error('credential owner cannot be a mirror');
  const previous = readCredentialOwner(CODEX_CREDENTIAL_SLOT, options.ledgerPath);
  if (previous && previous.ownerHost !== CODEX_CREDENTIAL_OWNER_HOST) throw new Error('Codex owner host must be mbp');
  try { deliver(); }
  catch (error) {
    const candidate = error as { code?: unknown; rc?: unknown } | null;
    const safeCode = ['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'SSH_FAILED'].includes(String(candidate?.code))
      ? String(candidate?.code) : undefined;
    const safeRc = Number.isInteger(candidate?.rc) && Number(candidate?.rc) >= 0 && Number(candidate?.rc) <= 255
      ? Number(candidate?.rc) : undefined; // Source: SSH process exit status is an unsigned byte; never include raw error text.
    throw new Error(`CODEX_MIRROR_DELIVERY_FAILED (reason=${safeCode ?? 'unknown'}${safeRc === undefined ? '' : `; rc=${safeRc}`})`);
  }
  return recordCredentialMirror({ slot: CODEX_CREDENTIAL_SLOT, ownerHost: CODEX_CREDENTIAL_OWNER_HOST, mirrorHost }, options.ledgerPath);
}

/** Account discovery and rotation must read the same remote snapshot as execution. */
export function codexAccountReadStorePath(ownerStorePath: string): string {
  if (process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY === '1') return codexOwnerMirrorAuthPath();
  if (!isCodexTokenOwnerHost()) {
    const mirror = codexOwnerMirrorAuthPath();
    if (existsSync(mirror)) return mirror;
  }
  return ownerStorePath;
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


/** One owner account that `codex mirror push` could not ship, and why (never a token value). */
export interface CodexMirrorSkippedAccount { account: string; reason: 'access-expiring' | 'credential-unavailable' }

/**
 * REMOTE-MIRROR-SKIP-UNUSABLE (11-05) — collect the access-only mirrors for `codex mirror push`, skipping accounts
 * the owner cannot ship right now instead of failing the whole push. 11-05 19:41~ the owner `default` access token
 * fell inside the 3 h window, `hostCredentials` threw for it, and every host lost the fresh `team`·`third` mirrors too.
 * Skipped accounts are logged (`llm.codex/owner-mirror-push-skipped`); only «nothing shippable» is an error.
 */
export function collectCodexMirrorCredentials<T extends object>(
  accounts: readonly string[],
  read: (account: string) => T,
  opts: { allowEmpty?: boolean } = {},
): { mirrors: Array<T & { account: string }>; skipped: CodexMirrorSkippedAccount[] } {
  const mirrors: Array<T & { account: string }> = [];
  const skipped: CodexMirrorSkippedAccount[] = [];
  for (const account of accounts) {
    try {
      mirrors.push({ ...read(account), account });
    } catch (error) {
      const reason = (error as { hoursLeft?: unknown } | null)?.hoursLeft !== undefined ? 'access-expiring' : 'credential-unavailable';
      skipped.push({ account, reason });
      try { debug.log('llm.codex', 'owner-mirror-push-skipped', { account, reason }, { level: 'warn' }); } catch { /* fail-soft */ }
    }
  }
  if (mirrors.length === 0 && !opts.allowEmpty) {
    throw new Error(`쓸 수 있는 주인 Codex 계정이 없다 (${skipped.map((s) => `${s.account}=${s.reason}`).join(', ')})`);
  }
  return { mirrors, skipped };
}
