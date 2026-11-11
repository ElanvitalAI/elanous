import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createFakeGoogleOAuthWorld, FAKE_GOOGLE_ISSUER, GOOGLE_MEMBER_SCOPES } from './fake-google-oauth.js';
import { createGoogleSignin } from '../nexus/members/google-signin.js';
import { createMembersApi, normalizeMemberSignupNetworkKey } from '../nexus/members/members-api.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createAppLifecycleEvent } from '../nexus/apps/app-lifecycle-ledger.js';
import { createAppLifecycleStore } from '../nexus/apps/app-db.js';
import { isPublicRoute } from '../nexus/api/public-routes.js';
import { routeRequest } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';

const CLIENT_ID = 'member-client-test';
const REDIRECT = 'https://api.example.test/v1/members/oauth/google/callback';

function authorizationUrl(overrides: Record<string, string> = {}): URL {
  const url = new URL('/o/oauth2/v2/auth', FAKE_GOOGLE_ISSUER);
  const verifier = 'test-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
  const fields: Record<string, string> = {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: GOOGLE_MEMBER_SCOPES.join(' '),
    state: 'test-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  return url;
}

function world() {
  return createFakeGoogleOAuthWorld({ clientId: CLIENT_ID, redirectUri: REDIRECT, identity: {
    sub: 'google-subject-1', email: 'member@example.test', emailVerified: true, name: 'Test Member',
  } });
}

describe('fake Google OAuth member boundary', () => {
  test('requires only the approved scope set, fixed callback, state, and S256 PKCE', () => {
    const google = world();
    expect(google.authorize(authorizationUrl()).state).toBe('test-state');
    expect(() => google.authorize(authorizationUrl({ scope: 'openid email profile drive' }))).toThrow('scope set');
    expect(() => google.authorize(authorizationUrl({ redirect_uri: 'https://attacker.test/callback' }))).toThrow('redirect URI');
    expect(() => google.authorize(authorizationUrl({ code_challenge_method: 'plain' }))).toThrow('S256 PKCE');
  });

  test('exchanges a code once with matching verifier and returns identity only to its bearer', async () => {
    const google = world();
    const verifier = 'test-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const { code } = google.authorize(authorizationUrl());
    const exchange = (codeVerifier: string) => google.fetch(`${FAKE_GOOGLE_ISSUER}/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT_ID, client_secret: 'fake-google-client-secret', redirect_uri: REDIRECT, code_verifier: codeVerifier }).toString(),
    });
    expect((await exchange('wrong-verifier')).status).toBe(400);
    const token = await exchange(verifier);
    expect(token.status).toBe(200);
    const accessToken = (await token.json() as { access_token: string }).access_token;
    expect((await exchange(verifier)).status).toBe(400);
    expect(await (await google.fetch(`${FAKE_GOOGLE_ISSUER}/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } })).json()).toEqual({
      sub: 'google-subject-1', email: 'member@example.test', email_verified: true, name: 'Test Member',
    });
    expect((await google.fetch(`${FAKE_GOOGLE_ISSUER}/userinfo`)).status).toBe(401);
  });

  test('rate-limits signup starts per network while retaining no pending signup payloads', () => {
    let clock = Date.parse('2026-11-14T01:00:00.000Z');
    const store = createMemberStore({ path: ':memory:', now: () => clock });
    const start = (network: string) => store.recordSignupStart(network, new Date(clock).toISOString(), new Date(clock - 60_000).toISOString(), 2);
    expect(start('network-a')).toBe(true);
    expect(start('network-a')).toBe(true);
    expect(start('network-a')).toBe(false);
    expect(start('network-b')).toBe(true);
    const stateHash = createHash('sha256').update('state-once').digest('hex');
    expect(store.consumeOAuthState(stateHash, new Date(clock + 600_000).toISOString(), new Date(clock).toISOString())).toBe(true);
    expect(store.consumeOAuthState(stateHash, new Date(clock + 600_000).toISOString(), new Date(clock).toISOString())).toBe(false);
    expect(normalizeMemberSignupNetworkKey('2001:db8:abcd:12::1')).toBe(normalizeMemberSignupNetworkKey('2001:db8:abcd:13::ffff'));
    expect(normalizeMemberSignupNetworkKey('2001:db8:abce:12::1')).not.toBe(normalizeMemberSignupNetworkKey('2001:db8:abcd:12::1'));
    clock += 61_000;
    expect(start('network-a')).toBe(true);
    store.close();
  });

  test('KAIST shared public IP permits 300 starts and still rejects excess starts', async () => {
    const now = () => Date.parse('2026-11-14T01:00:00.000Z');
    const store = createMemberStore({ path: ':memory:', now });
    const google = createGoogleSignin({
      clientId: async () => CLIENT_ID,
      clientSecret: async () => 'fake-google-client-secret',
      stateEncryptionKey: async () => 'test-only-state-encryption-key',
      redirectUri: REDIRECT, store, now,
    });
    const api = createMembersApi({ store, google, successRedirectUri: 'https://app.example.test/signup/complete', now });
    const start = (ip: string) => api.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' } }),
    }), ip);
    try {
      const first300 = await Promise.all(Array.from({ length: 300 }, () => start('203.0.113.42')));
      expect(first300.every(response => response?.status === 201)).toBe(true);
      const next60 = await Promise.all(Array.from({ length: 60 }, () => start('203.0.113.42')));
      expect(next60.every(response => response?.status === 201)).toBe(true);
      expect((await start('203.0.113.42'))?.status).toBe(429);
      expect((await start('203.0.113.43'))?.status).toBe(201);
    } finally { store.close(); }
  });

  test('reversed Google callbacks keep each attendee identity and session separate', async () => {
    const now = () => Date.parse('2026-11-14T01:00:00.000Z');
    const store = createMemberStore({ path: ':memory:', now });
    const googleWorld = createFakeGoogleOAuthWorld({ clientId: CLIENT_ID, redirectUri: REDIRECT,
      identity: (_url, sequence) => ({ sub: `google-${sequence}`, email: `attendee-${sequence}@example.test`,
        emailVerified: true, name: `Attendee ${sequence}` }),
    });
    const google = createGoogleSignin({ clientId: async () => CLIENT_ID,
      clientSecret: async () => 'fake-google-client-secret',
      stateEncryptionKey: async () => 'test-only-state-encryption-key', redirectUri: REDIRECT,
      store, now, fetch: googleWorld.fetch,
      authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`,
      tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`, userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo`,
    });
    const api = createMembersApi({ store, google, successRedirectUri: 'https://app.example.test/signup/complete', now });
    try {
      const starts = await Promise.all([1, 2].map(() => api.handle(new Request('https://api.example.test/v1/members', {
        method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' } }),
      }), '203.0.113.42')));
      const authorizations = await Promise.all(starts.map(async response => {
        const { authorizationUrl } = await response!.json() as { authorizationUrl: string };
        return { ...googleWorld.authorize(authorizationUrl), stateCookie: response!.headers.get('set-cookie')!.split(';', 1)[0]! };
      }));
      const profiles = [];
      for (const authorization of [...authorizations].reverse()) {
        const callback = (await api.handle(new Request(`${REDIRECT}?code=${authorization.code}&state=${authorization.state}`, {
          headers: { cookie: authorization.stateCookie },
        })))!;
        expect(callback.status).toBe(200);
        const sessionCookie = callback.headers.get('set-cookie')!.split(';', 1)[0]!;
        const profile = (await api.handle(new Request('https://api.example.test/v1/members', {
          headers: { cookie: sessionCookie },
        })))!;
        profiles.push((await profile.json() as { member: { email: string } }).member.email);
      }
      expect(profiles).toEqual(['attendee-2@example.test', 'attendee-1@example.test']);
    } finally { store.close(); }
  });

  test('native Google callback returns an allowlisted one-time state-bound app-slot exchange code', async () => {
    let clock = Date.parse('2026-11-14T01:00:00.000Z');
    const now = () => clock;
    const store = createMemberStore({ path: ':memory:', now });
    // Source: #93455 — fixture event code must cover both successful app-auth attempts.
    store.provisionEventCode({ code: 'APP-AUTH', maxUses: 3 });
    const googleWorld = world();
    const google = createGoogleSignin({
      clientId: async () => CLIENT_ID, clientSecret: async () => 'fake-google-client-secret',
      stateEncryptionKey: async () => 'test-only-state-encryption-key', redirectUri: REDIRECT, store, now,
      fetch: googleWorld.fetch, authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`,
      tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`, userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo`,
    });
    const issued: Array<{ appSlug: string; memberId: string }> = [];
    const api = createMembersApi({ store, google, successRedirectUri: 'https://app.example.test/signup/complete', now,
      appAuthRedirectUris: ['elanous://auth/callback'],
      issueOwnerSession: (appSlug, memberId) => {
        issued.push({ appSlug, memberId });
        return { sessionToken: 'aps-one-time-session', expiresAt: new Date(clock + 60_000).toISOString() };
      },
    });
    const codeVerifier = 'app-verifier-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMN';
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const start = async (appRedirectUri = 'elanous://auth/callback') => api.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'APP-AUTH', appRedirectUri,
        ...(appRedirectUri ? { appCodeChallenge: codeChallenge } : {}) }),
    }));
    try {
      expect((await start('https://attacker.example/callback'))?.status).toBe(400);
      const started = await start();
      expect(started?.status).toBe(201);
      const { authorizationUrl } = await started!.json() as { authorizationUrl: string };
      const authorization = googleWorld.authorize(authorizationUrl);
      const stateCookie = started!.headers.get('set-cookie')!.split(';', 1)[0]!;
      const callback = await api.handle(new Request(`${REDIRECT}?code=${authorization.code}&state=${authorization.state}`, {
        headers: { cookie: stateCookie },
      }));
      expect(callback?.status).toBe(303);
      const appCallback = new URL(callback!.headers.get('location')!);
      expect(`${appCallback.protocol}//${appCallback.host}${appCallback.pathname}`).toBe('elanous://auth/callback');
      const exchangeCode = appCallback.searchParams.get('code')!;
      const state = appCallback.searchParams.get('state')!;
      expect(state).toBe(authorization.state);
      expect(callback!.headers.get('set-cookie')).toContain('Max-Age=0');
      expect(callback!.headers.get('set-cookie')).not.toContain('__Host-elanous_member_session=');

      const exchange = (code: string, boundState: string, verifier = codeVerifier) => api.handle(new Request('https://api.example.test/v1/members/app-slot/exchange', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, state: boundState, codeVerifier: verifier }),
      }));
      expect((await exchange(exchangeCode, 'wrong-state'))?.status).toBe(401);
      expect((await exchange(exchangeCode, state, `${codeVerifier}wrong`))?.status).toBe(401);
      const exchanged = await exchange(exchangeCode, state);
      expect(exchanged?.status).toBe(200);
      const payload = await exchanged!.json() as { appId: string; sessionToken: string; tokenType: string; expiresAt: string };
      expect(payload).toMatchObject({ appId: expect.stringMatching(/^kaist-/), sessionToken: 'aps-one-time-session', tokenType: 'Bearer' });
      expect(Number.isFinite(Date.parse(payload.expiresAt))).toBe(true);
      expect(issued).toHaveLength(1);
      expect((await exchange(exchangeCode, state))?.status).toBe(401);
      expect(isPublicRoute('POST', '/v1/members/app-slot/exchange', { setupMode: false })).toBe(true);

      const expiredStart = await start();
      const expiredAuthorization = googleWorld.authorize((await expiredStart!.json() as { authorizationUrl: string }).authorizationUrl);
      const expiredCallback = await api.handle(new Request(`${REDIRECT}?code=${expiredAuthorization.code}&state=${expiredAuthorization.state}`, {
        headers: { cookie: expiredStart!.headers.get('set-cookie')!.split(';', 1)[0]! },
      }));
      const expiredAppCallback = new URL(expiredCallback!.headers.get('location')!);
      clock += 2 * 60_000 + 1;
      expect(store.pruneExpiredAppAuthCodes?.(new Date(clock).toISOString())).toBe(1);
      expect((await exchange(expiredAppCallback.searchParams.get('code')!, expiredAuthorization.state))?.status).toBe(401);
    } finally { store.close(); }
  });

  test('drives real signup, consent/code attribution, member session and deletion through fake Google', async () => {
    const now = () => Date.parse('2026-11-14T01:00:00.000Z');
    const store = createMemberStore({ path: ':memory:', now });
    const appLifecycle = createAppLifecycleStore(':memory:');
    let lifecycleLookups = 0;
    let lifecycleCreateAttempts = 0;
    const retryingAppLifecycle = {
      ensureCreated: (event: Parameters<typeof appLifecycle.ensureCreated>[0]) => {
        lifecycleCreateAttempts += 1;
        if (lifecycleCreateAttempts === 1) throw new Error('temporary lifecycle write failure');
        appLifecycle.ensureCreated(event);
      },
    };
    // Source: src/nexus/members/member-store.ts — the two-use event code permits two distinct members then exhausts.
    store.provisionEventCode({ code: 'KAIST-2026', maxUses: 2 });
    expect(store.validateCode('KAIST-2026', 'event', new Date(now()).toISOString())).toMatchObject({
      valid: true, benefit: 'non-monetary', finalizesAt: '2026-11-28T01:00:00.000Z',
    });
    const inviter = store.register({ sub: 'google-inviter', email: 'inviter@example.test', emailVerified: true, name: 'Inviter' }, {
      consents: { privacy: 'privacy-v1', terms: 'terms-v1' },
    });
    const googleWorld = createFakeGoogleOAuthWorld({ clientId: CLIENT_ID, redirectUri: REDIRECT, identity: {
      sub: 'google-new-member', email: 'new@example.test', emailVerified: true, name: 'New Member',
    } });
    const google = createGoogleSignin({
      clientId: async () => CLIENT_ID,
      clientSecret: async () => 'fake-google-client-secret',
      stateEncryptionKey: async () => 'test-only-random-encryption-secret-32-bytes-minimum',
      redirectUri: REDIRECT,
      store,
      fetch: googleWorld.fetch,
      now,
      authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`,
      tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`,
      userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo`,
    });
    const invalidCallbackGoogle = createGoogleSignin({
      clientId: async () => CLIENT_ID, clientSecret: async () => 'fake-google-client-secret',
      stateEncryptionKey: async () => 'test-only-random-encryption-secret-32-bytes-minimum',
      redirectUri: 'https://api.example.test/v1/members/google/callback', store,
    });
    expect(() => createMembersApi({ store, google: invalidCallbackGoogle, successRedirectUri: 'https://app.example.test/signup/complete', now }))
      .toThrow('fixed HTTPS URL');
    const api = createMembersApi({ store, google, successRedirectUri: 'https://app.example.test/signup/complete', now,
      getAppLifecycle: () => {
        lifecycleLookups += 1;
        if (lifecycleLookups === 1) throw new Error('temporary lifecycle-store initialization failure');
        return retryingAppLifecycle;
      } });
    expect(isPublicRoute('POST', '/v1/members', { setupMode: false })).toBe(true);
    expect(isPublicRoute('GET', '/v1/members/oauth/google/callback', { setupMode: false })).toBe(true);
    expect(isPublicRoute('GET', '/v1/members/app-slot', { setupMode: false })).toBe(true);
    expect(isPublicRoute('POST', '/v1/members/app-slot', { setupMode: false })).toBe(true);
    expect(isPublicRoute('DELETE', '/v1/members/app-slot', { setupMode: false })).toBe(false);
    expect(isPublicRoute('GET', '/v1/members/private', { setupMode: false })).toBe(false);
    const preflight = await api.handle(new Request('https://api.example.test/v1/members', { method: 'OPTIONS', headers: { origin: 'https://app.example.test' } }));
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(preflight?.headers.get('access-control-allow-credentials')).toBe('true');
    // OP #89454 acceptance scenario: 10,000 rotating addresses must not reserve server-side pending signup slots.
    let rotatedAddressStarts = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const start = await api.handle(new Request('https://api.example.test/v1/members', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.test' }, body: JSON.stringify({
          consents: { privacy: 'privacy-v1', terms: 'terms-v1' },
        }),
      }), `2001:db8:${index.toString(16)}::1`);
      if (start?.status === 201) rotatedAddressStarts += 1;
    }
    expect(rotatedAddressStarts).toBe(10_000);
    const started = await api.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.test' }, body: JSON.stringify({
        consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, referralCode: inviter.referralCode, eventCode: 'KAIST-2026',
      }),
    }));
    expect(started?.status).toBe(201);
    const stateCookie = started?.headers.get('set-cookie') ?? '';
    expect(stateCookie).toContain('__Host-elanous_member_oauth_state=');
    expect(stateCookie.split(';')[0]?.split('=')[1]).not.toBe('1');
    expect(stateCookie).not.toContain('__Host-elanous_member_signup_client=');
    expect(stateCookie).toContain('HttpOnly; Secure; SameSite=Lax');
    const { authorizationUrl } = await started!.json() as { authorizationUrl: string };
    const callback = googleWorld.authorize(authorizationUrl);
    const callbackUrl = `https://api.example.test/v1/members/oauth/google/callback?code=${callback.code}&state=${callback.state}`;
    const forged = await api.handle(new Request(callbackUrl));
    expect(forged?.status).toBe(401);
    const completed = await routeRequest(new Request(callbackUrl, { headers: { cookie: stateCookie.split(';')[0]! } }),
      { membersApi: api } as never, {} as never, null, createDevProxyRuntimeRef());
    expect(completed?.status).toBe(200);
    expect(await completed!.text()).toContain('emk_');
    const setCookie = completed?.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly; Secure; SameSite=Lax');
    const memberCookie = setCookie.split(';', 1)[0]!;
    const keyList = await routeRequest(new Request('https://api.example.test/v1/member/keys', { headers: { cookie: memberCookie } }),
      { membersApi: api } as never, {} as never, null, createDevProxyRuntimeRef());
    expect(keyList?.status).toBe(200);
    expect((await keyList!.json() as { keys: unknown[] }).keys).toHaveLength(1);
    const keyPreflight = await routeRequest(new Request('https://api.example.test/v1/member/keys', {
      method: 'OPTIONS', headers: { origin: 'https://app.example.test', 'access-control-request-method': 'POST' },
    }), { membersApi: api } as never, {} as never, null, createDevProxyRuntimeRef());
    expect(keyPreflight?.status).toBe(204);
    expect(keyPreflight?.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    const createdKey = await routeRequest(new Request('https://api.example.test/v1/member/keys', {
      method: 'POST', headers: { cookie: memberCookie, origin: 'https://app.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'device' }),
    }), { membersApi: api } as never, {} as never, null, createDevProxyRuntimeRef());
    expect(createdKey?.status).toBe(201);
    expect(createdKey?.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    const key = await createdKey!.json() as { id: string; key: string };
    expect(key.key.startsWith('emk_')).toBe(true);
    const revokedKey = await routeRequest(new Request(`https://api.example.test/v1/member/keys/${key.id}`, {
      method: 'DELETE', headers: { cookie: memberCookie },
    }), { membersApi: api } as never, {} as never, null, createDevProxyRuntimeRef());
    expect(revokedKey?.status).toBe(200);
    expect((await api.handle(new Request(callbackUrl, { headers: { cookie: stateCookie.split(';')[0]! } })))?.status).toBe(401);
    const sessionCookie = setCookie.split(';')[0]!;
    const profile = await api.handle(new Request('https://api.example.test/v1/members', { headers: { cookie: sessionCookie, origin: 'https://app.example.test' } }));
    expect(profile?.status).toBe(200);
    expect(lifecycleLookups).toBe(2);
    expect(lifecycleCreateAttempts).toBe(2);
    const profileBody = await profile!.json();
    expect(profileBody).toMatchObject({ member: { email: 'new@example.test', invitedBy: inviter.id, eventCode: 'KAIST-2026' } });
    expect(JSON.stringify(profileBody)).not.toContain('fake-google-access');
    const slotResponse = await routeRequest(new Request('https://api.example.test/v1/members/app-slot', {
      headers: { cookie: sessionCookie, origin: 'https://app.example.test' },
    }), { membersApi: api } as never, {} as never, null, createDevProxyRuntimeRef());
    expect(slotResponse?.status).toBe(200);
    expect(lifecycleLookups).toBe(2);
    const { appSlot } = await slotResponse!.json() as { appSlot: { appId: string; templateSlug: string; createdAt: string } };
    expect(appSlot).toMatchObject({ templateSlug: 'next-app-lecture-scrap' });
    expect(appSlot.appId).not.toBe(appSlot.templateSlug);
    expect(appLifecycle.view(appSlot.appId)).toMatchObject({ snapshot: { appId: appSlot.appId, status: 'draft', eventCount: 1 } });
    const retriedMember = store.register({ sub: 'google-new-member', email: 'new@example.test', emailVerified: true, name: 'New Member' }, {
      consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'KAIST-2026',
    }, new Date(now()).toISOString());
    expect(store.appSlotForMember(retriedMember.id)?.appId).toBe(appSlot.appId);
    appLifecycle.ensureCreated(store.appSlotForMember(retriedMember.id)!.lifecycleEvent);
    expect(appLifecycle.view(appSlot.appId).events).toHaveLength(1);
    const secondCreate = await routeRequest(new Request('https://api.example.test/v1/members/app-slot', {
      method: 'POST', headers: { cookie: sessionCookie, origin: 'https://app.example.test' },
    }), { membersApi: api } as never, {} as never, null, createDevProxyRuntimeRef());
    expect(secondCreate?.status).toBe(409);
    expect(await secondCreate!.json()).toEqual({ error: 'app-slot-already-exists' });

    const secondMember = store.register({ sub: 'google-second-member', email: 'second@example.test', emailVerified: true, name: 'Second Member' }, {
      consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'KAIST-2026',
    }, new Date(now()).toISOString());
    const secondSlot = store.appSlotForMember(secondMember.id);
    expect(secondSlot).not.toBeNull();
    expect(secondSlot?.appId).not.toBe(appSlot.appId);
    expect(secondSlot?.templateSlug).toBe(appSlot.templateSlug);
    const secondSession = store.createSession(secondMember.id, new Date(now()).toISOString());
    const secondMemberSlot = await routeRequest(new Request('https://api.example.test/v1/members/app-slot', {
      headers: { cookie: `__Host-elanous_member_session=${encodeURIComponent(secondSession.token)}`, origin: 'https://app.example.test' },
    }), { membersApi: api } as never, {} as never, null, createDevProxyRuntimeRef());
    expect(secondMemberSlot?.status).toBe(200);
    expect(await secondMemberSlot!.json()).toEqual({ appSlot: { appId: secondSlot?.appId, appSlug: secondSlot?.appSlug,
      templateSlug: secondSlot?.templateSlug, createdAt: secondSlot?.createdAt, url: null } });
    const anonymousSlot = await api.handle(new Request('https://api.example.test/v1/members/app-slot', { headers: { origin: 'https://app.example.test' } }));
    expect(anonymousSlot?.status).toBe(401);
    appLifecycle.ensureCreated(createAppLifecycleEvent({ appId: appSlot.templateSlug, action: 'created', environment: 'simulation', actor: 'system',
      appVersion: 'template-v1', appFingerprint: 'a'.repeat(64) }));
    expect(appLifecycle.view(appSlot.templateSlug).events).toHaveLength(1);
    expect(appLifecycle.view(appSlot.appId).events).toHaveLength(1);
    expect(appLifecycle.view(appSlot.appId).events[0]).not.toHaveProperty('appVersion');
    expect(appLifecycle.view(appSlot.appId).events[0]).not.toHaveProperty('appFingerprint');
    const deletion = await api.handle(new Request('https://api.example.test/v1/members', { method: 'DELETE', headers: { cookie: sessionCookie, origin: 'https://app.example.test' } }));
    expect(deletion?.status).toBe(202);
    const afterDeletion = await api.handle(new Request('https://api.example.test/v1/members', { headers: { cookie: sessionCookie, origin: 'https://app.example.test' } }));
    expect(afterDeletion?.status).toBe(401);
    expect(store.validateCode('KAIST-2026', 'event', new Date(now()).toISOString())).toMatchObject({ valid: false, reason: 'exhausted' });
    expect(store.validateCode('KAIST-2026', 'event', '2026-11-16T00:00:00.000Z')).toMatchObject({ valid: false, reason: 'inactive' });
    store.close();
    appLifecycle.close();
  });
});
