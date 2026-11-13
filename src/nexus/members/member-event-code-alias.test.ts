import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

const at = '2026-11-14T02:00:00.000Z';
const identity = (sub: string) => ({ sub, email: `${sub}@example.test`, emailVerified: true as const, name: sub });
const consents = { privacy: 'v1', terms: 'v1' };

test('KCB1114 aliases validate at the Nexus API and consume one canonical event quota', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    // 출처: #5518 — 두 가입이 동일 행사 코드의 한도를 함께 소진하는 계약.
    store.provisionEventCode({ code: 'KCB1114', maxUses: 2 });
    // 출처: #5731 — KCB 외의 행사 코드 표기는 이 별칭 변경의 대상이 아니다.
    store.provisionEventCode({ code: 'OTHER-2026', maxUses: 1 });
    const api = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/signup/complete', now: () => Date.parse(at) });
    const handleOwner = store.register(identity('handle-collision'), { consents }, at);
    store.claimHandle(handleOwner.id, 'kcb1114');
    const unspecified = await api.handle(new Request('https://api.example.test/v1/members/validate-code', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'kcb1114' }),
    }));
    expect(await unspecified?.json()).toMatchObject({ valid: true, kind: 'event' });
    const validate = async (code: string) => {
      const response = await api.handle(new Request('https://api.example.test/v1/members/validate-code', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, kind: 'event' }),
      }));
      expect(response?.status).toBe(200);
      return response?.json() as Promise<{ valid: boolean; reason?: string }>;
    };
    for (const code of ['KCB1114', 'KCB_1114', 'kcb-1114', 'K C B 1 1 1 4']) {
      expect((await validate(code)).valid).toBe(true);
    }
    expect((await validate('KCB.1114')).valid).toBe(false);
    expect(store.validateCode('OTHER_2026', 'event', at)).toEqual({ valid: false, reason: 'invalid' });

    const first = store.register(identity('alias-one'), { consents, eventCode: 'KCB_1114' }, at);
    expect(first.eventCode).toBe('KCB1114');
    const second = store.register(identity('alias-two'), { consents, eventCode: 'K C B 1 1 1 4' }, at);
    expect(second.eventCode).toBe('KCB1114');
    expect(await validate('kcb-1114')).toEqual({ valid: false, reason: 'exhausted' });
    expect(() => store.register(identity('alias-three'), { consents, eventCode: 'KCB1114' }, at)).toThrow('event code exhausted');
    expect(store.validateCode('KCB_1114', 'referral', at)).toEqual({ valid: false, reason: 'invalid' });
  } finally { store.close(); }
});
