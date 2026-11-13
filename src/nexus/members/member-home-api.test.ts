import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

test('Google callback creates a session without an undelivered key and opens the authenticated home', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const api = createMembersApi({
      store,
      google: {
        redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
        complete: async () => ({
          identity: { sub: 'new-member', email: 'new@example.test', emailVerified: true, name: 'New Member' },
          intent: { consents: { privacy: 'v1', terms: 'v1' } },
        }),
      } as never,
      successRedirectUri: 'https://app.example.test/member', webOrigin: 'https://app.example.test',
    });
    const callback = await api.handle(new Request('https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state', {
      headers: { cookie: '__Host-elanous_member_oauth_state=fake-state' },
    }));
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get('location')).toBe('https://api.example.test/v1/members/home');
    expect(await callback?.text()).not.toContain('Save your member key');
    const session = /__Host-elanous_member_session=([^;]+)/.exec(callback?.headers.get('set-cookie') ?? '')?.[1];
    expect(session).toBeTruthy();
    const member = store.memberForGoogleSub('new-member');
    expect(member).not.toBeNull();
    expect(store.listMemberKeys(member!.id)).toEqual([]);
    const homeUrl = 'https://api.example.test/v1/members/home';
    expect((await api.handle(new Request(homeUrl)))?.status).toBe(401);
    const home = await api.handle(new Request(homeUrl, { headers: { cookie: `__Host-elanous_member_session=${session}` } }));
    expect(home?.status).toBe(200);
    const body = await home!.text();
    expect(body).toContain('무료 멤버');
    expect(body).toContain('유료 멤버십은 2027년 2월 시작 예정입니다');
    expect(body).toContain('내 추천 링크 복사');
    expect(body).toContain('href="https://app.example.test/app/connect"');
    expect(body).toContain('href="https://app.example.test/app"');
    expect(body).toContain('연결 상태를 아직 확인하지 못했어요');
    expect(body).not.toContain('연결된 기기가 없어요');
    expect(body).not.toContain('Save your member key');
    expect(body).not.toContain('emk_');
    expect(home?.headers.get('content-security-policy')).toContain('script-src');
    const publicId = store.publicIdForMember(member!.id);
    expect(publicId).toStartWith('em_');
    expect(publicId).not.toBe(member!.id);
    expect(body).toContain(publicId!);
    const profile = await api.handle(new Request('https://api.example.test/v1/members', {
      headers: { cookie: `__Host-elanous_member_session=${session}` },
    }));
    expect((await profile?.json() as { member: { publicId: string } }).member.publicId).toBe(publicId!);
  } finally { store.close(); }
});

test('KCB signup keeps its dedicated same-origin success redirect', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    store.provisionEventCode({ code: 'KCB1114', maxUses: Number.MAX_SAFE_INTEGER,
      startsAt: '2026-11-12T15:00:00Z', endsAt: '2026-11-15T15:00:00Z' });
    const options = {
      store,
      google: {
        redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
        complete: async () => ({
          identity: { sub: 'kcb-member', email: 'kcb@example.test', emailVerified: true, name: 'KCB Member' },
          intent: { consents: { privacy: 'v1', terms: 'v1' }, eventCode: 'kcb_1114' },
        }),
      } as never,
      successRedirectUri: 'https://app.example.test/member',
      webOrigin: 'https://app.example.test',
      kcbSuccessRedirectUri: 'https://app.example.test/app/signup/complete/',
      now: () => Date.parse('2026-11-14T01:00:00.000Z'),
    };
    const api = createMembersApi(options);
    const callback = await api.handle(new Request('https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state', {
      headers: { cookie: '__Host-elanous_member_oauth_state=fake-state' },
    }));
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get('location')).toBe(options.kcbSuccessRedirectUri);
    expect(store.memberForGoogleSub('kcb-member')?.eventCode).toBe('KCB1114');
    expect(() => createMembersApi({ ...options,
      kcbSuccessRedirectUri: 'https://other.example.test/app/signup/complete/',
    })).toThrow('KCB success redirect must share the member web origin');
  } finally { store.close(); }
});

test('callback destination follows this request, not an existing member event code', async () => {
  const at = '2026-11-14T01:00:00.000Z';
  const identity = { sub: 'returning-member', email: 'returning@example.test',
    emailVerified: true, name: 'Returning Member' } as const;
  const consents = { privacy: 'v1', terms: 'v1' };
  for (const scenario of [
    { previousCode: 'KCB1114', requestedCode: undefined,
      expected: 'https://api.example.test/v1/members/home' },
    { previousCode: undefined, requestedCode: 'KCB_1114',
      expected: 'https://app.example.test/app/signup/complete/' },
  ]) {
    const store = createMemberStore({ path: ':memory:' });
    try {
      store.provisionEventCode({ code: 'KCB1114', maxUses: Number.MAX_SAFE_INTEGER,
        startsAt: '2026-11-12T15:00:00Z', endsAt: '2026-11-15T15:00:00Z' });
      store.register(identity, { consents, ...(scenario.previousCode ? { eventCode: scenario.previousCode } : {}) }, at);
      const api = createMembersApi({
        store,
        google: {
          redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
          complete: async () => ({ identity, intent: {
            consents, ...(scenario.requestedCode ? { eventCode: scenario.requestedCode } : {}),
          } }),
        } as never,
        successRedirectUri: 'https://app.example.test/member', webOrigin: 'https://app.example.test',
        kcbSuccessRedirectUri: 'https://app.example.test/app/signup/complete/',
        now: () => Date.parse(at),
      });
      const callback = await api.handle(new Request('https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state', {
        headers: { cookie: '__Host-elanous_member_oauth_state=fake-state' },
      }));
      expect(callback?.status).toBe(303);
      expect(callback?.headers.get('location')).toBe(scenario.expected);
      expect(store.memberForGoogleSub(identity.sub)?.eventCode).toBe('KCB1114');
    } finally { store.close(); }
  }
});
