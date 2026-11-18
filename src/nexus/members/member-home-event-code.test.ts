// OP 11-18 (B): an app slot needs an event code. The member home says so and hides the app-name form for a member who
// has no slot and no code; a member who joined with a code keeps the form. The rule itself is unchanged.
import { afterEach, expect, test } from 'bun:test';
import { APP_NAME_NEEDS_EVENT_CODE, renderMemberHomePage, type MemberHomePageInput } from './member-home-page.js';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

const base: MemberHomePageInput = {
  name: '회원 A', email: 'a@example.test', publicId: 'membera',
  referralUrl: 'https://elanous.ai/r/membera',
  membership: { label: '무료 멤버', note: '유료 멤버십은 2027년 2월 시작 예정입니다' },
  connection: { linked: true, recheckUrl: '/v1/members/home' }, siteUrl: 'https://elanous.ai/', handleStepUrl: 'https://elanous.ai/members/',
  myElanous: { handleAddress: 'membera.elanous.app' },
  devices: [], nonce: 'fake-nonce',
};

test('no slot and no event code: the card says why, and the name form is hidden and disabled', () => {
  const page = renderMemberHomePage({ ...base, appName: { slug: null, needsEventCode: true } });
  expect(page).toContain(`data-member-app-name-needs-event-code>${APP_NAME_NEEDS_EVENT_CODE}</p>`);
  expect(page).toContain('<form id="app-name-form" hidden>');
  for (const id of ['app-name-input', 'app-name-check', 'app-name-save']) expect(page).toMatch(new RegExp(`id="${id}"[^>]*disabled`));
});

test('a member who can name the app keeps the form and gets no event-code line', () => {
  const page = renderMemberHomePage({ ...base, appName: { slug: null } });
  expect(page).not.toContain('data-member-app-name-needs-event-code');
  expect(page).toContain('<form id="app-name-form">');
  expect(page).not.toMatch(/id="app-name-save"[^>]*disabled/);
});

test('a refused save for lack of an event code shows the same line, not «지금은 확인할 수 없어요»', () => {
  const page = renderMemberHomePage({ ...base, appName: { slug: null } });
  expect(page).toContain(`code==='event-code-required'?${JSON.stringify(APP_NAME_NEEDS_EVENT_CODE)}`);
});

const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('the home route marks needsEventCode only for a member without a slot and without a code', async () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  store.provisionEventCode({ code: 'HOME1', maxUses: Number.MAX_SAFE_INTEGER, startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' });
  const api = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
    successRedirectUri: 'https://app.example.test/members/', webOrigin: 'https://app.example.test',
    appLifecycle: { ensureCreated: () => {}, events: () => [] } as never });
  const home = async (name: string, eventCode?: string) => {
    const m = store.register({ sub: name, email: `${name}@example.test`, emailVerified: true, name },
      { consents: { privacy: 'v1', terms: 'v1' }, ...(eventCode ? { eventCode } : {}) });
    const cookie = `__Host-elanous_member_session=${store.createSession(m.id).token}`;
    const response = await api.handle(new Request('https://api.example.test/v1/members/home', { headers: { cookie } }));
    expect(response?.status).toBe(200);
    return await response!.text();
  };
  expect(await home('nocode')).toContain(APP_NAME_NEEDS_EVENT_CODE);
  expect(await home('withcode', 'HOME1')).not.toContain('data-member-app-name-needs-event-code');
});
