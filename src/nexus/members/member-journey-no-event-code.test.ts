// MEMBER-JOURNEY S1: no page asks for or prints an event code; an invite-link code is applied with one line.
import { afterEach, expect, test } from 'bun:test';
import { renderMemberHomePage, type MemberHomePageInput } from './member-home-page.js';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

const INVITE_LINE = '초대 코드 적용됨';
const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const challenge = 'A'.repeat(43);
async function loginPage(extra: string): Promise<string> {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  const api = createMembersApi({ store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
    successRedirectUri: 'https://app.example.test/members/', webOrigin: 'https://app.example.test',
    appAuthRedirectUris: ['elanous://auth'], appLifecycle: { ensureCreated: () => {}, events: () => [] } as never } as never);
  const response = await api.handle(new Request(`https://api.example.test/v1/members?flow=app-login&appRedirectUri=${encodeURIComponent('elanous://auth')}&appCodeChallenge=${challenge}${extra}`));
  expect(response?.status).toBe(200);
  return await response!.text();
}

test('hosted login: code in the link is applied with one line and never printed; no event-code input', async () => {
  const page = await loginPage('&code=KCB1114');
  expect(page.includes('KCB1114')).toBe(false);
  expect(page.split(INVITE_LINE).length - 1).toBe(1);
  expect(page.includes('행사 코드')).toBe(false);
  expect(page.includes('name="eventCode"')).toBe(false);
  // the code still reaches the server through the form POST, read from the link by the script
  expect(page).toContain("params.get('code')");
});

test('hosted login: no code in the link means no invite line', async () => {
  const page = await loginPage('');
  expect(page.includes(INVITE_LINE)).toBe(false);
  expect(page.includes('행사 코드')).toBe(false);
});

// JUD #116886 repair: the notice line and the POSTed eventCode must be picked by the same rule.
// Executes the rendered <script> with stubbed browser globals and records what the signup POST carries.
async function scriptEventCode(page: string, search: string): Promise<unknown> {
  const source = /<script nonce="[^"]+">([^<]*)<\/script>/.exec(page)![1]!;
  const bodies: Record<string, unknown>[] = [];
  let submitDone: Promise<unknown> | undefined;
  const form = {
    addEventListener: (_type: string, listener: (event: { preventDefault(): void }) => unknown) => {
      submitDone = Promise.resolve(listener({ preventDefault() {} }));
    },
  };
  const status = { textContent: '' };
  const fetch_ = async (_input: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ authorizationUrl: 'https://api.example.test/authorize' }) } as never;
  };
  // The script runs `new FormData(form)`; the stub must be constructible, so it is a regular function.
  const FormDataStub = function (_form: unknown) { return { get: (_name: string) => 'on' }; };
  // The parameters shadow the browser globals the script touches; everything else (JSON) stays real.
  await new Function('document', 'FormData', 'URLSearchParams', 'location', 'fetch', source)(
    { getElementById: (id: string) => (id === 'member-login' ? form : id === 'status' ? status : null) } as never,
    FormDataStub as never,
    URLSearchParams,
    { search, replace: () => {} } as never,
    fetch_ as unknown as never,
  );
  await submitDone;
  return bodies.at(-1)?.['eventCode'];
}

test('hosted login: an empty code= falls back to eventCode for the notice line AND the POST', async () => {
  const page = await loginPage('&code=&eventCode=KCB1114');
  expect(page.includes('KCB1114')).toBe(false);                    // the value itself is never printed
  expect(page.split(INVITE_LINE).length - 1).toBe(1);              // the line says a code was applied
  const posted = await scriptEventCode(page, '?flow=app-login&appRedirectUri=' + encodeURIComponent('elanous://auth') + '&appCodeChallenge=' + challenge + '&code=&eventCode=KCB1114');
  expect(posted).toBe('KCB1114');                                  // the POST carries the same value the line promised
});

test('hosted login: a whitespace-only code= falls through to eventCode for the line AND the POST', async () => {
  const page = await loginPage('&code=%20&eventCode=KCB1114');
  expect(page.split(INVITE_LINE).length - 1).toBe(1);
  const posted = await scriptEventCode(page, '?flow=app-login&appRedirectUri=' + encodeURIComponent('elanous://auth') + '&appCodeChallenge=' + challenge + '&code=%20&eventCode=KCB1114');
  expect(posted).toBe('KCB1114');
});

test('hosted login: a usable code= wins over eventCode= for the notice line AND the POST (mixed parameters)', async () => {
  const page = await loginPage('&code=AB12&eventCode=KCB1114');
  expect(page.split(INVITE_LINE).length - 1).toBe(1);
  const posted = await scriptEventCode(page, '?flow=app-login&appRedirectUri=' + encodeURIComponent('elanous://auth') + '&appCodeChallenge=' + challenge + '&code=AB12&eventCode=KCB1114');
  expect(posted).toBe('AB12');
});

test('hosted login: JSON metacharacters in the code stay one escaped string in the POST body', async () => {
  const raw = 'z","evil":1}';
  const page = await loginPage('&code=' + encodeURIComponent(raw));
  expect(page.split(INVITE_LINE).length - 1).toBe(1);
  expect(page.includes('evil')).toBe(false);                       // the value itself is never printed
  const posted = await scriptEventCode(page, '?flow=app-login&appRedirectUri=' + encodeURIComponent('elanous://auth') + '&appCodeChallenge=' + challenge + '&code=' + encodeURIComponent(raw));
  expect(posted).toBe(raw);                                        // JSON.parse of the body yields the code as one string
});

test('member home: no event-code wording and no code printed', () => {
  const input: MemberHomePageInput = {
    name: '회원 A', email: 'a@example.test', publicId: 'membera', referralUrl: 'https://elanous.ai/r/membera',
    membership: { label: '무료 멤버', note: '유료 멤버십은 2027년 2월 시작 예정입니다' },
    connection: { linked: true, recheckUrl: '/v1/members/home' }, siteUrl: 'https://elanous.ai/', handleStepUrl: 'https://elanous.ai/members/',
    myElanous: { handleAddress: 'membera.elanous.app' }, devices: [], nonce: 'fake-nonce',
    appName: { slug: null, needsEventCode: true },
  };
  const page = renderMemberHomePage(input);
  expect(page.includes('KCB1114')).toBe(false);
  expect(page.includes('이벤트 코드')).toBe(false);
  expect(page.includes('행사 코드')).toBe(false);
  expect(page).toContain('data-member-app-name-needs-event-code');
});
