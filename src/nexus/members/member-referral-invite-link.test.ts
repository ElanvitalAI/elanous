import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

test('a member receives a fixed-origin invite link whose code attributes the invitee', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const referrer = store.register(
      { sub: 'referrer', email: 'referrer@example.test', emailVerified: true, name: 'Referrer' },
      { consents: { privacy: 'v1', terms: 'v1' } },
    );
    const api = createMembersApi({ store, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
    } as never, successRedirectUri: 'https://app.example.test/signup/complete', webOrigin: 'https://app.example.test' });
    const profileUrl = 'https://untrusted.example.test/v1/members';
    const anonymous = await api.handle(new Request(profileUrl));
    expect(anonymous?.status).toBe(401);
    expect(await anonymous?.text()).not.toContain(referrer.referralCode);

    const authorized = await api.handle(new Request(profileUrl, {
      headers: { cookie: `__Host-elanous_member_session=${referrer.session.token}` },
    }));
    expect(authorized?.status).toBe(200);
    expect(authorized?.headers.get('cache-control')).toBe('no-store');
    const profile = await authorized?.json() as { member: { id: string; invited: boolean; referralCount: number; invitedBy?: string }; inviteLink: string };
    expect(profile.member.id).toBe(referrer.id);
    expect(profile.member.invited).toBe(false);
    expect(profile.member.invitedBy).toBeUndefined();
    expect(profile.inviteLink).toBe(`https://app.example.test/app/signup?referralCode=${referrer.referralCode}`);

    const code = new URL(profile.inviteLink).searchParams.get('referralCode');
    expect(code).not.toBeNull();
    const invitee = store.register(
      { sub: 'invitee', email: 'invitee@example.test', emailVerified: true, name: 'Invitee' },
      { consents: { privacy: 'v1', terms: 'v1' }, referralCode: code! },
    );
    expect(invitee.invitedBy).toBe(referrer.id);
    const updated = await api.handle(new Request(profileUrl, {
      headers: { cookie: `__Host-elanous_member_session=${referrer.session.token}` },
    }));
    const updatedProfile = await updated?.json() as { member: { referralCount: number; invitedBy?: string }; referralCount: number };
    expect(updatedProfile.referralCount).toBe(1);
    expect(updatedProfile.member.referralCount).toBe(1);
    expect(updatedProfile.member.invitedBy).toBeUndefined();
  } finally {
    store.close();
  }
});

test('member session alone can rotate and revoke an invite link', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const owner = store.register(
      { sub: 'owner', email: 'owner@example.test', emailVerified: true, name: 'Owner' },
      { consents: { privacy: 'v1', terms: 'v1' } },
    );
    const api = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete', webOrigin: 'https://app.example.test' });
    const endpoint = 'https://api.example.test/v1/members/referral-code';
    expect((await api.handle(new Request(endpoint, { method: 'POST' })))?.status).toBe(401);
    const headers = { cookie: `__Host-elanous_member_session=${owner.session.token}`, origin: 'https://app.example.test' };
    const rotated = await api.handle(new Request(endpoint, { method: 'POST', headers }));
    expect(rotated?.status).toBe(201);
    const next = (await rotated?.json() as { inviteLink: string }).inviteLink;
    expect(next).toStartWith('https://app.example.test/app/signup?referralCode=');
    expect(next).not.toContain(owner.referralCode);
    expect(store.validateCode(owner.referralCode, 'referral').valid).toBe(false);
    const revoked = await api.handle(new Request(endpoint, { method: 'DELETE', headers }));
    expect(revoked?.status).toBe(200);
    expect(store.validateCode(new URL(next).searchParams.get('referralCode')!, 'referral').valid).toBe(false);
    const profile = await api.handle(new Request('https://api.example.test/v1/members', { headers }));
    expect((await profile?.json() as { inviteLink: string | null }).inviteLink).toBeNull();
  } finally { store.close(); }
});
