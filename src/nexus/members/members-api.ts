import { isIP } from 'node:net';
import { OAuth2Client } from 'google-auth-library';
import type { GoogleSignin } from './google-signin.js';
import { createGoogleSignin, GoogleSignupRateLimitedError } from './google-signin.js';
import { getSecretAsync } from '../config/secrets/index.js';
import { corsPreflight } from '../api/json-response.js';
import { createMemberStore, type MemberStore, type MemberSignupIntent } from './member-store.js';
import { createAppLifecycleStore, type AppLifecycleStore } from '../apps/app-db.js';
import type { MemberAppSlot } from './member-store.js';
import type { VerifiedAppOwner } from '../apps/app-host.js';

export const MEMBER_GOOGLE_CALLBACK_PATH = '/v1/members/oauth/google/callback';
const MEMBER_COOKIE = '__Host-elanous_member_session';
const OAUTH_STATE_COOKIE = '__Host-elanous_member_oauth_state';
const MAX_BODY_BYTES = 16 * 1024;

export function normalizeMemberSignupNetworkKey(address: string): string {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (isIP(value) === 4) return `ipv4:${value}`;
  if (isIP(value) !== 6) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped && isIP(mapped[1]!) === 4) return `ipv4:${mapped[1]}`;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  const normalized = dotted && isIP(dotted[1]!) === 4
    ? value.slice(0, -dotted[1]!.length) + dotted[1]!.split('.').map(Number).reduce((groups, octet, index) => {
      if (index % 2 === 0) groups.push(octet << 8);
      else groups[groups.length - 1] = groups[groups.length - 1]! | octet;
      return groups;
    }, [] as number[]).map(group => group.toString(16)).join(':')
    : value;
  const [left = '', right = ''] = normalized.split('::');
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  const groups = normalized.includes('::')
    ? [...leftGroups, ...Array(Math.max(0, 8 - leftGroups.length - rightGroups.length)).fill('0'), ...rightGroups]
    : normalized.split(':');
  if (groups.length !== 8) return 'unknown';
  // /48 coalesces privacy-address and delegated /56-/64 rotation within one subscriber allocation.
  return `ipv6:${groups.slice(0, 3).map(group => Number.parseInt(group, 16).toString(16).padStart(4, '0')).join(':')}/48`;
}

export interface MembersApi {
  handle(request: Request, networkKey?: string): Promise<Response | undefined>;
}

export interface MembersApiOptions {
  readonly store: MemberStore;
  readonly google: GoogleSignin;
  /** Fixed post-signup destination, never accepted from request data. */
  readonly successRedirectUri: string;
  /** Exact website origin allowed to use the member cookie cross-origin. */
  readonly webOrigin?: string;
  readonly now?: () => number;
  readonly appLifecycle?: Pick<AppLifecycleStore, 'ensureCreated'>;
  /** Lazily resolve the lifecycle store so transient startup failures can recover on a later read. */
  readonly getAppLifecycle?: () => Pick<AppLifecycleStore, 'ensureCreated'>;
  /** Verifies a native Google ID token and returns only its provider subject. */
  readonly verifyMobileGoogleIdToken?: (idToken: string) => Promise<string | null>;
  /** Issues an app-scoped session after the member and app slot have been resolved server-side. */
  readonly issueOwnerSession?: (appId: string, memberId: string) => { readonly sessionToken: string; readonly expiresAt: string };
  readonly resolveVerifiedOwner?: (appSlug: string, sessionCredential: string, members: Pick<MemberStore, 'memberPlanForMember'>) => VerifiedAppOwner | null;
  readonly publicAppUrl?: (slot: MemberAppSlot) => string | null;
}

export class GoogleMobileVerificationUnavailableError extends Error {
  constructor() { super('Google ID-token verification service is unavailable'); }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error('body-too-large');
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('body-too-large');
  try { return JSON.parse(text); } catch { throw new Error('invalid-json'); }
}

