import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { generatePkcePair } from '../../oauth/pkce.js';
import type { GoogleMemberIdentity, MemberSignupIntent, MemberStore } from './member-store.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const APPROVED_SCOPES = ['email', 'openid', 'profile'] as const;
// 출처: #89454 — encrypted OAuth state is short-lived; retain the prior 10-minute state TTL.
export const STATE_TTL_MS = 10 * 60_000;
// Source: KAIST 강당 300명 동시 · 1분 창
// One shared public IP can have 300 legitimate starts in a minute.
// Keep a finite per-network cap with 20% headroom for retries.
const START_RATE_WINDOW_MS = 60_000;
const START_RATE_LIMIT = 360;

export class GoogleSignupRateLimitedError extends Error {
  constructor() { super('Google signup start rate limit exceeded'); }
}

interface SignupCookiePayload {
  readonly version: 1;
  readonly state: string;
  readonly verifier: string;
  readonly intent: MemberSignupIntent;
  readonly expiresAt: number;
}

function encryptionKey(secret: string): Buffer {
  if (!secret.trim()) throw new Error('Google OAuth state encryption key is not configured');
  return createHash('sha256').update(secret).digest();
}

function encryptPayload(payload: SignupCookiePayload, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('elanous-member-google-oauth-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

function decryptPayload(value: string, key: Buffer): SignupCookiePayload | null {
  try {
    const [nonceText, tagText, ciphertextText, ...extra] = value.split('.');
    if (!nonceText || !tagText || !ciphertextText || extra.length || value.length > 4096) return null;
    const nonce = Buffer.from(nonceText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    const ciphertext = Buffer.from(ciphertextText, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16 || !ciphertext.length) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from('elanous-member-google-oauth-v1'));
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as Partial<SignupCookiePayload>;
    if (payload.version !== 1 || typeof payload.state !== 'string' || typeof payload.verifier !== 'string'
      || typeof payload.expiresAt !== 'number' || !payload.intent || typeof payload.intent !== 'object') return null;
    return payload as SignupCookiePayload;
  } catch { return null; }
}

export interface GoogleSigninOptions {
  readonly clientId: () => Promise<string | undefined>;
  readonly clientSecret: () => Promise<string | undefined>;
  /** Random deployment secret stored in the credential manager as GOOGLE_OAUTH_STATE_ENCRYPTION_KEY. */
  readonly stateEncryptionKey: () => Promise<string | undefined>;
  /** Fixed deployment setting; never read from a request or Host header. */
  readonly redirectUri: string;
  readonly store: Pick<MemberStore, 'consumeOAuthState' | 'recordSignupStart'>;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly userinfoEndpoint?: string;
}

export interface GoogleSignin {
  readonly redirectUri: string;
  start(intent: MemberSignupIntent, networkKey?: string): Promise<{ authorizationUrl: string; state: string; cookieValue: string; maxAgeSeconds: number }>;
  complete(code: string, state: string, cookieValue: string): Promise<{ identity: GoogleMemberIdentity; intent: MemberSignupIntent }>;
}

function allowedGrantedScopes(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return true; // Google may omit this field.
  const normalized = new Set(value.split(/\s+/).map(scope => {
    if (scope === 'https://www.googleapis.com/auth/userinfo.email') return 'email';
    if (scope === 'https://www.googleapis.com/auth/userinfo.profile') return 'profile';
    return scope;
  }));
  return normalized.size === APPROVED_SCOPES.length && APPROVED_SCOPES.every(scope => normalized.has(scope));
}

/** Server-side authorization-code flow. Provider tokens are used transiently and never persisted. */
export function createGoogleSignin(options: GoogleSigninOptions): GoogleSignin {
  const redirectUri = new URL(options.redirectUri);
  if (redirectUri.protocol !== 'https:' && redirectUri.hostname !== 'localhost') throw new Error('Google OAuth redirect URI must use HTTPS');
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const authEndpoint = options.authorizationEndpoint ?? GOOGLE_AUTH;
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN;
  const userinfoEndpoint = options.userinfoEndpoint ?? GOOGLE_USERINFO;

  return {
    redirectUri: redirectUri.toString(),
    async start(intent, networkKey) {
      const clientId = (await options.clientId())?.trim();
      if (!clientId) throw new Error('Google OAuth client is not configured');
      const secret = await options.stateEncryptionKey();
      if (!secret) throw new Error('Google OAuth state encryption key is not configured');
      const at = now();
      if (!options.store.recordSignupStart(networkKey ?? 'unknown', new Date(at).toISOString(),
        new Date(at - START_RATE_WINDOW_MS).toISOString(), START_RATE_LIMIT)) throw new GoogleSignupRateLimitedError();
      const pair = generatePkcePair();
      const expiresAt = at + STATE_TTL_MS;
      const cookieValue = encryptPayload({ version: 1, state: pair.state, verifier: pair.verifier, intent, expiresAt }, encryptionKey(secret));
      const url = new URL(authEndpoint);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri.toString());
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', APPROVED_SCOPES.join(' '));
      url.searchParams.set('state', pair.state);
      url.searchParams.set('code_challenge', pair.challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('prompt', 'select_account');
      return { authorizationUrl: url.toString(), state: pair.state, cookieValue, maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000) };
    },
    async complete(code, state, cookieValue) {
      if (!code || code.length > 4096 || !state || state.length > 512) throw new Error('invalid Google OAuth callback');
      const secret = await options.stateEncryptionKey();
      if (!secret) throw new Error('Google OAuth state encryption key is not configured');
      const pending = decryptPayload(cookieValue, encryptionKey(secret));
      const at = now();
      if (!pending || pending.state !== state || pending.expiresAt <= at
        || !options.store.consumeOAuthState(createHash('sha256').update(state).digest('hex'), new Date(pending.expiresAt).toISOString(), new Date(at).toISOString())) {
        throw new Error('Google OAuth state expired, invalid, or already used');
      }
      const [clientId, clientSecret] = await Promise.all([options.clientId(), options.clientSecret()]);
      if (!clientId?.trim() || !clientSecret?.trim()) throw new Error('Google OAuth client is not configured');
      const tokenResponse = await fetchImpl(tokenEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId.trim(), client_secret: clientSecret, redirect_uri: redirectUri.toString(), code_verifier: pending.verifier }),
      });
      if (!tokenResponse.ok) throw new Error('Google OAuth code exchange failed');
      const token = await tokenResponse.json() as { access_token?: unknown; token_type?: unknown; scope?: unknown };
      if (typeof token.access_token !== 'string' || !token.access_token || (token.token_type && token.token_type !== 'Bearer') || !allowedGrantedScopes(token.scope)) {
        throw new Error('Google OAuth token response invalid');
      }
      const response = await fetchImpl(userinfoEndpoint, { headers: { authorization: `Bearer ${token.access_token}` } });
      if (!response.ok) throw new Error('Google identity lookup failed');
      const profile = await response.json() as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown };
      if (typeof profile.sub !== 'string' || !profile.sub || typeof profile.email !== 'string'
        || typeof profile.name !== 'string' || profile.email_verified !== true) throw new Error('Google account must have a verified email');
      return {
        identity: { sub: profile.sub, email: profile.email, emailVerified: true, name: profile.name },
        intent: pending.intent,
      };
    },
  };
}
