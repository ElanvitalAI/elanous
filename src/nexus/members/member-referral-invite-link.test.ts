import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

test('a member receives a fixed-origin public ID link that attributes the invitee without exposing a code', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const referrer = store.register(
      { sub: 'referrer', email: 'referrer@example.test', emailVerified: true, name: 'Referrer' },
      { consents: { privacy: 'v1', terms: 'v1' } },
    );
    store.claimHandle(referrer.id, 'referrer1');
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
    const profile = await authorized?.json() as { member: { id: string; handle: string; invited: boolean; referralCount: number; invitedBy?: string; referralCode?: string }; inviteLink: string };
    expect(profile.member.id).toBe(referrer.id);
    expect(profile.member.invited).toBe(false);
    expect(profile.member.invitedBy).toBeUndefined();
    expect(profile.member.referralCode).toBeUndefined();
    expect(profile.inviteLink).toBe(`https://app.example.test/r/${profile.member.handle}`);
    expect(profile.inviteLink).not.toContain(referrer.referralCode);

    const handle = new URL(profile.inviteLink).pathname.slice('/r/'.length);
    const invitee = store.register(
      { sub: 'invitee', email: 'invitee@example.test', emailVerified: true, name: 'Invitee' },
      { consents: { privacy: 'v1', terms: 'v1' }, referrerMemberId: handle },
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
    store.claimHandle(owner.id, 'ownerlink');
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
    expect((await profile?.json() as { inviteLink: string }).inviteLink).toBe('https://app.example.test/r/ownerlink');
  } finally { store.close(); }
});

test('one-time readable handle rejects duplicates while legacy public IDs and codes survive', () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const owner = store.register({ sub: 'a', email: 'a@example.test', emailVerified: true, name: 'A' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const other = store.register({ sub: 'b', email: 'b@example.test', emailVerified: true, name: 'B' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const oldPublicId = store.publicIdForMember(owner.id)!;
    expect(store.claimHandle(owner.id, 'ElanvitalAI')).toBe('ElanvitalAI');
    expect(store.memberForPublicId(oldPublicId)).toBe(owner.id);
    expect(store.memberForHandle('ElanvitalAI')).toBe(owner.id);
    expect(() => store.claimHandle(other.id, 'ElanvitalAI')).toThrow('already taken');
    expect(() => store.claimHandle(owner.id, 'anotherid')).toThrow('cannot be changed');
    expect(() => store.claimHandle(other.id, 'Joosung80')).toThrow('invalid member ID');
    expect(() => store.claimHandle(other.id, 'user-80')).toThrow('invalid member ID');
    expect(() => store.claimHandle(other.id, 'em_guest')).toThrow('invalid member ID');
    store.revokeReferralCode(owner.id);
    expect(store.validateCode(owner.referralCode, 'referral').valid).toBe(false);
    const invitee = store.register({ sub: 'c', email: 'c@example.test', emailVerified: true, name: 'C' },
      { consents: { privacy: 'v1', terms: 'v1' }, legacyPublicId: oldPublicId });
    expect(invitee.invitedBy).toBe(owner.id);
    expect(store.referralsForMember(owner.id)).toHaveLength(1);
  } finally { store.close(); }
});

test('member ID validation and signup intent use the public handle contract without a legacy code', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const owner = store.register({ sub: 'owner-public', email: 'public@example.test', emailVerified: true, name: 'Owner' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const handle = store.claimHandle(owner.id, 'ElanvitalAI');
    const fakeOAuthAge = 1;
    let captured: unknown;
    const api = createMembersApi({ store, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
      start: async (intent: unknown) => { captured = intent; return { authorizationUrl: 'https://accounts.example.test/auth',
        cookieValue: 'opaque-test-state', maxAgeSeconds: fakeOAuthAge }; },
    } as never, successRedirectUri: 'https://app.example.test/signup/complete', webOrigin: 'https://app.example.test' });
    const headers = { origin: 'https://app.example.test', 'content-type': 'application/json' };
    const checked = await api.handle(new Request('https://api.example.test/v1/members/validate-code', {
      method: 'POST', headers, body: JSON.stringify({ code: handle }) }));
    expect(await checked?.json()).toEqual({ valid: true, kind: 'member' });
    const started = await api.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers, body: JSON.stringify({ consents: { privacy: 'v1', terms: 'v1' }, referrerMemberId: handle }) }));
    expect(started?.status).toBe(201);
    expect(captured).toEqual({ consents: { privacy: 'v1', terms: 'v1' }, referrerMemberId: handle });
    const conflict = await api.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers, body: JSON.stringify({ consents: { privacy: 'v1', terms: 'v1' },
        referrerMemberId: handle, referralCode: owner.referralCode }) }));
    expect(conflict?.status).toBe(400);
  } finally { store.close(); }
});

test('authenticated one-time handle claim returns a public link, keeps an alias, and rejects duplicates', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const owner = store.register({ sub: 'claim-owner', email: 'claim@example.test', emailVerified: true, name: 'Owner' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const other = store.register({ sub: 'claim-other', email: 'other@example.test', emailVerified: true, name: 'Other' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const previous = store.publicIdForMember(owner.id)!;
    const api = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete', webOrigin: 'https://app.example.test' });
    const endpoint = 'https://api.example.test/v1/members/handle';
    const body = JSON.stringify({ handle: 'ElanvitalAI' });
    expect((await api.handle(new Request(endpoint, { method: 'PUT', body })))?.status).toBe(401);
    const ownerHeaders = { origin: 'https://app.example.test', 'content-type': 'application/json',
      cookie: `__Host-elanous_member_session=${owner.session.token}` };
    const claimed = await api.handle(new Request(endpoint, { method: 'PUT', headers: ownerHeaders, body }));
    expect(claimed?.status).toBe(200);
    expect(await claimed?.json()).toEqual({ handle: 'ElanvitalAI', inviteLink: 'https://app.example.test/r/ElanvitalAI' });
    expect(store.memberForPublicId(previous)).toBe(owner.id);
    const otherHeaders = { ...ownerHeaders, cookie: `__Host-elanous_member_session=${other.session.token}` };
    expect((await api.handle(new Request(endpoint, { method: 'PUT', headers: otherHeaders, body })))?.status).toBe(409);
  } finally { store.close(); }
});
