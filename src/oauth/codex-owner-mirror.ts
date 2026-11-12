import { hostname, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config/reader.js';
import { CODEX_CREDENTIAL_SLOT, credentialOwnerLedgerPath, normalizeCredentialHost, readCredentialOwner, recordCredentialMirror, resolveCodexCredentialOwnerHost, type CredentialOwnerRecord } from '../nexus/config/secrets/cred-owner.js';
import { loadTokens, type ProviderAuthState } from './store.js';
import { decodeJWTPayload } from './jwt.js';

export const CODEX_OWNER_MIRROR_RELATIVE_PATH = join('remote-parent-credentials', 'cli-mirror', 'auth.json');
export const CODEX_OWNER_MIRROR_REQUIRED = 'Codex owner access mirror rejected — inspect llm.codex/owner-mirror-rejected for the precise reason';

export function codexOwnerMirrorAuthPath(): string {
  const stateRoot = getElanousConfigDir();
  const derivedPath = join(stateRoot, CODEX_OWNER_MIRROR_RELATIVE_PATH);
  const accessOnly = process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY === '1';
  const explicitCodexHome = accessOnly ? process.env.CODEX_HOME?.trim() : undefined;
  const codexHomePath = explicitCodexHome ? join(resolve(explicitCodexHome), 'auth.json') : undefined;
  const configuredPath = accessOnly
    ? process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH?.trim()
    : undefined;
  const path = codexHomePath ?? (configuredPath && isAbsolute(configuredPath) ? configuredPath : derivedPath);
  try {
    debug.log('llm.codex', 'owner-mirror-path-compared', {
      source: path === codexHomePath ? 'codex-home' : path === derivedPath ? 'state-root' : 'remote-explicit',
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

/** The HQ-configured machine identity is compared to the configured fleet owner. */
export function isCodexTokenOwnerHost(config = getUserConfig(), machine = hostname()): boolean {
  try {
    const owner = resolveCodexCredentialOwnerHost(config);
    if (!owner) return false;
    const local = normalizeCredentialHost(config.hq?.hostName || machine);
    return local === owner;
  } catch { return false; }
}

/** A standalone install owns its local login; only explicit access-only or configured fleet nonowners consume a mirror. */
export function shouldUseCodexOwnerMirror(config = getUserConfig(), machine = hostname()): boolean {
  if (process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY === '1') return true;
  return Boolean(resolveCodexCredentialOwnerHost(config) && !isCodexTokenOwnerHost(config, machine));
}

/** Run the existing install on an owner host, then record only slot and host metadata. */
export function deliverCodexMirrorAndRecord(
  targetHost: string,
  deliver: () => void,
  options: { readonly config?: ReturnType<typeof getUserConfig>; readonly machine?: string; readonly ledgerPath?: string } = {},
): CredentialOwnerRecord {
  const config = options.config ?? getUserConfig();
  const ledgerPath = options.ledgerPath ?? credentialOwnerLedgerPath();
  const ownerHost = resolveCodexCredentialOwnerHost(config);
  if (!ownerHost || !isCodexTokenOwnerHost(config, options.machine ?? hostname()))
    throw new Error('Codex mirror push requires the configured or leased owner host');
  const mirrorHost = normalizeCredentialHost(targetHost);
  if (mirrorHost === ownerHost) throw new Error('credential owner cannot be a mirror');
  readCredentialOwner(CODEX_CREDENTIAL_SLOT, ledgerPath); // Parse the local receipt before side effects; it is not the owner authority.
  try { deliver(); }
  catch (error) {
    const candidate = error as { code?: unknown; rc?: unknown } | null;
    const safeCode = ['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'SSH_FAILED'].includes(String(candidate?.code))
      ? String(candidate?.code) : undefined;
    const safeRc = Number.isInteger(candidate?.rc) && Number(candidate?.rc) >= 0 && Number(candidate?.rc) <= 255
      ? Number(candidate?.rc) : undefined; // Source: SSH process exit status is an unsigned byte; never include raw error text.
    throw new Error(`CODEX_MIRROR_DELIVERY_FAILED (reason=${safeCode ?? 'unknown'}${safeRc === undefined ? '' : `; rc=${safeRc}`})`);
  }
  return recordCredentialMirror({ slot: CODEX_CREDENTIAL_SLOT, ownerHost, mirrorHost }, ledgerPath);
}

/** Account discovery and rotation must read the same remote snapshot as execution. */
export function codexAccountReadStorePath(ownerStorePath: string): string {
  const candidates = [
    ['config-dir', ownerStorePath],
    ['default-root', join(homedir(), '.elanous', 'auth.json')],
    ['owner-mirror', codexOwnerMirrorAuthPath()],
  ] as const;
  for (const [source, path] of candidates) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) continue;
      if (source === 'owner-mirror') {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { providers?: Record<string, unknown> };
        const keys = Object.keys(parsed.providers ?? {});
        if (keys.length === 0) keys.push('openai-codex');
        if (!keys.some(key => {
          if (key !== 'openai-codex' && !key.startsWith('openai-codex:')) return false;
          try { readCodexOwnerAccessMirror(key, { path }); return true; } catch { return false; }
        })) continue;
      } else {
        const keys = Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { providers?: Record<string, unknown> }).providers ?? {});
        if (!keys.some(key => {
          if (key !== 'openai-codex' && !key.startsWith('openai-codex:')) return false;
          const state = loadTokens(key, path);
          const expiry = state?.tokens.expiresAt;
          const accountId = state?.chatGPT?.accountId ?? state?.accountUuid;
          return Boolean(state?.authMode === 'chatgpt' && state.tokens.accessToken
            && typeof expiry === 'number' && expiry > Date.now() + 120_000
            && (source === 'config-dir' || accountId)
            && (!state.chatGPT?.accountId || !state.accountUuid || state.chatGPT.accountId === state.accountUuid));
        })) continue;
      }
      const root = source === 'owner-mirror' ? dirname(dirname(dirname(path))) : dirname(path);
      try { debug.log('llm.auth', 'path-found', { source, rootSha256: rootFingerprint(root) }); } catch { /* fail-soft */ }
      return path;
    } catch { continue; }
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
  let parsed: unknown;
  let readFailure: 'missing-file' | 'read-error' | 'invalid-json' | undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    try { parsed = JSON.parse(raw); } catch { readFailure = 'invalid-json'; }
  } catch (error) {
    readFailure = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-file' : 'read-error';
  }
  if (!readFailure) {
    try { state = loadTokens(storeKey, path) ?? codexHomeAccessState(parsed); } catch { /* classify safely below */ }
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

/** Convert the Codex CLI's native access-only mirror into the shared provider shape. */
function codexHomeAccessState(value: unknown): ProviderAuthState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { auth_mode?: unknown; last_refresh?: unknown; tokens?: Record<string, unknown> };
  const tokens = record.tokens;
  if (record.auth_mode !== 'chatgpt' || !tokens || typeof tokens.access_token !== 'string'
      || typeof tokens.refresh_token !== 'string') return null;
  const expiresAt = decodeJWTPayload(tokens.access_token)?.exp;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  const normalizedTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    refresh_token: tokens.refresh_token,
    expiresAt: expiresAt * 1000,
    tokenType: 'Bearer',
  } as ProviderAuthState['tokens'] & { refresh_token?: string };
  return {
    source: 'mirror',
    authMode: 'chatgpt',
    lastRefresh: typeof record.last_refresh === 'string' ? record.last_refresh : '',
    ...(typeof tokens.account_id === 'string' ? { accountUuid: tokens.account_id } : {}),
    tokens: normalizedTokens,
  };
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
