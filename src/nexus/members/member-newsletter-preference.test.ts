import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore, type MemberSignupIntent } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { createGoogleSignin } from './google-signin.js';
import { createFakeGoogleOAuthWorld, FAKE_GOOGLE_ISSUER } from '../../ux-sim/fake-google-oauth.js';
import { createDevProxyRuntimeRef } from '../api/admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from '../api/http-server.js';

const at = '2026-11-14T02:00:00.000Z';
const consents = { privacy: 'v1', terms: 'v1' };
const identity = (sub: string) => ({ sub, email: `${sub}@example.test`, emailVerified: true as const, name: sub });
const endpoint = 'https://api.example.test/v1/members/newsletter-preference';

test('newsletter choice remains unrecorded until explicit input, then latest choice controls the aggregate', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const unrecorded = store.register(identity('none'), { consents }, at);
    const optedIn = store.register(identity('yes'), { consents, newsletterPreference: { choice: 'opted_in', revision: 'newsletter-v1' } }, at);
    const declined = store.register(identity('no'), { consents, newsletterPreference: { choice: 'declined', revision: 'newsletter-v1' } }, at);
    expect(store.newsletterPreference(unrecorded.id)).toBeNull();
    expect(store.newsletterPreference(optedIn.id)).toEqual({ choice: 'opted_in', revision: 'newsletter-v1', updatedAt: at });
    expect(store.newsletterPreference(declined.id)?.choice).toBe('declined');
    expect(store.newsletterOptInCount()).toBe(1);

    store.register(identity('yes'), { consents }, '2026-11-14T03:00:00.000Z');
    expect(store.newsletterPreference(optedIn.id)?.choice).toBe('opted_in');
    expect(store.setNewsletterPreference(optedIn.id, { choice: 'declined', revision: 'newsletter-v1' }, '2026-11-14T04:00:00.000Z')?.choice).toBe('declined');
    expect(store.newsletterOptInCount()).toBe(0);
    expect(store.setNewsletterPreference(declined.id, { choice: 'opted_in', revision: 'newsletter-v1' }, '2026-11-14T05:00:00.000Z')?.choice).toBe('opted_in');
    expect(store.newsletterOptInCount()).toBe(1);
    expect(store.setNewsletterPreference('missing', { choice: 'opted_in', revision: 'newsletter-v1' })).toBeNull();
    expect(store.newsletterOptInCount()).toBe(1);
  } finally { store.close(); }
});

test('explicit decline and later opt-in survive a store restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-newsletter-'));
  const path = join(directory, 'members.sqlite');
  try {
    const first = createMemberStore({ path });
    let memberId: string;
    try {
      memberId = first.register(identity('restart'), {
        consents, newsletterPreference: { choice: 'declined', revision: 'newsletter-v1' },
      }, at).id;
      expect(first.newsletterOptInCount()).toBe(0);
    } finally { first.close(); }

    const second = createMemberStore({ path });
    try {
      expect(second.newsletterPreference(memberId!)).toEqual({
        choice: 'declined', revision: 'newsletter-v1', updatedAt: at,
      });
      expect(second.newsletterOptInCount()).toBe(0);
      second.setNewsletterPreference(memberId!, { choice: 'opted_in', revision: 'newsletter-v1' }, '2026-11-14T03:00:00.000Z');
    } finally { second.close(); }

    const third = createMemberStore({ path });
    try {
      expect(third.newsletterPreference(memberId!)?.choice).toBe('opted_in');
      expect(third.newsletterOptInCount()).toBe(1);
    } finally { third.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('signup carries explicit preference through OAuth intent and rejects malformed choices', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    let accepted: MemberSignupIntent | undefined;
    const api = createMembersApi({ store, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
      // 출처: #89454 — fake OAuth state cookie lifetime is only a test fixture.
      start: async (intent: MemberSignupIntent) => { accepted = intent; return { authorizationUrl: 'https://accounts.example.test/start', cookieValue: 'state', maxAgeSeconds: 60 }; },
    } as never, successRedirectUri: 'https://app.example.test/signup/complete' });
    const post = (newsletterPreference: unknown) => api.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ consents, newsletterPreference }),
    }));
    expect((await post({ choice: 'opted_in', revision: 'newsletter-v1' }))?.status).toBe(201);
    expect(accepted?.newsletterPreference).toEqual({ choice: 'opted_in', revision: 'newsletter-v1' });
    for (const value of [{ choice: 'opted_in' }, { choice: 'declined', revision: 'newsletter-v2' }, { choice: true, revision: 'newsletter-v1' }, { choice: 'opted_in', revision: 'newsletter-v1', extra: true }]) {
      expect((await post(value))?.status).toBe(400);
    }
  } finally { store.close(); }
});

