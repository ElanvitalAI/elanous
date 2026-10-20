/** Codex access-only credential copies for hosts that must never own refresh authority. */

export interface CodexAccessMirrorInput {
  account: string;
  store: { version?: number; providers: Record<string, Record<string, unknown>> };
  codexAuth: { [key: string]: unknown; auth_mode?: string; tokens: Record<string, unknown> };
}

export interface CodexAccessMirror {
  /** Minimal elanous auth store containing only this account's access token. */
  elanousAuth: string;
  /** Codex CLI auth document with refresh authority removed. */
  codexAuth: string;
  expiresAt: number;
}

/** Build the same refresh-less access-token copies used by Pod credentials. */
export function createCodexAccessMirror(input: CodexAccessMirrorInput): CodexAccessMirror {
  const storeKey = input.account === 'default' ? 'openai-codex' : `openai-codex:${input.account}`;
  const entry = input.store.providers[storeKey] as {
    tokens?: Record<string, unknown>; lastRefresh?: string; authMode?: string;
  } | undefined;
  if (!entry?.tokens) throw new Error(`${storeKey} 계정이 없다`);

  const accessToken = input.codexAuth.tokens.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new Error(`${storeKey} access token 이 없다`);
  // The Codex auth document is the authority for its own auth_mode. Store metadata
  // remains available in elanousAuth, but must not be synthesized into auth.json.
  const authMode = input.codexAuth.auth_mode;
  if (authMode !== undefined && (typeof authMode !== 'string' || !authMode.trim())) throw new Error(`${storeKey} Codex CLI auth_mode 가 비어 있다`);
  let payload: { exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
  } catch { throw new Error(`${storeKey} access token 만료를 읽을 수 없다`); }
  const expiresAt = Number(payload.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error(`${storeKey} access token 만료를 읽을 수 없다`);

  const elanousAuth = JSON.stringify({
    version: input.store.version ?? 1,
    providers: {
      'openai-codex': {
        tokens: { ...entry.tokens, accessToken, expiresAt, refreshToken: '', refresh_token: '' },
        lastRefresh: entry.lastRefresh,
        authMode: entry.authMode,
        chatGPT: { accountId: input.codexAuth.tokens.account_id },
      },
    },
  });
  const codexAuth = JSON.stringify({
    ...input.codexAuth,
    auth_mode: authMode,
    tokens: { ...input.codexAuth.tokens, refresh_token: '', refreshToken: '' },
  });
  return { elanousAuth, codexAuth, expiresAt };
}