function signupIntent(body: unknown): MemberSignupIntent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !['consents', 'referralCode', 'eventCode'].includes(key))) return null;
  if (!value.consents || typeof value.consents !== 'object' || Array.isArray(value.consents)) return null;
  const raw = value.consents as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['privacy', 'terms'].includes(key))
    || typeof raw.privacy !== 'string' || !raw.privacy.trim()
    || typeof raw.terms !== 'string' || !raw.terms.trim()) return null;
  if (value.referralCode !== undefined && (typeof value.referralCode !== 'string' || value.referralCode.length > 80)) return null;
  if (value.eventCode !== undefined && (typeof value.eventCode !== 'string' || value.eventCode.length > 80)) return null;
  return {
    consents: { privacy: raw.privacy.trim(), terms: raw.terms.trim() },
    ...(typeof value.referralCode === 'string' && value.referralCode.trim() ? { referralCode: value.referralCode.trim() } : {}),
    ...(typeof value.eventCode === 'string' && value.eventCode.trim() ? { eventCode: value.eventCode.trim() } : {}),
  };
}

function sessionFromCookie(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  const token = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${MEMBER_COOKIE}=`))?.slice(MEMBER_COOKIE.length + 1);
  if (!token) return null;
  try { return decodeURIComponent(token); } catch { return null; }
}

function cookieValue(request: Request, name: string): string | null {
  const value = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

function cookie(token: string, maxAgeSeconds: number): string {
  return `${MEMBER_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function expiredCookie(): string {
  return `${MEMBER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function stateCookie(value: string, maxAgeSeconds: number): string {
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function expiredStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function publicAppSlot(slot: MemberAppSlot, publicUrl: string | null): { appId: string; appSlug: string; templateSlug: string; createdAt: string; url: string | null } {
  return { appId: slot.appId, appSlug: slot.appSlug, templateSlug: slot.templateSlug, createdAt: slot.createdAt, url: publicUrl };
}

function withCors(request: Request, response: Response, webOrigin: string): Response {
  if (request.headers.get('origin') !== webOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', webOrigin);
  headers.set('access-control-allow-credentials', 'true');
  headers.append('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Signup and the small authenticated member surface. Provider data and token values never enter responses. */
export function createMembersApi(options: MembersApiOptions): MembersApi {
  const callback = new URL(options.google.redirectUri);
  if (callback.pathname !== MEMBER_GOOGLE_CALLBACK_PATH || callback.search || callback.hash
    || (callback.protocol !== 'https:' && callback.hostname !== 'localhost')) {
    throw new Error(`Google OAuth redirect URI must be a fixed HTTPS URL at ${MEMBER_GOOGLE_CALLBACK_PATH}`);
  }
  const success = new URL(options.successRedirectUri);
  if (success.protocol !== 'https:' && success.hostname !== 'localhost') throw new Error('member success redirect must use HTTPS');
  const webOrigin = options.webOrigin ?? success.origin;
  if (new URL(webOrigin).origin !== webOrigin || (new URL(webOrigin).protocol !== 'https:' && new URL(webOrigin).hostname !== 'localhost')) {
    throw new Error('member web origin must be a fixed HTTPS origin');
  }
  const now = options.now ?? Date.now;
  const synchronizeAppSlot = (memberId: string): MemberAppSlot | null => {
    const slot = options.store.appSlotForMember(memberId);
    if (slot) {
      // The member DB keeps the event as an outbox. Replaying this stable creation event repairs
      // a prior lifecycle-store outage without creating another app or copying template data.
      try {
        (options.getAppLifecycle?.() ?? options.appLifecycle)?.ensureCreated(slot.lifecycleEvent);
      } catch { /* the outbox event is retried on the next member read */ }
    }
    return slot;
  };

  return {
    async handle(request, networkKey = 'unknown') {
      const url = new URL(request.url);
      const path = url.pathname;
      if (!path.startsWith('/v1/members')) return undefined;
      const origin = request.headers.get('origin');
      if (origin && origin !== webOrigin && request.method !== 'GET') return json({ error: 'origin-not-allowed' }, 403);
      if (request.method === 'OPTIONS' && [
        '/v1/members', '/v1/members/validate-code', '/v1/members/app-slot', '/v1/members/app-slot/session', '/v1/members/owner', MEMBER_GOOGLE_CALLBACK_PATH,
      ].includes(path)) {
        if (origin !== webOrigin) return new Response(null, { status: 403 });
        return withCors(request, corsPreflight('GET, POST, DELETE, OPTIONS'), webOrigin);
      }
      if (path === '/v1/members/oauth/google/callback') {
        if (request.method !== 'GET') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        if (url.searchParams.has('error')) {
          const state = url.searchParams.get('state') ?? '';
          const denied = json({ error: 'google-signin-denied' }, 400);
          denied.headers.append('set-cookie', expiredStateCookie());
          return withCors(request, denied, webOrigin);
        }
        const code = url.searchParams.get('code') ?? '';
        const state = url.searchParams.get('state') ?? '';
        if (!state || !/^[A-Za-z0-9_-]{1,128}$/.test(state)) {
          return withCors(request, json({ error: 'google-signin-failed' }, 401), webOrigin);
        }
        try {
          const encryptedState = cookieValue(request, OAUTH_STATE_COOKIE);
          if (!encryptedState) throw new Error('Google OAuth state cookie missing');
          const result = await options.google.complete(code, state, encryptedState);
          const member = options.store.register(result.identity, result.intent, new Date(now()).toISOString());
          synchronizeAppSlot(member.id);
          const session = options.store.createSession(member.id, new Date(now()).toISOString());
          const response = new Response(null, { status: 303, headers: { location: success.toString(), 'cache-control': 'no-store' } });
          response.headers.append('set-cookie', cookie(session.token, Math.max(0, Math.floor((Date.parse(session.expiresAt) - now()) / 1000))));
          response.headers.append('set-cookie', expiredStateCookie());
          return withCors(request, response, webOrigin);
        } catch {
          const failed = json({ error: 'google-signin-failed' }, 401);
          failed.headers.append('set-cookie', expiredStateCookie());
          return withCors(request, failed, webOrigin);
        }
      }
      if (path === '/v1/members/validate-code') {
        if (request.method !== 'POST') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        let body: unknown;
        try { body = await readJson(request); } catch { return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin);
        const input = body as Record<string, unknown>;
        if (Object.keys(input).some(key => !['code', 'kind'].includes(key)) || typeof input.code !== 'string'
          || input.code.length > 80 || (input.kind !== undefined && input.kind !== 'referral' && input.kind !== 'event')) return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin);
        return withCors(request, json(options.store.validateCode(input.code, input.kind as 'referral' | 'event' | undefined, new Date(now()).toISOString())), webOrigin);
      }
      if (path === '/v1/members/owner') {
        if (request.method !== 'GET') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        const appSlug = url.searchParams.get('appSlug') ?? '';
        const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
        const credential = bearer ?? request.headers.get('cookie') ?? '';
        const owner = options.resolveVerifiedOwner?.(appSlug, credential, options.store);
        return withCors(request, owner ? json(owner) : json({ error: 'unauthorized' }, 401), webOrigin);
      }
      if (path === '/v1/members' && request.method === 'POST') {
        let body: unknown;
        try { body = await readJson(request); } catch { return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin); }
        const intent = signupIntent(body);
        if (!intent) return withCors(request, json({ error: 'invalid-signup' }, 400), webOrigin);
        if (intent.referralCode && !options.store.validateCode(intent.referralCode, 'referral', new Date(now()).toISOString()).valid) return withCors(request, json({ error: 'invalid-referral-code' }, 400), webOrigin);
        if (intent.eventCode && !options.store.validateCode(intent.eventCode, 'event', new Date(now()).toISOString()).valid) return withCors(request, json({ error: 'invalid-event-code' }, 400), webOrigin);
        try {
          const started = await options.google.start(intent, normalizeMemberSignupNetworkKey(networkKey));
          const response = json({ authorizationUrl: started.authorizationUrl }, 201);
          response.headers.append('set-cookie', stateCookie(started.cookieValue, started.maxAgeSeconds));
          return withCors(request, response, webOrigin);
        }
        catch (error) {
          if (error instanceof GoogleSignupRateLimitedError) return withCors(request, json({ error: 'rate-limited' }, 429), webOrigin);
          return withCors(request, json({ error: 'signup-unavailable' }, 503), webOrigin);
        }
      }
      if (path === '/v1/members' && request.method === 'GET') {
        const token = sessionFromCookie(request);
        const member = token ? options.store.memberForSession(token, new Date(now()).toISOString()) : null;
        if (!member) return withCors(request, json({ error: 'unauthorized' }, 401), webOrigin);
        const slot = synchronizeAppSlot(member.id);
        return withCors(request, json({ member, ...(slot ? { appSlot: publicAppSlot(slot, options.publicAppUrl?.(slot) ?? null) } : {}) }), webOrigin);
      }
      if (path === '/v1/members/app-slot') {
        if (request.method !== 'GET' && request.method !== 'POST') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        const token = sessionFromCookie(request);
        const member = token ? options.store.memberForSession(token, new Date(now()).toISOString()) : null;
        if (!member) return withCors(request, json({ error: 'unauthorized' }, 401), webOrigin);
        if (request.method === 'GET') {
          const slot = synchronizeAppSlot(member.id);
          return withCors(request, slot ? json({ appSlot: publicAppSlot(slot, options.publicAppUrl?.(slot) ?? null) }) : json({ error: 'app-slot-not-found' }, 404), webOrigin);
        }
        const created = options.store.createAppSlotForMember(member.id, new Date(now()).toISOString());
        if (created.outcome === 'already-exists') return withCors(request, json({ error: 'app-slot-already-exists' }, 409), webOrigin);
        if (created.outcome !== 'created') return withCors(request, json({ error: 'event-code-required' }, 403), webOrigin);
        synchronizeAppSlot(member.id);
        return withCors(request, json({ appSlot: publicAppSlot(created.slot, options.publicAppUrl?.(created.slot) ?? null) }, 201), webOrigin);
      }
      if (path === '/v1/members/app-slot/session') {
        if (request.method !== 'POST') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        if (!options.verifyMobileGoogleIdToken || !options.issueOwnerSession) {
          return withCors(request, json({ error: 'mobile-session-unavailable' }, 503), webOrigin);
        }
        let body: unknown;
        try { body = await readJson(request); } catch { return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin);
        const input = body as Record<string, unknown>;
        if (Object.keys(input).length !== 1 || typeof input.googleIdToken !== 'string'
          || !input.googleIdToken.trim() || input.googleIdToken.length > 8_192) {
          return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin);
        }
        let sub: string | null;
        try { sub = await options.verifyMobileGoogleIdToken(input.googleIdToken); }
        catch (error) {
          const status = error instanceof GoogleMobileVerificationUnavailableError ? 503 : 401;
          return withCors(request, json({ error: status === 503 ? 'google-verification-unavailable' : 'unauthorized' }, status), webOrigin);
        }
        if (!sub) return withCors(request, json({ error: 'unauthorized' }, 401), webOrigin);
        const member = options.store.memberForGoogleSub(sub);
        if (!member) return withCors(request, json({ error: 'unauthorized' }, 401), webOrigin);
        const slot = synchronizeAppSlot(member.id);
        if (!slot) return withCors(request, json({ error: 'app-slot-not-found' }, 404), webOrigin);
        try {
          const session = options.issueOwnerSession(slot.appSlug, member.id);
          return withCors(request, json({ appId: slot.appId, sessionToken: session.sessionToken,
            tokenType: 'Bearer', expiresAt: session.expiresAt }), webOrigin);
        } catch {
          return withCors(request, json({ error: 'app-session-unavailable' }, 503), webOrigin);
        }
      }
      if (path === '/v1/members' && request.method === 'DELETE') {
        if (origin !== webOrigin) return json({ error: 'origin-not-allowed' }, 403);
        const token = sessionFromCookie(request);
        if (!token || !options.store.requestDeletion(token, new Date(now()).toISOString())) return withCors(request, json({ error: 'unauthorized' }, 401), webOrigin);
        const response = json({ deletionRequested: true }, 202);
        response.headers.append('set-cookie', expiredCookie());
        return withCors(request, response, webOrigin);
      }
      if (path === '/v1/members') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
      return withCors(request, json({ error: 'not-found' }, 404), webOrigin);
    },
  };
}

/** Builds the daemon's singleton member API only when its deployment URLs are explicitly configured. */
export function createConfiguredMembersApi(options: Pick<MembersApiOptions, 'issueOwnerSession' | 'resolveVerifiedOwner' | 'publicAppUrl'> = {}): MembersApi | null {
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!redirectUri) return null;
  const store = createMemberStore();
  let appLifecycle: AppLifecycleStore | undefined;
  const getAppLifecycle = () => appLifecycle ??= createAppLifecycleStore();
  const eventCode = process.env.KAIST_MEMBER_EVENT_CODE?.trim();
  const maxUses = Number(process.env.KAIST_MEMBER_EVENT_MAX_USES);
  if (eventCode && Number.isSafeInteger(maxUses) && maxUses > 0) store.provisionEventCode({ code: eventCode, maxUses });
  const google = createGoogleSignin({
    clientId: () => getSecretAsync('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: () => getSecretAsync('GOOGLE_OAUTH_CLIENT_SECRET'),
    stateEncryptionKey: () => getSecretAsync('GOOGLE_OAUTH_STATE_ENCRYPTION_KEY'),
    redirectUri,
    store,
  });
  const successRedirectUri = process.env.MEMBER_SIGNUP_SUCCESS_REDIRECT_URI?.trim()
    || new URL('/signup/complete', redirectUri).toString();
  const webOrigin = process.env.MEMBER_SIGNUP_WEB_ORIGIN?.trim() || new URL(successRedirectUri).origin;
  const mobileClientIds = (process.env.GOOGLE_MOBILE_OAUTH_CLIENT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const mobileVerifier = mobileClientIds.length > 0 ? createMobileGoogleIdTokenVerifier(mobileClientIds) : undefined;
  return createMembersApi({ store, google, successRedirectUri, webOrigin, getAppLifecycle,
    ...(mobileVerifier ? { verifyMobileGoogleIdToken: mobileVerifier } : {}),
    ...(options.issueOwnerSession ? { issueOwnerSession: options.issueOwnerSession } : {}),
    ...(options.resolveVerifiedOwner ? { resolveVerifiedOwner: options.resolveVerifiedOwner } : {}),
    ...(options.publicAppUrl ? { publicAppUrl: options.publicAppUrl } : {}),
  });
}

export interface GoogleMobileIdTokenClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly sub?: unknown;
}

/** Exact issuer, an allowlisted native audience, an unexpired token, and a non-empty subject are required. */
export function googleMobileSubjectFromClaims(
  claims: GoogleMobileIdTokenClaims | undefined,
  allowedAudiences: readonly string[],
  now = Date.now(),
): string | null {
  if (!claims || !allowedAudiences.length || (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com')
    || typeof claims.aud !== 'string' || !allowedAudiences.includes(claims.aud)
    || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp * 1_000 <= now
    || typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 256) return null;
  return claims.sub;
}

function createMobileGoogleIdTokenVerifier(audiences: readonly string[]): (idToken: string) => Promise<string | null> {
  const client = new OAuth2Client();
  return async idToken => {
    if (!idToken || idToken.length > 8_192) return null;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: [...audiences] });
      return googleMobileSubjectFromClaims(ticket.getPayload(), audiences);
    } catch (error) {
      const failure = error as { name?: unknown; response?: { status?: unknown } };
      if (failure?.name === 'GaxiosError') {
        const status = typeof failure.response?.status === 'number' ? failure.response.status : undefined;
        if (status === undefined || status === 429 || status >= 500) throw new GoogleMobileVerificationUnavailableError();
      }
      return null;
    }
  };
}
