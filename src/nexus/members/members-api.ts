import { randomBytes } from 'node:crypto';
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
import type { GraphCapabilityRegistry } from '../../graph-runner/capabilities.js';
import { createMemberTokenApi } from './member-token-api.js';
import type { MemberAccessMatch } from './member-store.js';
import { KCB_EVENT_CODE, KCB_TRY_EXAMPLES, KCB_TRY_MAX_ATTEMPTS, KCB_TRY_MAX_INPUT_CHARS,
  runKcbTryExample, type KcbTryExampleId } from './kcb-try.js';
import { runKcbTryWithinDeadline } from './kcb-try-deadline.js';

export const MEMBER_GOOGLE_CALLBACK_PATH = '/v1/members/oauth/google/callback';
const MEMBER_COOKIE = '__Host-elanous_member_session';
const OAUTH_STATE_COOKIE = '__Host-elanous_member_oauth_state';
const MAX_BODY_BYTES = 16 * 1024;
const APP_AUTH_CODE_TTL_MS = 2 * 60_000;
const APP_SLOT_EXCHANGE_PATH = '/v1/members/app-slot/exchange';

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
  /** Shared graph capability providers may be injected for route adapters without changing route behavior. */
  readonly capabilityProviders?: GraphCapabilityRegistry;
  handle(request: Request, networkKey?: string): Promise<Response | undefined>;
  handleToken?(request: Request): Promise<Response>;
  memberForScope?(request: Request, scope: string, audience?: string): MemberAccessMatch | null;
}

export interface MembersApiOptions {
  readonly store: MemberStore;
  readonly google: GoogleSignin;
  /** Fixed post-signup destination, never accepted from request data. */
  readonly successRedirectUri: string;
  /** KCB QR members land on the try cards; ordinary signup keeps its configured destination. */
  readonly kcbSuccessRedirectUri?: string;
  /** Exact native callback URIs accepted from signup requests. */
  readonly appAuthRedirectUris?: readonly string[];
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
  readonly resolveVerifiedMemberOwner?: (sessionCredential: string, members: Pick<MemberStore, 'memberPlanForMember'>) => VerifiedAppOwner | null;
  readonly publicAppUrl?: (slot: MemberAppSlot) => string | null;
  /** Shared provider registry for graph-backed member route adapters. */
  readonly capabilityProviders?: GraphCapabilityRegistry;
  readonly runTryExample?: (exampleId: KcbTryExampleId, input: string, signal?: AbortSignal) => Promise<string>;
}

export class GoogleMobileVerificationUnavailableError extends Error {
  constructor() { super('Google ID-token verification service is unavailable'); }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function memberInviteLink(webOrigin: string, referralCode: string): string {
  const invite = new URL('/app/signup', webOrigin);
  invite.searchParams.set('referralCode', referralCode);
  return invite.toString();
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
  if (Object.keys(value).some(key => !['consents', 'referralCode', 'eventCode', 'appRedirectUri', 'appCodeChallenge'].includes(key))) return null;
  if (!value.consents || typeof value.consents !== 'object' || Array.isArray(value.consents)) return null;
  const raw = value.consents as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['privacy', 'terms'].includes(key))
    || typeof raw.privacy !== 'string' || !raw.privacy.trim()
    || typeof raw.terms !== 'string' || !raw.terms.trim()) return null;
  if (value.referralCode !== undefined && (typeof value.referralCode !== 'string' || value.referralCode.length > 80)) return null;
  if (value.eventCode !== undefined && (typeof value.eventCode !== 'string' || value.eventCode.length > 80)) return null;
  if (value.appRedirectUri !== undefined && (typeof value.appRedirectUri !== 'string' || value.appRedirectUri.length > 512)) return null;
  if (value.appCodeChallenge !== undefined && (typeof value.appCodeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.appCodeChallenge))) return null;
  if ((value.appRedirectUri === undefined) !== (value.appCodeChallenge === undefined)) return null;
  return {
    consents: { privacy: raw.privacy.trim(), terms: raw.terms.trim() },
    ...(typeof value.referralCode === 'string' && value.referralCode.trim() ? { referralCode: value.referralCode.trim() } : {}),
    ...(typeof value.eventCode === 'string' && value.eventCode.trim() ? { eventCode: value.eventCode.trim() } : {}),
    ...(typeof value.appRedirectUri === 'string' && value.appRedirectUri.trim() ? { appRedirectUri: value.appRedirectUri.trim() } : {}),
    ...(typeof value.appCodeChallenge === 'string' ? { appCodeChallenge: value.appCodeChallenge } : {}),
  };
}

function validAppAuthRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'elanous:' && Boolean(url.hostname) && !url.username && !url.password && !url.port
      && !url.search && !url.hash && url.toString() === value;
  } catch { return false; }
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
  const kcbSuccess = new URL(options.kcbSuccessRedirectUri ?? '/app/signup/complete/', webOrigin);
  if (kcbSuccess.origin !== webOrigin) throw new Error('KCB success redirect must share the member web origin');
  const appAuthRedirectUris = new Set(options.appAuthRedirectUris ?? []);
  if ([...appAuthRedirectUris].some(uri => !validAppAuthRedirectUri(uri))) throw new Error('app auth redirects must be exact allowlisted elanous:// URIs');
  const now = options.now ?? Date.now;
  const tokens = createMemberTokenApi({ store: options.store, now });
  let resolvedAppLifecycle: Pick<AppLifecycleStore, 'ensureCreated'> | undefined;
  let hasResolvedAppLifecycle = false;
  const appLifecycleStore = (): Pick<AppLifecycleStore, 'ensureCreated'> | undefined => {
    if (hasResolvedAppLifecycle) return resolvedAppLifecycle;
    const lifecycle = options.getAppLifecycle?.() ?? options.appLifecycle;
    if (lifecycle) {
      resolvedAppLifecycle = lifecycle;
      hasResolvedAppLifecycle = true;
    }
    return lifecycle;
  };
  const synchronizeAppSlot = (memberId: string): MemberAppSlot | null => {
    const slot = options.store.appSlotForMember(memberId);
    if (slot) {
      // The member DB keeps the event as an outbox. Replaying this stable creation event repairs
      // a prior lifecycle-store outage without creating another app or copying template data.
      try {
        appLifecycleStore()?.ensureCreated(slot.lifecycleEvent);
      } catch { /* the outbox event is retried on the next member read */ }
    }
    return slot;
  };

  return {
    ...(options.capabilityProviders ? { capabilityProviders: options.capabilityProviders } : {}),
    handleToken: request => tokens.handle(request),
    memberForScope: (request, scope, audience) => tokens.memberForScope(request, scope, audience),
    async handle(request, networkKey = 'unknown') {
      const url = new URL(request.url);
      const path = url.pathname;
      if (!path.startsWith('/v1/members') && !path.startsWith('/v1/member/keys') && !path.startsWith('/v1/member/tokens')) return undefined;
      const origin = request.headers.get('origin');
      if (request.method === 'OPTIONS' && (path.startsWith('/v1/member/keys') || path.startsWith('/v1/member/tokens'))) {
        if (origin !== webOrigin) return new Response(null, { status: 403 });
        return withCors(request, corsPreflight('GET, POST, DELETE, OPTIONS'), webOrigin);
      }
      if (origin && origin !== webOrigin && request.method !== 'GET') return json({ error: 'origin-not-allowed' }, 403);
      if (path.startsWith('/v1/member/keys') || path.startsWith('/v1/member/tokens')) {
        const respond = (response: Response) => withCors(request, response, webOrigin);
        const session = sessionFromCookie(request);
        const member = session ? options.store.memberForSession(session, new Date(now()).toISOString()) : null;
        if (!member) return respond(json({ error: 'unauthorized' }, 401));
        if (path === '/v1/member/keys' && request.method === 'GET') return respond(json({ keys: options.store.listMemberKeys(member.id) }));
        if (path === '/v1/member/tokens' && request.method === 'GET') return respond(json({ tokens: options.store.listMemberAccessTokens(member.id) }));
        if (path === '/v1/member/keys' && request.method === 'POST') {
          let body: unknown;
          try { body = await readJson(request); } catch { return respond(json({ error: 'invalid-request' }, 400)); }
          const name = (body as { name?: unknown } | null)?.name;
          if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(name)) return respond(json({ error: 'invalid-request' }, 400));
          return respond(json(options.store.createMemberKey(member.id, name), 201));
        }
        const keyPath = /^\/v1\/member\/keys\/([a-f0-9-]{36})(\/rotate)?$/.exec(path);
        if (keyPath && request.method === 'DELETE' && !keyPath[2]) return respond(options.store.revokeMemberKey(member.id, keyPath[1]!)
          ? json({ revoked: true }) : json({ error: 'not-found' }, 404));
        if (keyPath && request.method === 'POST' && keyPath[2]) {
          try { return respond(json(options.store.rotateMemberKey(member.id, keyPath[1]!), 201)); }
          catch (error) {
            if (error instanceof Error && error.message === 'member key not found') return respond(json({ error: 'not-found' }, 404));
            return respond(json({ error: 'unavailable' }, 503));
          }
        }
        const tokenPath = /^\/v1\/member\/tokens\/([a-f0-9-]{36})$/.exec(path);
        if (tokenPath && request.method === 'DELETE') return respond(options.store.revokeMemberAccessToken(member.id, tokenPath[1]!)
          ? json({ revoked: true }) : json({ error: 'not-found' }, 404));
        return respond(json({ error: 'method-not-allowed' }, 405));
      }
      if (request.method === 'OPTIONS' && [
        '/v1/members', '/v1/members/referral-code', '/v1/members/validate-code', '/v1/members/try', '/v1/members/app-slot', '/v1/members/app-slot/session', APP_SLOT_EXCHANGE_PATH, '/v1/members/owner', MEMBER_GOOGLE_CALLBACK_PATH,
      ].includes(path)) {
        if (origin !== webOrigin) return new Response(null, { status: 403 });
        return withCors(request, corsPreflight('GET, POST, DELETE, OPTIONS'), webOrigin);
      }
      if (path === '/v1/members' && request.method === 'GET' && url.searchParams.get('flow') === 'app-login') {
        const appRedirectUri = url.searchParams.get('appRedirectUri') ?? '';
        const appCodeChallenge = url.searchParams.get('appCodeChallenge') ?? '';
        if (url.searchParams.getAll('flow').length !== 1 || url.searchParams.getAll('appRedirectUri').length !== 1 || url.searchParams.getAll('appCodeChallenge').length !== 1
          || !appAuthRedirectUris.has(appRedirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(appCodeChallenge)) {
          return withCors(request, json({ error: 'invalid-app-login-start' }, 400), webOrigin);
        }
        const scriptNonce = randomBytes(18).toString('base64url');
        const page = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Elanous 회원 로그인</title><main><h1>Elanous 회원 로그인</h1><p>Google 계정으로 계속합니다.</p><form id="member-login"><label><input name="privacy" type="checkbox" required> 개인정보 처리에 동의합니다</label><label><input name="terms" type="checkbox" required> 이용약관에 동의합니다</label><label>행사 코드 <input name="eventCode" autocomplete="off" maxlength="80"></label><button type="submit">Google로 계속</button><p id="status" role="status"></p></form></main><script nonce="${scriptNonce}">(function(){const form=document.getElementById('member-login');const status=document.getElementById('status');form.addEventListener('submit',async function(event){event.preventDefault();const values=new FormData(form);const params=new URLSearchParams(location.search);status.textContent='Google 로그인으로 이동합니다…';try{const response=await fetch('/v1/members',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({consents:{privacy:values.get('privacy')==='on'?'privacy-v1':'',terms:values.get('terms')==='on'?'terms-v1':''},eventCode:String(values.get('eventCode')||''),appRedirectUri:params.get('appRedirectUri'),appCodeChallenge:params.get('appCodeChallenge')})});const body=await response.json();if(!response.ok||typeof body.authorizationUrl!=='string')throw new Error('start-failed');location.replace(body.authorizationUrl)}catch{status.textContent='로그인을 시작하지 못했습니다. 입력한 행사 코드를 확인하고 다시 시도해 주세요.'}})})();</script></html>`;
        return withCors(request, new Response(page, { headers: {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        } }), webOrigin);
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
          const { appRedirectUri, appCodeChallenge, ...memberIntent } = result.intent;
          if (Boolean(appRedirectUri) !== Boolean(appCodeChallenge)
            || (appRedirectUri && !appAuthRedirectUris.has(appRedirectUri))) throw new Error('native callback contract is invalid or no longer allowlisted');
          const member = options.store.register(result.identity, memberIntent, new Date(now()).toISOString());
          synchronizeAppSlot(member.id);
          if (appRedirectUri && appCodeChallenge) {
            if (!options.issueOwnerSession || !options.store.createAppAuthCode) throw new Error('app-slot session issuer unavailable');
            const slot = options.store.appSlotForMember(member.id);
            if (!slot) throw new Error('member app slot is unavailable');
            const exchangeCode = randomBytes(32).toString('base64url');
            const expiresAt = new Date(now() + APP_AUTH_CODE_TTL_MS).toISOString();
            options.store.createAppAuthCode!({ code: exchangeCode, state, codeChallenge: appCodeChallenge,
              memberId: member.id, appId: slot.appId, expiresAt }, new Date(now()).toISOString());
            const appCallback = new URL(appRedirectUri);
            appCallback.searchParams.set('code', exchangeCode);
            appCallback.searchParams.set('state', state);
            const response = new Response(null, { status: 303, headers: { location: appCallback.toString(), 'cache-control': 'no-store' } });
            response.headers.append('set-cookie', expiredStateCookie());
            return withCors(request, response, webOrigin);
          }
          // Registration commits the one-time key and session together. A lifecycle retry
          // must never prevent delivery of the key already committed to the member store.
          const session = member.session;
          const firstKey = member.initialKey;
          const destination = memberIntent.eventCode?.toUpperCase() === KCB_EVENT_CODE ? kcbSuccess : success;
          const safeSuccess = destination.toString().replace(/[&"<>]/g, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!);
          const response = firstKey
            ? new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Save your member key</title><h1>Save your member key</h1><p>This key is shown once. Store it privately.</p><code>${firstKey.key}</code><p><a href="${safeSuccess}" rel="noreferrer">Continue</a></p></html>`,
              { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
                'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } })
            : new Response(null, { status: 303, headers: { location: destination.toString(), 'cache-control': 'no-store' } });
          response.headers.append('set-cookie', cookie(session.token, Math.max(0, Math.floor((Date.parse(session.expiresAt) - now()) / 1000))));
          response.headers.append('set-cookie', expiredStateCookie());
          try { synchronizeAppSlot(member.id); } catch { /* outbox retries on the next member read */ }
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
      if (path === '/v1/members/try') {
        if (request.method !== 'POST') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        const session = sessionFromCookie(request);
        const member = session ? options.store.memberForSession(session, new Date(now()).toISOString()) : null;
        if (!member || member.eventCode?.toUpperCase() !== KCB_EVENT_CODE) return withCors(request, json({ error: 'unauthorized' }, 401), webOrigin);
        let body: unknown;
        try { body = await readJson(request); } catch { return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin);
        const input = body as Record<string, unknown>;
        const exampleId = input.exampleId;
        const message = input.input;
        if (Object.keys(input).length !== 2 || !KCB_TRY_EXAMPLES.some(example => example.id === exampleId)
          || typeof message !== 'string' || !message.trim() || message.length > KCB_TRY_MAX_INPUT_CHARS)
          return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin);
        if (!options.runTryExample) return withCors(request, json({ error: 'try-unavailable' }, 503), webOrigin);
        const reservationId = options.store.reserveEventTry(member.id, KCB_EVENT_CODE, KCB_TRY_MAX_ATTEMPTS, new Date(now()).toISOString());
        if (!reservationId) return withCors(request, json({ error: 'try-limit-reached' }, 429), webOrigin);
        try {
          const result = await runKcbTryWithinDeadline(
            signal => options.runTryExample!(exampleId as KcbTryExampleId, message.trim(), signal), 30_000, request.signal,
          );
          if (!result.trim()) throw new Error('empty result');
          if (!options.store.completeEventTry(reservationId, new Date(now()).toISOString())) throw new Error('try reservation expired');
          return withCors(request, json({ exampleId, result: result.slice(0, 2_000) }), webOrigin);
        } catch {
          try { options.store.releaseEventTry(reservationId); } catch { /* failed attempts should not mask the safe response */ }
          return withCors(request, json({ error: 'try-unavailable' }, 503), webOrigin);
        }
      }
      if (path === '/v1/members/owner') {
        if (request.method !== 'GET') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
        const appSlug = url.searchParams.get('appSlug');
        const memberSession = sessionFromCookie(request);
        const member = memberSession ? options.store.memberForSession(memberSession, new Date(now()).toISOString()) : null;
        const owner = appSlug
          ? options.resolveVerifiedOwner?.(appSlug, bearer ?? request.headers.get('cookie') ?? '', options.store)
          : bearer?.startsWith('aps_') ? options.resolveVerifiedMemberOwner?.(bearer, options.store)
            : member ? { memberId: member.id } : null;
        return withCors(request, owner ? json(owner) : json({ error: 'unauthorized' }, 401), webOrigin);
      }
      if (path === '/v1/members' && request.method === 'POST') {
        let body: unknown;
        try { body = await readJson(request); } catch { return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin); }
        const intent = signupIntent(body);
        if (!intent) return withCors(request, json({ error: 'invalid-signup' }, 400), webOrigin);
        if (intent.appRedirectUri && !appAuthRedirectUris.has(intent.appRedirectUri)) return withCors(request, json({ error: 'invalid-app-redirect' }, 400), webOrigin);
        if (intent.appRedirectUri && (!options.issueOwnerSession || !options.store.createAppAuthCode)) return withCors(request, json({ error: 'app-session-unavailable' }, 503), webOrigin);
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
        const activeCode = options.store.activeReferralCodeForMember(member.id);
        const referralCount = options.store.referralsForMember(member.id).length;
        const { invitedBy, ...ownProfile } = member;
        const publicMember = { ...ownProfile, invited: invitedBy !== null, referralCount };
        return withCors(request, json({ member: publicMember, inviteLink: activeCode ? memberInviteLink(webOrigin, activeCode) : null, referralCount,
          ...(slot ? { appSlot: publicAppSlot(slot, options.publicAppUrl?.(slot) ?? null) } : {}) }), webOrigin);
      }
      if (path === '/v1/members/referral-code') {
        if (request.method !== 'POST' && request.method !== 'DELETE') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        const token = sessionFromCookie(request);
        const member = token ? options.store.memberForSession(token, new Date(now()).toISOString()) : null;
        if (!member) return withCors(request, json({ error: 'unauthorized' }, 401), webOrigin);
        if (request.method === 'DELETE') {
          options.store.revokeReferralCode(member.id, new Date(now()).toISOString());
          return withCors(request, json({ inviteLink: null }), webOrigin);
        }
        const code = options.store.rotateReferralCode(member.id, new Date(now()).toISOString());
        return withCors(request, json({ inviteLink: memberInviteLink(webOrigin, code) }, 201), webOrigin);
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
      if (path === APP_SLOT_EXCHANGE_PATH) {
        if (request.method !== 'POST') return withCors(request, json({ error: 'method-not-allowed' }, 405), webOrigin);
        if (!options.issueOwnerSession || !options.store.consumeAppAuthCode) return withCors(request, json({ error: 'app-session-unavailable' }, 503), webOrigin);
        let body: unknown;
        try { body = await readJson(request); } catch { return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin);
        const input = body as Record<string, unknown>;
        if (Object.keys(input).length !== 3 || typeof input.code !== 'string' || typeof input.state !== 'string'
          || typeof input.codeVerifier !== 'string' || input.code.length > 128 || input.state.length > 128 || input.codeVerifier.length > 128) {
          return withCors(request, json({ error: 'invalid-request' }, 400), webOrigin);
        }
        const exchanged = options.store.consumeAppAuthCode!(input.code, input.state, input.codeVerifier, new Date(now()).toISOString());
        if (!exchanged) return withCors(request, json({ error: 'invalid-or-expired-app-auth-code' }, 401), webOrigin);
        try {
          const slot = options.store.appSlotForMember(exchanged.memberId);
          if (!slot || slot.appId !== exchanged.appId) return withCors(request, json({ error: 'app-slot-not-found' }, 404), webOrigin);
          const session = options.issueOwnerSession(slot.appSlug, exchanged.memberId);
          return withCors(request, json({ appId: slot.appId, sessionToken: session.sessionToken,
            tokenType: 'Bearer', expiresAt: session.expiresAt }), webOrigin);
        } catch { return withCors(request, json({ error: 'app-session-unavailable' }, 503), webOrigin); }
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
export function createConfiguredMembersApi(options: Pick<MembersApiOptions, 'issueOwnerSession' | 'resolveVerifiedOwner' | 'resolveVerifiedMemberOwner' | 'publicAppUrl' | 'capabilityProviders' | 'runTryExample'> = {}): MembersApi | null {
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!redirectUri) return null;
  const store = createMemberStore();
  let appLifecycle: AppLifecycleStore | undefined;
  const getAppLifecycle = () => appLifecycle ??= createAppLifecycleStore();
  const eventCode = process.env.KAIST_MEMBER_EVENT_CODE?.trim();
  const maxUses = Number(process.env.KAIST_MEMBER_EVENT_MAX_USES);
  if (eventCode && Number.isSafeInteger(maxUses) && maxUses > 0) store.provisionEventCode({ code: eventCode, maxUses });
  store.provisionEventCode({ code: KCB_EVENT_CODE, maxUses: 300,
    startsAt: '2026-11-12T15:00:00Z', endsAt: '2026-11-15T15:00:00Z' });
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
  const appAuthRedirectUris = (process.env.MEMBER_APP_AUTH_REDIRECT_URIS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return createMembersApi({ store, google, successRedirectUri, webOrigin, getAppLifecycle,
    appAuthRedirectUris,
    ...(mobileVerifier ? { verifyMobileGoogleIdToken: mobileVerifier } : {}),
    ...(options.issueOwnerSession ? { issueOwnerSession: options.issueOwnerSession } : {}),
    ...(options.resolveVerifiedOwner ? { resolveVerifiedOwner: options.resolveVerifiedOwner } : {}),
    ...(options.resolveVerifiedMemberOwner ? { resolveVerifiedMemberOwner: options.resolveVerifiedMemberOwner } : {}),
    ...(options.publicAppUrl ? { publicAppUrl: options.publicAppUrl } : {}),
    ...(options.capabilityProviders ? { capabilityProviders: options.capabilityProviders } : {}),
    runTryExample: options.runTryExample ?? runKcbTryExample,
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
