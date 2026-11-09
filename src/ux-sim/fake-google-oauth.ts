import { createHash } from 'node:crypto';

export const FAKE_GOOGLE_ISSUER = 'https://accounts.google.test';
export const GOOGLE_MEMBER_SCOPES = ['openid', 'email', 'profile'] as const;

export interface FakeGoogleIdentity {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
}

export interface FakeGoogleOAuthWorld {
  authorize(authorizationUrl: string | URL): { code: string; state: string };
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface FakeGoogleOAuthOptions {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly identity: FakeGoogleIdentity | ((authorizationUrl: URL, sequence: number) => FakeGoogleIdentity);
}

/** Deterministic Google OAuth boundary for member-signup simulations; no network or secrets. */
export function createFakeGoogleOAuthWorld(options: FakeGoogleOAuthOptions): FakeGoogleOAuthWorld {
  const redirectUri = new URL(options.redirectUri).toString();
  const clientSecret = options.clientSecret ?? 'fake-google-client-secret';
  const codes = new Map<string, { challenge: string; redirectUri: string; identity: FakeGoogleIdentity }>();
  const tokens = new Map<string, FakeGoogleIdentity>();
  let codeNumber = 0;

  return {
    authorize(input) {
      const url = input instanceof URL ? input : new URL(input);
      if (url.origin !== FAKE_GOOGLE_ISSUER || url.pathname !== '/o/oauth2/v2/auth') throw new Error('fake Google authorization endpoint mismatch');
      if (url.searchParams.get('client_id') !== options.clientId) throw new Error('fake Google client id mismatch');
      if (url.searchParams.get('redirect_uri') !== redirectUri) throw new Error('fake Google redirect URI mismatch');
      if (url.searchParams.get('response_type') !== 'code') throw new Error('fake Google response type mismatch');
      const scopes = (url.searchParams.get('scope') ?? '').split(/\s+/).filter(Boolean).sort();
      if (JSON.stringify(scopes) !== JSON.stringify([...GOOGLE_MEMBER_SCOPES].sort())) throw new Error('fake Google scope set must be openid email profile');
      const state = url.searchParams.get('state');
      const challenge = url.searchParams.get('code_challenge');
      if (!state || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('fake Google state and S256 PKCE are required');
      const code = `fake-google-code-${++codeNumber}`;
      const identity = typeof options.identity === 'function' ? options.identity(url, codeNumber) : options.identity;
      codes.set(code, { challenge, redirectUri, identity });
      return { code, state };
    },
    async fetch(input, init = {}) {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      if (url.origin !== FAKE_GOOGLE_ISSUER) return json({ error: 'not_found' }, 404);
      if (url.pathname === '/token' && method === 'POST') {
        const rawBody = init.body;
        const body = rawBody instanceof URLSearchParams ? new URLSearchParams(rawBody)
          : new URLSearchParams(typeof rawBody === 'string' ? rawBody : '');
        const code = body.get('code') ?? '';
        const pending = codes.get(code);
        if (!pending || body.get('grant_type') !== 'authorization_code'
          || body.get('client_id') !== options.clientId
          || body.get('client_secret') !== clientSecret
          || body.get('redirect_uri') !== redirectUri
          || !body.get('code_verifier')
          || createHash('sha256').update(body.get('code_verifier')!).digest('base64url') !== pending.challenge) {
          return json({ error: 'invalid_grant' }, 400);
        }
        codes.delete(code);
        const accessToken = `fake-google-access-${tokens.size + 1}`;
        tokens.set(accessToken, pending.identity);
        return json({ access_token: accessToken, token_type: 'Bearer', scope: GOOGLE_MEMBER_SCOPES.join(' ') });
      }
      if (url.pathname === '/userinfo' && method === 'GET') {
        const bearer = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') ?? '')?.[1];
        const identity = bearer ? tokens.get(bearer) : undefined;
        if (!identity) return json({ error: 'unauthorized' }, 401);
        return json({ sub: identity.sub, email: identity.email, email_verified: identity.emailVerified, name: identity.name });
      }
      return json({ error: 'not_found' }, 404);
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
