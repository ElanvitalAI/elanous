import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createConfiguredMembersApi } from './members-api.js';
import { createFakeGoogleOAuthWorld, FAKE_GOOGLE_ISSUER } from '../../ux-sim/fake-google-oauth.js';
import { createGoogleSignin } from './google-signin.js';

const consents = { privacy: 'v1', terms: 'v1' };

test('configured daemon admits KCB signup now, closes December 1 KST, and refuses the 301st member', async () => {
  const store = createMemberStore({ path: ':memory:' });
  const previous = {
    redirect: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    success: process.env.MEMBER_SIGNUP_SUCCESS_REDIRECT_URI,
    origin: process.env.MEMBER_SIGNUP_WEB_ORIGIN,
  };
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.example.test/v1/members/oauth/google/callback';
  process.env.MEMBER_SIGNUP_SUCCESS_REDIRECT_URI = 'https://app.example.test/signup/complete';
  process.env.MEMBER_SIGNUP_WEB_ORIGIN = 'https://app.example.test';
  let now = Date.parse('2026-11-12T10:01:00Z');
  try {
    const api = createConfiguredMembersApi({
      store,
      google: {
        redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
        start: async () => ({ authorizationUrl: 'https://accounts.example.test/authorize', cookieValue: 'fake', maxAgeSeconds: 60 }), // Source: #16901, finite fake OAuth state lifetime.
      } as never,
      now: () => now,
    });
    expect(api).not.toBeNull();
    const start = () => api!.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.test' },
      body: JSON.stringify({ consents, eventCode: 'kcb_1114' }),
    }));
    expect((await start())?.status).toBe(201);

    now = Date.parse('2026-11-30T14:59:59Z');
    expect((await start())?.status).toBe(201);
    now = Date.parse('2026-11-30T15:00:00Z');
    const closed = await start();
    expect(closed?.status).toBe(400);
    expect(await closed?.json()).toEqual({ error: 'invalid-event-code' });

    now = Date.parse('2026-11-12T10:01:00Z');
    const quota = 300; // Source: #16901, OP fixed the KCB signup code at 300 uses.
    for (const index of Array.from({ length: quota }, (_, i) => i)) {
      store.register({ sub: `member-${index}`, email: `member-${index}@example.test`, emailVerified: true, name: 'Member' },
        { consents, eventCode: 'KCB1114' }, new Date(now).toISOString());
    }
    const overQuota = await start();
    expect(overQuota?.status).toBe(400);
    expect(await overQuota?.json()).toEqual({ error: 'invalid-event-code' });
    expect(() => store.register({ sub: 'member-over-cap', email: 'over-cap@example.test', emailVerified: true, name: 'Member' },
      { consents, eventCode: 'KCB1114' }, new Date(now).toISOString())).toThrow('event code exhausted');
    expect(now).toBeLessThan(Date.parse('2026-11-14T08:00:00Z')); // Source: #16901, draw eligibility begins later.
  } finally {
    for (const [key, value] of [
      ['GOOGLE_OAUTH_REDIRECT_URI', previous.redirect],
      ['MEMBER_SIGNUP_SUCCESS_REDIRECT_URI', previous.success],
      ['MEMBER_SIGNUP_WEB_ORIGIN', previous.origin],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    store.close();
  }
});

test('configured KCB callback defaults to /members/, honors same-origin override, and leaves ordinary callback unchanged', async () => {
  const previous = {
    redirect: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    success: process.env.MEMBER_SIGNUP_SUCCESS_REDIRECT_URI,
    origin: process.env.MEMBER_SIGNUP_WEB_ORIGIN,
  };
  const redirectUri = 'https://api.example.test/v1/members/oauth/google/callback';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = redirectUri;
  process.env.MEMBER_SIGNUP_WEB_ORIGIN = 'https://app.example.test';
  const now = () => Date.parse('2026-11-12T10:05:00Z');
  const complete = async (eventCode?: string): Promise<string | null> => {
    const store = createMemberStore({ path: ':memory:', now });
    const googleWorld = createFakeGoogleOAuthWorld({ clientId: 'client-test', redirectUri, identity: {
      sub: 'test-member', email: 'member@example.test', emailVerified: true, name: 'Member',
    } });
    const google = createGoogleSignin({ clientId: async () => 'client-test', clientSecret: async () => 'fake-google-client-secret',
      stateEncryptionKey: async () => 'test-only-state-encryption-key', redirectUri, store, now, fetch: googleWorld.fetch,
      authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`, tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`,
      userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo` });
    try {
      const api = createConfiguredMembersApi({ store, google, now });
      expect(api).not.toBeNull();
      const started = await api!.handle(new Request('https://api.example.test/v1/members', {
        method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ consents, ...(eventCode ? { eventCode } : {}) }),
      }));
      expect(started?.status).toBe(201);
      const { authorizationUrl } = await started!.json() as { authorizationUrl: string };
      const authorization = googleWorld.authorize(authorizationUrl);
      const completed = await api!.handle(new Request(`${redirectUri}?code=${authorization.code}&state=${authorization.state}`, {
        headers: { cookie: started!.headers.get('set-cookie')!.split(';', 1)[0]! },
      }));
      expect(completed?.status).toBe(303);
      const setCookie = completed?.headers.get('set-cookie') ?? '';
      expect(setCookie.startsWith('__Host-elanous_member_session=')).toBe(true);
      return completed?.headers.get('location') ?? null;
    } finally { store.close(); }
  };
  try {
    delete process.env.MEMBER_SIGNUP_SUCCESS_REDIRECT_URI;
    expect(await complete('KCB1114')).toBe('https://app.example.test/members/');
    expect(await complete()).toBe('https://api.example.test/v1/members/home');
    process.env.MEMBER_SIGNUP_SUCCESS_REDIRECT_URI = 'https://app.example.test/custom-success';
    expect(await complete('KCB1114')).toBe('https://app.example.test/custom-success');
    process.env.MEMBER_SIGNUP_SUCCESS_REDIRECT_URI = 'https://attacker.example.test/escape';
    const rejectedStore = createMemberStore({ path: ':memory:' });
    try {
      expect(() => createConfiguredMembersApi({ store: rejectedStore,
        google: { redirectUri } as never, now })).toThrow('KCB success redirect must share the member web origin');
    } finally { rejectedStore.close(); }
  } finally {
    for (const [key, value] of [
      ['GOOGLE_OAUTH_REDIRECT_URI', previous.redirect],
      ['MEMBER_SIGNUP_SUCCESS_REDIRECT_URI', previous.success],
      ['MEMBER_SIGNUP_WEB_ORIGIN', previous.origin],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
