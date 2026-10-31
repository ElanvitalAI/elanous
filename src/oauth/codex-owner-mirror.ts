import { hostname } from 'node:os';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { getUserConfig } from '../user-config.js';
import { loadTokens, type ProviderAuthState } from './store.js';

export const CODEX_OWNER_MIRROR_RELATIVE_PATH = join('remote-parent-credentials', 'cli-mirror', 'auth.json');
export const CODEX_OWNER_MIRROR_REQUIRED = 'Codex 주인 미러가 없거나 만료됐다 — 주인 호스트에서 `eln codex mirror push <host>` 를 실행해야 한다';

export function codexOwnerMirrorAuthPath(): string {
  return join(elanousStateRoot(), CODEX_OWNER_MIRROR_RELATIVE_PATH);
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
  try { state = loadTokens(storeKey, path); } catch { /* fail closed below */ }
  const tokenFields = state?.tokens as (ProviderAuthState['tokens'] & { refresh_token?: unknown }) | undefined;
  const expiresAt = state?.tokens.expiresAt;
  if (!state || state.authMode !== 'chatgpt' || !state.tokens.accessToken
    || tokenFields?.refreshToken !== '' || tokenFields?.refresh_token !== ''
    || typeof expiresAt !== 'number'
    || !Number.isFinite(expiresAt) || expiresAt <= now + 120_000) {
    throw new Error(CODEX_OWNER_MIRROR_REQUIRED);
  }
  return state;
}

