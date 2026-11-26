import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { createMemberConnectEntry } from './member-connect-entry-api.js';
import { renderMemberHomePage, type MemberHomePageInput } from './member-home-page.js';
import type { MemberStore } from './member-store.js';

// MEMBER-CONNECT-APPROVE-HOME: in-app browser guidance + approve from the signed-in home.
const origin = 'https://api.elanous.ai';
const withActiveForAuth: MemberStore['withActiveForAuth'] = (_memberId, effect) => ({ active: true, value: effect() });
const post = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function entry(clock: { at: number }) {
  const created: Array<Record<string, unknown>> = [];
  const api = createMemberConnectEntry({ origin, now: () => clock.at,
    loginUrl: 'https://elanous.ai/members/', homeUrl: 'https://api.elanous.ai/v1/members/home',
    memberForRequest: request => request.headers.get('x-member'),
    store: { activeForAuth: () => true, withActiveForAuth,
      ensureNativeAppSlotForMember: memberId => ({ memberId, appId: `app-${memberId}` }) as never,
      createAppAuthCode: input => { created.push(input); } },
  });
  return { api, created };
}

async function start(api: ReturnType<typeof entry>['api'], seed: string, caller: string) {
  const response = await api.handle(post(`${origin}/v1/members/connect/start`, {
    state: seed.repeat(43), codeChallenge: 'c'.repeat(43), pollSecret: 'p'.repeat(43) }), caller);
  expect(response?.status).toBe(201);
  return await response!.json() as { approvalUrl: string; id: string; userCode: string };
}

test('approve link without a member session explains the in-app browser and links to sign-in and home', async () => {
  const { api } = entry({ at: Date.parse('2026-11-26T00:00:00.000Z') });
  const { approvalUrl } = await start(api, 's', '203.0.113.1');
  const page = await api.handle(new Request(approvalUrl));
  expect(page?.status).toBe(401);
  expect(page?.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(page?.headers.get('cache-control')).toBe('private, no-store');
  const html = await page!.text();
  expect(html).toContain('이 브라우저에는 로그인 세션이 없습니다 — Safari/Chrome 에서 열거나, 내 엘라누스(로그인 후) → 연결 요청 승인 에서 승인하세요');
  expect(html).toContain('<a href="https://elanous.ai/members/">로그인하기</a>');
  expect(html).toContain('<a href="https://api.elanous.ai/v1/members/home">내 엘라누스 열기</a>');
  expect(html).not.toContain('name="csrf"');
  // A sessionless POST stays a plain JSON refusal.
  const refused = await api.handle(new Request(approvalUrl, { method: 'POST', headers: { origin }, body: 'csrf=x&userCode=AAAA-BBBB' }));
  expect(refused?.status).toBe(401);
  expect(await refused!.json()).toEqual({ error: 'unauthorized' });
});

test('home lists only requests the member opened while signed in, without the code; approval needs the typed TUI code', async () => {
  const clock = { at: Date.parse('2026-11-26T00:00:00.000Z') };
  const { api, created } = entry(clock);
  const mine = await start(api, 's', '203.0.113.1');
  const anonymous = await start(api, 't', '203.0.113.2');
  // Unbound (anonymous) requests are listed to nobody.
  expect(api.pendingForMember('member-a')).toEqual([]);
  expect(api.pendingForMember('member-b')).toEqual([]);
  expect((await api.handle(new Request(mine.approvalUrl, { headers: { 'x-member': 'member-a' } })))?.status).toBe(200);
  const listed = api.pendingForMember('member-a');
  expect(listed).toHaveLength(1);
  expect(listed[0]).toEqual({ id: mine.id, csrf: listed[0]!.csrf, startedAt: '2026-11-26T00:00:00.000Z', deviceLabel: null, expiresInSeconds: 120 });
  expect(JSON.stringify(listed)).not.toContain(mine.userCode);
  expect(listed.some(item => item.id === anonymous.id)).toBe(false);
  expect(api.pendingForMember('member-b')).toEqual([]);

  // The home button replays the existing same-origin approve POST with the listed csrf and the code the member typed.
  const approve = (member: string, requestOrigin: string, form: Record<string, string>) =>
    new Request(`${origin}/v1/members/connect/approve?id=${listed[0]!.id}`, {
      method: 'POST', headers: { 'x-member': member, origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString() });
  const csrf = listed[0]!.csrf;
  expect((await api.handle(approve('member-a', origin, { csrf })))?.status).toBe(403);
  expect((await api.handle(approve('member-a', origin, { csrf, userCode: '' })))?.status).toBe(403);
  const wrong = mine.userCode === 'AAAA-BBBB' ? 'BBBB-AAAA' : 'AAAA-BBBB';
  expect((await api.handle(approve('member-a', origin, { csrf, userCode: wrong })))?.status).toBe(403);
  expect((await api.handle(approve('member-b', origin, { csrf, userCode: mine.userCode })))?.status).toBe(403);
  expect((await api.handle(approve('member-a', 'https://elanous.ai', { csrf, userCode: mine.userCode })))?.status).toBe(403);
  expect(created).toHaveLength(0);
  expect((await api.handle(approve('member-a', origin, { csrf, userCode: mine.userCode })))?.status).toBe(200);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ memberId: 'member-a' });
  expect(api.pendingForMember('member-a')).toEqual([]);
});

test('bound requests drop off the home list at the unchanged 2-minute expiry', async () => {
  const clock = { at: Date.parse('2026-11-26T00:00:00.000Z') };
  const { api } = entry(clock);
  const mine = await start(api, 's', '203.0.113.1');
  await api.handle(new Request(mine.approvalUrl, { headers: { 'x-member': 'member-a' } }));
  clock.at += 119_000;
  expect(api.pendingForMember('member-a')[0]?.expiresInSeconds).toBe(1);
  clock.at += 1_000;
  expect(api.pendingForMember('member-a')).toEqual([]);
});

