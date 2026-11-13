import { expect, test } from 'bun:test';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from './fake-member-oidc-world.js';

const origin = 'https://app.example.test';
const endpoint = 'https://members.example.test/v1/members';

test('fake Google world completes a three-member referral chain through real HTTP handlers', async () => {
  const now = '2026-11-12T01:00:00.000Z';
  const world = createFakeMemberOidcWorld({ now: () => Date.parse(now) });
  world.memberStore.provisionEventCode({ code: 'EVENT', maxUses: ['a', 'b', 'c'].length, startsAt: '2026-11-11T00:00:00Z', endsAt: '2026-11-13T00:00:00Z' });
  async function signup(referralCode?: string, eventCode?: string) {
    const started = await world.membersApi.handle(new Request(endpoint, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ consents: { privacy: 'v1', terms: 'v1' }, referralCode, eventCode }),
    }), '203.0.113.11');
    expect(started?.status).toBe(201);
    const authorizationUrl = (await started?.json() as { authorizationUrl: string }).authorizationUrl;
    const authorization = world.googleWorld.authorize(authorizationUrl);
    const callback = await world.membersApi.handle(new Request(
      `${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${authorization.code}&state=${authorization.state}`,
      { headers: { cookie: started!.headers.get('set-cookie')!.split(';', 1)[0]! } },
    ));
    expect(callback?.status).toBe(303);
    const sessionCookie = callback!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const homeUrl = callback!.headers.get('location')!;
    const home = await world.membersApi.handle(new Request(homeUrl, { headers: { cookie: sessionCookie } }));
    expect(home?.status).toBe(200);
    const homeHtml = await home!.text();
    expect(homeHtml).toContain('내 추천 링크 복사');
    expect(homeHtml).toContain('무료 멤버');
    expect(homeHtml).not.toContain('Save your member key');
    expect(homeHtml).not.toContain('emk_');
    const profile = await world.membersApi.handle(new Request(endpoint, {
      headers: { cookie: sessionCookie, origin },
    }));
    expect(profile?.status).toBe(200);
    return { ...(await profile!.json() as { member: { id: string }; inviteLink: string }), sessionCookie, homeHtml };
  }
  try {
    const a = await signup();
    const b = await signup(new URL(a.inviteLink).searchParams.get('referralCode')!, 'EVENT');
    const c = await signup(new URL(b.inviteLink).searchParams.get('referralCode')!);
    expect(a.inviteLink).not.toContain(a.member.id);
    expect(world.memberStore.referralsForMember(a.member.id)).toEqual([{
      inviteeId: b.member.id, referralCode: new URL(a.inviteLink).searchParams.get('referralCode')!, eventCode: 'EVENT', invitedAt: now,
    }]);
    expect(world.memberStore.referralsForMember(b.member.id)[0]?.inviteeId).toBe(c.member.id);
    const memberA = world.memberStore.memberForSession(a.sessionCookie.split('=', 2)[1]!);
    expect(memberA).not.toBeNull();
    const keyApi = 'https://members.example.test/v1/member/keys';
    for (const signup of [a, b, c]) {
      const before = await world.membersApi.handle(new Request(keyApi, { headers: { cookie: signup.sessionCookie } }));
      expect(before?.status).toBe(200);
      expect(await before!.json()).toEqual({ keys: [] });
    }
    const created = await world.membersApi.handle(new Request(keyApi, {
      method: 'POST', headers: { cookie: a.sessionCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'developer' }),
    }));
    expect(created?.status).toBe(201);
    const issued = await created!.json() as { id: string; key: string };
    expect(issued.key).toStartWith('emk_');
    const list = await world.membersApi.handle(new Request(keyApi, { headers: { cookie: a.sessionCookie } }));
    expect(list?.status).toBe(200);
    const metadata = await list!.text();
    expect(metadata).toContain(issued.id);
    expect(metadata).not.toContain(issued.key);
    const keyRows = JSON.parse(metadata) as { keys: Array<Record<string, unknown>> };
    expect(keyRows.keys).toHaveLength(1);
    const keyRow = keyRows.keys.find(row => row.id === issued.id);
    expect(Object.keys(keyRow ?? {}).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name', 'revokeUrl', 'rotateUrl']);
    expect(keyRow?.name).toBe('developer');
    expect(keyRow?.createdAt).toBe(now);
    expect(keyRow?.lastUsedAt).toBeNull();
    expect(keyRow?.rotateUrl).toBe(`/v1/member/keys/${issued.id}/rotate`);
    expect(keyRow?.revokeUrl).toBe(`/v1/member/keys/${issued.id}`);
    expect(a.homeHtml).not.toContain(issued.key);
    const rotated = await world.membersApi.handle(new Request(`${keyApi}/${issued.id}/rotate`, {
      method: 'POST', headers: { cookie: a.sessionCookie, origin },
    }));
    expect(rotated?.status).toBe(201);
    const replacement = await rotated!.json() as { id: string; key: string };
    expect(replacement.key).not.toBe(issued.key);
    expect(world.memberStore.memberForKey(issued.key)).toBeNull();
    expect(world.memberStore.memberForKey(replacement.key)?.memberId).toBe(memberA!.id);
    const revoked = await world.membersApi.handle(new Request(`${keyApi}/${replacement.id}`, {
      method: 'DELETE', headers: { cookie: a.sessionCookie, origin },
    }));
    expect(revoked?.status).toBe(200);
    expect(world.memberStore.memberForKey(replacement.key)).toBeNull();
    world.memberStore.rotateReferralCode(a.member.id);
    const stale = await world.membersApi.handle(new Request(endpoint, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ consents: { privacy: 'v1', terms: 'v1' }, referralCode: new URL(a.inviteLink).searchParams.get('referralCode') }),
    }));
    expect(stale?.status).toBe(400);
  } finally { world.close(); }
});
