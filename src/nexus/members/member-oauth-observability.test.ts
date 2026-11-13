import { expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

const callbackUrl = 'https://api.example.test/v1/members/oauth/google/callback?code=private-code&state=private-state';
const stateCookie = '__Host-elanous_member_oauth_state=private-cookie';

test('callback reports fixed failure stages without logging state, code, cookie, or provider details', async () => {
  const records: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    records.push({ category, event, data });
  });
  const store = createMemberStore({ path: ':memory:' });
  try {
    const apiFor = (message: string) => createMembersApi({ store, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
      complete: async () => { throw new Error(message); },
    } as never, successRedirectUri: 'https://app.example.test/signup/complete' });
    const cases = [
      ['Google OAuth state expired, invalid, or already used', 'state-mismatch'],
      ['Google OAuth code exchange failed', 'code-exchange'],
      ['Google identity lookup failed', 'identity-lookup'],
      ['provider said private-code private-cookie private-state', 'google-unavailable'],
    ] as const;
    for (const [message, reason] of cases) {
      const response = await apiFor(message).handle(new Request(callbackUrl, { headers: { cookie: stateCookie } }));
      expect(response?.status).toBe(401);
      expect(await response?.json()).toEqual({ error: reason });
    }
    const missing = await apiFor('unused').handle(new Request(callbackUrl));
    expect(await missing?.json()).toEqual({ error: 'state-missing' });
    const invalid = await apiFor('unused').handle(new Request(callbackUrl.replace('private-state', 'bad%20state')));
    expect(await invalid?.json()).toEqual({ error: 'state-invalid' });
    expect(records.map(row => [row.category, row.event, row.data])).toEqual([
      ['members', 'oauth-callback-failed', { reason: 'state-mismatch' }],
      ['members', 'oauth-callback-failed', { reason: 'code-exchange' }],
      ['members', 'oauth-callback-failed', { reason: 'identity-lookup' }],
      ['members', 'oauth-callback-failed', { reason: 'google-unavailable' }],
      ['members', 'oauth-callback-failed', { reason: 'state-missing' }],
      ['members', 'oauth-callback-failed', { reason: 'state-invalid' }],
    ]);
    expect(JSON.stringify(records)).not.toMatch(/private-code|private-state|private-cookie|provider said/);
  } finally { log.mockRestore(); store.close(); }
});

test('native app slot failure has its own callback code', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const api = createMembersApi({ store: { ...store,
      ensureNativeAppSlotForMember: () => { throw new Error('private slot storage detail'); },
    }, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
      complete: async () => ({ identity: { sub: 'sub-native', email: 'native@example.test', name: 'Native', emailVerified: true },
        intent: { consents: { privacy: 'privacy-v1', terms: 'terms-v1' },
          appRedirectUri: 'elanous://auth/callback', appCodeChallenge: 'a'.repeat(43) } }),
    } as never, successRedirectUri: 'https://app.example.test/signup/complete',
      appAuthRedirectUris: ['elanous://auth/callback'], issueOwnerSession: () => ({ sessionToken: 'unused', expiresAt: '2099-01-01T00:00:00.000Z' }) });
    const response = await api.handle(new Request(callbackUrl, { headers: { cookie: stateCookie } }));
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: 'member-slot' });
  } finally { store.close(); }
});

test('native callback creates one app slot for an existing member without an event code', async () => {
  const store = createMemberStore({ path: ':memory:' });
  const identity = { sub: 'sub-default-native', email: 'default@example.test', name: 'Default', emailVerified: true as const };
  const intent = { consents: { privacy: 'privacy-v1', terms: 'terms-v1' } };
  try {
    const member = store.register(identity, intent, '2026-11-13T00:00:00.000Z', false);
    expect(store.appSlotForMember(member.id)).toBeNull();
    const api = createMembersApi({ store, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
      complete: async () => ({ identity, intent: { ...intent,
        appRedirectUri: 'elanous://auth/callback', appCodeChallenge: 'a'.repeat(43) } }),
    } as never, successRedirectUri: 'https://app.example.test/signup/complete',
      appAuthRedirectUris: ['elanous://auth/callback'],
      issueOwnerSession: () => ({ sessionToken: 'native-session', expiresAt: '2099-01-01T00:00:00.000Z' }) });
    const response = await api.handle(new Request(callbackUrl, { headers: { cookie: stateCookie } }));
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toStartWith('elanous://auth/callback?code=');
    const slot = store.appSlotForMember(member.id);
    expect(slot?.appId).toStartWith('kaist-');
    expect(store.ensureNativeAppSlotForMember(member.id)).toEqual(slot);
  } finally { store.close(); }
});

test('verified mobile Google session provisions the same default member slot once', async () => {
  const store = createMemberStore({ path: ':memory:' });
  const identity = { sub: 'sub-mobile-default', email: 'mobile-default@example.test', name: 'Mobile', emailVerified: true as const };
  try {
    const member = store.register(identity, { consents: { privacy: 'privacy-v1', terms: 'terms-v1' } },
      '2026-11-13T00:00:00.000Z', false);
    const api = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete',
      verifyMobileGoogleIdToken: async token => token === 'valid-token' ? identity.sub : null,
      issueOwnerSession: () => ({ sessionToken: 'native-session', expiresAt: '2099-01-01T00:00:00.000Z' }) });
    const request = (token: string) => api.handle(new Request('https://api.example.test/v1/members/app-slot/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ googleIdToken: token }),
    }));
    expect((await request('invalid-token'))?.status).toBe(401);
    expect(store.appSlotForMember(member.id)).toBeNull();
    const first = await request('valid-token');
    expect(first?.status).toBe(200);
    const slot = store.appSlotForMember(member.id);
    expect(slot?.appId).toStartWith('kaist-');
    expect((await request('valid-token'))?.status).toBe(200);
    expect(store.appSlotForMember(member.id)).toEqual(slot);
  } finally { store.close(); }
});

test('web slot retry preserves the session while response construction retains its failure phase', async () => {
  const google = { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
    complete: async () => ({ identity: { sub: 'sub-web', email: 'web@example.test', name: 'Web', emailVerified: true },
      intent: { consents: { privacy: 'privacy-v1', terms: 'terms-v1' } } }) } as never;
  const slotStore = createMemberStore({ path: ':memory:' });
  const responseStore = createMemberStore({ path: ':memory:' });
  try {
    const slotApi = createMembersApi({ store: { ...slotStore,
      appSlotForMember: () => { throw new Error('private slot storage detail'); },
    }, google, successRedirectUri: 'https://app.example.test/signup/complete' });
    const slotResponse = await slotApi.handle(new Request(callbackUrl, { headers: { cookie: stateCookie } }));
    expect(slotResponse?.status).toBe(303);
    expect(slotResponse?.headers.get('location')).toBe('https://api.example.test/v1/members/home');
    expect(slotResponse?.headers.get('set-cookie')).toContain('__Host-elanous_member_session=');

    const responseApi = createMembersApi({ store: { ...responseStore,
      register: (...args: Parameters<typeof responseStore.register>) => {
        const member = responseStore.register(...args);
        Object.defineProperty(member, 'session', { get() { throw new Error('private response detail'); } });
        return member;
      },
    }, google, successRedirectUri: 'https://app.example.test/signup/complete' });
    const response = await responseApi.handle(new Request(callbackUrl, { headers: { cookie: stateCookie } }));
    expect(await response?.json()).toEqual({ error: 'callback-response' });
  } finally { slotStore.close(); responseStore.close(); }
});
