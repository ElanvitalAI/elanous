import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { resolveVerifiedMemberOwner } from '../api/board-api.js';

test('real board owner resolver accepts a member web cookie only for that member slot', async () => {
  const fixtureMemberNames = ['own', 'other'] as const;
  const store = createMemberStore({ path: ':memory:' });
  try {
    store.provisionEventCode({ code: 'KCB1114', maxUses: fixtureMemberNames.length, startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' });
    const make = (name: string) => store.register({ sub: name, email: `${name}@example.test`, emailVerified: true, name },
      { consents: { privacy: 'v1', terms: 'v1' }, eventCode: 'KCB1114' });
    const own = make(fixtureMemberNames[0]); const other = make(fixtureMemberNames[1]);
    store.createAppSlotForMember(own.id); store.createAppSlotForMember(other.id);
    const ownSlot = store.appSlotForMember(own.id)!; const otherSlot = store.appSlotForMember(other.id)!;
    const session = store.createSession(own.id);
    const headers = { cookie: `__Host-elanous_member_session=${session.token}` };
    const api = createMembersApi({ store, google: { redirectUri: 'https://nexus.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://nexus.example.test/app/board/', webOrigin: 'https://nexus.example.test' });
    const ownerUrl = (slug: string) => `https://nexus.example.test/v1/members/owner?appSlug=${encodeURIComponent(slug)}`;
    expect((await api.handle(new Request(ownerUrl(ownSlot.appSlug), { headers })))?.status).toBe(200);
    expect((await api.handle(new Request(ownerUrl(otherSlot.appSlug), { headers })))?.status).toBe(401);
    expect((await api.handle(new Request(ownerUrl('forged'), { headers })))?.status).toBe(401);
    expect((await api.handle(new Request(ownerUrl(ownSlot.appSlug))))?.status).toBe(401);
    expect(await resolveVerifiedMemberOwner(new Request('https://nexus.example.test/v1/board', { headers }), api))
      .toMatchObject({ memberId: own.id, appSlug: ownSlot.appSlug });
    expect(await resolveVerifiedMemberOwner(new Request('https://nexus.example.test/v1/board'), api)).toBeNull();
  } finally { store.close(); }
});
