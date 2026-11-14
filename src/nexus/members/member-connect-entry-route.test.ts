import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

test('real member API routes bind browser approval to its logged-in member and existing PKCE exchange', async () => {
  const at = Date.parse('2026-11-14T01:00:00.000Z');
  const store = createMemberStore({ path: ':memory:', now: () => at });
  try {
    const a = store.register({ sub: 'connect-a', email: 'a@example.test', emailVerified: true, name: 'A' },
      { consents: { privacy: 'v1', terms: 'v1' } }, new Date(at).toISOString());
    const b = store.register({ sub: 'connect-b', email: 'b@example.test', emailVerified: true, name: 'B' },
      { consents: { privacy: 'v1', terms: 'v1' } }, new Date(at).toISOString());
    const api = createMembersApi({ store, now: () => at,
      google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/member', webOrigin: 'https://app.example.test',
      issueOwnerSession: (_app, member) => ({ sessionToken: `aps_${member}`, expiresAt: '2026-11-15T01:00:00.000Z' }),
    });
    const state = 's'.repeat(43);
    const verifier = 'v'.repeat(43);
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    const pollSecret = 'p'.repeat(43);
    const start = await api.handle(new Request('https://api.example.test/v1/members/connect/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, codeChallenge, pollSecret }),
    }));
    expect(start?.status).toBe(201);
    const { approvalUrl, id, userCode } = await start!.json() as { approvalUrl: string; id: string; userCode: string };
    const page = await api.handle(new Request(approvalUrl, { headers: {
      cookie: `__Host-elanous_member_session=${a.session.token}`,
    } }));
    expect(page?.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page!.text())?.[1];
    expect(csrf).toBeTruthy();
    const approval = async (session: string) => api.handle(new Request(approvalUrl, { method: 'POST',
      headers: { origin: 'https://api.example.test', cookie: `__Host-elanous_member_session=${session}`,
        'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}&userCode=${userCode}` }));
    expect((await approval(b.session.token))?.status).toBe(403);
    expect((await approval(a.session.token))?.status).toBe(200);
    const poll = await api.handle(new Request(`https://api.example.test/v1/members/connect/poll?id=${id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollSecret }),
    }));
    expect(poll?.status).toBe(200);
    const { code } = await poll!.json() as { code: string };
    const exchange = await api.handle(new Request('https://api.example.test/v1/members/app-slot/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, state, codeVerifier: verifier }),
    }));
    expect(exchange?.status).toBe(200);
    const body = await exchange!.json() as { sessionToken: string; appSlot: { memberId?: string; appSlug: string } };
    expect(body.sessionToken).toBe(`aps_${a.id}`);
    expect(body.appSlot.appSlug).toBe(store.appSlotForMember(a.id)!.appSlug);
    expect(body.appSlot.memberId).toBeUndefined();
    const replay = await api.handle(new Request('https://api.example.test/v1/members/app-slot/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, state, codeVerifier: verifier }),
    }));
    expect(replay?.status).toBe(401);
  } finally { store.close(); }
});
