import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

test('only the pinned Google web session may claim user; the store also denies an unverified caller', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-reserved-handle-'));
  const pin = createHash('sha256').update('pinned.owner@example.test').digest('hex');
  const path = join(root, 'members.sqlite');
  const store = createMemberStore({ path, reservedJoosungGoogleEmailSha256: pin });
  try {
    const register = (sub: string, email: string) => store.register(
      { sub, email, emailVerified: true, name: sub },
      { consents: { privacy: 'v1', terms: 'v1' } },
    );
    const owner = register('pinned-owner', 'Pinned.Owner@example.test');
    const other = register('other-owner', 'other@example.test');
    const makeApi = (memberStore = store) => createMembersApi({
      store: memberStore, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete',
    });
    const put = async (api: ReturnType<typeof makeApi>, token: string, authorization?: string) => api.handle(
      new Request('https://api.example.test/v1/members/handle', {
        method: 'PUT', headers: { cookie: '__Host-elanous_member_session=' + token,
          ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ handle: 'user' }),
      }),
    );
    const unpinned = createMemberStore({ path });
    try {
      expect(() => unpinned.claimHandle(owner.id, 'user')).toThrow('reserved member ID');
      expect((await put(makeApi(unpinned), owner.session.token))?.status).toBe(403);
    } finally { unpinned.close(); }
    expect((await put(makeApi(), other.session.token))?.status).toBe(403);
    expect((await put(makeApi(), owner.session.token, 'Bearer aps_forged'))?.status).toBe(401);
    const api = makeApi();
    for (const reserved of ['admin', 'ElanvitalAI', 'elanvital', 'monad', 'elanous']) {
      expect(() => store.claimHandle(other.id, reserved)).toThrow('reserved member ID');
      const denied = await api.handle(new Request('https://api.example.test/v1/members/handle', {
        method: 'PUT', headers: { cookie: '__Host-elanous_member_session=' + other.session.token },
        body: JSON.stringify({ handle: reserved }),
      }));
      expect(denied?.status).toBe(403);
    }
    const profile = await api.handle(new Request('https://api.example.test/v1/members', {
      headers: { cookie: '__Host-elanous_member_session=' + owner.session.token },
    }));
    expect((await profile?.json()).member.canClaimReservedJoosung).toBe(true);
    expect((await put(api, owner.session.token))?.status).toBe(200);
    expect(store.memberForHandle('user')).toBe(owner.id);
    expect((await put(api, other.session.token))?.status).toBe(403);
    expect(() => createMemberStore({ path, reservedJoosungGoogleEmailSha256: 'bad-pin' }))
      .toThrow('invalid reserved handle owner pin');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// OWNER-TYPED-JOOSUNG (대표 11-26): the pinned owner types «user» into the ordinary handle field — the same check + PUT every member
// uses, no dedicated button — and gets it. Everyone else is refused as reserved, and «ElanvitalAI» stays reserved even for the owner.
test('the pinned owner claims a typed user through the ordinary check + PUT; others and ElanvitalAI stay reserved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-reserved-typed-'));
  const pin = createHash('sha256').update('typed.owner@example.test').digest('hex');
  const store = createMemberStore({ path: join(root, 'members.sqlite'), reservedJoosungGoogleEmailSha256: pin });
  try {
    const register = (sub: string, email: string) => store.register(
      { sub, email, emailVerified: true, name: sub },
      { consents: { privacy: 'v1', terms: 'v1' } },
    );
    const owner = register('typed-owner', 'typed.owner@example.test');
    const other = register('typed-other', 'someone@example.test');
    const api = createMembersApi({
      store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete',
    });
    const cookie = (token: string) => ({ cookie: '__Host-elanous_member_session=' + token });
    const check = async (token: string, handle: string) => (await (await api.handle(new Request(
      'https://api.example.test/v1/members/handle/check?handle=' + handle, { headers: cookie(token) },
    )))!.json()).status;
    const put = async (token: string, handle: string) => (await api.handle(new Request('https://api.example.test/v1/members/handle', {
      method: 'PUT', headers: cookie(token), body: JSON.stringify({ handle }),
    })))!;

    // Typed check: owner sees ok, a non-owner sees reserved; ElanvitalAI is reserved for both.
    expect(await check(owner.session.token, 'user')).toBe('ok');
    expect(await check(other.session.token, 'user')).toBe('reserved');
    expect(await check(owner.session.token, 'ElanvitalAI')).toBe('reserved');
    expect(await check(other.session.token, 'ElanvitalAI')).toBe('reserved');

    // ElanvitalAI refused for the owner (store and API), and the owner still has no handle afterwards.
    expect(() => store.claimHandle(owner.id, 'ElanvitalAI')).toThrow('reserved member ID');
    const ownerJoosung80 = await put(owner.session.token, 'ElanvitalAI');
    expect(ownerJoosung80.status).toBe(403);
    expect((await ownerJoosung80.json()).error).toBe('member-id-reserved');
    expect(store.handleForMember(owner.id)).toBeNull();

    // A non-owner typing user is refused as reserved.
    const otherTyped = await put(other.session.token, 'user');
    expect(otherTyped.status).toBe(403);
    expect((await otherTyped.json()).error).toBe('member-id-reserved');
    expect(store.memberForHandle('user')).toBeNull();

    // The owner typing user in the ordinary field succeeds.
    const ownerTyped = await put(owner.session.token, 'user');
    expect(ownerTyped.status).toBe(200);
    expect((await ownerTyped.json()).handle).toBe('user');
    expect(store.memberForHandle('user')).toBe(owner.id);
    expect(store.handleForMember(owner.id)).toBe('user');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
