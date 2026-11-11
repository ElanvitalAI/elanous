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
    expect(callback?.status).toBe(200);
    const profile = await world.membersApi.handle(new Request(endpoint, {
      headers: { cookie: callback!.headers.get('set-cookie')!.split(';', 1)[0]!, origin },
    }));
    expect(profile?.status).toBe(200);
    return profile!.json() as Promise<{ member: { id: string }; inviteLink: string }>;
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
    world.memberStore.rotateReferralCode(a.member.id);
    const stale = await world.membersApi.handle(new Request(endpoint, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ consents: { privacy: 'v1', terms: 'v1' }, referralCode: new URL(a.inviteLink).searchParams.get('referralCode') }),
    }));
    expect(stale?.status).toBe(400);
  } finally { world.close(); }
});
