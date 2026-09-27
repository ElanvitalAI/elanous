// Step 5 PR δ — token scope model.
//
// PLAN-step5-sdk-zero-env.md §1 D-Phase3-F: 3-tier scope ('admin' /
// 'session' / 'read-only'). Closes BACKLOG #6 (per-session ACL) by
// letting the user mint scoped tokens that grant only the
// permissions they need.
//
// The control plane HTTP server consults `tokenScopeAllows` for
// every authenticated route. Read-only scope rejects POST/PUT/PATCH
// /DELETE; session scope rejects calls that would touch a sibling
// session; admin scope is the existing single-token semantics.
//
// Tokens themselves are opaque random strings — the scope lives in
// the envelope alongside the token, not encoded into the token text.
// This keeps the SDK simple (no HMAC verify on the client side) and
// makes "leak in shell history" recovery a one-line revoke instead
// of a key-rotation flow.

export type TokenScope = 'admin' | 'session' | 'read-only' | 'mcp-public';

const READONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ScopedToken {
  /** The opaque token string. */
  token: string;
  /** Scope grant. */
  scope: TokenScope;
  /** Required when `scope === 'session'` — the SessionId this token
   *  is bound to. Calls touching another session id → 403. */
  sessionId?: string;
  /** ISO8601. When set + the timestamp is past, the token rejects
   *  with 401 (expired). Optional — admin tokens usually have no
   *  expiry. */
  expiresAt?: string;
}

export interface ScopeCheckRequest {
  method: string;
  /** Request path (e.g. `/v1/mcp`). Callers must provide the full
   *  pathname when checking the `mcp-public` scope. */
  pathname: string;
  /** Optional — the session id this request is targeting. Routes
   *  that touch a single session (e.g. `active-session` or future
   *  per-session HTTP routes) extract this from the body / params.
   *  When omitted, session-scoped tokens are rejected for any
   *  mutating call (conservative — better-safe-than-leaky). */
  targetSessionId?: string;
}

export interface ScopeCheckResult {
  ok: boolean;
  /** Diagnostic — populated when ok=false so the server response can
   *  surface a 403 reason. */
  reason?: string;
}

/** Decide whether a `ScopedToken` may execute a given request.
 *  Returns ok:true on grant, ok:false + reason on deny. */
export function tokenScopeAllows(
  token: ScopedToken,
  req: ScopeCheckRequest,
): ScopeCheckResult {
  // Expiry check (applies to every scope).
  if (token.expiresAt) {
    const t = Date.parse(token.expiresAt);
    if (Number.isFinite(t) && t < Date.now()) {
      return { ok: false, reason: 'token_expired' };
    }
  }

  switch (token.scope) {
    case 'admin':
      return { ok: true };

    case 'mcp-public':
      return req.method.toUpperCase() === 'POST' && req.pathname === '/v1/mcp'
        ? { ok: true }
        : { ok: false, reason: 'mcp_public_scope' };

    case 'read-only': {
      const m = req.method.toUpperCase();
      if (READONLY_METHODS.has(m)) return { ok: true };
      return { ok: false, reason: 'read_only_token' };
    }

    case 'session': {
      if (!token.sessionId) {
        return { ok: false, reason: 'session_token_missing_binding' };
      }
      // GET on the active-session endpoint is allowed — UI loops
      // poll this. Mutations require the session id to match.
      const m = req.method.toUpperCase();
      const isReadOnly = READONLY_METHODS.has(m);
      if (isReadOnly) return { ok: true };

      if (req.targetSessionId === undefined) {
        // Caller didn't extract a target — refuse mutating calls
        // conservatively. Routes that should accept session tokens
        // for mutation must populate `targetSessionId`.
        return { ok: false, reason: 'session_token_no_target' };
      }
      if (req.targetSessionId !== token.sessionId) {
        return { ok: false, reason: 'session_mismatch' };
      }
      return { ok: true };
    }

    default:
      return { ok: false, reason: 'unknown_scope' };
  }
}

/** Generate an opaque random token. 32 bytes hex = 64 chars — same
 *  shape as the legacy `~/.elanous/acp-token` mint path. */
export function mintRandomToken(): string {
  // Lazy require to keep this module zero-side-effect on import.
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return randomBytes(32).toString('hex');
}
