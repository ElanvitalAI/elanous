import { afterEach, expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';

const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('member plan is read from the catalog and defaults only to free with no entitlements', () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  const member = store.register({ sub: 'google-sub', email: 'member@example.test', emailVerified: true, name: 'Member' }, {
    consents: { privacy: 'rev-1', terms: 'rev-1' },
  });
  expect(store.memberPlanForMember(member.id)).toEqual({ plan: 'free', entitlements: {} });

  store.provisionPlan({ plan: 'catalog-row', entitlements: { feature: true } });
  expect(store.assignPlan(member.id, 'catalog-row')).toBe(true);
  expect(store.memberPlanForMember(member.id)).toEqual({ plan: 'catalog-row', entitlements: { feature: true } });
});
