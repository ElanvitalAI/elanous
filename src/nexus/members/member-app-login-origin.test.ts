import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { STATE_TTL_MS } from './google-signin.js';

const GOOGLE_STATE_COOKIE_LIFETIME_SECONDS = STATE_TTL_MS / 1000;

test('API-hosted app login can start Google while other member writes keep the website origin', async () => {
  const store = createMemberStore({ path: ':memory:' });
  let starts = 0;
  try {
    const api = createMembersApi({
      store,
      google: {
        redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
        start: async () => {
          starts++;
          return { authorizationUrl: 'https://accounts.google.test/auth', state: 'state', cookieValue: 'encrypted', maxAgeSeconds: GOOGLE_STATE_COOKIE_LIFETIME_SECONDS };
        },
      } as never,
      successRedirectUri: 'https://app.example.test/signup/complete',
      webOrigin: 'https://app.example.test',
      appAuthRedirectUris: ['elanous://auth/callback'],
      issueOwnerSession: () => ({ sessionToken: 'unused', expiresAt: '2099-01-01T00:00:00.000Z' }),
    });
    const body = JSON.stringify({
      consents: { privacy: 'privacy-v1', terms: 'terms-v1' },
      appRedirectUri: 'elanous://auth/callback',
      appCodeChallenge: 'a'.repeat(43),
    });
    const request = (url: string, method: string, origin: string) => new Request(url, {
      method, headers: { origin, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body } : {}),
    });
    const started = await api.handle(request('https://api.example.test/v1/members', 'POST', 'https://api.example.test'));
    expect(started?.status).toBe(201);
    expect((await started?.json() as { authorizationUrl: string }).authorizationUrl).toBe('https://accounts.google.test/auth');
    expect(starts).toBe(1);

    const foreign = await api.handle(request('https://api.example.test/v1/members', 'POST', 'https://evil.example.test'));
    expect(foreign?.status).toBe(403);
    expect(starts).toBe(1);
    const memberWrite = await api.handle(request('https://api.example.test/v1/members', 'DELETE', 'https://api.example.test'));
    expect(memberWrite?.status).toBe(403);
    const keyWrite = await api.handle(request('https://api.example.test/v1/member/keys', 'POST', 'https://api.example.test'));
    expect(keyWrite?.status).toBe(403);
  } finally {
    store.close();
  }
});