const member: MemberHomePageInput = {
  name: '회원 A', email: 'a@example.test', publicId: 'elan-member-a', referralUrl: 'https://elanous.ai/r/a',
  membership: { label: '무료 멤버', note: '유료 멤버십은 2027년 2월 시작 예정입니다' },
  connection: { linked: false, recheckUrl: '/v1/members/home' }, siteUrl: 'https://elanous.ai/',
  handleStepUrl: 'https://elanous.ai/v1/members/handle', myElanous: { handleAddress: null }, devices: [], nonce: 'fake-nonce',
};

test('home card shows device and start time, asks for the TUI code, and never carries a code', () => {
  const page = renderMemberHomePage({ ...member, connectRequests: [
    { id: 'A'.repeat(24), csrf: 'csrf_token-1', startedAt: '2026-11-26T00:05:00.000Z', deviceLabel: null, expiresInSeconds: 97 },
  ] });
  expect(page).toContain('<h2 id="connect-approve">연결 요청 승인</h2>');
  expect(page).toContain('내 기기에서 시작한 연결인가요? 내 터미널(TUI)에 보이는 코드를 입력해 승인하세요. 내가 시작하지 않았다면 승인하지 마세요.');
  expect(page).toContain('<strong>알 수 없는 기기</strong>');
  expect(page).toContain('시작 09:05');
  expect(page).toContain('남은 시간 약 97초');
  expect(page).toContain(`data-connect-code-input="${'A'.repeat(24)}"`);
  expect(page).toContain(`data-connect-approve="${'A'.repeat(24)}"`);
  expect(page).not.toContain('data-connect-code=');
  expect(page).not.toMatch(/<input[^>]*value=/);
  expect(page).toContain("fetch('/v1/members/connect/approve?id='+id");
  const empty = renderMemberHomePage({ ...member, connectRequests: [] });
  expect(empty).toContain('승인을 기다리는 연결 요청이 없어요.');
  expect(renderMemberHomePage({ ...member, connectRequests: null })).toContain('연결 요청을 아직 확인하지 못했어요');
  expect(renderMemberHomePage(member)).not.toContain('id="connect-approve"');
  // Malformed ids or tokens never reach the page.
  expect(renderMemberHomePage({ ...member, connectRequests: [
    { id: 'bad"id', csrf: 'ok', startedAt: '2026-11-26T00:05:00.000Z', deviceLabel: null, expiresInSeconds: 1 },
  ] })).not.toContain('data-connect-approve="bad');
});

test('members API: the signed-in home lists the bound request without its code; the typed code approves end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-connect-approve-home-'));
  const at = Date.parse('2026-11-26T09:00:00.000Z');
  const store = createMemberStore({ path: join(dir, 'members.sqlite'), now: () => at });
  try {
    const registered = store.register({ sub: 'home-a', email: 'home-a@example.test', emailVerified: true, name: 'home-a' },
      { consents: { privacy: 'v1', terms: 'v1' } }, new Date(at).toISOString());
    const apiOrigin = 'https://api.example.test';
    const api = createMembersApi({ store, now: () => at,
      google: { redirectUri: apiOrigin + '/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/member', webOrigin: 'https://app.example.test',
      issueOwnerSession: () => ({ sessionToken: 'aps_fake-owner-session', expiresAt: '2026-11-27T09:00:00.000Z' }),
    });
    const cookie = '__Host-elanous_member_session=' + registered.session.token;
    const started = await api.handle(post(apiOrigin + '/v1/members/connect/start',
      { state: 's'.repeat(43), codeChallenge: 'c'.repeat(43), pollSecret: 'p'.repeat(43) }));
    const { approvalUrl, userCode } = await started!.json() as { approvalUrl: string; userCode: string };
    const sessionless = await api.handle(new Request(approvalUrl));
    expect(sessionless?.status).toBe(401);
    expect(await sessionless!.text()).toContain('<a href="https://app.example.test/members/">로그인하기</a>');
    const homeBefore = await (await api.handle(new Request(apiOrigin + '/v1/members/home', { headers: { cookie } })))!.text();
    expect(homeBefore).toContain('승인을 기다리는 연결 요청이 없어요.');
    expect(homeBefore).not.toContain(userCode);
    expect((await api.handle(new Request(approvalUrl, { headers: { cookie } })))?.status).toBe(200);
    const home = await (await api.handle(new Request(apiOrigin + '/v1/members/home', { headers: { cookie } })))!.text();
    expect(home).toContain('data-connect-request');
    expect(home).toContain('<strong>알 수 없는 기기</strong>');
    expect(home).not.toContain(userCode);
    const id = /data-connect-approve="([^"]+)"/.exec(home)?.[1];
    const csrf = /data-connect-csrf="([^"]+)"/.exec(home)?.[1];
    expect(id && csrf).toBeTruthy();
    const noCode = await api.handle(new Request(apiOrigin + '/v1/members/connect/approve?id=' + id, {
      method: 'POST', headers: { origin: apiOrigin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: csrf! }).toString() }));
    expect(noCode?.status).toBe(403);
    const approved = await api.handle(new Request(apiOrigin + '/v1/members/connect/approve?id=' + id, {
      method: 'POST', headers: { origin: apiOrigin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: csrf!, userCode }).toString() }));
    expect(approved?.status).toBe(200);
    const homeAfter = await (await api.handle(new Request(apiOrigin + '/v1/members/home', { headers: { cookie } })))!.text();
    expect(homeAfter).toContain('승인을 기다리는 연결 요청이 없어요.');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