test('member can read and change only own choice; count requires a private token and returns no addresses', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const first = store.register(identity('member-one'), { consents }, at);
    const second = store.register(identity('member-two'), { consents, newsletterPreference: { choice: 'opted_in', revision: 'newsletter-v1' } }, at);
    const api = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete', webOrigin: 'https://app.example.test',
      now: () => Date.parse(at), getNewsletterCountToken: async () => 'private-count-token' });
    const preflight = await api.handle(new Request(endpoint, { method: 'OPTIONS', headers: {
      origin: 'https://app.example.test', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type',
    } }));
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(preflight?.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect((await api.handle(new Request(endpoint, { method: 'OPTIONS', headers: {
      origin: 'https://other.example.test', 'access-control-request-method': 'PUT',
    } })))?.status).toBe(403);
    expect((await api.handle(new Request(endpoint)))?.status).toBe(401);
    const memberHeaders = { cookie: `__Host-elanous_member_session=${first.session.token}`, origin: 'https://app.example.test' };
    const before = await api.handle(new Request(endpoint, { headers: memberHeaders }));
    expect(await before?.json()).toEqual({ preference: null });
    const put = await api.handle(new Request(endpoint, { method: 'PUT', headers: { ...memberHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'declined', revision: 'newsletter-v1' }) }));
    expect(put?.status).toBe(200);
    expect((await put?.json() as { preference: { choice: string } }).preference.choice).toBe('declined');
    expect(store.newsletterPreference(second.id)?.choice).toBe('opted_in');
    expect((await api.handle(new Request(endpoint, { method: 'PUT', headers: { ...memberHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'opted_in', revision: 'newsletter-v2' }) })))?.status).toBe(400);

    const countUrl = `${endpoint}/count`;
    const unavailableCountApi = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete', webOrigin: 'https://app.example.test', now: () => Date.parse(at) });
    expect((await unavailableCountApi.handle(new Request(countUrl, { headers: { authorization: 'Bearer private-count-token' } })))?.status).toBe(503);
    expect((await api.handle(new Request(countUrl, { headers: memberHeaders })))?.status).toBe(401);
    expect((await api.handle(new Request(countUrl, { headers: { authorization: 'Bearer wrong' } })))?.status).toBe(401);
    const count = await api.handle(new Request(countUrl, { headers: { authorization: 'Bearer private-count-token' } }));
    expect(count?.status).toBe(200);
    const countBody = await count?.text();
    expect(JSON.parse(countBody ?? '')).toEqual({ optedInCount: 1 });
    expect(countBody).not.toContain(second.email);
  } finally { store.close(); }
});

test('Nexus HTTP gate reaches the member-verified preference and private count routes', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const member = store.register(identity('routed'), {
      consents, newsletterPreference: { choice: 'opted_in', revision: 'newsletter-v1' },
    }, at);
    const membersApi = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete', webOrigin: 'https://app.example.test',
      now: () => Date.parse(at), getNewsletterCountToken: async () => 'private-count-token' });
    const opts = { membersApi } as NexusHttpServerOpts;
    const route = (path: string, init?: RequestInit) => routeRequest(
      new Request(`https://api.example.test${path}`, init), opts, {} as never, null, createDevProxyRuntimeRef());
    const ownCookie = { cookie: `__Host-elanous_member_session=${member.session.token}` };
    expect((await route('/v1/members/newsletter-preference'))?.status).toBe(401);
    const own = await route('/v1/members/newsletter-preference', { headers: ownCookie });
    expect(await own?.json()).toEqual({ preference: { choice: 'opted_in', revision: 'newsletter-v1', updatedAt: at } });
    expect((await route('/v1/members/newsletter-preference/count'))?.status).toBe(401);
    const count = await route('/v1/members/newsletter-preference/count', { headers: { authorization: 'Bearer private-count-token' } });
    expect(await count?.json()).toEqual({ optedInCount: 1 });
    const decline = await route('/v1/members/newsletter-preference', { method: 'PUT',
      headers: { ...ownCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'declined', revision: 'newsletter-v1' }) });
    expect(decline?.status).toBe(200);
    expect(store.newsletterPreference(member.id)?.choice).toBe('declined');
    expect((await route('/v1/members/newsletter-preference/count', { headers: { authorization: 'Bearer private-count-token' } }))?.status).toBe(200);
    expect((await route('/v1/members/newsletter-preference/count', { method: 'POST', headers: { authorization: 'Bearer private-count-token' } }))?.status).toBe(401);
  } finally { store.close(); }
});

test('OAuth state cookie preserves newsletter choice through callback and member registration', async () => {
  const store = createMemberStore({ path: ':memory:', now: () => Date.parse(at) });
  try {
    const redirectUri = 'https://api.example.test/v1/members/oauth/google/callback';
    const clientId = 'newsletter-member-client';
    const world = createFakeGoogleOAuthWorld({ clientId, redirectUri, identity: identity('oauth-newsletter') });
    const google = createGoogleSignin({ clientId: async () => clientId,
      clientSecret: async () => 'fake-google-client-secret', stateEncryptionKey: async () => 'test-only-state-encryption-key',
      redirectUri, store, now: () => Date.parse(at), fetch: world.fetch,
      authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`,
      tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`, userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo` });
    const api = createMembersApi({ store, google, successRedirectUri: 'https://app.example.test/signup/complete', now: () => Date.parse(at) });
    const start = await api.handle(new Request('https://api.example.test/v1/members', { method: 'POST',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ consents, newsletterPreference: { choice: 'declined', revision: 'newsletter-v1' } }),
    }));
    expect(start?.status).toBe(201);
    const { authorizationUrl } = await start!.json() as { authorizationUrl: string };
    const authorization = world.authorize(authorizationUrl);
    const stateCookie = start!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const callback = await api.handle(new Request(`${redirectUri}?code=${authorization.code}&state=${authorization.state}`, { headers: { cookie: stateCookie } }));
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get('location')).toBe('https://api.example.test/v1/members/home');
    const member = store.memberForGoogleSub('oauth-newsletter');
    expect(member).not.toBeNull();
    expect(store.newsletterPreference(member!.id)?.choice).toBe('declined');
    expect(store.newsletterOptInCount()).toBe(0);
    const sessionCookie = callback!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const profile = await api.handle(new Request(endpoint, { headers: { cookie: sessionCookie } }));
    expect((await profile?.json() as { preference: { choice: string } }).preference.choice).toBe('declined');
  } finally { store.close(); }
});
